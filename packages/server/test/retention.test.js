import { test } from 'node:test';
import { bindSQLiteClock } from '../../../test/fixtures/sqlite-clock.js';
import { CORE_RETIREMENT_TABLES } from '../src/storage.js';
import assert from 'node:assert/strict';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../src/index.js';
import { createUIRenderLimiter } from '../src/ui-render-limits.js';
import { SQLiteBudgetLedger, createSpendCap, createVoiceCap } from '../src/index.js';
import { testToken, ownedRequest, mockConsent, temporaryDb } from '../../../test/helpers.js';

const request = (path, init) => ownedRequest(`http://localhost/api/sessions/${path}`, init);
function fixture(t) {
  const storage = bindSQLiteClock(new SQLiteStorage()), erased = [];
  const handlers = createHandlers({ storage, consent: mockConsent, host: { retired: info => erased.push(info) } });
  t.after(async () => { await handlers.close(); storage.close(); });
  return { storage, handlers, erased };
}
const age = (storage, id, at = 1) => storage.db.prepare('UPDATE session_retention SET last_activity=? WHERE session_id=?').run(at, id);

for (const via of ['erase route', 'storage erase']) test(`AIT-295: ${via} is fully retired by the next sweep past 24h`, async t => {
  const { storage, handlers, erased } = fixture(t);
  const session = storage.create({ ownerToken: testToken }), survivor = storage.create();
  storage.postTurn(session.id, 'one', Buffer.from('one'), 'private input');
  storage.postTurn(survivor.id, 'keep', Buffer.from('keep'), 'keep this journal');
  const release = storage.hold(survivor.id);
  const journal = storage.read(survivor.id);
  storage.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,NULL)').run('upload', session.id, Buffer.from('private'), 7, 'ref');
  storage.db.prepare('INSERT INTO concept_artifacts VALUES (?,?,?,?,?,NULL)').run('concept', session.id, Buffer.from('private'), '{}', '{"turnIds":[]}');
  storage.db.prepare('INSERT INTO voice_calls VALUES (?,?,?,?)').run('provider', 'call', session.id, '{"terminal":true}');
  storage.db.prepare('INSERT INTO voice_lifecycle_calls VALUES (?,?,?)').run(session.id, 'call', '{}');
  storage.db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run('op', session.id, 'call', 'provider', '{}');
  if (via === 'erase route') assert.equal((await handlers.handle(request(`${session.id}/erase`, { method: 'POST' }))).status, 200);
  else storage.erase(session.id);
  assert.ok(storage.get(session.id).tombstone);
  assert.deepEqual(storage.pendingRetirements(10), [session.id], 'erase queues retirement in the tombstone transaction');
  assert.equal(storage.retirementOwnerHash(session.id), session.ownerHash);
  assert.equal(storage.db.prepare('SELECT bytes FROM uploads WHERE session_id=?').get(session.id).bytes, null);
  const day = 24 * 60 * 60 * 1000, sweepAt = Date.now() + day + 1;
  assert.deepEqual(await handlers.retire({ before: sweepAt - day, limit: 1 }), { retired: 1, failed: 0, more: false });
  assert.throws(() => storage.get(session.id), /not found/i);
  const present = new Set(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of CORE_RETIREMENT_TABLES.filter(table => present.has(table))) {
    assert.equal(storage.db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE session_id=?`).get(session.id).n, 0, table);
  }
  assert.equal(erased[0].sessionId, session.id);
  assert.deepEqual(storage.read(survivor.id), journal);
  assert.throws(() => storage.db.prepare('DELETE FROM events WHERE session_id=?').run(survivor.id), /append only/);
  release();
});

test('retire erases whole sessions, calls the host, bounds batches and is idempotent', async t => {
  const { storage, handlers, erased } = fixture(t);
  // AIT-212 schema, also exercised before its mainline merge lands.
  storage.db.exec(`CREATE TABLE IF NOT EXISTS lane_failures (session_id TEXT NOT NULL REFERENCES sessions(id),
    lane TEXT NOT NULL CHECK(lane IN ('reaction','understanding')), failure TEXT NOT NULL, PRIMARY KEY(session_id,lane))`);
  const ids = Array.from({ length: 3 }, () => storage.create({ ownerToken: testToken }).id);
  for (const id of ids) {
    storage.postTurn(id, 'one', Buffer.from('one'), 'private input');
    storage.transitionHost(id, () => ({ state: { private: 'host data' } }));
    storage.recordSafeguard(id, 'one', '1', true, 3);
    storage.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,NULL)').run(`upload-${id}`, id, Buffer.from('private upload'), 14, 'upload-ref');
    storage.db.prepare('INSERT INTO concept_artifacts VALUES (?,?,?,?,?,NULL)').run(`concept-${id}`, id, Buffer.from('private concept'), '{}', '{"turnIds":[]}');
    storage.db.prepare('INSERT INTO voice_calls VALUES (?,?,?,?)').run(`voice-${id}`, 'call', id, '{}');
    storage.db.prepare('INSERT INTO voice_lifecycle_calls VALUES (?,?,?)').run(id, 'call', '{}');
    storage.db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run(`op-${id}`, id, 'call', 'provider', '{}');
    storage.db.prepare('INSERT INTO lane_failures(session_id,lane,failure) VALUES (?,?,?)').run(id, 'reaction', '{}');
    age(storage, id);
  }
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 2, failed: 0, more: true });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 1, failed: 0, more: false });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 0, failed: 0, more: false });
  for (const { name } of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (storage.db.prepare(`PRAGMA table_info("${name}")`).all().some(c => c.name === 'session_id')) {
      assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0, name);
    }
  }
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM lane_failures').get().n, 0, 'lane_failures rows are gone after retirement');
  assert.deepEqual(storage.list(), []);
  assert.equal(erased.length, 3);
  assert.ok(erased.every(info => info.ownerToken === undefined && /^[a-f0-9]{64}$/.test(info.ownerHash) && ids.includes(info.sessionId)));
  for (const id of ids) assert.equal((await handlers.handle(request(`${id}/export`))).status, 404);
});

test('last activity uses server events and authorized reads, strict cutoff, and protects a live stream', async t => {
  const { storage, handlers } = fixture(t);
  const s = storage.create({ ownerToken: testToken });
  age(storage, s.id, 100);
  assert.deepEqual(await handlers.retire({ before: 100, limit: 1 }), { retired: 0, failed: 0, more: false });
  await handlers.handle(request(s.id));
  assert.deepEqual(await handlers.retire({ before: Date.now() - 1000, limit: 1 }), { retired: 0, failed: 0, more: false });
  age(storage, s.id);
  storage.append(s.id, 'turn.final', { id: 'old-client-time', role: 'user', content: 'hello', at: '1970-01-01T00:00:00.001Z' });
  assert.deepEqual(await handlers.retire({ before: Date.now() - 1000, limit: 1 }), { retired: 0, failed: 0, more: false });
  const stream = await handlers.handle(request(`${s.id}/events`));
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, failed: 0, more: false });
  const disconnectedAt = Date.now();
  await stream.body.cancel(); await handlers.idle();
  assert.ok(storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(s.id).last_activity >= disconnectedAt,
    'the idle clock starts when protected activity finishes, not when a long-lived stream opened');
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
});

test('expiry skips tombstones and live retirement skips deferred erased sessions', async t => {
  const { storage, handlers } = fixture(t);
  for (let i = 0; i < 1000; i++) storage.erase(storage.create().id);
  // Deferred erased sessions must not enter the live candidate query.
  storage.db.prepare('UPDATE retirement_pending SET retry_at=?').run(Number.MAX_SAFE_INTEGER);
  const live = storage.create({ ownerToken: testToken }); age(storage, live.id);
  let reads = 0; const get = storage.get.bind(storage);
  storage.get = id => { reads++; return get(id); };
  storage.list = () => assert.fail('retention must not scan sessions');
  await handlers.expire(2);
  assert.ok(reads <= 3, `expire hydrated ${reads} sessions`);
  reads = 0;
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
  assert.ok(reads < 15, `retire hydrated ${reads} sessions`);
  const plan = storage.db.prepare('EXPLAIN QUERY PLAN SELECT session_id FROM session_retention WHERE busy=0 AND last_activity<? ORDER BY last_activity,session_id LIMIT ?').all(2, 2);
  assert.ok(plan.some(row => /SEARCH.*retention_idle/.test(row.detail)), JSON.stringify(plan));
  const erasedPlan = storage.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM sessions
    WHERE json_extract(snapshot,'$.tombstone') IS NOT NULL AND id>? ORDER BY id LIMIT ?`).all('', 1);
  assert.ok(erasedPlan.some(row => /SEARCH.*sessions_erased/.test(row.detail)), JSON.stringify(erasedPlan));
});

