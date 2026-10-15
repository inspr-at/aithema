import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { createUIRenderLimiter } from '../src/ui-render-limits.js';
import { SQLiteBudgetLedger, createSpendCap, createVoiceCap } from '../src/index.js';
import { testToken, ownedRequest, mockConsent } from '../../../test/helpers.js';

const request = path => ownedRequest(`http://localhost/api/sessions/${path}`);
function fixture(t) {
  const storage = new SQLiteStorage(), erased = [];
  const handlers = createHandlers({ storage, consent: mockConsent, host: { erased: info => erased.push(info) } });
  t.after(async () => { await handlers.close(); storage.close(); });
  return { storage, handlers, erased };
}
const age = (storage, id, at = 1) => storage.db.prepare('UPDATE session_retention SET last_activity=? WHERE session_id=?').run(at, id);

test('retire erases whole sessions, calls the host, bounds batches and is idempotent', async t => {
  const { storage, handlers, erased } = fixture(t);
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
    age(storage, id);
  }
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 2, more: true });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 1, more: false });
  assert.deepEqual(await handlers.retire({ before: 2, limit: 2 }), { retired: 0, more: false });
  for (const { name } of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (storage.db.prepare(`PRAGMA table_info("${name}")`).all().some(c => c.name === 'session_id')) {
      assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0, name);
    }
  }
  assert.deepEqual(storage.list(), []);
  assert.equal(erased.length, 3);
  assert.ok(erased.every(info => info.ownerToken === undefined && ids.includes(info.sessionId)));
  for (const id of ids) assert.equal((await handlers.handle(request(`${id}/export`))).status, 404);
});

test('last activity uses server events and authorized reads, strict cutoff, and protects a live stream', async t => {
  const { storage, handlers } = fixture(t);
  const s = storage.create({ ownerToken: testToken });
  age(storage, s.id, 100);
  assert.deepEqual(await handlers.retire({ before: 100, limit: 1 }), { retired: 0, more: false });
  await handlers.handle(request(s.id));
  assert.deepEqual(await handlers.retire({ before: Date.now() - 1000, limit: 1 }), { retired: 0, more: false });
  age(storage, s.id);
  storage.postTurn(s.id, 'one', Buffer.from('one'), 'hello');
  assert.deepEqual(await handlers.retire({ before: Date.now() - 1000, limit: 1 }), { retired: 0, more: false });
  const stream = await handlers.handle(request(`${s.id}/events`));
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, more: false });
  await stream.body.cancel(); await handlers.idle(); age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
});

test('many tombstones never enter expire or retire candidate queries', async t => {
  const { storage, handlers } = fixture(t);
  for (let i = 0; i < 1000; i++) storage.erase(storage.create().id);
  const live = storage.create({ ownerToken: testToken }); age(storage, live.id);
  let reads = 0; const get = storage.get.bind(storage);
  storage.get = id => { reads++; return get(id); };
  storage.list = () => assert.fail('retention must not scan sessions');
  await handlers.expire(2);
  assert.ok(reads <= 3, `expire hydrated ${reads} sessions`);
  reads = 0;
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
  assert.ok(reads < 15, `retire hydrated ${reads} sessions`);
  const plan = storage.db.prepare('EXPLAIN QUERY PLAN SELECT session_id FROM session_retention WHERE busy=0 AND last_activity<? ORDER BY last_activity,session_id LIMIT ?').all(2, 2);
  assert.ok(plan.some(row => /SEARCH.*retention_idle/.test(row.detail)), JSON.stringify(plan));
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
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, more: false });
  assert.equal(storage.get(s.id).tombstone, null);
});

test('an authorized request waiting for its body protects the session', async t => {
  const { storage, handlers } = fixture(t), s = storage.create({ ownerToken: testToken });
  let body;
  const pending = handlers.handle(ownedRequest(`http://localhost/api/sessions/${s.id}/pause`, {
    method: 'POST', duplex: 'half', body: new ReadableStream({ start(controller) { body = controller; } }),
  }));
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 0, more: false });
  body.enqueue(new TextEncoder().encode('{"paused":true}')); body.close();
  assert.equal((await pending).status, 200);
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
});

test('failed host cleanup is queued durably, retried and only then acknowledged', async t => {
  const storage = new SQLiteStorage(); let attempts = 0;
  const handlers = createHandlers({ storage, consent: mockConsent, host: { erased() { if (++attempts === 1) throw new Error('host unavailable'); } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const s = storage.create(); age(storage, s.id);
  await assert.rejects(handlers.retire({ before: 2, limit: 1 }), /host unavailable/);
  assert.ok(storage.get(s.id).tombstone);
  assert.deepEqual(storage.pendingRetirements(10), [s.id]);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
  assert.equal(attempts, 2); assert.deepEqual(storage.list(), []);
  const live = storage.create();
  assert.throws(() => storage.db.prepare('DELETE FROM events WHERE session_id=?').run(live.id), /append only/);
});

test('retirement removes accounting links while preserving deployment spend and daily caps', async t => {
  const { storage, handlers } = fixture(t), s = storage.create();
  const ledger = new SQLiteBudgetLedger(storage);
  const spend = createSpendCap({ storage, account: 'test-account', capMicro: 100 });
  const voice = createVoiceCap({ storage, capMilliseconds: 60_000, perDayMilliseconds: 60_000 });
  const renders = createUIRenderLimiter({ storage, perDay: 1 });
  ledger.admit({ attemptId: 'attempt', sessionId: s.id, lane: 'concept', maxMicro: 100, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const reservation = spend.reserve(100, { attemptId: 'attempt', provider: 'private-provider' });
  spend.record(reservation, { generationId: 'private-generation', chargedMicro: 101 });
  spend.settle(reservation, 101);
  voice.reserve({ attemptId: 'voice-attempt', sessionId: s.id, callId: 'call', maxMilliseconds: 60_000 });
  renders.consume('render-attempt', s.id, () => {});
  const spentBefore = spend.snapshot({ includeBreachReason: true }), voiceBefore = voice.snapshot();
  age(storage, s.id);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
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

test('unauthorized reads cannot renew another session retention deadline', async t => {
  const { storage, handlers } = fixture(t), s = storage.create({ ownerToken: 'another-owner' }); age(storage, s.id);
  assert.equal((await handlers.handle(request(s.id))).status, 404);
  assert.deepEqual(await handlers.retire({ before: 2, limit: 1 }), { retired: 1, more: false });
});
