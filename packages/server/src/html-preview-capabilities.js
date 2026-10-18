import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const hash = token => createHash('sha256').update(token).digest('hex');
/** Process-local, bounded, single-use delegations. Only hashes are retained;
 * restarting or redeeming on another instance requires the owner to mint again.
 */
export function createHTMLPreviewCapabilities({ capacity = 1024, perSessionCapacity = Math.min(8, capacity),
  ttlMs = 60_000, now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000 ||
    !Number.isSafeInteger(perSessionCapacity) || perSessionCapacity < 1 || perSessionCapacity > capacity ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) throw new TypeError('Invalid preview capability limits');
  const entries = new Map();
  let lastTime = -Infinity;
  const timeNow = () => {
    const time = now();
    // Production uses a monotonic clock. A regressed injected clock must not
    // prolong any outstanding delegation either.
    if (time < lastTime) entries.clear();
    lastTime = time;
    return time;
  };
  return Object.freeze({
    ttlMs,
    mint(scope) {
      const time = timeNow();
      for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key);
      const sessionKeys = [];
      for (const [key, entry] of entries) if (entry.sessionId === scope.sessionId) sessionKeys.push(key);
      if (sessionKeys.length >= perSessionCapacity) entries.delete(sessionKeys[0]);
      // Saturation must never invalidate another session's live delegation.
      if (entries.size >= capacity) return null;
      const token = randomBytes(32).toString('base64url');
      entries.set(hash(token), { ...scope, expiresAt: time + ttlMs });
      return token;
    },
    redeem(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const time = timeNow();
      const key = hash(token), entry = entries.get(key);
      // Consume synchronously, before any asynchronous publication checks.
      entries.delete(key);
      return entry && entry.expiresAt > time ? entry : null;
    },
    clear() { entries.clear(); },
  });
}
