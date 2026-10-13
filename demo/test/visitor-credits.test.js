import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { admitCredits, createIdentity, reduceIdentity, createHandover, reduceHandover } from '@inspr/aithema-core';
import { createDemoHost } from '../host-ports.js';
import { mockConsent, temporaryDb } from '../../test/helpers.js';
import { lowCreditThreshold } from '../../packages/server/src/host-handlers.js';

const owner = 'tier-owner', address = 'visitor@example.test', noticeVersion = 'ait-135-v1';
const ownerHash = createHash('sha256').update(owner).digest('hex');
function fixture(t, options = {}) {
  const storage = options.storage ?? new SQLiteStorage();
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 1_000_000_000, visitorCapMicro: 1_000_000_000 });
  let time = 1_000;
  const host = createDemoHost({ storage, demo: false, ownerGuard: false, now: () => time, privacyDocumentConfigured: () => true, ...options });
  t.after(() => storage.close());
  const session = id => storage.create({ id, ownerToken: owner });
  const settings = (anonymous, emailGiven = anonymous, emailConfirmed = emailGiven) => host.visitorCredits.saveSettings({
    baseRevision: host.visitorCredits.settings().revision, allowancesUsd: { anonymous, emailGiven, emailConfirmed },
  }, { actor: 'ops-cli:fixture', source: 'ops-cli' });
  const request = (sessionId, maxMicro, extra = {}) => ({ sessionId, lane: 'reaction', maxMicro,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
  return { storage, ledger, host, session, settings, request, at: value => { time = value; } };
}

const DAY = 24 * 60 * 60_000;
test('AIT-164: server thresholds use 10% of the tier and a five-minute voice floor', () => {
  for (const [tier, expected] of [[10_000_000, 1_000_000], [15_000_000, 1_500_000], [20_000_000, 2_000_000], [3_000_000, 500_000]]) {
    assert.equal(lowCreditThreshold(tier, 100_000), expected);
  }
  assert.equal(lowCreditThreshold(3_000_000, 200_000), 1_000_000, 'changed server rate changes the voice floor');
  assert.equal(lowCreditThreshold(3_000_000, 0), 300_000, 'voice off has no five-minute / 50-Credit floor');
  assert.equal(lowCreditThreshold(1_234_567, 0), 130_000, 'round up to a whole Credit');
});
test('AIT-164: a fifth-turn ask is shared by the visitor for a rolling 24h, including after restart', async t => {
  const db = await temporaryDb(), first = new SQLiteStorage(db);
  let time = 1_000; t.after(() => { if (first.db.isOpen) first.close(); });
  const hostBefore = createDemoHost({ storage: first, demo: false, now: () => time, ownerGuard: false });
  const f = { storage: first, host: hostBefore, at: value => { time = value; } };
  assert.equal(f.host.claimEmailAsk(owner), true);
  assert.equal(f.host.claimEmailAsk(owner), false);
  f.at(1_000 + DAY - 1); assert.equal(f.host.claimEmailAsk(owner), false);
  f.at(1_000 + DAY); assert.equal(f.host.claimEmailAsk(owner), true);
  const other = 'separate-visitor'; assert.equal(f.host.claimEmailAsk(other), true);
  f.storage.close();
  const reopened = new SQLiteStorage(db); t.after(() => reopened.close());
  const host = createDemoHost({ storage: reopened, demo: false, now: () => 1_000 + DAY, ownerGuard: false });
  assert.equal(host.claimEmailAsk(owner), false);
  host.eraseVisitor(owner); assert.equal(host.emailAskAfter(owner), 0);
});
test('AIT-164: low claims are atomic, visitor-wide, persistent and cascade erased', async t => {
  const db = await temporaryDb(), storage = new SQLiteStorage(db);
  let time = 1_000; t.after(() => { if (storage.db.isOpen) storage.close(); });
  const options = { demo: false, now: () => time, ownerGuard: false };
  const host = createDemoHost({ storage, ...options });
  assert.deepEqual(host.lowEmailAsk(owner), { after: 0, armed: true });
  assert.throws(() => storage.transaction(() => {
    assert.equal(host.claimLowEmailAsk(owner), true);
    throw new Error('rollback gate and claim');
  }), /rollback gate and claim/u);
  assert.equal(host.claimLowEmailAsk(owner), true, 'rolled-back claim is not consumed');
  // The repository has one leased SQLite writer. Separate host clients/tabs
  // share it; opening a second SQLiteStorage is deliberately refused.
  const otherHost = createDemoHost({ storage, ...options });
  assert.equal(otherHost.claimLowEmailAsk(owner), false, 'another client cannot claim the same low episode');
  assert.equal(host.claimLowEmailAsk('separate-visitor'), true);
  time += DAY;
  assert.equal(host.claimLowEmailAsk(owner), false, '24 hours alone does not re-arm');
  storage.close();
  const reopened = new SQLiteStorage(db); t.after(() => reopened.close());
  const restarted = createDemoHost({ storage: reopened, ...options });
  assert.deepEqual(restarted.lowEmailAsk(owner), { after: 1_000 + DAY, armed: false });
  assert.equal(restarted.claimLowEmailAsk(owner), false);
  restarted.rearmLowEmailAsk(owner);
  assert.equal(restarted.claimLowEmailAsk(owner), true);
  restarted.rearmLowEmailAsk(owner);
  time += DAY - 1; assert.equal(restarted.claimLowEmailAsk(owner), false, 're-arm never shortens cooldown');
  time++; assert.equal(restarted.claimLowEmailAsk(owner), true);
  restarted.eraseVisitor(owner);
  assert.deepEqual(restarted.lowEmailAsk(owner), { after: 0, armed: true });
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM visitor_low_email_asks WHERE visitor_ref NOT IN (SELECT visitor_ref FROM visitor_identities)').get().n, 0);
});
test('AIT-164: low asks need a visitor-wide high-to-low crossing and a full day', async t => {
  const f = fixture(t); f.settings('10', '15', '20');
  const a = f.session('low-a'), b = f.session('low-b'), { call } = api(t, f);
  for (const s of [a, b]) {
    f.storage.append(s.id, 'turn.final', { id: `${s.id}-u`, role: 'user', content: 'A requirement.' });
    f.storage.append(s.id, 'turn.final', { id: `${s.id}-a`, role: 'assistant', content: 'A question.' });
  }
  const show = async id => (await (await call(`/api/sessions/${id}/email-ask`, { action: 'show', why: 'low' })).json()).accepted;
  const rearm = async id => (await (await call(`/api/sessions/${id}/email-ask`, { action: 'rearm' })).json()).accepted;
  f.ledger.admit(f.request(a.id, 9_050_000));
  assert.equal(await show(a.id), true, 'low trigger needs no fifth turn');
  await call(`/api/sessions/${a.id}/email-ask`, { action: 'dismiss' });
  assert.equal(await show(b.id), false, 'a new conversation cannot repeat the low ask');
  assert.equal(await rearm(b.id), false, 'client cannot re-arm while the server balance is low');
  f.at(1_000 + DAY);
  assert.equal(await show(b.id), false, 'remaining low beyond 24 hours does not repeat');
  f.settings('20', '25', '30');
  const high = await (await call(`/api/sessions/${b.id}/credits`)).json();
  assert.equal(high.lowEmailAsk.armed, false, 'GET does not change the latch');
  assert.equal(await rearm(b.id), true);
  assert.equal(await show(b.id), false, 'balance must fall low again');
  f.settings('10', '15', '20');
  assert.equal(await show(a.id), true, 'the same conversation can claim a new low episode');
  await call(`/api/sessions/${a.id}/email-ask`, { action: 'dismiss' });
  f.settings('20', '25', '30'); assert.equal(await rearm(b.id), true);
  f.settings('10', '15', '20');
  f.at(1_000 + 2 * DAY - 1); assert.equal(await show(b.id), false);
  f.at(1_000 + 2 * DAY); assert.equal(await show(b.id), true);
});
test('AIT-164: server refuses fold before openedAt + 2 without changing the gate', async t => {
  const f = fixture(t); f.settings('10', '15');
  const s = f.session('fold-ask'), { call } = api(t, f);
  const reply = i => {
    f.storage.append(s.id, 'turn.final', { id: `fold-u${i}`, role: 'user', content: 'A requirement.' });
    f.storage.append(s.id, 'turn.final', { id: `fold-a${i}`, role: 'assistant', content: 'A question.' });
  };
  for (let i = 0; i < 5; i++) reply(i);
  const opened = await (await call(`/api/sessions/${s.id}/email-ask`, { action: 'show', why: 'turn5' })).json();
  assert.equal(opened.accepted, true); assert.equal(opened.emailAsk.openedAt, 5);
  for (const count of [5, 6]) {
    if (count === 6) reply(5);
    const folded = await (await call(`/api/sessions/${s.id}/email-ask`, { action: 'fold' })).json();
    assert.equal(folded.accepted, false, `refuse at ${count} turns`);
    assert.deepEqual(folded.emailAsk, opened.emailAsk, 'no revision or visibility change');
  }
  reply(6);
  const folded = await (await call(`/api/sessions/${s.id}/email-ask`, { action: 'fold' })).json();
  assert.equal(folded.accepted, true); assert.equal(folded.emailAsk.open, false); assert.equal(folded.emailAsk.folded, true);
});
test('AIT-164: owner-bound gate and low line survive reads without entering transcript or exports', async t => {
  const f = fixture(t, { visitorMicroPerMinute: () => 100_000 }); f.settings('10', '15', '20');
  const a = f.session('ask-a'), b = f.session('ask-b'), { call } = api(t, f);
  const reply = (id, i) => { f.storage.append(id, 'turn.final', { id: `u${i}`, role: 'user', content: 'A requirement.' }); f.storage.append(id, 'turn.final', { id: `a${i}`, role: 'assistant', content: 'A question.' }); };
  for (let i = 0; i < 4; i++) reply(a.id, i);
  const show = id => call(`/api/sessions/${id}/email-ask`, { action: 'show', why: 'turn5' });
  assert.equal((await (await show(a.id)).json()).accepted, false);
  reply(a.id, 4); assert.equal((await (await show(a.id)).json()).accepted, true);
  await call(`/api/sessions/${a.id}/email-ask`, { action: 'dismiss' });
  for (let i = 0; i < 5; i++) reply(b.id, i);
  assert.equal((await (await show(b.id)).json()).accepted, false, 'another conversation has the same day limit');
  const attempt = f.ledger.admit(f.request(b.id, 9_050_000)); f.ledger.claim(attempt.attemptId, { sideEffecting: false });
  const credits = await (await call(`/api/sessions/${b.id}/credits`)).json(); assert.equal(credits.lowAtMicro, 1_000_000);
  assert.equal((await (await call(`/api/sessions/${b.id}/email-ask`, { action: 'line' })).json()).accepted, true);
  const low = await (await call(`/api/sessions/${b.id}/email-ask`, { action: 'show', why: 'low' })).json(); assert.equal(low.accepted, true);
  assert.equal(low.emailAsk.lowLine.kind, 'give'); assert.equal(low.emailAsk.lowLine.deltaMicro, 5_000_000);
  await call(`/api/sessions/${b.id}/email-ask`, { action: 'dismiss' });
  assert.equal((await (await call(`/api/sessions/${b.id}/email-ask`, { action: 'show', why: 'low' })).json()).accepted, false);
  assert.equal(f.storage.get(b.id).transcript.length, 10);
  assert.equal(f.storage.read(b.id).some(e => /email-ask/u.test(e.type)), false);
  assert.equal((await call('/api/visitor/email', { address, noticeVersion }, 'PUT')).status, 200);
  assert.equal(f.storage.hostState(b.id).emailAsk.lowLine.resolved, true, 'giving an address retires its historical action');
  await call('/api/visitor/email', {}, 'DELETE');
  assert.equal(f.storage.hostState(b.id).emailAsk.lowLine.resolved, true, 'deletion never restores a historical offer');
  const foreign = await call('/api/sessions/foreign/email-ask', { action: 'show', why: 'low' }); assert.equal(foreign.status, 404);
});
test('AIT-164: C1 confirmation retires the pending-email line in the current host transaction', async t => {
  const f = fixture(t, { demo: true }); f.settings('10', '15', '20');
  f.host.visitorCredits.saveSettings({ baseRevision: f.host.visitorCredits.settings().revision, confirmationEnabled: true }, { actor: 'ops-cli:fixture', source: 'ops-cli' });
  const s = f.session('confirm-ask'), { call } = api(t, f);
  await call('/api/visitor/email', { address, noticeVersion }, 'PUT');
  f.storage.append(s.id, 'turn.final', { id: 'confirm-user', role: 'user', content: 'A requirement.' });
  f.storage.append(s.id, 'turn.final', { id: 'confirm-reply', role: 'assistant', content: 'A question.' });
  f.ledger.admit(f.request(s.id, 14_050_000));
  await call(`/api/sessions/${s.id}/email-ask`, { action: 'line' });
  assert.equal(f.storage.hostState(s.id).emailAsk.lowLine.kind, 'confirm');
  await call(`/api/sessions/${s.id}/identity/request`, { address });
  const mail = (await f.host.outbox({ sessionId: s.id, ownerToken: owner })).at(-1);
  const confirmed = await call(`/api/sessions/${s.id}/identity/confirm`, { token: mail.token });
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).identity.status, 'verified');
  assert.equal(f.storage.hostState(s.id).emailAsk.lowLine.resolved, true);
  await call('/api/visitor/email', {}, 'DELETE');
  assert.equal(f.storage.hostState(s.id).emailAsk.lowLine.resolved, true);
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function api(t, f) {
  const runtime = createPluginRuntime({ storage: f.storage, consent: mockConsent, budget: f.ledger });
  const handlers = createHandlers({ storage: f.storage, pluginRuntime: runtime, consent: mockConsent, host: f.host });
  t.after(() => handlers.close());
  const call = (path, payload, method = payload === undefined ? 'GET' : 'POST') => handlers.handle(new Request(`http://local${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
  return { handlers, call };
}
function verificationRequest(f, session, event = { type: 'request-verification', address }) {
  f.host.visitor(owner);
  const identity = f.host.identity.project({ session }, createIdentity());
  const result = reduceIdentity(identity, { ...event, now: f.host.now() });
  // The accepted transition owns identity changes; the queued effect only
  // issues a token for that already-persisted address revision.
  f.host.identity.persist({ session }, result.state);
  return { sessionId: session.id, ownerToken: owner, ...result.events.find(e => e.type === 'verification.requested').data };
}

for (const [name, options, allowed] of [
  ['non-demo without a document', { demo: false }, false],
  ['non-demo with a document', { demo: false, privacyDocumentConfigured: () => true }, true],
  ['demo without a document', { demo: true, privacyDocumentConfigured: () => { throw new Error('demo is exempt'); } }, true],
]) for (const status of ['verified', 'verification-pending']) {
  test(`AIT-135 fix round 2 migration: ${name}, legacy ${status}`, async t => {
    const db = await temporaryDb(), old = new SQLiteStorage(db);
    const s = old.create({ id: 'legacy-privacy', ownerToken: owner });
    const identity = { ...createIdentity(), status, address, verificationRevision: 1, lastNow: 1_000,
      ...(status === 'verification-pending' ? { expiresAt: 1_801_000 } : {}) };
    old.transitionHost(s.id, () => ({ state: { identity, handover: createHandover({ sessionId: s.id }) },
      events: [{ type: 'identity.state', data: identity }] }));
    const original = old.hostState(s.id), events = old.read(s.id);
    old.close();
    const storage = new SQLiteStorage(db); t.after(() => storage.close());
    const host = createDemoHost({ storage, now: () => 1_000, ...options });
    const row = storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
    assert.equal(host.visitor(owner).address, allowed ? address : null, 'construction must not copy a protected address');
    assert.equal(host.visitor(owner).tier, allowed && status === 'verified' ? 'emailGiven' : 'anonymous');
    if (!allowed) {
      assert.equal(JSON.stringify(row).includes(address), false);
      assert.equal(row.saved_at, null); assert.equal(row.confirmed_at, null); assert.equal(row.pending_at, null);
    }
    assert.deepEqual(storage.hostState(s.id), original, 'migration leaves the original legacy store untouched');
    assert.deepEqual(storage.read(s.id), events);
  });
}

for (const [name, options] of [
  ['non-demo without a document', { demo: false }],
  ['non-demo with a document', { demo: false, privacyDocumentConfigured: () => true }],
  ['demo without a document', { demo: true }],
]) test(`AIT-135 fix round 2 startup cleanup: ${name} deletes expired evidence without rewriting addresses`, async t => {
  const db = await temporaryDb(), old = new SQLiteStorage(db);
  let time = 1_000;
  const before = createDemoHost({ storage: old, demo: true, now: () => time });
  const expiredOwner = 'expired-owner', expiredAddress = 'expired@example.test';
  const expiredSession = old.create({ id: 'expired-saved', ownerToken: expiredOwner });
  before.saveEmail(expiredOwner, { address: expiredAddress, noticeVersion });
  const expiredIdentity = before.identity.project({ session: expiredSession }, createIdentity());
  old.transitionHost(expiredSession.id, () => ({ state: { identity: expiredIdentity },
    events: [{ type: 'identity.state', data: expiredIdentity }] }));
  time += 89 * DAY;
  const pendingOwner = 'pending-owner', pendingAddress = 'pending@example.test';
  for (const [token, email, saved] of [[owner, address, true], [pendingOwner, pendingAddress, false]]) {
    const session = old.create({ id: saved ? 'saved-pending' : 'pending-only', ownerToken: token });
    if (saved) before.saveEmail(token, { address: email, noticeVersion });
    const result = reduceIdentity(before.identity.project({ session }, createIdentity()),
      { type: 'request-verification', address: email, now: time });
    before.identity.persist({ session }, result.state);
    old.transitionHost(session.id, () => ({ state: { identity: result.state }, events: result.events }));
    await before.identity.requestVerification({ sessionId: session.id, ownerToken: token,
      ...result.events.find(e => e.type === 'verification.requested').data });
  }
  assert.equal(old.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 2);
  const saved = old.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
  old.close();
  const storage = new SQLiteStorage(db); t.after(() => storage.close());
  const host = createDemoHost({ storage, now: () => time + DAY, ...options });
  // Observe writes even when the address bytes happen to be unchanged. A
  // retained address column is allowed; putting it into a new JSON write is not.
  storage.db.exec(`CREATE TABLE address_writes (target TEXT NOT NULL);
    CREATE TRIGGER observe_address_column AFTER UPDATE OF address ON visitor_identities
      WHEN NEW.address IS NOT NULL BEGIN INSERT INTO address_writes VALUES ('address'); END;
    CREATE TRIGGER observe_identity_json AFTER UPDATE OF identity_json ON visitor_identities
      WHEN json_extract(NEW.identity_json,'$.address') IS NOT NULL
      BEGIN INSERT INTO address_writes VALUES ('identity_json'); END;
    CREATE TRIGGER observe_host_identity AFTER UPDATE ON host_states
      WHEN json_extract(NEW.record,'$.identity.address') IS NOT NULL
      BEGIN INSERT INTO address_writes VALUES ('host_states'); END;`);
  const result = host.retainVisitors();
  assert.equal(result.addresses, 1); assert.ok(result.pending >= 2);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities WHERE pending_at IS NOT NULL').get().n, 0);
  for (const token of [expiredOwner, pendingOwner]) {
    assert.equal(host.visitor(token).address, null); assert.equal(host.visitor(token).tier, 'anonymous');
  }
  for (const id of ['expired-saved', 'pending-only', 'saved-pending']) {
    assert.equal(storage.hostState(id).identity.address, null);
    assert.equal(JSON.stringify(storage.read(id)).includes(id === 'expired-saved' ? expiredAddress : id === 'pending-only' ? pendingAddress : address), false);
  }
  const retained = storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
  assert.equal(retained.address, address); assert.equal(retained.saved_at, saved.saved_at);
  assert.equal(retained.last_active_at, saved.last_active_at);
  assert.equal(host.visitor(owner).tier, 'emailGiven');
  const projected = host.identity.project({ session: storage.get('saved-pending') }, createIdentity());
  assert.equal(projected.address, address); assert.equal(projected.status, 'guest');
  assert.equal(projected.verificationRevision, saved.address_revision + 1);
  assert.equal(projected.expiresAt, null);
  assert.deepEqual(storage.db.prepare('SELECT * FROM address_writes').all(), [], 'cleanup must not persist an address');
  assert.deepEqual(host.retainVisitors(), { addresses: 0, pending: 0, audit: 0, projections: 0 });
});

for (const method of ['DELETE', 'PUT']) test(`AIT-135 fix round 1 ${method} during pending verification cannot restore the old address or issue its token`, { timeout: 5_000 }, async t => {
  const f = fixture(t, { demo: true, verificationRequired: true }), { call } = api(t, f);
  const s = await (await call('/api/sessions', {})).json();
  f.host.saveEmail(owner, { address, noticeVersion });
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  const send = f.host.identity.requestVerification.bind(f.host.identity);
  let staleError, attemptedToken;
  const createToken = f.host.visitorCredits.createToken.bind(f.host.visitorCredits);
  t.mock.method(f.host.visitorCredits, 'createToken', effect => { attemptedToken = effect.token; return createToken(effect); });
  t.mock.method(f.host.identity, 'requestVerification', async effect => {
    started.resolve(effect); await release.promise;
    try { return await send(effect); } catch (error) { staleError = error; throw error; }
  });
  const pending = call(`/api/sessions/${s.id}/identity/request`, { address });
  const effect = await started.promise;
  const replacement = method === 'PUT' ? 'replacement@example.test' : null;
  const changed = await call('/api/visitor/email', replacement ? { address: replacement, noticeVersion } : {}, method);
  assert.equal(changed.status, 200);
  const before = f.storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
  release.resolve(); const response = await pending;
  assert.equal(f.host.visitor(owner).address, replacement, 'the queued effect must not resurrect the old address');
  assert.deepEqual(f.storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash), before);
  assert.equal(staleError?.code, 'stale-verification');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'stale-verification');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
  assert.equal(f.host.visitorCredits.verifyToken({ ownerHash, address, revision: effect.revision, token: attemptedToken }), false);
  assert.deepEqual(f.host.outbox({ sessionId: s.id, ownerToken: owner }), []);
  assert.equal(JSON.stringify(f.storage.read(s.id)).includes(address), false);
});

test('AIT-135 fix round 1 a stale token effect rejects atomically without replacing the current revision token', t => {
  const f = fixture(t), s = f.session('stale-token-atomic');
  const visitor = f.host.saveEmail(owner, { address, noticeVersion });
  const effect = { ownerHash, sessionId: s.id, address, revision: visitor.addressRevision, expiresAt: 1_801_000 };
  f.host.visitorCredits.createToken({ ...effect, token: 'current-token' });
  const identity = f.storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
  const tokens = f.storage.db.prepare('SELECT * FROM visitor_confirmation_tokens').all();
  const transaction = f.storage.transaction.bind(f.storage);
  let transactions = 0;
  t.mock.method(f.storage, 'transaction', fn => { transactions++; return transaction(fn); });
  assert.throws(() => f.host.visitorCredits.createToken({ ...effect, revision: effect.revision - 1, token: 'stale-token' }), { code: 'stale-verification' });
  assert.equal(transactions, 1);
  assert.deepEqual(f.storage.db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash), identity);
  assert.deepEqual(f.storage.db.prepare('SELECT * FROM visitor_confirmation_tokens').all(), tokens);
  assert.equal(f.host.visitorCredits.verifyToken({ ...effect, token: 'current-token' }), true);
});

test('AIT-135 fix round 1 a queued token effect cannot recreate an erased visitor', t => {
  const f = fixture(t), s = f.session('stale-token-erasure');
  const visitor = f.host.saveEmail(owner, { address, noticeVersion });
  f.host.eraseVisitor(owner);
  assert.throws(() => f.host.visitorCredits.createToken({ ownerHash, sessionId: s.id, address,
    revision: visitor.addressRevision, expiresAt: 1_801_000, token: 'erased-token' }), { code: 'stale-verification' });
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities').get().n, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
});

for (const background of ['expiry', 'recovery']) test(`AIT-135 fix round 1 migration ignores automatic ${background} and identity clocks for address retention`, async t => {
  const db = await temporaryDb(), old = new SQLiteStorage(db), s = old.create({ id: `legacy-${background}`, ownerToken: owner });
  const backgroundAt = 1_000 + 89 * DAY;
  const identity = { ...createIdentity(), status: 'verified', address, verificationRevision: 1, lastNow: backgroundAt };
  old.transitionHost(s.id, () => ({ state: { identity, handover: createHandover({ sessionId: s.id }) }, events: [] }));
  old.postTurn(s.id, 'legacy-turn', Buffer.from('legacy-turn'), 'systems: API');
  if (background === 'expiry') old.expire(s.id, 'legacy-turn');
  else old.transitionHost(s.id, state => {
    const preparing = reduceHandover(state.handover, { type: 'request', revision: 'legacy-revision' }).state;
    const recovered = reduceHandover(preparing, { type: 'recover' });
    return { state: { ...state, handover: recovered.state }, events: recovered.events };
  });
  old.db.exec('DROP TRIGGER events_no_update');
  for (const row of old.db.prepare('SELECT seq,event FROM events WHERE session_id=?').all(s.id)) {
    const event = JSON.parse(row.event);
    event.at = new Date(['turn.withdrawn', 'handover.state'].includes(event.type) ? backgroundAt : 1_000).toISOString();
    old.db.prepare('UPDATE events SET event=? WHERE session_id=? AND seq=?').run(JSON.stringify(event), s.id, row.seq);
  }
  old.close();
  const f = fixture(t, { storage: new SQLiteStorage(db), now: () => 1_000 + 90 * DAY });
  assert.equal(f.storage.db.prepare('SELECT last_active_at FROM visitor_identities WHERE owner_hash=?').get(ownerHash).last_active_at, 1_000);
  assert.equal(f.host.retainVisitors().addresses, 1);
  assert.equal(f.host.visitor(owner).address, null);
});

test('AIT-135 fix round 1 startup policy removal preserves the original confirmed-address retention deadline', async t => {
  const f = fixture(t, { demo: true, verificationRequired: true }), { handlers, call } = api(t, f);
  const s = await (await call('/api/sessions', {})).json(), base = `/api/sessions/${s.id}/identity`;
  f.host.saveEmail(owner, { address, noticeVersion });
  await call(`${base}/request`, { address });
  const message = f.host.outbox({ sessionId: s.id, ownerToken: owner }).at(-1);
  await call(`${base}/confirm`, { token: message.token });
  assert.equal(f.host.visitor(owner).address, address);
  f.at(1_000 + 89 * DAY); f.host.policy.verificationRequired = false;
  await handlers.resume(); await handlers.idle();
  assert.equal(f.storage.hostState(s.id).identity.verificationRequired, false);
  assert.equal(f.storage.db.prepare('SELECT last_active_at FROM visitor_identities WHERE owner_hash=?').get(ownerHash).last_active_at, 1_000);
  f.at(1_000 + 90 * DAY);
  assert.equal(f.host.retainVisitors().addresses, 1);
  assert.equal(f.host.visitor(owner).address, null);
});

test('AIT-135 fix round 1 address commands and identity polling do not replace visitor activity', async t => {
  const f = fixture(t), { call } = api(t, f);
  const s = await (await call('/api/sessions', {})).json();
  f.host.saveEmail(owner, { address, noticeVersion });
  f.at(1_000 + 89 * DAY);
  await call('/api/visitor/email', { address, noticeVersion }, 'PUT');
  await call(`/api/sessions/${s.id}/identity`);
  await call(`/api/sessions/${s.id}/credits`);
  await call(`/api/sessions/${s.id}/identity/unlock`, {});
  assert.equal(f.storage.db.prepare('SELECT last_active_at FROM visitor_identities WHERE owner_hash=?').get(ownerHash).last_active_at, 1_000);
  f.at(1_000 + 90 * DAY); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, null);
});

test('AIT-135 fix round 1 an authenticated conversation visit renews address retention', async t => {
  const f = fixture(t), { call } = api(t, f);
  const s = await (await call('/api/sessions', {})).json();
  f.host.saveEmail(owner, { address, noticeVersion });
  f.at(1_000 + 89 * DAY);
  assert.equal((await call(`/api/sessions/${s.id}`)).status, 200);
  f.at(1_000 + 90 * DAY); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, address);
  f.at(1_000 + 179 * DAY); f.host.retainVisitors();
  assert.equal(f.host.visitor(owner).address, null);
});

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
  const f = fixture(t, { demo: true }), s = f.session('tiers-retention');
  f.settings('10', '15', '20'); f.host.saveEmail(owner, { address, noticeVersion });
  await f.host.identity.requestVerification(verificationRequest(f, s));
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
  const request = verificationRequest(f, s);
  await f.host.identity.requestVerification(request);
  f.at(1000 + 23 * 60 * 60_000);
  await f.host.identity.requestVerification(verificationRequest(f, s, { type: 'resend' }));
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


for (const delivery of [false, true]) test(`AIT-135 A2 API: tiers are server-computed, owner-bound and read-only (delivery ${delivery})`, async t => {
  const f = fixture(t, { demo: delivery }); f.settings('12', '18', '24');
  if (delivery) f.host.visitorCredits.saveSettings({ baseRevision: f.host.visitorCredits.settings().revision, confirmationEnabled: true });
  const s = f.session('a2-api'), { call, handlers } = api(t, f), path = `/api/sessions/${s.id}/credits`;
  const before = f.storage.read(s.id);
  const read = async () => (await (await call(path)).json()).tiers;
  const expected = current => ({ current, next: current === 'anonymous' ? 'emailGiven' : delivery ? 'emailConfirmed' : null,
    delta: current === 'anonymous' || delivery ? 6_000_000 : 0, canConfirm: delivery,
    allowancesMicro: { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 } });
  assert.deepEqual(await read(), expected('anonymous'));
  assert.deepEqual(f.storage.read(s.id), before, 'reading tiers appends no events');
  f.host.saveEmail(owner, { address, noticeVersion });
  assert.deepEqual(await read(), expected('emailGiven'));
  const foreign = await handlers.handle(new Request(`http://local${path}`, { headers: { 'x-aithema-session-token': 'foreign' } }));
  assert.equal(foreign.status, 404);
  assert.equal(JSON.stringify(await foreign.json()).includes('allowancesMicro'), false);
  f.host.deleteEmail(owner); f.settings('4', '9', '11');
  assert.equal((await read()).delta, 5_000_000, 'CLI changes reach the next response');
});

test('AIT-135 A2 API: the privacy gate removes the offered next tier without changing the wallet', async t => {
  const f = fixture(t, { privacyDocumentConfigured: () => false }); f.settings('12', '18', '24');
  const s = f.session('a2-gated'), { call } = api(t, f);
  const body = await (await call(`/api/sessions/${s.id}/credits`)).json();
  assert.deepEqual(body.tiers, { current: 'anonymous', next: null, delta: 0, canConfirm: false,
    allowancesMicro: { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 } });
  assert.equal(body.balance.owner.limitMicro, 12_000_000);
  const identity = await (await call(`/api/sessions/${s.id}/identity`)).json();
  assert.equal(identity.delivery, false); assert.equal(identity.privacyDocumentConfigured, false);
});

for (const ownerGuard of [false, true]) test(`AIT-135 A2 fix 1 API: full voice holds and confirmed spend have distinct wallet verdicts (owner guard ${ownerGuard})`, async t => {
  const f = fixture(t, { ownerGuard }); f.settings('12', '18', '24');
  const s = f.session('a2-held-voice'), { call, handlers } = api(t, f), path = `/api/sessions/${s.id}/credits`;
  const reserve = async maxMicro => {
    const admitted = await admitCredits(f.ledger, f.request(s.id, maxMicro, { lane: 'voice', maxVisitorMicro: maxMicro }), f.host.wallet(owner));
    assert.equal(admitted.ok, true);
    const claim = f.ledger.claim(admitted.admission.attemptId); claim.consume(); return claim;
  };
  const settle = (claim, micro) => f.ledger.settleVoice(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: micro, visitorMicro: micro, costEstimated: false } });
  const first = await reserve(12_000_000), events = f.storage.read(s.id);
  let body = await (await call(path)).json();
  assert.equal(body.balance.owner.availableMicro, 0);
  assert.equal(body.balance.owner.reservedMicro, 12_000_000); assert.equal(body.balance.owner.confirmedSpendMicro, 0);
  assert.equal(body.exhausted, false, 'a full hold is not a wallet exhaustion verdict');
  assert.deepEqual(f.storage.read(s.id), events, 'reading a hold never emits an exhaustion event');
  if (ownerGuard) assert.notEqual(body.limitSlot.endReason, 'host-limit');
  const foreign = await handlers.handle(new Request(`http://local${path}`, { headers: { 'x-aithema-session-token': 'foreign' } }));
  assert.equal(foreign.status, 404);
  settle(first, 4_000_000);
  body = await (await call(path)).json();
  assert.equal(body.exhausted, false); assert.equal(body.balance.owner.availableMicro, 8_000_000);
  assert.equal(body.balance.owner.reservedMicro, 0); assert.equal(body.balance.owner.confirmedSpendMicro, 4_000_000);
  const second = await reserve(8_000_000);
  assert.equal((await (await call(path)).json()).exhausted, false, 'confirmed spend plus a remaining full hold still permits the admitted segment');
  settle(second, 8_000_000);
  body = await (await call(path)).json();
  assert.equal(body.exhausted, true); assert.equal(body.balance.owner.confirmedSpendMicro, 12_000_000);
  f.settings('18', '24', '30');
  body = await (await call(path)).json();
  assert.equal(body.exhausted, false); assert.equal(body.balance.owner.availableMicro, 6_000_000);
});