test('retire validates bounds and concurrent calls cannot double-retire', async t => {
  const { storage, handlers } = fixture(t);
  for (const options of [{ before: NaN, limit: 1 }, { before: 2, limit: 0 }, { before: 2, limit: 1001 }]) {
    await assert.rejects(handlers.retire(options), TypeError);
  }
  const s = storage.create(); age(storage, s.id);
  const results = await Promise.all([handlers.retire({ before: 2, limit: 1 }), handlers.retire({ before: 2, limit: 1 })]);
  assert.equal(results.reduce((n, r) => n + r.retired, 0), 1);
});

test('a candidate revived after selection survives the final transactional idle check', async t => {
  const { storage, handlers } = fixture(t), s = storage.create({ ownerToken: testToken }); age(storage, s.id);
  const candidates = storage.retirementCandidates.bind(storage);
  storage.retirementCandidates = (...args) => { const ids = candidates(...args); if (ids.includes(s.id)) storage.touch(s.id); return ids; };
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, failed: 0, more: false });
  assert.equal(storage.get(s.id).tombstone, null);
});

test('an authorized request waiting for its body protects the session', async t => {
  const { storage, handlers } = fixture(t), s = storage.create({ ownerToken: testToken });
  let body;
  const pending = handlers.handle(ownedRequest(`http://localhost/api/sessions/${s.id}/pause`, {
    method: 'POST', duplex: 'half', body: new ReadableStream({ start(controller) { body = controller; } }),
  }));
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, failed: 0, more: false });
  body.enqueue(new TextEncoder().encode('{"paused":true}')); body.close();
  assert.equal((await pending).status, 200);
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
});

test('failed host cleanup survives restart, is retried and only then acknowledged', async t => {
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path), attempts = 0;
  const host = { retired() { if (++attempts === 1) throw new Error('host unavailable'); } };
  let handlers = createHandlers({ storage, consent: mockConsent, host });
  t.after(async () => { await handlers.close(); storage.close(); });
  const s = storage.create(); age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, failed: 1, more: false });
  assert.ok(storage.get(s.id).tombstone);
  assert.deepEqual(storage.pendingRetirements(10, Number.MAX_SAFE_INTEGER), [s.id]);
  await handlers.close(); storage.close();
  storage = new SQLiteStorage(path);
  handlers = createHandlers({ storage, consent: mockConsent, host });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, failed: 0, more: false });
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(storage.pendingRetirements(10, Number.MAX_SAFE_INTEGER), [s.id]);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
  assert.equal(attempts, 2); assert.deepEqual(storage.list(), []);
  const live = storage.create();
  assert.throws(() => storage.db.prepare('DELETE FROM events WHERE session_id=?').run(live.id), /append only/);
});

