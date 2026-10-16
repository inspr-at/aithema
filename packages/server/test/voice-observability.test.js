import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceTurnOperations, createVoiceReplyExecutor } from '../src/voice-turns.js';
import { SQLiteBudgetLedger } from '../src/budget.js';
import { PluginError } from '../../core/src/invocation.js';

const collect = async events => { const values = []; for await (const event of events) values.push(event); return values; };
function fixture(t, options = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  let clock = 1000;
  const unblock = [], logs = [], turns = createVoiceTurnOperations({ storage, now: () => clock, log: record => logs.push(typeof record === 'string' ? JSON.parse(record) : record), ...options });
  t.after(async () => { unblock.forEach(release => release()); await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'call-private-person@example.test', providerSessionId: 'https://private.example.test/generation',
    stream: true, callbackBody: { messages: [{ role: 'system', content: 'Private prompt' }, { role: 'user', content: 'Private speech' }],
      headers: { authorization: 'Bearer private-credential' } } };
  return { storage, session, logs, turns, context, unblock, tick: value => { clock = value; } };
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
  h.unblock.push(() => gates.forEach(gate => gate.resolve()));
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

for (const asyncLog of [false, true]) test(`AIT-139: a ${asyncLog ? 'rejected' : 'throwing'} logger leaves execution and closure intact`, async t => {
  const h = fixture(t, { log: asyncLog ? async () => { throw new Error('Private credential'); }
    : () => { throw new Error('Private credential'); } });
  const result = await h.turns.run(h.context, worker => {
    worker.admitted('attempt');
    return { replyId: 'reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Reply' }; yield { type: 'completion', text: 'Reply' };
    })() };
  });
  assert.equal((await collect(result.events)).at(-1).text, 'Reply'); await h.turns.idle();
  h.turns.observeClosure({ ...h.context, endedAt: 1000 }, { closureConfirmed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'completed');
});

test('AIT-139: the field allowlist drops arbitrary fields and restricts every free-form value', async () => {
  const { createVoiceDiagnostics } = await import('../src/voice-observability.js');
  const logs = [], emit = createVoiceDiagnostics({ log: record => logs.push(typeof record === 'string' ? JSON.parse(record) : record) });
  const identity = { callId: 'private-person@example.test', providerSessionId: 'https://private.example.test',
    fence: 'Bearer private-credential', attempts: [{ id: 'private-id' }], speech: 'Private speech', headers: { authorization: 'Private credential' } };
  const fields = { speech: 'Private speech', prompt: 'Private prompt', email: 'private-person@example.test',
    credentials: 'Bearer private-credential', headers: identity.headers, url: identity.providerSessionId,
    cause: 'Private speech', outcome: 'Private prompt', totalMs: 'https://private.example.test' };
  emit('Private speech', identity, fields);
  emit('voice.turn.completion', identity, fields);
  emit('voice.turn.closure', identity, { ...fields, closureConfirmed: 'Private speech', costEstimated: 'Private prompt', reconciliationAgeMs: Infinity });
  assert.equal(logs.length, 2);
  assert.deepEqual(Object.keys(logs[0]), ['event', 'callHash', 'generationHash', 'turnHash', 'attemptHash', 'cause']);
  assert.equal(logs[0].cause, 'provider');
  assert.deepEqual(Object.keys(logs[1]), ['event', 'callHash', 'generationHash', 'turnHash', 'attemptHash']);
  assertSafe(logs);
});

test('AIT-139: delayed closure correlates after executor restart and never downgrades confirmation', async t => {
  const h = fixture(t);
  const result = await h.turns.run(h.context, worker => {
    worker.admitted('attempt');
    return { replyId: 'reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Reply' }; yield { type: 'completion', text: 'Reply' };
    })() };
  });
  await collect(result.events); await h.turns.idle();
  const restarted = createVoiceTurnOperations({ storage: h.storage, now: () => 1500, log: record => h.logs.push(typeof record === 'string' ? JSON.parse(record) : record) });
  const record = { ...h.context, endedAt: 1100 };
  restarted.observeClosure(record, { closureConfirmed: false });
  restarted.observeClosure(record, { closureConfirmed: false });
  restarted.observeClosure(record, { closureConfirmed: true, usage: { costEstimated: true } });
  restarted.observeClosure(record, { closureConfirmed: false });
  const closed = h.logs.filter(row => row.event === 'voice.turn.closure');
  assert.deepEqual(closed.map(row => row.closureConfirmed), [true], 'One closure record only after confirmation');
  assert.equal(closed[0].reconciliationAgeMs, 400);
  assert.equal(closed[0].turnHash, h.logs[0].turnHash);
  assert.equal(closed[0].generationHash, h.logs[0].generationHash);
  assertSafe(h.logs);
});


