import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceEvents, voiceOperation, assertVoiceMediaGrant } from '../../../packages/core/src/live-voice.js';
import { createVoiceLifecycleController } from '../../../packages/core/src/voice-lifecycle-controller.js';
import { manifest } from './manifest.js';

/** Host media ports supply physical capture/playback. Offline tests inject them;
 * the browser never receives Mistral credentials or transcript authority. */
export function createComposedBrowserMedia({ openRelay, capture, player, control, now = Date.now } = {}) {
  if (![openRelay, capture, player?.play, player?.stop].every(fn => typeof fn === 'function')) throw new TypeError('Host media ports required');
  let mediaOwner, stopOwner;
  async function connect(grant, options = {}) {
    assertVoiceMediaGrant(grant, now());
    const events = voiceEvents(); let transport, recording, input = true, output = true, stopped = false,
      playbackRevision = 0, holdRevision = 0, hold = false, session, closing, pendingPlaybackBytes = 0, captureController;
    const owner = Symbol('composed-media'), pendingPlayback = new Set();
    const stopPlayback = (origin = 'interrupt') => {
      if (mediaOwner === owner) player.stop({ origin });
      pendingPlayback.clear(); pendingPlaybackBytes = 0;
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
        onAudio: audio => stopped || hold || !input || mediaOwner !== owner ? Promise.resolve() : transport.sendAudio(audio) });
      if (stopped || hold || !input || signal.aborted || captureController !== controller || mediaOwner !== owner) next.stop(); else recording = next;
    }
    const lifecycle = createVoiceLifecycleController({ callId: grant.callId, now,
      renew: opts => transport.command('heartbeat', opts),
      beforeRecovery: async () => { await transport?.disconnect(); },
      async replace({ explicit }) {
        if (!control?.recover) throw new PluginError('unavailable');
        const replacement = await control.recover({ callId: grant.callId, explicit });
        assertVoiceMediaGrant(replacement, now());
        transport = await openRelay(replacement); grant = replacement; playbackRevision = 0;
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
          if (frame.type === 'silence') { stopPlayback(); playbackRevision = Math.max(playbackRevision, frame.playbackRevision); }
          else if (frame.type === 'audio' && !hold && output && frame.playbackRevision >= playbackRevision) {
            if (!(frame.bytes instanceof Uint8Array) || !['pcm_f32le', 'pcm_s16le'].includes(frame.format) ||
              pendingPlaybackBytes + frame.bytes.byteLength > 256_000) throw new PluginError('limit', 'Playback queue full');
            playbackRevision = frame.playbackRevision;
            const token = { size: frame.bytes.byteLength }; pendingPlayback.add(token); pendingPlaybackBytes += token.size;
            // A playback completion must not obstruct control frames such as silence.
            void Promise.resolve(player.play(frame.bytes, { format: frame.format, sampleRateHz: frame.sampleRateHz, channels: frame.channels, replyId: frame.replyId }))
              .catch(() => { if (!stopped && source === transport) { mute(); lifecycle.wait('playback-failed'); } })
              .finally(() => { if (pendingPlayback.delete(token)) pendingPlaybackBytes -= token.size; });
          } else if (frame.type === 'event') {
            if (frame.event.type === 'waiting') { hold = true; holdRevision++; localStop(); lifecycle.wait(frame.event.reason); }
            else if (frame.event.type === 'ended') { stop(); lifecycle.end(frame.event.reason); }
            events.push(frame.event);
          }
        }
        if (!stopped && source === transport) await lifecycle.recover();
      } catch { if (!stopped && source === transport) await lifecycle.recover(); }
    }
    const retainHold = () => {
      if (stopped) return;
      if (options.holdSignal?.reason === 'ownership-lost') { holdRevision++; lifecycle.ownershipLost(); return; }
      void session.pause({ deadlineAt: now() + 5000 }).catch(() => lifecycle.wait('pause-failed'));
    };
    const cancel = () => { stop(); void session?.close({ reason: 'cancelled' }).catch(() => {}); };
    try {
      transport = await voiceOperation(options, () => openRelay(grant));
      stopOwner?.(); mediaOwner = owner; stopOwner = stop;
      lifecycle.connected({ providerSessionId: grant.providerSessionId, spendDeadlineAt: grant.opaque.spendDeadlineAt ?? grant.expiresAt,
        browserLivenessDeadlineAt: grant.opaque.browserLivenessDeadlineAt ?? grant.expiresAt });
      session = { callId: grant.callId, get providerSessionId() { return grant.providerSessionId; }, events,
        async close(opts) {
          if (closing) return closing;
          stop(); lifecycle.end(opts?.reason ?? 'closed'); options.holdSignal?.removeEventListener('abort', retainHold);
          options.signal?.removeEventListener('abort', cancel);
          if (mediaOwner === owner) { mediaOwner = undefined; stopOwner = undefined; }
          events.end(); closing = Promise.resolve(transport.command('close', opts?.reason ?? 'closed')); return closing;
        },
        pause(opts) { hold = true; holdRevision++; localStop(); lifecycle.pause(); return Promise.resolve(transport.command('pause', opts)).then(async ack => {
          if (transport.recoverOnResume) await lifecycle.recover(); return ack;
        }); },
        async resume(opts) {
          const revision = holdRevision;
          if (lifecycle.state.needsRecovery && !await lifecycle.recover({ explicit: true })) throw new PluginError('unavailable');
          if (stopped || revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
          const ack = await transport.command('resume', opts); if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output');
          if (stopped || revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
          lifecycle.resumed(); hold = false; await captureOn(); return ack; },
        async setInput(on, opts) { input = Boolean(on); if (!input) { captureController?.abort(); recording?.stop(); recording = undefined; }
          await transport.command('setInput', on, opts); if (input) await captureOn(); },
        async setOutput(on, opts) { output = Boolean(on); if (!output) mute(); await transport.command('setOutput', on, opts); },
        interrupt(opts) { mute('interrupt'); return transport.command('interrupt', opts); },
        sendText: (text, opts) => transport.command('sendText', text, opts),
        updateContext: (value, opts) => transport.command('updateContext', value, opts),
        heartbeat: opts => lifecycle.heartbeat(opts),
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) { cancel(); throw new PluginError('cancelled'); }
      options.holdSignal?.addEventListener('abort', retainHold, { once: true });
      if (options.holdSignal?.aborted) await session.pause(options);
      void read(transport); await captureOn(); return session;
    } catch (error) {
      stop(); lifecycle.end('start-failed'); options.signal?.removeEventListener('abort', cancel);
      options.holdSignal?.removeEventListener('abort', retainHold); await transport?.disconnect().catch(() => {}); throw error;
    }
  }
  return Object.freeze({ manifest, connect,
    capture: (session, on, opts) => session.setInput(on, opts), playback: (session, on, opts) => session.setOutput(on, opts),
    teardown: (session, opts) => session.close(opts) });
}
