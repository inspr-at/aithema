import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';
const admit = (ledger, sessionId, extra = {}) => ledger.admit({ sessionId, lane: 'reaction', maxMicro: 40,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });

test('AIT-163 fix1: the pending receipt query uses its partial index and includes legacy rows', t => {
  const storage = new SQLiteStorage(), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  t.after(() => storage.close());
  const pending = admit(ledger, session.id, { providerCost: { plugin: 'openrouter' } });
  const legacy = admit(ledger, session.id);
  for (const a of [pending, legacy]) {
    const claim = ledger.claim(a.attemptId); claim.consume();
    ledger.settle(claim.claimId, { attemptId: a.attemptId, outcome: 'uncertain' });
  }
  const prepare = storage.db.prepare.bind(storage.db), plans = [];
  t.mock.method(storage.db, 'prepare', sql => {
    if (/^SELECT \* FROM budget_attempts/u.test(sql)) plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
    return prepare(sql);
  });
  assert.deepEqual(new Set(ledger.pendingCosts().map(row => row.attempt_id)), new Set([pending.attemptId, legacy.attemptId]));
  assert.ok(plans.some(plan => plan.detail.includes('budget_cost_pending')), JSON.stringify(plans));
  assert.ok(plans.every(plan => !/^SCAN budget_attempts$/u.test(plan.detail)), JSON.stringify(plans));
});
test('actual provider costs settle once, reject invalid costs and expose overruns', () => {
  const storage = new SQLiteStorage(), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  try {
    for (const chargedMicro of [0, 13, 41]) {
      const a = admit(ledger, session.id, { lane: 'concept' }), claim = ledger.claim(a.attemptId); claim.consume();
      const terminal = { attemptId: a.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, chargedMicro };
      for (const invalid of [-1, NaN, Infinity, .1, '13', null, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => ledger.settle(claim.claimId, { ...terminal, chargedMicro: invalid }), /Invalid terminal/);
      }
      const row = ledger.settle(claim.claimId, terminal);
      assert.equal(row.settled_micro, chargedMicro); assert.equal(row.overrun, chargedMicro > 40 ? 1 : 0);
      assert.equal(ledger.settle(claim.claimId, terminal).settled_micro, chargedMicro);
      assert.throws(() => ledger.settle(claim.claimId, { ...terminal, chargedMicro: chargedMicro + 1 }), { code: 'already-claimed' });
    }
  } finally { storage.close(); }
});
test('an explicitly undefined optional cost uses token rates and replays as an absent cost', () => {
  const storage = new SQLiteStorage(), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  try {
    const a = admit(ledger, session.id), claim = ledger.claim(a.attemptId); claim.consume();
    const terminal = { attemptId: a.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 2 } };
    assert.equal(ledger.settle(claim.claimId, { ...terminal, chargedMicro: undefined }, { inputMicro: 1, outputMicro: 2 }).settled_micro, 5);
    assert.equal(ledger.settle(claim.claimId, terminal).settled_micro, 5);
  } finally { storage.close(); }
});
test('budget atomically reserves maxima across both lanes and burns durable single-use claims', () => {
  const storage = new SQLiteStorage(), s = storage.create(), ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 60 });
  try {
    const a = admit(ledger, s.id), claim = ledger.claim(a.attemptId);
    assert.equal(ledger.used(s.id), 40);
    assert.throws(() => admit(ledger, s.id, { lane: 'understanding' }), /Budget denied/);
    claim.consume(); assert.throws(() => claim.consume(), { code: 'already-claimed' });
    assert.throws(() => ledger.claim(a.attemptId), { code: 'already-claimed' });
    const report = { attemptId: a.attemptId, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 4 }, servedModel: 'provider/served-model' };
    assert.equal(ledger.settle(claim.claimId, report, { inputMicro: 1, outputMicro: 2 }).settled_micro, 11);
    assert.deepEqual(JSON.parse(ledger.get(a.attemptId).terminal_json), report);
    assert.equal(ledger.settle(claim.claimId, report, { inputMicro: 1, outputMicro: 2 }).settled_micro, 11);
    assert.throws(() => ledger.settle(claim.claimId, { ...report, outcome: 'uncertain' }), { code: 'already-claimed' });
    assert.throws(() => admit(ledger, s.id, { attemptId: a.attemptId }), { code: 'already-claimed' });
    const retry = admit(ledger, s.id, { lane: 'understanding' }); assert.notEqual(retry.attemptId, a.attemptId);
  } finally { storage.close(); }
});
test('dispatched uncertain settlement charges the maximum; known overruns record actual cost and flag', () => {
  const storage = new SQLiteStorage(), s = storage.create(), ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 200 });
  try {
    for (const [terminal, cost] of [[{ outcome: 'uncertain', servedModel: 'provider/served-model' }, 40],
      [{ outcome: 'cancelled', usage: { inputTokens: 2, outputTokens: 1 } }, 4],
      [{ outcome: 'completed', usage: { inputTokens: 200, outputTokens: 0 } }, 200]]) {
      const a = admit(ledger, s.id), claim = ledger.claim(a.attemptId); claim.consume();
      const result = ledger.settle(claim.claimId, { attemptId: a.attemptId, ...terminal }, { inputMicro: 1, outputMicro: 2 });
      assert.equal(result.settled_micro, cost);
      assert.equal(result.overrun, cost > 40 ? 1 : 0);
      if (cost === 40) {
        assert.equal(result.outcome, 'uncertain');
        assert.equal(JSON.parse(result.terminal_json).servedModel, 'provider/served-model');
      }
      else assert.equal(result.outcome, terminal.outcome);
    }
    assert.equal(ledger.used(s.id), 244); assert.equal(ledger.canAdmit(s.id, 0), false);
  } finally { storage.close(); }
});
test('recovery releases undispatched claims, charges dispatched claims and never reopens a claim', async () => {
  const db = await temporaryDb(); let storage = new SQLiteStorage(db), ledger = new SQLiteBudgetLedger(storage);
  const s = storage.create(), unused = admit(ledger, s.id), unconsumed = admit(ledger, s.id), uncertain = admit(ledger, s.id);
  ledger.claim(unconsumed.attemptId);
  const claim = ledger.claim(uncertain.attemptId); claim.consume(); storage.close();
  storage = new SQLiteStorage(db); ledger = new SQLiteBudgetLedger(storage);
  try {
    assert.equal(ledger.recover(), 3); assert.equal(ledger.recover(), 0);
    assert.equal(ledger.get(unused.attemptId).settled_micro, 0);
    assert.equal(ledger.get(unconsumed.attemptId).settled_micro, 0);
    assert.equal(ledger.get(uncertain.attemptId).settled_micro, 40);
    assert.throws(() => ledger.claim(uncertain.attemptId), { code: 'already-claimed' });
    assert.equal(ledger.settle(claim.claimId, { attemptId: uncertain.attemptId, outcome: 'uncertain' }).settled_micro, 40);
  } finally { storage.close(); }
});