test('retirement removes accounting links while preserving deployment spend and daily caps', async t => {
  const midnight = Date.parse('2028-10-21T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: midnight - 1 });
  const { storage, handlers } = fixture(t), s = storage.create();
  const now = () => midnight - 1;
  const ledger = new SQLiteBudgetLedger(storage, { now });
  const spend = createSpendCap({ storage, account: 'test-account', capMicro: 100, now });
  const voice = createVoiceCap({ storage, capMilliseconds: 60_000, perDayMilliseconds: 60_000, now });
  const renders = createUIRenderLimiter({ storage, perDay: 1, now });
  ledger.admit({ attemptId: 'attempt', sessionId: s.id, lane: 'concept', maxMicro: 100, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim('attempt'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'attempt', outcome: 'completed', chargedMicro: 101, usage: { inputTokens: 1, outputTokens: 1 } });
  const reservation = spend.reserve(100, { attemptId: 'attempt', provider: 'private-provider' });
  spend.record(reservation, { generationId: 'private-generation', chargedMicro: 101 });
  spend.settle(reservation, 101);
  voice.reserve({ attemptId: 'voice-attempt', sessionId: s.id, callId: 'call', maxMilliseconds: 60_000 });
  renders.consume('render-attempt', s.id, () => {});
  const spentBefore = spend.snapshot({ includeBreachReason: true }), voiceBefore = voice.snapshot();
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
  t.mock.timers.setTime(midnight);
  assert.deepEqual(spend.snapshot({ includeBreachReason: true }), spentBefore);
  assert.deepEqual(voice.snapshot(), voiceBefore);
  assert.equal(renders.reason('new-session'), 'UI render limit reached for this UTC day');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM spend_reservations').get().n, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
  for (const table of ['retired_spend', 'retired_voice_usage', 'retired_ui_renders']) {
    const retained = JSON.stringify(storage.db.prepare(`SELECT * FROM ${table}`).all());
    for (const identifier of [s.id, 'attempt', 'private-provider', 'private-generation']) assert.equal(retained.includes(identifier), false);
  }
});

test('AIT-295: open budget and spend reservations retain billing rows and back off until both settle', async t => {
  const { storage, handlers, erased } = fixture(t), session = storage.create();
  const ledger = new SQLiteBudgetLedger(storage), spend = createSpendCap({ storage, account: 'pending', capMicro: 100 });
  ledger.admit({ attemptId: 'pending', sessionId: session.id, lane: 'concept', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim('pending'); claim.consume();
  const reservation = spend.reserve(100, { attemptId: 'pending' }); spend.dispatch(reservation);
  storage.erase(session.id);
  const journal = storage.read(session.id);
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  const retry = storage.db.prepare('SELECT attempts,retry_at FROM retirement_pending WHERE session_id=?').get(session.id);
  assert.equal(retry.attempts, 1); assert.ok(retry.retry_at > Date.now());
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 0, more: false });
  assert.throws(() => storage.purgeRetired(session.id), /billing unsettled/);
  ledger.settle(claim.claimId, { attemptId: 'pending', outcome: 'completed', chargedMicro: 40, usage: { inputTokens: 1, outputTokens: 1 } });
  // The spend dispatch is still active after its budget receipt commits.
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  assert.throws(() => storage.purgeRetired(session.id), /spend unsettled/);
  assert.equal(ledger.get('pending').settled_micro, 40);
  assert.deepEqual(storage.read(session.id), journal);
  assert.equal(erased.length, 0, 'host cleanup waits for billing');
  spend.settle(reservation, 40);
  const total = spend.snapshot();
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
  assert.equal(ledger.get('pending'), undefined);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM spend_reservations').get().n, 0);
  assert.deepEqual(spend.snapshot(), total);
});

test('AIT-295: uncertain and estimated provider receipts remain reconcilable until final acknowledgement', async t => {
  const { storage, handlers } = fixture(t), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  ledger.admit({ attemptId: 'receipt', sessionId: session.id, lane: 'reaction', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), providerCost: { generationId: 'gen-retention', retryAt: Date.now() + 60_000 } });
  const claim = ledger.claim('receipt'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'receipt', outcome: 'uncertain' });
  storage.erase(session.id);
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  ledger.reconcileCost('receipt', { chargedMicro: 50, generationId: 'gen-retention', estimated: true });
  ledger.acknowledgeCost('receipt', Date.now() + 60_000);
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  ledger.reconcileCost('receipt', { chargedMicro: 40, generationId: 'gen-retention' });
  assert.throws(() => storage.purgeRetired(session.id), /billing unsettled/, 'deferred reconciliation still owns its receipt');
  ledger.acknowledgeCost('receipt');
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM budget_corrections').get().n, 2);
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM budget_corrections').get().n, 0);
});

for (const erased of [true, false]) test(`AIT-297: removed plugin ends scheduled retries only for ${erased ? 'erased' : 'live'} sessions`, async t => {
  const { storage, handlers } = fixture(t), session = storage.create();
  const ledger = new SQLiteBudgetLedger(storage), spend = createSpendCap({ storage, account: 'removed', capMicro: 100 });
  let clock = Date.now();
  ledger.admit({ attemptId: 'removed', sessionId: session.id, lane: 'reaction', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
    providerCost: { plugin: 'mock', generationId: 'removed-generation', estimateMicro: 60, settledAt: 0 } });
  const claim = ledger.claim('removed'); claim.consume();
  const reservation = spend.reserve(100, { attemptId: 'removed' }); spend.dispatch(reservation);
  ledger.settle(claim.claimId, { attemptId: 'removed', outcome: 'uncertain' });
  spend.uncertain(reservation);
  const registry = new PluginRegistry().register({ ...createMockReasoning(), async reconcileCost() { return null; } });
  const original = createPluginRuntime({ storage, registry, now: () => clock, costReconciliationWindowMs: 1000 });
  clock = Date.now() + 1001;
  await original.reconcileCosts();
  assert.ok(JSON.parse(ledger.get('removed').provider_cost_json).retryAt > clock, 'plugin initially schedules an estimate retry');
  if (erased) {
    storage.erase(session.id);
    assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  }
  // A restart with the provider removed must not leave erased metadata waiting forever.
  clock += 1001;
  const runtime = createPluginRuntime({ storage, registry: new PluginRegistry(), now: () => clock });
  const receipt = ledger.get('removed'), totals = spend.snapshot();
  await runtime.reconcileCosts({ dryRun: true });
  assert.deepEqual(ledger.get('removed'), receipt, 'dry-run cannot acknowledge a missing provider');
  await runtime.reconcileCosts();
  const after = ledger.get('removed');
  assert.equal(after.settled_micro, receipt.settled_micro, 'retain the conservative recorded charge');
  assert.equal(after.cost_reconciliation_json, receipt.cost_reconciliation_json, 'do not invent provider evidence');
  assert.deepEqual(spend.snapshot(), totals);
  if (erased) {
    assert.equal(JSON.parse(after.provider_cost_json).retryAt, null, 'missing plugin releases the erased-session retry');
    storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
    assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
    assert.throws(() => storage.get(session.id), /not found/i);
    assert.deepEqual(spend.snapshot(), totals, 'retirement preserves deployment spend totals');
  } else {
    assert.deepEqual(after, receipt, 'live receipts remain available if the plugin returns');
  }
});