test('AIT-139: benign admission retry records a bounded cause without creating another operation', async t => {
  const h = fixture(t);
  const reply = await h.turns.run(h.context, worker => {
    worker.beforeAdmission(); worker.retry('session-changed'); worker.admitted('attempt');
    return { replyId: 'reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Reply' }; yield { type: 'completion', text: 'Reply' };
    })() };
  });
  await collect(reply.events); await h.turns.idle();
  assert.equal(h.logs[0].event, 'voice.turn.retry'); assert.equal(h.logs[0].cause, 'session-changed');
  assert.equal(h.storage.voiceOperations(h.session.id).length, 1);
  assertSafe(h.logs);
});


test('AIT-139: startup records orphan completion without implicitly retrying paid work', async t => {
  const h = fixture(t), { operation } = h.storage.claimVoiceOperation(h.context, { now: 1000 });
  h.storage.voiceTurnStore.admitted(operation.key, operation.fence, 'paid-attempt');
  h.tick(1400); h.turns.recover(); h.turns.recover();
  assert.equal(h.logs.length, 1); assert.equal(h.logs[0].event, 'voice.turn.completion');
  assert.equal(h.logs[0].outcome, 'failed'); assert.equal(h.logs[0].cause, 'server-restart'); assert.equal(h.logs[0].totalMs, 400);
  assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'failed');
  assertSafe(h.logs);
});


test('AIT-139: a regressing wall clock cannot make stage durations decrease or disappear', async t => {
  const h = fixture(t);
  const result = await h.turns.run(h.context, worker => {
    h.tick(1040); worker.admitted('attempt');
    return { replyId: 'reply', created: 1, events: (async function* () {
      h.tick(900); yield { type: 'delta', text: 'Reply' };
      h.tick(1010); yield { type: 'completion', text: 'Reply' };
    })() };
  });
  await collect(result.events); await h.turns.idle();
  assert.deepEqual(h.logs.map(row => row.admissionMs ?? row.firstTokenMs ?? row.totalMs), [40, 40, 40]);
  assertSafe(h.logs);
});

