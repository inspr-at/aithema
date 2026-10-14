import { PluginError } from '../../../packages/core/src/invocation.js';
import { voiceEvents, voiceOperation, assertVoiceMediaGrant } from '../../../packages/core/src/live-voice.js';
import { createVoiceLifecycleController } from '../../../packages/core/src/voice-lifecycle-controller.js';
import { manifest } from './manifest.js';

/** Host media ports supply physical capture/playback. Offline tests inject them;
 * the browser never receives Mistral credentials or transcript authority. */
export function createComposedBrowserMedia({ openRelay, capture, player, control, now = Date.now } = {}) {
  if (![openRelay, capture, player?.play, player?.stop].every(fn => typeof fn === 'function')) throw new TypeError('Host media ports required');
  async function connect(grant, options = {}) {
    assertVoiceMediaGrant(grant, now());
    const events = voiceEvents(); let transport, recording, input = true, output = true, stopped = false,
      playbackRevision = 0, hold = false, session;
    const localStop = () => { recording?.stop(); recording = undefined; player.stop(); playbackRevision++; };
    const mute = () => { player.stop(); playbackRevision++; };
    const stop = () => { stopped = true; hold = true; localStop(); };
    async function captureOn() {
      if (stopped || hold || !input || recording) return;
      const revision = playbackRevision;
      const next = await capture({ signal: options.holdSignal, format: 'pcm_s16le', sampleRateHz: 16000,
        onAudio: audio => stopped || hold || !input ? Promise.resolve() : transport.sendAudio(audio) });
      if (stopped || hold || revision !== playbackRevision) next.stop(); else recording = next;
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
          if (frame.type === 'silence') { player.stop(); playbackRevision = Math.max(playbackRevision, frame.playbackRevision); }
          else if (frame.type === 'audio' && !hold && output && frame.playbackRevision >= playbackRevision) {
            playbackRevision = frame.playbackRevision;
            await player.play(frame.bytes, { format: frame.format, replyId: frame.replyId });
          } else if (frame.type === 'event') events.push(frame.event);
        }
        if (!stopped && source === transport) await lifecycle.recover();
      } catch { if (!stopped && source === transport) await lifecycle.recover(); }
    }
    const abort = () => { void session?.close({ reason: 'hold' }).catch(() => {}); };
    try {
      transport = await voiceOperation(options, () => openRelay(grant));
      lifecycle.connected({ providerSessionId: grant.providerSessionId, spendDeadlineAt: grant.opaque.spendDeadlineAt ?? grant.expiresAt,
        browserLivenessDeadlineAt: grant.opaque.browserLivenessDeadlineAt ?? grant.expiresAt });
      session = { callId: grant.callId, get providerSessionId() { return grant.providerSessionId; }, events,
        async close(opts) {
          stop(); lifecycle.end(opts?.reason ?? 'closed'); options.holdSignal?.removeEventListener('abort', abort);
          events.end(); return transport.command('close', opts?.reason ?? 'closed');
        },
        pause(opts) { hold = true; localStop(); lifecycle.pause(); return transport.command('pause', opts); },
        async resume(opts) { const ack = await transport.command('resume', opts); if (ack?.acknowledged !== true || ack.paused !== false) throw new PluginError('invalid-output');
          lifecycle.resumed(); hold = false; await captureOn(); return ack; },
        async setInput(on, opts) { input = Boolean(on); if (!input) { recording?.stop(); recording = undefined; }
          await transport.command('setInput', on, opts); if (input) await captureOn(); },
        async setOutput(on, opts) { output = Boolean(on); if (!output) mute(); await transport.command('setOutput', on, opts); },
        interrupt(opts) { mute(); return transport.command('interrupt', opts); },
        sendText: (text, opts) => transport.command('sendText', text, opts),
        updateContext: (value, opts) => transport.command('updateContext', value, opts),
        heartbeat: opts => lifecycle.heartbeat(opts),
      };
      options.holdSignal?.addEventListener('abort', abort, { once: true });
      if (options.holdSignal?.aborted) { await session.close(); throw new PluginError('cancelled'); }
      void read(transport); await captureOn(); return session;
    } catch (error) { stop(); lifecycle.end('start-failed'); await transport?.disconnect().catch(() => {}); throw error; }
  }
  return Object.freeze({ manifest, connect,
    capture: (session, on, opts) => session.setInput(on, opts), playback: (session, on, opts) => session.setOutput(on, opts),
    teardown: (session, opts) => session.close(opts) });
}
