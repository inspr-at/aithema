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
 * provider availability and full-chain regional evidence belong to AIT-331. */
export function validateVoxtralConfiguration(raw = {}) {
  const fail = () => { throw new TypeError('Invalid Voxtral private configuration'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  const allowed = ['endpoint', 'secretRef', 'voiceId', 'sttFormat', 'ttsFormat', 'languages',
    'targetDelayMs', 'sttMicroPerSecond', 'ttsMicroPerCharacter'];
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
  return deepFreeze({ ...value, sttFormat: { ...value.sttFormat }, ttsFormat: { ...value.ttsFormat }, languages: [...value.languages] });
}
