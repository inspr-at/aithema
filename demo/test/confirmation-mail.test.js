import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash, createHmac, randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createIdentity, reduceIdentity } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createDemoHost } from '../host-ports.js';
import { createVisitorCredits } from '../visitor-credits.js';
import { temporaryDb, mockConsent } from '../../test/helpers.js';

const origin = 'https://host.example.test', address = 'visitor@example.test', DAY = 86_400_000;
async function fixture(t, options = {}) {
  let time = 1_000;
  const storage = options.storage ?? new SQLiteStorage(); t.after(() => { if (storage.db.isOpen) storage.close(); });
  const messages = [], forms = new Map();
  const mailPlugin = { id: 'smtp', deliversVerification: true, async requestVerification(effect) { messages.push(effect); return { status: 'sent' }; } };
  const host = createDemoHost({ storage, demo: false, now: () => time, privacyDocumentConfigured: () => true, mailPlugin, ...options });
  const { createConfirmationPage } = await import('../confirmation-page.js');
  const page = createConfirmationPage({ host, publicOrigin: origin });
  const session = (owner = 'owner') => storage.create({ ownerToken: owner, locale: 'de' });
  const request = async (s, owner = 'owner', email = address) => {
    host.saveEmail(owner, { address: email, noticeVersion: 'ait-135-v1' });
    const result = reduceIdentity(host.identity.project({ session: s }, createIdentity()), { type: 'request-verification', address: email, now: time });
    host.identity.persist({ session: s }, result.state);
    const effect = result.events.find(e => e.type === 'verification.requested');
    if (!effect) return { status: 'rate-limited' };
    const delivery = await host.identity.requestVerification({ sessionId: s.id, ownerToken: owner, ...effect.data });
    if (delivery.status === 'sent') forms.set(messages.at(-1).token, await form(messages.at(-1).token));
    return delivery;
  };
  const get = token => page.handle(new Request(`${origin}/confirm-email?token=${encodeURIComponent(token)}&lang=de`));
  const form = async token => {
    const response = await get(token), html = await response.text();
    return { cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: /name="csrf" value="([^"]+)"/u.exec(html)?.[1], html };
  };
  const post = async (token, overrides = {}) => {
    const f = forms.get(token) ?? await form(token);
    return page.handle(new Request(`${origin}/confirm-email`, { method: 'POST', headers: {
      origin, cookie: f.cookie ?? '', 'content-type': 'application/x-www-form-urlencoded', ...overrides },
    body: new URLSearchParams({ token, csrf: f.csrf ?? '', lang: 'de' }) }));
  };
  host.visitorCredits.saveSettings({ baseRevision: 1, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' }, confirmationEnabled: true }, { actor: 'ops-cli:test', source: 'ops-cli' });
  return { storage, host, messages, session, request, get, post, form, at: value => { time = value; } };
}

test('C1 stores only SHA-256 of a random token, survives restart, and GET never redeems', async t => {
  const db = await temporaryDb();
  const f = await fixture(t, { storage: new SQLiteStorage(db) }), s = f.session();
  await f.request(s); const token = f.messages[0].token;
  assert.ok(token.length >= 32); assert.equal(f.messages[0].locale, 'de');
  const rows = f.storage.db.prepare('SELECT * FROM visitor_confirmation_tokens').all();
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(rows).includes(token), false);
  const before = f.storage.db.prepare('SELECT * FROM visitor_identities').all();
  const response = await f.get(token), html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /E-Mail-Adresse bestätigen/u); assert.match(html, /method="post"/u);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(f.storage.db.prepare('SELECT * FROM visitor_identities').all(), before);
  assert.equal(f.host.visitor('owner').tier, 'emailGiven');
  f.storage.close(); const reopened = new SQLiteStorage(db); t.after(() => reopened.close());
  const host = createDemoHost({ storage: reopened, demo: false, mailPlugin: { id: 'smtp', deliversVerification: true }, now: () => 1_000, privacyDocumentConfigured: () => true });
  assert.equal(host.confirmation.inspect(token).state, 'valid');
});

