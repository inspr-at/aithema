import { FOCUS_REFUSAL_CLASSES } from '../../core/src/question-focus.js';
import { PLUGIN_ERROR_CODES } from '../../core/src/invocation.js';
import { BINDING_REASON_CODES } from '../../core/src/presets.js';

const codes = new Set([...Object.keys(FOCUS_REFUSAL_CLASSES), ...PLUGIN_ERROR_CODES, ...BINDING_REASON_CODES,
  'focus-refused', 'invalid-request', 'not-admitted', 'stale-question', 'stale-revision', 'paused',
  'reasoning-unavailable', 'focused-question-removed', 'identity-changed',
  'session-not-found', 'not-found', 'server-error', 'size-limit', 'idempotency-conflict',
  'unknown preset', 'device browser only', 'preset not configured', 'preset choices invalid',
  'not configured', 'model not offered', 'effort not offered', 'plugin not in preset', 'binding invalid',
  'plugin not registered', 'plugin binding mismatch', 'plugin kind unsupported', 'operation unsupported',
  'effort not supported', 'session paused', 'processing scope invalid', 'processing residency unverified',
  'processing residency denied', 'endpoint not allowed', 'browser only', 'model not supported',
  'document text not covered by reasoning scope', 'invalid mock budget', 'verification required']);
const code = value => value == null ? null : codes.has(value) ? value : 'unclassified';

// Never log Error.message, payloads, question text, tokens or conversation IDs.
// These are observations at the UI boundary, not reconstructed server history.
export function warnFocusRefusal(error, { status = error?.status, accepted = false } = {}, laneFailed = false) {
  try {
    const observedStatus = status ?? error?.status;
    console.warn('Aithema: clarify refusal', {
      status: Number.isInteger(observedStatus) && observedStatus >= 100 && observedStatus <= 599 ? observedStatus : null,
      error: code(error?.error), reason: code(error?.reason), admissionReason: code(error?.admissionReason),
      accepted: Boolean(accepted), acceptedThenLaneFailed: Boolean(accepted && laneFailed),
    });
  } catch { /* Diagnostic hooks cannot interrupt the conversation. */ }
}
