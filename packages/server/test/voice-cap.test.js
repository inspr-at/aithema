import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createVoiceCap, voiceCapConfig, VOICE_CAP_REASON, VOICE_DAY_CAP_REASON,
  SQLiteBudgetLedger, createPluginRuntime, createHandlers, createFacadeSecrets } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';

const reserve = (cap, attemptId, maxMilliseconds = 60_000, callId = attemptId) =>
  cap.reserve({ attemptId, sessionId: 'session-1', callId, maxMilliseconds });

test('optional decimal minute caps are exact, round headroom down and fail closed on invalid configuration', () => {
  assert.deepEqual(voiceCapConfig(), { capMilliseconds: undefined, perDayMilliseconds: undefined });
  assert.deepEqual(voiceCapConfig({ AITHEMA_VOICE_CAP_MINUTES: '1.25', AITHEMA_VOICE_CAP_MINUTES_PER_DAY: '0' }),
    { capMilliseconds: 75_000, perDayMilliseconds: 0 });
  assert.equal(voiceCapConfig({ AITHEMA_VOICE_CAP_MINUTES: '0.000001' }).capMilliseconds, 0);
  for (const key of ['AITHEMA_VOICE_CAP_MINUTES', 'AITHEMA_VOICE_CAP_MINUTES_PER_DAY']) {
    for (const value of ['', '-1', 'NaN', 'Infinity', '1e2', '1.0000001', ' 1 ', '9007199254740991', 1, null]) {
      assert.throws(() => voiceCapConfig({ [key]: value }), TypeError);
    }
  }
});

test('total cap counts actual duration and outstanding holds; exact boundaries and fractional usage are conservative', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const cap = createVoiceCap({ storage, capMilliseconds: 120_000 });
  const first = reserve(cap, 'first'), second = reserve(cap, 'second');
  assert.equal(cap.reason(1), VOICE_CAP_REASON);
  assert.throws(() => reserve(cap, 'third', 1), { code: 'not-admitted', message: VOICE_CAP_REASON });
  cap.settle(first, 10.0001); cap.settle(first, 10.0001);
  assert.equal(cap.snapshot().spentMilliseconds, 10_001);
  assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
  reserve(cap, 'third', 49_999);
  assert.equal(cap.reason(1), VOICE_CAP_REASON);
  assert.throws(() => cap.settle(first, 0), /already settled/);
  for (const invalid of [-1, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER]) assert.throws(() => cap.settle(second, invalid), TypeError);
});

test('UTC daily cap rolls over independently, retaining prior-day reservations and lifetime usage', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let clock = Date.parse('2026-10-10T23:59:59.000Z');
  const cap = createVoiceCap({ storage, capMilliseconds: 180_000, perDayMilliseconds: 60_000, now: () => clock });
  const first = reserve(cap, 'first');
  assert.equal(cap.reason(1), VOICE_DAY_CAP_REASON);
  clock += 1000;
  assert.equal(cap.reason(60_000), null);
  reserve(cap, 'second');
  assert.equal(cap.snapshot().day, '2026-10-11');
  assert.equal(cap.snapshot().reservedMilliseconds, 120_000);
  assert.equal(cap.snapshot().perDay.reservedMilliseconds, 60_000);
  cap.settle(first, 20);
  assert.equal(cap.snapshot('2026-10-10').perDay.spentMilliseconds, 20_000);
  assert.equal(cap.snapshot().perDay.spentMilliseconds, 0, 'reconciliation retains the original admission day');
  assert.equal(cap.reason(1), VOICE_DAY_CAP_REASON);
  clock += 86_400_000;
  reserve(cap, 'third', 60_000);
  assert.equal(cap.reason(40_001), VOICE_CAP_REASON, 'daily rollover does not reset the total');
});

test('unset caps admit arbitrary duration while either cap may independently disable new calls', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const unlimited = createVoiceCap({ storage });
  reserve(unlimited, 'first', 3_600_000); reserve(unlimited, 'second', 3_600_000);
  assert.equal(unlimited.reason(3_600_000), null);
  assert.equal(createVoiceCap({ storage, capMilliseconds: 0 }).reason(1), VOICE_CAP_REASON);
  assert.equal(createVoiceCap({ storage, perDayMilliseconds: 0 }).reason(1), VOICE_DAY_CAP_REASON);
});

