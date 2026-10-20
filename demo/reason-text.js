import { BINDING_REASON_CODES } from '../packages/core/src/presets.js';

const DELEGATED = 'delegated reasoning: ';
/** Server verdicts are stable machine reasons; this shows them in the page language. */
export function reasonText(copy, reason, feature) {
  const reasons = copy.reasons ?? {};
  const inner = typeof reason === 'string' && reason.startsWith(DELEGATED) ? reason.slice(DELEGATED.length) : reason;
  if (BINDING_REASON_CODES.includes(inner) || inner === 'binding invalid' ||
    typeof inner === 'string' && /^agent-api(?:$|-(?:get|post|patch)-\d{3}$)/u.test(inner)) return feature === 'voice' ? reasons['voice-host-unavailable']
    : feature === 'images' || feature === 'html' ? copy.display.draftsUnavailable : copy.chooser.unavailable;
  if (typeof reason === 'string' && reason.startsWith(DELEGATED) && reasons.delegated) {
    return reasons.delegated.replace('{reason}', reasonText(copy, reason.slice(DELEGATED.length), feature));
  }
  return Object.hasOwn(reasons, reason) ? reasons[reason] : reason;
}
