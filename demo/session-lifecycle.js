export function createOwnership({ publicOrigin } = {}) { return {
  token(request) {
    const value = /(?:^|;\s*)aithema-visitor=([a-zA-Z0-9_-]{1,128})(?:;|$)/u.exec(request.headers.get('cookie') ?? '');
    return value?.[1] ?? null;
  },
  created(response, token, request) {
    const secure = new URL(publicOrigin ?? request.url).protocol === 'https:' ? '; Secure' : '';
    response.headers.set('set-cookie', `aithema-visitor=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
  },
}; }
export const ownership = createOwnership();

export function startExpiry(handlers, { now = handlers.now ?? Date.now } = {}) {
  let running = false;
  const expiry = setInterval(async () => {
    if (running) return;
    running = true;
    // One bounded batch per existing minute tick; no overlapping sweeps.
    // Erased sessions (including legacy tombstones) retire on this same tick,
    // independently of the live-session cutoff, once their billing is settled.
    try { await handlers.retire({ before: now() - 365 * 24 * 60 * 60 * 1000, limit: 100 }); }
    catch { console.error({ event: 'session-expiry-failed' }); }
    finally { running = false; }
  }, 60_000);
  expiry.unref();
  return expiry;
}

/** Startup and hourly maintenance use the authoritative database writer.
 * Drain full batches in short turns so idle IP buckets expire within about 25h. */
export function startVisitorRetention(host) {
  let batch, closed = false;
  function retain() {
    batch = undefined;
    if (closed) return;
    try {
      const result = host.retainVisitors({ limit: 100 });
      if (Object.values(result).some(value => value >= 100)) {
        batch = setTimeout(retain, 10); batch.unref();
      }
    } catch { console.error({ event: 'visitor-retention-failed' }); }
  }
  retain();
  const interval = setInterval(() => {
    // A backlog already being drained needs no second chain of batches.
    if (batch === undefined) retain();
  }, 60 * 60_000);
  interval.unref();
  return { close() { closed = true; clearInterval(interval); clearTimeout(batch); } };
}