test('reservation replay and recovery extend the same call by remaining duration; uncertain predecessors keep their holds', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
  const first = reserve(cap, 'first', 60_000, 'call');
  assert.deepEqual(reserve(cap, 'first', 60_000, 'call'), first);
  assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
  assert.throws(() => reserve(cap, 'recovery', 50_000, 'call'), { code: 'not-admitted' });
  cap.settle(first, 10);
  reserve(cap, 'recovery', 50_000, 'call');
  assert.equal(cap.snapshot().spentMilliseconds + cap.snapshot().reservedMilliseconds, 60_000);
  assert.throws(() => reserve(cap, 'first', 60_000, 'other-call'), /identity reused/);
  assert.equal(storage.db.prepare('SELECT COUNT(DISTINCT call_id) n FROM voice_cap_reservations').get().n, 1);
});

test('reservations, actual usage and overruns persist across restart', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let cap = createVoiceCap({ storage, capMilliseconds: 120_000, perDayMilliseconds: 120_000 });
  const first = reserve(cap, 'first'), second = reserve(cap, 'second');
  cap.settle(first, 30); const before = cap.snapshot();
  storage.close(); storage = new SQLiteStorage(path);
  cap = createVoiceCap({ storage, capMilliseconds: 120_000, perDayMilliseconds: 120_000 });
  assert.deepEqual(cap.snapshot(), before);
  assert.throws(() => reserve(cap, 'third', 30_001), { code: 'not-admitted' });
  cap.settle(second, 91);
  storage.close(); storage = new SQLiteStorage(path);
  cap = createVoiceCap({ storage, capMilliseconds: 120_000, perDayMilliseconds: 120_000 });
  assert.equal(cap.snapshot().spentMilliseconds, 121_000);
  assert.equal(cap.snapshot().reservedMilliseconds, 0);
  assert.equal(cap.reason(0), VOICE_CAP_REASON);
});

test('startup replays a confirmed budget report interrupted before aggregate settlement', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let budget = new SQLiteBudgetLedger(storage), cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
  const session = storage.create(), { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = budget.claim(attemptId); claim.consume();
  cap.reserve({ attemptId, sessionId: session.id, callId: 'call', maxMilliseconds: 60_000 });
  budget.settleVoice(claim.claimId, { attemptId, outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 15, providerMinutes: 0.25, pausedSeconds: 5, visitorSeconds: 10, upstreamMicro: 25, visitorMicro: 10 } });
  assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
  storage.close(); storage = new SQLiteStorage(path);
  budget = new SQLiteBudgetLedger(storage); cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
  budget.recover(); cap.recover(); cap.recover();
  assert.equal(cap.snapshot().spentMilliseconds, 15_000); assert.equal(cap.snapshot().reservedMilliseconds, 0);
});

test('startup releases a durable cancelled zero budget even when its original terminal says uncertain', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let budget = new SQLiteBudgetLedger(storage), cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
  const session = storage.create(), { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100,
    maxVisitorMicro: 200, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = budget.claim(attemptId);
  cap.reserve({ attemptId, sessionId: session.id, callId: 'call', maxMilliseconds: 60_000 });
  const row = budget.settleVoice(claim.claimId, { attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: 100 });
  assert.equal(row.outcome, 'cancelled'); assert.equal(row.settled_micro, 0);
  assert.equal(JSON.parse(row.terminal_json).outcome, 'uncertain');
  assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
  storage.close(); storage = new SQLiteStorage(path);
  budget = new SQLiteBudgetLedger(storage); cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
  budget.recover(); cap.recover(); cap.recover();
  assert.equal(cap.snapshot().reservedMilliseconds, 0); assert.equal(cap.snapshot().spentMilliseconds, 0);
  assert.equal(storage.db.prepare('SELECT actual_ms FROM voice_cap_reservations WHERE attempt_id=?').get(attemptId).actual_ms, 0);
  cap.reserve({ attemptId: 'later-call', sessionId: session.id, callId: 'later', maxMilliseconds: 60_000 });
});

