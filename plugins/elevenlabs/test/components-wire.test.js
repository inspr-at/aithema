import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsSTT, createElevenLabsTTS, STT_FORMAT, TTS_FORMAT } from '../src/components.js';
import { fixtureSocket, fixtureBinding, fixtureConsent, fixtureConfig as config, sttWire, ttsWire, unverified } from './component-fixtures.js';
import { createQualificationBudget, runOfflineQualification } from '../../composed-voice/src/qualification.js';

const collect = async source => { const result = []; for await (const item of source) result.push(item); return result; };
const options = reports => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: 'fixture-attempt', claimId: 'fixture-claim', maxMicro: 1000, consume() {} }, report: terminal => reports.push(terminal) });
const audio = () => (async function* () { yield Buffer.alloc(3200); })();
const request = role => role === 'stt' ? { audio: audio(), format: STT_FORMAT.encoding } : { text: 'Hallo', format: TTS_FORMAT.encoding };
const factory = role => role === 'stt' ? createElevenLabsSTT : createElevenLabsTTS;
const run = (role, adapter, opts) => collect(role === 'stt' ? adapter.stream(request(role), opts) : adapter.speak(request(role), opts));
const setup = (role, extra = {}) => factory(role)({ enabled: true, config, consent: fixtureConsent(fixtureBinding(role)), resolveSecret: () => 'synthetic-auth',
  connect: () => fixtureSocket({ role }), ...extra });

test('AIT-160: ElevenLabs STT sends documented PCM16/manual-commit frames after endpointing', async () => {
  const sent = [], reports = []; let closes = 0;
  const stt = setup('stt', { connect: req => {
    const url = new URL(req.url);
    assert.equal(url.pathname, '/v1/speech-to-text/realtime'); assert.equal(url.protocol, 'wss:');
    assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
    assert.equal(url.searchParams.get('audio_format'), 'pcm_16000'); assert.equal(url.searchParams.get('commit_strategy'), 'manual');
    assert.deepEqual(req.headers, { 'xi-api-key': 'synthetic-auth' });
    return fixtureSocket({ role: 'stt', onSend: x => sent.push(x), onClose: () => closes++ });
  } });
  assert.deepEqual(await stt.negotiateAudioFormat([STT_FORMAT], {}), STT_FORMAT);
  const events = await run('stt', stt, options(reports));
  assert.deepEqual(events, [{ text: 'Grüß', final: false }, { text: 'Grüß Gott', final: true }]);
  assert.deepEqual(sent, [sttWire.chunk(Buffer.alloc(3200).toString('base64')), sttWire.chunk('', true)]);
  assert.equal(closes, 1); assert.equal(reports.length, 1);
  assert.equal(reports[0].usage.quantity, 0.1); assert.equal(reports[0].usage.unit, 'seconds');
  assert.equal(reports[0].chargedMicro, 1); assert.equal(reports[0].usage.estimated, true);
  assert.equal(stt.estimateCost({ maxDurationMs: 30000 }), 300);
});

test('AIT-160: ElevenLabs TTS streams explicit PCM16/24k and includes trailing wire space in character estimate', async () => {
  const sent = [], reports = []; let closed = 0;
  const tts = setup('tts', { connect: req => {
    const url = new URL(req.url); assert.equal(url.pathname, '/v1/text-to-speech/fixture-voice/stream-input');
    assert.equal(url.searchParams.get('output_format'), 'pcm_24000'); assert.equal(url.searchParams.get('model_id'), 'eleven_flash_v2_5');
    return fixtureSocket({ role: 'tts', onSend: x => sent.push(x), onClose: () => closed++ });
  } });
  assert.deepEqual(await tts.negotiateAudioFormat([TTS_FORMAT], {}), TTS_FORMAT);
  assert.deepEqual(await run('tts', tts, options(reports)), [new Uint8Array(4)]);
  assert.deepEqual(sent, [ttsWire.initialize, ttsWire.text('Hallo '), ttsWire.end]);
  assert.equal(closed, 1); assert.equal(reports.length, 1); assert.equal(reports[0].usage.quantity, 7);
  assert.equal(reports[0].chargedMicro, 14); assert.equal(tts.estimateCost({ text: 'Hallo' }), 14);
  assert.ok(unverified.length);
});

