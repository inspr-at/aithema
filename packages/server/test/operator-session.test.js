import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../src/storage.js';
import { createOperatorSessions, createSQLiteOperatorStore, OPERATOR_COOKIE, OPERATOR_STATE_COOKIE } from '../src/operator-session.js';
import { createZitadelOIDC, zitadelOperatorConfig } from '../../../plugins/zitadel-oidc/src/index.js';
import { stubOperatorIssuer } from '../../../test/fixtures/operator-issuer.js';

async function fixture(t) {
  const issuer = await stubOperatorIssuer(); t.after(() => issuer.close());
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let time = Date.now();
  const config = zitadelOperatorConfig({ AITHEMA_OPERATOR_ISSUER: issuer.issuer, AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECT: 'allowed-operator', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' });
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
  assert.equal(f.issuer.exchanges.length, 0); assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_used_states').get().count, 0);
});

test('AIT-165 grant survives a new port, is revoked by logout, expires after eight hours and changes with host authority', async t => {
  const f = await fixture(t), p = await f.login();
  const response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie));
  const cookie = response.headers.getSetCookie().find(v => v.startsWith(OPERATOR_COOKIE + '=')).split(';')[0];
  const again = createOperatorSessions({ provider: f.provider, store: createSQLiteOperatorStore(f.storage.db), publicOrigin: f.config.publicOrigin });
  assert.deepEqual(again.session(f.req('/', cookie)), { name: 'Ada', subject: 'allowed-operator' });
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
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_used_states').get().count, 0);
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
    AITHEMA_OPERATOR_SUBJECT: 'subject', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' };
  for (const key of Object.keys(full)) assert.equal(createZitadelOIDC({ config: zitadelOperatorConfig({ ...full, [key]: ' ' }) }), null);
  for (const issuer of ['http://external.test', 'https://issuer.test/path', 'https://user:pass@issuer.test', 'https://issuer.test/?q=1']) {
    assert.throws(() => zitadelOperatorConfig({ ...full, AITHEMA_OPERATOR_ISSUER: issuer }), TypeError);
  }
});

test('AIT-165 OPS env names produce the exact registered callback including its trailing slash', () => {
  const values = { AITHEMA_OPERATOR_ISSUER: 'https://issuer.test', AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECT: 'subject', AITHEMA_PUBLIC_ORIGIN: 'https://start2.augmentoring.com' };
  const config = zitadelOperatorConfig(values);
  assert.equal(config.redirectUri, 'https://start2.augmentoring.com/api/operator/callback/');
  const authorization = new URL(createZitadelOIDC({ config }).begin().url);
  assert.equal(authorization.searchParams.get('redirect_uri'), config.redirectUri);
  assert.deepEqual(config.subjects, ['subject']);
  assert.equal(zitadelOperatorConfig({ ...values, AITHEMA_OPERATOR_SUBJECT: undefined, AITHEMA_OPERATOR_SUBJECTS: 'subject' }), null);
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
  assert.deepEqual(f.port.session(f.req('/', second)), { name: 'Ada', subject: 'allowed-operator' }, 'a separate browser remains signed in');
  const latest = response.headers.getSetCookie().find(v => v.startsWith(OPERATOR_COOKIE + '=')).split(';')[0];
  const logout = await f.port.handle(f.req('/api/operator/logout/', latest, { method: 'POST', headers: { origin: f.config.publicOrigin } }));
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.ok(logout.headers.getSetCookie().every(c => c.includes('Max-Age=0')));
  assert.equal(f.port.session(f.req('/', latest)), null);
});

test('AIT-165 5,000 unauthenticated login starts cannot lock out an operator', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5000; i++) {
    const response = await f.port.handle(f.req('/api/operator/login/'));
    assert.equal(new URL(response.headers.get('location'), f.config.publicOrigin).origin, f.issuer.issuer, `login start ${i + 1}`);
  }
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_used_states').get().count, 0, 'login starts allocate no replay rows');
  const p = await f.login(), response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie));
  assert.equal(response.headers.get('location'), '/#settings-general');
  assert.equal(f.issuer.exchanges.length, 1);
  assert.equal(f.storage.db.prepare("SELECT name FROM sqlite_master WHERE name='operator_pending'").get(), undefined, 'no server-side pending proofs');
});

test('AIT-165 sealed state refuses tampering, duplicates and replay before exchange', async t => {
  const f = await fixture(t), p = await f.login(), value = p.cookie.split('=')[1];
  const at = 50, tampered = p.cookie.slice(0, p.cookie.indexOf('=') + 1) + value.slice(0, at) +
    (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
  for (const cookie of [tampered, `${p.cookie}; ${p.cookie}`]) {
    const response = await f.port.handle(f.req(p.callback.pathname + p.callback.search, cookie));
    assert.equal(response.headers.get('location'), '/?operator=denied#settings-general');
    assert.match(response.headers.getSetCookie()[0], /Max-Age=0/u);
  }
  assert.equal(f.issuer.exchanges.length, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_used_states').get().count, 0, 'invalid cookies allocate no replay rows');
  const results = await Promise.all([0, 1].map(() => f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie))));
  assert.equal(results.filter(r => r.headers.get('location') === '/#settings-general').length, 1);
  assert.equal(f.issuer.exchanges.length, 1);
  const rows = JSON.stringify(f.storage.db.prepare('SELECT * FROM operator_used_states').all());
  assert.equal(rows.includes(value), false, 'only consumed cookie hashes are retained');
  const restarted = createOperatorSessions({ provider: f.provider, store: createSQLiteOperatorStore(f.storage.db), publicOrigin: f.config.publicOrigin });
  assert.equal((await restarted.handle(f.req(p.callback.pathname + p.callback.search, p.cookie))).headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.issuer.exchanges.length, 1);
});

