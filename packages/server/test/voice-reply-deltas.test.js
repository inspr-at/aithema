import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceTurnOperations, createVoiceReplyExecutor } from '../src/voice-turns.js';
import { assertVoicePorts } from '@inspr/aithema-core/live-voice';

function fixture(t) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage });
  const release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'fixture-call', providerSessionId: 'fixture-generation', stream: true,
    callbackBody: { model: 'untrusted', messages: [{ role: 'user', content: 'Ja' }], metadata: { fixture: true } } };
  return { storage, session, turns, context, release };
}
const collect = async events => { const result = []; for await (const event of events) result.push(event); return result; };

test('AIT-102: shared executor emits server operation identity, plain deltas and committed completion', async t => {
  const h = fixture(t), release = h.release; let admissions = 0;
  const execute = worker => {
    worker.beforeAdmission(); worker.admitted(`attempt-${++admissions}`);
    return { replyId: 'neutral-reply', created: 1, events: (async function* () {
      yield { type: 'delta', text: 'Die Frage: ' }; await release.promise;
      yield { type: 'delta', text: 'Was soll entstehen?' };
      yield { type: 'completion', text: 'Die Frage: Was soll entstehen?' };
    })() };
  };
  const executor = createVoiceReplyExecutor({ execute: (envelope, options) => h.turns.run(h.context, execute, options) });
  assertVoicePorts({ replyExecutor: executor });
  const envelope = { source: 'server-coordinator', payload: {}, operation: { key: 'forged' } };
  const reader = executor.execute(envelope, {})[Symbol.asyncIterator]();
  const first = (await reader.next()).value;
  assert.equal(first.type, 'operation'); assert.notEqual(first.operation.key, 'forged');
  assert.deepEqual(first.operation, { key: h.storage.voiceOperations(h.session.id)[0].key,
    callId: h.context.callId, providerSessionId: h.context.providerSessionId, ordinal: 1 });
  assert.deepEqual((await reader.next()).value, { type: 'delta', text: 'Die Frage: ' });
  assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'pending');
  const follower = collect(executor.execute(envelope, {})); release.resolve();
  const remainder = await collect({ [Symbol.asyncIterator]: () => reader });
  assert.deepEqual(remainder.at(-1), { type: 'completion', replyId: 'neutral-reply', text: 'Die Frage: Was soll entstehen?' });
  assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'completed');
  assert.equal((await follower).at(-1).type, 'completion');
  const record = h.storage.getRecord(h.session.id, h.storage.voiceOperations(h.session.id)[0].replyRef).data;
  assert.deepEqual(record, { replyId: 'neutral-reply', created: 1, text: 'Die Frage: Was soll entstehen?' });
  const replay = await collect(executor.execute(envelope, {})); assert.deepEqual(replay[0], first);
  assert.equal(admissions, 1);
  await assert.rejects(executor.execute({ source: 'browser-final', payload: {} }, {}).next(), { code: 'not-admitted' });
});

test('AIT-102: cancelling a text subscriber leaves the writer and bounded replay alive', async t => {
  const h = fixture(t), release = h.release;
  let executions = 0;
  const text = 'x'.repeat(16_383) + '😀' + 'z'.repeat(40_000);
  const execute = () => ({ replyId: `reply-${++executions}`, created: 1, events: (async function* () {
    await release.promise; yield { type: 'delta', text }; yield { type: 'completion', text };
  })() });
  const first = await h.turns.run(h.context, execute), follower = await h.turns.run(h.context, execute);
  await first.events.cancel(); release.resolve();
  const events = await collect(follower.events);
  assert.equal(events.at(-1).type, 'completion'); assert.equal(executions, 1);
  const replay = await h.turns.run(h.context, () => assert.fail('Replay must not execute'));
  const deltas = (await collect(replay.events)).filter(e => e.type === 'delta');
  assert.equal(deltas.map(e => e.text).join(''), text);
  for (const delta of deltas) { assert.ok(delta.text.length <= 16_384); assert.doesNotMatch(delta.text, /[\uD800-\uDBFF]$/u); }
});

for (const mode of ['missing-completion', 'wrong-completion', 'late-delta', 'too-large']) {
  test(`AIT-102: executor rejects ${mode} without storing a completed reply`, async t => {
    const h = fixture(t);
    const result = await h.turns.run(h.context, () => ({ replyId: 'invalid', created: 1, events: (async function* () {
      const text = mode === 'too-large' ? 'x'.repeat(1_048_577) : 'Partial';
      yield { type: 'delta', text };
      if (mode !== 'missing-completion') yield { type: 'completion', text: mode === 'wrong-completion' ? 'Different' : text };
      if (mode === 'late-delta') yield { type: 'delta', text: 'late' };
    })() }));
    await assert.rejects(collect(result.events), { code: mode === 'too-large' ? 'limit' : 'invalid-output' });
    await h.turns.idle(); assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'failed');
  });
}

test('AIT-102: shared executor source contains no HTTP or chat-completion codec', async () => {
  assert.doesNotMatch(await readFile(new URL('../src/voice-turns.js', import.meta.url), 'utf8'),
    /Response|TextDecoder|TextEncoder|chat\.completion|choices|finish_reason|data:|\[DONE\]/u);
});