test('C1 POST atomically promotes exactly once; replay and concurrent replay are refused', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  const responses = await Promise.all([f.post(token), f.post(token)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.host.visitor('owner').tier, 'emailConfirmed');
  assert.equal(f.host.confirmation.inspect(token).state, 'alreadyUsed');
  assert.match(await (await f.post(token)).text(), /bereits verwendet/u);
  assert.equal(f.storage.db.prepare('SELECT confirmed_at FROM visitor_identities').get().confirmed_at, 1_000);
  const audit = JSON.stringify(f.host.visitorCredits.audit()); assert.match(audit, /confirmation.redeemed/u); assert.equal(audit.includes(address), false);
});

test('C1 expiry, invalid tokens and five failed attempts have distinct states', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  assert.equal(f.host.confirmation.inspect('nonsense').state, 'invalid');
  const wrong = token.slice(0, token.indexOf('.') + 1) + 'x'.repeat(43);
  for (let i = 0; i < 5; i++) assert.equal(f.host.confirmation.redeem(wrong).state, 'invalid');
  assert.equal(f.host.confirmation.redeem(token).state, 'tooManyAttempts');
  f.at(61_000); await f.request(s); const fresh = f.messages.at(-1).token;
  f.at(61_000 + 30 * 60_000);
  assert.equal(f.host.confirmation.inspect(fresh).state, 'expired');
  assert.match(await (await f.get(fresh)).text(), /neuen Link/u);
  assert.equal((await f.post(fresh)).status, 410);
  assert.equal(f.host.visitor('owner').tier, 'emailGiven');
});

test('C1 durable visitor cooldown and resend replacement invalidate old links', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const old = f.messages[0].token;
  assert.equal((await f.request(s)).status, 'rate-limited'); assert.equal(f.messages.length, 1);
  f.at(61_000); await f.request(s);
  assert.equal(f.host.confirmation.inspect(old).state, 'invalid');
  assert.equal(f.host.confirmation.inspect(f.messages.at(-1).token).state, 'valid');
});

for (const action of ['change', 'delete']) test(`C1 email ${action} invalidates the pending link`, async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  if (action === 'change') f.host.saveEmail('owner', { address: 'new@example.test', noticeVersion: 'ait-135-v1' });
  else f.host.deleteEmail('owner');
  assert.equal(f.host.confirmation.redeem(token).state, 'invalid');
  assert.equal(f.host.visitor('owner').tier, action === 'delete' ? 'anonymous' : 'emailGiven');
});

test('C1 24h cleanup deletes pending tokens/delivery metadata while preserving an independently saved email', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); f.at(DAY + 1_000); f.host.retainVisitors();
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_deliveries').get().n, 0);
  assert.equal(f.host.visitor('owner').address, address); assert.equal(f.host.visitor('owner').tier, 'emailGiven');
  assert.match(JSON.stringify(f.host.visitorCredits.audit()), /confirmation.delivery/u);
  f.at(181 * DAY); f.host.retainVisitors(); assert.deepEqual(f.host.visitorCredits.audit(), []);
});

test('C1 visitor erasure cascades tokens and delivery metadata', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  f.host.eraseVisitor('owner'); assert.equal(f.host.confirmation.inspect(token).state, 'invalid');
  for (const table of ['visitor_confirmation_tokens', 'visitor_mail_deliveries']) assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('C1 address HMAC throttle permits three mails per rolling 24h across visitors', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const owner = `owner-${i}`, s = f.session(owner);
    const result = await f.request(s, owner, i % 2 ? 'visitor@EXAMPLE.TEST' : address);
    assert.equal(result.status, i < 3 ? 'sent' : 'rate-limited');
  }
  assert.equal(f.messages.length, 3);
  const rows = f.storage.db.prepare('SELECT * FROM visitor_mail_abuse').all();
  assert.equal(new Set(rows.map(r => r.address_key)).size, 1); assert.match(rows[0].address_key, /^[a-f0-9]{64}$/u);
  assert.notEqual(rows[0].address_key, rows[0].token_hash);
  assert.equal(JSON.stringify(rows).toLowerCase().includes(address), false);
  f.at(DAY + 1_000); const s = f.session('later'); assert.equal((await f.request(s, 'later')).status, 'sent');
});

