import { deepFreeze } from '../../../packages/core/src/plugins.js';

// D4: no account selection, legal terms, rates or credentials in this public document.
export const manifest = deepFreeze({
  id: 'elevenlabs', version: '0.0.0', apiVersion: '^1.0.0', kinds: ['live-voice'], placement: 'server',
  entrypoints: { server: './src/server.js', browser: './src/client.js' },
  configSchema: { type: 'object', properties: { agentId: { type: 'string' } }, additionalProperties: false },
  vendor: { name: 'ElevenLabs', url: 'https://elevenlabs.io' },
  models: [{ id: '*', operations: ['start'], streaming: true, structured: false,
    efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['audio', 'text'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: [
      'https://elevenlabs.io/docs/eleven-agents/libraries/java-script',
      'https://elevenlabs.io/docs/eleven-agents/customization/events/client-events',
      'https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm',
      'https://elevenlabs.io/docs/eleven-agents/customization/authentication',
    ],
    cost: { unit: 'minute', inputMicro: null, outputMicro: null, reviewedAt: null } }],
  liveVoice: { reasoning: 'delegated', transcript: { finality: 'turns', persistence: 'durable' },
    capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'emulated',
      pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'native' },
    billing: { visitor: 'Exclude server-acknowledged paused duration from visitor credits.',
      upstream: 'Provider session remains alive while paused; record all provider duration and usage.' } },
});
