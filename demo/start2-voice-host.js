import { createElevenLabsVoiceHost } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { qualifyStartBinding } from './processing-consent.js';
import { voiceCostConfig } from './voice-cost-config.js';

export const START2_VOICE_OPENERS = Object.freeze({
  de: 'Hallo, hier ist die KI-Assistenz von Augmentoring. Wie kann ich Ihnen helfen?',
  en: "Hello, this is Augmentoring's AI assistant. How can I help you?",
});

export function createVoiceHost(options = {}) {
  return createElevenLabsVoiceHost({ agentName: 'aithema-start2', facadeSecretName: 'aithema-start2-facade',
    accountRef: 'start2-elevenlabs', spokenOpeners: START2_VOICE_OPENERS, costConfig: voiceCostConfig,
    qualifyBinding: qualifyStartBinding, ...options });
}
