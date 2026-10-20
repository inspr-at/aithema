import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createPluginRuntime } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';

const yesterday = Date.parse('2026-10-19T23:59:59.000Z');
const today = Date.parse('2026-10-20T00:00:01.000Z');
const tomorrow = Date.parse('2026-10-21T00:00:01.000Z');
const day = at => new Date(at).toISOString().slice(0, 10);
const admission = (ledger, sessionId, extra = {}) => ledger.admit({ attemptId: 'voice', sessionId,
  lane: 'voice', maxMicro: 1_000_000, maxVisitorMicro: 500_000,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
const terminal = (attemptId, upstreamMicro) => ({ attemptId, outcome: 'completed', closureConfirmed: true,
  usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60,
    upstreamMicro, visitorMicro: 500_000 } });
const extensions = (ledger, id = 'voice') => JSON.parse(ledger.get(id).voice_extensions_json);

test('AIT-401 START-524: midnight extension remains in today\'s 30 USD cap after restart', async t => {
  const path = await temporaryDb();
  let clock = yesterday, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100_000_000, now: () => clock });
  const session = storage.create(); admission(ledger, session.id);
  ledger.claim('voice').consume();
  // The host already owns the original hold and its admission day.
  const originalHold = { micro: 1_000_000, at: yesterday };
  const filed = at => (day(at) === day(originalHold.at) ? originalHold.micro : 0) +
    extensions(ledger).filter(event => day(event.at) === day(at)).reduce((sum, event) => sum + event.extraMicro, 0);
  clock = today;
  const calls = [];
  const wallet = (extra, context) => {
    calls.push({ extra, context });
    assert.deepEqual(context, { attemptId: 'voice', sessionId: session.id, extraMicro: extra.maxMicro, at: today });
    return extra.maxMicro <= 30_000_000 - filed(context.at);
  };
  ledger.extendVoice('voice', { maxMicro: 10_000_000, maxVisitorMicro: 5_000_000 }, wallet);
  assert.equal(filed(today), 9_000_000, 'the extra belongs to the extension day, not yesterday');
  assert.equal(filed(yesterday), 1_000_000);
  storage.close(); storage = new SQLiteStorage(path);
  ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100_000_000, now: () => clock });
  assert.equal(filed(today), 9_000_000, 'a crash cannot lose the daily reservation');
  assert.throws(() => ledger.extendVoice('voice', { maxMicro: 32_000_000, maxVisitorMicro: 5_000_000 }, wallet), { code: 'not-admitted' });
  assert.equal(calls.length, 2);
  assert.equal(extensions(ledger).length, 1, 'refused extensions have no durable event');
});

test('AIT-401: replayed cumulative extensions preserve committed times and never double-file', async t => {
  const path = await temporaryDb(); let clock = today, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  const session = storage.create(); admission(ledger, session.id); ledger.claim('voice').consume();
  const maxima = { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 };
  ledger.extendVoice('voice', maxima);
  const committed = extensions(ledger);
  assert.deepEqual(committed, [{ ...maxima, extraMicro: 1_000_000, extraVisitorMicro: 500_000, at: today }]);
  storage.close(); storage = new SQLiteStorage(path); clock = tomorrow;
  ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  let context;
  assert.deepEqual(ledger.extendVoice('voice', maxima, (_, info) => { context = info; }), maxima);
  assert.deepEqual(context, { attemptId: 'voice', sessionId: session.id, extraMicro: 0, at: today });
  assert.deepEqual(extensions(ledger), committed);
  ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_500_000 });
  assert.deepEqual(extensions(ledger)[1], { maxMicro: 2_000_000, maxVisitorMicro: 1_500_000,
    extraMicro: 0, extraVisitorMicro: 500_000, at: tomorrow });
  ledger.extendVoice('voice', maxima);
  assert.equal(extensions(ledger).length, 2);
});

test('AIT-401: throwing or refusing extension callbacks roll back host writes and ledger changes', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
  storage.db.exec('CREATE TABLE host_filed (attempt_id TEXT PRIMARY KEY, micro INTEGER)');
  admission(ledger, session.id); ledger.claim('voice').consume();
  const before = ledger.get('voice');
  for (const throws of [false, true]) {
    assert.throws(() => ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 }, () => {
      assert.equal(storage.db.isTransaction, true);
      storage.db.prepare('INSERT INTO host_filed VALUES (?,?)').run('voice', 1_000_000);
      if (throws) throw new Error('host failure');
      return false;
    }), throws ? /host failure/ : { code: 'not-admitted' });
    assert.deepEqual(ledger.get('voice'), before);
    assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM host_filed').get().n, 0);
  }
});

for (const lane of ['voice', 'reaction']) test(`AIT-401: ${lane} over-reservation settlement has a durable, once-only host time`, async t => {
  const path = await temporaryDb(); let clock = yesterday, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  const session = storage.create(); admission(ledger, session.id, { lane });
  const claim = ledger.claim('voice'); claim.consume();
  clock = today;
  const report = lane === 'voice' ? terminal('voice', 2_000_000) : { attemptId: 'voice', outcome: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 }, chargedMicro: 2_000_000 };
  const settle = () => lane === 'voice' ? ledger.settleVoice(claim.claimId, report) : ledger.settle(claim.claimId, report);
  const receipt = settle();
  assert.equal(receipt.settled_at_ms, today);
  const perDay = { [day(yesterday)]: receipt.max_micro,
    [day(receipt.settled_at_ms)]: Math.max(0, receipt.settled_micro - receipt.max_micro) };
  assert.deepEqual(perDay, { '2026-10-19': 1_000_000, '2026-10-20': 1_000_000 });
  storage.close(); storage = new SQLiteStorage(path); clock = tomorrow;
  ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  assert.deepEqual(settle(), receipt, 'duplicate reports retain the original settlement time across restart');
  assert.equal(ledger.recover(), 0);
  assert.equal(ledger.get('voice').settled_at_ms, today);
});

