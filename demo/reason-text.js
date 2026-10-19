const DELEGATED = 'delegated reasoning: ';
// This native-browser host module has no package-source import exception.
// The DE/EN feature × reason matrix keeps this bounded seam aligned with UI copy.
const EVIDENCE_REASONS = new Set([
  'manifest evidence expired', 'binding evidence unverified', 'binding evidence mismatch',
  'binding evidence not yet valid', 'binding evidence expired',
]);
/** Server verdicts are stable machine reasons; this shows them in the page language. */
export function reasonText(copy, reason, feature) {
  const reasons = copy.reasons ?? {};
  const inner = typeof reason === 'string' && reason.startsWith(DELEGATED) ? reason.slice(DELEGATED.length) : reason;
  if (EVIDENCE_REASONS.has(inner)) return feature === 'voice' ? reasons['voice-host-unavailable']
    : feature === 'images' || feature === 'html' ? copy.display.draftsUnavailable : copy.chooser.unavailable;
  if (typeof reason === 'string' && reason.startsWith(DELEGATED) && reasons.delegated) {
    return reasons.delegated.replace('{reason}', reasonText(copy, reason.slice(DELEGATED.length), feature));
  }
  // ensure-agent emits a bounded HTTP verb plus the provider's status.
  const agentAPI = typeof reason === 'string' && /^agent-api-(?:get|post|patch)-(\d{3})$/u.exec(reason);
  if (agentAPI && reasons['agent-api']) return reasons['agent-api'].replace('{status}', agentAPI[1]);
  return Object.hasOwn(reasons, reason) ? reasons[reason] : reason;
}
