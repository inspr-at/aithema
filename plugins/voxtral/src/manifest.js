import { deepFreeze } from '@inspr/aithema-core/plugins';
import { STT_MODEL, TTS_MODEL, EVIDENCE_DATE } from './configuration.js';

// Preserve the existing speech component identity independently of the pipeline.
export const componentManifest = deepFreeze({ id: 'voxtral', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['stt', 'tts'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
  vendor: { name: 'Mistral', url: 'https://mistral.ai' },
  presentation: { label: 'Voxtral (Mistral): not yet qualified in live use' },
  models: [
    { id: STT_MODEL, operations: ['transcribe', 'stream'], streaming: true, structured: false, efforts: ['none'],
      languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_s16le'], processingLocations: ['unverified'],
      qualification: 'unverified', evidence: [], expiresAt: null, cost: { unit: 'minute', inputMicro: 6000, outputMicro: 0, reviewedAt: EVIDENCE_DATE } },
    { id: TTS_MODEL, operations: ['speak'], streaming: true, structured: false, efforts: ['none'],
      languages: ['de', 'en'], germanQuality: 'unverified', formats: ['pcm_f32le'], processingLocations: ['unverified'],
      qualification: 'unverified', evidence: [], expiresAt: null, cost: { unit: 'character', inputMicro: 16, outputMicro: 0, reviewedAt: EVIDENCE_DATE } },
  ] });

// Pipeline metadata only. Account admission and supported assembly follow in
// AIT-331/AIT-330; this manifest does not establish regional eligibility.
export const manifest = deepFreeze({ id: 'voxtral-voice', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['live-voice'], placement: 'server', entrypoints: { server: './src/server.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  vendor: componentManifest.vendor, presentation: componentManifest.presentation,
  liveVoice: { reasoning: 'delegated', transcript: { finality: 'turns', persistence: 'durable' },
    ownership: { stt: 'server', tts: 'server', turnTaking: 'server' },
    capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'native',
      pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'unavailable' },
    billing: { visitor: 'Components require separate admission; money is estimated.',
      upstream: 'STT, reasoning and TTS require separate child claims; no aggregate upstream charge.' } },
  models: [{ id: 'voxtral-voice', operations: ['start'], streaming: true, structured: false, efforts: ['none'],
    languages: ['de', 'en'], germanQuality: 'unverified', formats: ['audio'], processingLocations: ['unverified'],
    qualification: 'unverified', evidence: [], expiresAt: null,
    cost: { unit: 'minute', inputMicro: 0, outputMicro: 0, reviewedAt: EVIDENCE_DATE } }],
});
