import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsSTT, createElevenLabsTTS, STT_FORMAT, TTS_FORMAT } from '../src/components.js';
import { fixtureSocket, fixtureBinding, fixtureConsent, fixtureConfig as config, fixtureVoiceSettings, sttWire, ttsWire, unverified } from './component-fixtures.js';
import { createQualificationBudget, runOfflineQualification } from '../../composed-voice/src/qualification.js';
import { validateVoiceSettings } from '../src/voice-settings.js';

const collect = async source => { const result = []; for await (const item of source) result.push(item); return result; };
const options = reports => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: 'fixture-attempt', claimId: 'fixture-claim', maxMicro: 1000, consume() {} }, report: terminal => reports.push(terminal) });
const audio = () => (async function* () { yield Buffer.alloc(3200); })();
const request = role => role === 'stt' ? { audio: audio(), format: STT_FORMAT.encoding } : { text: 'Hallo', format: TTS_FORMAT.encoding };
const factory = role => role === 'stt' ? createElevenLabsSTT : createElevenLabsTTS;
const run = (role, adapter, opts) => collect(role === 'stt' ? adapter.stream(request(role), opts) : adapter.speak(request(role), opts));
const setup = (role, extra = {}) => factory(role)({ enabled: true, config, consent: fixtureConsent(fixtureBinding(role)), resolveSecret: () => 'synthetic-auth',
  connect: () => fixtureSocket({ role }), ...extra });

test('AIT-403 component receipt matching evidence uses the invocation clock', async t => {
  const wall = Date.parse('2030-06-15T00:00:30Z');
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => wall - 60_000, reports = [], consent = fixtureConsent(fixtureBinding('tts'));
  consent.port.coverage = ({ scope, consentRevision }) => ({ ...scope, scope, covered: true, consentRevision,
    checkedAt: now(), expiresAt: now() + 60_000 });
  const adapter = setup('tts', { consent });
  await run('tts', adapter, { ...options(reports), now, deadlineAt: now() + 5000 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].matchingKey.startedAt, new Date(now()).toISOString());
  assert.equal(reports[0].matchingKey.endedAt, new Date(now()).toISOString());
});

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
  assert.deepEqual(sent, [sttWire.chunk(Buffer.alloc(64_000).toString('base64'), true)]);
  assert.equal(closes, 1); assert.equal(reports.length, 1);
  assert.equal(reports[0].usage.quantity, 2); assert.equal(reports[0].usage.unit, 'seconds');
  assert.equal(reports[0].chargedMicro, 20); assert.equal(reports[0].usage.estimated, true);
  assert.deepEqual(reports[0].identity, { sessionId: sttWire.session().session_id });
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
  assert.equal(reports[0].identity, null); assert.equal(reports[0].identityReason, 'no-request-id');
});

test('AIT-249: TTS validates and snapshots explicit voice settings and sends them for each synthesis', async () => {
  const sent = [], voiceSettings = { ...fixtureVoiceSettings };
  const tts = setup('tts', { config: { ...config, voiceSettings },
    connect: () => fixtureSocket({ role: 'tts', onSend: frame => sent.push(frame) }) });
  voiceSettings.speed = 1.1;
  for (let i = 0; i < 2; i++) await run('tts', tts, options([]));
  assert.deepEqual(sent.filter(frame => frame.text === ' '), Array.from({ length: 2 }, () => ({ text: ' ', voice_settings: fixtureVoiceSettings })));
  for (const voiceSettings of [null, {}, { ...fixtureVoiceSettings, speed: 2 }, { ...fixtureVoiceSettings, stability: '0.5' }]) {
    assert.throws(() => setup('tts', { config: { ...config, voiceSettings } }), /voice settings/);
  }
});