test('AIT-295: live retirement retries keep bounded billing behavior across restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const path = await temporaryDb();
  let storage = bindSQLiteClock(new SQLiteStorage(path)), handlers, calls = 0;
  t.after(async () => { await handlers?.close(); storage.close(); });
  const session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  ledger.admit({ attemptId: 'live-retry', sessionId: session.id, lane: 'reaction', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), providerCost: { generationId: 'live-generation' } });
  const claim = ledger.claim('live-retry'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'live-retry', outcome: 'uncertain' });
  ledger.acknowledgeCost('live-retry', Date.now() + 60_000);
  t.mock.timers.setTime(Date.now() + 3_600_001);
  handlers = createHandlers({ storage, consent: mockConsent, host: { retired() { calls++; throw new Error('offline'); } } });
  age(storage, session.id);
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 0, failed: 1, more: false });
  assert.equal(calls, 1, 'live retirement reaches the host after the bounded receipt window');
  await handlers.close(); storage.close();
  storage = bindSQLiteClock(new SQLiteStorage(path));
  handlers = createHandlers({ storage, consent: mockConsent, host: { retired() { calls++; } } });
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 1, failed: 0, more: false });
  assert.equal(calls, 2);
  assert.throws(() => storage.get(session.id), /not found/i);
});

test('AIT-295: existing tombstones migrate in bounded pages without resetting pending retries', async t => {
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path);
  // Reproduce the old schema's erase trigger, before opening with the migration.
  storage.db.exec('DROP TRIGGER retirement_erase');
  for (const id of ['a-pending', 'b-legacy', 'c-legacy']) storage.erase(storage.create({ id }).id);
  storage.db.prepare('INSERT INTO retirement_pending(session_id,owner_hash,attempts,retry_at) VALUES (?,?,3,?)')
    .run('a-pending', storage.get('a-pending').ownerHash, Date.now() + 3_600_000);
  storage.close(); storage = new SQLiteStorage(path);
  const handlers = createHandlers({ storage, consent: mockConsent });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.deepEqual(await handlers.retire({ before: 0, limit: 1 }), { retired: 0, failed: 0, more: true });
  assert.equal(storage.db.prepare('SELECT attempts FROM retirement_pending WHERE session_id=?').get('a-pending').attempts, 3);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM retirement_pending').get().n, 1);
  assert.deepEqual(await handlers.retire({ before: 0, limit: 1 }), { retired: 1, failed: 0, more: true });
  assert.throws(() => storage.get('b-legacy'), /not found/i);
  assert.ok(storage.get('c-legacy').tombstone);
  assert.deepEqual(await handlers.retire({ before: 0, limit: 1 }), { retired: 1, failed: 0, more: false });
  assert.deepEqual(await handlers.retire({ before: 0, limit: 1 }), { retired: 0, failed: 0, more: false });
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0, limit: 1 }), { retired: 1, failed: 0, more: false });
});

for (const state of ['live', 'erased']) for (const receipt of ['terminal estimate', 'uncertain without cost lookup', 'uncertain without provider record', 'voice estimate', 'uncertain voice']) {
  test(`AIT-295: ${state} ${receipt} retires with conservative spend totals`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { storage, handlers } = fixture(t), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
    const spend = createSpendCap({ storage, account: 'terminal', capMicro: 100 });
    ledger.admit({ attemptId: 'terminal', sessionId: session.id, lane: receipt.includes('voice') ? 'voice' : 'reaction', maxMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
      ...(!receipt.includes('voice') && receipt !== 'uncertain without provider record'
        ? { providerCost: { plugin: 'no-cost-lookup', generationId: 'terminal-generation' } } : {}) });
    const claim = ledger.claim('terminal'); claim.consume();
    const reservation = spend.reserve(100, { attemptId: 'terminal' }); spend.dispatch(reservation); spend.uncertain(reservation);
    if (receipt.includes('voice')) {
      ledger.settleVoice(claim.claimId, { attemptId: 'terminal', outcome: receipt === 'uncertain voice' ? 'uncertain' : 'completed',
        closureConfirmed: true, usage: { providerSeconds: 1, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 1,
          upstreamMicro: 40, visitorMicro: 0, costEstimated: true } });
    } else {
      ledger.settle(claim.claimId, { attemptId: 'terminal', outcome: 'uncertain' });
      if (receipt === 'terminal estimate') {
        ledger.reconcileCost('terminal', { chargedMicro: 50, generationId: 'terminal-generation', estimated: true });
        ledger.acknowledgeCost('terminal', null, 3);
      }
    }
    t.mock.timers.setTime(Date.now() + 3_600_001);
    if (state === 'erased') storage.erase(session.id);
    else age(storage, session.id);
    const total = spend.snapshot();
    assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 1, failed: 0, more: false });
    assert.throws(() => storage.get(session.id), /not found/i);
    assert.deepEqual(spend.snapshot(), total);
    assert.deepEqual({ ...storage.db.prepare('SELECT * FROM retired_spend WHERE account=?').get('terminal') },
      { account: 'terminal', spent_micro: 0, reserved_micro: 0, uncertain_micro: 100, breached: 0 });
    assert.equal(ledger.get('terminal'), undefined);
    assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 0, failed: 0, more: false }, 'terminal receipts cannot fail every sweep');
  });
}

