import { createElevenLabsVoiceHost } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { qualifyStartBinding } from './processing-consent.js';
import { voiceCostConfig } from './voice-cost-config.js';

export const START2_VOICE_OPENERS = Object.freeze({
  de: 'Hallo, hier ist die KI-Assistenz von Augmentoring. Wie kann ich Ihnen helfen?',
  en: "Hello, this is Augmentoring's AI assistant. How can I help you?",
});
export const START2_VOICE_CONTINUATIONS = Object.freeze({
  de: 'Schön, dass Sie wieder da sind – Ihre KI-Assistenz ist bereit, das Gespräch fortzusetzen.',
  en: "Welcome back – your AI assistant is ready to pick up where we left off.",
});

export function createVoiceHost(options = {}) {
  return createElevenLabsVoiceHost({ agentName: 'aithema-start2', facadeSecretName: 'aithema-start2-facade',
    accountRef: 'start2-elevenlabs', spokenOpeners: START2_VOICE_OPENERS,
    spokenContinuations: START2_VOICE_CONTINUATIONS, costConfig: voiceCostConfig,
    qualifyBinding: qualifyStartBinding,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== null && value !== undefined)) });
}
