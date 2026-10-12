import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { admitCredits, createIdentity } from '@inspr/aithema-core';
import { createDemoHost } from '../host-ports.js';
import { mockConsent, temporaryDb } from '../../test/helpers.js';

const owner = 'tier-owner', address = 'visitor@example.test', noticeVersion = 'ait-135-v1';
const ownerHash = createHash('sha256').update(owner).digest('hex');
function fixture(t, options = {}) {
  const storage = options.storage ?? new SQLiteStorage();
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 1_000_000_000, visitorCapMicro: 1_000_000_000 });
  let time = 1_000;
  const host = createDemoHost({ storage, demo: false, ownerGuard: false, now: () => time, ...options });
  t.after(() => storage.close());
  const session = id => storage.create({ id, ownerToken: owner });
  const settings = (anonymous, emailGiven = anonymous, emailConfirmed = emailGiven) => host.visitorCredits.saveSettings({
    baseRevision: host.visitorCredits.settings().revision, allowancesUsd: { anonymous, emailGiven, emailConfirmed },
  }, { actor: 'ops-cli:fixture', source: 'ops-cli' });
  const request = (sessionId, maxMicro, extra = {}) => ({ sessionId, lane: 'reaction', maxMicro,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
  return { storage, ledger, host, session, settings, request, at: value => { time = value; } };
}

test('AIT-135 concurrent sessions of one visitor exhaust a single lifetime ceiling at the exact boundary', async t => {
  const f = fixture(t), a = f.session('tiers-a'), b = f.session('tiers-b');
  f.settings('0.000010');
  const results = await Promise.all([admitCredits(f.ledger, f.request(a.id, 6), f.host.wallet(owner)),
    admitCredits(f.ledger, f.request(b.id, 6), f.host.wallet(owner))]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await admitCredits(f.ledger, f.request(b.id, 4), f.host.wallet(owner))).ok, true);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 10);
  assert.equal((await admitCredits(f.ledger, f.request(a.id, 1), f.host.wallet(owner))).ok, false);
});

test('AIT-135 promotion, address replacement and deletion change the ceiling without replenishing spend or holds', async t => {
  const f = fixture(t), a = f.session('tiers-promote');
  f.settings('0.000010', '0.000015', '0.000020');
  const admitted = await admitCredits(f.ledger, f.request(a.id, 10), f.host.wallet(owner));
  const claim = f.ledger.claim(admitted.admission.attemptId); claim.consume();
  f.ledger.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', chargedMicro: 9, usage: { inputTokens: 0, outputTokens: 0 } });
  f.host.saveEmail(owner, { address, noticeVersion });
  assert.equal(f.host.wallet(owner).balance().limitMicro, 15);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 9);
  assert.equal(f.host.visitor(owner).tier, 'emailGiven');
  const ref = f.host.visitor(owner).visitorRef;
  const b = f.session('tiers-inherit');
  assert.equal(f.host.walletForSession(b).balance().limitMicro, 15);
  await admitCredits(f.ledger, f.request(b.id, 6), f.host.wallet(owner));
  f.host.saveEmail(owner, { address: 'changed@example.test', noticeVersion });
  f.host.deleteEmail(owner);
  assert.equal(f.host.visitor(owner).visitorRef, ref);
  assert.equal(f.host.wallet(owner).balance().limitMicro, 10);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 15);
  assert.equal((await admitCredits(f.ledger, f.request(b.id, 1), f.host.wallet(owner))).ok, false);
  f.settings('0.000020');
  assert.equal((await admitCredits(f.ledger, f.request(b.id, 5), f.host.wallet(owner))).ok, true);
});

test('AIT-135 an in-flight voice extension reads raised, decreased and zero policy in its ledger transaction', async t => {
  const f = fixture(t), s = f.session('tiers-voice'); f.settings('0.000010');
  const admitted = await admitCredits(f.ledger, f.request(s.id, 8, { lane: 'voice', maxVisitorMicro: 8 }), f.host.wallet(owner));
  const claim = f.ledger.claim(admitted.admission.attemptId); claim.consume();
  const wallet = f.host.wallet(owner);
  const extend = maxMicro => f.ledger.extendVoice(claim.attemptId, { maxMicro, maxVisitorMicro: maxMicro }, extra => {
    assert.equal(f.storage.db.isTransaction, true);
    return wallet.canAdmit(extra);
  });
  f.settings('0.000020'); extend(20);
  f.settings('0.000010'); assert.throws(() => extend(21), { code: 'not-admitted' });
  f.settings('0'); assert.throws(() => extend(22), { code: 'not-admitted' });
  assert.equal(f.ledger.get(claim.attemptId).max_micro, 20);
  f.ledger.settleVoice(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 25, visitorMicro: 25 } });
  assert.equal(wallet.balance().committedMicro, 25, 'actual liability is recorded even above the lowered allowance');
});

