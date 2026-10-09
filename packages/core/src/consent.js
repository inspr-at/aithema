// The host returns an authoritative grant, never a browser assertion. Each
// binding supplies its actual purpose, recipient chain and item version.
export const MOCK_PROCESSING_SCOPE = Object.freeze({ purpose: 'mock-conversation', recipients: ['mock'],
  upstreamProcessors: [], dataCategories: ['conversation'], itemVersion: 1 });
export function coversProcessingScope(grant, scope, revision, now = Date.now()) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !scope || typeof scope.purpose !== 'string' || !scope.purpose ||
    !(Number.isInteger(scope.itemVersion) && scope.itemVersion > 0 || typeof scope.itemVersion === 'string' && scope.itemVersion.length > 0)) return false;
  return grant?.covered === true && !grant.withdrawn && grant.purpose === scope.purpose && grant.itemVersion === scope.itemVersion &&
    grant.consentRevision === revision && Number.isFinite(grant.expiresAt) && grant.expiresAt > now &&
    (!scope.plugin || Number.isFinite(grant.checkedAt) && grant.checkedAt <= now && now - grant.checkedAt <= 1000 &&
      JSON.stringify(grant.scope) === JSON.stringify(scope)) &&
    ['recipients', 'upstreamProcessors', 'dataCategories'].every(key => Array.isArray(scope[key]) &&
      (key === 'upstreamProcessors' || scope[key].length > 0) &&
      Array.isArray(grant[key]) && scope[key].every(value => typeof value === 'string' && value.length > 0 && grant[key].includes(value)));
}
export function consentReason(grant, scope, now = Date.now(), revision = grant?.consentRevision) {
  return coversProcessingScope(grant, scope, revision, now) ? null : 'current processing consent required';
}
export async function consentCoverage(port, session, scope, options, now) {
  if (session.tombstone || session.consentWithdrawn || !port?.coverage) return false;
  try {
    return coversProcessingScope(await port.coverage({ sessionId: session.id, scope: structuredClone(scope),
      consentRevision: session.consentRevision }, options), scope, session.consentRevision, now ?? Date.now());
  } catch { return false; }
}
