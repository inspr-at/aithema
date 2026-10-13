import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { readFile } from 'node:fs/promises';
import { decodeElevenLabsReply, encodeElevenLabsReply, readElevenLabsStoredReply, runElevenLabsReply } from '../src/reply.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../../../packages/server/src/voice-turns.js';

test('AIT-102: adapter codec round-trips the pinned replay SSE and JSON bytes', async () => {
  const baseline = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8'));
  const wire = baseline.callbacks.find(c => c.name === 'retry-stream').response;
  const decoded = await decodeElevenLabsReply(new Response(wire.body, wire));
  const events = [{ type: 'operation', replyId: decoded.replyId }];
  for await (const event of decoded.events) events.push(event);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Die erste Frage: Was soll entstehen?');
  const reply = () => ({ replyId: decoded.replyId, created: decoded.created, events: new ReadableStream({
    start(controller) { for (const event of events) controller.enqueue(event); controller.close(); } }) });
  const stream = await encodeElevenLabsReply(reply(), { stream: true });
  assert.equal(await stream.text(), wire.body);
  assert.deepEqual(Object.fromEntries(stream.headers), wire.headers);
  const json = baseline.callbacks.find(c => c.name === 'retry-json').response;
  const response = await encodeElevenLabsReply(reply());
  assert.equal(await response.text(), json.body);
  assert.deepEqual(Object.fromEntries(response.headers), json.headers);
  assert.deepEqual(readElevenLabsStoredReply(JSON.parse(json.body)),
    { replyId: decoded.replyId, created: decoded.created, text: events.at(-1).text });
});

test('AIT-102: codec rejects incomplete or changed-identity streams and preserves initial HTTP errors', async () => {
  const chunk = id => `data: ${JSON.stringify({ id, created: 1, choices: [{ delta: { content: 'Text' }, finish_reason: 'stop' }] })}\n\n`;
  for (const wire of [chunk('one'), chunk('one') + chunk('other') + 'data: [DONE]\n\n', chunk('one') + 'data: [DONE]\n\ntrailing']) {
    const decoded = await decodeElevenLabsReply(new Response(wire));
    await assert.rejects(async () => { for await (const event of decoded.events) void event; }, { code: 'invalid-output' });
  }
  await assert.rejects(decodeElevenLabsReply(Response.json({ error: 'not-admitted', reason: 'host-limit' }, { status: 403 })),
    error => error.code === 'not-admitted' && error.replyResponse.status === 403 && error.replyResponse.body.reason === 'host-limit');
});

for (const shape of ['wire', 'neutral']) test(`AIT-102: a durable ${shape} reply replays without changing identity or admitting work`, async t => {
  const baseline = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8'));
  const wire = baseline.callbacks.find(c => c.name === 'retry-stream').response;
  const json = baseline.callbacks.find(c => c.name === 'retry-json').response;
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now: () => 1000 });
  t.after(async () => { await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'call', providerSessionId: 'generation',
    callbackBody: { messages: [{ role: 'user', content: 'Ja' }] } };
  const { operation } = storage.voiceTurnStore.claim(context, { now: 900 });
  const stored = JSON.parse(json.body);
  storage.voiceTurnStore.complete(operation.key, operation.fence,
    shape === 'wire' ? stored : readElevenLabsStoredReply(stored), 900, 120_000);
  const execute = () => assert.fail('Historical reply must not be readmitted');
  assert.equal(await (await runElevenLabsReply(turns, { ...context, stream: true }, execute)).text(), wire.body);
  assert.equal(await (await runElevenLabsReply(turns, context, execute)).text(), json.body);
  assert.equal(storage.voiceOperations(session.id)[0].key, operation.key);
  assert.equal(storage.voiceOperations(session.id)[0].attempts.length, 1);
});

test('AIT-102: newly completed adapter replies retain the main-compatible durable bytes', async t => {
  const baseline = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8'));
  const wire = baseline.callbacks.find(c => c.name === 'retry-stream').response;
  const json = baseline.callbacks.find(c => c.name === 'retry-json').response;
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now: () => 1000 });
  t.after(async () => { await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'call', providerSessionId: 'generation',
    callbackBody: { messages: [{ role: 'user', content: 'Ja' }] } };
  assert.equal(await (await runElevenLabsReply(turns, { ...context, stream: true },
    () => new Response(wire.body, wire))).text(), wire.body);
  const operation = storage.voiceOperations(session.id)[0];
  assert.equal(operation.state, 'completed');
  const stored = storage.getRecord(session.id, operation.replyRef).data;
  assert.equal(JSON.stringify(stored), json.body);
  assert.equal(stored.choices[0].message.content, 'Die erste Frage: Was soll entstehen?');
  const restarted = createVoiceTurnOperations({ storage, now: () => 1000 });
  const execute = () => assert.fail('Stored replies must not be readmitted after restart');
  assert.equal(await (await runElevenLabsReply(restarted, { ...context, stream: true }, execute)).text(), wire.body);
  assert.equal(await (await runElevenLabsReply(restarted, context, execute)).text(), json.body);
});

test('AIT-102: initial HTTP errors, voice-turn refusals and nonstream errors retain their policy', async () => {
  const execute = () => assert.fail('Refusal must not execute');
  const refusal = new PluginError('not-admitted', 'voice-turn-replacement-required');
  await assert.rejects(runElevenLabsReply({ run() { throw refusal; } }, { stream: true }, execute),
    error => error === refusal);
  const http = new PluginError('not-admitted');
  http.replyResponse = { body: { error: 'not-admitted', reason: 'host-limit' }, status: 403 };
  const response = await runElevenLabsReply({ run() { throw http; } }, { stream: true }, execute);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), http.replyResponse.body);
  for (const [code, status] of [['not-admitted', 403], ['deadline', 504], ['cancelled', 502]]) {
    const response = await runElevenLabsReply({ run() { throw new PluginError(code); } }, { stream: false }, execute);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
});
