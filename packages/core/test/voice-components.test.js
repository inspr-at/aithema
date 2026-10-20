import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertSTTComponent, assertTTSComponent, voiceCompositionCapabilities, componentInvocation,
  assertComponentUsage, boundedEvents, audioQueue, preflightVoiceComposition, TTS_SPEAK_BYTES, TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS } from '@inspr/aithema-core/voice-components';

const descriptor = { role: 'stt', unit: 'seconds', model: 'fake-stt' };
const fixture = (overrides = {}) => {
  const reports = [], controller = new AbortController(); let consumes = 0;
  return { reports, controller, get consumes() { return consumes; }, options: {
    signal: controller.signal, deadlineAt: Date.now() + 2000,
    attempt: { attemptId: 'attempt', claimId: 'claim', maxMicro: 100, consume() { consumes++; } },
    report: terminal => { reports.push(terminal); }, ...overrides,
  } };
};
const ports = () => ({
  stt: { capabilities: { streaming: true, partialTranscripts: true, languages: ['de', 'en', 'de-AT'] },
    async negotiateAudioFormat(offered) { return offered[0]; }, async transcribe() { return { text: 'Hallo' }; },
    async *stream() { yield { text: 'Hal', final: false }; yield { text: 'Hallo', final: true }; } },
  tts: { capabilities: { streaming: false, languages: ['DE', 'fr'], heardPrefix: 'unavailable' },
    async negotiateAudioFormat(offered) { return offered[0]; }, async *speak() { yield new Uint8Array([0, 0]); } },
});

test('AIT-403 component preflight default deadline uses its supplied clock', async t => {
  const wall = Date.parse('2030-06-15T00:00:30Z');
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => wall - 60_000, components = ports(), observed = [];
  for (const component of Object.values(components)) component.negotiateAudioFormat = async (offered, options) => {
    observed.push(options); return offered[0];
  };
  const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 };
  await preflightVoiceComposition({ ...components, capture: format, playback: format, languages: ['de'], voice: 'fixture' }, { now });
  assert.equal(observed.length, 2);
  for (const options of observed) assert.equal(options.deadlineAt, now() + 1000);
});

