import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrokTTS, TTS_FORMAT } from '../src/tts.js';
import { config, operation, expiredEvidenceAt } from './fixtures.js';
import { ttsHarness, ttsText, TTS_DOC, PRICE_DOC } from './tts-fixtures.js';
const collect = async source => { const values = []; for await (const value of source) values.push(value); return values; };
const request = { text: ttsText, voice: 'eve', language: 'de', format: 'pcm_s16le' };
const component = (h, extra = {}) => createGrokTTS({ config, enabled: true, resolveSecret: () => 'synthetic-only', connect: h.connect, ...extra });

test(`terminal trace completes with estimated code-point usage, explicit PCM (${TTS_DOC}; ${PRICE_DOC})`, async () => {
  const h = ttsHarness(), op = operation(), tts = component(h);
  const chunks = await collect(tts.speak(request, op.options));
  assert.equal(chunks.reduce((n, bytes) => n + bytes.byteLength, 0), 4);
  const query = new URL(h.urls[0]).searchParams;
  assert.equal(query.get('codec'), 'pcm'); assert.equal(query.get('sample_rate'), '24000');
  assert.equal(query.get('voice'), 'eve'); assert.equal(query.get('speed'), '1'); assert.equal(query.get('language'), 'de');
  assert.deepEqual(h.sent, [{ type: 'text.delta', delta: ttsText }, { type: 'text.done' }]);
  assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'completed');
  assert.equal(op.reports[0].usage.quantity, [...ttsText].length);
  assert.equal(op.reports[0].usage.upstreamMicro, [...ttsText].length * 15);
  assert.equal(op.reports[0].usage.estimated, true);
  assert.match(op.reports[0].usage.source, /code-points/);
  assert.equal(tts.capabilities.heardPrefix, 'unavailable'); assert.equal(tts.speakAligned, undefined);
  assert.deepEqual(await tts.negotiateAudioFormat([TTS_FORMAT], {}), TTS_FORMAT);
  assert.equal(h.fixtures.activeCount(), 0);
});
for (const [mode, code] of [['malformed', 'invalid-output'], ['bad-base64', 'invalid-output'],
  ['noncanonical-base64', 'invalid-output'], ['odd-pcm', 'invalid-output'], ['overflow', 'limit'],
  ['overflow-total', 'limit'], ['missing-final', 'invalid-output'], ['missing-trace', 'invalid-output'], ['interrupted', 'invalid-output']]) {
  test(`${mode} retains the reservation (${TTS_DOC})`, async () => {
    const h = ttsHarness({ mode }), op = operation();
    await assert.rejects(collect(component(h).speak(request, op.options)), { code });
    assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'uncertain');
    assert.equal(op.reports[0].chargedMicro, op.options.attempt.maxMicro); assert.equal(h.fixtures.activeCount(), 0);
  });
}
for (const mode of ['active-cancelled', 'active-deadline', 'stalled-after-audio', 'late-open']) {
  test(`${mode} bounded cleanup and uncertain cost (${TTS_DOC})`, async () => {
    const h = ttsHarness({ mode }), abort = new AbortController(), op = operation({ signal: abort.signal,
      deadlineAt: Date.now() + (mode === 'active-cancelled' ? 1000 : 30) });
    const timer = mode === 'active-cancelled' ? setTimeout(() => abort.abort(), 20) : undefined;
    try { await assert.rejects(collect(component(h).speak(request, op.options)), { code: mode === 'active-cancelled' ? 'cancelled' : 'deadline' }); }
    finally { clearTimeout(timer); }
    if (mode === 'late-open') await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'uncertain');
    assert.equal(op.reports[0].chargedMicro, 1000000); assert.equal(h.fixtures.activeCount(), 0);
  });
}
test(`eager bounded reader completes while playback consumer pauses (${TTS_DOC})`, async () => {
  const h = ttsHarness(), op = operation(), source = component(h).speak(request, op.options);
  const first = await source.next(); assert.equal(first.value.byteLength, 4);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.fixtures.activeCount(), 0); assert.equal(op.reports.length, 1);
  assert.equal(op.reports[0].outcome, 'completed'); await source.return();
});
test('fresh claims for fragment/retry; no internal retries', async () => {
  const h = ttsHarness(), tts = component(h);
  for (const [i, text] of ['Grüße', '😀', '😀'].entries()) {
    const op = operation(); op.options.attempt.attemptId = `fragment-${i}`; op.options.attempt.claimId = `claim-${i}`;
    await collect(tts.speak({ ...request, text }, op.options));
    assert.equal(op.consumed, 1); assert.equal(op.reports[0].attemptId, `fragment-${i}`);
    assert.equal(op.reports[0].usage.quantity, [...text].length);
  }
  assert.equal(h.fixtures.requestCount(), 3);
});
test('invalid configuration, request or refused consume performs no secret/transport work', async () => {
  const h = ttsHarness(); let secrets = 0;
  assert.throws(() => component(h, { config: { ...config, voice: 'unknown' } }));
  const tts = component(h, { resolveSecret() { secrets++; return 'synthetic-only'; } });
  for (const changes of [{ voice: 'unknown' }, { format: 'mp3' }, { language: 'fr' }, { text: '\ud800' }, { text: 'x'.repeat(32769) }]) {
    await assert.rejects(collect(tts.speak({ ...request, ...changes }, operation().options)));
  }
  const op = operation(); op.options.attempt.consume = () => { throw Object.assign(new Error(), { code: 'not-admitted' }); };
  await assert.rejects(collect(tts.speak(request, op.options)), { code: 'not-admitted' });
  await tts.health(); await tts.negotiateAudioFormat([TTS_FORMAT], {});
  assert.equal(secrets, 0); assert.equal(h.fixtures.requestCount(), 0);
});