test('AIT-250: start2 saved null settings pass unchanged and only nulls are omitted on every TTS initialization', async () => {
  for (const [style, use_speaker_boost] of [[null, null], [null, false], [0, null], [0, false], [1, true]]) {
    const saved = { stability: 0.5, similarity_boost: 0.8, style, use_speaker_boost, speed: 1 };
    const voiceSettings = { ...saved }, sent = [];
    assert.deepEqual(validateVoiceSettings(saved), saved);
    const tts = setup('tts', { config: { ...config, voiceSettings },
      connect: () => fixtureSocket({ role: 'tts', onSend: frame => sent.push(frame) }) });
    voiceSettings.style = 0.5; voiceSettings.use_speaker_boost = true;
    for (let i = 0; i < 2; i++) await run('tts', tts, options([]));
    const expected = { stability: 0.5, similarity_boost: 0.8,
      ...(style === null ? {} : { style }), ...(use_speaker_boost === null ? {} : { use_speaker_boost }), speed: 1 };
    assert.deepEqual(sent.filter(frame => frame.text === ' '), Array.from({ length: 2 }, () => ({ text: ' ', voice_settings: expected })));
  }
});

for (const role of ['stt', 'tts']) test(`AIT-248: ${role} preserves a returned upgrade request-id and no invalid ID`, async () => {
  for (const requestId of ['fixture-request', undefined, 'unsafe id', 'x'.repeat(129)]) {
    const reports = [], adapter = setup(role, { connect: () => ({ ...fixtureSocket({ role }), requestId }) });
    await run(role, adapter, options(reports));
    assert.deepEqual(reports[0].identity, role === 'stt'
      ? { sessionId: 'fixture-session', ...(requestId === 'fixture-request' ? { requestId } : {}) }
      : requestId === 'fixture-request' ? { requestId } : null);
  }
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
      assert.equal(reports[0].identity, null); assert.equal(reports[0].identityReason, role === 'tts' ? 'no-request-id' : 'stt-provider-identity-not-observed');
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
  const result = await runOfflineQualification({ candidateComponents: (item, { now }) => ({
    stt: setup('stt', { consent: fixtureConsent(fixtureBinding('stt'), true, now),
      connect: () => fixtureSocket({ role: 'stt', text: item.reference }) }),
    tts: setup('tts', { consent: fixtureConsent(fixtureBinding('tts'), true, now) }),
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


function burstTTS(chunks, final = true) {
  return setup('tts', { connect: () => ({ send() {}, close() {}, events: (async function* () {
    for (const bytes of chunks) yield JSON.stringify({ ...ttsWire.audio, audio: bytes.toString('base64') });
    if (final) yield JSON.stringify(ttsWire.done);
  })() }) });
}

test('AIT-258: real-sized ElevenLabs chunks split byte-for-byte and settle only on isFinal', async () => {
  for (const size of [102_540, 1_048_576]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i % 251)), reports = [];
    const pieces = await run('tts', burstTTS([bytes]), options(reports));
    assert.ok(pieces.every(piece => piece.length > 0 && piece.length <= 64_000 && piece.length % 2 === 0));
    assert.deepEqual(pieces.map(piece => piece.length), Array.from({ length: Math.ceil(size / 64_000) }, (_, i) => Math.min(64_000, size - i * 64_000)));
    assert.deepEqual(Buffer.concat(pieces), bytes);
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'completed');
    assert.equal(reports[0].usage.quantity, 7); assert.equal(reports[0].chargedMicro, 14);
    const truncated = [];
    await assert.rejects(run('tts', burstTTS([bytes], false), options(truncated)), { code: 'invalid-output' });
    assert.equal(truncated.length, 1); assert.equal(truncated[0].outcome, 'uncertain');
  }
});

test('AIT-258: ElevenLabs keeps empty, alignment, 1 MiB message and 16 MB total bounds', async () => {
  for (const size of [0, 3, 1_048_578, 1_500_000]) {
    const reports = [];
    await assert.rejects(run('tts', burstTTS([Buffer.alloc(size)]), options(reports)), { code: 'limit' });
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  }
  const bytes = Buffer.alloc(1_000_000), reports = []; let delivered = 0;
  await assert.rejects(async () => {
    for await (const part of burstTTS(Array(17).fill(bytes)).speak(request('tts'), options(reports))) delivered += part.length;
  }, { code: 'limit' });
  assert.equal(delivered, 16_000_000); assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
});