for (const beforeCap of [true, false]) {
  test(`reconciliation interrupted ${beforeCap ? 'before cap settlement' : 'before journal acknowledgement'} replays recorded usage across restarts`, async t => {
    const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
    let budget = new SQLiteBudgetLedger(storage), cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
    const session = storage.create(), { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100,
      maxVisitorMicro: 200, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = budget.claim(attemptId); claim.consume();
    cap.reserve({ attemptId, sessionId: session.id, callId: 'call', maxMilliseconds: 60_000 });
    const unknown = { attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: 100 };
    budget.settleVoice(claim.claimId, unknown);
    storage.saveVoiceCall(session.id, { attemptId, callId: 'call', providerSessionId: 'provider', facadeSecretRef: 'ref',
      maxMicro: 100, terminal: unknown, reconciliationPending: true });
    const confirmed = { providerSessionId: 'provider', outcome: 'completed', closureConfirmed: true,
      usage: { providerSeconds: 12, providerMinutes: 0.2, pausedSeconds: 4, visitorSeconds: 8, upstreamMicro: 20, visitorMicro: 10 } };
    const consent = { coverage: () => ({ covered: false }) };
    let runtime = createPluginRuntime({ storage, budget, voiceCap: cap, consent });
    if (beforeCap) {
      const settle = cap.settle; cap.settle = () => { throw new Error('interrupted cap write'); };
      assert.throws(() => runtime.reconcileVoice(attemptId, confirmed), /interrupted cap write/);
      cap.settle = settle;
      assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
    } else {
      runtime.reconcileVoice(attemptId, confirmed);
      runtime.reconcileVoice(attemptId, { usage: Object.fromEntries(Object.entries(confirmed.usage).reverse()),
        closureConfirmed: true, providerSessionId: confirmed.providerSessionId });
      assert.equal(cap.snapshot().spentMilliseconds, 12_000);
    }
    assert.deepEqual(JSON.parse(budget.get(attemptId).voice_reconciliation_json), confirmed);
    for (let restart = 0; restart < 2; restart++) {
      storage.close(); storage = new SQLiteStorage(path);
      budget = new SQLiteBudgetLedger(storage); cap = createVoiceCap({ storage, capMilliseconds: 60_000 });
      runtime = createPluginRuntime({ storage, budget, voiceCap: cap, consent });
      let lookups = 0;
      const handlers = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets: createFacadeSecrets(), closeOrphan: async () => {
        lookups++;
        return { ...confirmed, usage: { ...confirmed.usage, providerSeconds: 13, upstreamMicro: 21 } };
      } } });
      await handlers.resume(); await handlers.resume();
      assert.equal(lookups, 0, 'durable settlement avoids a changed provider duration');
      assert.equal(cap.snapshot().spentMilliseconds, 12_000); assert.equal(cap.snapshot().reservedMilliseconds, 0);
      assert.equal(budget.get(attemptId).settled_micro, 20); assert.equal(budget.get(attemptId).settled_visitor_micro, 10);
      assert.equal(storage.voiceCalls()[0].reconciliationPending, false);
      assert.deepEqual(storage.voiceCalls()[0].reconciliation, confirmed);
      runtime.reconcileVoice(attemptId, confirmed);
      assert.throws(() => runtime.reconcileVoice(attemptId, { ...confirmed, usage: { ...confirmed.usage, providerSeconds: 13 } }), /already settled/);
      assert.equal(budget.get(attemptId).settled_micro, 20); assert.equal(cap.snapshot().spentMilliseconds, 12_000);
      await handlers.close();
    }
  });
}