test('AIT-135 settings use exact decimals, ordered tiers and a revision; the audit is atomic with no replay duplicate', t => {
  const f = fixture(t), before = f.host.visitorCredits.settings();
  assert.deepEqual(before.allowancesMicro, { anonymous: 10_000_000, emailGiven: 10_000_000, emailConfirmed: 10_000_000 });
  assert.equal(before.schemaVersion, 1); assert.equal(before.confirmationEnabled, false);
  for (const anonymous of ['-1', '1.0000001', '1e1', '1000.000001', '9007199254740992', 1]) {
    assert.throws(() => f.settings(anonymous), TypeError);
  }
  assert.throws(() => f.settings('2', '1', '3'), TypeError);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: before.revision, allowancesUsd: { anonymous: '1', emailGiven: '1', emailConfirmed: '1', surprise: '1' } }), TypeError);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: before.revision, unknown: true }), TypeError);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: before.revision, confirmationEnabled: true }), TypeError);
  const next = f.settings('0.100001', '15', '20');
  assert.equal(next.allowancesMicro.anonymous, 100001);
  const audit = f.host.visitorCredits.audit();
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: before.revision, allowancesUsd: { anonymous: '1', emailGiven: '1', emailConfirmed: '1' } }, { actor: 'ops-cli:fixture' }), error => error.status === 409);
  assert.deepEqual(f.host.visitorCredits.audit(), audit);
  f.storage.db.exec("CREATE TRIGGER reject_credit_audit BEFORE INSERT ON visitor_credit_audit BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.throws(() => f.settings('1'));
  assert.deepEqual(f.host.visitorCredits.settings(), next);
  assert.throws(() => f.storage.db.exec("UPDATE visitor_credit_audit SET actor='forged'"), /append only/u);
});

