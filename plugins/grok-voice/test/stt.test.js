import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrokSTT, createGrokBatchSTT, STT_FORMAT } from '../src/stt.js';
import { validateManifest } from '../../../packages/core/src/plugins.js';
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

for (const batch of [false, true]) for (const mode of ['active-cancelled', 'active-deadline']) {
  test(`${mode} closes resource and settles once, batch=${batch} (${STREAM_DOC})`, async () => {
    const h = harness({ mode }), abort = new AbortController();
    const op = operation({ signal: abort.signal, deadlineAt: Date.now() + (mode === 'active-deadline' ? 50 : 2000) });
    const timer = mode === 'active-cancelled' ? setTimeout(() => abort.abort(), 30) : undefined;
    try { await assert.rejects(component(h, batch).transcribe(request(), op.options), { code: mode === 'active-deadline' ? 'deadline' : 'cancelled' }); }
    finally { clearTimeout(timer); }
    assert.equal(h.fixtures.activeCount(), 0); assert.equal(op.reports.length, 1);
    assert.equal(op.reports[0].outcome, 'uncertain'); assert.equal(op.reports[0].chargedMicro, 1000000);
  });
}
test('REST oversized file settles undispatched without secrets or transport', async () => {
  const h = harness(), op = operation(); let secrets = 0;
  const stt = createGrokBatchSTT({ enabled: true, config, fetchImpl: h.fetchImpl, resolveSecret() { secrets++; return 'synthetic-only'; } });
  await assert.rejects(stt.transcribe({ ...request(), audio: new Uint8Array(1920002) }, op.options), { code: 'limit' });
  assert.equal(secrets, 0); assert.equal(h.fixtures.requestCount(), 0);
  assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'cancelled'); assert.equal(op.reports[0].chargedMicro, 0);
});
for (const batch of [false, true]) test(`pre-cancel/expired deadline/refused consume dispatches nothing batch=${batch}`, async () => {
  for (const mode of ['cancelled', 'deadline', 'refused']) {
    const h = harness(), abort = new AbortController(); if (mode === 'cancelled') abort.abort();
    const op = operation({ signal: abort.signal, deadlineAt: Date.now() + (mode === 'deadline' ? -1 : 1000) });
    if (mode === 'refused') op.options.attempt.consume = () => { throw Object.assign(new Error('Synthetic refusal'), { code: 'not-admitted' }); };
    await assert.rejects(component(h, batch).transcribe(request(), op.options));
    assert.equal(h.fixtures.requestCount(), 0); assert.equal(op.reports.length, 1); assert.equal(op.reports[0].chargedMicro, 0);
  }
});
test('late socket is closed after deadline, retaining the reservation once', async () => {
  const h = harness({ mode: 'late-open' }), op = operation({ deadlineAt: Date.now() + 20 });
  await assert.rejects(component(h).transcribe(request(), op.options), { code: 'deadline' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.fixtures.activeCount(), 0); assert.equal(op.reports.length, 1); assert.equal(op.reports[0].chargedMicro, 1000000);
});
for (const batch of [false, true]) test(`report failure propagates and is called once batch=${batch}`, async () => {
  const h = harness(), error = new Error('Synthetic report failure'); let calls = 0;
  const op = operation({ report() { calls++; throw error; } });
  await assert.rejects(component(h, batch).transcribe(request(), op.options), caught => caught === error);
  assert.equal(calls, 1); assert.equal(h.fixtures.activeCount(), 0);
});
test('imports, construction, negotiation and health perform no transport or secret work', async () => {
  let secrets = 0, transports = 0;
  const ports = { config, enabled: true, resolveSecret() { secrets++; }, connect() { transports++; }, fetchImpl() { transports++; } };
  for (const factory of [createGrokSTT, createGrokBatchSTT]) {
    const stt = factory(ports); await stt.health();
    assert.deepEqual(await stt.negotiateAudioFormat([STT_FORMAT], {}), STT_FORMAT);
    assert.deepEqual(stt.capabilities.languages, ['de', 'en']); assert.deepEqual(stt.formats, [STT_FORMAT]);
    assert.equal(stt.manifest.presentation.label, 'Grok Voice (xAI): not yet qualified in live use');
    assert.deepEqual(validateManifest(stt.manifest), { ok: true, errors: [] });
  }
  assert.equal(secrets, 0); assert.equal(transports, 0);
});
