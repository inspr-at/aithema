import { readJson } from './server.js';

export const AGENT_NAME = 'aithema-start2';
const SECRET_NAME = 'aithema-start2-facade';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
export class AgentEnsureError extends Error {}

/** Only the local creation receipt authorizes future writes. Remote names confer no ownership. */
export async function ensureAgent({ storage, templateAgentId, publicOrigin, resolveSecret,
  apiBaseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, log = console.log, maxDurationSeconds = 600 } = {}) {
  if (!id(templateAgentId)) throw new AgentEnsureError('template-agent-required');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new AgentEnsureError('public-origin-invalid');
  const base = new URL(apiBaseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) || base.username || base.password || base.search || base.hash) throw new AgentEnsureError('api-base-invalid');
  const key = await resolveSecret('ELEVENLABS_API_KEY'), bearer = await resolveSecret('AITHEMA_VOICE_FACADE_SECRET');
  if (typeof key !== 'string' || !key || typeof bearer !== 'string' || !bearer || /[\r\n]/u.test(key + bearer)) throw new AgentEnsureError('voice-secret-unavailable');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS host_agents (name TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS host_voice_secrets (name TEXT PRIMARY KEY, secret_id TEXT NOT NULL UNIQUE);`);
  const request = async (path, method = 'GET', body) => {
    try {
      const response = await fetchImpl(`${base.href.replace(/\/$/u, '')}${path}`, { method, redirect: 'error',
        signal: AbortSignal.timeout(15_000), headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new AgentEnsureError(`agent-api-${method.toLowerCase()}-${response.status}`); }
      return await readJson(response, 1_048_576);
    } catch (error) { throw error instanceof AgentEnsureError ? error : new AgentEnsureError('agent-api-unavailable'); }
  };
  // UNVERIFIED API SHAPE: START has no list/write agent implementation.
  // Assumed GET /v1/convai/agents with agents[], has_more, next_cursor and cursor pagination.
  const matches = new Map(); let cursor, pages = 0; const cursors = new Set();
  do {
    if (++pages > 100) throw new AgentEnsureError('agent-list-incomplete');
    const page = await request(`/v1/convai/agents?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(page.agents) || typeof page.has_more !== 'boolean') throw new AgentEnsureError('agent-list-invalid');
    for (const agent of page.agents) {
      if (agent.name !== AGENT_NAME) continue;
      if (!id(agent.agent_id)) throw new AgentEnsureError('agent-list-invalid');
      matches.set(agent.agent_id, agent);
    }
    if (!page.has_more) break;
    cursor = page.next_cursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new AgentEnsureError('agent-list-incomplete');
    cursors.add(cursor);
  } while (true);
  if (matches.size > 1) throw new AgentEnsureError('agent-name-ambiguous');
  const owned = db.prepare('SELECT agent_id FROM host_agents WHERE name=?').get(AGENT_NAME)?.agent_id;
  const existing = [...matches.keys()][0];
  if (existing === templateAgentId || owned === templateAgentId) throw new AgentEnsureError('template-agent-write-forbidden');
  if (existing && existing !== owned || owned && existing !== owned) throw new AgentEnsureError('agent-ownership-unproven');
  // Confirmed GET path/config envelope: START src/pages/api/health.ts remoteAgentCeilingSeconds.
  // UNVERIFIED API SHAPE: agent GET name/agent_id and detailed TTS/ASR/turn/privacy
  // fields; START consumes only conversation_config.conversation.max_duration_seconds.
  // No request with a method other than GET ever targets templateAgentId.
  const template = await request(`/v1/convai/agents/${encodeURIComponent(templateAgentId)}`);
  if (owned) {
    const remote = await request(`/v1/convai/agents/${encodeURIComponent(owned)}`);
    if (remote.agent_id !== owned || remote.name !== AGENT_NAME) throw new AgentEnsureError('agent-ownership-unproven');
  }
  const config = template.conversation_config;
  if (!id(config?.tts?.voice_id)) throw new AgentEnsureError('template-voice-invalid');
  // UNVERIFIED API SHAPE: workspace secret list/create/update is absent from START.
  // Assumed GET/POST /v1/convai/workspace/secrets and PATCH /.../secrets/:secret_id;
  // list {secrets:[{name,secret_id}]}, create {type:'new',name,value}, update {type:'update',value}.
  const listed = await request('/v1/convai/workspace/secrets');
  if (!Array.isArray(listed.secrets)) throw new AgentEnsureError('secret-list-invalid');
  const named = listed.secrets.filter(secret => secret.name === SECRET_NAME);
  if (named.length > 1) throw new AgentEnsureError('secret-name-ambiguous');
  const cachedSecret = db.prepare('SELECT secret_id FROM host_voice_secrets WHERE name=?').get(SECRET_NAME)?.secret_id;
  if (named.length && named[0].secret_id !== cachedSecret || cachedSecret && named[0]?.secret_id !== cachedSecret) throw new AgentEnsureError('secret-ownership-unproven');
  let secretId = cachedSecret;
  if (secretId) {
    await request(`/v1/convai/workspace/secrets/${encodeURIComponent(secretId)}`, 'PATCH', { type: 'update', value: bearer });
  } else {
    const created = await request('/v1/convai/workspace/secrets', 'POST', { type: 'new', name: SECRET_NAME, value: bearer });
    if (!id(created.secret_id)) throw new AgentEnsureError('secret-create-invalid');
    secretId = created.secret_id;
    db.prepare('INSERT INTO host_voice_secrets VALUES (?,?)').run(SECRET_NAME, secretId);
  }
  // UNVERIFIED API SHAPE: POST /v1/convai/agents/create and PATCH /v1/convai/agents/:id;
  // custom_llm.api_key {secret_id}, llm 'custom-llm', platform_config.auth/overrides,
  // TTS/ASR/turn/privacy fields below are not exposed by START's agent GET consumer.
  const body = { name: AGENT_NAME, conversation_config: {
    tts: { ...pick(config.tts, ['voice_id', 'model_id', 'stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed', 'optimize_streaming_latency', 'agent_output_audio_format']),
      ...(config.tts.voice_settings ? { voice_settings: pick(config.tts.voice_settings, ['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']) } : {}) },
    asr: pick(config.asr, ['quality', 'provider', 'user_input_audio_format', 'keywords']),
    turn: pick(config.turn, ['turn_timeout', 'silence_end_call_timeout', 'mode']),
    conversation: { max_duration_seconds: maxDurationSeconds },
    agent: { language: config.agent?.language ?? 'en', first_message: '',
      prompt: { prompt: '', llm: 'custom-llm', tools: [], knowledge_base: [],
        custom_llm: { url: `${publicOrigin}/api/voice/llm/chat/completions`, model_id: 'aithema-session', api_key: { secret_id: secretId } } } },
  }, platform_config: {
    privacy: pick(template.platform_config?.privacy, ['record_voice', 'retention_days', 'delete_audio', 'delete_transcript', 'zero_retention_mode']),
    auth: { enable_auth: true, allowlist: [{ hostname: publicOrigin }] },
    overrides: { custom_llm_extra_body: true },
  } };
  let agentId = owned;
  if (agentId) await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, 'PATCH', body);
  else {
    const created = await request('/v1/convai/agents/create', 'POST', body);
    if (!id(created.agent_id) || created.agent_id === templateAgentId) throw new AgentEnsureError('agent-create-invalid');
    agentId = created.agent_id;
    db.prepare('INSERT INTO host_agents VALUES (?,?)').run(AGENT_NAME, agentId);
  }
  log({ name: AGENT_NAME, id: agentId }); // Never log bodies, errors from fetch, secrets, or template data.
  return { agentId, apiBaseUrl: base.href.replace(/\/$/u, '') };
}
