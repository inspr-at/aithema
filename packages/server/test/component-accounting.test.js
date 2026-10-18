import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as composed from '@inspr/aithema-server/composed-voice/accounting';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { componentInvocation } from '@inspr/aithema-core/voice-components';
import { SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const digest = 'a'.repeat(64);
function fixture(t, path) {
  const storage = new SQLiteStorage(path), session = storage.create({ ownerToken: 'owner' });
  const budget = new SQLiteBudgetLedger(storage);
  const parent = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 0, maxVisitorMicro: 10000,
    requestSha256: digest, bindingSha256: digest });
  const claim = budget.claim(parent.attemptId); claim.consume();
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const request = { sessionId: session.id, callId: 'call', providerSessionId: 'provider', epoch: 0,
    parentAttemptId: parent.attemptId, role: 'tts', maxMicro: 90,
    binding: { plugin: 'fixture', model: 'speech', accountRef: 'private:fixture' }, request: { text: '😀 hello' } };
  const admit = (...args) => {
    assert.equal(typeof composed.createComposedComponentAccounting, 'function', 'supported durable component accounting export');
    return composed.createComposedComponentAccounting({ storage, budget }).admit(...args);
  };
  return { storage, session, budget, parent, claim, request, admit };
}
const descriptor = { role: 'tts', unit: 'characters', model: 'speech' };
const usage = attemptId => ({ attemptId, role: 'tts', unit: 'characters', quantity: 7,
  upstreamMicro: 75, source: 'synthetic-code-points', estimated: true });

test('AIT-347 P7: consume commits before dispatch; fragments and retries use fresh durable child claims', async t => {
  const h = fixture(t), ids = [];
  for (const text of ['first fragment', 'second fragment', 'first fragment']) {
    const options = await h.admit({ ...h.request, request: { text } });
    ids.push(options.attempt.attemptId);
    assert.equal(h.budget.get(ids.at(-1)).state, 'claimed');
    const invocation = await componentInvocation(options, descriptor);
    assert.equal(h.budget.get(ids.at(-1)).state, 'dispatched');
    invocation.dispatch(); invocation.usage(7, 75, 'synthetic-code-points', true);
    await invocation.finish(true); await invocation.finish(false);
    const row = h.budget.get(ids.at(-1));
    assert.equal(row.settled_micro, 75); assert.equal(row.lane, 'tts');
    assert.equal(JSON.parse(row.component_json).parentAttemptId, h.parent.attemptId);
    assert.equal(JSON.parse(row.usage).estimated, true);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(h.budget.breakdown(h.session.id).confirmedSpendMicro, 0);
  assert.equal(h.budget.breakdown(h.session.id).uncertainSpendMicro, 225);
});

test('AIT-347 P7: component terminal retries settle once and conflicting reports fail', async t => {
  const h = fixture(t), options = await h.admit(h.request);
  await options.attempt.consume();
  const terminal = { attemptId: options.attempt.attemptId, outcome: 'completed', chargedMicro: 75, usage: usage(options.attempt.attemptId) };
  await options.report(terminal); await options.report(terminal);
  await assert.rejects(async () => options.report({ ...terminal, chargedMicro: 0 }), { code: 'already-claimed' });
  assert.equal(h.budget.used(h.session.id), 75);
});

test('AIT-347 P7: failed reports propagate and observed overruns survive restart and abandonment', async t => {
  const path = await temporaryDb(), h = fixture(t, path);
  const options = await h.admit(h.request), attemptId = options.attempt.attemptId;
  const invocation = await componentInvocation({ ...options, report() { throw new Error('durable-report-unavailable'); } }, descriptor);
  invocation.dispatch();
  assert.throws(() => invocation.usage(10, 130, 'synthetic-overrun', true), { code: 'limit' });
  await assert.rejects(invocation.finish(false), /durable-report-unavailable/);
  assert.equal(h.budget.used(h.session.id), 130);
  h.storage.close();
  const storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage);
  t.after(() => storage.close());
  budget.recover(); budget.recover();
  assert.equal(budget.get(attemptId).outcome, 'uncertain');
  assert.equal(budget.get(attemptId).settled_micro, 130);
  assert.equal(budget.breakdown(h.session.id).uncertainSpendMicro, 130);
});

test('AIT-347 P7/P8: parent closure never releases an unresolved child; restart retains STT reservation', async t => {
  const path = await temporaryDb(), h = fixture(t, path);
  const options = await h.admit({ ...h.request, role: 'stt', maxMicro: 1700, request: { maxDurationMs: 30000 } });
  await options.attempt.consume();
  h.budget.settleVoice(h.claim.claimId, { attemptId: h.parent.attemptId, outcome: 'completed', closureConfirmed: true,
    chargedMicro: 0, usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 20, visitorSeconds: 40,
      upstreamMicro: 0, visitorMicro: 400 } });
  assert.equal(h.budget.used(h.session.id), 1700); assert.equal(h.budget.visitorUsed(h.session.id), 400);
  await assert.rejects(h.admit(h.request), { code: 'not-admitted' });
  h.storage.close();
  const storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage);
  t.after(() => storage.close()); budget.recover();
  assert.equal(budget.get(options.attempt.attemptId).settled_micro, 1700);
  assert.equal(budget.get(h.parent.attemptId).settled_micro, 0);
  assert.equal(budget.visitorUsed(h.session.id), 400);
});