for (const via of ['erase route', 'operator erase', 'visitor erase', 'operator retry']) {
  test(`AIT-295: ${via} finishes the erase hook before queuing and retiring`, async t => {
    const storage = new SQLiteStorage(), session = storage.create({ ownerToken: testToken }), order = [];
    let finishErase, started;
    const entered = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { finishErase = resolve; });
    const host = {
      async erased() { order.push('erase started'); started(); await barrier; order.push('erase finished'); },
      retired() { order.push('retired'); },
      eraseVisitorForOwnerHash() { order.push('visitor erased'); },
    };
    const handlers = createHandlers({ storage, consent: mockConsent, host });
    const sweeper = createHandlers({ storage, consent: mockConsent, host });
    t.after(async () => { finishErase(); await handlers.close(); await sweeper.close(); storage.close(); });
    if (via === 'operator retry') storage.erase(session.id);
    const erasing = via === 'erase route'
      ? handlers.handle(request(`${session.id}/erase`, { method: 'POST' }))
      : handlers.eraseSession({ sessionId: session.id, visitor: via === 'visitor erase' });
    await entered;
    assert.deepEqual(storage.pendingRetirements(10), [], 'erase in flight is not eligible');
    if (via !== 'operator retry') assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM retirement_pending').get().n, 0);
    assert.deepEqual(await sweeper.retire({ before: 0 }), { retired: 0, failed: 0, more: false });
    assert.deepEqual(order, ['erase started']);
    assert.ok(storage.get(session.id).tombstone);
    finishErase();
    const result = await erasing;
    if (via === 'erase route') assert.equal(result.status, 200);
    assert.deepEqual(storage.pendingRetirements(10), [session.id]);
    assert.deepEqual(await sweeper.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
    assert.deepEqual(order, ['erase started', 'erase finished', ...(via === 'visitor erase' ? ['visitor erased'] : []), 'retired']);
  });
}

test('AIT-295: a failed visitor cleanup waits for sibling tombstone hooks before queuing', async t => {
  const storage = new SQLiteStorage(), first = storage.create({ ownerToken: testToken }), second = storage.create({ ownerToken: testToken });
  for (const session of [first, second]) storage.erase(session.id);
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { finish = resolve; });
  const handlers = createHandlers({ storage, consent: mockConsent, host: {
    async erased({ sessionId }) {
      if (sessionId === first.id) throw new Error('cleanup failed');
      started(); await barrier;
    },
    eraseVisitorForOwnerHash() { assert.fail('visitor cleanup cannot succeed'); },
    retired() { assert.fail('retirement must wait for every erase hook'); },
  } });
  t.after(async () => { finish(); await handlers.close(); storage.close(); });
  const erasing = handlers.eraseSession({ sessionId: first.id, visitor: true });
  const rejected = assert.rejects(erasing, /cleanup failed/);
  await entered;
  // Flush rejection continuations while the sibling hook remains in flight.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(storage.pendingRetirements(10), []);
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 0, more: false });
  finish(); await rejected;
  assert.deepEqual(new Set(storage.pendingRetirements(10)), new Set([first.id, second.id]));
});

test('unauthorized reads cannot renew another session retention deadline', async t => {
  const { storage, handlers } = fixture(t), s = storage.create({ ownerToken: 'another-owner' }); age(storage, s.id);
  assert.equal((await handlers.handle(request(s.id))).status, 404);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
});


test('host retired deletes FK rows before core purge, preserving host retention decisions', async t => {
  const storage = new SQLiteStorage();
  storage.db.exec(`CREATE TABLE host_parent (id TEXT PRIMARY KEY, conversation TEXT REFERENCES sessions(id));
    CREATE TABLE host_child (session_id TEXT REFERENCES host_parent(id));
    CREATE TABLE legal_proof (session_id TEXT, proof TEXT);
    CREATE INDEX legal_proof_session ON legal_proof(session_id);`);
  const session = storage.create(); age(storage, session.id);
  storage.db.prepare('INSERT INTO host_parent VALUES (?,?)').run(session.id, session.id);
  storage.db.prepare('INSERT INTO host_child VALUES (?)').run(session.id);
  storage.db.prepare('INSERT INTO legal_proof VALUES (?,?)').run(session.id, 'retain by host policy');
  const handlers = createHandlers({ storage, consent: mockConsent, host: {
    erased() { assert.fail('retire must use its dedicated hook'); },
    retired({ sessionId, ownerHash }) {
      assert.ok(storage.get(sessionId).tombstone);
      assert.equal(ownerHash, session.ownerHash);
      storage.db.prepare('DELETE FROM host_child WHERE session_id=?').run(sessionId);
      storage.db.prepare('DELETE FROM host_parent WHERE conversation=?').run(sessionId);
    },
  } });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 1, failed: 0, more: false });
  assert.deepEqual(storage.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM host_child').get().n, 0);
  assert.equal(storage.db.prepare('SELECT proof FROM legal_proof WHERE session_id=?').get(session.id).proof, 'retain by host policy');
});

test('one failing hook does not block the batch, checkpoint or later batches', async t => {
  const storage = new SQLiteStorage();
  const bad = storage.create(), good = storage.create();
  for (const s of [bad, good]) age(storage, s.id);
  let fail = true, checkpoints = 0;
  const logs = [];
  const checkpoint = storage.checkpointErasure.bind(storage);
  storage.checkpointErasure = () => { checkpoints++; checkpoint(); };
  const handlers = createHandlers({ storage, consent: mockConsent, log: entry => logs.push(entry), host: { retired({ sessionId }) {
    if (sessionId === bad.id && fail) throw new Error('offline');
  } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 1, failed: 1, more: false });
  assert.ok(checkpoints >= 3);
  assert.deepEqual(logs, [{ event: 'session.retirement.failed', sessionId: bad.id, error: 'Error' }]);
  assert.ok(storage.get(bad.id).tombstone);
  assert.throws(() => storage.get(good.id), /not found/i);
  const pending = storage.db.prepare('SELECT * FROM retirement_pending').get();
  assert.equal(pending.attempts, 1); assert.equal(pending.owner_hash, bad.ownerHash);
  assert.ok(pending.retry_at > Date.now());
  const later = storage.create(); age(storage, later.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
  fail = false;
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, failed: 0, more: false });
});

test('explicit core list covers initialized core session tables and respects child FKs', t => {
  const { storage } = fixture(t);
  new SQLiteBudgetLedger(storage);
  createSpendCap({ storage, account: 'schema', capMicro: 100 });
  createVoiceCap({ storage }); createUIRenderLimiter({ storage });
  for (const { name } of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (storage.db.prepare(`PRAGMA table_info("${name}")`).all().some(c => c.name === 'session_id')) {
      assert.ok(CORE_RETIREMENT_TABLES.includes(name), `unlisted core table: ${name}`);
    }
  }
  // Exercise a child-to-child FK, independent of table creation/list order.
  storage.db.exec('CREATE TABLE IF NOT EXISTS lane_failures (session_id TEXT REFERENCES sessions(id)); ALTER TABLE lane_failures ADD COLUMN content_id TEXT REFERENCES content(id)');
  const order = storage.retirementDeleteOrder();
  assert.ok(order.indexOf('lane_failures') < order.indexOf('content'));
  for (const name of order) for (const fk of storage.db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
    if (order.includes(fk.table)) assert.ok(order.indexOf(name) < order.indexOf(fk.table));
  }
});

