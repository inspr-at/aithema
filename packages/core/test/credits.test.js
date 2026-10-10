import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredits, reduceCredits, creditsView, CONVERSATION_LIMIT_MS,
  budgetCreditView, creditAdmission, requestCreditTopUp } from '../src/index.js';
import { SQLiteStorage } from '../../server/src/storage.js';
import { SQLiteBudgetLedger } from '../../server/src/budget.js';
import * as creditContracts from '../src/credits.js';
import { createMemoryLibrary } from '../src/library-port.js';
import { PluginError } from '../src/invocation.js';

const walletRequest = { sessionId: 'wallet-session', lane: 'reaction', maxMicro: 10, maxVisitorMicro: 0,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
const fingerprintChanges = { sessionId: 'other-session', lane: 'voice', maxMicro: 60, maxVisitorMicro: 5,
  requestSha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64) };

const ownerWallet = { balance: () => ({ limitMicro: 1000, committedMicro: 0 }),
  canAdmit: () => true, admit: async () => ({ ok: true }), release: async () => {} };
function walletFixture(limitMicro = 1000) {
  const reservations = new Map(), fingerprints = new Map();
  const committed = () => [...reservations.values()].reduce((sum, amount) => sum + amount, 0);
  const port = {
    balance: () => ({ limitMicro, committedMicro: committed() }),
    canAdmit: ({ maxMicro }) => maxMicro <= limitMicro - committed(),
    async admit({ attemptId, sessionId, lane, maxMicro, maxVisitorMicro = 0, requestSha256, bindingSha256 }) {
      const fingerprint = JSON.stringify([sessionId, lane, maxMicro, maxVisitorMicro, requestSha256, bindingSha256]);
      if (fingerprints.has(attemptId) && fingerprints.get(attemptId) !== fingerprint) return { ok: false, reason: 'attempt-conflict' };
      if (reservations.has(attemptId)) return { ok: true };
      if (maxMicro > limitMicro - committed()) return { ok: false };
      fingerprints.set(attemptId, fingerprint);
      reservations.set(attemptId, maxMicro); return { ok: true };
    },
    async release({ attemptId }) { reservations.delete(attemptId); }
  };
  return { port, reservations };
}
const viewOf = (ledger, sessionId) => budgetCreditView(ledger, sessionId, ownerWallet);
const previewOf = (ledger, sessionId, maxMicro, maxVisitorMicro = 0) =>
  creditAdmission(ledger, sessionId, maxMicro, maxVisitorMicro, ownerWallet);

const step = (s, type, data = {}, now = s.lastNow) => reduceCredits(s, { type, now, ...data });
const start = () => step(createCredits({ sessionId: 's1' }), 'start', {}, 100).state;
const admit = (ledger, sessionId, extra = {}) => ledger.admit({ sessionId, lane: 'reaction', maxMicro: 40,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
function withLedger(fn) {
  const storage = new SQLiteStorage(), session = storage.create();
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100, visitorCapMicro: 50 });
  try { fn(ledger, session, storage); } finally { storage.close(); }
}

test('credit view reserves admitted maxima without making a new charge', () => withLedger((ledger, session) => {
  admit(ledger, session.id);
  const view = viewOf(ledger, session.id);
  assert.deepEqual(view.session, { limitMicro: 100, committedMicro: 40, availableMicro: 60, overrunMicro: 0 });
  assert.deepEqual(view.voiceVisitor, { limitMicro: 50, committedMicro: 0, availableMicro: 50, overrunMicro: 0 });
  const preview = previewOf(ledger, session.id, 61);
  assert.equal(preview.ok, false); assert.equal(preview.reason, 'session');
  assert.equal(previewOf(ledger, session.id, 60).ok, true);
  assert.equal(ledger.used(session.id), 40);
}));

