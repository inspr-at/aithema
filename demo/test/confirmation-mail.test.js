import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createIdentity, reduceIdentity } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { createDemoHost } from '../host-ports.js';
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

test('C1 visitor erasure cascades tokens, HMAC throttle rows and delivery metadata', async t => {
  const f = await fixture(t), s = f.session(); await f.request(s); const token = f.messages[0].token;
  f.host.eraseVisitor('owner'); assert.equal(f.host.confirmation.inspect(token).state, 'invalid');
  for (const table of ['visitor_confirmation_tokens', 'visitor_mail_deliveries']) assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('C1 address HMAC throttle permits three mails per rolling 24h across visitors', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const owner = `owner-${i}`, s = f.session(owner);
    const result = await f.request(s, owner, i % 2 ? ' VISITOR@example.test '.trim() : address);
    assert.equal(result.status, i < 3 ? 'sent' : 'rate-limited');
  }
  assert.equal(f.messages.length, 3);
  const rows = f.storage.db.prepare('SELECT * FROM visitor_mail_deliveries').all();
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

test('C1 real plugin obeys AIT-151 privacy funnel and cross-visitor address throttle returns existing rate limit', async t => {
  const f = await fixture(t), handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent }); t.after(() => handlers.close());
  const call = (path, owner, payload) => handlers.handle(new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner }, body: JSON.stringify(payload) }));
  for (let i = 0; i < 4; i++) {
    const owner = `api-owner-${i}`, s = f.session(owner);
    const response = await call(`/api/sessions/${s.id}/identity/request`, owner, { address });
    assert.equal(response.status, i < 3 ? 200 : 429);
    if (i === 3) assert.equal((await response.json()).error, 'confirmation-rate-limit');
  }
  f.host.privacyDocumentConfigured = () => false;
  const s = f.session('privacy-owner');
  assert.equal((await call(`/api/sessions/${s.id}/identity/request`, 'privacy-owner', { address })).status, 403);
  assert.equal((await f.post(f.messages[0].token)).status, 403);
  assert.equal(f.messages.length, 3);
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
