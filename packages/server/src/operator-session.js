import { createHash, randomBytes } from 'node:crypto';
import { assertOperatorSessionPort } from '@inspr/aithema-core';

export const OPERATOR_COOKIE = 'aithema-operator';
export const OPERATOR_STATE_COOKIE = 'aithema-operator-state';
const STATE_MS = 600_000, GRANT_MS = 8 * 60 * 60_000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
const digest = id => createHash('sha256').update(id).digest('hex');
const random = () => randomBytes(32).toString('base64url');
function cookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  const id = matches.length === 1 ? matches[0].slice(name.length + 1) : null;
  return identifier(id) ? id : null;
}
const cookieHeader = (name, id, maxAge) => `${name}=${id}; Path=${name === OPERATOR_STATE_COOKIE ? '/api/operator' : '/'}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = location => new Response(null, { status: 303, headers: { location,
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const refused = (status, allow) => new Response(null, { status, headers: { 'cache-control': 'no-store', ...(allow ? { allow } : {}) } });

/** Pending proofs and opaque grants stay in the host database, outside sessions,
 * replay and export. Atomic DELETE RETURNING consumes state before network I/O.
 * Only hashes of random browser handles are stored; no provider tokens persist.
 */
export function createSQLiteOperatorStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_pending (
    id_hash TEXT PRIMARY KEY, namespace TEXT NOT NULL, pending TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_grants (
    id_hash TEXT PRIMARY KEY, namespace TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS operator_pending_expiry ON operator_pending(expires_at);
    CREATE INDEX IF NOT EXISTS operator_grant_expiry ON operator_grants(expires_at);`);
  return {
    sweep(now) {
      db.prepare('DELETE FROM operator_pending WHERE expires_at<=?').run(now);
      db.prepare('DELETE FROM operator_grants WHERE expires_at<=?').run(now);
    },
    putPending(id, namespace, pending, expiresAt) {
      if (db.prepare('SELECT COUNT(*) AS count FROM operator_pending').get().count >= 1000) throw new Error('operator-pending-limit');
      db.prepare('INSERT INTO operator_pending VALUES (?,?,?,?)').run(digest(id), namespace, JSON.stringify(pending), expiresAt);
    },
    takePending(id, namespace, now) {
      if (!identifier(id)) return null;
      const row = db.prepare('DELETE FROM operator_pending WHERE id_hash=? RETURNING *').get(digest(id));
      return row && row.namespace === namespace && row.expires_at > now ? JSON.parse(row.pending) : null;
    },
    grant(id, namespace, now) {
      if (!identifier(id)) return null;
      const row = db.prepare('SELECT * FROM operator_grants WHERE id_hash=? AND namespace=? AND expires_at>?').get(digest(id), namespace, now);
      return row ? { subject: row.subject, name: row.name } : null;
    },
    issue(id, namespace, identity, expiresAt) {
      db.prepare('INSERT INTO operator_grants VALUES (?,?,?,?,?)').run(digest(id), namespace, identity.subject, identity.name, expiresAt);
    },
    revoke(id) { if (identifier(id)) db.prepare('DELETE FROM operator_grants WHERE id_hash=?').run(digest(id)); },
  };
}

export function createOperatorSessions({ provider, store, publicOrigin, now = Date.now } = {}) {
  if (!provider) return null;
  if (typeof provider.begin !== 'function' || typeof provider.complete !== 'function' || typeof provider.allows !== 'function' ||
      !provider.sessionNamespace || typeof provider.label !== 'string' || !store) throw new TypeError('Invalid operator provider');
  const u = new URL(publicOrigin);
  if (u.origin !== publicOrigin || u.username || u.password || u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new TypeError('Invalid operator public origin');
  const namespace = provider.sessionNamespace;
  const live = request => {
    const grant = store.grant(cookie(request, OPERATOR_COOKIE), namespace, now());
    return grant && provider.allows(grant.subject) ? { name: grant.name } : null;
  };
  return assertOperatorSessionPort({
    entry: () => ({ provider: provider.label, url: '/api/operator/login/', logoutUrl: '/api/operator/logout/' }),
    session: live,
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (!/^\/api\/operator\/(login|callback|logout)\/?$/u.test(path)) return null;
      const action = path.split('/')[3], method = action === 'logout' ? 'POST' : 'GET';
      if (request.method !== method) return refused(405, method);
      if (action === 'logout') {
        if (request.headers.get('origin') !== publicOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return refused(403);
        store.revoke(cookie(request, OPERATOR_COOKIE));
        store.takePending(cookie(request, OPERATOR_STATE_COOKIE), namespace, now());
        const response = redirect('/#settings-general');
        response.headers.append('set-cookie', cookieHeader(OPERATOR_COOKIE, '', 0));
        response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, '', 0));
        return response;
      }
      store.sweep(now());
      if (action === 'login') {
        try {
          store.takePending(cookie(request, OPERATOR_STATE_COOKIE), namespace, now());
          const { pending, url } = provider.begin(), id = random();
          store.putPending(id, namespace, pending, now() + STATE_MS);
          const response = redirect(url);
          response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, id, STATE_MS / 1000));
          return response;
        } catch { return redirect('/?operator=denied#settings-general'); }
      }
      const pending = store.takePending(cookie(request, OPERATOR_STATE_COOKIE), namespace, now());
      const params = new URL(request.url).searchParams, code = params.get('code');
      const fail = () => {
        const response = redirect('/?operator=denied#settings-general');
        response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, '', 0));
        return response;
      };
      if (!pending || params.getAll('state').length !== 1 || params.get('state') !== pending.state ||
          params.getAll('code').length !== 1 || !code || code.length > 8000 || params.has('error')) return fail();
      try {
        const identity = await provider.complete(code, pending, request.signal);
        if (!identity || !provider.allows(identity.subject) || typeof identity.name !== 'string' || request.signal.aborted) return fail();
        const id = random(); store.issue(id, namespace, identity, now() + GRANT_MS);
        store.revoke(cookie(request, OPERATOR_COOKIE));
        const response = redirect('/#settings-general');
        response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, '', 0));
        response.headers.append('set-cookie', cookieHeader(OPERATOR_COOKIE, id, GRANT_MS / 1000));
        return response;
      } catch { return fail(); }
    },
  });
}