test('credit view follows actual settlement, preserves uncertain maxima and exposes overruns', () => withLedger((ledger, session) => {
  const a = admit(ledger, session.id), claim = ledger.claim(a.attemptId); claim.consume();
  ledger.settle(claim.claimId, { attemptId: a.attemptId, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 4 } },
    { inputMicro: 1, outputMicro: 2 });
  assert.equal(viewOf(ledger, session.id).session.committedMicro, 11);
  const b = admit(ledger, session.id), unknown = ledger.claim(b.attemptId); unknown.consume();
  ledger.settle(unknown.claimId, { attemptId: b.attemptId, outcome: 'uncertain' });
  assert.equal(viewOf(ledger, session.id).session.committedMicro, 51);
  const c = admit(ledger, session.id), overrun = ledger.claim(c.attemptId); overrun.consume();
  ledger.settle(overrun.claimId, { attemptId: c.attemptId, outcome: 'completed', usage: { inputTokens: 100, outputTokens: 0 } },
    { inputMicro: 1, outputMicro: 0 });
  assert.deepEqual(viewOf(ledger, session.id).session,
    { limitMicro: 100, committedMicro: 151, availableMicro: 0, overrunMicro: 51 });
  assert.equal(previewOf(ledger, session.id, 0).ok, false);
}));

test('voice visitor and upstream balances remain separate, including paused duration settlement', () => withLedger((ledger, session) => {
  const a = admit(ledger, session.id, { lane: 'voice', maxMicro: 80, maxVisitorMicro: 45 });
  assert.equal(viewOf(ledger, session.id).voiceVisitor.availableMicro, 5);
  assert.equal(previewOf(ledger, session.id, 0, 6).reason, 'voiceVisitor');
  const claim = ledger.claim(a.attemptId); claim.consume();
  ledger.settleVoice(claim.claimId, { attemptId: a.attemptId, outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 30, visitorSeconds: 30, upstreamMicro: 60, visitorMicro: 20 } });
  const view = viewOf(ledger, session.id);
  assert.equal(view.session.committedMicro, 60);
  assert.equal(view.voiceVisitor.committedMicro, 20);
  assert.equal(view.voiceVisitor.availableMicro, 30);
}));

test('recovery projection releases undispatched holds and retains dispatched uncertainty', () => withLedger((ledger, session) => {
  admit(ledger, session.id);
  const a = admit(ledger, session.id), claim = ledger.claim(a.attemptId); claim.consume();
  assert.equal(viewOf(ledger, session.id).session.committedMicro, 80);
  ledger.recover(session.id);
  assert.equal(viewOf(ledger, session.id).session.committedMicro, 40);
  assert.throws(() => ledger.claim(a.attemptId), { code: 'already-claimed' });
}));

test('preview defers to the host ledger admission decision', () => {
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0, canAdmit: () => false };
  assert.equal(previewOf(ledger, 's1', 1).reason, 'host-limit');
});

test('one-hour guard starts once and emits a graceful end request at the exact deadline', () => {
  let s = start();
  const endsAt = 100 + CONVERSATION_LIMIT_MS;
  assert.equal(s.endsAt, endsAt);
  s = step(s, 'start', {}, 1000).state;
  assert.equal(s.endsAt, endsAt);
  assert.equal(step(s, 'tick', {}, endsAt - 1).state.status, 'active');
  const ended = step(s, 'tick', {}, endsAt);
  assert.equal(ended.state.status, 'ending');
  assert.equal(ended.state.endReason, 'one-hour');
  assert.deepEqual(ended.events[1], { type: 'conversation.end-requested', data: {
    sessionId: 's1', reason: 'one-hour', preserveTranscript: true, settleOutstanding: true } });
  assert.equal(creditsView(ended.state, endsAt).canStartPaidWork, false);
  assert.equal(step(ended.state, 'closed').state.status, 'ended');
});

test('manual pause and resumption do not extend the one-hour wall-clock guard', () => {
  let s = start();
  s = step(s, 'pause', { paused: true }, 200).state;
  assert.equal(creditsView(s, 200).canStartPaidWork, false);
  s = step(s, 'pause', { paused: false }, 300).state;
  assert.equal(creditsView(s, 300).canStartPaidWork, true);
  s = step(s, 'pause', { paused: true }, 400).state;
  assert.equal(step(s, 'tick', {}, s.endsAt).state.endReason, 'one-hour');
});