for (const [phase, exposure] of [['claimed', 0], ['dispatched', 90], ['observed', 130]]) {
  test(`AIT-347 P7: SIGKILL at ${phase} recovers durable child exposure ${exposure}`, { timeout: 10000 }, async t => {
    const path = await temporaryDb();
    const child = fork(new URL('../../../test/fixtures/component-accounting-crash.mjs', import.meta.url), [path, phase], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
    const message = await Promise.race([once(child, 'message').then(([value]) => value),
      once(child, 'exit').then(() => { throw new Error(errors || 'crash fixture exited before dispatch'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage);
    t.after(() => storage.close()); budget.recover(); budget.recover();
    assert.equal(budget.get(message.attemptId).settled_micro, exposure);
    assert.equal(budget.get(message.attemptId).outcome, phase === 'claimed' ? 'cancelled' : 'uncertain');
    assert.equal(budget.used(message.sessionId), exposure);
  });
}

for (const reason of ['cancel', 'deadline', 'abandon']) test(`AIT-347 P7: ${reason} retains the consumed child reservation`, async t => {
  const h = fixture(t), controller = new AbortController();
  const options = await h.admit({ ...h.request, signal: controller.signal,
    ...(reason === 'deadline' ? { deadlineAt: Date.now() + 25 } : {}) });
  const invocation = await componentInvocation(options, descriptor); invocation.dispatch();
  if (reason === 'cancel') controller.abort();
  if (reason === 'deadline') await new Promise(resolve => setTimeout(resolve, 35));
  await invocation.finish(false);
  assert.equal(h.budget.get(options.attempt.attemptId).outcome, 'uncertain');
  assert.equal(h.budget.get(options.attempt.attemptId).settled_micro, 90);
});

test('AIT-347 P8: zero upstream parent charges active visitor duration and excludes acknowledged pause', async t => {
  const h = fixture(t); let at = Date.now();
  const plugin = createComposedVoice({ enabled: true, storage: h.storage, binding: { visitorMicroPerMinute: 600 },
    stt: { stream() {} }, tts: { speak() {} }, replyExecutor: { execute() {} },
    authorize: async () => true, commitUtterance() {}, admitComponent() {}, now: () => at });
  const reports = [];
  const call = await plugin.start({ sessionId: h.session.id, callId: 'duration', ownerToken: 'owner' }, {
    deadlineAt: at + 5000, spendDeadlineAt: at + 120000, browserLivenessDeadlineAt: at + 120000,
    attempt: { ...h.claim, maxMicro: 0, consume() {} }, report: terminal => { reports.push(terminal); h.budget.settleVoice(h.claim.claimId, terminal); } });
  at += 10000; await call.pause(); at += 20000; await call.resume(); at += 30000;
  const terminal = await call.close(); await call.close();
  assert.equal(terminal.chargedMicro, 0); assert.equal(terminal.usage.upstreamMicro, 0);
  assert.equal(terminal.usage.visitorSeconds, 40); assert.equal(terminal.usage.pausedSeconds, 20);
  assert.equal(terminal.usage.visitorMicro, 400); assert.equal(reports.length, 1);
  assert.equal(h.budget.visitorUsed(h.session.id), 400);
});

async function durationFixture(t, { request = {}, save } = {}) {
  const h = fixture(t); let at = Date.now();
  const startedAt = at, reports = [], originalSave = h.storage.saveVoiceCall.bind(h.storage);
  if (save) h.storage.saveVoiceCall = (...args) => save(originalSave, ...args);
  const plugin = createComposedVoice({ enabled: true, storage: h.storage, config: { maxDurationSeconds: 120 },
    binding: { visitorMicroPerMinute: 601 }, stt: { stream() {} }, tts: { speak() {} },
    replyExecutor: { execute() {} }, authorize: async () => true, commitUtterance() {}, admitComponent() {}, now: () => at });
  const call = await plugin.start({ sessionId: h.session.id, callId: 'server-duration', ownerToken: 'owner', ...request }, {
    deadlineAt: at + 5000, spendDeadlineAt: at + 120000, browserLivenessDeadlineAt: at + 120000,
    attempt: { ...h.claim, maxMicro: 0, consume() {} },
    report: terminal => { reports.push(terminal); h.budget.settleVoice(h.claim.claimId, terminal); } });
  t.after(() => call.close());
  return { ...h, call, startedAt, reports, advance(ms) { at += ms; } };
}

test('AIT-347 b2: client duration and timing fields cannot override server coordinator timestamps or lifetime', async t => {
  const h = await durationFixture(t, { request: {
    maxDurationSeconds: 1, startedAt: 0, endedAt: Number.MAX_SAFE_INTEGER,
    providerSeconds: 0, visitorSeconds: 0, pausedSeconds: 9999, duration: 0, durationMs: 0,
    pauses: [{ from: 0, to: Number.MAX_SAFE_INTEGER }], paused: true,
    spendDeadlineAt: 0, browserLivenessDeadlineAt: 0, now: () => 0,
    context: { startedAt: 0, duration: 0, pausedSeconds: 9999 },
  } });
  assert.equal(h.call.snapshot().startedAt, h.startedAt);
  assert.equal(h.call.snapshot().spendDeadlineAt, h.startedAt + 120000, 'client timing must not shorten the server lifetime');
  h.advance(60001);
  const terminal = await h.call.close({ duration: 0, durationMs: 0, visitorSeconds: 0, endedAt: 0 });
  assert.equal(terminal.usage.providerSeconds, 60.001);
  assert.equal(terminal.usage.visitorSeconds, 60.001);
  assert.equal(terminal.usage.pausedSeconds, 0);
  assert.equal(terminal.usage.visitorMicro, 602, 'ceil the tariff from server elapsed time only');
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.costEstimated, false);
});

test('AIT-347 b2: confirmed visitor duration persists Aithema provenance while STT and TTS children stay estimated', async t => {
  const h = await durationFixture(t), children = [];
  for (const role of ['stt', 'tts']) {
    const options = await h.admit({ ...h.request, role });
    await options.attempt.consume();
    await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', chargedMicro: 75,
      usage: { ...usage(options.attempt.attemptId), role, unit: role === 'stt' ? 'seconds' : 'characters' } });
    children.push(options.attempt.attemptId);
  }
  h.advance(60000);
  const terminal = await h.call.close();
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.costEstimated, false);
  assert.equal(terminal.usage.visitorDurationSource, 'aithema-measured');
  const persisted = h.storage.voiceCalls(h.session.id).find(row => row.providerSessionId === h.call.providerSessionId);
  assert.equal(persisted.terminal.usage.visitorDurationSource, 'aithema-measured');
  assert.equal(JSON.parse(h.budget.get(h.parent.attemptId).usage).visitorDurationSource, 'aithema-measured');
  for (const id of children) {
    assert.equal(JSON.parse(h.budget.get(id).usage).estimated, true, 'parent confirmation cannot confirm provider spend');
    assert.equal(h.budget.get(id).settled_micro, 75);
  }
  assert.equal(h.budget.breakdown(h.session.id).confirmedSpendMicro, 0);
  assert.equal(h.budget.breakdown(h.session.id).uncertainSpendMicro, 150);
  assert.equal(h.budget.visitorUsed(h.session.id), 601);
});

for (const refusal of ['throw', 'unacknowledged', 'wrong-state']) {
  test(`AIT-347 b2: ${refusal} pause never excludes visitor time, even after heartbeat`, async t => {
    const h = await durationFixture(t, { save(original, sessionId, record, options) {
      if (options?.paused === true) {
        if (refusal === 'throw') throw new Error('pause-save-failed');
        return { acknowledged: refusal !== 'unacknowledged', paused: false };
      }
      return original(sessionId, record, options);
    } });
    h.advance(10000); await assert.rejects(h.call.pause());
    h.advance(5000); await h.call.heartbeat();
    h.advance(15000);
    const terminal = await h.call.close();
    assert.equal(terminal.usage.pausedSeconds, 0);
    assert.equal(terminal.usage.visitorSeconds, 30);
    assert.equal(terminal.usage.visitorMicro, 301);
  });
}

test('AIT-347 b2: acknowledged open pause is excluded; unacknowledged resume cannot restart charging', async t => {
  const h = await durationFixture(t, { save(original, sessionId, record, options) {
    if (options?.paused === false) return { acknowledged: false, paused: false };
    return original(sessionId, record, options);
  } });
  h.advance(10000); await h.call.pause();
  h.advance(10000); await h.call.pause(); // Idempotent: no duplicate interval.
  h.advance(10000); await assert.rejects(h.call.resume(), { code: 'invalid-output' });
  h.advance(10000);
  const terminal = await h.call.close();
  assert.equal(terminal.usage.pausedSeconds, 30);
  assert.equal(terminal.usage.visitorSeconds, 10);
  assert.equal(terminal.usage.visitorMicro, 101);
});

test('AIT-347 b2: pending pause at close excludes no time and a late acknowledgement cannot change settlement', async t => {
  const entered = Promise.withResolvers(), ack = Promise.withResolvers();
  const h = await durationFixture(t, { save(original, sessionId, record, options) {
    if (options?.paused === true) { entered.resolve(); return ack.promise; }
    return original(sessionId, record, options);
  } });
  h.advance(10000); const holding = h.call.pause();
  await entered.promise; h.advance(20000);
  const terminal = await h.call.close();
  ack.resolve({ acknowledged: true, paused: true });
  await assert.rejects(holding, { code: 'unavailable' });
  assert.equal(terminal.usage.pausedSeconds, 0);
  assert.equal(terminal.usage.visitorSeconds, 30);
  assert.equal(h.reports.length, 1);
  assert.equal(h.budget.visitorUsed(h.session.id), 301);
});
