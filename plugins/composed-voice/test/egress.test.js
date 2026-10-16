import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedVoiceCoordinator } from '../../../packages/server/src/composed-voice.js';
import { createComposedRelay } from '../src/relay.js';
import { createComposedRelayRoute } from '../src/network-relay.js';
import { createNetworkRelayClient } from '../src/network-client.js';
import { createComposedBrowserMedia } from '../src/client.js';
import { createPCMPlayer } from '../src/browser-audio.js';
import { createElevenLabsTTS } from '../../elevenlabs/src/components.js';
import { fixtureBinding, fixtureConsent, fixtureConfig } from '../../elevenlabs/test/component-fixtures.js';
import { createVoxtralTTS } from '../../voxtral/src/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const collect = async source => { for await (const _ of source) { /* drain */ } };
const sentence = 'Guten Tag, ich helfe Ihnen bei Ihrer Anfrage und fasse die wichtigsten Punkte zusammen. ';
const input = voiced => {
  const bytes = Buffer.alloc(voiced ? 3200 : 16_000);
  if (voiced) for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i);
  return bytes;
};

async function fixture(t, { format, text, pollDelay = 250, providerGap = false, providerLatency = 0 } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const at = Date.now(), sampleBytes = format === 'pcm_s16le' ? 2 : 4, bytesPerSecond = 24_000 * sampleBytes;
  const expected = [], delivered = [], scheduled = [], audible = [], events = [], failures = [], providerTimes = [], dispatches = [];
  const synthesis = async () => {
    dispatches.push(Date.now());
    if (providerLatency) await new Promise(resolve => setTimeout(resolve, providerLatency));
  };
  let fragment = 0, utterances = 0, stopCount = 0, coordinator, pollingBlocked = false;
  const relay = createComposedRelay({ callId: 'egress-call', providerSessionId: 'egress-segment',
    expiresAt: at + 60_000, spendDeadlineAt: at + 60_000, browserLivenessDeadlineAt: at + 60_000 });
  function* audioChunks() {
    const index = ++fragment, seconds = text.length === 240 ? 18 : 6;
    for (let second = 0; second < seconds; second += 6) {
      const bytes = Buffer.alloc(bytesPerSecond * 6);
      for (let i = 0; i < bytes.length; i += sampleBytes) {
        if (sampleBytes === 2) bytes.writeInt16LE(index * 2000, i); else bytes.writeFloatLE(index / 8, i);
      }
      expected.push(bytes); providerTimes.push(Date.now()); yield bytes;
    }
  }
  const tts = sampleBytes === 2 ? createElevenLabsTTS({ enabled: true, config: fixtureConfig,
    consent: fixtureConsent(fixtureBinding('tts')), resolveSecret: () => 'synthetic-auth',
    connect: async () => { await synthesis(); return { send() {}, close() {}, events: (async function* () {
      for (const bytes of audioChunks()) {
        if (providerGap && expected.length === 2) await new Promise(resolve => setTimeout(resolve, 4000));
        yield JSON.stringify({ audio: bytes.toString('base64'), isFinal: false });
      }
      yield JSON.stringify({ audio: null, isFinal: true });
    })() }; } }) : createVoxtralTTS({ enabled: true,
    config: { secretRef: 'synthetic-only', voiceId: 'fixture-voice' }, resolveSecret: () => 'synthetic-auth',
    fetchImpl: async () => { await synthesis(); return new Response(new ReadableStream({ start(controller) {
      for (const bytes of audioChunks()) controller.enqueue(new TextEncoder().encode(
        'data: ' + JSON.stringify({ type: 'speech.audio.delta', audio_data: bytes.toString('base64') }) + '\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"speech.audio.done","usage":{}}\n\n')); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }); } });
  const published = [], silences = [];
  coordinator = createComposedVoiceCoordinator({ sessionId: 'egress-session', callId: relay.grant.callId,
    providerSessionId: relay.grant.providerSessionId, spendDeadlineAt: at + 60_000, browserLivenessDeadlineAt: at + 60_000,
    outputFormat: format, outputAudioFormat: { encoding: format, sampleRateHz: 24_000, channels: 1 }, tts,
    stt: { async *stream({ audio }) { const turn = ++utterances; await collect(audio); yield { text: turn === 1 ? 'Ja' : '', final: true }; } },
    replyExecutor: { async *execute() {
      yield { type: 'operation', replyId: 'egress-reply' }; yield { type: 'delta', text };
      yield { type: 'completion', replyId: 'egress-reply', text };
    } }, authorize: async () => true, commitUtterance: async () => {},
    admitComponent: async () => ({ attempt: { attemptId: 'fixture-attempt', claimId: 'fixture-claim', maxMicro: 100_000, consume() {} }, report() {} }),
    relay: { event: event => relay.event(event), silence(frame) { silences.push(frame); relay.silence(frame); },
      audio(frame) { published.push({ ...frame, at: Date.now() }); relay.audio(frame); } } });
  relay.attach(coordinator);
  const route = createComposedRelayRoute({ authenticate: () => 'fixture-owner', authorize: async () => true,
    connect: grant => relay.connect(grant) });
  const openRelay = createNetworkRelayClient({ url: 'http://localhost/composed/relay', fetch: async (url, init) => {
    // Browser polls normally, with a bounded network/startup delay. Commands
    // (including interrupt) bypass polling and never await playback completion.
    if (init.headers['x-composed-action'] === 'frame' && pollingBlocked) await new Promise(resolve => setTimeout(resolve, pollDelay));
    return route.handle(new Request(url, init));
  } });
  class AudioContext {
    get currentTime() { return (Date.now() - at) / 1000; }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: Date.now() }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createBuffer(_channels, length, sampleRate) {
      const samples = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => samples };
    }
    createBufferSource() {
      let begin, end;
      const source = { connect() {}, disconnect() {}, start: start => {
        scheduled.push({ start, duration: source.buffer.duration });
        begin = setTimeout(() => audible.push({ at: Date.now(), value: source.buffer.getChannelData(0)[0] }), Math.max(0, (start - this.currentTime) * 1000));
        end = setTimeout(() => source.onended?.(), Math.max(0, (start + source.buffer.duration - this.currentTime) * 1000));
      }, stop() { clearTimeout(begin); clearTimeout(end); } };
      return source;
    }
  }
  const pcmPlayer = createPCMPlayer({ AudioContext, clock: Date.now });
  const media = createComposedBrowserMedia({ openRelay, capture: async () => ({ stop() {} }), player: {
    play(bytes, metadata) {
      delivered.push({ bytes: Buffer.from(bytes), at: Date.now(), ...metadata });
      return pcmPlayer.play(bytes, metadata).catch(error => { failures.push(error); throw error; });
    }, stop(options) { stopCount++; pcmPlayer.stop(options); }
  } });
  const session = await media.connect(relay.grant);
  void (async () => { for await (const event of session.events) events.push(event); })();
  t.after(async () => { await session.close(); route.close(); await coordinator.idle(); await pcmPlayer.close(); });
  await tick(); pollingBlocked = true;
  await coordinator.receiveAudio(input(true)); await coordinator.receiveAudio(input(false)); await tick();
  return { coordinator, relay, session, expected, delivered, published, silences, scheduled, audible, events, failures, providerTimes, dispatches,
    get fragments() { return fragment; }, get stopCount() { return stopCount; },
    async advance(ms) { for (let elapsed = 0; elapsed < ms; elapsed += 25) { t.mock.timers.tick(25); await tick(); } } };
}

