import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceTurnOperations, createVoiceReplyExecutor } from '../src/voice-turns.js';
import { PluginError } from '../../core/src/invocation.js';

const collect = async events => { const values = []; for await (const event of events) values.push(event); return values; };
function fixture(t, options = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  let clock = 1000;
  const logs = [], turns = createVoiceTurnOperations({ storage, now: () => clock, log: record => logs.push(record), ...options });
  t.after(async () => { await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'call-private-person@example.test', providerSessionId: 'https://private.example.test/generation',
    stream: true, callbackBody: { messages: [{ role: 'system', content: 'Private prompt' }, { role: 'user', content: 'Private speech' }],
      headers: { authorization: 'Bearer private-credential' } } };
  return { storage, session, logs, turns, context, tick: value => { clock = value; } };
}

function assertSafe(records) {
  const fields = new Set(['event', 'callHash', 'generationHash', 'turnHash', 'attemptHash', 'admissionMs', 'firstTokenMs',
    'totalMs', 'cause', 'outcome', 'closureConfirmed', 'costEstimated', 'reconciliationAgeMs']);
  assert.ok(records.length > 0, 'Correlation stages must be observable');
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      assert.ok(fields.has(key), `Unexpected diagnostic field: ${key}`);
      if (key.endsWith('Hash')) assert.match(value, /^[a-f0-9]{64}$/u);
      if (key.endsWith('Ms')) assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
  }
  assert.doesNotMatch(JSON.stringify(records), /Private|private-|person@|https?:|Bearer|authorization|headers|prompt|speech/iu);
}

test('AIT-139: one correlated set joins admission, first token, completion and confirmed closure', async t => {
  const h = fixture(t);
  const execute = worker => {
    h.tick(1010); worker.beforeAdmission(); worker.admitted('private-attempt'); worker.admitted('private-attempt');
    return { replyId: 'private-reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: '' };
      h.tick(1030); yield { type: 'delta', text: 'Private reply' };
      for (let i = 0; i < 20; i++) yield { type: 'delta', text: '!' };
      h.tick(1080); yield { type: 'completion', text: 'Private reply' + '!'.repeat(20) };
    })() };
  };
  const executor = createVoiceReplyExecutor({ execute: (_envelope, options) => h.turns.run(h.context, execute, options) });
  await collect(executor.execute({ source: 'server-coordinator', payload: { text: 'Private speech' } }, {}));
  await h.turns.idle();
  assert.deepEqual(h.logs.map(record => record.event), ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion']);
  h.tick(1200);
  h.turns.observeClosure({ ...h.context, endedAt: 1100 }, { closureConfirmed: true, usage: { costEstimated: false } });
  const [admission, first, completion, closure] = h.logs;
  assert.equal(admission.admissionMs, 10); assert.equal(first.firstTokenMs, 30); assert.equal(completion.totalMs, 80);
  assert.equal(closure.event, 'voice.turn.closure'); assert.equal(closure.closureConfirmed, true); assert.equal(closure.reconciliationAgeMs, 100);
  for (const field of ['callHash', 'generationHash', 'turnHash', 'attemptHash']) assert.equal(new Set(h.logs.map(row => row[field])).size, 1, field);
  assertSafe(h.logs);
});

test('AIT-139: interleaved history, duplicate readers and a replacement generation retain their own records', async t => {
  const h = fixture(t), gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  t.after(() => gates.forEach(gate => gate.resolve()));
  let executions = 0;
  const execute = worker => {
    const n = executions++; worker.beforeAdmission(); worker.admitted(`attempt-${n}`);
    return { replyId: `reply-${n}`, created: 1, events: (async function* () {
      await gates[n].promise; yield { type: 'delta', text: `reply ${n}` }; yield { type: 'completion', text: `reply ${n}` };
    })() };
  };
  const growth = { ...h.context, callbackBody: { messages: [...h.context.callbackBody.messages,
    { role: 'assistant', content: 'Private reply' }, { role: 'user', content: 'Private speech again' }] } };
  const replacement = { ...h.context, providerSessionId: 'new-private-generation' };
  const a = await h.turns.run(h.context, execute), duplicate = await h.turns.run(h.context, execute);
  const b = await h.turns.run(growth, execute), c = await h.turns.run(replacement, execute);
  await duplicate.events.cancel();
  h.turns.observeClosure({ ...h.context, endedAt: 1000 }, { closureConfirmed: true, usage: { costEstimated: false } });
  gates[2].resolve(); await collect(c.events);
  gates[1].resolve(); await collect(b.events);
  gates[0].resolve(); await collect(a.events); await h.turns.idle();
  h.turns.observeClosure({ ...replacement, endedAt: 1000 }, { closureConfirmed: true, usage: { costEstimated: false } });
  assert.equal(executions, 3, 'Rule C pays once per distinct body and generation');
  const completions = h.logs.filter(row => row.event === 'voice.turn.completion');
  assert.equal(completions.length, 3);
  assert.equal(new Set(completions.map(row => row.turnHash)).size, 3);
  assert.equal(new Set(completions.map(row => row.generationHash)).size, 2);
  for (const completion of completions) {
    const stages = h.logs.filter(row => row.turnHash === completion.turnHash && row.event !== 'voice.turn.retry');
    assert.deepEqual(stages.map(row => row.event), ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion', 'voice.turn.closure']);
  }
  assert.equal(h.logs.find(row => row.event === 'voice.turn.retry').cause, 'duplicate-callback');
  assertSafe(h.logs);
});

test('AIT-139: partial failure, explicit replacement and replay report bounded causes without exception text', async t => {
  const h = fixture(t, { authorizeReplacement: () => true });
  const failed = await h.turns.run(h.context, worker => {
    worker.admitted('failed-attempt');
    return { replyId: 'partial', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Private partial' }; throw new PluginError('provider', 'Private speech Bearer private-credential');
    })() };
  });
  await assert.rejects(collect(failed.events), { code: 'provider' }); await h.turns.idle();
  const retry = await h.turns.run(h.context, worker => {
    worker.admitted('replacement-attempt');
    return { replyId: 'replacement', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Private final' }; yield { type: 'completion', text: 'Private final' };
    })() };
  });
  await collect(retry.events); await h.turns.idle();
  const replay = await h.turns.run(h.context, () => assert.fail('Replay must not dispatch')); await collect(replay.events);
  assert.deepEqual(h.logs.filter(row => row.event === 'voice.turn.retry').map(row => row.cause), ['provider', 'replay']);
  const completions = h.logs.filter(row => row.event === 'voice.turn.completion');
  assert.deepEqual(completions.map(row => row.outcome), ['failed', 'completed']);
  assert.equal(new Set(completions.map(row => row.turnHash)).size, 1);
  assert.equal(new Set(completions.map(row => row.attemptHash)).size, 2);
  assertSafe(h.logs);
});
