import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoxtralSTT, createVoxtralTTS, STT_FORMAT, TTS_FORMAT } from '../src/index.js';
// Synthetic protocol fixtures, not captured provider traffic. Sources (2026-10-14):
// https://docs.mistral.ai/studio/audio/speech_to_text/realtime_transcription
// https://docs.mistral.ai/api/endpoint/audio/speech
// https://github.com/mistralai/client-python/tree/main/src/mistralai/client/models

const collect = async source => { const out = []; for await (const x of source) out.push(x); return out; };
const options = reports => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: 'offline-attempt', claimId: 'offline-claim', maxMicro: 10_000, consume() {} },
  report: terminal => reports.push(terminal) });
const config = { endpoint: 'https://api.mistral.ai', secretRef: 'fixture-only', voiceId: 'fixture-voice' };

test('AIT-160: Voxtral realtime encodes documented session and audio frames and finalizes only on done', async () => {
  const sent = [], reports = []; let closed = 0;
  const stt = createVoxtralSTT({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
    connect: async request => {
      assert.equal(new URL(request.url).searchParams.get('model'), 'voxtral-mini-transcribe-realtime-2602');
      return { send: wire => { sent.push(JSON.parse(wire)); }, close: () => { closed++; },
        events: (async function* () {
          yield JSON.stringify({ type: 'session.created', session: { request_id: 'fixture-session' } });
          yield JSON.stringify({ type: 'transcription.text.delta', text: 'Grüß ' });
          yield JSON.stringify({ type: 'transcription.text.delta', text: 'Gott' });
          yield JSON.stringify({ type: 'transcription.done', text: 'Grüß Gott', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
        })() };
    } });
  const events = await collect(stt.stream({ audio: (async function* () { yield Buffer.alloc(3200); })(), format: 'pcm_s16le' }, options(reports)));
  assert.equal(events.at(-1).text, 'Grüß Gott'); assert.equal(events.at(-1).final, true);
  assert.deepEqual(sent[0], { type: 'session.update', session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 }, target_streaming_delay_ms: 480 } });
  assert.equal(sent[1].type, 'input_audio.append'); assert.equal(sent.at(-1).type, 'input_audio.end');
  assert.equal(reports.length, 1); assert.equal(reports[0].usage.unit, 'seconds'); assert.equal(closed, 1);
  assert.equal((await stt.negotiateAudioFormat([STT_FORMAT], {})).encoding, 'pcm_s16le');
});

