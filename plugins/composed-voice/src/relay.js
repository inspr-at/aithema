import { randomUUID } from 'node:crypto';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { assertVoiceMediaGrant } from '../../../packages/core/src/live-voice.js';

/** In-process relay transport for the offline slice. A host may bridge this port
 * to an authenticated socket in PR 4b; no public route is installed here. */
export function createComposedRelay({ callId, providerSessionId, epoch = 0, expiresAt, spendDeadlineAt = expiresAt,
  browserLivenessDeadlineAt = expiresAt, now = Date.now, maxBytes = 256_000 } = {}) {
  const relayId = randomUUID(), frames = [];
  let bytes = 0, consumer, closed = false, connected = false, coordinator, playbackRevision = 0;
  const identity = { callId, providerSessionId, epoch };
  const grant = Object.freeze({ callId, providerSessionId, expiresAt,
    opaque: Object.freeze({ relayId, epoch, spendDeadlineAt, browserLivenessDeadlineAt }) });
  assertVoiceMediaGrant(grant, now());
  const wake = () => { const fn = consumer; consumer = undefined; fn?.(); };
  function push(frame) {
    if (closed) return;
    const size = frame.bytes?.byteLength ?? JSON.stringify(frame).length * 2;
    if (bytes + size > maxBytes) throw new PluginError('limit', 'Playback consumer fell behind');
    frames.push({ frame, size }); bytes += size; wake();
  }
  const transport = {
    grant,
    attach(value) { if (coordinator) throw new PluginError('already-claimed'); coordinator = value; },
    event: event => push({ type: 'event', event }),
    audio(frame) {
      if (frame.playbackRevision < playbackRevision) return;
      push({ type: 'audio', ...frame, bytes: Uint8Array.from(frame.bytes) });
    },
    silence(frame) {
      // Flush audio before the stop frame. A stale producer cannot refill after its revision is fenced.
      playbackRevision = Math.max(playbackRevision, frame.playbackRevision);
      for (let i = frames.length - 1; i >= 0; i--) if (frames[i].frame.type === 'audio') bytes -= frames.splice(i, 1)[0].size;
      push({ type: 'silence', ...frame });
    },
    close() { closed = true; frames.length = 0; bytes = 0; wake(); },
    async connect(candidate) {
      assertVoiceMediaGrant(candidate, now());
      if (closed || connected || !coordinator || candidate.callId !== callId || candidate.providerSessionId !== providerSessionId ||
        candidate.expiresAt !== expiresAt || candidate.opaque?.relayId !== relayId || candidate.opaque?.epoch !== epoch) throw new PluginError('not-admitted');
      connected = true;
      return {
        ...identity, grant,
        frames: { [Symbol.asyncIterator]() { return this; }, async next() {
          while (!closed && !frames.length) await new Promise(resolve => { consumer = resolve; });
          if (closed) return { done: true };
          const item = frames.shift(); bytes -= item.size; return { done: false, value: item.frame };
        }, return() { transport.close(); return Promise.resolve({ done: true }); } },
        sendAudio: (audio, receipt = identity) => coordinator.receiveAudio(audio, receipt),
        command: (name, ...args) => {
          if (!['pause', 'resume', 'setInput', 'setOutput', 'interrupt', 'sendText', 'updateContext', 'heartbeat', 'close'].includes(name)) throw new PluginError('unavailable');
          return coordinator[name](...args);
        },
        disconnect() { transport.close(); return coordinator.close('transport-lost'); },
      };
    },
  };
  return Object.freeze(transport);
}
