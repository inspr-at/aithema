import { PluginError } from '../../../packages/core/src/invocation.js';
import { createElevenLabsServer } from '../src/server.js';
import { createElevenLabsClient } from '../src/client.js';
import { manifest } from '../src/manifest.js';

export const binding = { agentId: 'agent_fixture', secretRef: 'fixture-api-ref', apiBaseUrl: 'https://api.example.test',
  upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300 };
export function invocationOptions(overrides = {}) {
  const reports = []; let consumed = false;
  return { deadlineAt: Date.now() + 1000, spendDeadlineAt: Date.now() + 5000, browserLivenessDeadlineAt: Date.now() + 1000,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), maxMicro: 10_000,
      async consume() { await Promise.resolve(); if (consumed) throw new PluginError('already-claimed'); consumed = true; } },
    reports, report: terminal => { reports.push(terminal); }, ...overrides };
}
function audioStream(source) {
  const track = { kind: 'audio', source, enabled: true, readyState: 'live',
    stop() { this.readyState = 'ended'; }, getSettings: () => ({}) };
  return { getTracks: () => [track], getAudioTracks: () => [track], clone: () => audioStream(source) };
}
export function fakeSdk() {
  const starts = [], effects = [], conversations = [], outgoing = [], acquired = []; let closed = false;
  const mediaDevices = { async getUserMedia() {
    await sdk.beforeAcquire?.();
    const stream = audioStream('microphone'); acquired.push(stream); return stream;
  } };
  class AudioContext {
    createMediaStreamDestination() { return { stream: audioStream('silence') }; }
    async close() {}
  }
  const sdk = { starts, effects, conversations, outgoing, acquired, mediaDevices, AudioContext,
    get closed() { return closed; },
    sample({ buffered = false } = {}) {
      const conversation = conversations.at(-1), track = conversation.track;
      if (conversation.transport === 'websocket') {
        if (buffered || !conversation.input.isMuted() && track?.readyState === 'live' && track.source === 'microphone') {
          conversation.connection.sendMessage({ user_audio_chunk: 'fixture-audio' });
        }
      } else if (track?.readyState === 'live' && track.enabled && track.source === 'microphone' && !conversation.muted) {
        outgoing.push(conversation.getId());
      }
    },
    interrupt(eventId = 2) { effects.push(['nativeInterruption', eventId]); starts.at(-1).onInterruption({ event_id: eventId }); },
    async startSession(options) {
      starts.push(options); closed = false;
      const providerSessionId = options.conversationToken?.replace('fixture-token-', '') ?? new URL(options.signedUrl).searchParams.get('conversation_id');
      const preliminary = await mediaDevices.getUserMedia({ audio: true });
      let stream = await mediaDevices.getUserMedia({ audio: true }), muted = false, publication;
      const publish = () => { publication = { track: { mediaStreamTrack: stream.getAudioTracks()[0],
        stop() { this.mediaStreamTrack.stop(); }, async mute() { muted = true; }, async unmute() { muted = false; } } }; };
      publish();
      const participant = {
        audioTrackPublications: new Map([['microphone', publication]]),
        getTrackPublication: () => publication,
        async unpublishTrack(track, stop = true) {
          effects.push(['unpublishTrack']); if (stop) track.stop(); publication = undefined;
          this.audioTrackPublications.clear();
        },
        async setMicrophoneEnabled(enabled) {
          effects.push(['setMicrophoneEnabled', enabled]);
          if (enabled && (!publication || stream.getAudioTracks()[0].readyState === 'ended')) {
            stream = await mediaDevices.getUserMedia({ audio: true }); publish();
            this.audioTrackPublications.set('microphone', publication);
          }
          muted = !enabled;
        },
      };
      const input = {
        get inputStream() { return stream; },
        mediaStreamSource: { disconnect() { effects.push(['disconnectInput']); } },
        forgetInputStreamAndSource() { stream.getTracks().forEach(track => track.stop()); this.mediaStreamSource.disconnect(); },
        async setMuted(value) {
          effects.push(['setInputMuted', value]); await sdk.muteHook?.(value);
          if (options.connectionType === 'webrtc') await participant.setMicrophoneEnabled(!value);
          muted = value;
        },
        isMuted: () => muted,
        async setDevice() {
          effects.push(['setInputDevice']); const replacement = await mediaDevices.getUserMedia({ audio: true });
          this.forgetInputStreamAndSource(); stream = replacement;
        },
      };
      const object = {
        input, transport: options.connectionType, get muted() { return muted; },
        get track() { return stream.getAudioTracks()[0]; },
        connection: options.connectionType === 'webrtc' ? { room: { localParticipant: participant } }
          : { sendMessage(message) { if (message.user_audio_chunk) outgoing.push(providerSessionId); } },
        getId: () => providerSessionId,
        async endSession() {
          effects.push(['endSession']); stream.getTracks().forEach(track => track.stop());
          preliminary.getTracks().forEach(track => track.stop()); closed = true;
          options.onDisconnect({ reason: 'user' });
        },
        setMicMuted(value) {
          effects.push(['setMicMuted', value]);
          input.setMuted(value).catch(error => options.onError?.('Failed to set input muted state', error));
        },
        setVolume({ volume }) { effects.push(['setVolume', volume]); },
        sendUserMessage(text) { effects.push(['sendUserMessage', text]); },
        sendContextualUpdate(text) { effects.push(['sendContextualUpdate', text]); },
      };
      conversations.push(object);
      // Both transports attach/publish audio before the public creation hook.
      sdk.sample(); await sdk.beforeCreated?.(object, options);
      preliminary.getTracks().forEach(track => track.stop());
      options.onConversationCreated?.(object);
      options.onConnect({ conversationId: providerSessionId }); return object;
    },
  };
  return sdk;
}
export function fixture({ saveCall, sdk = fakeSdk(), providerDetails, prepareCall = async () => {}, requestProviderClose,
  now = Date.now, closureTimeoutMs = 20, closurePollIntervalMs = 2, reconcileLater, closeTimeoutMs } = {}) {
  const requests = [], saved = [], persisted = [], calls = new Map(); let mints = 0;
  const fetchImpl = async (input, options) => {
    const url = new URL(input); requests.push({ url, options });
    if (url.hostname !== 'api.example.test') throw new Error('Fixture rejects nonlocal provider');
    if (url.pathname.endsWith('/token')) {
      const id = `conv_${++mints}`;
      return Response.json({ token: `fixture-token-${id}`, conversation_id: id });
    }
    if (url.pathname.endsWith('/get-signed-url')) {
      const id = `conv_${++mints}`;
      return Response.json({ signed_url: `wss://socket.example.test/call?conversation_id=${id}`, conversation_id: id });
    }
    const id = url.pathname.split('/').at(-1), call = [...calls.values()].find(c => c.providerSessionId === id);
    return Response.json((typeof providerDetails === 'function' ? await providerDetails(id, call, options) : providerDetails) ?? { conversation_id: id, status: sdk.closed ? 'done' : 'processing',
      metadata: { call_duration_secs: 120, start_time_unix_secs: (call?.startedAt ?? Date.now()) / 1000, cost: 17 } });
  };
  const server = createElevenLabsServer({ binding, fetchImpl, resolveSecret: () => 'fixture-api-key', prepareCall,
    requestProviderClose, now, closureTimeoutMs, closurePollIntervalMs, reconcileLater,
    async saveCall(call, options) {
      saved.push(structuredClone(call)); calls.set(`${call.callId}:${call.providerSessionId}`, structuredClone(call));
      if (saveCall) return saveCall(call, options);
      return { acknowledged: true, paused: call.paused };
    } });
  const sessions = new Map();
  const control = {
    async start(request, options) {
      const session = await server.start({ ...request, facadeSecretRef: 'fixture-facade-ref' }, options);
      sessions.set(session.providerSessionId, session); return receipt(session);
    },
    close: ({ providerSessionId, reason }, options) => sessions.get(providerSessionId).close(reason, reason === 'closed' ? 'completed' : 'cancelled', options),
    pause: ({ providerSessionId }, options) => sessions.get(providerSessionId).pause(options),
    resume: ({ providerSessionId }, options) => sessions.get(providerSessionId).resume(options),
    heartbeat: ({ providerSessionId }, options) => sessions.get(providerSessionId).heartbeat(options),
  };
  const client = createElevenLabsClient({ sdk, control, closeTimeoutMs, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    persistEvent: async event => { persisted.push(event); } });
  // Joined fixture burns the SERVER authority even for a preflight-cancelled browser start.
  const plugin = { manifest, health: opts => server.health(opts), async start(request, options) {
    const ready = await server.start({ ...request, facadeSecretRef: 'fixture-facade-ref' }, options);
    sessions.set(ready.providerSessionId, ready);
    const joined = createElevenLabsClient({ sdk, control: { ...control, start: async () => receipt(ready) },
      mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
      persistEvent: async event => { persisted.push(event); } });
    try { return await joined.start(request, options); } catch (error) { await ready.close('start-failed', 'cancelled'); throw error; }
  } };
  return { plugin, client, control, server, fetchImpl, requests, saved, calls, sdk, persisted, sessions };
}
export function receipt(session) {
  return { callId: session.callId, providerSessionId: session.providerSessionId, credential: session.credential,
    spendDeadlineAt: session.spendDeadlineAt, browserLivenessDeadlineAt: session.browserLivenessDeadlineAt };
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