test(`iterator abandonment closes stalled generation and retains reservation (${TTS_DOC})`, async () => {
  const h = ttsHarness({ mode: 'stalled-after-audio' }), op = operation();
  const source = component(h).speak(request, op.options);
  assert.equal((await source.next()).value.byteLength, 4); await source.return();
  assert.equal(op.reports.length, 1); assert.equal(op.reports[0].outcome, 'uncertain');
  assert.equal(op.reports[0].chargedMicro, 1000000); assert.equal(h.fixtures.activeCount(), 0);
});
test(`event ceiling and malformed transport close once (${TTS_DOC})`, async () => {
  const h = ttsHarness(), op = operation();
  await assert.rejects(collect(component(h, { config: { ...config, maxEvents: 1 } }).speak(request, op.options)), { code: 'limit' });
  assert.equal(op.reports[0].outcome, 'uncertain'); assert.equal(h.fixtures.activeCount(), 0);
  let closes = 0; const malformed = component(h, { connect: async () => ({ close() { closes++; } }) });
  await assert.rejects(collect(malformed.speak(request, operation().options)), { code: 'invalid-output' });
  assert.equal(closes, 1);
});
test('expired evidence, small ceiling and cancelled claim never resolve a secret', async () => {
  const h = ttsHarness(); let secrets = 0;
  const tts = component(h, { resolveSecret() { secrets++; return 'synthetic-only'; } });
  const abort = new AbortController(); abort.abort();
  for (const options of [operation({ signal: abort.signal }).options, operation({ deadlineAt: Date.now() - 1 }).options,
    { ...operation().options, attempt: { ...operation().options.attempt, maxMicro: 1 } }]) {
    await assert.rejects(collect(tts.speak(request, options)));
  }
  assert.throws(() => component(h, { config: { ...config, accountEvidence: { ...config.accountEvidence, expiresAt: expiredEvidenceAt } } }));
  assert.equal(secrets, 0); assert.equal(h.fixtures.requestCount(), 0);
});
