import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';

const beforeMidnight = Date.parse('2026-10-19T23:40:00Z');
const afterMidnight = Date.parse('2026-10-20T00:01:00Z');
const day = at => new Date(at).toISOString().slice(0, 10);
const admit = (ledger, sessionId, extra = {}) => ledger.admit({ attemptId: 'attempt', sessionId,
  lane: 'reaction', maxMicro: 10_000_000, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
const plain = events => JSON.parse(JSON.stringify(events));
const voiceReceipt = (upstreamMicro, visitorMicro) => ({ closureConfirmed: true, providerSessionId: 'private-session',
  usage: { upstreamMicro, visitorMicro, providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60 } });

test('AIT-409 START-524: a receipt after midnight dates the correction to today, not the first settlement', async t => {
  const path = await temporaryDb();
  let clock = beforeMidnight, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100_000_000, now: () => clock });
  const session = storage.create();
  admit(ledger, session.id, { providerCost: { generationId: 'private-generation', secretRef: 'private-secret' } });
  const claim = ledger.claim('attempt'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'attempt', outcome: 'uncertain' });
  assert.equal(ledger.get('attempt').settled_micro, 10_000_000);
  clock += 5 * 60_000;
  ledger.reconcileCost('attempt', { chargedMicro: 10_000, estimated: true, source: 'configured-call-estimate' });
  assert.equal(ledger.get('attempt').settled_micro, 10_000);
  // A sibling uses the room released by yesterday's estimate. Its day key can
  // expire: today's charge must be reconstructible from the posted correction.
  const sibling = ledger.admit({ attemptId: 'sibling', sessionId: storage.create().id, lane: 'reaction',
    maxMicro: 29_990_000, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  assert.equal(sibling.maxMicro + ledger.get('attempt').settled_micro, 30_000_000);
  clock = afterMidnight;
  const receipt = { chargedMicro: 8_000_000, generationId: 'private-generation' };
  ledger.reconcileCost('attempt', receipt);
  const events = plain(ledger.corrections('attempt'));
  assert.deepEqual(events, [
    { id: events[0].id, attemptId: 'attempt', lane: 'reaction', atMs: beforeMidnight + 5 * 60_000,
      oldMicro: 10_000_000, newMicro: 10_000, oldVisitorMicro: 0, newVisitorMicro: 0 },
    { id: events[1].id, attemptId: 'attempt', lane: 'reaction', atMs: afterMidnight,
      oldMicro: 10_000, newMicro: 8_000_000, oldVisitorMicro: 0, newVisitorMicro: 0 },
  ]);
  assert.ok(Number.isSafeInteger(events[0].id) && events[0].id > 0);
  assert.ok(events[1].id > events[0].id);
  const filedToday = () => ledger.corrections('attempt').filter(event => day(event.atMs) === day(clock))
    .reduce((sum, event) => sum + event.newMicro - event.oldMicro, 0);
  assert.equal(filedToday(), 7_990_000);
  const canAdmitToday = micro => micro <= 30_000_000 - filedToday();
  assert.equal(canAdmitToday(30_000_000), false, 'the late receipt consumes today\'s headroom');
  assert.equal(canAdmitToday(22_010_000), true);
  assert.equal(ledger.get('attempt').settled_at_ms, beforeMidnight);
  storage.close(); storage = new SQLiteStorage(path);
  ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  ledger.reconcileCost('attempt', receipt);
  assert.deepEqual(plain(ledger.corrections('attempt')), events, 'restart and receipt replay preserve ids and dates');
  assert.equal(filedToday(), 7_990_000);
  assert.deepEqual(ledger.corrections('sibling'), []);
  assert.deepEqual(ledger.corrections('missing'), []);
});

test('AIT-409: corrections preserve posting order across equal or decreasing clock readings and exclude private evidence', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let clock = afterMidnight;
  const ledger = new SQLiteBudgetLedger(storage, { now: () => clock }), session = storage.create();
  admit(ledger, session.id, { providerCost: { secretRef: 'private-secret' } });
  const claim = ledger.claim('attempt'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'attempt', outcome: 'uncertain' });
  for (const chargedMicro of [10_000, 20_000, 30_000]) {
    ledger.reconcileCost('attempt', { chargedMicro, estimated: true, secret: 'private-evidence' });
    if (chargedMicro === 20_000) clock--;
  }
  const events = plain(ledger.corrections('attempt'));
  assert.deepEqual(events.map(event => event.newMicro), [10_000, 20_000, 30_000]);
  assert.deepEqual(events.map(event => event.atMs), [afterMidnight, afterMidnight, afterMidnight - 1]);
  assert.ok(events.every((event, index) => index === 0 || event.id > events[index - 1].id));
  assert.ok(events.every(event => Object.keys(event).sort().join(',') ===
    'atMs,attemptId,id,lane,newMicro,newVisitorMicro,oldMicro,oldVisitorMicro'));
  assert.equal(JSON.stringify(events).includes('private'), false);
  // Reads cannot mutate persisted history.
  events[0].newMicro = 0;
  assert.equal(ledger.corrections('attempt')[0].newMicro, 10_000);
});