for (const order of ['expire-first', 'retire-first']) {
  test(`24h idle retention is not extended by expiry (${order})`, async t => {
    const { storage, handlers } = fixture(t);
    const day = 24 * 60 * 60 * 1000, now = Date.now(), lastTurn = now - day - 1;
    const session = storage.create({ demo: true });
    storage.append(session.id, 'turn.final', {
      id: 'last-turn', role: 'user', content: 'input at T', at: new Date(lastTurn).toISOString(),
    });
    age(storage, session.id, lastTurn);
    const cutoff = now - day; // sweeps at T + 24h + epsilon, both with a 24h cutoff
    if (order === 'expire-first') {
      await handlers.expire(cutoff);
      assert.ok(storage.read(session.id).some(e => e.type === 'turn.withdrawn'));
      assert.equal(storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(session.id).last_activity,
        lastTurn, 'expiry events and completed rebuild jobs must not renew activity');
    }
    assert.deepEqual(await handlers.retire({ before: cutoff }), { retired: 1, failed: 0, more: false });
    if (order === 'retire-first') await handlers.expire(cutoff);
    assert.throws(() => storage.get(session.id), /not found/i);
  });
}

test('system events and async leases do not renew activity; independent host activity does', async t => {
  const { storage } = fixture(t), session = storage.create();
  age(storage, session.id);
  let finish;
  const pending = storage.systemWork(async () => {
    const release = storage.hold(session.id);
    await new Promise(resolve => { finish = resolve; });
    storage.append(session.id, 'session.paused', { paused: true });
    storage.touch(session.id);
    release();
  });
  finish(); await pending;
  assert.equal(storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(session.id).last_activity, 1);
  // The same event outside maintenance is an explicit host change.
  storage.append(session.id, 'session.paused', { paused: false });
  assert.ok(storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(session.id).last_activity > 1);
});

test('a never-settling retired hook times out per session, backs off and checkpoints', { timeout: 2000 }, async t => {
  const storage = new SQLiteStorage(), logs = [];
  const hung = storage.create({ id: 'a-hung' }), good = storage.create({ id: 'z-good' });
  for (const session of [hung, good]) age(storage, session.id);
  let checkpoints = 0, calls = 0;
  const checkpoint = storage.checkpointErasure.bind(storage);
  storage.checkpointErasure = () => { checkpoints++; checkpoint(); };
  const handlers = createHandlers({ storage, consent: mockConsent, retiredHookTimeoutMs: 20,
    log: entry => logs.push(entry), host: { retired({ sessionId }) {
      calls++;
      if (sessionId === hung.id) return new Promise(() => {});
    } },
  });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 1, failed: 1, more: false });
  assert.equal(calls, 2); assert.ok(checkpoints >= 3);
  assert.ok(storage.get(hung.id).tombstone);
  assert.throws(() => storage.get(good.id), /not found/i);
  const pending = storage.db.prepare('SELECT attempts,retry_at FROM retirement_pending WHERE session_id=?').get(hung.id);
  assert.equal(pending.attempts, 1); assert.ok(pending.retry_at > Date.now());
  assert.deepEqual(logs, [{ event: 'session.retirement.failed', sessionId: hung.id, error: 'RetirementHookTimeoutError' }]);
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 0, failed: 0, more: false });
});

for (const via of ['idle retirement', 'erase route']) for (const lane of ['reaction', 'voice']) {
  test(`AIT-421: ${via} cannot purge a ${lane} receipt unseen by the host`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const storage = bindSQLiteClock(new SQLiteStorage()), session = storage.create({ ownerToken: testToken });
    const ledger = new SQLiteBudgetLedger(storage);
    ledger.admit({ attemptId: 'late', sessionId: session.id, lane, maxMicro: 100, maxVisitorMicro: lane === 'voice' ? 50 : 0,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
      ...(lane === 'reaction' ? { providerCost: { generationId: 'late-generation' } } : {}) });
    const claim = ledger.claim('late'); claim.consume();
    if (lane === 'voice') ledger.settleVoice(claim.claimId, { attemptId: 'late', outcome: 'uncertain' });
    else { ledger.settle(claim.claimId, { attemptId: 'late', outcome: 'uncertain' }); ledger.acknowledgeCost('late'); }
    // Exhaust the receipt wait without mixing a fixture date with a real clock.
    t.mock.timers.setTime(Date.now() + 3_600_001);
    let seen, committed, receiptError, hookInfo, finish, entered;
    const barrier = new Promise(resolve => { finish = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const handlers = createHandlers({ storage, consent: mockConsent, host: {
      async retired(info) { hookInfo = info; seen = ledger.get('late').settled_micro; entered(); await barrier; },
    } });
    t.after(async () => { finish(); await handlers.close(); storage.close(); });
    if (via === 'erase route') assert.equal((await handlers.handle(request(`${session.id}/erase`, { method: 'POST' }))).status, 200);
    else age(storage, session.id);
    const retiring = handlers.retire({ before: 2 });
    await started;
    try {
      if (lane === 'reaction') ledger.reconcileCost('late', { chargedMicro: 250, generationId: 'late-generation' });
      else ledger.reconcileVoice('late', { closureConfirmed: true, providerSessionId: 'late-voice', usage: {
        providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 250, visitorMicro: 125 } });
    } catch (error) { receiptError = error; }
    committed = ledger.get('late').settled_micro;
    finish();
    assert.deepEqual(await retiring, { retired: 1, failed: 0, more: false });
    assert.equal(committed, seen, 'a receipt must not commit above the host snapshot before purge');
    assert.match(receiptError?.message ?? '', /sealed/);
    assert.equal(hookInfo.attempts[0].attemptId, 'late');
    assert.equal(hookInfo.attempts[0].settledMicro, seen);
    assert.deepEqual(hookInfo.attempts[0].corrections, []);
    assert.equal(ledger.get('late'), undefined);
    assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM budget_corrections').get().n, 0);
  });
}

for (const lane of ['reaction', 'voice']) test(`AIT-421: ${lane} receipt during erased is included in the final retirement handoff`, async t => {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: testToken }), ledger = new SQLiteBudgetLedger(storage);
  ledger.admit({ attemptId: 'before-seal', sessionId: session.id, lane, maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
    ...(lane === 'reaction' ? { providerCost: { generationId: 'private-generation' } } : {}) });
  const claim = ledger.claim('before-seal'); claim.consume();
  if (lane === 'voice') ledger.settleVoice(claim.claimId, { attemptId: 'before-seal', outcome: 'uncertain' });
  else ledger.settle(claim.claimId, { attemptId: 'before-seal', outcome: 'uncertain' });
  const settledAtMs = ledger.get('before-seal').settled_at_ms;
  let snapshot;
  const handlers = createHandlers({ storage, consent: mockConsent, host: {
    async erased() {
      await Promise.resolve();
      if (lane === 'reaction') {
        ledger.reconcileCost('before-seal', { chargedMicro: 250, generationId: 'private-generation' });
        ledger.acknowledgeCost('before-seal');
      } else ledger.reconcileVoice('before-seal', { closureConfirmed: true, providerSessionId: 'private-voice', usage: {
        providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 250, visitorMicro: 125 } });
    },
    retired({ attempts }) { snapshot = attempts; },
  } });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.equal((await handlers.handle(request(`${session.id}/erase`, { method: 'POST' }))).status, 200);
  const corrections = ledger.corrections('before-seal');
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].settledMicro, 250);
  assert.equal(snapshot[0].settledVisitorMicro, lane === 'voice' ? 125 : 0);
  assert.equal(snapshot[0].settledAtMs, settledAtMs);
  assert.equal(snapshot[0].final, true);
  assert.deepEqual(snapshot[0].corrections, corrections);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
});