test('startup preserves dispatched unknown holds, releases undispatched holds and settles authenticated orphan reconciliation', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let budget = new SQLiteBudgetLedger(storage), cap = createVoiceCap({ storage, capMilliseconds: 120_000 });
  const session = storage.create({ ownerToken: 'owner' }), claims = [];
  for (const dispatched of [false, true]) {
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = budget.claim(attemptId); claims.push(claim);
    cap.reserve({ attemptId, sessionId: session.id, callId: 'call', maxMilliseconds: 60_000 });
    if (dispatched) claim.consume();
  }
  const { attemptId, claimId } = claims[1];
  storage.saveVoiceCall(session.id, { attemptId, claimId, callId: 'call', providerSessionId: 'provider',
    facadeSecretRef: 'ref', maxMicro: 100, spendDeadlineAt: Date.now() + 60_000 });
  storage.close(); storage = new SQLiteStorage(path);
  budget = new SQLiteBudgetLedger(storage); cap = createVoiceCap({ storage, capMilliseconds: 120_000 });
  const runtime = createPluginRuntime({ storage, budget, voiceCap: cap, consent: { coverage: () => ({ covered: false }) } });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets: createFacadeSecrets(),
    closeOrphan: async () => ({ providerSessionId: 'foreign', closureConfirmed: true }) } });
  await handlers.resume();
  assert.equal(cap.snapshot().reservedMilliseconds, 60_000);
  assert.equal(storage.voiceCalls()[0].reconciliationPending, true, 'foreign closure cannot free the hold');
  await handlers.close();
  const confirmed = { providerSessionId: 'provider', closureConfirmed: true,
    usage: { providerSeconds: 12, providerMinutes: 0.2, pausedSeconds: 4, visitorSeconds: 8, upstreamMicro: 20, visitorMicro: 10 } };
  const reconciler = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets: createFacadeSecrets(), closeOrphan: async () => confirmed } });
  await reconciler.resume();
  assert.equal(cap.snapshot().spentMilliseconds, 12_000);
  assert.equal(cap.snapshot().reservedMilliseconds, 0);
  assert.equal(storage.voiceCalls()[0].reconciliationPending, false);
  await reconciler.resume(); assert.equal(cap.snapshot().spentMilliseconds, 12_000, 'reconciliation is idempotent');
  await reconciler.close();
});

test('periodic reconciliation bounds stalled lookups, rotates batches, retains foreign holds and stops on shutdown', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const storage = new SQLiteStorage(), budget = new SQLiteBudgetLedger(storage), cap = createVoiceCap({ storage, capMilliseconds: 180_000 });
  const session = storage.create(), attempts = [];
  for (let i = 0; i < 3; i++) {
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = budget.claim(attemptId); claim.consume(); attempts.push(attemptId);
    cap.reserve({ attemptId, sessionId: session.id, callId: `call-${i}`, maxMilliseconds: 60_000 });
    const terminal = { attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: 100 };
    budget.settleVoice(claim.claimId, terminal);
    storage.saveVoiceCall(session.id, { attemptId, callId: `call-${i}`, providerSessionId: `provider-${i}`,
      facadeSecretRef: 'ref', maxMicro: 100, terminal, reconciliationPending: true });
  }
  const lookups = []; let mode = 'outage';
  const runtime = createPluginRuntime({ storage, budget, voiceCap: cap, consent: { coverage: () => ({ covered: false }) } });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets: createFacadeSecrets(), reconcileIntervalMs: 10,
    reconcileBatchSize: 1, closeOrphan: async record => {
      lookups.push(record.providerSessionId);
      if (mode === 'outage') throw new Error('provider outage');
      if (mode === 'stalled') return new Promise(() => {});
      return { providerSessionId: mode === 'foreign' ? 'foreign' : record.providerSessionId, outcome: 'completed', closureConfirmed: true,
        usage: { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 0, visitorSeconds: 10, upstreamMicro: 20, visitorMicro: 10 } };
    } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const tick = async ms => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  await handlers.resume(); assert.equal(lookups.length, 3); assert.equal(cap.snapshot().reservedMilliseconds, 180_000);
  mode = 'stalled'; await tick(10);
  assert.equal(lookups.length, 4); await tick(999); assert.equal(lookups.length, 4);
  await tick(1); assert.equal(cap.snapshot().reservedMilliseconds, 180_000);
  mode = 'foreign'; await tick(10); await tick(10);
  assert.deepEqual(lookups.slice(3), ['provider-0', 'provider-1', 'provider-2']);
  assert.equal(cap.snapshot().reservedMilliseconds, 180_000);
  mode = 'confirmed'; await tick(10); await tick(10); await tick(10);
  assert.equal(cap.snapshot().reservedMilliseconds, 0); assert.equal(cap.snapshot().spentMilliseconds, 30_000);
  assert.ok(attempts.every(id => budget.get(id).voice_reconciliation_json));
  assert.ok(storage.voiceCalls().every(record => record.reconciliationPending === false));
  const before = lookups.length; await handlers.close(); await tick(10_000); assert.equal(lookups.length, before);
});
