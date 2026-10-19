import { createElevenLabsClient } from '../../../../plugins/elevenlabs/src/client.js';
import { createGrokVoiceClient } from '../../../../plugins/grok-voice/src/client.js';
import { voiceEvents } from '../../../core/src/live-voice.js';

// Real, unmodified clients with offline control, SDK and media boundaries. Shared
// by the controlled-clock regression and the viewport evidence (no provider I/O).
export function currentVoiceClient(provider, { permission = Promise.resolve() } = {}) {
  const requests = [], options = [], streams = [];
  let callbacks, capture, generation = 0, acquired = 0;
  const receipt = request => {
    const providerSessionId = `fixture-${++generation}`, until = Date.now() + 300_000;
    return { callId: request.callId, providerSessionId, epoch: 1,
      spendDeadlineAt: until, browserLivenessDeadlineAt: until,
      credential: { providerSessionId, ttlMs: 60_000, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}` },
      mediaGrant: { callId: request.callId, providerSessionId, expiresAt: until,
        opaque: { epoch: 1, spendDeadlineAt: until, browserLivenessDeadlineAt: until } } };
  };
  const control = {
    async start(request, opts) { requests.push('start'); options.push(opts); return receipt(request); },
    async recover(request) { requests.push('recover'); return receipt(request); },
    async close() { return { closureConfirmed: true, usage: { costEstimated: false } }; },
    async pause() { return { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async heartbeat() { return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 300_000 }; },
  };
  const mediaDevices = { async getUserMedia() {
    acquired++; await permission;
    const track = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } };
  const sdk = { async startSession(opts) {
    callbacks = opts;
    const stream = await mediaDevices.getUserMedia({ audio: true });
    const conversation = { getId: () => opts.conversationToken.replace('fixture-token-', ''),
      input: { inputStream: stream, async setMuted() {}, async setDevice() {} },
      setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {},
      async endSession() { stream.getTracks().forEach(track => track.stop()); } };
    opts.onConversationCreated?.(conversation); opts.onConnect({ conversationId: conversation.getId() });
    return conversation;
  } };
  const client = provider === 'elevenlabs' ? createElevenLabsClient({ control, sdk, mediaDevices, persistEvent: async () => {} })
    : createGrokVoiceClient({ control,
      async openRelay() {
        const frames = voiceEvents(); streams.push(frames);
        return { frames: { async *[Symbol.asyncIterator]() { for await (const event of frames) yield { type: 'event', event }; } }, async disconnect() { frames.end(); }, async sendAudio() {}, async command() { return { acknowledged: true }; } };
      },
      async capture(opts) { capture = opts; acquired++; await permission; return { stop() {} }; },
      player: { play() {}, stop() {} } });
  return { client, requests, options, get acquired() { return acquired; },
    recover() { if (provider === 'elevenlabs') callbacks.onDisconnect({ reason: 'error' }); else capture.onError(); },
    speaking(callId) {
      if (provider === 'elevenlabs') callbacks.onModeChange({ mode: 'speaking' });
      else streams.at(-1).push({ type: 'speaking', callId });
    },
    end() { for (const stream of streams) stream.end(); } };
}
