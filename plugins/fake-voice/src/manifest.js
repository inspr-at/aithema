import { deepFreeze } from '../../../packages/core/src/plugins.js';

/** A local simulator declares its own contract; it has no upstream protocol. */
export const manifest = deepFreeze({
  id: 'fake-voice', version: '0.0.0', apiVersion: '^1.0.0', kinds: ['live-voice'], placement: 'server',
  entrypoints: { server: './src/server.js', browser: './src/client.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  vendor: { name: 'Local simulated agent', url: 'https://example.test' },
  presentation: { label: 'Test voice', translations: [{ locale: 'de', label: 'Test-Stimme' }, { locale: 'en', label: 'Test voice' }] },
  models: [{ id: 'local-agent', operations: ['start'], streaming: true, structured: false,
    efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['audio', 'text'],
    processingLocations: ['local'], qualification: 'unverified', expiresAt: null, evidence: [],
    cost: { unit: 'minute', inputMicro: 0, outputMicro: 0, reviewedAt: null } }],
  liveVoice: { reasoning: 'delegated', transcript: { finality: 'turns', persistence: 'durable' },
    optionalCapabilities: { speakText: 'emulated' },
    ownership: { stt: 'browser', tts: 'browser', turnTaking: 'browser' },
    capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'emulated',
      pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'native' },
    billing: { visitor: 'Local simulated time; no charge.', upstream: 'No upstream processing or charge.' } },
});

export function fakeMediaGrant(receipt, now = Date.now()) {
  return Object.freeze({ callId: receipt.callId, providerSessionId: receipt.providerSessionId,
    expiresAt: Math.min(now + 60_000, receipt.spendDeadlineAt, receipt.browserLivenessDeadlineAt),
    opaque: { simulated: true, ...structuredClone(receipt) } });
}