test('credits emit only changed state, including one expiry instead of countdown events', () => withLedger((ledger, session) => {
  let s = step(createCredits({ sessionId: session.id }), 'start', {}, 100).state;
  for (const result of [step(s, 'tick', {}, 101), step(s, 'start', {}, 102),
    step(s, 'pause', { paused: false }, 103)]) assert.deepEqual(result.events, []);
  const balance = viewOf(ledger, session.id);
  const changed = step(s, 'balance', { balance }, 104);
  assert.equal(changed.events.length, 1);
  s = changed.state;
  assert.deepEqual(step(s, 'balance', { balance }, 105).events, []);
  const expired = step(s, 'tick', {}, s.endsAt);
  assert.deepEqual(expired.events.map(e => e.type), ['credits.limit-reached', 'conversation.end-requested', 'credits.state']);
  assert.deepEqual(step(expired.state, 'tick', {}, s.endsAt + 1).events, []);
}));

test('an authoritative limit ends once, waits for host closure and cannot be restarted by a balance/top-up', () => {
  let s = start();
  const limited = step(s, 'limit', { reason: 'session' }, 200);
  assert.equal(limited.events.filter(e => e.type === 'conversation.end-requested').length, 1);
  s = step(limited.state, 'limit', { reason: 'session' }, 201).state;
  assert.equal(step(s, 'tick', {}, 202).events.filter(e => e.type === 'conversation.end-requested').length, 0);
  s = step(s, 'closed', {}, 203).state;
  assert.equal(step(s, 'start', {}, 204).state.status, 'ended');
  assert.equal(step(s, 'start', {}, 204).state.endsAt, start().endsAt);
});

test('a full outstanding hold renders zero available without ending an admitted conversation', () => withLedger((ledger, session) => {
  admit(ledger, session.id, { maxMicro: 100 });
  let s = step(createCredits({ sessionId: session.id }), 'start').state;
  const balance = viewOf(ledger, session.id), update = step(s, 'balance', { balance });
  s = update.state;
  assert.equal(s.status, 'active');
  assert.equal(s.balance.session.availableMicro, 0);
  assert.equal(update.events.filter(e => e.type === 'conversation.end-requested').length, 0);
  balance.session.availableMicro = 999;
  assert.equal(s.balance.session.availableMicro, 0);
  assert.equal(step(s, 'limit', { reason: previewOf(ledger, session.id, 1).reason }).state.status, 'ending');
}));

test('limit shutdown leaves admitted claims to the existing ledger settlement', () => withLedger((ledger, session) => {
  const a = admit(ledger, session.id), claim = ledger.claim(a.attemptId); claim.consume();
  const s = step(createCredits({ sessionId: session.id }), 'limit', { reason: 'session' }).state;
  assert.equal(s.status, 'ending');
  assert.equal(ledger.get(a.attemptId).state, 'dispatched');
  ledger.settle(claim.claimId, { attemptId: a.attemptId, outcome: 'uncertain' });
  assert.equal(viewOf(ledger, session.id).session.committedMicro, 40);
}));

test('top-up uses only the optional host hook and sanitizes the response', async () => {
  assert.deepEqual(await requestCreditTopUp(null, { sessionId: 's1' }), { status: 'unavailable' });
  const calls = [], options = { requestId: 'host-request' };
  const port = { topUp: async (request, received) => { calls.push([request, received]); return { status: 'requested', hostPrivate: 'omitted' }; } };
  assert.deepEqual(await requestCreditTopUp(port, { sessionId: 's1' }, options), { status: 'requested' });
  assert.deepEqual(calls, [[{ sessionId: 's1' }, options]]);
  await assert.rejects(requestCreditTopUp({ topUp: async () => ({ status: 'funded' }) }, { sessionId: 's1' }));
  await assert.rejects(requestCreditTopUp({ topUp: async () => { throw new Error('host unavailable'); } }, { sessionId: 's1' }));
});

