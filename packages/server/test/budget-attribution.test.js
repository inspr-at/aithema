import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createPluginRuntime } from '../src/index.js';
import { PluginRegistry, publicReasoningManifest, createMockReasoning } from '@inspr/aithema-core';
import { mockPresets } from '../src/plugin-runtime.js';
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
  assert.deepEqual(ledger.extendVoice('voice', maxima, (_, info) => { context = info; return true; }), maxima);
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

for (const preview of [false, { ok: false, reason: 'session' }, { ok: false, reason: 'host-limit' },
  { ok: false, reason: 'dailyCap' }, { ok: false, reason: 'daily-cap' }, { ok: false, reason: 'unknown' },
  { ok: false }, { reason: 'session' }, {}, null, undefined, 1, 'true', { ok: true }]) {
  test(`AIT-411: voice extension requires explicit wallet yes (${JSON.stringify(preview)})`, t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
    admission(ledger, session.id); ledger.claim('voice').consume();
    const before = ledger.get('voice');
    assert.throws(() => ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 },
      () => preview), { code: 'not-admitted' });
    assert.deepEqual(ledger.get('voice'), before, 'refusal preserves every reservation and extension event');
  });
}
test('AIT-411: an invalid extension authorizer fails closed without changing reservations', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
  admission(ledger, session.id); ledger.claim('voice').consume();
  const before = ledger.get('voice');
  for (const invalid of [false, null, 0]) {
    assert.throws(() => ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 }, invalid), TypeError);
    assert.deepEqual(ledger.get('voice'), before);
  }
});
test('AIT-411: explicit boolean wallet yes funds a voice extension', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage, { now: () => today }), session = storage.create();
  admission(ledger, session.id); ledger.claim('voice').consume();
  assert.deepEqual(ledger.extendVoice('voice', { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 }, () => true),
    { maxMicro: 2_000_000, maxVisitorMicro: 1_000_000 });
  assert.equal(extensions(ledger).length, 1);
});

test('AIT-401: handlers supply host.now to a prebuilt runtime ledger', async t => {
  const storage = new SQLiteStorage();
  const runtime = createPluginRuntime({ storage, now: () => yesterday, consent: { coverage: () => ({ covered: false }) } });
  const host = { now: () => today };
  const handlers = createHandlers({ storage, pluginRuntime: runtime, host, log: () => {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create(); admission(runtime.budget, session.id);
  const claim = runtime.budget.claim('voice'); claim.consume();
  assert.equal(runtime.budget.settleVoice(claim.claimId, terminal('voice', 1_000_000)).settled_at_ms, today);
});


test('AIT-401: voice runtime forwards extension context to the host wallet and uses its clock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: yesterday });
  let clock = yesterday;
  const storage = new SQLiteStorage();
  const endpoint = 'https://voice.example.test', base = publicReasoningManifest('attribution-voice', 'Fixture', endpoint);
  const binding = { plugin: 'attribution-voice', model: 'fixture', effort: 'none', endpoint, accountRef: 'fixture', secretRef: 'fixture',
    maxMicro: 1200, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 3600, reservationSeconds: 30,
    upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300,
    legal: { approved: true, countries: ['AT'], training: false, retention: 'fixture', purpose: 'conversation',
      recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
      evidence: { qualified: true, accountRef: 'fixture', secretRef: 'fixture', model: 'fixture', endpoint, routing: {},
        verifiedAt: yesterday - 1000, expiresAt: today + 100_000 } } };
  const plugin = { binding, manifest: { ...base, kinds: ['live-voice'],
    entrypoints: { server: './server.js', browser: './browser.js' },
    models: [{ ...base.models[0], operations: ['start'], structured: false, cost: { ...base.models[0].cost, unit: 'minute' } }],
    liveVoice: { reasoning: 'native', transcript: { finality: 'turns', persistence: 'durable' },
      capabilities: Object.fromEntries(['sendText', 'updateContext', 'setInput', 'setOutput', 'pause', 'resume', 'interrupt', 'heard'].map(k => [k, 'unavailable'])),
      billing: { visitor: 'duration', upstream: 'duration' } } },
    health: async () => ({ available: true }), start() { throw new Error('No provider calls allowed'); } };
  const consent = { coverage: async ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision,
    checkedAt: clock, expiresAt: today + 100_000 }) };
  const runtime = createPluginRuntime({ storage, now: () => clock, consent,
    registry: new PluginRegistry().register(createMockReasoning()).register(plugin),
    presets: { best: { plugins: ['mock', binding.plugin], bindings: { ...mockPresets().best.bindings, voice: binding }, policy: { endpoints: [endpoint] } } } });
  let preview = true;
  const calls = [], host = { now: () => clock, walletForSession: () => ({ balance: () => ({ limitMicro: 10_000_000, committedMicro: 0 }),
    admit: () => ({ ok: true }), release() {},
    canAdmit(extra, context) { calls.push({ extra, context }); return preview; } }) };
  const handlers = createHandlers({ storage, pluginRuntime: runtime, host, log: () => {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: 'fixture-owner' });
  const admitted = await runtime.admitVoice({ session, request: { callId: 'attribution-call' } });
  await admitted.options.attempt.consume(); clock = today;
  const attemptId = admitted.options.attempt.attemptId;
  const before = runtime.budget.get(attemptId), funded = admitted.options.attempt.fundedSeconds;
  for (const refusal of [false, { ok: false, reason: 'session' }, { ok: false, reason: 'host-limit' }, { ok: false }, undefined]) {
    preview = refusal;
    assert.throws(() => admitted.options.attempt.extend(150), { code: 'not-admitted' });
    assert.deepEqual(runtime.budget.get(attemptId), before);
    assert.equal(admitted.options.attempt.fundedSeconds, funded, 'refusal cannot advance the runtime runway');
  }
  preview = true;
  admitted.options.attempt.extend(150);
  assert.deepEqual(calls.at(-1), { extra: { maxMicro: 300, maxVisitorMicro: 150 },
    context: { attemptId, sessionId: session.id, extraMicro: 300, at: today } });
  assert.equal(extensions(runtime.budget, attemptId)[0].at, today);
  admitted.options.report(terminal(attemptId, 1500));
  assert.equal(runtime.budget.get(attemptId).settled_at_ms, today);
});
