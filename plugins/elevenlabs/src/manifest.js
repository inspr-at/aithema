import { deepFreeze } from '../../../packages/core/src/plugins.js';

// D4: no account selection, legal terms, rates or credentials in this public document.
export const manifest = deepFreeze({
  id: 'elevenlabs', version: '0.0.0', apiVersion: '^1.0.0', kinds: ['live-voice'], placement: 'server',
  entrypoints: { server: './src/server.js', browser: './src/client.js' },
  configSchema: { type: 'object', properties: { agentId: { type: 'string' } }, additionalProperties: false },
  vendor: { name: 'ElevenLabs', url: 'https://elevenlabs.io' },
  presentation: { label: 'ElevenLabs', translations: [
    { locale: 'de', label: 'ElevenLabs', consentItem: { id: 'voice-elevenlabs', version: 1,
      title: 'Sprache mit ElevenLabs',
      recipients: 'ElevenLabs, Inc., USA.',
      text: 'Ihre Spracheingabe, die Live-Transkription und die gesprochenen Antworten verarbeitet ElevenLabs. Die Antworten selbst entstehen über den Punkt KI-Modelle international.',
    } },
    { locale: 'en', label: 'ElevenLabs', consentItem: { id: 'voice-elevenlabs', version: 1,
      title: 'Voice with ElevenLabs',
      recipients: 'ElevenLabs, Inc., United States.',
      text: 'Your speech input, the live transcription and the spoken answers are processed by ElevenLabs. The answers themselves are generated under the item AI models, international.',
    } },
  ] },
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
    ownership: { stt: 'provider', tts: 'provider', turnTaking: 'provider' },
    capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'emulated',
      pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'native' },
    billing: { visitor: 'Exclude server-acknowledged paused duration from visitor credits.',
      upstream: 'Provider session remains alive while paused; record all provider duration and usage.' } },
});
