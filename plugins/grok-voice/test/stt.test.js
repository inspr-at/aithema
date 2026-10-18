import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrokSTT, createGrokBatchSTT, STT_FORMAT } from '../src/stt.js';
import { config, harness, operation, expectedTranscripts, text, STREAM_DOC, STT_DOC } from './fixtures.js';
const request = () => ({ audio: new Uint8Array(64000), format: 'pcm_s16le', language: 'en' });
const component = (h, batch = false) => (batch ? createGrokBatchSTT : createGrokSTT)({ enabled: true, config,
  resolveSecret: () => 'synthetic-only', connect: h.connect, fetchImpl: h.fetchImpl });
const collect = async iterable => { const out = []; for await (const value of iterable) out.push(value); return out; };
// Fixture source: STREAM_DOC — transcript.created/partial/done; binary audio/audio.done.
test(`readiness, replacement/segmented hypotheses and single terminal final (${STREAM_DOC})`, async () => {
  let ready = false;
  const h = harness({ onSend() { assert.equal(ready, true); } });
  const original = h.connect; h.connect = async args => {
    const socket = await original(args), events = socket.events;
    socket.events = (async function* () { for await (const event of events) { if (JSON.parse(event).type === 'transcript.created') ready = true; yield event; } })();
    return socket;
  };
  const op = operation();
  const values = await collect(component(h).stream({ ...request(), audio: (async function* () { yield request().audio; })() }, op.options));
  assert.deepEqual(values, expectedTranscripts);
  assert.ok(h.sent[0] instanceof Uint8Array);
  assert.deepEqual(JSON.parse(h.sent.at(-1)), { type: 'audio.done' });
  const url = new URL(h.urls[0]); assert.equal(url.pathname, '/v1/stt'); assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('model'), config.model); assert.equal(url.searchParams.get('encoding'), 'pcm');
  assert.equal(url.searchParams.get('interim_results'), 'true');
  assert.equal(op.reports.length, 1); assert.equal(op.reports[0].usage.quantity, 3.45);
  assert.equal(op.reports[0].usage.upstreamMicro, 192); assert.equal(op.reports[0].usage.estimated, true);
  assert.match(op.reports[0].usage.source, /2026-10-18/u); assert.equal(h.fixtures.activeCount(), 0);
});
for (const batch of [false, true]) {
  test(`provider duration and REST multipart contract, batch=${batch} (${STT_DOC})`, async () => {
    const h = harness(), op = operation();
    assert.deepEqual(await component(h, batch).transcribe(request(), op.options), { text });
    assert.equal(op.consumed, 1); assert.equal(op.reports.length, 1);
    assert.equal(op.reports[0].usage.quantity, 3.45);
    assert.equal(op.reports[0].usage.upstreamMicro, batch ? 96 : 192);
    assert.equal(op.reports[0].usage.estimated, true);
    if (batch) {
      assert.equal(h.urls[0], 'https://api.x.ai/v1/stt');
      assert.deepEqual([...h.bodies[0].keys()], ['model', 'audio_format', 'sample_rate', 'language', 'file']);
      assert.equal(h.bodies[0].get('audio_format'), 'pcm'); assert.equal(h.bodies[0].get('sample_rate'), '16000');
    }
  });
  for (const mode of ['missing-final', 'malformed', 'overflow', 'bad-duration', ...(batch ? [] : ['before-ready'])]) {
    test(`wire ${mode} retains child reservation batch=${batch} (${STREAM_DOC})`, async () => {
      const h = harness({ mode }), op = operation();
      await assert.rejects(component(h, batch).transcribe(request(), op.options), error => ['invalid-output', 'limit'].includes(error.code));
      assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'uncertain');
      assert.equal(op.reports[0].chargedMicro, 1000000); assert.equal(h.fixtures.activeCount(), 0);
    });
  }
  for (const status of [400, 408, 499]) if (batch) test(`HTTP ${status} reservation rule (${STT_DOC})`, async () => {
    const h = harness({ mode: `http-${status}` }), op = operation();
    await assert.rejects(component(h, true).transcribe(request(), op.options));
    assert.equal(op.reports.length, 1); assert.equal(op.reports[0].chargedMicro, status === 400 ? 0 : 1000000);
  });
}
test('terminal before endpoint is refused even if audio iterator never finishes', async () => {
  const h = harness(), original = h.connect, op = operation();
  h.connect = async args => { const socket = await original(args); socket.events = (async function* () {
    yield JSON.stringify({ type: 'transcript.created' }); yield JSON.stringify({ type: 'transcript.done', text, duration: 1 });
  })(); return socket; };
  await assert.rejects(collect(component(h).stream({ format: STT_FORMAT.encoding,
    audio: { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, async return() { return { done: true }; } } }, op.options)), { code: 'invalid-output' });
  assert.equal(op.reports[0].outcome, 'uncertain');
});
