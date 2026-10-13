import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceHandlers } from '../src/voice-handlers.js';
import { createVoiceTurnOperations } from '../src/voice-turns.js';
import { PluginError } from '../../core/src/invocation.js';

const collect = async events => { for await (const _event of events) { /* Drain the reader. */ } };

test('AIT-139: the neutral lifecycle emits reconnect cause and closes turns in their original generation', async t => {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'owner' }), logs = [];
  let operations, generation = 0, clock = Date.now();
  const adapter = { bindCallbacks(ports) { operations = ports; return { callbackRoutes: [] }; } };
  const plugin = { ports: { serverAdapter: adapter }, async start(request, options) {
    const providerSessionId = `fixture-generation-${++generation}`, signal = new AbortController().signal;
    const record = { sessionId: session.id, callId: request.callId, providerSessionId, startedAt: clock,
      spendDeadlineAt: options.spendDeadlineAt, settingsRevision: session.settings?.revision ?? 0 };
    storage.saveVoiceCall(session.id, record);
    return { ...record, signal, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt,
      snapshot: () => record, async close(reason) {
        const terminal = { providerSessionId, closureConfirmed: true, outcome: 'completed', usage: { costEstimated: false } };
        storage.saveVoiceCall(session.id, { ...record, reason, endedAt: clock, terminal }); return terminal;
      } };
  } };
  const handlers = createVoiceHandlers({ storage, now: () => clock, log: row => logs.push(typeof row === 'string' ? JSON.parse(row) : row), callbackAdapter: adapter,
    ownership: { token: () => 'owner' }, readBody: async request => new Uint8Array(await request.arrayBuffer()), publish() {},
    runtime: { async admitVoice() { return { plugin, binding: { maxDurationSeconds: 120 }, options: {}, finish() {} }; },
      async checkVoice() {} } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const route = (action, body) => handlers.handle(new Request(`https://fixture.test/api/sessions/${session.id}/voice${action ? `/fixture-call/${action}` : ''}`,
    { method: 'POST', body: JSON.stringify(body) }));
  const started = await route('', { callId: 'fixture-call' }); assert.equal(started.status, 201);
  const first = await started.json();
  const run = async providerSessionId => {
    const reply = await operations.turnOperations.run({ callId: 'fixture-call', providerSessionId,
      messages: [{ role: 'user', content: 'Private synthetic speech' }], stream: true }, worker => {
      worker.admitted(`attempt-${providerSessionId}`);
      return { replyId: `reply-${providerSessionId}`, created: 1, events: (async function* () {
        yield { type: 'delta', text: 'Reply' }; yield { type: 'completion', text: 'Reply' };
      })() };
    });
    await collect(reply.events); await handlers.idle();
  };
  await run(first.providerSessionId); clock += 100;
  const recovered = await route('recover', { providerSessionId: first.providerSessionId }); assert.equal(recovered.status, 200);
  const second = await recovered.json(); await handlers.idle();
  await run(second.providerSessionId); clock += 100;
  const closed = await route('close', { providerSessionId: second.providerSessionId }); assert.equal(closed.status, 200);
  await handlers.idle();
  const reconnect = logs.find(row => row.event === 'voice.segment.reconnect');
  assert.equal(reconnect.cause, 'transport-lost');
  const admissions = logs.filter(row => row.event === 'voice.turn.admission'), closures = logs.filter(row => row.event === 'voice.turn.closure');
  assert.equal(closures.length, 2); assert.notEqual(admissions[0].generationHash, admissions[1].generationHash);
  assert.equal(reconnect.generationHash, admissions[1].generationHash);
  for (const admission of admissions) assert.ok(closures.some(row => row.turnHash === admission.turnHash && row.generationHash === admission.generationHash && row.closureConfirmed));
  assert.doesNotMatch(JSON.stringify(logs), /Private|https?:|fixture-call|fixture-generation|speech/iu);
});

test('AIT-139: reconciliation reports age and closure using persisted turn correlation, with bounded retry codes', async t => {
  const fixture = JSON.parse(await readFile(new URL('../../../test/fixtures/voice-observability-reconciliation.json', import.meta.url), 'utf8'));
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'owner' }), logs = [];
  const base = fixture.reconciliation[0].call, context = { sessionId: session.id, callId: 'fixture-call', providerSessionId: base.providerSessionId,
    messages: [{ role: 'user', content: 'Private synthetic speech' }], stream: true };
  const turns = createVoiceTurnOperations({ storage, now: () => base.startedAt, log: row => logs.push(typeof row === 'string' ? JSON.parse(row) : row) });
  const reply = await turns.run(context, worker => {
    worker.admitted('attempt');
    return { replyId: 'reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Reply' }; yield { type: 'completion', text: 'Reply' };
    })() };
  });
  await collect(reply.events); await turns.idle();
  storage.transitionVoiceLifecycle(session.id, context.callId, { type: 'connected', providerSessionId: context.providerSessionId });
  storage.saveVoiceCall(session.id, { ...base, callId: context.callId, attemptId: 'voice-attempt', terminal: fixture.reconciliation[0].terminal, reconciliationPending: true });
  let clock = base.endedAt + 500, lookups = 0;
  const handlers = createVoiceHandlers({ storage, now: () => clock, log: row => logs.push(typeof row === 'string' ? JSON.parse(row) : row), publish() {},
    runtime: { budget: { get: () => ({ settled_micro: 1000 }) }, reconcileVoice() {} },
    async closeOrphan() {
      if (++lookups === 1) throw new PluginError('Private speech', 'Private synthetic credential');
      return fixture.reconciliation[lookups === 2 ? 1 : 2].terminal;
    } });
  t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.reconcileUncertain({ dryRun: false });
  clock += 500; await handlers.reconcileUncertain({ dryRun: false });
  clock += 500; await handlers.reconcileUncertain({ dryRun: false });
  const retry = logs.find(row => row.event === 'voice.reconciliation-retry');
  assert.equal(retry.code, 'provider'); assert.equal(retry.cause, 'provider'); assert.equal(retry.reconciliationAgeMs, 500);
  const reconciliation = logs.filter(row => row.event === 'voice.cost-reconciled');
  assert.deepEqual(reconciliation.map(row => row.costEstimated), [true, false]);
  assert.deepEqual(reconciliation.map(row => row.reconciliationAgeMs), [1000, 1500]);
  const closure = logs.find(row => row.event === 'voice.turn.closure');
  assert.equal(closure.turnHash, logs[0].turnHash); assert.equal(closure.generationHash, logs[0].generationHash); assert.equal(closure.closureConfirmed, true);
  assert.doesNotMatch(JSON.stringify(logs), /Private|https?:|credential|speech/iu);
});
