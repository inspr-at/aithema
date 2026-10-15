import { readJson } from './server.js';
import { isDeepStrictEqual } from 'node:util';
import { aiNoticeText } from '@inspr/aithema-core/ai-notice';
import { voiceOverrides } from './options.js';

/** Base URL path of the voice callback; the platform appends /chat/completions (static route: /api/voice/llm/chat/completions). */
export const CUSTOM_LLM_BASE_PATH = '/api/voice/llm';

// Detailed requirements need room for thinking pauses and spelled domains.
// This owned-agent policy replaces START's eager settings when they drift.
// https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow
const TURN_POLICY = Object.freeze({ turn_eagerness: 'patient', turn_timeout: 12,
  spelling_patience: 'auto', turn_model: 'turn_v3', speculative_turn: false });
// Seconds since the user last spoke, independent of turn_timeout and total duration.
// https://github.com/elevenlabs/elevenlabs-python/blob/ea9589784336ba9aa9fc0dc01683a15da2562080/src/elevenlabs/types/turn_config.py#L22
// Qualified against the official agent API/OpenAPI and pinned browser SDK:
// no supported last-agent-message timeout. README documents the remaining
// absent-reply gap and the existing 3600-second total-duration/orphan handling.
const SILENCE_END_CALL_TIMEOUT = 120;
const ASR_KEYWORDS = Object.freeze(['Aithema', 'Hosting', 'Domain', 'Webshop', 'Schnittstelle', 'Datenschutz']);
const CLIENT_EVENTS = Object.freeze(['conversation_initiation_metadata', 'asr_initiation_metadata', 'audio', 'interruption',
  'user_transcript', 'tentative_user_transcript', 'agent_response',
  'agent_response_correction', 'agent_chat_response_part', 'agent_response_metadata', 'ping']);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
// Every leaf of a provider overrides tree as [dotted path, value]; only non-empty plain objects are
// descended, so null, arrays, strings and empty objects surface as leaves that no boolean check accepts.
const leaves = (value, path = []) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length
  ? Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key])) : [[path.join('.'), value]];
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
// Compare only the desired managed shape. Provider metadata and extra settings are
// not ours. Empty maps/arrays are intentional clears and remain exact comparisons.
// These TTS defaults are also used when the API elides default-valued properties;
// null, strings and missing security/identity fields are never defaulted.
const OMITTED_DEFAULTS = Object.freeze({
  'conversation_config.tts.stability': 0.5,
  'conversation_config.tts.speed': 1,
  'conversation_config.tts.similarity_boost': 0.8,
});
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function managedDrift(remote, desired, path = '') {
  if (remote === undefined && Object.hasOwn(OMITTED_DEFAULTS, path)) remote = OMITTED_DEFAULTS[path];
  if (path === 'platform_settings.overrides.conversation_config_override') {
    // Extra explicitly false override flags are equivalent to disabled defaults.
    // Keep malformed leaves and unknown enabled flags visible as drift.
    const enabled = tree => leaves(tree).filter(([, value]) => value !== false).sort(([a], [b]) => a.localeCompare(b));
    return isDeepStrictEqual(enabled(remote), enabled(desired)) ? [] : [path];
  }
  if (plainObject(desired) && Object.keys(desired).length) {
    return Object.entries(desired).flatMap(([key, value]) => managedDrift(
      plainObject(remote) ? remote[key] : undefined, value, path ? `${path}.${key}` : key));
  }
  return isDeepStrictEqual(remote, desired) ? [] : [path];
}
export class AgentEnsureError extends Error {
  constructor(reason, { transient = false } = {}) {
    super(reason);
    this.transient = transient;
  }
}

