import { mock } from 'node:test';
import { createVoiceHost as createStart2VoiceHost } from '../../demo/start2-voice-host.js';

// In-memory provider API: every provider request is intercepted, including tokens.
export function stubAgentApi() {
  const state = { endpoint: 'http://127.0.0.1:1', requests: [], agents: [], secrets: [],
    template: { agent_id: 'template-agent', name: 'START', conversation_config: {
      agent: { language: 'en' }, tts: { voice_id: 'fixture-voice' }, asr: {}, turn: {},
    }, platform_settings: { privacy: {} } } };
  state.fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname, method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ path, method, body });
    if (path === '/v1/convai/agents') return Response.json({ agents: state.agents, has_more: false });
    if (path.endsWith('/agents/template-agent')) {
      if (method !== 'GET') throw new Error('START must be GET-only');
      return Response.json(state.template);
    }
    if (path === '/v1/convai/secrets') {
      if (method === 'POST') state.secrets.push({ name: body.name, secret_id: 'owned-secret' });
      return Response.json(method === 'POST' ? { secret_id: 'owned-secret' } : { secrets: state.secrets });
    }
    if (path.endsWith('/secrets/owned-secret')) return Response.json({ secret_id: 'owned-secret' });
    if (path.endsWith('/agents/create')) {
      state.agents.push({ ...body, agent_id: 'owned-agent' });
      return Response.json({ agent_id: 'owned-agent' });
    }
    if (path.endsWith('/agents/owned-agent')) {
      if (method === 'PATCH') Object.assign(state.agents[0], body);
      return Response.json(state.agents[0]);
    }
    if (path.endsWith('/conversation/token')) return Response.json({ token: 'fixture-token', conversation_id: 'fixture-conversation' });
    if (path.endsWith('/conversations/fixture-conversation')) return Response.json({ conversation_id: 'fixture-conversation', status: 'done',
      metadata: { call_duration_secs: 1, cost_fiat: 0.001 } });
    throw new Error('Unexpected fixture API request');
  };
  return state;
}

export async function createVoiceHost(options) {
  const api = stubAgentApi(), failure = process.env.AITHEMA_TEST_VOICE_FAILURE ?? '503';
  let failed = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = api.fetchImpl;
  const host = await createStart2VoiceHost({ ...options, publicOrigin: options.publicOrigin ?? 'https://fixture.test',
    apiBaseUrl: api.endpoint, values: {}, random: () => 0.5,
    resolveSecret: () => 'fixture-secret', fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/v1/convai/agents' && !failed && failure !== 'none') {
        failed = true;
        if (failure === 'network') throw new TypeError('fixture network failure');
        if (failure === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError');
        return new Response(null, { status: Number(failure) });
      }
      return api.fetchImpl(url, init);
    } });
  process.on('message', async message => {
    if (message.event !== 'advance-voice-clock') return;
    mock.timers.tick(message.ms);
    // All fixture API operations resolve as microtasks; let the retry finish.
    await new Promise(resolve => setImmediate(resolve));
    process.send({ event: 'voice-clock-advanced', requests: api.requests });
  });
  // The IPC clock listener must not keep this fixture child alive after shutdown.
  process.once('SIGTERM', () => process.disconnect());
  process.once('SIGINT', () => process.disconnect());
  return host;
}
