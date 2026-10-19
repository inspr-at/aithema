const DELEGATED = 'delegated reasoning: ';
const EVIDENCE_REASONS = new Set([
  'manifest evidence expired', 'binding evidence unverified', 'binding evidence mismatch',
  'binding evidence not yet valid', 'binding evidence expired',
]);

/** Keep precise server verdicts in diagnostics; visitors get their feature's neutral copy. */
export function neutralBindingReason(copy, reason, feature) {
  const inner = typeof reason === 'string' && reason.startsWith(DELEGATED) ? reason.slice(DELEGATED.length) : reason;
  if (!EVIDENCE_REASONS.has(inner)) return undefined;
  if (feature === 'voice') return copy.reasons['voice-host-unavailable'];
  if (feature === 'images' || feature === 'html') return copy.display.draftsUnavailable;
  return copy.chooser.unavailable;
}