test('a terminal on a claimed but unconsumed attempt cannot incur cost', () => {
  const storage = new SQLiteStorage(), s = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  try {
    for (const terminal of [{ outcome: 'uncertain' }, { outcome: 'completed', usage: { inputTokens: 200, outputTokens: 4 } }]) {
      const a = admit(ledger, s.id), claim = ledger.claim(a.attemptId);
      const report = { attemptId: a.attemptId, ...terminal };
      const result = ledger.settle(claim.claimId, report, { inputMicro: 1, outputMicro: 2 });
      assert.equal(result.settled_micro, 0); assert.equal(result.outcome, 'cancelled');
      assert.deepEqual(JSON.parse(result.usage), { inputTokens: 0, outputTokens: 0 });
      assert.equal(ledger.settle(claim.claimId, report).settled_micro, 0);
      assert.throws(() => claim.consume(), { code: 'already-claimed' });
    }
  } finally { storage.close(); }
});

test('budget connection waits briefly for another SQLite writer', () => {
  const storage = new SQLiteStorage();
  try {
    storage.db.exec('PRAGMA busy_timeout=0');
    new SQLiteBudgetLedger(storage);
    const timeout = storage.db.prepare('PRAGMA busy_timeout').get().timeout;
    assert.ok(timeout >= 100 && timeout <= 1000);
  } finally { storage.close(); }
});
test('two SQLite connections share ceilings and claim uniqueness', async () => {
  const db = await temporaryDb(), first = new SQLiteStorage(db), connection = new DatabaseSync(db);
  // Exercise ledger contention through a second raw connection, without creating
  // a second session engine (the durable engine writer remains exclusive).
  const second = { db: connection, transaction(fn) {
    connection.exec('BEGIN IMMEDIATE');
    try { const value = fn(); connection.exec('COMMIT'); return value; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }, close: () => connection.close() };
  try {
    const s = first.create(), a = new SQLiteBudgetLedger(first, { sessionCapMicro: 50 }), b = new SQLiteBudgetLedger(second, { sessionCapMicro: 50 });
    const hold = admit(a, s.id); assert.throws(() => admit(b, s.id), /Budget denied/);
    a.claim(hold.attemptId); assert.throws(() => b.claim(hold.attemptId), { code: 'already-claimed' });
  } finally { first.close(); second.close(); }
});

for (const recovery of [false, true]) test(`AIT-198 visitor understanding refund survives restart and a late provider receipt (${recovery ? 'recovered dispatch' : 'terminal failure'})`, async t => {
  const db = await temporaryDb();
  let storage = new SQLiteStorage(db), ledger = new SQLiteBudgetLedger(storage);
  t.after(() => storage.close());
  const session = storage.create();
  const { attemptId } = admit(ledger, session.id, { lane: 'understanding', providerCost: { plugin: 'openrouter' } });
  const claim = ledger.claim(attemptId); claim.consume(); ledger.markCostDispatch(attemptId);
  if (!recovery) {
    ledger.settle(claim.claimId, { attemptId, outcome: 'uncertain' });
    assert.equal(ledger.get(attemptId).visitor_credit_released, 0, 'unknown provider cost alone is not lane failure');
    // The lane reports failure after host validation/publication; this refunds it.
    ledger.releaseUnderstandingCredits(attemptId);
  }
  storage.close(); storage = new SQLiteStorage(db); ledger = new SQLiteBudgetLedger(storage);
  if (recovery) assert.equal(ledger.recover(session.id), 1);
  assert.equal(ledger.get(attemptId).settled_micro, 40, 'provider liability remains conservative');
  assert.equal(ledger.get(attemptId).visitor_credit_released, 1);
  assert.equal(ledger.breakdown(session.id, { visitorCredits: true }).uncertainSpendMicro, 0);
  ledger.reconcileCost(attemptId, { chargedMicro: 7 });
  assert.equal(ledger.get(attemptId).settled_micro, 7, 'real receipt repairs the provider ledger');
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 7);
  assert.equal(ledger.breakdown(session.id, { visitorCredits: true }).confirmedSpendMicro, 0, 'receipt cannot charge the refunded visitor again');
  assert.deepEqual(ledger.displayBreakdown(session.id), { reservedMicro: 0, confirmedSpendMicro: 0, uncertainSpendMicro: 0, pendingHoldMicro: 0, reconciling: false });
});
