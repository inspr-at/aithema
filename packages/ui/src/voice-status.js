import { isConsentReason } from '../../core/src/settings.js';

const reasonGroups = {
  paused: ['session paused'], credits: ['budget denied', 'host-limit', 'spend cap reached', 'OpenRouter spend cap exhausted',
    'Voice minute cap reached for this deployment', 'Voice minute cap reached for this UTC day'],
  checking: ['budget reconciling'], off: ['voice off'], verification: ['verification required'],
  setup: ['not configured', 'plugin not registered', 'preset not configured', 'template-agent-required'],
  provider: ['plugin unhealthy', 'agent-api-unavailable'],
  ended: ['closed', 'turn-withdrawn', 'turn-expired', 'server-restart', 'server-stopping', 'session-erased'],
  permission: ['call-authorization-lost', 'session-revoked', 'consent-withdrawn', 'consent-revised'],
};

/** All header copy sources get a bounded visual label, including host-defined refusals. */
export function narrowVoiceStatus(copy, sentence) {
  if (sentence === copy.notConfigured) return copy.voiceReasonsNarrow.setup;
  if (sentence === copy.featureConsent.voice) return copy.featureConsent.textNarrow;
  const state = Object.keys(copy.voiceStates).find(key => copy.voiceStates[key] === sentence);
  if (state) return copy.voiceStatesNarrow[state];
  const message = Object.keys(copy.voiceMessagesNarrow).find(key => copy[key] === sentence);
  if (message) return copy.voiceMessagesNarrow[message];
  const reason = Object.keys(copy.reasons).find(key => copy.reasons[key] === sentence);
  const group = isConsentReason(reason) ? 'consent'
    : Object.keys(reasonGroups).find(key => reasonGroups[key].includes(reason)) ?? 'unavailable';
  return copy.voiceReasonsNarrow[group];
}
