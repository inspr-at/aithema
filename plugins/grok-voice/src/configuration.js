import { deepFreeze } from '@inspr/aithema-core/plugins';

export const STT_MODEL = 'grok-voice-transcribe-2.0';
export const STT_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
export const TTS_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 });
export const EVIDENCE_DATE = '2026-10-18';
const reference = value => typeof value === 'string' && /^private:[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/u.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function sameFormat(value, expected) {
  return value && Object.keys(value).length === 3 && ['encoding', 'sampleRateHz', 'channels'].every(key => value[key] === expected[key]);
}
/** Pure private-binding validation. Does not dereference evidence or resolve secrets.
 * References are owner evidence, never credentials or proof of current legal admission.
 * Account/consent/ownership admission remains the host's fresh consume responsibility.
 */
export function validateGrokConfiguration(raw = {}, { now = Date.now() } = {}) {
  const fail = () => { throw new TypeError('Invalid Grok Voice private configuration'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isFinite(now)) fail();
  const allowed = ['endpoint', 'model', 'sttFormat', 'ttsFormat', 'languages', 'voice', 'speed', 'endpointingMs',
    'streamingMicroPerHour', 'restMicroPerHour', 'ttsMicroPerMillionCharacters', 'maxInputBytes', 'maxInputChunkBytes',
    'maxTranscriptCharacters', 'maxWireCharacters', 'maxEvents', 'secretRef', 'accountRef', 'accountEvidence'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail();
  const value = { endpoint: 'https://api.x.ai', model: STT_MODEL, sttFormat: STT_FORMAT, ttsFormat: TTS_FORMAT,
    languages: ['de', 'en'], voice: 'eve', speed: 1, endpointingMs: 400,
    streamingMicroPerHour: 200000, restMicroPerHour: 100000, ttsMicroPerMillionCharacters: 15000000,
    maxInputBytes: 1920000, maxInputChunkBytes: 64000, maxTranscriptCharacters: 32768, maxWireCharacters: 256000,
    maxEvents: 1024, ...raw };
  if (value.endpoint !== 'https://api.x.ai' || value.model !== STT_MODEL ||
    !sameFormat(value.sttFormat, STT_FORMAT) || !sameFormat(value.ttsFormat, TTS_FORMAT) ||
    !Array.isArray(value.languages) || !value.languages.length || value.languages.some(language => !['de', 'en'].includes(language)) ||
    new Set(value.languages).size !== value.languages.length || !['ara', 'eve', 'rex'].includes(value.voice) ||
    !Number.isFinite(value.speed) || value.speed < 0.7 || value.speed > 1.5 ||
    !Number.isSafeInteger(value.endpointingMs) || value.endpointingMs < 0 || value.endpointingMs > 5000 ||
    !reference(value.secretRef) || !reference(value.accountRef)) fail();
  for (const [key, minimum] of [['streamingMicroPerHour', 200000], ['restMicroPerHour', 100000], ['ttsMicroPerMillionCharacters', 15000000]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > 1_000_000_000) fail();
  }
  for (const [key, maximum] of [['maxInputBytes', 1920000], ['maxInputChunkBytes', 64000], ['maxTranscriptCharacters', 32768],
    ['maxWireCharacters', 256000], ['maxEvents', 1024]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum) fail();
  }
  if (value.maxInputBytes % 2 || value.maxInputChunkBytes % 2 || value.maxInputChunkBytes > value.maxInputBytes) fail();
  const evidence = value.accountEvidence;
  if (!evidence || evidence.zdrEnabled !== true || evidence.dpaAccepted !== true || evidence.recipient !== 'SpaceXAI LLC' ||
    evidence.recipientCountry !== 'US' || evidence.processing !== 'international-no-guaranteed-region' ||
    !date(evidence.reviewedAt) || !date(evidence.expiresAt) || Date.parse(evidence.reviewedAt) > now ||
    Date.parse(evidence.expiresAt) <= now || Date.parse(evidence.expiresAt) <= Date.parse(evidence.reviewedAt) ||
    ['zdrRef', 'dpaRef', 'retentionRef', 'transferRef', 'approvalRef', 'contractRef'].some(key => !reference(evidence[key]))) fail();
  if (Object.keys(evidence).some(key => !['zdrEnabled', 'dpaAccepted', 'recipient', 'recipientCountry', 'processing',
    'reviewedAt', 'expiresAt', 'zdrRef', 'dpaRef', 'retentionRef', 'transferRef', 'approvalRef', 'contractRef'].includes(key))) fail();
  return deepFreeze({ ...value, sttFormat: { ...value.sttFormat }, ttsFormat: { ...value.ttsFormat },
    languages: [...value.languages], accountEvidence: { ...evidence } });
}
