// START src/lib/config.ts and request-size.ts. Originals are discarded after
// extraction; the session byte ceiling still counts the admitted source sizes.
export const SERVER_UPLOAD_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxRequestBytes: 64 * 1024 * 1024,
  maxFilesPerRequest: 8, maxDocumentsPerSession: 8, maxSessionBytes: 160 * 1024 * 1024, requestBudgetMs: 25_000,
  maxConcurrentRequestsPerSession: 2, maxConcurrentRequestsPerDeployment: 4 });
export function normalizeUploadLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(SERVER_UPLOAD_LIMITS, k))) throw new TypeError('Invalid upload limits');
  return Object.freeze(Object.fromEntries(Object.entries(SERVER_UPLOAD_LIMITS).map(([key, ceiling]) => {
    const n = value[key] ?? ceiling;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw new TypeError('Invalid upload limit');
    return [key, n];
  })));
}
export function uploadLimitConfig(environment) {
  const names = { maxBytes: 'AITHEMA_UPLOAD_MAX_BYTES', maxRequestBytes: 'AITHEMA_UPLOAD_MAX_REQUEST_BYTES',
    maxDocumentsPerSession: 'AITHEMA_UPLOAD_MAX_FILES', maxSessionBytes: 'AITHEMA_UPLOAD_MAX_SESSION_BYTES',
    maxConcurrentRequestsPerSession: 'AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS_PER_SESSION',
    maxConcurrentRequestsPerDeployment: 'AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS' };
  const configured = {};
  for (const [key, name] of Object.entries(names)) if (environment[name] !== undefined) {
    if (!/^[1-9]\d*$/u.test(environment[name])) throw new TypeError(`Invalid ${name}`);
    configured[key] = Number(environment[name]);
  }
  return normalizeUploadLimits(configured);
}
