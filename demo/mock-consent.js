import { createMemoryConsentLedger } from '../packages/server/src/memory-consent.js';

// Same in-memory mock grant, with a read port for the dedicated consent page.
// The server verdict disappears on restart, even when the session persists.
export function createMockConsent(storage, now = Date.now) {
  const ledger = createMemoryConsentLedger(undefined, now);
  return { ...ledger, describe(sessionId) {
    if (!sessionId) return { selected: [] };
    const session = storage.get(sessionId), grant = ledger.coverage({ sessionId });
    return { selected: grant.covered && !session.consentWithdrawn && !session.tombstone &&
      grant.consentRevision === session.consentRevision && grant.expiresAt > now() ? ['mock-processing'] : [] };
  } };
}
