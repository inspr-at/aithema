// Recovery data only. Retrying a command still needs ordinary admission and
// consent; an unknown refusal never implies that another attempt is safe.
export const FOCUS_REFUSAL_CLASSES = Object.freeze({
  'admission deadline': 'retryable', 'budget reconciling': 'wait',
  'plugin unhealthy': 'retryable', 'consent port unavailable': 'retryable', 'reply-in-flight': 'wait',
  network: 'retryable', paused: 'actionable',
  'budget denied': 'terminal', session: 'terminal', 'one-hour': 'terminal', 'host-limit': 'terminal',
  'consent-required': 'actionable', 'current processing consent required': 'actionable', 'invalid-request': 'terminal',
});
export function classifyFocusRefusal(error) {
  for (const reason of [error?.reason, error?.admissionReason, error?.error]) {
    if (Object.hasOwn(FOCUS_REFUSAL_CLASSES, reason)) return FOCUS_REFUSAL_CLASSES[reason];
  }
  if (error?.name === 'TypeError' || Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599) return 'retryable';
  return 'terminal';
}