for (const [name, headers] of [['cross-origin', { origin: 'https://evil.example.test' }], ['missing origin', { origin: '' }], ['missing CSRF cookie', { cookie: '' }]]) {
  test(`C1 ${name} POST refuses redemption`, async t => {
    const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
    assert.equal((await f.post(token, headers)).status, 403);
    assert.equal(f.host.confirmation.inspect(token).state, 'valid');
  });
}

test('C1 real plugin obeys AIT-151 privacy funnel and hides the shared address limit', async t => {
  const f = await fixture(t), handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent }); t.after(() => handlers.close());
  const call = (path, owner, payload) => handlers.handle(new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify(payload) }));
  for (let i = 0; i < 4; i++) {
    const owner = `api-owner-${i}`, s = f.session(owner);
    const response = await call(`/api/sessions/${s.id}/identity/request`, owner, { address });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).identity.delivery, 'sent');
    await handlers.idle();
  }
  f.host.privacyDocumentConfigured = () => false;
  const s = f.session('privacy-owner');
  assert.equal((await call(`/api/sessions/${s.id}/identity/request`, 'privacy-owner', { address })).status, 403);
  assert.equal((await f.post(f.messages[0].token)).status, 403);
  assert.equal(f.messages.length, 3);
});

test('C1 fix1 erase-and-recreate preserves the three-mail limit and erases all visitor-linked rows', async t => {
  const f = await fixture(t), erasedRefs = [];
  for (let i = 0; i < 5; i++) {
    const owner = `erased-${i}`, s = f.session(owner);
    await f.request(s, owner);
    const ref = f.host.visitor(owner).visitorRef;
    erasedRefs.push(ref);
    f.host.eraseVisitor(owner);
    for (const table of ['visitor_identities', 'visitor_confirmation_tokens', 'visitor_mail_deliveries']) {
      assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
  }
  assert.equal(f.messages.length, 3, 'erasure must not reset the shared quota');
  for (const ref of erasedRefs) assert.equal(JSON.stringify(f.host.visitorCredits.audit()).includes(ref), false);
  const rows = f.storage.db.prepare('SELECT * FROM visitor_mail_abuse').all();
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['address_key', 'created_at']);
  assert.equal(f.storage.db.prepare('PRAGMA foreign_key_list(visitor_mail_abuse)').all().length, 0);
  f.at(DAY + 1_000);
  f.host.retainVisitors({ limit: 1 });
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse').get().n, 2, 'cleanup remains bounded');
  f.host.retainVisitors();
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse').get().n, 0);
  assert.equal((await f.request(f.session('after-expiry'), 'after-expiry')).status, 'sent');
});