test('AIT-165 sealed state is bound to the public callback and provider authority', async t => {
  const f = await fixture(t), p = await f.login();
  for (const [provider, publicOrigin] of [
    [f.provider, 'https://other-host.test'],
    [createZitadelOIDC({ config: { ...f.config, clientId: 'other-client' } }), f.config.publicOrigin],
  ]) {
    const changed = createOperatorSessions({ provider, store: f.store, publicOrigin });
    assert.equal((await changed.handle(f.req(p.callback.pathname + p.callback.search, p.cookie))).headers.get('location'), '/?operator=denied#settings-general');
  }
  assert.equal(f.issuer.exchanges.length, 0);
  assert.equal((await f.port.handle(f.req(p.callback.pathname + p.callback.search, p.cookie))).headers.get('location'), '/#settings-general');
  f.advance(600_000);
  await f.port.handle(f.req('/api/operator/login/'));
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS count FROM operator_used_states').get().count, 0, 'consumed hashes are swept after the state TTL');
});

test('AIT-165 state uses a persistent 0600 host key and contains no plaintext pending proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-operator-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issuer = await stubOperatorIssuer(); t.after(() => issuer.close());
  const config = zitadelOperatorConfig({ AITHEMA_OPERATOR_ISSUER: issuer.issuer, AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECT: 'allowed-operator', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' });
  const provider = createZitadelOIDC({ config }), path = join(directory, 'host.sqlite');
  let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let port = createOperatorSessions({ provider, store: createSQLiteOperatorStore(storage.db), publicOrigin: config.publicOrigin });
  const response = await port.handle(new Request(config.publicOrigin + '/api/operator/login/'));
  const cookie = response.headers.getSetCookie()[0].split(';')[0], url = new URL(response.headers.get('location'));
  const keyPath = join(directory, 'operator-state.key'), key = await readFile(keyPath);
  assert.equal(key.length, 32); assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  const raw = Buffer.from(cookie.split('=')[1], 'base64url').toString('utf8');
  for (const name of ['state', 'nonce']) assert.equal(raw.includes(url.searchParams.get(name)), false);
  storage.close(); storage = new SQLiteStorage(path);
  port = createOperatorSessions({ provider, store: createSQLiteOperatorStore(storage.db), publicOrigin: config.publicOrigin });
  assert.deepEqual(await readFile(keyPath), key, 'restarts reuse the same host secret');
  const callback = issuer.authorize(url);
  assert.equal((await port.handle(new Request(callback, { headers: { cookie } }))).headers.get('location'), '/#settings-general');
  assert.equal((await port.handle(new Request(callback, { headers: { cookie } }))).headers.get('location'), '/?operator=denied#settings-general');
});

test('AIT-165 normalizes a safe issuer trailing slash while retaining fixed paths and the exact redirect', () => {
  const config = zitadelOperatorConfig({ AITHEMA_OPERATOR_ISSUER: 'https://issuer.test/', AITHEMA_OPERATOR_CLIENT_ID: 'client',
    AITHEMA_OPERATOR_SUBJECT: 'subject', AITHEMA_PUBLIC_ORIGIN: 'https://host.test' });
  assert.equal(config.issuer, 'https://issuer.test');
  const url = new URL(createZitadelOIDC({ config }).begin().url);
  assert.equal(url.pathname, '/oauth/v2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://host.test/api/operator/callback/');
});

for (const [label, claims, accepted] of [
  ['recent expiry', now => ({ exp: now - 15 }), true],
  ['small future iat', now => ({ iat: now + 15 }), true],
  ['expiry beyond tolerance', now => ({ exp: now - 45 }), false],
  ['future iat beyond tolerance', now => ({ iat: now + 45 }), false],
]) test(`AIT-165 30-second ID token clock tolerance: ${label}`, async t => {
  const f = await fixture(t), start = await f.port.handle(f.req('/api/operator/login/'));
  const callback = f.issuer.authorize(start.headers.get('location'), claims(Math.floor(Date.now() / 1000)));
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  const response = await f.port.handle(f.req(callback.pathname + callback.search, cookie));
  assert.equal(response.headers.get('location'), accepted ? '/#settings-general' : '/?operator=denied#settings-general');
});

test('AIT-165 unknown kid cannot refetch JWKS within the 30-second cooldown', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const complete = async header => {
    const { pending, url } = f.provider.begin(), callback = f.issuer.authorize(url, {}, header);
    return f.provider.complete(callback.searchParams.get('code'), pending);
  };
  await complete({}); assert.equal(f.issuer.keysRead(), 1);
  for (let i = 0; i < 5; i++) await assert.rejects(complete({ kid: `unknown-${i}` }), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
  assert.equal(f.issuer.keysRead(), 1, 'unknown keys must not force repeated downloads');
  t.mock.timers.tick(29_999);
  await assert.rejects(complete({ kid: 'unknown' }), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
  assert.equal(f.issuer.keysRead(), 1, 'still cooling down at 29,999 ms');
  t.mock.timers.tick(1);
  await assert.rejects(complete({ kid: 'unknown' }), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
  assert.equal(f.issuer.keysRead(), 2, 'one refetch permitted after 30 seconds');
  await assert.rejects(complete({ kid: 'unknown' }), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
  assert.equal(f.issuer.keysRead(), 2, 'the refetch starts a new cooldown');
});
