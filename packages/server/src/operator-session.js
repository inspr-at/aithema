import { createHash, randomBytes } from 'node:crypto';
import { assertOperatorSessionPort } from '@inspr/aithema-core';
import { createOperatorStateSeal, OPERATOR_STATE_MS } from './operator-state.js';

export const OPERATOR_COOKIE = 'aithema-operator';
export const OPERATOR_STATE_COOKIE = 'aithema-operator-state';
const GRANT_MS = 8 * 60 * 60_000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
const digest = id => createHash('sha256').update(id).digest('hex');
const random = () => randomBytes(32).toString('base64url');
function cookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  const id = matches.length === 1 ? matches[0].slice(name.length + 1) : null;
  return name === OPERATOR_STATE_COOKIE ? id : identifier(id) ? id : null;
}
const cookieHeader = (name, id, maxAge) => `${name}=${id}; Path=${name === OPERATOR_STATE_COOKIE ? '/api/operator' : '/'}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = location => new Response(null, { status: 303, headers: { location,
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const refused = (status, allow) => new Response(null, { status, headers: { 'cache-control': 'no-store', ...(allow ? { allow } : {}) } });

/** Pending proofs live only in sealed browser cookies. SQLite retains consumed
 * hashes until expiry for captured-cookie/concurrent replay refusal. Login starts
 * allocate no rows or global quota. Grants remain revocable, hashed and private.
 */
export function createSQLiteOperatorStore(db) {
  const state = createOperatorStateSeal(db);
  db.exec(`DROP TABLE IF EXISTS operator_pending;
    CREATE TABLE IF NOT EXISTS operator_used_states (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_grants (
    id_hash TEXT PRIMARY KEY, namespace TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS operator_used_state_expiry ON operator_used_states(expires_at);
    CREATE INDEX IF NOT EXISTS operator_grant_expiry ON operator_grants(expires_at);`);
  return {
    sweep(now) {
      db.prepare('DELETE FROM operator_used_states WHERE expires_at<=?').run(now);
      db.prepare('DELETE FROM operator_grants WHERE expires_at<=?').run(now);
    },
    sealState: state.seal,
    takeState(token, binding, now) {
      const pending = state.open(token, binding, now);
      if (!pending) return null;
      // Atomic insertion before any token exchange also covers failed callbacks.
      const used = db.prepare('INSERT OR IGNORE INTO operator_used_states VALUES (?,?)').run(digest(token), pending.expiresAt);
      return used.changes === 1 ? pending : null;
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
  const stateBinding = JSON.stringify([namespace, publicOrigin + '/api/operator/callback/']);
  const live = request => {
    const grant = store.grant(cookie(request, OPERATOR_COOKIE), namespace, now());
    return grant && provider.allows(grant.subject) ? { name: grant.name, subject: grant.subject } : null;
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
        store.takeState(cookie(request, OPERATOR_STATE_COOKIE), stateBinding, now());
        const response = redirect('/#settings-general');
        response.headers.append('set-cookie', cookieHeader(OPERATOR_COOKIE, '', 0));
        response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, '', 0));
        return response;
      }
      store.sweep(now());
      if (action === 'login') {
        try {
          store.takeState(cookie(request, OPERATOR_STATE_COOKIE), stateBinding, now());
          const { pending, url } = provider.begin();
          const returns = new URL(request.url).searchParams.getAll('return');
          const sealed = store.sealState({ ...pending, ...(returns.length === 1 && returns[0] === 'admin' ? { return: 'admin' } : {}) }, stateBinding, now() + OPERATOR_STATE_MS);
          const response = redirect(url);
          response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, sealed, OPERATOR_STATE_MS / 1000));
          return response;
        } catch { return redirect('/?operator=denied#settings-general'); }
      }
      const pending = store.takeState(cookie(request, OPERATOR_STATE_COOKIE), stateBinding, now());
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
        const response = redirect(pending.return === 'admin' ? '/admin' : '/#settings-general');
        response.headers.append('set-cookie', cookieHeader(OPERATOR_STATE_COOKIE, '', 0));
        response.headers.append('set-cookie', cookieHeader(OPERATOR_COOKIE, id, GRANT_MS / 1000));
        return response;
      } catch { return fail(); }
    },
  });
}
