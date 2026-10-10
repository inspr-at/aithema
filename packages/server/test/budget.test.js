import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';
const admit = (ledger, sessionId, extra = {}) => ledger.admit({ sessionId, lane: 'reaction', maxMicro: 40,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
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