test('C1 fix1 Unicode and punycode recipients share a quota and one stored/delivered canonical form', async t => {
  const f = await fixture(t), canonical = 'visitor@xn--bcher-kva.test';
  for (let i = 0; i < 4; i++) {
    const owner = `idn-${i}`, email = i % 2 ? canonical : ' visitor@BÜCHER.test ';
    // Exercise the HTTP boundary, including trimming before core validation.
    const s = f.session(owner), handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent });
    const response = await handlers.handle(new Request(`http://local/api/sessions/${s.id}/identity/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify({ address: email }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).identity.address, canonical);
    await handlers.idle(); await handlers.close();
    assert.equal(f.host.visitor(owner).address, canonical);
  }
  assert.equal(f.messages.length, 3);
  assert.ok(f.messages.every(message => message.address === canonical));
  const keys = f.storage.db.prepare('SELECT address_key FROM visitor_mail_abuse').all();
  assert.equal(new Set(keys.map(row => row.address_key)).size, 1);
  f.host.saveEmail('idn-0', { address: ' visitor@BÜCHER.test ', noticeVersion: 'ait-135-v1' });
  const revision = f.host.visitor('idn-0').addressRevision;
  f.host.saveEmail('idn-0', { address: canonical, noticeVersion: 'ait-135-v1' });
  assert.equal(f.host.visitor('idn-0').addressRevision, revision);
});

for (const email of ['visitor@\u200d.test', 'visitor@xn--.test', 'visitor\u0001@example.test', 'visitor@example.test\u007f']) {
  test(`C1 fix1 rejects invalid IDN/control address ${JSON.stringify(email)}`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.host.saveEmail('owner', { address: email, noticeVersion: 'ait-135-v1' }), /Invalid/iu);
  });
}

test('C1 fix1 the host HMAC secret is create-once, private and survives a database restart', async t => {
  const db = await temporaryDb(), f = await fixture(t, { storage: new SQLiteStorage(db) });
  const secretPath = join(dirname(db), 'confirmation-hmac.key');
  const key = await readFile(secretPath);
  assert.equal(key.length, 32);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  for (let i = 0; i < 3; i++) { const owner = `persistent-${i}`; await f.request(f.session(owner), owner); f.host.eraseVisitor(owner); }
  f.storage.close();
  const reopened = new SQLiteStorage(db), again = await fixture(t, { storage: reopened });
  assert.ok(key.equals(await readFile(secretPath)), 'restart must not rotate the host secret');
  assert.equal((await again.request(again.session('restart'), 'restart')).status, 'rate-limited');
  assert.equal(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name='visitor_mail_key'").get(), undefined);
});

for (const currentAddress of [address, 'changed@example.test']) test(`C1 fix1 migration preserves draft C1 quotas with current address ${currentAddress} and moves the existing secret once`, async t => {
  const db = await temporaryDb(), storage = new SQLiteStorage(db), key = randomBytes(32);
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const credits = createVisitorCredits({ storage, now: () => 1_000, deliveryEnabled: true, privacyDocumentConfigured: () => true });
  const ownerHash = createHash('sha256').update('legacy').digest('hex');
  const visitor = credits.saveEmail(ownerHash, { address: currentAddress, noticeVersion: 'ait-135-v1' });
  storage.db.exec(`CREATE TABLE visitor_mail_key (id INTEGER PRIMARY KEY CHECK(id=1), key BLOB NOT NULL);
    CREATE TABLE visitor_mail_deliveries (request_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
      visitor_ref TEXT NOT NULL REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
      address_key TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, locale TEXT NOT NULL);
    CREATE INDEX visitor_mail_address_limit ON visitor_mail_deliveries(address_key,created_at);`);
  storage.db.prepare('INSERT INTO visitor_mail_key VALUES (1,?)').run(key);
  const digest = createHmac('sha256', key).update(`address\0${address}`).digest('hex');
  for (let i = 0; i < 3; i++) storage.db.prepare('INSERT INTO visitor_mail_deliveries VALUES (?,?,?,?,?,?,?)')
    .run(`legacy-${i}`, `legacy-hash-${i}`, visitor.visitorRef, digest, 1_000, 'sent', 'en');
  const f = await fixture(t, { storage });
  assert.ok(key.equals(await readFile(join(dirname(db), 'confirmation-hmac.key'))));
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse').get().n, 3);
  assert.equal(storage.db.prepare('PRAGMA table_info(visitor_mail_deliveries)').all().some(column => column.name === 'address_key'), false);
  f.host.eraseVisitor('legacy');
  assert.equal((await f.request(f.session('migration-new'), 'migration-new')).status, 'rate-limited');
  createDemoHost({ storage, demo: false, now: () => 1_000 });
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse').get().n, 3, 'migration is idempotent');
});

test('C1 fix1 the HTTP adapter completes its response while SMTP is held', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { mailPlugin: { id: 'smtp', deliversVerification: true, async requestVerification() { await held; return { status: 'sent' }; } } });
  const handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent });
  const { server, url } = await listen(handlers.handle);
  t.after(async () => { release(); await handlers.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  try {
    const s = f.session();
    const response = await fetch(`${url}/api/sessions/${s.id}/identity/request`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aithema-session-token': 'owner' }, body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).identity.delivery, 'sent');
  } finally { release(); }
});

test('C1 fix1 accepted/suppressed HTTP responses match and finish before SMTP; outage stays private', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const messages = [];
  const f = await fixture(t, { mailPlugin: { id: 'smtp', deliversVerification: true, async requestVerification(effect) {
    messages.push(effect); await held; throw new Error('relay unavailable');
  } } });
  const handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent });
  t.after(() => handlers.close());
  const call = (s, owner, command = 'request') => handlers.handle(new Request(`http://local/api/sessions/${s.id}/identity/${command}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner },
    body: JSON.stringify(command === 'request' ? { address } : {}),
  }));
  const responseBeforeMail = async (s, owner) => {
    let timer;
    const response = await Promise.race([call(s, owner), new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
    clearTimeout(timer);
    assert.ok(response, 'HTTP must not wait for SMTP');
    return { status: response.status, headers: [...response.headers], body: await response.json() };
  };
  try {
    const first = f.session('async-0'), accepted = await responseBeforeMail(first, 'async-0');
    assert.equal(messages.length, 0, 'SMTP starts after the response');
    assert.equal(accepted.body.identity.delivery, 'sent');
    // Let queued reservations complete without waiting on the held SMTP calls.
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 1; i < 3; i++) { await responseBeforeMail(f.session(`async-${i}`), `async-${i}`); await new Promise(resolve => setImmediate(resolve)); }
    const suppressed = await responseBeforeMail(f.session('async-3'), 'async-3');
    assert.deepEqual(suppressed, accepted);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 3);
    assert.equal((await call(first, 'async-0', 'resend')).status, 429, 'own cooldown stays observable');
    release(); await handlers.idle();
    for (const owner of ['async-0', 'async-3']) assert.equal(f.host.identity.project({ session: f.storage.get(f.storage.ownedIds(owner)[0]) }, createIdentity()).delivery, 'sent');
  } finally { release(); }
});

