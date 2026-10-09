import { listen } from '../packages/server/src/http.js';

export async function fakeElevenLabs(t, { agents = [], pageSize = 100 } = {}) {
  const state = { agents: structuredClone(agents), secrets: [], requests: [] };
  const template = { agent_id: 'template-agent', name: 'START', conversation_config: {
    agent: { language: 'en', first_message: 'template greeting', prompt: { prompt: 'template persona', knowledge_base: ['private'], tools: ['private'] } },
    tts: { voice_id: 'voice-fixture', model_id: 'eleven_turbo_v2', stability: 0.5, unknown: 'private' },
    asr: { quality: 'high', provider: 'elevenlabs' }, turn: { turn_timeout: 7, silence_end_call_timeout: 20 },
    conversation: { max_duration_seconds: 600 },
  }, platform_settings: { privacy: { retention_days: 30, record_voice: false }, overrides: { custom_llm_extra_body: true, prompt: true } } };
  const unknownKeys = (body, allowed) => !body || Object.keys(body).some(key => !allowed.includes(key));
  const agentShape = agent => ({ agent_id: agent.agent_id, name: agent.name,
    conversation_config: agent.conversation_config,
    platform_settings: agent.platform_settings ?? { auth: { enable_auth: false, allowlist: [] }, privacy: {}, overrides: { custom_llm_extra_body: false } } });
  const running = await listen(async request => {
    const url = new URL(request.url), body = request.method === 'GET' ? null : await request.json();
    state.requests.push({ path: url.pathname, search: url.search, method: request.method, body });
    if (url.pathname === '/v1/convai/agents' && request.method === 'GET') {
      const start = Number(url.searchParams.get('cursor') ?? 0), entries = state.agents.slice(start, start + pageSize);
      return Response.json({ agents: entries.map(({ agent_id, name }) => ({ agent_id, name })), has_more: start + pageSize < state.agents.length, next_cursor: String(start + pageSize) });
    }
    if (url.pathname === '/v1/convai/agents/create' && request.method === 'POST') {
      if (unknownKeys(body, ['name', 'conversation_config', 'platform_settings'])) return Response.json({}, { status: 400 });
      const agent = agentShape({ ...body, agent_id: 'owned-agent' }); state.agents.push(agent); return Response.json({ agent_id: agent.agent_id });
    }
    if (url.pathname.startsWith('/v1/convai/agents/')) {
      const id = url.pathname.split('/').at(-1);
      if (id === template.agent_id && request.method === 'GET') return Response.json(template);
      const existing = state.agents.find(a => a.agent_id === id);
      if (!existing) return Response.json({}, { status: 404 });
      if (request.method === 'PATCH') {
        if (unknownKeys(body, ['name', 'conversation_config', 'platform_settings'])) return Response.json({}, { status: 400 });
        Object.assign(existing, body);
      }
      return Response.json(agentShape(existing));
    }
    if (url.pathname === '/v1/convai/secrets') {
      if (request.method === 'POST') {
        if (unknownKeys(body, ['type', 'name', 'value'])) return Response.json({}, { status: 400 });
        state.secrets.push({ type: 'new', name: body.name, secret_id: 'owned-secret', used_by: [] }); return Response.json({ secret_id: 'owned-secret' });
      }
      return Response.json({ secrets: state.secrets });
    }
    if (url.pathname.startsWith('/v1/convai/secrets/') && request.method === 'PATCH') {
      if (unknownKeys(body, ['type', 'name', 'value'])) return Response.json({}, { status: 400 });
      const secret = state.secrets.find(s => s.secret_id === url.pathname.split('/').at(-1));
      if (!secret) return Response.json({}, { status: 404 });
      secret.name = body.name;
      return Response.json({ secret_id: secret.secret_id });
    }
    if (url.pathname.endsWith('/token')) return Response.json({ token: 'local-token-fixture', conversation_id: `provider-${state.requests.length}` });
    if (url.pathname.startsWith('/v1/convai/conversations/')) return Response.json({ conversation_id: url.pathname.split('/').at(-1), status: 'done',
      metadata: { call_duration_secs: 1, start_time_unix_secs: Date.now() / 1000, cost: 12 } });
    return Response.json({}, { status: 404 });
  });
  t.after(async () => { running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); });
  return { ...state, template, endpoint: running.url };
}