for (const format of ['pcm_s16le', 'pcm_f32le']) {
  test(`AIT-258: ${format} three fragments hide subsequent synthesis latency without sentence gaps`, async t => {
    const started = 1_800_000_000_000, providerLatency = 1500;
    const h = await fixture(t, { format, text: sentence.repeat(3), providerLatency });
    assert.equal(h.published.length, 0, 'the first fragment still pays provider latency');
    await h.advance(23_000); await h.coordinator.idle();
    assert.equal(h.fragments, 3); assert.equal(h.failures.length, 0);
    assert.equal(h.published[0].at, started + providerLatency, 'pacing adds no first-audio delay');
    assert.deepEqual(h.dispatches, [started, started + providerLatency, started + 2 * providerLatency]);
    assert.deepEqual(Buffer.concat(h.delivered.map(frame => frame.bytes)), Buffer.concat(h.expected));
    assert.ok(h.scheduled.length > 3);
    for (let i = 1; i < h.scheduled.length; i++) {
      const previousEnd = h.scheduled[i - 1].start + h.scheduled[i - 1].duration;
      assert.ok(Math.abs(h.scheduled[i].start - previousEnd) < 0.000001, 'no gap or overlap in the player timeline, including sentence boundaries');
    }
    assert.ok(!h.events.some(event => event.type === 'waiting'));
  });

  for (const text of ['a'.repeat(240), sentence.repeat(3)]) {
    test(`AIT-258: ${format} ${text.length === 240 ? '240-character fragment' : 'three sentences'} traverses paced egress in order`, async t => {
      const h = await fixture(t, { format, text });
      assert.ok(h.published.length > 0, 'first frame is published without advancing the clock');
      assert.equal(h.published[0].at, h.providerTimes[0], 'pacing adds zero first-audio latency');
      await h.advance(21_000); await h.coordinator.idle();
      assert.equal(h.coordinator.state.state, 'active'); assert.equal(h.failures.length, 0);
      assert.equal(h.events.filter(event => ['waiting', 'ended'].includes(event.type)).length, 0);
      assert.equal(h.fragments, text.length === 240 ? 1 : 3);
      assert.deepEqual(Buffer.concat(h.delivered.map(frame => frame.bytes)), Buffer.concat(h.expected));
      assert.ok(h.delivered.every(frame => frame.format === format && frame.sampleRateHz === 24_000 && frame.channels === 1));
      let seconds = 0;
      for (const frame of h.published) {
        seconds += frame.bytes.length / (format === 'pcm_s16le' ? 48_000 : 96_000);
        assert.ok(seconds <= (frame.at - h.published[0].at) / 1000 + 1.001, 'one-second lead spans sentence boundaries');
      }
      assert.ok(h.scheduled.every((row, i) => !i || row.start >= h.scheduled[i - 1].start + h.scheduled[i - 1].duration - 0.000001));
      assert.ok(h.audible.length > 0);
    });
  }
  test(`AIT-258: ${format} barge-in flushes a paced reply and fences stale frames`, async t => {
    const h = await fixture(t, { format, text: 'a'.repeat(240) });
    await h.advance(750);
    assert.ok(h.delivered.length > 0); const before = h.stopCount;
    const revision = h.published.at(-1).playbackRevision, published = h.published.length;
    // Voiced ingress must silence before this asynchronous operation settles.
    const silent = h.silences.length;
    const pending = h.coordinator.receiveAudio(input(true));
    assert.equal(h.silences.length, silent + 1, 'server silence flush is synchronous');
    assert.equal(h.silences.at(-1).reason, 'barge-in');
    assert.equal(h.coordinator.state.state, 'active');
    await pending; await h.advance(250);
    assert.ok(h.stopCount > before, 'silence reaches the player on the next poll');
    const played = h.audible.length, delivered = h.delivered.length;
    for (let i = 0; i < 10; i++) h.relay.audio({ playbackRevision: revision, format, sampleRateHz: 24_000, channels: 1, bytes: new Uint8Array(64_000) });
    await h.advance(10_000); await h.coordinator.idle();
    assert.equal(h.published.length, published, 'cancelled pacing cannot publish another frame');
    assert.equal(h.delivered.length, delivered, 'silence fences even a stale producer refilling the relay');
    assert.equal(h.audible.length, played, 'future scheduled sources were physically stopped');
    assert.equal(h.failures.length, 0);
  });
}

test('AIT-258: provider gaps do not accumulate catch-up burst credit', async t => {
  const h = await fixture(t, { format: 'pcm_s16le', text: 'a'.repeat(240), providerGap: true });
  await h.advance(26_000); await h.coordinator.idle();
  assert.equal(h.failures.length, 0); assert.equal(h.coordinator.state.state, 'active');
  assert.deepEqual(Buffer.concat(h.delivered.map(frame => frame.bytes)), Buffer.concat(h.expected));
  for (let i = 1; i < h.published.length; i++) {
    const window = h.published.filter(frame => frame.at >= h.published[i].at && frame.at < h.published[i].at + 500);
    assert.ok(window.reduce((sum, frame) => sum + frame.bytes.length, 0) <= 72_000, 'a stalled provider cannot refill several seconds at once');
  }
});