test('C1 fix1 inspection and redemption use fixed-length timingSafeEqual and handle malformed lengths', async t => {
  const f = await fixture(t); await f.request(f.session()); const token = f.messages[0].token;
  const original = crypto.timingSafeEqual, calls = [];
  const mocked = t.mock.method(crypto, 'timingSafeEqual', (left, right) => {
    calls.push([left.length, right.length]); return original(left, right);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(f.host.confirmation.inspect(token).state, 'valid');
  assert.deepEqual(calls.pop(), [32, 32]);
  assert.equal(f.host.confirmation.redeem(token.split('.')[0] + '.short').state, 'invalid');
  assert.deepEqual(calls.pop(), [32, 32], 'redemption hashes even a short supplied bearer');
  const digest = createHash('sha256').update(token).digest('hex');
  f.storage.db.prepare('UPDATE visitor_confirmation_tokens SET token_hash=? WHERE token_hash=?').run('aa', digest);
  f.storage.db.prepare('UPDATE visitor_mail_deliveries SET token_hash=? WHERE token_hash=?').run('aa', digest);
  assert.equal(f.host.confirmation.inspect(token).state, 'invalid');
  assert.equal(f.host.confirmation.redeem(token).state, 'invalid');
  assert.ok(calls.every(([a, b]) => a === 32 && b === 32), 'malformed stored length must never reach timingSafeEqual');
});

test('C1 production host rejects a mock mail transport and absent config stays at email-given', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  assert.throws(() => createDemoHost({ storage, demo: false, mailPlugin: { id: 'console', deliversVerification: true } }), /SMTP|production|mock/iu);
  const host = createDemoHost({ storage, demo: false, privacyDocumentConfigured: () => true });
  assert.equal(host.identity.deliversVerification, false);
  assert.throws(() => host.visitorCredits.saveSettings({ baseRevision: 1, confirmationEnabled: true }, { source: 'ops-cli' }));
});

test('C1 authenticated confirm cannot redeem or claim a different visitor token', async t => {
  const f = await fixture(t), a = f.session('owner'), b = f.session('other');
  await f.request(a); const token = f.messages[0].token;
  await f.request(b, 'other', 'other@example.test');
  const result = await f.host.identity.verify({ sessionId: b.id, ownerToken: 'other', address: 'other@example.test', revision: f.host.visitor('other').addressRevision, token });
  assert.equal(result.verified, false); assert.equal(f.host.confirmation.inspect(token).state, 'valid');
  assert.equal(f.host.visitor('other').tier, 'emailGiven');
});

test('C1 CSRF proof is bound to the cookie and link and cannot be forged', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token, form = await f.form(token);
  const response = await f.host.confirmation.checkCsrf(form.cookie.split('=')[1], token, '0'.repeat(64));
  assert.equal(response, false);
  assert.equal(f.host.confirmation.checkCsrf(form.cookie.split('=')[1], token + 'tamper', form.csrf), false);
  assert.equal(f.host.confirmation.inspect(token).state, 'valid');
});