test('credit slot validates identity, counters, timestamps and host responses', () => {
  assert.throws(() => createCredits({ sessionId: '' }));
  assert.throws(() => createCredits({ sessionId: 's1', durationMs: 0 }));
  assert.throws(() => budgetCreditView({}, 's1', ownerWallet), /Credit ledger/);
  const invalid = { sessionCapMicro: -1, visitorCapMicro: 1, used: () => 0, visitorUsed: () => 0 };
  assert.throws(() => budgetCreditView(invalid, 's1', ownerWallet), /Invalid credit balance/);
  assert.throws(() => creditAdmission({}, 's1', -1, 0, ownerWallet), /Invalid credit request/);
  const s = start();
  for (const event of [{ type: 'tick', now: 99 }, { type: 'tick', now: NaN }, { type: 'unknown', now: 100 },
    { type: 'balance', now: 100, balance: {} }, { type: 'pause', now: 100, paused: 'yes' },
    { type: 'limit', now: 100, reason: 'private raw error' }, { type: 'closed', now: 100 }]) {
    assert.throws(() => reduceCredits(s, event));
  }
  assert.throws(() => creditsView(s, -1));
});

test('credit projections require an owner wallet and sanitize its owner-level balance', () => withLedger((ledger, session) => {
  assert.throws(() => budgetCreditView(ledger, session.id), /Owner wallet/);
  assert.throws(() => creditAdmission(ledger, session.id, 1), /Owner wallet/);
  const host = { ...ownerWallet, balance: () => ({ limitMicro: 90, committedMicro: 30, privateHostField: 'omit' }) };
  assert.deepEqual(budgetCreditView(ledger, session.id, host).owner,
    { limitMicro: 90, committedMicro: 30, availableMicro: 60, overrunMicro: 0 });
  const denied = { ...host, canAdmit: () => false };
  assert.equal(creditAdmission(ledger, session.id, 1, 0, denied).reason, 'host-limit');
  assert.throws(() => budgetCreditView(ledger, session.id, { ...host, balance: () => ({ limitMicro: -1, committedMicro: 0 }) }));
}));

test('authoritative owner denial prevents ledger admission even after a successful preview', async () => {
  let ledgerCalls = 0, walletCalls = 0;
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, admit: () => { ledgerCalls += 1; return { attemptId: 'attempt' }; } };
  const host = { ...ownerWallet, admit: async () => { walletCalls += 1; return { ok: false, privateReason: 'omit' }; } };
  const request = { sessionId: 's1', maxMicro: 1 };
  assert.equal(creditAdmission(ledger, 's1', 1, 0, host).ok, true);
  const denied = await creditContracts.admitCredits(ledger, request, host);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'host-limit');
  assert.equal(JSON.stringify(denied).includes('privateReason'), false);
  assert.equal(walletCalls, 1);
  assert.equal(ledgerCalls, 0);
  await assert.rejects(creditContracts.admitCredits(ledger, request), /Owner wallet/);
  await assert.rejects(creditContracts.admitCredits(ledger, request, { ...host, admit: async () => ({ ok: 'true' }) }));
  await assert.rejects(creditContracts.admitCredits(ledger, request, { ...host, admit: async () => { throw new Error('unavailable'); } }));
  assert.equal(ledgerCalls, 0);
});

test('owner admission finishes before atomic ledger admission and cannot mutate its request', async () => {
  const calls = [], request = { sessionId: 's1', maxMicro: 1, attemptId: 'attempt' };
  let release, walletSnapshot, mutationRefused = false;
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0, canAdmit: () => true,
    admit: received => {
      calls.push('ledger'); assert.deepEqual(received, request); assert.equal(received, walletSnapshot);
      return { attemptId: 'attempt', maxMicro: 1 };
    } };
  const host = { ...ownerWallet, admit: received => {
    calls.push('owner'); walletSnapshot = received;
    try { received.sessionId = 'mutated'; } catch (error) { mutationRefused = error instanceof TypeError; }
    return new Promise(resolve => { release = resolve; });
  } };
  const pending = creditContracts.admitCredits(ledger, request, host);
  await Promise.resolve();
  assert.deepEqual(calls, ['owner']);
  release({ ok: true });
  const accepted = await pending;
  assert.equal(mutationRefused, true);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.admission, { attemptId: 'attempt', maxMicro: 1 });
  assert.deepEqual(calls, ['owner', 'ledger']);
});

