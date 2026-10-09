// The host returns an authoritative grant, never a browser assertion. Each
// binding supplies its actual purpose, recipient chain and item version.
export const MOCK_PROCESSING_SCOPE = Object.freeze({ purpose: 'mock-conversation', recipients: ['mock'],
  upstreamProcessors: [], dataCategories: ['conversation'], itemVersion: 1 });
export function coversProcessingScope(grant, scope, revision, now = Date.now()) {
  if (!scope || typeof scope.purpose !== 'string' || !Number.isInteger(scope.itemVersion)) return false;
  return grant?.covered === true && grant.purpose === scope.purpose && grant.itemVersion === scope.itemVersion &&
    grant.consentRevision === revision && Number.isFinite(grant.expiresAt) && grant.expiresAt > now &&
    ['recipients', 'upstreamProcessors', 'dataCategories'].every(key => Array.isArray(scope[key]) &&
      Array.isArray(grant[key]) && scope[key].every(value => grant[key].includes(value)));
}
export async function consentCoverage(port, session, scope) {
  if (session.tombstone || session.consentWithdrawn || !port?.coverage) return false;
  try {
    return coversProcessingScope(await port.coverage({ sessionId: session.id, scope: structuredClone(scope),
      consentRevision: session.consentRevision }), scope, session.consentRevision);
  } catch { return false; }
}
