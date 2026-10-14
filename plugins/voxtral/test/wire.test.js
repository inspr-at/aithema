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
