import { isConsentReason } from '../packages/core/src/settings.js';

// Compact header variants retain the AIT-302 two-line visual contract.
const compactVoiceMessageKeys = ['voiceMicDenied', 'voiceMicMissing', 'voiceAdmissionDenied', 'voiceConflict', 'voiceDeadline',
  'voiceConnectionFailed', 'voiceRecoveryFailed', 'voiceMoved', 'voiceClosureUncertain', 'voiceEnded', 'voicePauseFailed', 'voicePlaybackBlocked'];
// Expanded S4/S5 callouts have their own full-copy viewport matrix in AIT-377.
export const voiceMessageKeys = [...compactVoiceMessageKeys, 'voiceMicBusy', 'voiceMicUnavailable', 'voiceMicFailed', 'voiceNoReply'];
export function voiceStatusCases(copy) {
  return [
    ...creditStatusCases(copy),
    { id: 'consent', full: copy.featureConsent.voice, kind: 'consent' },
    ...Object.entries(copy.voiceStates).map(([id, full]) => id === 'usedUp'
      ? creditStatusCases(copy).find(sample => sample.id === id) : { id, full, kind: 'state' }),
    ...compactVoiceMessageKeys.map(id => ({ id, full: copy[id], kind: 'error' })),
    { id: 'notConfigured', full: copy.notConfigured, kind: 'unavailable' },
    { id: 'unknown-host-reason', full: 'A host-defined availability explanation', kind: 'unavailable' },
    ...Object.entries(copy.reasons).map(([reason, full], index) => reason === 'budget denied'
      ? { ...creditStatusCases(copy).find(sample => sample.reason === reason), id: `reason-${index}` }
      : { id: `reason-${index}`, reason, full: isConsentReason(reason) ? copy.featureConsent.voice : full, kind: isConsentReason(reason) ? 'consent' : 'reason' }),
  ];
}

// Tick’s binding AIT-302 round-3 table approval (2026-10-18), DE / EN.
const approvedNarrowForms = {
  'closing': ['Wird beendet …', 'Ending …'],
  'creditEnding': ['Wird beendet …', 'Ending …'],
  'consent-withdrawn': ['Freigabe widerrufen', 'Consent withdrawn'],
  'consent-revised': ['Freigabe geändert', 'Consent changed'],
  'session-revoked': ['Freigabe widerrufen', 'Permission withdrawn'],
  'call-authorization-lost': ['Freigabe abgelaufen', 'Permission expired'],
  'spend cap reached': ['Anbieterlimit erreicht', 'Provider limit reached'],
  'OpenRouter spend cap exhausted': ['Anbieterlimit erreicht', 'Provider limit reached'],
  'spend-deadline': ['Anbieterlimit erreicht', 'Provider limit reached'],
  'Voice minute cap reached for this deployment': ['Sprachlimit erreicht', 'Voice limit reached'],
  'Voice minute cap reached for this UTC day': ['Sprachlimit erreicht', 'Voice limit reached'],
  'usedUp': ['Credits aufgebraucht', 'Credits used up'],
  'budget denied': ['Credits aufgebraucht', 'Credits used up'],
  'cancelled': ['Abgebrochen', 'Cancelled'],
  'start-cancelled': ['Abgebrochen', 'Cancelled'],
  'transport-lost': ['Verbindung getrennt', 'Connection lost'],
  'browser-liveness-deadline': ['Verbindung abgelaufen', 'Connection expired'],
  'recovery-failed': ['Verbindung gestört', 'Reconnect failed'],
  'start-failed': ['Verbindung gestört', 'Connection failed'],
  'closure-uncertain': ['Kostenabgleich …', 'Reconciling costs …'],
  'transcript-persistence-failed': ['Nicht gespeichert', 'Not saved'],
  'transcript-limit': ['Transkript voll', 'Transcript full'],
  'concept storage limit': ['Speicher voll', 'Storage full'],
  'UI render limit reached for this session': ['Limit erreicht', 'Limit reached'],
  'UI render limit reached for this UTC day': ['Limit erreicht', 'Limit reached'],
  'session-erased': ['Gespräch gelöscht', 'Conversation deleted'],
};
export function approvedNarrowForm(copy, sample) {
  if (sample.creditCase) return sample.short;
  return approvedNarrowForms[sample.reason ?? sample.id]?.[copy.display.locale === 'de' ? 0 : 1];
}

// Tick's binding AIT-422 table supersedes AIT-310's upgrade-dependent labels.
export function creditStatusCases(copy) {
  const credits = copy.display.locale === 'de' ? 'Credits aufgebraucht' : 'Credits used up';
  const unavailable = copy.display.locale === 'de' ? 'Sprache gerade nicht verfügbar' : 'Voice unavailable right now';
  return [
    { id: 'host-limit-with-upgrade', endReason: 'host-limit', nextTier: 'emailGiven', exhausted: true, short: unavailable },
    { id: 'host-limit-without-upgrade', endReason: 'host-limit', nextTier: null, exhausted: true, short: unavailable },
    { id: 'usedUp', exhausted: true, short: unavailable },
    { id: 'budget-denied', reason: 'budget denied', short: credits },
  ].map(sample => ({ ...sample, creditCase: true, kind: 'credit', full: sample.short }));
}

export function applyCreditStatusCase(rail, sample) {
  rail.session = null; rail.state = 'idle'; rail.errorKey = null; rail.errorReason = null;
  rail.usedUp = () => Boolean(sample.exhausted);
  rail.endReason = () => sample.endReason ?? null;
  rail.nextTier = () => sample.nextTier ?? null;
  rail.feature = () => sample.reason ? { available: false, rawReason: sample.reason, reason: sample.full } : { available: true };
}
