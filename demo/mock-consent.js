import { createMemoryConsentLedger } from '@inspr/aithema-server';

// Same in-memory mock grant, with a read port for the dedicated consent page.
// The server verdict disappears on restart, even when the session persists.
export function createMockConsent(storage, now = () => storage.now()) {
  const ledger = createMemoryConsentLedger(undefined, now);
  return { ...ledger, describe(sessionId, { consentRevision, granted: acceptingGrant = false } = {}) {
    if (!sessionId) return { selected: [] };
    const session = storage.get(sessionId), grant = ledger.coverage({ sessionId });
    return { mock: true, selected: grant.covered && (!session.consentWithdrawn || acceptingGrant) && !session.tombstone &&
      grant.consentRevision === (consentRevision ?? session.consentRevision) && grant.expiresAt > now() ? ['mock-processing'] : [] };
  } };
}
