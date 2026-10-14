// Shared host reads for the private socket and authenticated HTTP surface.
export const CAP_RECOVERY = 'Investigate provider receipts, reconcile confirmed and unresolved liabilities, and fix the overrun cause. '
  + 'OPS then performs an approved, audited maintenance recovery, preserving historical evidence and carrying confirmed and unresolved liabilities forward. '
  + 'Restarting or raising the deployment cap cannot clear a historical reservation breach; there is no routine reset command.';

export const readAdminSettings = host => host.visitorCredits.settings();
export const readAdminMailCap = host => host.confirmation.mailCap();
export function readProviderCap(spendCap, { details = false } = {}) {
  if (!spendCap) return { available: false, capMicro: null, confirmedMicro: null, reservedMicro: null,
    uncertainMicro: null, remainingMicro: null, breached: null, recovery: CAP_RECOVERY };
  const cap = spendCap.snapshot({ includeBreachReason: details });
  return { ...spendCap.settings(), available: true, capMicro: cap.capMicro, confirmedMicro: cap.spentMicro, reservedMicro: cap.reservedMicro,
    uncertainMicro: cap.uncertainMicro, remainingMicro: details && cap.breached ? 0 : Math.max(0, cap.capMicro - cap.spentMicro - cap.reservedMicro - cap.uncertainMicro),
    breached: cap.breached, recovery: CAP_RECOVERY,
    ...(details ? { breach: cap.breached ? { reason: cap.breachReason } : null } : {}) };
}