for (const role of ['stt', 'tts']) {
  test(`AIT-160: ${role} disabled, missing tariff, refused claim and missing consent prevent dispatch`, async () => {
    let calls = 0; const spy = () => { calls++; };
    for (const extra of [{ enabled: false }, { config: { ...config, sttMicroPerSecond: undefined, ttsMicroPerCharacter: undefined } },
      { consent: fixtureConsent(fixtureBinding(role), false) }, { consent: undefined }]) {
      await assert.rejects(run(role, setup(role, { resolveSecret: spy, connect: spy, ...extra }), options([])));
    }
    const opts = options([]); opts.attempt.consume = () => { throw new Error('Refused'); };
    await assert.rejects(run(role, setup(role, { resolveSecret: spy, connect: spy }), opts)); assert.equal(calls, 0);
  });
  for (const status of [400, 401, 403, 408, 422, 429, 499, 500]) {
    test(`AIT-198: ${role} transport-observed ${status} without usage settles once`, async () => {
      const reports = [], opts = options(reports), budget = createQualificationBudget();
      const claim = budget.reserve({ attemptId: opts.attempt.attemptId, maxMicro: 1000 });
      opts.attempt = claim; opts.report = terminal => { reports.push(terminal); claim.report(terminal); };
      await assert.rejects(run(role, setup(role, { connect: () => { throw Object.assign(new Error('private detail'), { status }); } }), opts),
        { code: [401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider', message: [401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider' });
      const rejectedWithoutUsage = status < 500 && ![408, 499].includes(status);
      assert.equal(reports.length, 1); assert.equal(budget.snapshot().exposureMicro, rejectedWithoutUsage ? 0 : 1000);
      assert.equal(reports[0].outcome, rejectedWithoutUsage ? 'cancelled' : 'uncertain');
    });
  }
  test(`AIT-160: ${role} abort closes synchronously, stalls cannot defer once-only uncertain settlement`, async () => {
    const controller = new AbortController(), dispatched = Promise.withResolvers(), reports = []; let closed = 0;
    const adapter = setup(role, { connect: () => ({ send() {}, close() { closed++; }, events: {
      [Symbol.asyncIterator]() { return this; }, next() { dispatched.resolve(); return new Promise(() => {}); }, return() { return { done: true }; }
    } }) });
    const pending = run(role, adapter, { ...options(reports), signal: controller.signal });
    await dispatched.promise; controller.abort(); assert.equal(closed, 1);
    await assert.rejects(pending, { code: 'cancelled' }); assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  });
  test(`AIT-160: ${role} malformed/truncated protocol retains reservation`, async () => {
    for (const frames of [[], ['not-json'], [JSON.stringify(role === 'stt' ? sttWire.final('early') : { isFinal: true })]]) {
      const reports = [];
      const adapter = setup(role, { connect: () => ({ send() {}, close() {}, events: (async function* () { yield* frames; })() }) });
      await assert.rejects(run(role, adapter, options(reports)), { code: 'invalid-output' });
      assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
    }
  });
  test(`AIT-160: ${role} successful estimates retain maximum, reconcile only attempt-bound evidence`, async () => {
    const budget = createQualificationBudget(), claim = budget.reserve({ attemptId: 'estimated', maxMicro: 1000 });
    const adapter = setup(role);
    await run(role, adapter, { deadlineAt: Date.now() + 5000, attempt: claim, report: x => claim.report(x) });
    assert.equal(budget.snapshot().exposureMicro, 1000);
    assert.equal(await adapter.reconcileCost({ attemptId: 'estimated' }, {}), null);
    for (const receipt of [{ attemptId: 'other', chargedMicro: 1, estimated: false }, { attemptId: 'estimated', chargedMicro: 1, estimated: true }]) {
      assert.equal(await setup(role, { reconcileReceipt: () => receipt }).reconcileCost({ attemptId: 'estimated' }, {}), null);
    }
    assert.deepEqual(await setup(role, { reconcileReceipt: () => ({ attemptId: 'estimated', chargedMicro: 1, estimated: false }) })
      .reconcileCost({ attemptId: 'estimated' }, {}), { chargedMicro: 1, estimated: false, source: 'host-component-receipt' });
  });
}

test('AIT-160: TTS rejects >240 fragments, wrong format, and under-reservation before dispatch', async () => {
  let calls = 0; const tts = setup('tts', { connect: () => { calls++; } });
  for (const req of [{ text: 'x'.repeat(241), format: 'pcm_s16le' }, { text: 'Hallo', format: 'pcm_f32le' }]) {
    await assert.rejects(collect(tts.speak(req, options([]))), TypeError);
  }
  const opts = options([]); opts.attempt.maxMicro = 1;
  await assert.rejects(collect(tts.speak(request('tts'), opts)), { code: 'not-admitted' }); assert.equal(calls, 0);
});

test('AIT-160: ElevenLabs fixture candidate runs offline qualification against existing baseline', async () => {
  const result = await runOfflineQualification({ candidateComponents: item => ({
    stt: setup('stt', { connect: () => fixtureSocket({ role: 'stt', text: item.reference }) }), tts: setup('tts'),
  }) });
  assert.equal(result.candidate.wer, 0); assert.equal(result.candidate.entityAccuracy, 1);
  assert.equal(result.candidate.firstAudioMs.p95, 900); assert.equal(result.candidate.bargeInStopMs, 0);
  assert.equal(result.candidate.qualified, false); assert.equal(result.baseline.qualified, false);
  assert.equal(result.componentAttempts, result.samples * 4); assert.ok(result.spendMicro > 0 && result.spendMicro < 25_000_000);
  console.log('ELEVENLABS_OFFLINE_QUALIFICATION', JSON.stringify(result));
});

for (const role of ['stt', 'tts']) test(`AIT-160: ${role} late connection after cancellation is closed without dispatching frames`, async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers(), reports = [];
  let closed = 0, sends = 0;
  const adapter = setup(role, { connect: async () => {
    entered.resolve(); await release.promise;
    return { close() { closed++; }, send() { sends++; }, events: (async function* () {})() };
  } });
  const pending = run(role, adapter, { ...options(reports), signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(pending, { code: 'cancelled' });
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(sends, 0); assert.equal(reports.length, 1);
});

for (const role of ['stt', 'tts']) {
  test(`AIT-198: ${role} 4xx carrying usage cannot release reservation as zero`, async () => {
    const reports = [];
    const adapter = setup(role, { connect: () => { throw { status: 429, usage: { unverified: true } }; } });
    await assert.rejects(run(role, adapter, options(reports)), { code: 'rate-limit' });
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  });
  test(`AIT-160: ${role} exact consent scope rejects expired, withdrawn and mismatched grants`, async () => {
    let calls = 0;
    for (const mutation of [{ expiresAt: 0 }, { withdrawn: true }, { itemVersion: 2 }, { scope: {} }, { consentRevision: 0 }]) {
      const consent = fixtureConsent(fixtureBinding(role)), original = consent.port.coverage;
      consent.port.coverage = async request => ({ ...await original(request), ...mutation });
      await assert.rejects(run(role, setup(role, { consent, connect: () => { calls++; } }), options([])), { code: 'not-admitted' });
    }
    assert.equal(calls, 0);
  });
}