// Exercise every relative ordering without timers or scheduler-dependent sleeps.
for (const order of ['abc', 'acb', 'bac', 'bca', 'cab', 'cba']) {
  test(`AIT-139: closure confirmation and two concurrent writers settle once in order ${order}`, async t => {
    const h = fixture(t), gates = [Promise.withResolvers(), Promise.withResolvers()];
    h.unblock.push(() => gates.forEach(gate => gate.resolve()));
    let executions = 0;
    const execute = worker => {
      const index = executions++; h.tick(1010 + index * 10); worker.admitted(`attempt-${index}`);
      return { replyId: `reply-${index}`, created: 1, events: (async function* () {
        await gates[index].promise;
        yield { type: 'delta', text: 'Private reply' }; yield { type: 'completion', text: 'Private reply' };
      })() };
    };
    const a = await h.turns.run(h.context, execute);
    const b = await h.turns.run({ ...h.context, callbackBody: { messages: [...h.context.callbackBody.messages,
      { role: 'assistant', content: 'Private reply' }, { role: 'user', content: 'Private next' }] } }, execute);
    const duplicate = await h.turns.run(h.context, execute); await duplicate.events.cancel();
    const closure = { ...h.context, endedAt: 1000 };
    // An unconfirmed provider lookup is not a closure confirmation.
    h.turns.observeClosure(closure, { closureConfirmed: false });
    assert.equal(h.logs.filter(row => row.event === 'voice.turn.closure').length, 0);
    for (const step of order) {
      h.tick(1100);
      if (step === 'c') {
        h.turns.observeClosure(closure, { closureConfirmed: true });
        h.turns.observeClosure(closure, { closureConfirmed: true });
        h.turns.observeClosure(closure, { closureConfirmed: false });
      } else {
        const index = step === 'a' ? 0 : 1;
        gates[index].resolve(); await collect((index === 0 ? a : b).events);
      }
    }
    await h.turns.idle();
    h.turns.observeClosure(closure, { closureConfirmed: true, usage: { costEstimated: false } });
    assert.equal(executions, 2, 'Duplicate readers do not admit paid work');
    assert.equal(h.logs.filter(row => row.event === 'voice.turn.closure').length, 2);
    for (const completion of h.logs.filter(row => row.event === 'voice.turn.completion')) {
      const rows = h.logs.filter(row => row.attemptHash === completion.attemptHash && row.event !== 'voice.turn.retry');
      assert.deepEqual(rows.map(row => row.event), ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion', 'voice.turn.closure']);
      assert.equal(new Set(rows.map(row => row.turnHash)).size, 1);
      assert.equal(new Set(rows.map(row => row.generationHash)).size, 1);
      assert.ok(rows[0].admissionMs <= rows[1].firstTokenMs && rows[1].firstTokenMs <= rows[2].totalMs);
      assert.equal(rows[3].closureConfirmed, true);
    }
    assertSafe(h.logs);
  });
}


for (const sink of ['collect', 'throw', 'reject']) test(`AIT-139: consent revokes publication while paid work settles once with ${sink} diagnostics`, async t => {
  let logCalls = 0;
  const h = fixture(t, sink === 'collect' ? {} : { log() {
    logCalls++;
    if (sink === 'throw') throw new Error('Private diagnostic failure');
    return Promise.reject(new Error('Private diagnostic failure'));
  } });
  const ledger = new SQLiteBudgetLedger(h.storage), gate = Promise.withResolvers();
  h.unblock.push(() => gate.resolve());
  let settlements = 0;
  const result = await h.turns.run(h.context, worker => {
    worker.beforeAdmission();
    const attempt = ledger.admit({ sessionId: h.session.id, lane: 'reaction', maxMicro: 40,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    const claim = ledger.claim(attempt.attemptId); claim.consume(); worker.admitted(attempt.attemptId);
    return { replyId: 'reply', created: 1, events: (async function* () {
      try {
        yield { type: 'delta', text: 'Private partial' }; await gate.promise;
        yield { type: 'delta', text: 'Private late' }; yield { type: 'completion', text: 'Private partialPrivate late' };
      } finally {
        settlements++;
        ledger.settle(claim.claimId, { attemptId: attempt.attemptId, outcome: 'completed', chargedMicro: 7 });
      }
    })() };
  });
  const reader = result.events.getReader();
  assert.equal((await reader.read()).value.type, 'operation');
  assert.equal((await reader.read()).value.text, 'Private partial');
  h.storage.reviseConsent(h.session.id, false); gate.resolve();
  await assert.rejects(reader.read(), { code: 'not-admitted' }); reader.releaseLock();
  await h.turns.idle();
  const operation = h.storage.voiceOperations(h.session.id)[0];
  assert.equal(operation.state, 'failed'); assert.equal(operation.replyRef, undefined);
  assert.equal(settlements, 1); assert.equal(ledger.used(h.session.id), 7);
  assert.deepEqual(h.storage.db.prepare('SELECT state,settled_micro FROM budget_attempts').all().map(row => ({ ...row })),
    [{ state: 'settled', settled_micro: 7 }]);
  await assert.rejects(h.turns.run(h.context, () => assert.fail('Withdrawn consent cannot dispatch')), { code: 'not-admitted' });
  h.turns.observeClosure({ ...h.context, endedAt: 1000 }, { closureConfirmed: true });
  await new Promise(resolve => setImmediate(resolve));
  if (sink === 'collect') assertSafe(h.logs);
  else assert.equal(logCalls, 4, 'Admission, first token, failed completion and closure all tolerate sink failure');
});

test('AIT-139: every stage stays below 1 KiB and rejects content, references, token counts and unsafe numbers', async () => {
  const { createVoiceDiagnostics } = await import('../src/voice-observability.js');
  const logs = [], emit = createVoiceDiagnostics({ log: row => logs.push(typeof row === 'string' ? JSON.parse(row) : row) });
  const secret = 'Private prompt transcript speech reference credential'.repeat(1000);
  const identity = { callId: secret, providerSessionId: secret, fence: secret, attempts: [{ id: secret }] };
  const fields = { prompt: secret, text: secret, transcript: secret, reference: secret, secretRef: secret, token: secret,
    inputTokens: 8, outputTokens: 4, cause: secret, code: secret, outcome: secret,
    admissionMs: -1, firstTokenMs: NaN, totalMs: Infinity, reconciliationAgeMs: Number.MAX_SAFE_INTEGER + 1,
    chargedMicro: -1, closureConfirmed: true, costEstimated: false };
  for (const event of ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion', 'voice.turn.retry',
    'voice.turn.closure', 'voice.segment.reconnect', 'voice.cost-reconciled', 'voice.reconciliation-retry']) emit(event, identity, fields);
  assert.equal(logs.length, 8);
  for (const row of logs) {
    assert.ok(Buffer.byteLength(JSON.stringify(row)) < 1024);
    for (const key of Object.keys(fields)) {
      if (['cause', 'code', 'closureConfirmed', 'costEstimated'].includes(key)) continue;
      assert.equal(Object.hasOwn(row, key), false, key);
    }
    for (const [key, value] of Object.entries(row)) if (key.endsWith('Hash')) assert.match(value, /^[a-f0-9]{64}$/u);
  }
  assert.doesNotMatch(JSON.stringify(logs), /Private|prompt|transcript|speech|reference|credential|Tokens|secretRef/iu);
});

test('AIT-139: confirmed closure interleaved with a failed writer and authorized retry stays unique per attempt', async t => {
  const h = fixture(t, { authorizeReplacement: () => true }), gate = Promise.withResolvers();
  h.unblock.push(() => gate.resolve());
  const record = { ...h.context, endedAt: 1000 };
  const failed = await h.turns.run(h.context, worker => {
    h.tick(1010); worker.admitted('failed-attempt');
    return { replyId: 'failed-reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Private partial' }; await gate.promise;
      throw new PluginError('provider', 'Private failure');
    })() };
  });
  const follower = await h.turns.run(h.context, () => assert.fail('Duplicate must join the paid writer'));
  await follower.events.cancel();
  h.turns.observeClosure(record, { closureConfirmed: true }); gate.resolve();
  await assert.rejects(collect(failed.events), { code: 'provider' }); await h.turns.idle();
  const retry = await h.turns.run(h.context, worker => {
    h.tick(1100); worker.admitted('retry-attempt');
    h.turns.observeClosure(record, { closureConfirmed: false });
    return { replyId: 'retry-reply', created: 1, events: (async function* () {
      h.tick(1120); yield { type: 'delta', text: 'Private complete' };
      h.tick(1150); yield { type: 'completion', text: 'Private complete' };
    })() };
  });
  await collect(retry.events); await h.turns.idle();
  h.turns.observeClosure(record, { closureConfirmed: true });
  const replay = await h.turns.run(h.context, () => assert.fail('Replay cannot dispatch')); await collect(replay.events);
  const closures = h.logs.filter(row => row.event === 'voice.turn.closure');
  assert.equal(closures.length, 2); assert.equal(new Set(closures.map(row => row.attemptHash)).size, 2);
  assert.equal(new Set(h.logs.map(row => row.turnHash)).size, 1, 'All retries retain one turn ID');
  for (const closure of closures) {
    const rows = h.logs.filter(row => row.attemptHash === closure.attemptHash && row.event !== 'voice.turn.retry');
    assert.deepEqual(rows.map(row => row.event), ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion', 'voice.turn.closure']);
    assert.ok(rows[0].admissionMs <= rows[1].firstTokenMs && rows[1].firstTokenMs <= rows[2].totalMs);
  }
  assert.deepEqual(h.logs.filter(row => row.event === 'voice.turn.retry').map(row => row.cause), ['duplicate-callback', 'provider', 'replay']);
  assertSafe(h.logs);
});
