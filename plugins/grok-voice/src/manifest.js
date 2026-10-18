import { deepFreeze } from '../../../packages/core/src/plugins.js';
import { STT_MODEL, EVIDENCE_DATE } from './configuration.js';

// Component metadata only. The supported package/exports and TTS arrive in AIT-317 package 2.
export const manifest = deepFreeze({ id: 'grok-voice', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['stt'], placement: 'server', entrypoints: { server: './src/stt.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
  vendor: { name: 'xAI', url: 'https://x.ai' },
  presentation: { label: 'Grok Voice (xAI): not yet qualified in live use' },
  models: [{ id: STT_MODEL, operations: ['transcribe', 'stream'], streaming: true, structured: false,
    efforts: ['none'], languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_s16le'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://docs.x.ai/developers/model-capabilities/audio/speech-to-text'],
    cost: { unit: 'second', inputMicro: null, outputMicro: 0, reviewedAt: EVIDENCE_DATE } }],
});
