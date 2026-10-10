import { readJson } from './server.js';
import { isDeepStrictEqual } from 'node:util';
import { SPOKEN_AI_NOTICE } from '../../../packages/core/src/ai-notice.js';

export const AGENT_NAME = 'aithema-start2';
const SECRET_NAME = 'aithema-start2-facade';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
// Dotted paths of every enabled (true) flag in a provider overrides tree.
const enabled = (value, path = []) => value === true ? [path.join('.')] : value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, item]) => enabled(item, [...path, key])) : [];
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
  // verified by read-only GET 2026-10-09: agents[], agent_id/name,
  // has_more, next_cursor and cursor pagination.
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
  // verified by read-only GET 2026-10-09: agent_id/name, conversation_config
  // TTS/ASR/turn/language/custom_llm and platform_settings privacy/auth/overrides.
  // No request with a method other than GET ever targets templateAgentId.
  const template = await request(`/v1/convai/agents/${encodeURIComponent(templateAgentId)}`);
  if (owned) {
    const remote = await request(`/v1/convai/agents/${encodeURIComponent(owned)}`);
    if (remote.agent_id !== owned || remote.name !== AGENT_NAME) throw new AgentEnsureError('agent-ownership-unproven');
  }
  const config = template.conversation_config;
  if (!id(config?.tts?.voice_id)) throw new AgentEnsureError('template-voice-invalid');
  // verified by read-only GET 2026-10-09: /v1/convai/secrets,
  // {secrets:[{type,secret_id,name,used_by}]}; /v1/convai/workspace/secrets is 404.
  const listed = await request('/v1/convai/secrets');
  if (!Array.isArray(listed.secrets)) throw new AgentEnsureError('secret-list-invalid');
  const named = listed.secrets.filter(secret => secret.name === SECRET_NAME);
  if (named.length > 1) throw new AgentEnsureError('secret-name-ambiguous');
  const cachedSecret = db.prepare('SELECT secret_id FROM host_voice_secrets WHERE name=?').get(SECRET_NAME)?.secret_id;
  if (named.length && named[0].secret_id !== cachedSecret || cachedSecret && named[0]?.secret_id !== cachedSecret) {
    log({ name: SECRET_NAME });
    throw new AgentEnsureError('secret-ownership-unproven');
  }
  let secretId = cachedSecret;
  // UNVERIFIED API SHAPE: POST/PATCH secret bodies.
  if (secretId) {
    await request(`/v1/convai/secrets/${encodeURIComponent(secretId)}`, 'PATCH', { type: 'update', name: SECRET_NAME, value: bearer });
  } else {
    const created = await request('/v1/convai/secrets', 'POST', { type: 'new', name: SECRET_NAME, value: bearer });
    if (!id(created.secret_id)) {
      log({ name: SECRET_NAME });
      throw new AgentEnsureError('secret-create-invalid');
    }
    secretId = created.secret_id;
    db.prepare('INSERT INTO host_voice_secrets VALUES (?,?)').run(SECRET_NAME, secretId);
  }
  // UNVERIFIED API SHAPE: POST /v1/convai/agents/create and PATCH /v1/convai/agents/:id;
  // custom_llm.api_key {secret_id}, llm 'custom-llm', platform_settings.auth/overrides.
  // Require a matching owned-agent GET after every write before enabling voice.
  // The first message is our own spoken AI notice (Art. 50(1), AIT-119), never START's greeting. It is
  // fixed here, server-side and bilingual, because no browser may choose it: the agent refuses a
  // first-message override, and no language preset exists through which a language could pick another.
  const body = { name: AGENT_NAME, conversation_config: {
    tts: { ...pick(config.tts, ['voice_id', 'model_id', 'stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed', 'optimize_streaming_latency', 'agent_output_audio_format']),
      ...(config.tts.voice_settings ? { voice_settings: pick(config.tts.voice_settings, ['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']) } : {}) },
    asr: pick(config.asr, ['quality', 'provider', 'user_input_audio_format', 'keywords']),
    turn: pick(config.turn, ['turn_timeout', 'silence_end_call_timeout', 'mode']),
    conversation: { max_duration_seconds: maxDurationSeconds },
    // UNVERIFIED API SHAPE: conversation_config.language_presets {[language]: {overrides, ...}}; empty clears them.
    language_presets: {},
    agent: { language: config.agent?.language ?? 'en', first_message: SPOKEN_AI_NOTICE,
      prompt: { prompt: '', llm: 'custom-llm', tools: [], knowledge_base: [],
        custom_llm: { url: `${publicOrigin}/api/voice/llm/chat/completions`, model_id: 'aithema-session', api_key: { secret_id: secretId } } } },
  }, platform_settings: {
    privacy: pick(template.platform_settings?.privacy, ['record_voice', 'retention_days', 'delete_audio', 'delete_transcript', 'zero_retention_mode']),
    // UNVERIFIED API SHAPE: allowlist item {hostname}, per ElevenLabs docs; live list was empty.
    auth: { enable_auth: true, allowlist: [{ hostname: origin.host }] },
    // verified by read-only GET 2026-10-09 on START's agent: conversation_config_override.agent
    // {first_message, language}. Only the language may change per conversation (speech recognition and
    // voice); it cannot change the greeting text, which only first_message or a language preset sets.
    overrides: { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: false, language: true } } },
  } };
  let agentId = owned;
  if (agentId) await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, 'PATCH', body);
  else {
    const created = await request('/v1/convai/agents/create', 'POST', body);
    if (!id(created.agent_id) || created.agent_id === templateAgentId) throw new AgentEnsureError('agent-create-invalid');
    agentId = created.agent_id;
    db.prepare('INSERT INTO host_agents VALUES (?,?)').run(AGENT_NAME, agentId);
  }
  let remote;
  try { remote = await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`); }
  catch (error) {
    log({ name: AGENT_NAME, id: agentId, fields: ['agent-readback'] });
    throw error;
  }
  const platform = remote?.platform_settings, prompt = remote?.conversation_config?.agent?.prompt;
  const spoken = remote?.conversation_config?.agent?.first_message, presets = remote?.conversation_config?.language_presets;
  const allowed = platform?.overrides?.conversation_config_override;
  const allowlist = platform?.auth?.allowlist;
  const checks = {
    agent_id: remote?.agent_id === agentId,
    name: remote?.name === AGENT_NAME,
    'platform_settings.auth.enable_auth': platform?.auth?.enable_auth === true,
    'platform_settings.auth.allowlist': Array.isArray(allowlist) && allowlist.length === 1 && allowlist[0]?.hostname === origin.host,
    'platform_settings.overrides.custom_llm_extra_body': platform?.overrides?.custom_llm_extra_body === true,
    'platform_settings.overrides.conversation_config_override.agent.first_message': allowed?.agent?.first_message !== true,
    'platform_settings.overrides.conversation_config_override.agent.language': allowed?.agent?.language === true,
    'platform_settings.overrides.conversation_config_override': isDeepStrictEqual(enabled(allowed), ['agent.language']),
    'conversation_config.agent.first_message': spoken === SPOKEN_AI_NOTICE,
    'conversation_config.language_presets': presets === undefined || presets === null ||
      typeof presets === 'object' && !Array.isArray(presets) && Object.keys(presets).length === 0,
    'conversation_config.agent.prompt.llm': prompt?.llm === 'custom-llm',
    'conversation_config.agent.prompt.custom_llm.url': prompt?.custom_llm?.url === body.conversation_config.agent.prompt.custom_llm.url,
    'conversation_config.agent.prompt.custom_llm.api_key.secret_id': prompt?.custom_llm?.api_key?.secret_id === secretId,
    ...Object.fromEntries(Object.entries(body.platform_settings.privacy).map(([field, expected]) =>
      [`platform_settings.privacy.${field}`, isDeepStrictEqual(platform?.privacy?.[field], expected)])),
  };
  const fields = Object.keys(checks).filter(field => !checks[field]);
  if (fields.length) {
    log({ name: AGENT_NAME, id: agentId, fields });
    throw new AgentEnsureError('agent-readback-mismatch');
  }
  log({ name: AGENT_NAME, id: agentId }); // Never log bodies, errors from fetch, secrets, or template data.
  return { agentId, apiBaseUrl: base.href.replace(/\/$/u, '') };
}
