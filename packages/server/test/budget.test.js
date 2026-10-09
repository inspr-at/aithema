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
    const report = { attemptId: a.attemptId, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 4 } };
    assert.equal(ledger.settle(claim.claimId, report, { inputMicro: 1, outputMicro: 2 }).settled_micro, 11);
    assert.equal(ledger.settle(claim.claimId, report, { inputMicro: 1, outputMicro: 2 }).settled_micro, 11);
    assert.throws(() => ledger.settle(claim.claimId, { ...report, outcome: 'uncertain' }), { code: 'already-claimed' });
    assert.throws(() => admit(ledger, s.id, { attemptId: a.attemptId }), { code: 'already-claimed' });
    const retry = admit(ledger, s.id, { lane: 'understanding' }); assert.notEqual(retry.attemptId, a.attemptId);
  } finally { storage.close(); }
});
test('uncertain and over-maximum settlement charge the maximum; cancellation with known usage is charged', () => {
  const storage = new SQLiteStorage(), s = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  try {
    for (const [terminal, cost] of [[{ outcome: 'uncertain' }, 40],
      [{ outcome: 'cancelled', usage: { inputTokens: 2, outputTokens: 1 } }, 4],
      [{ outcome: 'completed', usage: { inputTokens: 200, outputTokens: 0 } }, 40]]) {
      const a = admit(ledger, s.id), claim = ledger.claim(a.attemptId); claim.consume();
      const result = ledger.settle(claim.claimId, { attemptId: a.attemptId, ...terminal }, { inputMicro: 1, outputMicro: 2 });
      assert.equal(result.settled_micro, cost);
      if (cost === 40) assert.equal(result.outcome, 'uncertain');
    }
  } finally { storage.close(); }
});
test('recovery after reopening releases unclaimed holds, charges committed claims and never reopens a claim', async () => {
  const db = await temporaryDb(); let storage = new SQLiteStorage(db), ledger = new SQLiteBudgetLedger(storage);
  const s = storage.create(), unused = admit(ledger, s.id), uncertain = admit(ledger, s.id);
  const claim = ledger.claim(uncertain.attemptId); storage.close();
  storage = new SQLiteStorage(db); ledger = new SQLiteBudgetLedger(storage);
  try {
    assert.equal(ledger.recover(), 2); assert.equal(ledger.recover(), 0);
    assert.equal(ledger.get(unused.attemptId).settled_micro, 0);
    assert.equal(ledger.get(uncertain.attemptId).settled_micro, 40);
    assert.throws(() => ledger.claim(uncertain.attemptId), { code: 'already-claimed' });
    assert.equal(ledger.settle(claim.claimId, { attemptId: uncertain.attemptId, outcome: 'uncertain' }).settled_micro, 40);
  } finally { storage.close(); }
});
test('two SQLite connections share ceilings and claim uniqueness', async () => {
  const db = await temporaryDb(), first = new SQLiteStorage(db), second = new SQLiteStorage(db);
  try {
    const s = first.create(), a = new SQLiteBudgetLedger(first, { sessionCapMicro: 50 }), b = new SQLiteBudgetLedger(second, { sessionCapMicro: 50 });
    const hold = admit(a, s.id); assert.throws(() => admit(b, s.id), /Budget denied/);
    a.claim(hold.attemptId); assert.throws(() => b.claim(hold.attemptId), { code: 'already-claimed' });
  } finally { first.close(); second.close(); }
});
