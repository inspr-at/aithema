import { resolveCopy } from './copy-resolve.js';
import { isConsentReason } from '../../core/src/settings.js';

const reasonGroups = {
  paused: ['session paused'], credits: ['budget denied', 'host-limit'],
  providerLimit: ['spend cap reached', 'OpenRouter spend cap exhausted'],
  voiceLimit: ['Voice minute cap reached for this deployment', 'Voice minute cap reached for this UTC day'],
  checking: ['budget reconciling'], off: ['voice off'], verification: ['verification required'],
  setup: ['not configured', 'plugin not registered', 'preset not configured', 'template-agent-required'],
  provider: ['plugin unhealthy'],
  ended: ['closed', 'turn-withdrawn', 'turn-expired', 'server-restart', 'server-stopping'],
  permission: ['call-authorization-lost'], consentWithdrawn: ['consent-withdrawn'],
  consentRevised: ['consent-revised'], sessionRevoked: ['session-revoked'],
  cancelled: ['cancelled', 'start-cancelled'], disconnected: ['transport-lost'],
  connectionExpired: ['browser-liveness-deadline'], notSaved: ['transcript-persistence-failed'],
  transcriptFull: ['transcript-limit'], storageFull: ['concept storage limit'],
  renderLimit: ['UI render limit reached for this session', 'UI render limit reached for this UTC day'],
  erased: ['session-erased'],
};

// One cause/phase classification for failures, stream ends, durable closes and labels.
// An unqualified deadline is not evidence that the per-call maximum elapsed.
export function classifyVoiceEnd({ error, reason, timeLimit, key, phase = 'start', legacyMicrophone = false } = {}) {
  // Only the server's explicit bound refusal on Resume is a time-bound start failure.
  if (!key && error?.code === 'deadline' && error.reason === 'time-limit' &&
    error.source !== 'connect-timer' && phase === 'resume') {
    return classifyVoiceEnd({ reason: 'spend-deadline', timeLimit: error.timeLimit });
  }
  let state = 'failed', timeExpired = false, errorReason = null;
  const neutral = reason === 'one-hour' || reason === 'spend-deadline';
  if (!key && error) {
    const connection = phase === 'start' ? 'voiceConnectFailed' : 'voiceConnectionFailed';
    key = error.status === 429 ? connection
      : error.name === 'NotAllowedError' ? 'voiceMicDenied'
      : error.name === 'NotFoundError' ? 'voiceMicMissing'
      : error.name === 'NotReadableError' ? 'voiceMicBusy'
      : error.name === 'NoMediaAPIError' ? 'voiceMicUnavailable'
      : error.code === 'not-admitted' ? 'voiceAdmissionDenied'
      : error.code === 'voice-conflict' ? 'voiceConflict'
      : error.code === 'deadline' ? connection
      : error.name === 'OverconstrainedError' || error.phase === 'microphone' ||
        error.name === 'AbortError' && !error.phase && legacyMicrophone && typeof error.code !== 'string' ? 'voiceMicFailed'
      : connection;
    errorReason = error.status !== 429 && error.code === 'not-admitted' ? error.reason : null;
  } else if (!key) {
    timeExpired = reason === 'one-hour' || reason === 'spend-deadline' && timeLimit === 'conversation';
    if (timeExpired) key = null;
    else if (reason === 'spend-deadline') {
      key = timeLimit === 'call' ? 'voiceTimeLimit' : null;
      if (!key) state = 'idle';
    }
    else if (reason === 'budget-limit') { key = 'voiceAdmissionDenied'; errorReason = 'budget denied'; }
    else if (reason === 'recovery-failed') key = 'voiceRecoveryFailed';
    else if (['provider-end', 'closure-uncertain'].includes(reason)) { key = 'voiceClosureUncertain'; state = 'idle'; }
    else if (['closed', 'cancelled', 'page-hidden', 'provider-changed', 'turn-withdrawn', 'session-erased', 'consent-revised', 'consent-withdrawn', 'upload-withdrawn', 'server-stopping', 'server-restart'].includes(reason)) { key = null; state = 'idle'; }
    else key = 'voiceConnectionFailed';
  }
  return { key, state, timeExpired, errorReason, neutral,
    retryAnchor: ['voiceConnectFailed', 'voiceConnectionFailed', 'voiceTimeLimit', 'voiceDeadline', 'voiceConflict'].includes(key),
    fallback: key === 'voiceTimeLimit' ? 'voiceDeadline' : key === 'voiceConnectFailed' ? 'voiceConnectionFailed' : key,
  };
}

// Tick v1, AIT-422: receipt ownership outranks a lower-level host refusal.
export function creditVoiceStatus(copy, { reason, creditReason, exhausted = false } = {}) {
  if (!exhausted && !['host-limit', 'session', 'budget denied'].includes(reason)) return null;
  return copy.voiceCreditStatus[creditReason === 'dailyCap' ? 'dailyCap'
    : creditReason === 'session' || reason === 'session' || reason === 'budget denied' ? 'session' : 'hostLimit'];
}

/** All header copy sources get a bounded visual label, including host-defined refusals. */
export function narrowVoiceStatus(copy, sentence, { reason: rawReason, creditReason, messageKey } = {}) {
  if (rawReason === 'agent-api-unavailable' && sentence === copy.reasons[rawReason]) return copy.voiceReasonsNarrow.unavailable;
  if (sentence === copy.voiceStates.usedUp || rawReason && sentence === copy.reasons?.[rawReason]) {
    const credit = creditVoiceStatus(copy, { reason: rawReason, creditReason, exhausted: sentence === copy.voiceStates.usedUp });
    if (credit) return credit;
  }
  if (Object.values(copy.voiceCreditStatus).includes(sentence)) return sentence;
  if (sentence === copy.voiceEndedAithemaMeasured) return copy.voiceEndedAithemaMeasuredNarrow;
  if (sentence === copy.notConfigured) return copy.voiceReasonsNarrow.setup;
  if (sentence === copy.featureConsent.voice) return copy.featureConsent.textNarrow;
  const state = Object.keys(copy.voiceStates).find(key => copy.voiceStates[key] === sentence);
  if (state) return copy.voiceStatesNarrow[state];
  const message = messageKey && (copy[messageKey] === sentence || ['voiceTimeLimit', 'voiceConnectFailed'].includes(messageKey) && sentence === resolveCopy(copy, messageKey, classifyVoiceEnd({ key: messageKey }).fallback))
    ? messageKey : Object.keys(copy.voiceMessagesNarrow).find(key => copy[key] === sentence);
  if (message) {
    const classified = classifyVoiceEnd({ key: message });
    return classified.key ? resolveCopy(copy, `voiceMessagesNarrow.${classified.key}`) ?? sentence : copy.voiceStatesNarrow.failed;
  }
  const reason = Object.keys(copy.reasons).find(key => copy.reasons[key] === sentence);
  if (['recovery-failed', 'start-failed', 'closure-uncertain', 'spend-deadline'].includes(reason)) {
    const classified = classifyVoiceEnd({ reason });
    return classified.key ? resolveCopy(copy, `voiceMessagesNarrow.${classified.key}`) ?? sentence : copy.voiceStatesNarrow.failed;
  }
  const group = isConsentReason(reason) ? 'consent'
    : Object.keys(reasonGroups).find(key => reasonGroups[key].includes(reason)) ?? 'unavailable';
  return copy.voiceReasonsNarrow[group];
}