test('AIT-316: public component declarations and legacy type re-exports typecheck', { timeout: 30_000 }, async () => {
  const compiler = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
  const source = fileURLToPath(new URL('../../../test/types/voice-components.ts', import.meta.url));
  await promisify(execFile)(process.execPath, [compiler, '--noEmit', '--strict', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', source], { timeout: 25_000 });
});

test('AIT-316: capability declarations expose language, streaming and heard-prefix losses', () => {
  const { stt, tts } = ports();
  assert.equal(assertSTTComponent(stt), stt); assert.equal(assertTTSComponent(tts), tts);
  assert.deepEqual(voiceCompositionCapabilities(stt, tts), { languages: ['de'], streaming: { stt: true, tts: false },
    partialTranscripts: true, heardPrefix: 'unavailable' });
  const caps = voiceCompositionCapabilities(stt, tts); caps.languages.push('invented');
  assert.deepEqual(stt.capabilities.languages, ['de', 'en', 'de-AT']);
  assert.throws(() => assertSTTComponent({ ...stt, stream: undefined }), TypeError);
  assert.throws(() => assertSTTComponent({ ...stt, transcribe: null }), TypeError);
  assert.throws(() => assertTTSComponent({ ...tts, negotiateAudioFormat: null }), TypeError);
  for (const languages of [null, 'de', ['*'], [''], ['de', 'DE'], [42], ['en_US']]) {
    assert.throws(() => assertSTTComponent({ ...stt, capabilities: { ...stt.capabilities, languages } }), TypeError);
    assert.throws(() => assertTTSComponent({ ...tts, capabilities: { ...tts.capabilities, languages } }), TypeError);
  }
  assert.throws(() => assertSTTComponent({ ...stt, capabilities: { ...stt.capabilities, streaming: false } }), TypeError);
  assert.throws(() => assertTTSComponent({ ...tts, capabilities: { ...tts.capabilities, heardPrefix: 'aligned' } }), TypeError);
  assert.throws(() => assertTTSComponent({ ...tts, capabilities: { ...tts.capabilities, heardPrefix: true } }), TypeError);
  const aligned = { ...tts, capabilities: { ...tts.capabilities, heardPrefix: 'aligned' }, async *speakAligned() {} };
  assert.equal(voiceCompositionCapabilities(stt, aligned).heardPrefix, 'aligned');
  assert.deepEqual(voiceCompositionCapabilities({ ...stt, capabilities: { streaming: false, partialTranscripts: false, languages: [] } }, tts).languages, []);
});

test('AIT-316: admission and accounting metadata are validated before host consume', async () => {
  for (const attempt of [undefined, {}, { attemptId: 1, claimId: 'c', consume() {}, maxMicro: 1 },
    { attemptId: 'a', claimId: 'c', consume() {}, maxMicro: -1 },
    { attemptId: 'a', claimId: 'c', consume() {}, maxMicro: 0.5 }]) {
    const f = fixture({ attempt }); await assert.rejects(componentInvocation(f.options, descriptor), { code: 'not-admitted' });
    assert.equal(f.consumes, 0); assert.equal(f.reports.length, 0);
  }
  const f = fixture();
  await assert.rejects(componentInvocation(f.options, { ...descriptor, role: 'invented' }), TypeError);
  assert.equal(f.consumes, 0);
  const usage = { attemptId: 'a', role: 'tts', unit: 'characters', quantity: 2, upstreamMicro: 3, source: 'fake', estimated: false };
  assert.equal(assertComponentUsage(usage), usage);
  assert.throws(() => assertComponentUsage({ ...usage, upstreamMicro: NaN }), { code: 'invalid-output' });
});

test('AIT-316: fresh consume precedes dispatch and exact completion settles once', async () => {
  const f = fixture(); let release;
  f.options.attempt.consume = () => new Promise(resolve => { release = resolve; });
  let admitted = false;
  const pending = componentInvocation(f.options, descriptor).then(value => { admitted = true; return value; });
  await Promise.resolve(); assert.equal(admitted, false); release();
  const invocation = await pending;
  assert.throws(() => invocation.usage(1, 10, 'fake'), { code: 'not-admitted' });
  invocation.dispatch(); assert.throws(() => invocation.dispatch(), { code: 'already-claimed' });
  invocation.usage(1.5, 12, 'fake-receipt', false);
  const first = invocation.finish(true); assert.equal(invocation.finish(false), first); await first;
  assert.deepEqual(f.reports, [{ attemptId: 'attempt', servedModel: 'fake-stt', outcome: 'completed', chargedMicro: 12,
    usage: { attemptId: 'attempt', role: 'stt', unit: 'seconds', quantity: 1.5, upstreamMicro: 12, source: 'fake-receipt', estimated: false } }]);
  assert.throws(() => invocation.usage(1, 1, 'late'), { code: 'already-claimed' });
  f.controller.abort(); assert.equal(f.reports.length, 1);
});

test('AIT-316: no dispatch, failed consume and already-aborted admission settle zero', async () => {
  const f = fixture(), invocation = await componentInvocation(f.options, descriptor);
  await invocation.finish(true); assert.equal(f.consumes, 1);
  assert.equal(f.reports[0].chargedMicro, 0); assert.equal(f.reports[0].usage.source, 'undispatched');
  assert.throws(() => invocation.dispatch(), { code: 'already-claimed' });
  const denied = fixture(); denied.options.attempt.consume = () => { throw new Error('fresh authority denied'); };
  await assert.rejects(componentInvocation(denied.options, descriptor), /fresh authority denied/);
  assert.equal(denied.reports.length, 1); assert.equal(denied.reports[0].chargedMicro, 0);
  const aborted = fixture(); aborted.controller.abort();
  await assert.rejects(componentInvocation(aborted.options, descriptor), { code: 'cancelled' });
  assert.equal(aborted.consumes, 0); assert.equal(aborted.reports[0].chargedMicro, 0);
});

test('AIT-316: missing completion, cancellation and uncertain usage retain claim maximum', async () => {
  for (const mode of ['missing-usage', 'incomplete', 'abort']) {
    const f = fixture(), invocation = await componentInvocation(f.options, descriptor); invocation.dispatch();
    if (mode !== 'missing-usage') invocation.usage(1, 5, 'estimate');
    if (mode === 'abort') f.controller.abort();
    await invocation.finish(mode === 'missing-usage');
    assert.equal(f.reports.length, 1); assert.equal(f.reports[0].outcome, 'uncertain');
    assert.equal(f.reports[0].chargedMicro, 100);
  }
});

test('AIT-316: invalid and over-ceiling usage cannot become successful or release a claim', async () => {
  for (const amount of [NaN, -1, 0.5, 101]) {
    const f = fixture(), invocation = await componentInvocation(f.options, descriptor); invocation.dispatch();
    assert.throws(() => invocation.usage(1, amount, 'fake'), { code: amount === 101 ? 'limit' : 'invalid-output' });
    invocation.rejectWithoutUsage(401); await invocation.finish(true);
    assert.equal(f.reports[0].outcome, 'uncertain'); assert.equal(f.reports[0].chargedMicro, amount === 101 ? 101 : 100);
  }
});

test('AIT-316: only a definitive 4xx without usage releases dispatch; timeouts retain max', async () => {
  for (const status of [400, 401, 403, 429, 408, 499, 500, 200, '401', undefined]) {
    const f = fixture(), invocation = await componentInvocation(f.options, descriptor); invocation.dispatch();
    invocation.rejectWithoutUsage(status); await invocation.finish(false);
    const definitive = [400, 401, 403, 429].includes(status);
    assert.equal(f.reports[0].outcome, definitive ? 'cancelled' : 'uncertain');
    assert.equal(f.reports[0].chargedMicro, definitive ? 0 : 100);
  }
  const f = fixture(), invocation = await componentInvocation(f.options, descriptor); invocation.dispatch();
  invocation.rejectWithoutUsage(401); invocation.usage(1, 7, 'receipt'); invocation.rejectWithoutUsage(401);
  await invocation.finish(false); assert.equal(f.reports[0].chargedMicro, 100);
});

test('AIT-316: deadline bounds ignoring consume/iterator and reports after dispatch once', async () => {
  const f = fixture({ deadlineAt: Date.now() + 30 });
  f.options.attempt.consume = () => new Promise(() => {});
  await assert.rejects(componentInvocation(f.options, descriptor), { code: 'deadline' });
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].chargedMicro, 0);
  const dispatched = fixture({ deadlineAt: Date.now() + 30 });
  const invocation = await componentInvocation(dispatched.options, descriptor); invocation.dispatch();
  await new Promise(resolve => invocation.signal.addEventListener('abort', resolve, { once: true }));
  await invocation.finish(true); assert.equal(dispatched.reports[0].outcome, 'uncertain');
  assert.equal(dispatched.reports[0].chargedMicro, 100);
  let returned = 0;
  const source = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, return() { returned++; return Promise.resolve({ done: true }); } };
  await assert.rejects(async () => { for await (const value of boundedEvents(source, { deadlineAt: Date.now() + 30 })) void value; }, { code: 'deadline' });
  assert.equal(returned, 1);
});