test('library new/reset keep the owner balance and the existing one-hour guard across conversations', async () => {
  const storage = new SQLiteStorage(), library = createMemoryLibrary().port;
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100, visitorCapMicro: 50 });
  const host = walletFixture(100).port;
  try {
    const original = await library.new(); storage.create({ id: original.id });
    const requestFor = (sessionId, maxMicro) => ({ sessionId, lane: 'reaction', maxMicro,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    assert.equal((await creditContracts.admitCredits(ledger, requestFor(original.id, 70), host)).ok, true);
    let credits = step(createCredits({ sessionId: original.id }), 'start', {}, 100).state;
    const deadline = credits.endsAt;
    const fresh = await library.new(); storage.create({ id: fresh.id });
    const reset = await library.reset(original.id); storage.create({ id: reset.id });
    for (const conversation of [fresh, reset]) {
      const balance = budgetCreditView(ledger, conversation.id, host);
      assert.equal(balance.session.availableMicro, 100);
      assert.equal(balance.owner.availableMicro, 30);
      assert.equal(creditAdmission(ledger, conversation.id, 31, 0, host).reason, 'host-limit');
      assert.equal((await creditContracts.admitCredits(ledger, requestFor(conversation.id, 31), host)).ok, false);
      credits = creditContracts.rebindCredits(credits, conversation.id);
      credits = step(credits, 'start', {}, 1000).state;
      assert.equal(credits.sessionId, conversation.id);
      assert.equal(credits.startedAt, 100);
      assert.equal(credits.endsAt, deadline);
    }
    assert.equal((await creditContracts.admitCredits(ledger, requestFor(reset.id, 30), host)).ok, true);
    assert.equal(budgetCreditView(ledger, fresh.id, host).owner.availableMicro, 0);
    assert.equal(step(credits, 'tick', {}, deadline).state.endReason, 'one-hour');
  } finally { storage.close(); }
});

test('conversation rebinding retains pause/end state and discards only the old conversation balance', () => withLedger((ledger, session) => {
  let s = step(start(), 'balance', { balance: { ...viewOf(ledger, session.id), sessionId: 's1' } }).state;
  s = step(s, 'pause', { paused: true }, 200).state;
  const rebound = creditContracts.rebindCredits(s, 's2');
  assert.equal(rebound.paused, true);
  assert.equal(rebound.balance, null);
  assert.equal(rebound.endsAt, s.endsAt);
  assert.notEqual(rebound, s);
  const ended = step(step(s, 'limit', { reason: 'host-limit' }).state, 'closed').state;
  const next = step(creditContracts.rebindCredits(ended, 's3'), 'start', {}, 300).state;
  assert.equal(next.status, 'ended');
  assert.equal(next.endsAt, s.endsAt);
  assert.throws(() => creditContracts.rebindCredits(s, ''));
}));

test('credit admission generates one attempt key shared by the wallet and SQLite ledger', async () => {
  const storage = new SQLiteStorage(), session = storage.create();
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100 });
  const fixture = walletFixture();
  let walletSnapshot;
  const host = { ...fixture.port, admit: request => { walletSnapshot = request; return fixture.port.admit(request); } };
  const request = { sessionId: session.id, lane: 'reaction', maxMicro: 40,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
  try {
    const result = await creditContracts.admitCredits(ledger, request, host);
    assert.equal(result.ok, true);
    assert.match(walletSnapshot.attemptId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    assert.equal(result.admission.attemptId, walletSnapshot.attemptId);
    assert.equal(ledger.get(walletSnapshot.attemptId).max_micro, 40);
    assert.equal(fixture.reservations.get(walletSnapshot.attemptId), 40);
    assert.equal(request.attemptId, undefined);
  } finally { storage.close(); }
});