test('AIT-421: live receipts defer retirement, then a final receipt reaches the host before purge', async t => {
  const { storage, handlers, erased } = fixture(t), session = storage.create(), ledger = new SQLiteBudgetLedger(storage);
  ledger.admit({ attemptId: 'awaiting', sessionId: session.id, lane: 'reaction', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), providerCost: { generationId: 'awaiting-generation' } });
  const claim = ledger.claim('awaiting'); claim.consume();
  ledger.settle(claim.claimId, { attemptId: 'awaiting', outcome: 'uncertain' });
  ledger.acknowledgeCost('awaiting', Date.now() + 60_000);
  age(storage, session.id);
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 0, failed: 1, more: false });
  assert.equal(erased.length, 0);
  assert.ok(storage.get(session.id).tombstone);
  ledger.reconcileCost('awaiting', { chargedMicro: 250, generationId: 'awaiting-generation' });
  ledger.acknowledgeCost('awaiting');
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 2 }), { retired: 1, failed: 0, more: false });
  assert.equal(erased[0].attempts[0].settledMicro, 250);
  assert.equal(erased[0].attempts[0].final, true);
});

test('AIT-421: active billing has a durable bounded wait and the seal survives a failed hook and restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const path = await temporaryDb();
  let storage = bindSQLiteClock(new SQLiteStorage(path)), ledger = new SQLiteBudgetLedger(storage), handlers, snapshot;
  const session = storage.create();
  ledger.admit({ attemptId: 'open', sessionId: session.id, lane: 'concept', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim('open'); claim.consume();
  storage.erase(session.id);
  handlers = createHandlers({ storage, consent: mockConsent, host: { retired({ attempts }) { snapshot = attempts; throw new Error('offline'); } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  const deadline = storage.db.prepare('SELECT billing_deadline_ms FROM retirement_pending').get().billing_deadline_ms;
  assert.equal(deadline, Date.now() + 3_600_000);
  await handlers.close(); storage.close();
  storage = bindSQLiteClock(new SQLiteStorage(path)); ledger = new SQLiteBudgetLedger(storage);
  handlers = createHandlers({ storage, consent: mockConsent, host: { retired({ attempts }) { snapshot = attempts; throw new Error('offline'); } } });
  t.mock.timers.setTime(deadline);
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 0, failed: 1, more: false });
  assert.equal(snapshot[0].final, false);
  assert.equal(snapshot[0].settledMicro, null);
  assert.equal(snapshot[0].maxMicro, 100);
  assert.throws(() => ledger.settle(claim.claimId, { attemptId: 'open', outcome: 'completed', chargedMicro: 250, usage: { inputTokens: 1, outputTokens: 1 } }), /sealed/);
  assert.throws(() => ledger.admit({ attemptId: 'new', sessionId: session.id, lane: 'concept', maxMicro: 1,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) }), /sealed/);
  await handlers.close(); storage.close();
  storage = bindSQLiteClock(new SQLiteStorage(path)); ledger = new SQLiteBudgetLedger(storage);
  assert.equal(ledger.recover(), 0, 'restart recovery must not mutate the sealed host snapshot');
  assert.deepEqual(ledger.pendingCosts(), []);
  assert.deepEqual(ledger.deferredCosts(Date.now()), []);
  handlers = createHandlers({ storage, consent: mockConsent, host: { retired({ attempts }) { assert.deepEqual(attempts, snapshot); } } });
  storage.db.prepare('UPDATE retirement_pending SET retry_at=0').run();
  assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
  assert.throws(() => storage.get(session.id), /not found/i);
});

test('AIT-427: removing wait_for_billing preserves pending seals, deadlines and retries across restart', async t => {
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path);
  t.after(() => storage.close());
  if (!storage.db.prepare('PRAGMA table_info(retirement_pending)').all().some(c => c.name === 'wait_for_billing')) {
    storage.db.exec('ALTER TABLE retirement_pending ADD COLUMN wait_for_billing INTEGER NOT NULL DEFAULT 0');
  }
  // Reproduce AIT-421's trigger as well as its populated legacy column.
  storage.db.exec(`DROP TRIGGER retirement_erase;
    CREATE TRIGGER retirement_erase AFTER UPDATE ON sessions
      WHEN json_extract(NEW.snapshot,'$.tombstone') IS NOT NULL AND retirement_ready(NEW.id)=1 BEGIN
      INSERT OR IGNORE INTO retirement_pending(session_id,owner_hash,wait_for_billing)
        VALUES (NEW.id,json_extract(NEW.snapshot,'$.ownerHash'),1); END;`);
  const expected = [];
  for (const sealed of [0, 1]) {
    const session = storage.create(); storage.erase(session.id);
    const deadline = Date.now() + 3_600_000, retryAt = Date.now() + 60_000;
    storage.db.prepare(`UPDATE retirement_pending SET wait_for_billing=?,attempts=3,retry_at=?,billing_sealed=?,billing_deadline_ms=?
      WHERE session_id=?`).run(sealed, retryAt, sealed, deadline, session.id);
    expected.push({ session_id: session.id, owner_hash: session.ownerHash, attempts: 3, retry_at: retryAt,
      billing_sealed: sealed, billing_deadline_ms: deadline });
  }
  for (let restart = 0; restart < 2; restart++) {
    storage.close(); storage = new SQLiteStorage(path);
    assert.equal(storage.db.prepare('PRAGMA table_info(retirement_pending)').all().some(c => c.name === 'wait_for_billing'), false);
    for (const row of expected) assert.deepEqual({ ...storage.db.prepare('SELECT * FROM retirement_pending WHERE session_id=?').get(row.session_id) }, row);
  }
  const fresh = storage.create(); storage.erase(fresh.id);
  assert.equal(storage.retirementOwnerHash(fresh.id), fresh.ownerHash, 'the migrated erase trigger still queues retirement');
});

