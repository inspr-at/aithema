import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStorage } from '../src/storage.js';
import { createOperatorSessions, createSQLiteOperatorStore, OPERATOR_COOKIE, OPERATOR_STATE_COOKIE } from '../src/operator-session.js';
import { createZitadelOIDC, zitadelOperatorConfig } from '../../../plugins/zitadel-oidc/src/index.js';
import { stubOperatorIssuer } from '../../../test/fixtures/operator-issuer.js';

async function fixture(t) {
  const issuer = await stubOperatorIssuer(); t.after(() => issuer.close());
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let time = Date.now();
  const config = zitadelOperatorConfig({ AITHEMA_OPERATOR_ISSUER: issuer.issuer, AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECTS: 'allowed-operator', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' });
  const store = createSQLiteOperatorStore(storage.db), provider = createZitadelOIDC({ config });
  const port = createOperatorSessions({ provider, store, publicOrigin: config.publicOrigin, now: () => time });
  const req = (path, cookie = '', init = {}) => new Request('https://host.test' + path, { ...init, headers: { cookie, ...init.headers } });
  const login = async () => {
    const response = await port.handle(req('/api/operator/login'));
    return { cookie: response.headers.getSetCookie()[0].split(';')[0], callback: issuer.authorize(response.headers.get('location')) };
  };
  return { storage, store, provider, config, port, req, login, issuer, advance: ms => { time += ms; } };
}

test('AIT-165 expires and deletes browser-bound state after ten minutes, before exchange', async t => {
  const f = await fixture(t), p = await f.login(); f.advance(600_000);
  const response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie));
  assert.equal(response.headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.issuer.exchanges.length, 0); assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_pending').get().count, 0);
});

test('AIT-165 grant survives a new port, is revoked by logout, expires after eight hours and changes with host authority', async t => {
  const f = await fixture(t), p = await f.login();
  const response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie));
  const cookie = response.headers.getSetCookie().find(v => v.startsWith(OPERATOR_COOKIE + '=')).split(';')[0];
  const again = createOperatorSessions({ provider: f.provider, store: createSQLiteOperatorStore(f.storage.db), publicOrigin: f.config.publicOrigin });
  assert.deepEqual(again.session(f.req('/', cookie)), { name: 'Ada' });
  const changed = createOperatorSessions({ provider: createZitadelOIDC({ config: { ...f.config, clientId: 'new-client' } }), store: f.store, publicOrigin: f.config.publicOrigin });
  assert.equal(changed.session(f.req('/', cookie)), null);
  const records = JSON.stringify(f.storage.db.prepare('SELECT * FROM operator_grants').all());
  assert.ok(!records.includes(cookie.split('=')[1])); assert.ok(!records.includes('id_token'));
  assert.equal(f.port.session(f.req('/', cookie + '; ' + cookie)), null, 'duplicate cookies are refused');
  f.advance(8 * 60 * 60_000); assert.equal(f.port.session(f.req('/', cookie)), null);
  assert.equal(f.port.session(f.req('/', `${OPERATOR_COOKIE}=forged`)), null);
  assert.equal(f.port.session(f.req('/', p.cookie.replace(OPERATOR_STATE_COOKIE, OPERATOR_COOKIE))), null, 'pending proof cannot act as a grant');
});

test('AIT-165 method/path guards precede any state creation or request body parsing', async t => {
  const f = await fixture(t);
  for (const path of ['/api/operator/login', '/api/operator/callback/']) {
    const r = f.req(path, '', { method: 'POST', body: '{malformed' });
    assert.equal((await f.port.handle(r)).status, 405); assert.equal(r.bodyUsed, false);
  }
  for (const path of ['/api/operator/login/extra', '/api/operator/not-found', '/api/sessions', '/privacy', '/api/voice/llm/chat/completions']) {
    assert.equal(await f.port.handle(f.req(path)), null);
  }
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_pending').get().count, 0);
});

test('AIT-165 fresh login supersedes the previous browser proof, and errors/duplicate params consume it', async t => {
  const f = await fixture(t), p = await f.login();
  const replacement = await f.port.handle(f.req('/api/operator/login', p.cookie));
  assert.equal((await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie))).headers.get('location'), '/?operator=denied#settings-general');
  const cookie = replacement.headers.getSetCookie()[0].split(';')[0], url = f.issuer.authorize(replacement.headers.get('location'));
  url.searchParams.append('state', url.searchParams.get('state'));
  assert.equal((await f.port.handle(f.req(url.pathname + url.search, cookie))).headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.issuer.exchanges.length, 0);
});

test('AIT-165 no issuer/client/subjects/origin means no plugin; invalid complete config fails closed', () => {
  const full = { AITHEMA_OPERATOR_ISSUER: 'https://issuer.test', AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECTS: 'subject', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' };
  for (const key of Object.keys(full)) assert.equal(createZitadelOIDC({ config: zitadelOperatorConfig({ ...full, [key]: ' ' }) }), null);
  for (const issuer of ['http://external.test', 'https://issuer.test/path', 'https://user:pass@issuer.test', 'https://issuer.test/?q=1']) {
    assert.throws(() => zitadelOperatorConfig({ ...full, AITHEMA_OPERATOR_ISSUER: issuer }), TypeError);
  }
});

test('AIT-165 a second sign-in revokes the previous grant and logout clears independent cookies', async t => {
  const f = await fixture(t);
  const signIn = async () => {
    const p = await f.login(), response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie));
    return response.headers.getSetCookie().find(v => v.startsWith(OPERATOR_COOKIE + '=')).split(';')[0];
  };
  const first = await signIn(), second = await signIn();
  // Supersession is bound to the browser presenting its old grant.
  const p = await f.login(), response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie + '; ' + first));
  assert.equal(f.port.session(f.req('/', first)), null);
  assert.deepEqual(f.port.session(f.req('/', second)), { name: 'Ada' }, 'a separate browser remains signed in');
  const latest = response.headers.getSetCookie().find(v => v.startsWith(OPERATOR_COOKIE + '=')).split(';')[0];
  const logout = await f.port.handle(f.req('/api/operator/logout/', latest, { method: 'POST', headers: { origin: f.config.publicOrigin } }));
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.ok(logout.headers.getSetCookie().every(c => c.includes('Max-Age=0')));
  assert.equal(f.port.session(f.req('/', latest)), null);
});