test('AIT-409: voice corrections expose both amounts and replay without a second event', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let clock = beforeMidnight;
  const ledger = new SQLiteBudgetLedger(storage, { now: () => clock }), session = storage.create();
  admit(ledger, session.id, { lane: 'voice', maxVisitorMicro: 5_000_000 });
  const claim = ledger.claim('attempt'); claim.consume();
  ledger.settleVoice(claim.claimId, { attemptId: 'attempt', outcome: 'uncertain', closureConfirmed: false });
  clock = afterMidnight;
  const receipt = voiceReceipt(8_000_000, 4_000_000);
  ledger.reconcileVoice('attempt', receipt);
  const events = plain(ledger.corrections('attempt'));
  assert.deepEqual(events, [{ id: events[0].id, attemptId: 'attempt', lane: 'voice', atMs: afterMidnight,
    oldMicro: 10_000_000, newMicro: 8_000_000, oldVisitorMicro: 5_000_000, newVisitorMicro: 4_000_000 }]);
  clock++;
  ledger.reconcileVoice('attempt', receipt);
  assert.deepEqual(plain(ledger.corrections('attempt')), events);
  assert.equal(ledger.get('attempt').settled_at_ms, beforeMidnight);
});

test('AIT-409: retained voice exposure is dated, durable and idempotent without becoming an admitted extension', async t => {
  const path = await temporaryDb();
  let clock = beforeMidnight, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  const session = storage.create();
  admit(ledger, session.id, { lane: 'voice', maxMicro: 1_000_000, maxVisitorMicro: 500_000,
    voiceExposure: { maxMicro: 10_000_000, maxVisitorMicro: 5_000_000 } });
  ledger.claim('attempt').consume();
  assert.deepEqual(ledger.voiceExposures('attempt'), []);
  clock = afterMidnight;
  assert.deepEqual(ledger.retainVoiceExposure('attempt'), { maxMicro: 10_000_000, maxVisitorMicro: 5_000_000 });
  const events = ledger.voiceExposures('attempt');
  assert.deepEqual(events, [{ id: 1, attemptId: 'attempt', lane: 'voice', atMs: afterMidnight,
    oldMicro: 1_000_000, newMicro: 10_000_000, oldVisitorMicro: 500_000, newVisitorMicro: 5_000_000 }]);
  assert.equal(ledger.used(session.id), 10_000_000);
  assert.equal(ledger.visitorUsed(session.id), 5_000_000);
  assert.equal(ledger.get('attempt').voice_closing, 1);
  assert.deepEqual(JSON.parse(ledger.get('attempt').voice_extensions_json), []);
  storage.close(); storage = new SQLiteStorage(path); clock++;
  ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  ledger.retainVoiceExposure('attempt');
  assert.deepEqual(ledger.voiceExposures('attempt'), events);
  assert.deepEqual(ledger.voiceExposures('missing'), []);
});

test('AIT-409: visitor-only exposure raises are dated and unchanged maxima produce no event', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => afterMidnight }), session = storage.create();
  admit(ledger, session.id, { lane: 'voice', maxMicro: 1_000_000, maxVisitorMicro: 500_000,
    voiceExposure: { maxMicro: 1_000_000, maxVisitorMicro: 1_000_000 } });
  ledger.claim('attempt').consume();
  ledger.retainVoiceExposure('attempt');
  assert.deepEqual(ledger.voiceExposures('attempt'), [{ id: 1, attemptId: 'attempt', lane: 'voice', atMs: afterMidnight,
    oldMicro: 1_000_000, newMicro: 1_000_000, oldVisitorMicro: 500_000, newVisitorMicro: 1_000_000 }]);
  admit(ledger, session.id, { attemptId: 'unchanged', lane: 'voice', maxMicro: 1_000_000 });
  ledger.claim('unchanged').consume(); ledger.retainVoiceExposure('unchanged');
  assert.deepEqual(ledger.voiceExposures('unchanged'), []);
  assert.equal(ledger.get('unchanged').voice_closing, 1);
});

test('AIT-409: exposure event and maxima roll back together on a failed write', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => afterMidnight }), session = storage.create();
  admit(ledger, session.id, { lane: 'voice', maxMicro: 1_000_000,
    voiceExposure: { maxMicro: 2_000_000, maxVisitorMicro: 0 },
    voiceEstimate: { upstreamMicroPerMinute: 1_000_000, visitorMicroPerMinute: 0 } });
  ledger.claim('attempt').consume();
  const before = ledger.get('attempt');
  storage.db.exec(`CREATE TRIGGER fail_exposure BEFORE UPDATE OF max_micro ON budget_attempts
    BEGIN SELECT RAISE(ABORT,'exposure write failed'); END;`);
  assert.throws(() => ledger.retainVoiceExposure('attempt'), /exposure write failed/);
  assert.deepEqual(ledger.get('attempt'), before);
  assert.deepEqual(ledger.voiceExposures('attempt'), []);
});