for (const [lane, maxMicro, maxVisitorMicro, reason] of [
  ['reaction', 60, 0, 'session'], ['voice', 10, 30, 'voiceVisitor']
]) {
  test(`concurrent owner-approved admissions release only the ${reason} refusal`, async () => {
    const storage = new SQLiteStorage(), session = storage.create();
    const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100, visitorCapMicro: 50 });
    const fixture = walletFixture(200), approved = [], released = [];
    await fixture.port.admit({ attemptId: 'unrelated', maxMicro: 10 });
    const before = fixture.port.balance().committedMicro;
    let resume;
    const barrier = new Promise(resolve => { resume = resolve; });
    const host = { ...fixture.port, async admit(request) {
      const result = await fixture.port.admit(request);
      approved.push({ request, result }); await barrier; return result;
    }, async release(request) { released.push(request); await fixture.port.release(request); } };
    const request = { sessionId: session.id, lane, maxMicro, maxVisitorMicro,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
    try {
      const pending = Promise.allSettled([
        creditContracts.admitCredits(ledger, { ...request, attemptId: 'race-first' }, host),
        creditContracts.admitCredits(ledger, { ...request, attemptId: 'race-second' }, host)
      ]);
      await Promise.resolve();
      const approvalsBeforeLedger = approved.length;
      const ownerApproved = approved.every(({ result }) => result.ok === true);
      const ledgerBefore = ledger.used(session.id);
      const ownerReservedBeforeLedger = fixture.port.balance().committedMicro;
      resume();
      const outcomes = await pending;
      assert.equal(approvalsBeforeLedger, 2);
      assert.equal(ownerApproved, true);
      assert.equal(ledgerBefore, 0);
      assert.equal(ownerReservedBeforeLedger, before + 2 * maxMicro);
      assert.ok(outcomes.every(result => result.status === 'fulfilled'));
      const accepted = outcomes.map(result => result.value).find(result => result.ok);
      const refused = outcomes.map(result => result.value).find(result => !result.ok);
      assert.ok(accepted); assert.ok(refused);
      assert.deepEqual(refused, { ok: false, reason, attemptId: approved[1].request.attemptId });
      assert.notEqual(refused.attemptId, accepted.admission.attemptId);
      assert.deepEqual(released, [{ attemptId: refused.attemptId }]);
      assert.equal(fixture.port.balance().committedMicro, before + maxMicro);
      assert.equal(fixture.reservations.get('unrelated'), 10);
      assert.equal(fixture.reservations.has(accepted.admission.attemptId), true);
      assert.equal(fixture.reservations.has(refused.attemptId), false);
      assert.equal(ledger.get(refused.attemptId), undefined);
      assert.equal(ledger.used(session.id), maxMicro);
    } finally { storage.close(); }
  });
}

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'async' : 'sync'} ledger refusal awaits owner release and sanitizes the reason`, async () => {
    const calls = [], request = { sessionId: 's1', maxMicro: 1, attemptId: 'refused' };
    let completeRelease;
    const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
      canAdmit: () => true, admit() {
        calls.push('ledger');
        if (asynchronous) return Promise.reject(new PluginError('not-admitted', 'private ledger diagnostic'));
        throw new PluginError('not-admitted', 'private ledger diagnostic');
      } };
    const host = { ...ownerWallet, release(received) {
      assert.deepEqual(received, { attemptId: 'refused' }); calls.push('release');
      return new Promise(resolve => { completeRelease = resolve; });
    } };
    const pending = creditContracts.admitCredits(ledger, request, host);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, ['ledger', 'release']);
    let returned = false;
    outcome.then(() => { returned = true; });
    await Promise.resolve(); assert.equal(returned, false);
    completeRelease();
    assert.deepEqual(await outcome, { value: { ok: false, reason: 'host-limit', attemptId: 'refused' } });
  });
}

test('credit admission requires owner release before making either reservation', async () => {
  let walletCalls = 0, ledgerCalls = 0;
  const host = { ...ownerWallet, release: undefined, admit: async () => { walletCalls += 1; return { ok: true }; } };
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, admit: request => { ledgerCalls += 1; return { attemptId: request.attemptId }; } };
  await assert.rejects(creditContracts.admitCredits(ledger, { sessionId: 's1', maxMicro: 1 }, host), /Owner wallet/);
  assert.equal(walletCalls, 0); assert.equal(ledgerCalls, 0);
});

test('owner release failure propagates without reporting a completed denial', async () => {
  const fixture = walletFixture(), failure = new Error('release unavailable');
  let attemptId;
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, admit: () => { throw new PluginError('not-admitted', 'ledger refused'); } };
  const host = { ...fixture.port, release: async request => { attemptId = request.attemptId; throw failure; } };
  await assert.rejects(creditContracts.admitCredits(ledger, walletRequest, host), error => {
    assert.equal(error, failure); assert.equal(error.attemptId, attemptId);
    assert.match(error.attemptId, /^[a-f0-9-]{36}$/u); return true;
  });
  assert.equal(fixture.reservations.get(attemptId), walletRequest.maxMicro);
});

test('a repeated ledger attempt cannot release the already admitted owner reservation', async () => {
  const storage = new SQLiteStorage(), session = storage.create();
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100 });
  const fixture = walletFixture();
  let releases = 0;
  const host = { ...fixture.port, release: request => { releases += 1; return fixture.port.release(request); } };
  const request = { attemptId: 'existing', sessionId: session.id, lane: 'reaction', maxMicro: 40,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
  try {
    assert.equal((await creditContracts.admitCredits(ledger, request, host)).ok, true);
    await assert.rejects(creditContracts.admitCredits(ledger, request, host), { code: 'already-claimed' });
    assert.equal(releases, 0);
    assert.equal(fixture.port.balance().committedMicro, 40);
    assert.equal(ledger.used(session.id), 40);
  } finally { storage.close(); }
});

test('owner wallet kit checks concurrent and repeated admission plus idempotent release', async () => {
  const fixture = walletFixture();
  assert.deepEqual(await creditContracts.ownerWalletConformance(fixture.port, walletRequest),
    { ok: true, failures: [] });
  assert.equal(fixture.port.balance().committedMicro, 0);
});

test('owner wallet kit rejects a host reserving twice for the same attempt', async () => {
  let committedMicro = 0;
  const host = { ...ownerWallet, balance: () => ({ limitMicro: 1000, committedMicro }),
    admit: async ({ maxMicro }) => { committedMicro += maxMicro; return { ok: true }; },
    release: async () => { committedMicro = 0; } };
  const result = await creditContracts.ownerWalletConformance(host, walletRequest);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('owner admission idempotency'));
});

test('owner wallet kit requires release and detects an unreleased reservation', async () => {
  const fixture = walletFixture(), request = walletRequest;
  const missing = await creditContracts.ownerWalletConformance({ ...fixture.port, release: undefined }, request);
  assert.deepEqual(missing, { ok: false, failures: ['owner wallet operations missing'] });
  const broken = await creditContracts.ownerWalletConformance({ ...fixture.port, release: async () => {} }, request);
  assert.equal(broken.ok, false);
  assert.ok(broken.failures.includes('owner reservation release'));
});

for (const [field, value] of Object.entries(fingerprintChanges)) {
  test(`owner wallet rejects attempt reuse with a different ${field} without changing its hold`, async () => {
    const fixture = walletFixture(), request = { ...walletRequest, attemptId: `conflict-${field}` };
    assert.deepEqual(await fixture.port.admit(request), { ok: true });
    assert.deepEqual(await fixture.port.admit({ ...request, [field]: value }), { ok: false, reason: 'attempt-conflict' });
    assert.equal(fixture.reservations.get(request.attemptId), request.maxMicro);
    assert.deepEqual(await fixture.port.admit({ ...request }), { ok: true });
    assert.equal(fixture.port.balance().committedMicro, request.maxMicro);
  });

  test(`credit admission preserves a wallet conflict for a different ${field}`, async () => {
    const storage = new SQLiteStorage(), session = storage.create(), other = storage.create();
    const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100, visitorCapMicro: 50 });
    const fixture = walletFixture(), request = { ...walletRequest, sessionId: session.id, attemptId: `conflict-${field}` };
    let ledgerCalls = 0, releases = 0;
    const trackedLedger = Object.assign(Object.create(ledger), { admit(received) { ledgerCalls += 1; return ledger.admit(received); } });
    const host = { ...fixture.port, release(received) { releases += 1; return fixture.port.release(received); } };
    try {
      assert.equal((await creditContracts.admitCredits(trackedLedger, request, host)).ok, true);
      const changed = { ...request, [field]: field === 'sessionId' ? other.id : value };
      assert.deepEqual(await creditContracts.admitCredits(trackedLedger, changed, host),
        { ok: false, reason: 'attempt-conflict', attemptId: request.attemptId });
      assert.equal(ledgerCalls, 1); assert.equal(releases, 0);
      assert.equal(fixture.reservations.get(request.attemptId), request.maxMicro);
      assert.equal(ledger.used(session.id), request.maxMicro);
      assert.equal(ledger.used(other.id), 0);
    } finally { storage.close(); }
  });
}

test('a concurrent duplicate cannot proceed after the first attempt ledger refusal releases its hold', async () => {
  const fixture = walletFixture(), request = { ...walletRequest, attemptId: 'refusal-first' };
  let refuseFirst, allowDuplicate, started, walletCalls = 0, ledgerCalls = 0, releases = 0;
  const ledgerStarted = new Promise(resolve => { started = resolve; });
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, admit(received) {
      ledgerCalls += 1;
      if (ledgerCalls === 1) { started(); return new Promise((_, reject) => { refuseFirst = reject; }); }
      return new Promise(resolve => { allowDuplicate = () => resolve({ attemptId: received.attemptId }); });
    } };
  const host = { ...fixture.port, admit(received) { walletCalls += 1; return fixture.port.admit(received); },
    release(received) { releases += 1; return fixture.port.release(received); } };
  const first = creditContracts.admitCredits(ledger, request, host);
  await ledgerStarted;
  const duplicate = creditContracts.admitCredits(ledger, { ...request }, host)
    .then(value => ({ value }), error => ({ error }));
  await Promise.resolve(); await Promise.resolve();
  refuseFirst(new PluginError('not-admitted'));
  assert.deepEqual(await first, { ok: false, reason: 'host-limit', attemptId: request.attemptId });
  allowDuplicate?.();
  const outcome = await duplicate;
  assert.equal(outcome.error?.code, 'already-claimed');
  assert.equal(outcome.error?.attemptId, request.attemptId);
  assert.equal(walletCalls, 1); assert.equal(ledgerCalls, 1); assert.equal(releases, 1);
  assert.equal(fixture.port.balance().committedMicro, 0);
});

test('a generated attempt key is attached to a wallet error for recovery', async () => {
  const fixture = walletFixture(), failure = new Error('wallet unavailable');
  let walletSnapshot, ledgerCalls = 0;
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, admit: () => { ledgerCalls += 1; } };
  const host = { ...fixture.port, async admit(request) {
    walletSnapshot = request; await fixture.port.admit(request); throw failure;
  } };
  await assert.rejects(creditContracts.admitCredits(ledger, walletRequest, host), error => {
    assert.equal(error, failure); assert.equal(error.attemptId, walletSnapshot.attemptId);
    assert.match(error.attemptId, /^[a-f0-9-]{36}$/u); return true;
  });
  assert.equal(ledgerCalls, 0);
  assert.equal(fixture.reservations.get(walletSnapshot.attemptId), walletRequest.maxMicro);
});

test('an unknown ledger outcome retains the owner hold and throws with the generated attempt key', async () => {
  const fixture = walletFixture(), failure = new Error('ledger timeout');
  let reservedAttempt, releases = 0;
  const ledger = { sessionCapMicro: 100, visitorCapMicro: 50, used: () => 0, visitorUsed: () => 0,
    canAdmit: () => true, async admit(request) { reservedAttempt = request; throw failure; } };
  const host = { ...fixture.port, release(request) { releases += 1; return fixture.port.release(request); } };
  await assert.rejects(creditContracts.admitCredits(ledger, walletRequest, host), error => {
    assert.equal(error, failure); assert.equal(error.attemptId, reservedAttempt.attemptId); return true;
  });
  assert.equal(releases, 0);
  assert.equal(fixture.reservations.get(reservedAttempt.attemptId), walletRequest.maxMicro);
});

test('owner wallet kit rejects a wallet accepting mismatched request fingerprints', async () => {
  const fixture = walletFixture();
  const host = { ...fixture.port, admit(request) {
    if (fixture.reservations.has(request.attemptId)) return { ok: true };
    return fixture.port.admit(request);
  } };
  const result = await creditContracts.ownerWalletConformance(host, walletRequest);
  assert.equal(result.ok, false);
  for (const field of Object.keys(fingerprintChanges)) {
    assert.ok(result.failures.includes(`owner attempt conflict ${field}`), field);
  }
});
