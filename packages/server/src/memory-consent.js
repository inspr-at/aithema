import { MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';

// Reference host ledger for the mock purpose. Restart intentionally loses grants
// and fails closed; persistent hosts supply their own authoritative consent port.
export function createMemoryConsentLedger(scope = MOCK_PROCESSING_SCOPE, now = Date.now) {
  const grants = new Map();
  return {
    grant({ sessionId, consentRevision }) {
      grants.set(sessionId, { covered: true, ...structuredClone(scope), consentRevision,
        expiresAt: now() + 365 * 24 * 60 * 60 * 1000 });
    },
    withdraw({ sessionId }) { grants.delete(sessionId); },
    coverage({ sessionId }) { return structuredClone(grants.get(sessionId) ?? { covered: false }); },
  };
}
