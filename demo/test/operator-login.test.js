import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startChild, temporaryDb } from '../../test/helpers.js';
import { stubOperatorIssuer } from '../../test/fixtures/operator-issuer.js';

const origin = 'https://operator.host.test';
async function fixture(t, settings = {}) {
  const issuer = await stubOperatorIssuer(); t.after(() => issuer.close());
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), {
    AITHEMA_PROVIDER: 'mock', AITHEMA_PUBLIC_ORIGIN: origin, AITHEMA_OPERATOR_ISSUER: issuer.issuer,
    AITHEMA_OPERATOR_CLIENT_ID: 'fixture-client', AITHEMA_OPERATOR_SUBJECTS: 'allowed-operator,second-operator', ...settings,
  });
  t.after(() => running.kill());
  const call = (path, cookie = '', init = {}) => fetch(running.url + path, { redirect: 'manual', ...init,
    headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}), ...init.headers } });
  const login = async (claims, header) => {
    const response = await call('/api/operator/login/'); assert.equal(response.status, 303);
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, issuer.issuer); assert.equal(url.pathname, '/oauth/v2/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/operator/callback/');
    assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    assert.equal(url.searchParams.has('client_secret'), false);
    for (const key of ['state', 'nonce', 'code_challenge']) assert.match(url.searchParams.get(key), /^[A-Za-z0-9_-]{43}$/u);
    const stateCookie = response.headers.getSetCookie()[0];
    assert.match(stateCookie, /HttpOnly/u); assert.match(stateCookie, /Secure/u); assert.match(stateCookie, /SameSite=Lax/u);
    assert.match(stateCookie, /Max-Age=600/u);
    return { callback: issuer.authorize(url, claims, header), cookie: stateCookie.split(';')[0] };
  };
  const callback = p => call(p.callback.pathname + p.callback.search, p.cookie);
  const grant = response => response.headers.getSetCookie().find(c => c.startsWith('aithema-operator='))?.split(';')[0];
  return { issuer, call, login, callback, grant };
}