test('AIT-160: Voxtral TTS decodes fragmented SSE float32 PCM and a terminal usage event', async () => {
  const reports = [];
  const wire = 'data: {"type":"speech.audio.delta","audio_data":"AAAAAA=="}\r\n\r\ndata: {"type":"speech.audio.done","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n';
  const tts = createVoxtralTTS({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.mistral.ai/v1/audio/speech');
      assert.deepEqual(JSON.parse(request.body), { model: 'voxtral-mini-tts-2603', input: 'Hallo', voice_id: 'fixture-voice', response_format: 'pcm', stream: true });
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < wire.length; i += 7) controller.enqueue(new TextEncoder().encode(wire.slice(i, i + 7)));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  const audio = await collect(tts.speak({ text: 'Hallo', format: 'pcm_f32le' }, options(reports)));
  assert.deepEqual([...audio[0]], [0, 0, 0, 0]); assert.equal(reports.length, 1);
  assert.equal(reports[0].usage.unit, 'characters'); assert.equal(reports[0].usage.quantity, 5);
  assert.equal((await tts.negotiateAudioFormat([TTS_FORMAT], {})).encoding, 'pcm_f32le');
});

test('AIT-160: disabled adapters never resolve auth or invoke transport; truncated TTS stays uncertain', async () => {
  let network = 0;
  const disabled = createVoxtralTTS({ config, resolveSecret: () => { network++; }, fetchImpl: () => { network++; } });
  await assert.rejects(collect(disabled.speak({ text: 'Hallo', format: 'pcm_f32le' }, options([]))), { code: 'unavailable' });
  assert.equal(network, 0);
  const reports = [], tts = createVoxtralTTS({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
    fetchImpl: async () => new Response('data: {"type":"speech.audio.delta","audio_data":"AAAAAA=="}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(collect(tts.speak({ text: 'Hallo', format: 'pcm_f32le' }, options(reports))), { code: 'invalid-output' });
  assert.equal(reports[0].outcome, 'uncertain');
});

for (const status of [401, 403, 429, 500]) {
  test(`AIT-160: Voxtral HTTP ${status} is sanitized and retains one uncertain dispatched attempt`, async () => {
    const reports = [], tts = createVoxtralTTS({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
      fetchImpl: async () => new Response('synthetic private provider detail', { status }) });
    await assert.rejects(collect(tts.speak({ text: 'Hallo', format: 'pcm_f32le' }, options(reports))), {
      code: status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'provider' });
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  });
}

test('AIT-160: a stalled TTS transport that ignores cancellation settles exactly once', async () => {
  const controller = new AbortController(), reports = [], dispatched = Promise.withResolvers();
  const tts = createVoxtralTTS({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
    fetchImpl: () => { dispatched.resolve(); return new Promise(() => {}); } });
  const pending = collect(tts.speak({ text: 'Hallo', format: 'pcm_f32le' }, { ...options(reports), signal: controller.signal }));
  await dispatched.promise; controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
});

test('AIT-160: a refused component claim never resolves auth or opens a provider transport', async () => {
  let calls = 0; const reports = [];
  const tts = createVoxtralTTS({ enabled: true, config, resolveSecret: () => { calls++; }, fetchImpl: () => { calls++; } });
  const opts = options(reports); opts.attempt.consume = () => { throw new Error('synthetic refusal'); };
  await assert.rejects(collect(tts.speak({ text: 'Hallo', format: 'pcm_f32le' }, opts)));
  assert.equal(calls, 0); assert.equal(reports.length, 1); assert.equal(reports[0].chargedMicro, 0);
});


function burstTTS(chunks, done = true) {
  return createVoxtralTTS({ enabled: true, config, resolveSecret: () => 'synthetic-auth',
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      // Coalesced SSE events exercise the event bound independently of HTTP reads.
      const frames = chunks.map(bytes => 'data: ' + JSON.stringify({ type: 'speech.audio.delta', audio_data: bytes.toString('base64') }) + '\n\n');
      if (done) frames.push('data: {"type":"speech.audio.done","usage":{}}\n\n');
      controller.enqueue(new TextEncoder().encode(frames.join(''))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
}

test('AIT-258: Voxtral large deltas split aligned and byte-identical with terminal accounting', async () => {
  for (const size of [102_540, 1_048_576]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i % 251)), reports = [];
    const pieces = await collect(burstTTS([bytes, bytes]).speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, options(reports)));
    assert.ok(pieces.every(piece => piece.length > 0 && piece.length <= 64_000 && piece.length % 4 === 0));
    assert.equal(pieces.length, 2 * Math.ceil(size / 64_000));
    assert.deepEqual(Buffer.concat(pieces), Buffer.concat([bytes, bytes]));
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'completed'); assert.equal(reports[0].usage.quantity, 5);
    const truncated = [];
    await assert.rejects(collect(burstTTS([bytes], false).speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, options(truncated))), { code: 'invalid-output' });
    assert.equal(truncated.length, 1); assert.equal(truncated[0].outcome, 'uncertain');
  }
});

test('AIT-258: Voxtral keeps empty, alignment, 1 MiB message and 16 MB total bounds', async () => {
  for (const size of [0, 2, 1_048_580, 1_500_000]) {
    const reports = [];
    await assert.rejects(collect(burstTTS([Buffer.alloc(size)]).speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, options(reports))), { code: 'limit' });
    assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  }
  const bytes = Buffer.alloc(1_000_000), reports = []; let delivered = 0;
  await assert.rejects(async () => {
    for await (const part of burstTTS(Array(17).fill(bytes)).speak({ text: 'Hallo', format: TTS_FORMAT.encoding }, options(reports))) delivered += part.length;
  }, { code: 'limit' });
  assert.equal(delivered, 16_000_000); assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
});
