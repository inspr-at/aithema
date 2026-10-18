import { PluginError } from '@inspr/aithema-core/invocation';
import { voiceEvents, voiceOperation, assertVoiceMediaGrant } from '@inspr/aithema-core/live-voice';
import { voiceAuthorityLost, createVoiceLifecycleController } from '@inspr/aithema-core/voice-lifecycle-controller';
import { manifest } from './manifest.js';

/** Host media ports supply physical capture/playback. Offline tests inject them;
 * the browser never receives Mistral credentials or transcript authority. */
export function createComposedBrowserMedia({ openRelay, capture, player, control, now = Date.now } = {}) {
  if (![openRelay, capture, player?.play, player?.stop].every(fn => typeof fn === 'function')) throw new TypeError('Host media ports required');
  let mediaOwner, stopOwner;
  async function connectRelay(grant, options) {
    let accepted = false;
    const pending = Promise.resolve().then(() => openRelay(grant, options));
    try { const result = await voiceOperation(options, () => pending); accepted = true; return result; }
    finally { if (!accepted) void pending.then(value => value.disconnect()).catch(() => {}); }
  }
  async function connect(grant, options = {}) {
    assertVoiceMediaGrant(grant, now());
    const events = voiceEvents(); let transport, recording, input = true, output = true, stopped = false,
      playbackRevision = 0, holdRevision = 0, hold = false, session, closing, pendingPlaybackBytes = 0, speechActive = false, speechSilenceMs = 0, lastSpeechAt = 0, captureController, playbackBlocked = false, blockedFrame;
    const owner = Symbol('composed-media'), pendingPlayback = new Set();
    const stopPlayback = (origin = 'interrupt') => {
      if (mediaOwner === owner) player.stop({ origin });
      pendingPlayback.clear(); pendingPlaybackBytes = 0; blockedFrame = undefined;
    };
    const localStop = () => { captureController?.abort(); recording?.stop(); recording = undefined; stopPlayback('teardown'); playbackRevision++; };
    const mute = (origin = 'control') => { stopPlayback(origin); playbackRevision++; };
    const stop = () => { if (stopped) return; stopped = true; hold = true; localStop(); };
    async function captureOn() {
      if (stopped || hold || !input || recording) return;
      const controller = new AbortController(); captureController = controller;
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const next = await capture({ signal, format: 'pcm_s16le', sampleRateHz: 16000,
        onError: () => { if (!stopped && !hold) void lifecycle.recover(); },
        onAudio: audio => {
          if (stopped || hold || !input || mediaOwner !== owner) return Promise.resolve();
          // The capture format is PCM16 mono 16 kHz. Mirror the server's
          // onset threshold locally so network latency cannot extend playback.
          if (audio instanceof Uint8Array && audio.byteLength && audio.byteLength % 2 === 0) {
            const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength); let energy = 0;
            for (let i = 0; i < audio.byteLength; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
            const voiced = Math.sqrt(energy / (audio.byteLength / 2)) >= 0.015;
            if (now() - lastSpeechAt >= 500) speechActive = false;
            if (voiced) {
              if (!speechActive) mute('barge-in');
              speechActive = true; speechSilenceMs = 0; lastSpeechAt = now();
            } else if ((speechSilenceMs += audio.byteLength / 32) >= 500) speechActive = false;
          }
          return transport.sendAudio(audio);
        } });
      if (stopped || hold || !input || signal.aborted || captureController !== controller || mediaOwner !== owner) next.stop(); else recording = next;
    }
    const lifecycle = createVoiceLifecycleController({ callId: grant.callId, now,
      renew: opts => transport.command('heartbeat', opts),
      beforeRecovery: async () => { await transport?.disconnect(); },
      async replace({ explicit }) {
        if (!control?.recover) throw new PluginError('unavailable');
        const revision = holdRevision;
        const recoveryOptions = { signal: options.signal, deadlineAt: now() + 5000 };
        const replacement = await voiceOperation(recoveryOptions, opts => control.recover({ callId: grant.callId, explicit }, opts));
        assertVoiceMediaGrant(replacement, now());
        const next = await connectRelay(replacement, recoveryOptions);
        if (stopped || revision !== holdRevision) { await next.disconnect(); throw new PluginError('cancelled'); }
        try {
          if (!input) await next.command('setInput', false);
          if (!output) await next.command('setOutput', false);
        } catch (error) { await next.disconnect(); throw error; }
        transport = next; grant = replacement; playbackRevision = 0; playbackBlocked = false;
        void read(transport); return { providerSessionId: grant.providerSessionId,
          spendDeadlineAt: replacement.opaque.spendDeadlineAt, browserLivenessDeadlineAt: replacement.opaque.browserLivenessDeadlineAt };
      },
      stopMedia: () => { hold = true; localStop(); },
      terminal: reason => { void session.close({ reason }).catch(() => {}); },
      onEvent: value => { events.push({ ...value, callId: grant.callId, providerSessionId: grant.providerSessionId });
        if (value.type === 'recovered') { hold = lifecycle.state.holds.length > 0; void captureOn().catch(() => {}); } },
    });
    async function read(source) {
      try {
        for await (const frame of source.frames) {
          if (stopped || source !== transport) break;
          if (frame.providerSessionId !== undefined && frame.providerSessionId !== grant.providerSessionId ||
            frame.epoch !== undefined && frame.epoch !== grant.opaque.epoch) throw new PluginError('not-admitted');
          if (frame.type === 'silence') { stopPlayback(); playbackRevision = Math.max(playbackRevision, frame.playbackRevision); }
          else if (frame.type === 'audio' && !hold && output && frame.playbackRevision >= playbackRevision) {
            if (!(frame.bytes instanceof Uint8Array) || !['pcm_f32le', 'pcm_s16le'].includes(frame.format) ||
              pendingPlaybackBytes + frame.bytes.byteLength > 256_000) throw new PluginError('limit', 'Playback queue full');
            playbackRevision = frame.playbackRevision;
            if (!playbackBlocked) playFrame(frame, source);
          } else if (frame.type === 'event') {
            if (frame.event.type === 'waiting') { hold = true; holdRevision++; localStop(); lifecycle.wait(frame.event.reason); }
            else if (frame.event.type === 'ended') {
              stop(); lifecycle.end(frame.event.reason); events.push(frame.event);
              await session.close({ reason: frame.event.reason }); return;
            }
            events.push(frame.event);
          }
        }
        if (!stopped && source === transport) {
          if (now() >= lifecycle.state.spendDeadlineAt) await session.close({ reason: 'spend-deadline' });
          else await lifecycle.recover();
        }
      } catch (error) {
        if (!stopped && source === transport) {
          if (error?.code === 'deadline') await session.close({ reason: 'spend-deadline' });
          else if (voiceAuthorityLost(error)) await session.close({ reason: 'call-authorization-lost' });
          else await lifecycle.recover();
        }
      }
    }
    function playFrame(frame, source) {
      const token = { size: frame.bytes.byteLength }; pendingPlayback.add(token); pendingPlaybackBytes += token.size;
      // Failures can arrive after pause, interruption or replacement; only the owning flight may affect the rail.
      void Promise.resolve().then(() => {
        if (!pendingPlayback.has(token)) return;
        return player.play(frame.bytes, { format: frame.format, sampleRateHz: frame.sampleRateHz, channels: frame.channels, replyId: frame.replyId });
      }).catch(error => {
        if (stopped || source !== transport || !pendingPlayback.has(token)) return;
        if (error?.name === 'NotAllowedError') {
          stopPlayback('playback-blocked'); playbackBlocked = true; blockedFrame = frame;
          options.onPlaybackBlocked?.(() => session.retryPlayback());
        } else { mute(); lifecycle.wait('playback-failed'); }
      }).finally(() => { if (pendingPlayback.delete(token)) pendingPlaybackBytes -= token.size; });
    }
    const retainHold = () => {
      if (stopped) return;
      if (options.holdSignal?.reason === 'ownership-lost') { holdRevision++; lifecycle.ownershipLost(); return; }
      void session.pause({ deadlineAt: now() + 5000 }).catch(() => lifecycle.wait('pause-failed'));
    };
    const cancel = () => { stop(); void session?.close({ reason: 'cancelled' }).catch(() => {}); };
    try {
      transport = await connectRelay(grant, options);
      stopOwner?.(); mediaOwner = owner; stopOwner = stop;
      lifecycle.connected({ providerSessionId: grant.providerSessionId, spendDeadlineAt: grant.opaque.spendDeadlineAt ?? grant.expiresAt,
        browserLivenessDeadlineAt: grant.opaque.browserLivenessDeadlineAt ?? grant.expiresAt });
      session = { callId: grant.callId, get providerSessionId() { return grant.providerSessionId; }, events, lifecycle,
        get epoch() { return grant.opaque.epoch; }, tabId: control?.tabId,
        audioLevels: () => ({ input: stopped || hold || !input ? 0 : recording?.audioLevel?.() ?? 0,
          output: stopped || hold || !output || playbackBlocked ? 0 : player.audioLevel?.() ?? 0 }),
        async retryPlayback(opts) {
          if (stopped || hold || !output || mediaOwner !== owner) throw new PluginError('not-admitted');
          const revision = playbackRevision, source = transport;
          // Called by the rail's existing explicit Ton aktivieren gesture only.
          await voiceOperation(opts, () => player.retry?.());
          if (stopped || hold || !output || revision !== playbackRevision || source !== transport) throw new PluginError('cancelled');
          playbackBlocked = false;
          const frame = blockedFrame; blockedFrame = undefined;
          if (frame) playFrame(frame, source);
        },
        receiveState(value) {
          if (value.callId !== grant.callId || value.epoch < grant.opaque.epoch) return;
          if (value.epoch > grant.opaque.epoch || value.controllingTabId && value.controllingTabId !== control?.tabId) lifecycle.ownershipLost();
          else if (value.reason === 'server-restart' && value.state === 'waiting') lifecycle.restart();
        },
        async close(opts) {
          if (closing) return closing;
          if (lifecycle.state.state !== 'ended') events.push({ type: 'ended', reason: opts?.reason ?? 'closed',
            callId: grant.callId, providerSessionId: grant.providerSessionId });
          stop(); lifecycle.end(opts?.reason ?? 'closed'); options.holdSignal?.removeEventListener('abort', retainHold);
          options.signal?.removeEventListener('abort', cancel);
          if (mediaOwner === owner) { mediaOwner = undefined; stopOwner = undefined; }
          events.end(); closing = Promise.resolve().then(() => transport.command('close', opts?.reason ?? 'closed'))
            .finally(() => transport.disconnect()); return closing;
        },
        pause(opts) { hold = true; holdRevision++; localStop(); lifecycle.pause(); return voiceOperation(opts, bounded => transport.command('pause', bounded)).then(async ack => {
          if (ack?.acknowledged !== true || ack.paused !== true) throw new PluginError('invalid-output');
          if (transport.recoverOnResume) await lifecycle.recover(); return ack;
        }); },
        async resume(opts) {
          const revision = holdRevision;
          if (lifecycle.state.needsRecovery && !await lifecycle.recover({ explicit: true })) throw new PluginError('unavailable');
          if (stopped || revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
          const ack = await voiceOperation(opts, bounded => transport.command('resume', bounded)); if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output');
          if (stopped || revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
          lifecycle.resumed(); hold = false; await captureOn(); return ack; },
        async setInput(on, opts) { input = Boolean(on); if (!input) { captureController?.abort(); recording?.stop(); recording = undefined; }
          await transport.command('setInput', on, opts); if (input) await captureOn(); },
        async setOutput(on, opts) { output = Boolean(on); if (!output) mute(); await transport.command('setOutput', on, opts); },
        interrupt(opts) { mute('interrupt'); return transport.command('interrupt', opts); },
        sendText(text, opts = {}) {
          if (stopped || hold || lifecycle.state.needsRecovery) return Promise.reject(new PluginError('not-admitted'));
          if (typeof text !== 'string' || !text.trim() || text.length > 16_384) return Promise.reject(new PluginError('limit', 'Invalid voice text'));
          const source = transport, revision = holdRevision, providerSessionId = grant.providerSessionId, epoch = grant.opaque.epoch;
          return voiceOperation(opts, bounded => {
            if (stopped || hold || source !== transport || revision !== holdRevision) throw new PluginError('not-admitted');
            return source.command('sendText', text, { deliveryId: opts.deliveryId ?? crypto.randomUUID(),
              providerSessionId, epoch, deadlineAt: bounded.deadlineAt });
          });
        },
        updateContext: (value, opts) => transport.command('updateContext', value, opts),
        heartbeat: opts => lifecycle.heartbeat(opts),
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
      options.holdSignal?.addEventListener('abort', retainHold, { once: true });
      if (options.holdSignal?.aborted) await session.pause(options);
      lifecycle.startHeartbeat();
      void read(transport); await captureOn(); return session;
    } catch (error) {
      stop(); lifecycle.end('start-failed'); options.signal?.removeEventListener('abort', cancel);
      options.holdSignal?.removeEventListener('abort', retainHold); await Promise.resolve(transport?.disconnect()).catch(() => {}); throw error;
    }
  }
  return Object.freeze({ manifest, connect,
    capture: (session, on, opts) => session.setInput(on, opts), playback: (session, on, opts) => session.setOutput(on, opts),
    teardown: (session, opts) => session.close(opts) });
}
