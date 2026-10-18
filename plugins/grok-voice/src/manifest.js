import { deepFreeze } from '@inspr/aithema-core/plugins';
import { STT_MODEL, EVIDENCE_DATE } from './configuration.js';

// Public component metadata; private configuration remains in the host binding.
export const manifest = deepFreeze({ id: 'grok-voice', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['stt', 'tts'], placement: 'server', entrypoints: { server: './src/server.js', browser: './src/client.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  vendor: { name: 'xAI', url: 'https://x.ai' },
  presentation: { label: 'Grok Voice (xAI): not yet qualified in live use' },
  models: [{ id: STT_MODEL, operations: ['transcribe', 'stream'], streaming: true, structured: false,
    efforts: ['none'], languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_s16le'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://docs.x.ai/developers/model-capabilities/audio/speech-to-text'],
    cost: { unit: 'second', inputMicro: null, outputMicro: 0, reviewedAt: EVIDENCE_DATE } },
    { id: 'grok-voice-tts', operations: ['speak'], streaming: true, structured: false, efforts: ['none'],
      languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_s16le'], processingLocations: ['unverified'],
      qualification: 'unverified', expiresAt: null, evidence: ['https://docs.x.ai/developers/model-capabilities/audio/text-to-speech'],
      cost: { unit: 'character', inputMicro: null, outputMicro: null, reviewedAt: EVIDENCE_DATE } }],
});
