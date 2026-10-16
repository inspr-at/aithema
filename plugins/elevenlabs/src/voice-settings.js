export const VOICE_SETTING_KEYS = Object.freeze(['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']);

// https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
// Require explicit values so a qualification cannot inherit provider defaults.
export function validateVoiceSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
    Object.keys(raw).length !== VOICE_SETTING_KEYS.length || Object.keys(raw).some(key => !VOICE_SETTING_KEYS.includes(key)) ||
    !['stability', 'similarity_boost', 'style'].every(key => Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) ||
    typeof raw.use_speaker_boost !== 'boolean' || !Number.isFinite(raw.speed) || raw.speed < 0.7 || raw.speed > 1.2) {
    throw new TypeError('Explicit valid ElevenLabs voice settings required');
  }
  return Object.freeze(Object.fromEntries(VOICE_SETTING_KEYS.map(key => [key, raw[key]])));
}