test('AIT-165 login → stubbed PKCE exchange → private operator session; visitor identity and privacy stay guarded', async t => {
  const f = await fixture(t), pending = await f.login(), response = await f.callback(pending);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/#settings-general');
  const cookie = f.grant(response); assert.ok(cookie);
  const config = await (await f.call('/demo/config', cookie)).json();
  assert.deepEqual(config.operator, { name: 'Ada' }); assert.equal(config.operatorLogin.provider, 'Zitadel');
  assert.equal(config.privacy, null); assert.equal(config.operatorLogin.url, '/api/operator/login/');
  assert.match(response.headers.getSetCookie().find(c => c.startsWith(cookie)), /HttpOnly; Secure; SameSite=Lax/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const visitor = await (await f.call('/demo/config')).json(); assert.equal(Object.hasOwn(visitor, 'operator'), false);
  assert.equal((await f.call('/demo/config', cookie)).headers.get('cache-control'), 'no-store');
  const created = await f.call('/api/sessions', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const session = await created.json(); assert.equal(session.identity.status, 'guest'); assert.equal(Object.hasOwn(session, 'operator'), false);
  assert.equal((await f.call(`/api/sessions/${session.id}`, cookie)).status, 404, 'operator has no visitor ownership');
  const visitorCookie = created.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await f.call(`/api/sessions/${session.id}`, visitorCookie)).status, 200);
  assert.equal((await f.call('/api/visitor/email', visitorCookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"address":"visitor@example.test","noticeVersion":"ait-135-v1"}' })).status, 403);
  assert.equal(JSON.stringify(config).includes('allowed-operator'), false);
  assert.equal(JSON.stringify(config).includes('id_token'), false);
  const next = await f.callback(await f.login()); assert.ok(f.grant(next)); assert.equal(f.issuer.keysRead(), 1, 'JWKS is cached');
});

for (const [label, claims, header] of [
  ['nonce mismatch', { nonce: 'wrong' }], ['wrong audience', { aud: 'wrong' }], ['wrong issuer', { iss: 'https://wrong.test' }],
  ['expired token', { exp: 1 }], ['non-allowlisted subject', { sub: 'visitor' }], ['missing subject', { sub: null }],
  ['missing nonce', { nonce: null }], ['missing iat', { iat: null }], ['future iat', { iat: 4_000_000_000 }],
  ['wrong azp', { azp: 'wrong' }], ['multiple audiences without azp', { aud: ['fixture-client', 'other'] }],
  ['unknown kid', {}, { kid: 'unknown' }], ['wrong algorithm', {}, { alg: 'HS256' }],
]) test(`AIT-165 refuses ${label} and consumes state`, async t => {
  const f = await fixture(t), p = await f.login(claims, header), response = await f.callback(p);
  assert.equal(response.headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.grant(response), undefined); assert.equal(f.issuer.exchanges.length, 1);
  assert.equal((await f.callback(p)).headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.issuer.exchanges.length, 1);
});

for (const state of ['wrong', 'missing', 'cookie-missing']) test(`AIT-165 refuses ${state} state before exchange`, async t => {
  const f = await fixture(t), p = await f.login();
  if (state === 'wrong') p.callback.searchParams.set('state', 'wrong');
  if (state === 'missing') p.callback.searchParams.delete('state');
  if (state === 'cookie-missing') p.cookie = '';
  assert.equal((await f.callback(p)).headers.get('location'), '/?operator=denied#settings-general');
  assert.equal(f.issuer.exchanges.length, 0);
});

test('AIT-165 state is single-use even with a replayed cookie and concurrent callbacks', async t => {
  const f = await fixture(t), p = await f.login();
  const results = await Promise.all([f.callback(p), f.callback(p)]);
  assert.equal(results.filter(r => f.grant(r)).length, 1); assert.equal(f.issuer.exchanges.length, 1);
  assert.equal(f.grant(await f.callback(p)), undefined);
});

test('AIT-165 logout requires same-origin POST and revokes the server grant', async t => {
  const f = await fixture(t), cookie = f.grant(await f.callback(await f.login()));
  for (const [method, headers, status] of [['GET', {}, 405], ['POST', {}, 403], ['POST', { origin: 'https://evil.test' }, 403],
    ['POST', { origin, 'sec-fetch-site': 'cross-site' }, 403]]) {
    assert.equal((await f.call('/api/operator/logout/', cookie, { method, headers })).status, status);
    assert.deepEqual((await (await f.call('/demo/config', cookie)).json()).operator, { name: 'Ada' });
  }
  const response = await f.call('/api/operator/logout/', cookie, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(response.status, 303); assert.match(response.headers.getSetCookie()[0], /Max-Age=0/u);
  assert.equal(Object.hasOwn(await (await f.call('/demo/config', cookie)).json(), 'operator'), false);
});

for (const key of ['AITHEMA_OPERATOR_ISSUER', 'AITHEMA_OPERATOR_CLIENT_ID', 'AITHEMA_OPERATOR_SUBJECTS']) {
  test(`AIT-165 feature off without ${key}`, async t => {
    const f = await fixture(t, { [key]: '' });
    const config = await (await f.call('/demo/config')).json(); assert.equal(Object.hasOwn(config, 'operatorLogin'), false);
    assert.equal(Object.hasOwn(config, 'operator'), false);
    for (const path of ['/api/operator/login', '/api/operator/callback/', '/api/operator/logout']) {
      assert.equal((await f.call(path)).status, 404); assert.equal((await f.call(path, '', { method: 'POST' })).status, 404);
    }
    assert.equal(f.issuer.exchanges.length, 0); assert.equal(f.issuer.keysRead(), 0);
  });
}

for (const claims of [{ sub: 'second-operator' }, { aud: ['fixture-client', 'other'], azp: 'fixture-client' }]) {
  test('AIT-165 accepts explicitly allowed subjects and authorized multiple audiences', async t => {
    const f = await fixture(t), response = await f.callback(await f.login(claims));
    assert.ok(f.grant(response));
    assert.deepEqual((await (await f.call('/demo/config', f.grant(response))).json()).operator, { name: 'Ada' });
  });
}

test('AIT-165 host/Origin guards run before operator routes; a header or query cannot impersonate a grant', async t => {
  const f = await fixture(t);
  for (const headers of [{ host: 'evil.test' }, { origin: 'https://evil.test' }]) {
    assert.equal((await f.call('/api/operator/login/', '', { headers })).status, 403);
  }
  const visitor = await (await f.call('/demo/config?operator=Ada', '', { headers: { 'x-aithema-session-token': 'allowed-operator' } })).json();
  assert.equal(Object.hasOwn(visitor, 'operator'), false); assert.equal(f.issuer.exchanges.length, 0);
});
