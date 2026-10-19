import { createElevenLabsClient } from '../../../../plugins/elevenlabs/src/client.js';
import { createGrokVoiceClient } from '../../../../plugins/grok-voice/src/client.js';
import { voiceEvents } from '../../../core/src/live-voice.js';

// Real, unmodified clients with offline control, SDK and media boundaries. Shared
// by the controlled-clock regression and the viewport evidence (no provider I/O).
export function currentVoiceClient(provider, { permission = Promise.resolve(), enabled = false, connection = Promise.resolve(), credential = Promise.resolve(), microphoneError } = {}) {
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
    async start(request, opts) { requests.push('start'); options.push(opts); await credential; return receipt(request); },
    async recover(request) { requests.push('recover'); return receipt(request); },
    async close() { return { closureConfirmed: true, usage: { costEstimated: false } }; },
    async pause() { return { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async heartbeat() { return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 300_000 }; },
  };
  const mediaDevices = { async getUserMedia() {
    acquired++; await permission; if (microphoneError) throw microphoneError;
    const track = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } };
  const sdk = { async startSession(opts) {
    callbacks = opts;
    const stream = await mediaDevices.getUserMedia({ audio: true });
    const conversation = { getId: () => opts.conversationToken.replace('fixture-token-', ''),
      connection: { handleMessage() {} }, input: { inputStream: stream, async setMuted() {}, async setDevice() {} },
      setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {},
      async endSession() { stream.getTracks().forEach(track => track.stop()); } };
    sdk.conversation = conversation; opts.onConversationCreated?.(conversation); opts.onConnect({ conversationId: conversation.getId() });
    await connection; return conversation;
  } };
  const client = provider === 'elevenlabs' ? createElevenLabsClient({ control, sdk, mediaDevices, persistEvent: async () => {} })
    : createGrokVoiceClient({ control,
      async openRelay() {
        const frames = voiceEvents(); streams.push(frames);
        return { frames: { async *[Symbol.asyncIterator]() { for await (const event of frames) yield { type: 'event', event }; } }, async disconnect() { frames.end(); }, async sendAudio() {}, async command() { return { acknowledged: true }; } };
      },
      async capture(opts) { capture = opts; acquired++; opts.onMicrophoneState?.('requesting'); await permission; if (microphoneError) throw Object.assign(microphoneError, { phase: 'microphone' }); opts.onMicrophoneState?.('granted'); await connection; return { stop() {} }; },
      player: { play() {}, stop() {} } });
  // Keep AIT-377's compatibility assertions for undeclared clients verbatim.
  const legacy = { ...client, manifest: structuredClone(client.manifest),
    start(request, opts) { const { onMicrophoneState, ...rest } = opts; return client.start(request, rest); } };
  for (const key of ['onMicrophoneState', 'replyStarted', 'opener']) delete legacy.manifest.liveVoice.capabilities[key];
  return { client: enabled ? client : legacy, requests, options, get acquired() { return acquired; },
    recover() { if (provider === 'elevenlabs') callbacks.onDisconnect({ reason: 'error' }); else capture.onError(); },
    speaking(callId) {
      if (provider === 'elevenlabs') callbacks.onModeChange({ mode: 'speaking' });
      else streams.at(-1).push({ type: 'speaking', callId });
    },
    event(event) { if (provider === 'elevenlabs') {
      if (event.type === 'final') callbacks.onMessage({ role: event.role === 'assistant' ? 'agent' : 'user', message: event.text, event_id: event.event_id ?? 10 });
      else callbacks.onModeChange({ mode: event.type });
    } else streams.at(-1).push(event); },
    audio(text = 'Eine richtige Antwort.') {
      if (provider === 'elevenlabs') {
        callbacks.onModeChange({ mode: 'speaking' });
        // Provider alignment is distinct from SDK mode and local analyser ticks.
        const conversation = sdk.conversation;
        conversation.connection.handleMessage({ type: 'audio', audio_event: { event_id: 20,
          alignment: { chars: [...text] } } });
      } else streams.at(-1).push({ type: 'speaking', audio: true, filler: false });
    },
    end() { for (const stream of streams) stream.end(); } };
}
