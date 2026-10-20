import { BINDING_REASON_CODES } from '../../core/src/presets.js';

const DELEGATED = 'delegated reasoning: ';

/** Keep precise server verdicts in diagnostics; visitors get their feature's neutral copy. */
export function neutralBindingReason(copy, reason, feature) {
  const inner = typeof reason === 'string' && reason.startsWith(DELEGATED) ? reason.slice(DELEGATED.length) : reason;
  if (!BINDING_REASON_CODES.includes(inner) && inner !== 'binding invalid' &&
    !(typeof inner === 'string' && /^agent-api(?:$|-(?:get|post|patch)-\d{3}$)/u.test(inner))) return undefined;
  if (feature === 'voice') return copy.reasons['voice-host-unavailable'];
  if (feature === 'images' || feature === 'html') return copy.display.draftsUnavailable;
  return copy.chooser.unavailable;
}
