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
      consume() { if (consumed) throw new PluginError('already-claimed'); consumed = true; } },
    reports, report: terminal => { reports.push(terminal); }, ...overrides };
}
export function fakeSdk() {
  const starts = [], effects = []; let closed = false;
  const sdk = { starts, effects, get closed() { return closed; },
    interrupt(eventId = 2) { effects.push(['nativeInterruption', eventId]); starts.at(-1).onInterruption({ event_id: eventId }); },
    async startSession(options) {
      starts.push(options); closed = false;
      const providerSessionId = options.conversationToken?.replace('fixture-token-', '') ?? new URL(options.signedUrl).searchParams.get('conversation_id');
      const object = {
        getId: () => providerSessionId,
        async endSession() { effects.push(['endSession']); closed = true; options.onDisconnect({ reason: 'user' }); },
        setMicMuted(muted) { effects.push(['setMicMuted', muted]); },
        setVolume({ volume }) { effects.push(['setVolume', volume]); },
        sendUserMessage(text) { effects.push(['sendUserMessage', text]); },
        sendContextualUpdate(text) { effects.push(['sendContextualUpdate', text]); },
      };
      options.onConnect({ conversationId: providerSessionId }); return object;
    },
  };
  return sdk;
}
export function fixture({ saveCall, sdk = fakeSdk(), providerDetails, prepareCall = async () => {} } = {}) {
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
    return Response.json(providerDetails ?? { conversation_id: id, status: sdk.closed ? 'done' : 'processing',
      metadata: { call_duration_secs: 120, start_time_unix_secs: (call?.startedAt ?? Date.now()) / 1000, cost: 17 } });
  };
  const server = createElevenLabsServer({ binding, fetchImpl, resolveSecret: () => 'fixture-api-key', prepareCall,
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
  const client = createElevenLabsClient({ sdk, control, persistEvent: async event => { persisted.push(event); } });
  // Joined fixture burns the SERVER authority even for a preflight-cancelled browser start.
  const plugin = { manifest, health: opts => server.health(opts), async start(request, options) {
    const ready = await server.start({ ...request, facadeSecretRef: 'fixture-facade-ref' }, options);
    sessions.set(ready.providerSessionId, ready);
    const joined = createElevenLabsClient({ sdk, control: { ...control, start: async () => receipt(ready) },
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
