import { isConsentReason } from '../packages/core/src/settings.js';

// Every source used by AudioRail.render(), including translated admission refusals.
export const voiceMessageKeys = ['voiceMicDenied', 'voiceMicMissing', 'voiceAdmissionDenied', 'voiceConflict', 'voiceDeadline',
  'voiceConnectionFailed', 'voiceRecoveryFailed', 'voiceMoved', 'voiceClosureUncertain', 'voiceEnded', 'voicePauseFailed', 'voicePlaybackBlocked'];
export function voiceStatusCases(copy) {
  return [
    { id: 'consent', full: copy.featureConsent.voice, kind: 'consent' },
    ...Object.entries(copy.voiceStates).map(([id, full]) => ({ id, full, kind: 'state' })),
    ...voiceMessageKeys.map(id => ({ id, full: copy[id], kind: 'error' })),
    { id: 'notConfigured', full: copy.notConfigured, kind: 'unavailable' },
    { id: 'unknown-host-reason', full: 'A host-defined availability explanation', kind: 'unavailable' },
    ...Object.entries(copy.reasons).map(([reason, full], index) => ({ id: `reason-${index}`, reason, full: isConsentReason(reason) ? copy.featureConsent.voice : full, kind: isConsentReason(reason) ? 'consent' : 'reason' })),
  ];
}
