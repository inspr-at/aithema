export const VOICE_SETTING_KEYS = Object.freeze(['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed']);

// https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
// Require all saved values; explicit null preserves the agent's voice default.
export function validateVoiceSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
    Object.keys(raw).length !== VOICE_SETTING_KEYS.length || Object.keys(raw).some(key => !VOICE_SETTING_KEYS.includes(key)) ||
    !['stability', 'similarity_boost'].every(key => Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) ||
    !(raw.style === null || Number.isFinite(raw.style) && raw.style >= 0 && raw.style <= 1) ||
    !(raw.use_speaker_boost === null || typeof raw.use_speaker_boost === 'boolean') ||
    !Number.isFinite(raw.speed) || raw.speed < 0.7 || raw.speed > 1.2) {
    throw new TypeError('Explicit valid ElevenLabs voice settings required');
  }
  return Object.freeze(Object.fromEntries(VOICE_SETTING_KEYS.map(key => [key, raw[key]])));
}
