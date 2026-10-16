import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElevenLabsSTT, createElevenLabsTTS, STT_FORMAT, TTS_FORMAT } from '../src/components.js';
import { fixtureSocket, fixtureBinding, fixtureConsent, fixtureConfig as config, ttsWire } from './component-fixtures.js';

const collect = async source => { const result = []; for await (const item of source) result.push(item); return result; };
const options = reports => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: 'live-protocol', claimId: 'fixture-claim', maxMicro: 1000, consume() {} }, report: terminal => reports.push(terminal) });
const setup = (role, connect) => (role === 'stt' ? createElevenLabsSTT : createElevenLabsTTS)({ enabled: true, config,
  consent: fixtureConsent(fixtureBinding(role)), resolveSecret: () => 'synthetic-auth', connect });
const stream = chunks => (async function* () { yield* chunks; })();

test('AIT-250 red-before: live isFinal frames end PCM synthesis and capture a private history matching key', async () => {
  const reports = [], text = 'Grüß 👋', started = Date.now();
  const tts = setup('tts', () => fixtureSocket({ role: 'tts' }));
  assert.deepEqual(await collect(tts.speak({ text, format: TTS_FORMAT.encoding }, options(reports))), [new Uint8Array(4)]);
  assert.equal(reports[0].identity, null); assert.equal(reports[0].identityReason, 'no-request-id');
  const { startedAt, endedAt, ...key } = reports[0].matchingKey;
  assert.deepEqual(key, { voiceId: config.voiceId, modelId: 'eleven_flash_v2_5', characterCount: [...` ${text} `].length,
    textSha256: createHash('sha256').update(` ${text} `).digest('hex') });
  assert.ok(Date.parse(startedAt) >= started); assert.ok(Date.parse(endedAt) >= Date.parse(startedAt));
  assert.ok(Date.parse(endedAt) <= Date.now()); assert.ok(!JSON.stringify(reports).includes(text));
});

test('AIT-250 red-before: four live-shaped partials commit spoken text on the last audio at the 500 ms endpoint', async () => {
  const partials = ['Grüß', 'Grüß Gott', 'Grüß Gott aus', 'Grüß Gott aus Wien'], sent = [], reports = [];
  const speech = Buffer.alloc(64_000, 1), endpointSilence = Buffer.alloc(16_000);
  const stt = setup('stt', () => fixtureSocket({ role: 'stt', text: partials.at(-1), partials, onSend: frame => sent.push(frame) }));
  const events = await collect(stt.stream({ audio: stream([speech, endpointSilence]), format: STT_FORMAT.encoding }, options(reports)));
  assert.deepEqual(events, [...partials.map(text => ({ text, final: false })), { text: partials.at(-1), final: true }]);
  assert.equal(sent.length, 2); assert.deepEqual(sent.map(frame => frame.commit), [false, true]);
  assert.deepEqual(Buffer.concat(sent.map(frame => Buffer.from(frame.audio_base_64, 'base64'))), Buffer.concat([speech, endpointSilence]));
  assert.equal(reports[0].usage.quantity, 2.5);
});

test('AIT-250: short STT input pads to the documented processing minimum, with no extra endpoint wait', async () => {
  for (const duration of [100, 600, 2000]) {
    const sent = [], reports = [], input = Buffer.alloc(duration * 32, 1);
    const stt = setup('stt', () => fixtureSocket({ role: 'stt', onSend: frame => sent.push(frame) }));
    const events = await collect(stt.stream({ audio: stream([input]), format: STT_FORMAT.encoding }, options(reports)));
    assert.equal(events.at(-1).text, 'Grüß Gott'); assert.equal(sent.length, 1); assert.equal(sent[0].commit, true);
    const wire = Buffer.from(sent[0].audio_base_64, 'base64');
    assert.equal(wire.length, 64_000); assert.deepEqual(wire.subarray(0, input.length), input);
    assert.ok(wire.subarray(input.length).every(byte => byte === 0)); assert.equal(reports[0].usage.quantity, 2);
    assert.equal(stt.estimateCost({ maxDurationMs: duration }), 20);
  }
});

test('AIT-250: empty STT and insufficient padding reservation never send an empty commit', async () => {
  for (const chunks of [[], [Buffer.alloc(3200)]]) {
    const sent = [], reports = [], opts = options(reports); opts.attempt.maxMicro = 1;
    const stt = setup('stt', () => fixtureSocket({ role: 'stt', onSend: frame => sent.push(frame) }));
    await assert.rejects(collect(stt.stream({ audio: stream(chunks), format: STT_FORMAT.encoding }, opts)));
    assert.ok(sent.every(frame => frame.audio_base_64 && !frame.commit)); assert.equal(reports.length, 1);
  }
});

test('AIT-250: legacy is_final alone cannot satisfy the live finality contract', async () => {
  const tts = setup('tts', () => ({ send() {}, close() {}, events: (async function* () {
    yield JSON.stringify(ttsWire.audio); yield JSON.stringify({ is_final: true });
  })() }));
  await assert.rejects(collect(tts.speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, options([]))), { code: 'invalid-output' });
});

test('AIT-250: cancelled TTS dispatch still reports the matching window without text', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), reports = [];
  const tts = setup('tts', () => ({ send() {}, close() {}, events: {
    [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return new Promise(() => {}); }, return() { return { done: true }; },
  } }));
  const pending = collect(tts.speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, { ...options(reports), signal: controller.signal }));
  await entered.promise; controller.abort(); await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(reports.length, 1); assert.equal(reports[0].identityReason, 'no-request-id');
  assert.ok(reports[0].matchingKey.startedAt); assert.ok(reports[0].matchingKey.endedAt);
});
