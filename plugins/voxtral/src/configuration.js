import { deepFreeze } from '../../../packages/core/src/plugins.js';

export const STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
export const TTS_MODEL = 'voxtral-mini-tts-2603';
export const EVIDENCE_DATE = '2026-10-19';
export const STT_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
// Speech API PCM is float32 LE. Never send this to a PCM16 player.
// The physical output sample rate still requires live qualification.
export const TTS_FORMAT = Object.freeze({ encoding: 'pcm_f32le', sampleRateHz: 24000, channels: 1 });
const reference = value => typeof value === 'string' && /^private:[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/u.test(value);
const sameFormat = (value, expected) => value && Object.keys(value).length === 3 &&
  ['encoding', 'sampleRateHz', 'channels'].every(key => value[key] === expected[key]);

/** Pure server configuration. Only a secret reference is stored; no credentials
 * or environment lookups. Saved voice syntax is checked here; account ownership,
 * provider availability and full-chain regional admission require the account authority. */
export function validateVoxtralConfiguration(raw = {}, { now = Date.now() } = {}) {
  const fail = () => { throw new TypeError('Invalid Voxtral private configuration'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  const allowed = ['endpoint', 'secretRef', 'voiceId', 'sttFormat', 'ttsFormat', 'languages',
    'targetDelayMs', 'sttMicroPerSecond', 'ttsMicroPerCharacter', 'accountRef', 'accountEvidence'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail();
  const value = { endpoint: 'https://api.mistral.ai', sttFormat: STT_FORMAT, ttsFormat: TTS_FORMAT,
    languages: ['de', 'en'], targetDelayMs: 480, sttMicroPerSecond: 100, ttsMicroPerCharacter: 16, ...raw };
  let url;
  try { url = new URL(value.endpoint); } catch { fail(); }
  if (typeof value.endpoint !== 'string' || url.origin !== value.endpoint || url.protocol !== 'https:' ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !reference(value.secretRef) || typeof value.voiceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value.voiceId) ||
    !sameFormat(value.sttFormat, STT_FORMAT) || !sameFormat(value.ttsFormat, TTS_FORMAT) ||
    !Array.isArray(value.languages) || !value.languages.length ||
    value.languages.some(language => !['de', 'en'].includes(language)) ||
    new Set(value.languages).size !== value.languages.length ||
    !Number.isSafeInteger(value.targetDelayMs) || value.targetDelayMs < 0 || value.targetDelayMs > 2400 ||
    ![value.sttMicroPerSecond, value.ttsMicroPerCharacter].every(n => Number.isSafeInteger(n) && n >= 0)) fail();
  voxtralEndpoints(value.endpoint);
  if (value.accountRef !== undefined || value.accountEvidence !== undefined) validateAccountEvidence(value, now);
  return deepFreeze({ ...value, ...(value.accountEvidence ? { accountEvidence: structuredClone(value.accountEvidence) } : {}), sttFormat: { ...value.sttFormat }, ttsFormat: { ...value.ttsFormat }, languages: [...value.languages] });
}

/** Exact transport targets. Regional selection never falls back to the global origin. */
export function voxtralEndpoints(endpoint) {
  if (!['https://api.mistral.ai', 'https://api.eu.mistral.ai'].includes(endpoint)) {
    throw new TypeError('Invalid Mistral API origin');
  }
  return Object.freeze({
    stt: `${endpoint.replace('https:', 'wss:')}/v1/audio/transcriptions/realtime?model=${STT_MODEL}`,
    reasoning: `${endpoint}/v1/chat/completions`, tts: `${endpoint}/v1/audio/speech`,
  });
}

const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const countries = (value, empty = false) => Array.isArray(value) && (empty || value.length > 0) &&
  value.every(country => typeof country === 'string' && /^[A-Z]{2}$/u.test(country)) && new Set(value).size === value.length;
function validateAccountEvidence(config, now) {
  const fail = () => { throw new TypeError('Invalid Voxtral private account evidence'); };
  const e = config.accountEvidence, endpoints = voxtralEndpoints(config.endpoint);
  if (!Number.isFinite(now) || !reference(config.accountRef) || !shape(e, ['accountRef', 'secretRef', 'endpoint',
    'dpaAccepted', 'dpaRef', 'recipient', 'recipientCountries', 'undertaking', 'zdrEnabled', 'zdrRef', 'zdrEndpoints',
    'trainingOptOut', 'trainingRef', 'availabilityRef', 'reviewedAt', 'expiresAt', 'services'])) fail();
  if (e.accountRef !== config.accountRef || e.secretRef !== config.secretRef || e.endpoint !== config.endpoint ||
    e.dpaAccepted !== true || e.zdrEnabled !== true || e.trainingOptOut !== true ||
    ['dpaRef', 'zdrRef', 'trainingRef', 'availabilityRef'].some(key => !reference(e[key])) ||
    typeof e.recipient !== 'string' || !e.recipient.trim() || e.recipient.length > 512 ||
    !countries(e.recipientCountries) || !date(e.reviewedAt) || !date(e.expiresAt) ||
    Date.parse(e.reviewedAt) > now || Date.parse(e.expiresAt) <= now || Date.parse(e.expiresAt) <= Date.parse(e.reviewedAt)) fail();
  const undertaking = e.undertaking;
  if (!shape(undertaking, ['region', 'processingCountries', 'controlPlaneIncluded']) ||
    !['EU', 'EU/EFTA', 'uncommitted'].includes(undertaking.region) ||
    typeof undertaking.controlPlaneIncluded !== 'boolean' ||
    !countries(undertaking.processingCountries, undertaking.region === 'uncommitted')) fail();
  if (!shape(e.services, ['stt', 'reasoning', 'tts']) || !Array.isArray(e.zdrEndpoints) ||
    e.zdrEndpoints.length !== 3 || new Set(e.zdrEndpoints).size !== 3) fail();
  for (const role of ['stt', 'reasoning', 'tts']) {
    const service = e.services[role];
    if (!shape(service, ['model', 'endpoint']) || service.endpoint !== endpoints[role] ||
      !e.zdrEndpoints.includes(endpoints[role]) || typeof service.model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(service.model) ||
      role === 'stt' && service.model !== STT_MODEL || role === 'tts' && service.model !== TTS_MODEL) fail();
  }
}

/** Mandatory account admission layer, separate from effect-free component preflight.
 * Evidence is owner-supplied private data; this validates it without dereferencing
 * documents, keys or endpoints. It never turns public regional docs into a promise. */
export function validateVoxtralAccountConfiguration(raw, options) {
  const config = validateVoxtralConfiguration(raw, options);
  validateAccountEvidence(config, options?.now ?? Date.now());
  return config;
}
