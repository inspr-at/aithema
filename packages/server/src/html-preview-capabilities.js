import { createHash, randomBytes } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');
/** Process-local, bounded, single-use delegations. Only hashes are retained;
 * restarting or redeeming on another instance requires the owner to mint again.
 */
export function createHTMLPreviewCapabilities({ capacity = 1024, ttlMs = 60_000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000 ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) throw new TypeError('Invalid preview capability limits');
  const entries = new Map();
  return Object.freeze({
    ttlMs,
    mint(scope) {
      const time = now();
      for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key);
      if (entries.size >= capacity) entries.delete(entries.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      entries.set(hash(token), { ...scope, expiresAt: time + ttlMs });
      return token;
    },
    redeem(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const key = hash(token), entry = entries.get(key);
      // Consume synchronously, before any asynchronous publication checks.
      entries.delete(key);
      return entry && entry.expiresAt > now() ? entry : null;
    },
    clear() { entries.clear(); },
  });
}
