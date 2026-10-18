import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as composed from '@inspr/aithema-server/composed-voice/accounting';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { componentInvocation } from '@inspr/aithema-core/voice-components';
import { SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';

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