test('AIT-401: recovery preserves extension days and stamps settlement only once', async t => {
  const path = await temporaryDb(); let clock = today, storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  let ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  const session = storage.create(); admission(ledger, session.id, { voiceExposure: { maxMicro: 3_000_000, maxVisitorMicro: 1_500_000 } });
  ledger.claim('voice').consume();
  ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 });
  admission(ledger, session.id, { attemptId: 'unused', lane: 'reaction' });
  const events = extensions(ledger);
  storage.close(); storage = new SQLiteStorage(path); clock = tomorrow;
  ledger = new SQLiteBudgetLedger(storage, { now: () => clock });
  assert.equal(ledger.recover(), 2);
  assert.equal(ledger.get('voice').settled_at_ms, tomorrow);
  assert.equal(ledger.get('unused').settled_at_ms, tomorrow);
  assert.equal(ledger.get('unused').settled_micro, 0);
  assert.equal(ledger.get('voice').settled_micro - ledger.get('voice').max_micro, 1_000_000);
  assert.deepEqual(extensions(ledger), events);
  clock += 86_400_000;
  const receipt = ledger.get('voice');
  assert.equal(ledger.recover(), 0);
  assert.deepEqual(ledger.get('voice'), receipt);
});

test('AIT-401: settlement write failure leaves the attempt un-settled and no timestamp committed', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
  admission(ledger, session.id); const claim = ledger.claim('voice'); claim.consume();
  const before = ledger.get('voice');
  storage.db.exec(`CREATE TRIGGER fail_settle BEFORE UPDATE ON budget_attempts WHEN NEW.state='settled'
    BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
  assert.throws(() => ledger.settleVoice(claim.claimId, terminal('voice', 2_000_000)), /injected failure/);
  assert.deepEqual(ledger.get('voice'), before);
  storage.db.exec('DROP TRIGGER fail_settle');
  assert.equal(ledger.settleVoice(claim.claimId, terminal('voice', 2_000_000)).settled_at_ms, today);
});

test('AIT-401: existing rows migrate without inventing historical times', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create();
  storage.db.exec(`CREATE TABLE budget_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    lane TEXT NOT NULL, max_micro INTEGER NOT NULL, claim_id TEXT UNIQUE, state TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, binding_sha256 TEXT NOT NULL, outcome TEXT, usage TEXT,
    settled_micro INTEGER, terminal_json TEXT)`);
  storage.db.prepare(`INSERT INTO budget_attempts VALUES (?,?, 'reaction',40,'old-claim','settled',?,?,'completed',NULL,40,'{}')`)
    .run('old', session.id, 'a'.repeat(64), 'b'.repeat(64));
  let ledger = new SQLiteBudgetLedger(storage, { now: () => today });
  assert.equal(ledger.get('old').settled_at_ms, null);
  assert.deepEqual(extensions(ledger, 'old'), []);
  ledger = new SQLiteBudgetLedger(storage, { now: () => tomorrow });
  assert.equal(ledger.get('old').settled_at_ms, null);
  assert.equal(ledger.used(session.id), 40);
});

test('AIT-401: legacy host callback calls and results snapshot remains identical', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
  admission(ledger, session.id); const claim = ledger.claim('voice'); claim.consume();
  const calls = [], results = [];
  const legacyHost = extra => { calls.push(extra); return extra.maxMicro <= 1_000_000; };
  for (const maxMicro of [2_000_000, 2_000_000, 1_000_000, 4_000_000]) {
    try { results.push(ledger.extendVoice('voice', { maxMicro, maxVisitorMicro: 1_000_000 }, legacyHost)); }
    catch (error) { results.push({ code: error.code }); }
  }
  const row = ledger.settleVoice(claim.claimId, terminal('voice', 1_500_000));
  assert.equal(ledger.settleVoice(claim.claimId, terminal('voice', 1_500_000)).settled_micro, 1_500_000);
  assert.deepEqual({ calls, results, receipt: { state: row.state, outcome: row.outcome, settledMicro: row.settled_micro,
    settledVisitorMicro: row.settled_visitor_micro, used: ledger.used(session.id), visitorUsed: ledger.visitorUsed(session.id) } }, {
    calls: [{ maxMicro: 1_000_000, maxVisitorMicro: 500_000 }, { maxMicro: 0, maxVisitorMicro: 0 },
      { maxMicro: 0, maxVisitorMicro: 0 }, { maxMicro: 2_000_000, maxVisitorMicro: 0 }],
    results: [{ maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 }, { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 },
      { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 }, { code: 'not-admitted' }],
    receipt: { state: 'settled', outcome: 'completed', settledMicro: 1_500_000, settledVisitorMicro: 500_000,
      used: 1_500_000, visitorUsed: 500_000 },
  });
});

test('AIT-401: handlers supply host.now to a prebuilt runtime ledger', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const runtime = createPluginRuntime({ storage, now: () => yesterday });
  const host = { now: () => today };
  const handlers = createHandlers({ storage, pluginRuntime: runtime, host, log: () => {} });
  t.after(() => handlers.close());
  const session = storage.create(); admission(runtime.budget, session.id);
  const claim = runtime.budget.claim('voice'); claim.consume();
  assert.equal(runtime.budget.settleVoice(claim.claimId, terminal('voice', 1_000_000)).settled_at_ms, today);
});