test('C1 fifth correct proof succeeds and API attempts share the landing-page limit', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  const handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent }); t.after(() => handlers.close());
  const call = candidate => handlers.handle(new Request(`http://local/api/sessions/${s.id}/identity/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': 'owner' }, body: JSON.stringify({ token: candidate }) }));
  for (let i = 0; i < 4; i++) assert.equal((await call('wrong')).status, 200);
  assert.equal((await f.post(token)).status, 200); assert.equal(f.host.visitor('owner').tier, 'emailConfirmed');
});

test('C1 confirmation setting is OPS-only and private CLI enables it with delivery', async t => {
  const f = await fixture(t);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: 2, confirmationEnabled: false }), /OPS/iu);
  const { listenAdmin, adminRequest } = await import('../admin-socket.js');
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { promisify } = await import('node:util'), { execFile } = await import('node:child_process');
  const socketPath = join(await mkdtemp(join(tmpdir(), 'ait-mail-cli-')), 'ops.sock');
  const admin = await listenAdmin({ host: f.host, socketPath }); t.after(() => admin.close());
  assert.equal((await adminRequest(socketPath, 'set-confirmation', { baseRevision: 2, confirmationEnabled: false })).status, 200);
  const result = await promisify(execFile)(process.execPath, ['demo/admin-cli.js', '--socket', socketPath, 'set-confirmation', '--base-revision', '3', '--enabled', 'true']);
  assert.equal(JSON.parse(result.stdout).confirmationEnabled, true);
});

test('C1 demo-only outbox also issues a token with at least 128 random bits', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage, demo: true, now: () => 1_000 }), s = storage.create({ ownerToken: 'demo-owner' });
  const result = reduceIdentity(createIdentity(), { type: 'request-verification', address, now: 1_000 });
  host.identity.persist({ session: s }, result.state);
  await host.identity.requestVerification({ sessionId: s.id, ownerToken: 'demo-owner', ...result.events.find(e => e.type === 'verification.requested').data });
  // UUIDv4 has 122 random bits. The demo and SMTP path both need stronger tokens.
  assert.equal(/^[A-Za-z0-9_-]{43}$/u.test(host.outbox({ sessionId: s.id, ownerToken: 'demo-owner' })[0].token), true, '256-bit base64url token');
});
