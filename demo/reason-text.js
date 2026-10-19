const DELEGATED = 'delegated reasoning: ';
/** Server verdicts are stable machine reasons; this shows them in the page language. */
export function reasonText(copy, reason) {
  const reasons = copy.reasons ?? {};
  if (reason === 'binding evidence unverified' || reason === `${DELEGATED}binding evidence unverified`) return reasons['voice-host-unavailable'];
  if (typeof reason === 'string' && reason.startsWith(DELEGATED) && reasons.delegated) {
    return reasons.delegated.replace('{reason}', reasonText(copy, reason.slice(DELEGATED.length)));
  }
  // ensure-agent emits a bounded HTTP verb plus the provider's status.
  const agentAPI = typeof reason === 'string' && /^agent-api-(?:get|post|patch)-(\d{3})$/u.exec(reason);
  if (agentAPI && reasons['agent-api']) return reasons['agent-api'].replace('{status}', agentAPI[1]);
  return Object.hasOwn(reasons, reason) ? reasons[reason] : reason;
}