for (const receipt of ['observation', 'cost reconciliation', 'terminal', 'priced terminal', 'voice reconciliation', 'voice terminal']) {
  test(`AIT-427: seal-refused ${receipt} reaches retained spend without reopening the attempt`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const path = await temporaryDb();
    let storage = bindSQLiteClock(new SQLiteStorage(path)), ledger = new SQLiteBudgetLedger(storage), handlers;
    t.after(async () => { await handlers?.close(); storage.close(); });
    const session = storage.create(), voice = receipt.startsWith('voice');
    let spend = createSpendCap({ storage, account: 'sealed-account', capMicro: 1000 });
    storage.db.prepare('INSERT INTO retired_spend VALUES (?,?,?,?,?)').run('sealed-account', 20, 10, 5, 0);
    ledger.admit({ attemptId: 'refused', sessionId: session.id, lane: voice ? 'voice' : 'reaction', maxMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
      ...(!voice ? { providerCost: { generationId: 'private-generation' } } : {}) });
    const claim = ledger.claim('refused'); claim.consume();
    const reservation = spend.reserve(100, { attemptId: 'refused', provider: 'private-provider' });
    spend.dispatch(reservation); spend.uncertain(reservation);
    if (receipt === 'voice reconciliation') ledger.settleVoice(claim.claimId, { attemptId: 'refused', outcome: 'uncertain' });
    else if (['observation', 'cost reconciliation'].includes(receipt)) ledger.settle(claim.claimId, { attemptId: 'refused', outcome: 'uncertain' });
    storage.erase(session.id);
    assert.throws(() => storage.sealRetirement(session.id), /unsettled/);
    t.mock.timers.setTime(Date.now() + 3_600_001);
    const snapshot = storage.sealRetirement(session.id), frozen = ledger.get('refused');
    const voiceReceipt = { attemptId: 'refused', outcome: 'completed', closureConfirmed: true, providerSessionId: 'private-voice', usage: {
      providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 250, visitorMicro: 125 } };
    const apply = () => {
      if (receipt === 'observation') return ledger.observeCost('refused', { chargedMicro: 250, generationId: 'private-generation' });
      if (receipt === 'cost reconciliation') return ledger.reconcileCost('refused', { chargedMicro: 250, generationId: 'private-generation' });
      if (receipt === 'voice reconciliation') return ledger.reconcileVoice('refused', voiceReceipt);
      if (receipt === 'voice terminal') return ledger.settleVoice(claim.claimId, voiceReceipt);
      return ledger.settle(claim.claimId, { attemptId: 'refused', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 },
        ...(receipt === 'terminal' ? { chargedMicro: 250 } : {}) }, { inputMicro: 100, outputMicro: 150 });
    };
    // Invalid identity and estimates cannot turn a hold into confirmed spend.
    if (receipt === 'cost reconciliation') {
      assert.throws(() => ledger.reconcileCost('refused', { chargedMicro: 250, generationId: 'wrong-generation' }), /not-admitted/);
      assert.throws(() => ledger.reconcileCost('refused', { chargedMicro: 250, generationId: 'private-generation', estimated: true }), /sealed/);
      assert.equal(spend.snapshot().spentMicro, 20);
      assert.equal(spend.snapshot().uncertainMicro, 105);
    }
    assert.throws(apply, /sealed/);
    assert.deepEqual(ledger.get('refused'), frozen);
    assert.deepEqual(ledger.corrections('refused'), []);
    const total = { spentMicro: 270, reservedMicro: 10, uncertainMicro: 5, capMicro: 1000, breached: true };
    assert.deepEqual(spend.snapshot(), total, 'host accounting records the charge despite the frozen attempt');
    assert.throws(apply, /sealed/);
    assert.deepEqual(spend.snapshot(), total, 'receipt replay never adds the same charge twice');
    storage.close(); storage = bindSQLiteClock(new SQLiteStorage(path)); ledger = new SQLiteBudgetLedger(storage);
    spend = createSpendCap({ storage, account: 'sealed-account', capMicro: 1000 });
    assert.deepEqual(storage.sealRetirement(session.id), snapshot);
    assert.deepEqual(spend.snapshot(), total, 'the host charge survives restart before purge');
    handlers = createHandlers({ storage, consent: mockConsent, host: { retired({ attempts }) { assert.deepEqual(attempts, snapshot); } } });
    assert.deepEqual(await handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
    assert.deepEqual({ ...storage.db.prepare('SELECT * FROM retired_spend WHERE account=?').get('sealed-account') },
      { account: 'sealed-account', spent_micro: 270, reserved_micro: 10, uncertain_micro: 5, breached: 1 });
    assert.deepEqual(spend.snapshot(), total);
    assert.equal(ledger.get('refused'), undefined);
    assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM spend_reservations').get().n, 0);
    assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM budget_corrections').get().n, 0);
    assert.throws(() => storage.get(session.id), /not found/i);
  });
}
