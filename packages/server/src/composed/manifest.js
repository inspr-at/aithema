import { deepFreeze } from '@inspr/aithema-core/plugins';
export const manifest = deepFreeze({ id: 'composed-voice', version: '0.0.0', apiVersion: '^1.0.0', kinds: ['live-voice'],
  placement: 'server', entrypoints: { server: './src/server.js', browser: './src/client.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
  vendor: { name: 'Host-composed voice', url: 'https://github.com/inspr-at/aithema' },
  presentation: { label: 'Composed voice (unqualified)' },
  models: [{ id: 'composed', operations: ['start'], streaming: true, structured: false, efforts: ['none'],
    languages: ['de', 'en'], germanQuality: 'unverified', formats: ['audio'], processingLocations: ['unverified'],
    qualification: 'unverified', expiresAt: null, evidence: [], cost: { unit: 'minute', inputMicro: 0, outputMicro: 0, reviewedAt: null } }],
  liveVoice: { reasoning: 'delegated', transcript: { finality: 'turns', persistence: 'durable' },
    ownership: { stt: 'server', tts: 'server', turnTaking: 'server' }, optionalCapabilities: { forceInterrupt: 'native', metering: 'emulated' },
    capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'native',
      pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'unavailable' },
    billing: { visitor: 'Active call duration measured by Aithema, excluding server-acknowledged pauses.', upstream: 'STT, reasoning and TTS settle once each; no aggregate charge.' } } });
