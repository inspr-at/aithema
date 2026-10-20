import { isConsentReason } from '../../core/src/settings.js';

const reasonGroups = {
  paused: ['session paused'], credits: ['budget denied', 'host-limit'],
  providerLimit: ['spend cap reached', 'OpenRouter spend cap exhausted', 'spend-deadline'],
  voiceLimit: ['Voice minute cap reached for this deployment', 'Voice minute cap reached for this UTC day'],
  checking: ['budget reconciling'], off: ['voice off'], verification: ['verification required'],
  setup: ['not configured', 'plugin not registered', 'preset not configured', 'template-agent-required'],
  provider: ['plugin unhealthy', 'agent-api-unavailable'],
  ended: ['closed', 'turn-withdrawn', 'turn-expired', 'server-restart', 'server-stopping'],
  permission: ['call-authorization-lost'], consentWithdrawn: ['consent-withdrawn'],
  consentRevised: ['consent-revised'], sessionRevoked: ['session-revoked'],
  cancelled: ['cancelled', 'start-cancelled'], disconnected: ['transport-lost'],
  connectionExpired: ['browser-liveness-deadline'], notSaved: ['transcript-persistence-failed'],
  transcriptFull: ['transcript-limit'], storageFull: ['concept storage limit'],
  renderLimit: ['UI render limit reached for this session', 'UI render limit reached for this UTC day'],
  erased: ['session-erased'],
};

const reasonMessages = { 'recovery-failed': 'voiceRecoveryFailed', 'start-failed': 'voiceConnectionFailed',
  'closure-uncertain': 'voiceClosureUncertain' };

// Tick v1, AIT-422: receipt ownership outranks a lower-level host refusal.
export function creditVoiceStatus(copy, { reason, creditReason, exhausted = false } = {}) {
  if (!exhausted && !['host-limit', 'session', 'budget denied'].includes(reason)) return null;
  return copy.voiceCreditStatus[creditReason === 'dailyCap' ? 'dailyCap'
    : creditReason === 'session' || reason === 'session' || reason === 'budget denied' ? 'session' : 'hostLimit'];
}

/** All header copy sources get a bounded visual label, including host-defined refusals. */
export function narrowVoiceStatus(copy, sentence, { reason: rawReason, creditReason } = {}) {
  if (sentence === copy.voiceStates.usedUp || sentence === copy.reasons?.[rawReason]) {
    const credit = creditVoiceStatus(copy, { reason: rawReason, creditReason, exhausted: sentence === copy.voiceStates.usedUp });
    if (credit) return credit;
  }
  if (Object.values(copy.voiceCreditStatus).includes(sentence)) return sentence;
  if (sentence === copy.voiceEndedAithemaMeasured) return copy.voiceEndedAithemaMeasuredNarrow;
  if (sentence === copy.notConfigured) return copy.voiceReasonsNarrow.setup;
  if (sentence === copy.featureConsent.voice) return copy.featureConsent.textNarrow;
  const state = Object.keys(copy.voiceStates).find(key => copy.voiceStates[key] === sentence);
  if (state) return copy.voiceStatesNarrow[state];
  const message = Object.keys(copy.voiceMessagesNarrow).find(key => copy[key] === sentence);
  if (message) return copy.voiceMessagesNarrow[message];
  const reason = Object.keys(copy.reasons).find(key => copy.reasons[key] === sentence);
  if (reasonMessages[reason]) return copy.voiceMessagesNarrow[reasonMessages[reason]];
  const group = isConsentReason(reason) ? 'consent'
    : Object.keys(reasonGroups).find(key => reasonGroups[key].includes(reason)) ?? 'unavailable';
  return copy.voiceReasonsNarrow[group];
}