test('AIT-135 migration seeds $10/$10/$10 and preserves owner hashes, settled spend and outstanding attempts', async t => {
  const db = await temporaryDb();
  const old = new SQLiteStorage(db), ledger = new SQLiteBudgetLedger(old), s = old.create({ id: 'pre-tiers', ownerToken: owner });
  const admitted = ledger.admit({ sessionId: s.id, lane: 'reaction', maxMicro: 9, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(admitted.attemptId); claim.consume();
  ledger.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', chargedMicro: 7, usage: { inputTokens: 0, outputTokens: 0 } });
  const hold = ledger.admit({ sessionId: s.id, lane: 'voice', maxMicro: 11, maxVisitorMicro: 11, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  old.db.exec(`CREATE TABLE owner_wallet_reservations (attempt_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, max_micro INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0)`);
  old.db.prepare('INSERT INTO owner_wallet_reservations VALUES (?,?,?,?,0)').run('unledgered', ownerHash, 'legacy', 3);
  const rows = old.db.prepare('SELECT * FROM budget_attempts ORDER BY attempt_id').all(); old.close();
  const f = fixture(t, { storage: new SQLiteStorage(db) });
  assert.equal(f.storage.get(s.id).ownerHash, s.ownerHash);
  assert.deepEqual(f.storage.db.prepare('SELECT * FROM budget_attempts ORDER BY attempt_id').all(), rows);
  assert.equal(f.ledger.get(hold.attemptId).state, 'admitted');
  assert.equal(f.host.wallet(owner).balance().committedMicro, 21);
  assert.equal(f.host.wallet(owner).balance().limitMicro, 10_000_000);
  const ref = f.host.visitor(owner).visitorRef;
  assert.equal(createDemoHost({ storage: f.storage }).visitor(owner).visitorRef, ref);
  assert.equal(f.host.visitorCredits.audit().filter(e => e.source === 'migration').length, 1);
});

test('AIT-135 bounded retention expires addresses, pending tokens and audit independently, and is idempotent', async t => {
  const f = fixture(t, { demo: true }); f.session('tiers-retention');
  f.settings('10', '15', '20'); f.host.saveEmail(owner, { address, noticeVersion });
  await f.host.identity.requestVerification({ sessionId: 'tiers-retention', ownerToken: owner, address, revision: 2, expiresAt: 1_801_000 });
  f.at(1_000 + 24 * 60 * 60_000); f.host.retainVisitors({ limit: 2 });
  assert.equal(f.host.visitor(owner).tier, 'emailGiven');
  assert.equal(f.host.outbox({ sessionId: 'tiers-retention', ownerToken: owner }).length, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
  f.at(1_000 + 90 * 24 * 60 * 60_000); f.host.retainVisitors({ limit: 2 });
  assert.equal(f.host.visitor(owner).address, null); assert.equal(f.host.visitor(owner).tier, 'anonymous');
  f.at(1_000 + 180 * 24 * 60 * 60_000);
  for (let i = 0; i < 4; i++) f.host.retainVisitors({ limit: 2 });
  assert.deepEqual(f.host.visitorCredits.audit(), []);
  assert.deepEqual(f.host.retainVisitors({ limit: 2 }), { addresses: 0, pending: 0, audit: 0, projections: 0 });
});

test('AIT-135 visitor email API is owner-bound, sends no mail without delivery and survives new conversations', async t => {
  const f = fixture(t); f.settings('10', '15', '20');
  const runtime = createPluginRuntime({ storage: f.storage, consent: mockConsent, budget: f.ledger });
  const handlers = createHandlers({ storage: f.storage, pluginRuntime: runtime, consent: mockConsent, host: f.host });
  t.after(() => handlers.close());
  const call = (path, payload, method = payload === undefined ? 'GET' : 'POST', token = owner) => handlers.handle(new Request(`http://local${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { 'x-aithema-session-token': token } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
  assert.equal((await call('/api/visitor/email', { address, noticeVersion }, 'POST', null)).status, 401);
  assert.equal((await call('/api/visitor/email', { address, noticeVersion, verified: true })).status, 400);
  const saved = await call('/api/visitor/email', { address, noticeVersion }); assert.equal(saved.status, 200);
  assert.equal((await saved.json()).visitor.tier, 'emailGiven');
  const s = await (await call('/api/sessions', {})).json();
  assert.equal((await (await call(`/api/sessions/${s.id}/credits`)).json()).limitSlot, null);
  assert.equal(f.storage.ownerCreditState(owner), null);
  assert.equal((await (await call(`/api/sessions/${s.id}/credits`)).json()).balance.owner.limitMicro, 15_000_000);
  assert.equal((await call('/api/visitor/email', {}, 'DELETE')).status, 200);
  assert.equal(f.host.visitor(owner).tier, 'anonymous');
  f.host.saveEmail(owner, { address, noticeVersion });
  assert.equal((await call('/api/visitor/erase', {})).status, 200);
  assert.equal(f.storage.get(s.id).tombstone !== null, true);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities WHERE owner_hash=?').get(ownerHash).n, 0);
});

test('AIT-135 visitor erasure removes evidence and all address projections but retains wallet accounting', async t => {
  const f = fixture(t), a = f.session('tiers-erase-a'), b = f.session('tiers-erase-b');
  f.host.saveEmail(owner, { address, noticeVersion });
  const admitted = await admitCredits(f.ledger, f.request(a.id, 10), f.host.wallet(owner));
  f.storage.append(a.id, 'identity.state', { address, status: 'verified' });
  f.storage.append(b.id, 'verification.requested', { address, revision: 1 });
  f.storage.erase(a.id, { ownerToken: owner });
  assert.equal(f.host.visitor(owner).address, address, 'conversation deletion does not erase the visitor profile');
  f.host.eraseVisitor(owner);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities WHERE owner_hash=?').get(ownerHash).n, 0);
  for (const id of [a.id, b.id]) assert.equal(JSON.stringify(f.storage.read(id)).includes(address), false);
  assert.equal(f.ledger.get(admitted.admission.attemptId).owner_hash, ownerHash);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 10);
});

test('AIT-135 confirmed visitor evidence promotes the existing wallet, survives new conversations, and an address change erases old projections', async t => {
  const f = fixture(t, { demo: true, verificationRequired: true }); f.settings('10', '15', '20');
  f.host.visitorCredits.saveSettings({ baseRevision: f.host.visitorCredits.settings().revision, confirmationEnabled: true });
  const runtime = createPluginRuntime({ storage: f.storage, consent: mockConsent, budget: f.ledger });
  const handlers = createHandlers({ storage: f.storage, pluginRuntime: runtime, consent: mockConsent, host: f.host });
  t.after(() => handlers.close());
  const call = (path, payload) => handlers.handle(new Request(`http://local${path}`, { method: payload === undefined ? 'GET' : 'POST',
    headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }));
  const a = await (await call('/api/sessions', {})).json(), base = `/api/sessions/${a.id}/identity`;
  f.host.saveEmail(owner, { address, noticeVersion });
  const ref = f.host.visitor(owner).visitorRef;
  await admitCredits(f.ledger, f.request(a.id, 10_000_000), f.host.wallet(owner));
  assert.equal((await call(`${base}/request`, { address })).status, 200);
  const message = f.host.outbox({ sessionId: a.id, ownerToken: owner }).at(-1);
  const confirmed = await call(`${base}/confirm`, { token: message.token });
  assert.equal((await confirmed.json()).identity.status, 'verified');
  assert.equal(f.host.wallet(owner).balance().limitMicro, 20_000_000);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 10_000_000);
  const b = await (await call('/api/sessions', {})).json(); assert.equal(b.identity.status, 'verified');
  assert.equal(f.host.visitor(owner).visitorRef, ref);
  f.at(61_000); await call(`${base}/change`, { address: 'new@example.test' });
  assert.equal(f.host.visitor(owner).tier, 'emailGiven');
  assert.equal(f.host.wallet(owner).balance().limitMicro, 15_000_000);
  assert.equal(f.host.wallet(owner).balance().committedMicro, 10_000_000);
  for (const id of [a.id, b.id]) assert.equal(JSON.stringify(f.storage.read(id)).includes(address), false, 'old address projections must be erased');
  assert.equal(f.host.visitorCredits.audit().some(e => JSON.stringify(e).includes(address)), false);
});

test('AIT-135 migration does not restart the inactivity retention window of a legacy confirmed address', async t => {
  const db = await temporaryDb(), old = new SQLiteStorage(db), s = old.create({ id: 'legacy-address', ownerToken: owner });
  old.transitionHost(s.id, () => ({ state: { identity: { ...createIdentity(), status: 'verified', address, verificationRevision: 1, lastNow: 1000 } }, events: [] }));
  old.db.exec('DROP TRIGGER events_no_update');
  const event = JSON.parse(old.db.prepare('SELECT event FROM events WHERE session_id=?').get(s.id).event);
  event.at = new Date(1000).toISOString();
  old.db.prepare('UPDATE events SET event=? WHERE session_id=?').run(JSON.stringify(event), s.id); old.close();
  const f = fixture(t, { storage: new SQLiteStorage(db), now: () => 1000 + 91 * 24 * 60 * 60_000 });
  f.host.retainVisitors(); assert.equal(f.host.visitor(owner).address, null);
});

test('AIT-135 a resend receives its own pending retention window; pending-only addresses still expire', async t => {
  const f = fixture(t, { demo: true }), s = f.session('pending-only');
  const request = { sessionId: s.id, ownerToken: owner, address, revision: 1, expiresAt: 1_801_000 };
  await f.host.identity.requestVerification(request);
  f.at(1000 + 23 * 60 * 60_000);
  await f.host.identity.requestVerification({ ...request, revision: 2, expiresAt: 1000 + 23 * 60 * 60_000 + 1_800_000 });
  f.at(1000 + 24 * 60 * 60_000); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, address);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 1);
  f.at(1000 + 47 * 60 * 60_000); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, null);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
});

test('AIT-135 failed policy reads block fresh admission while actual settlements remain recordable', async t => {
  const f = fixture(t), s = f.session('policy-failure');
  const admitted = await admitCredits(f.ledger, f.request(s.id, 10), f.host.wallet(owner));
  const claim = f.ledger.claim(admitted.admission.attemptId); claim.consume();
  f.storage.db.exec('DROP TABLE visitor_credit_settings');
  await assert.rejects(admitCredits(f.ledger, f.request(s.id, 1), f.host.wallet(owner)));
  f.ledger.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', chargedMicro: 12, usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(f.ledger.get(claim.attemptId).settled_micro, 12);
});

test('AIT-135 background wallet work cannot renew the inactivity retention of a visitor address', async t => {
  const f = fixture(t), s = f.session('background-retention');
  f.host.saveEmail(owner, { address, noticeVersion });
  f.at(1000 + 89 * 24 * 60 * 60_000);
  await f.host.wallet(owner).admit(f.request(s.id, 1, { attemptId: 'background-work' }));
  f.at(1000 + 90 * 24 * 60 * 60_000); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, null);
});