/** Only the local creation receipt authorizes future writes. Remote names confer no ownership. */
export async function ensureAgent({ storage, templateAgentId, publicOrigin, resolveSecret,
  apiBaseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, log = console.log, maxDurationSeconds = 3600,
  spokenOpeners, signal, agentName, facadeSecretName } = {}) {
  if (!id(agentName)) throw new AgentEnsureError('agentName is required and must be a host-specific identifier');
  if (!id(facadeSecretName)) throw new AgentEnsureError('facadeSecretName is required and must be a host-specific identifier');
  // Reject a host configuration without AI disclosure before any provider read or write.
  const openers = Object.fromEntries(['de', 'en'].map(language => {
    const firstMessage = aiNoticeText(language, { opener: spokenOpeners?.[language] });
    voiceOverrides({ agent: { language, firstMessage } });
    return [language, firstMessage];
  }));
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
      // Shutdown stops new work. Started writes and their ownership receipts finish
      // under their own timeout; only reads also inherit the shutdown signal.
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal && method === 'GET' ? AbortSignal.any([signal, timeout]) : timeout;
      requestSignal.throwIfAborted();
      const response = await fetchImpl(`${base.href.replace(/\/$/u, '')}${path}`, { method, redirect: 'error',
        signal: requestSignal, headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AgentEnsureError(`agent-api-${method.toLowerCase()}-${response.status}`,
          { transient: response.status === 429 || response.status >= 500 && response.status < 600 });
      }
      return await readJson(response, 1_048_576, { signal: requestSignal });
    } catch (error) {
      throw error instanceof AgentEnsureError ? error : new AgentEnsureError('agent-api-unavailable',
        { transient: !['invalid-output', 'limit'].includes(error?.code) });
    }
  };
  // verified by read-only GET 2026-10-09: agents[], agent_id/name,
  // has_more, next_cursor and cursor pagination.
  const matches = new Map(); let cursor, pages = 0; const cursors = new Set();
  do {
    if (++pages > 100) throw new AgentEnsureError('agent-list-incomplete');
    const page = await request(`/v1/convai/agents?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(page.agents) || typeof page.has_more !== 'boolean') throw new AgentEnsureError('agent-list-invalid');
    for (const agent of page.agents) {
      if (agent.name !== agentName) continue;
      if (!id(agent.agent_id)) throw new AgentEnsureError('agent-list-invalid');
      matches.set(agent.agent_id, agent);
    }
    if (!page.has_more) break;
    cursor = page.next_cursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new AgentEnsureError('agent-list-incomplete');
    cursors.add(cursor);
  } while (true);
  if (matches.size > 1) throw new AgentEnsureError('agent-name-ambiguous');
  const owned = db.prepare('SELECT agent_id FROM host_agents WHERE name=?').get(agentName)?.agent_id;
  const existing = [...matches.keys()][0];
  if (existing === templateAgentId || owned === templateAgentId) throw new AgentEnsureError('template-agent-write-forbidden');
  if (existing && existing !== owned || owned && existing !== owned) throw new AgentEnsureError('agent-ownership-unproven');
  // verified by read-only GET 2026-10-09: agent_id/name, conversation_config
  // TTS/ASR/turn/language/custom_llm and platform_settings privacy/auth/overrides.
  // No request with a method other than GET ever targets templateAgentId.
  const template = await request(`/v1/convai/agents/${encodeURIComponent(templateAgentId)}`);
  let remote;
  if (owned) {
    remote = await request(`/v1/convai/agents/${encodeURIComponent(owned)}`);
    if (remote.agent_id !== owned || remote.name !== agentName) throw new AgentEnsureError('agent-ownership-unproven');
  }
  const config = template.conversation_config;
  if (!id(config?.tts?.voice_id)) throw new AgentEnsureError('template-voice-invalid');
  // verified by read-only GET 2026-10-09: /v1/convai/secrets,
  // {secrets:[{type,secret_id,name,used_by}]}; /v1/convai/workspace/secrets is 404.
  const listed = await request('/v1/convai/secrets');
  if (!Array.isArray(listed.secrets)) throw new AgentEnsureError('secret-list-invalid');
  const named = listed.secrets.filter(secret => secret.name === facadeSecretName);
  if (named.length > 1) throw new AgentEnsureError('secret-name-ambiguous');
  const cachedSecret = db.prepare('SELECT secret_id FROM host_voice_secrets WHERE name=?').get(facadeSecretName)?.secret_id;
  if (named.length && named[0].secret_id !== cachedSecret || cachedSecret && named[0]?.secret_id !== cachedSecret) {
    log({ name: facadeSecretName });
    throw new AgentEnsureError('secret-ownership-unproven');
  }
  let secretId = cachedSecret;
  // UNVERIFIED API SHAPE: POST/PATCH secret bodies.
  if (secretId) {
    await request(`/v1/convai/secrets/${encodeURIComponent(secretId)}`, 'PATCH', { type: 'update', name: facadeSecretName, value: bearer });
  } else {
    const created = await request('/v1/convai/secrets', 'POST', { type: 'new', name: facadeSecretName, value: bearer });
    if (!id(created.secret_id)) {
      log({ name: facadeSecretName });
      throw new AgentEnsureError('secret-create-invalid');
    }
    secretId = created.secret_id;
    db.prepare('INSERT INTO host_voice_secrets VALUES (?,?)').run(facadeSecretName, secretId);
  }
  // UNVERIFIED API SHAPE: POST /v1/convai/agents/create and PATCH /v1/convai/agents/:id;
  // custom_llm.api_key {secret_id}, llm 'custom-llm', platform_settings.auth/overrides.
  // Require a matching owned-agent GET after every write before enabling voice.
  // The host supplies the same AI opener for the stored fallback and per-call override.
  // Only our receipt-owned aithema-start2 agent is changed, never START's template.
  const language = ['en', 'de'].includes(config.agent?.language) ? config.agent.language : 'de';
  const firstMessage = openers[language];
  const body = { name: agentName, conversation_config: {
    tts: { ...pick(config.tts, ['voice_id', 'model_id', 'stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed', 'optimize_streaming_latency', 'agent_output_audio_format']),
      ...(config.tts.voice_settings ? { voice_settings: pick(config.tts.voice_settings, ['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']) } : {}) },
    asr: { ...pick(config.asr, ['quality', 'provider', 'user_input_audio_format']), keywords: [...ASR_KEYWORDS] },
    turn: { ...pick(config.turn, ['mode']), ...TURN_POLICY, silence_end_call_timeout: SILENCE_END_CALL_TIMEOUT },
    conversation: { max_duration_seconds: maxDurationSeconds, client_events: [...CLIENT_EVENTS] },
    // UNVERIFIED API SHAPE: conversation_config.language_presets {[language]: {overrides, ...}}; empty clears them.
    language_presets: {},
    agent: { language, first_message: firstMessage,
      prompt: { prompt: '', llm: 'custom-llm', tools: [], knowledge_base: [],
        // A base URL: ElevenLabs' custom-LLM client (AsyncOpenAI) appends /chat/completions itself, as START's agent
        // (https://start.augmentoring.com/api/v2/llm) shows. The full path was doubled live on 2026-10-10 and fell outside
        // the host's exact-path callback bypass (AIT-126). The server route stays /api/voice/llm/chat/completions.
        custom_llm: { url: `${publicOrigin}${CUSTOM_LLM_BASE_PATH}`, model_id: 'aithema-session', api_key: { secret_id: secretId } } } },
  }, platform_settings: {
    privacy: pick(template.platform_settings?.privacy, ['record_voice', 'retention_days', 'delete_audio', 'delete_transcript', 'zero_retention_mode']),
    // UNVERIFIED API SHAPE: allowlist item {hostname}, per ElevenLabs docs; live list was empty.
    auth: { enable_auth: true, allowlist: [{ hostname: origin.host }] },
    // First-message and language overrides are documented platform fields. The client accepts
    // only a host AI opener in the server's locale; prompt/model/voice overrides stay closed.
    overrides: { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: true, language: true } } },
  } };
  let agentId = owned;
  const drift = owned ? managedDrift(remote, body) : [];
  if (agentId && drift.length) {
    // The documented PATCH accepts optional top-level configuration objects;
    // nested replacement/merge semantics are not guaranteed. Send the full
    // managed object for each changed top-level field, never unrelated objects.
    // https://elevenlabs.io/docs/api-reference/agents/update
    const changed = new Set(drift.map(field => field.split('.')[0]));
    await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, 'PATCH', pick(body, [...changed]));
  } else if (!agentId) {
    const created = await request('/v1/convai/agents/create', 'POST', body);
    if (!id(created.agent_id) || created.agent_id === templateAgentId) throw new AgentEnsureError('agent-create-invalid');
    agentId = created.agent_id;
    db.prepare('INSERT INTO host_agents VALUES (?,?)').run(agentName, agentId);
  }
  try {
    if (!owned || drift.length) remote = await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
  }
  catch (error) {
    log({ name: agentName, id: agentId, fields: ['agent-readback'] });
    throw error;
  }
  const platform = remote?.platform_settings, prompt = remote?.conversation_config?.agent?.prompt;
  const spoken = remote?.conversation_config?.agent?.first_message, presets = remote?.conversation_config?.language_presets;
  const allowed = platform?.overrides?.conversation_config_override;
  const allowlist = platform?.auth?.allowlist;
  const checks = {
    agent_id: remote?.agent_id === agentId,
    name: remote?.name === agentName,
    'platform_settings.auth.enable_auth': platform?.auth?.enable_auth === true,
    'platform_settings.auth.allowlist': Array.isArray(allowlist) && allowlist.length === 1 && allowlist[0]?.hostname === origin.host,
    'platform_settings.overrides.custom_llm_extra_body': platform?.overrides?.custom_llm_extra_body === true,
    // Explicit values only: an omitted, null or string flag is no proof that an override is refused.
    'platform_settings.overrides.conversation_config_override.agent.first_message': allowed?.agent?.first_message === true,
    'platform_settings.overrides.conversation_config_override.agent.language': allowed?.agent?.language === true,
    'platform_settings.overrides.conversation_config_override': leaves(allowed).every(([path, flag]) => flag === ['agent.language', 'agent.first_message'].includes(path)),
    'conversation_config.agent.language': remote?.conversation_config?.agent?.language === language,
    'conversation_config.conversation.max_duration_seconds': remote?.conversation_config?.conversation?.max_duration_seconds === maxDurationSeconds,
    'conversation_config.conversation.client_events': isDeepStrictEqual(remote?.conversation_config?.conversation?.client_events, CLIENT_EVENTS),
    'conversation_config.agent.first_message': spoken === firstMessage,
    'conversation_config.language_presets': isDeepStrictEqual(presets, {}),
    'conversation_config.turn.silence_end_call_timeout': remote?.conversation_config?.turn?.silence_end_call_timeout === SILENCE_END_CALL_TIMEOUT,
    ...Object.fromEntries(Object.entries(TURN_POLICY).map(([field, expected]) =>
      [`conversation_config.turn.${field}`, isDeepStrictEqual(remote?.conversation_config?.turn?.[field], expected)])),
    'conversation_config.asr.keywords': isDeepStrictEqual(remote?.conversation_config?.asr?.keywords, ASR_KEYWORDS),
    'conversation_config.agent.prompt.llm': prompt?.llm === 'custom-llm',
    'conversation_config.agent.prompt.custom_llm.url': prompt?.custom_llm?.url === body.conversation_config.agent.prompt.custom_llm.url,
    'conversation_config.agent.prompt.custom_llm.api_key.secret_id': prompt?.custom_llm?.api_key?.secret_id === secretId,
    ...Object.fromEntries(Object.entries(body.platform_settings.privacy).map(([field, expected]) =>
      [`platform_settings.privacy.${field}`, isDeepStrictEqual(platform?.privacy?.[field], expected)])),
  };
  const fields = Object.keys(checks).filter(field => !checks[field]);
  if (fields.length) {
    log({ name: agentName, id: agentId, fields });
    throw new AgentEnsureError('agent-readback-mismatch');
  }
  // Read-back covers the whole managed shape, including TTS, prompt and tools.
  const remaining = managedDrift(remote, body);
  if (remaining.length) {
    log({ name: agentName, id: agentId, fields: remaining });
    throw new AgentEnsureError('agent-readback-mismatch');
  }
  const message = !owned ? 'elevenlabs agent ensured: created' : drift.length
    ? `elevenlabs agent ensured: patched (fields: ${drift.join(', ')})` : 'elevenlabs agent ensured: unchanged';
  log({ name: agentName, id: agentId, message }); // Field names only; never provider values.
  return { agentId, apiBaseUrl: base.href.replace(/\/$/u, '') };
}