test('AIT-316: report rejection and synchronous abort do not report twice', async () => {
  const f = fixture(); f.options.report = terminal => { f.reports.push(terminal); f.controller.abort(); throw new Error('host report failed'); };
  const invocation = await componentInvocation(f.options, descriptor); invocation.dispatch();
  const first = invocation.finish(false); await assert.rejects(first, /host report failed/);
  assert.equal(invocation.finish(true), first); assert.equal(f.reports.length, 1);
});

test('AIT-316: byte queue bounds ingress, drains end, discards clear and permits one reader', async () => {
  assert.equal(TTS_SPEAK_BYTES, 16_000_000); assert.equal(TTS_MESSAGE_BYTES, 1_048_576);
  assert.ok(TTS_WIRE_CHARACTERS >= 4 * Math.ceil(TTS_MESSAGE_BYTES / 3));
  for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => audioQueue(limit), TypeError);
  const queue = audioQueue(4); queue.push(new Uint8Array([1, 2])); queue.push(new Uint8Array([3, 4]));
  assert.throws(() => queue.push(new Uint8Array([5])), { code: 'limit' });
  assert.throws(() => queue.push({ byteLength: -1 }), TypeError); queue.end();
  assert.deepEqual(await Array.fromAsync(queue), [new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  assert.throws(() => queue.push(new Uint8Array([1])), { code: 'unavailable' });
  const waiting = audioQueue(4), read = waiting.next(); assert.throws(() => waiting.next(), TypeError);
  waiting.push(new Uint8Array([1])); assert.deepEqual((await read).value, new Uint8Array([1]));
  waiting.push(new Uint8Array([2])); await waiting.return(); assert.equal((await waiting.next()).done, true);
  const envelopes = audioQueue(2), entry = { byteLength: 2, bytes: new Uint8Array(2), fragment: 'fake' };
  envelopes.push(entry); envelopes.end(); assert.equal((await envelopes.next()).value, entry);
  for (const byteLength of [NaN, Infinity, 0, 0.5, -1]) {
    assert.throws(() => audioQueue(4).push({ byteLength }), TypeError);
  }
});

test('AIT-316: fake TTS iterator cancellation retains its independent claim', async () => {
  const f = fixture();
  const tts = { ...ports().tts, async *speak(request, options) {
    const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: 'fake-tts' });
    let completed = false;
    try { invocation.dispatch(); yield new Uint8Array([0, 0]); invocation.usage(request.text.length, 3, 'fake'); completed = true; }
    finally { await invocation.finish(completed); }
  } };
  for await (const chunk of boundedEvents(tts.speak({ text: 'Hallo' }, f.options), f.options)) { assert.equal(chunk.length, 2); break; }
  assert.equal(f.consumes, 1); assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].outcome, 'uncertain'); assert.equal(f.reports[0].chargedMicro, 100);
});
