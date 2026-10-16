import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installScriptedCapture } from '../ops/qualification-scripted-capture.mjs';
import { createQualificationMediaProbe } from '../src/live-qualification.js';

function sourceFixture() {
  const contexts = [], starts = [], stops = [];
  let now = 42000;
  class Node {
    connect(destination) { return destination; } disconnect() {}
    start(at) { starts.push({ at, buffer: this.buffer }); }
    stop() { stops.push(this); }
  }
  class Context {
    constructor() { this.currentTime = 0; this.sampleRate = 16000; this.destination = new Node(); contexts.push(this); }
    createMediaStreamDestination() { return { stream: { clone: () => ({ synthetic: true }), getTracks: () => [] } }; }
    createGain() { return Object.assign(new Node(), { gain: {} }); }
    createScriptProcessor() { return this.processor = new Node(); }
    createBufferSource() { return new Node(); }
    createBuffer(channels, frames, rate) {
      const samples = new Float32Array(frames);
      return { rate, samples, getChannelData: () => samples };
    }
    async resume() {} async close() { this.closed = true; }
  }
  const runtime = { AudioContext: Context, navigator: { mediaDevices: { async getUserMedia() { assert.fail('physical mic must not open'); } } },
    atob: value => Buffer.from(value, 'base64').toString('binary'), performance: { now: () => now } };
  runtime.window = runtime;
  const clip = { sampleRateHz: 16000, pcm: Buffer.from([0, 32, 0, 224]).toString('base64') };
  runInNewContext(`(${installScriptedCapture.toString()})(${JSON.stringify({ utterance: clip, bargeIn: clip })})`, runtime);
  const advance = seconds => { contexts[0].currentTime = seconds; now = 42000 + seconds * 1000; };
  const render = (time, level) => {
    advance(time + .1);
    const samples = new Float32Array(1024).fill(level);
    contexts[0].processor.onaudioprocess({ playbackTime: time + samples.length / 16000,
      inputBuffer: { duration: samples.length / 16000, getChannelData: () => samples } });
  };
  return { runtime, capture: runtime.qualificationScriptedCapture, contexts, starts, advance, render };
}

for (const delays of [[2500, 4000], [4000, 2500]]) for (const reversedDelivery of [false, true])
test(`both lanes barge in relative to fast/slow first reply (${delays}; reversed delivery ${reversedDelivery})`, async () => {
  for (const [lane, delay] of ['candidate', 'baseline'].map((lane, i) => [lane, delays[i]])) {
    const h = sourceFixture(), probe = createQualificationMediaProbe(), captured = [];
    h.capture.subscribe(event => captured.push(event));
    const stream = await h.runtime.navigator.mediaDevices.getUserMedia({ audio: true });
    assert.equal(stream.synthetic, true); assert.equal(h.starts.length, 0, `${lane}: silence until ready`);
    h.advance(.2); h.capture.startUtterance(); h.capture.startUtterance();
    assert.equal(h.starts.length, 1); assert.equal(h.starts[0].at, .2);
    assert.equal(h.starts[0].buffer.samples[0], .25, 'identical unmodified input');
    h.render(.2, .25); h.render(.264, 0);
    const firstAudioAt = 42264 + delay;
    h.advance((firstAudioAt - 42000) / 1000 + .01);
    h.capture.firstAudio(firstAudioAt); h.capture.firstAudio(firstAudioAt + 100);
    assert.equal(h.starts.length, 2, 'only one barge-in phrase');
    assert.ok(Math.abs(42000 + h.starts[1].at * 1000 - firstAudioAt - 800) < .001);
    const onset = { kind: 'playback-start', firstAudioAt };
    if (reversedDelivery) probe.onTiming(onset);
    captured.forEach(probe.onTiming);
    if (!reversedDelivery) probe.onTiming(onset);
    const events = []; h.capture.subscribe(event => events.push(event));
    h.render(h.starts[1].at, .25); events.forEach(probe.onTiming);
    probe.onTiming({ kind: 'playback-stop', stoppedAt: firstAudioAt + 950 });
    const evidence = probe.evidence();
    assert.ok(Math.abs(evidence.speechEndAt - 42264) < .001);
    assert.ok(Math.abs(evidence.bargeInAt - firstAudioAt - 800) < .001);
    await h.capture.close(); assert.equal(h.contexts[0].closed, true);
  }
});

test('late observed onset refuses scheduling instead of playing an unanchored second turn', async () => {
  const h = sourceFixture(); await h.runtime.navigator.mediaDevices.getUserMedia({ audio: true });
  h.capture.startUtterance(); h.advance(5); h.capture.firstAudio(42100);
  assert.equal(h.starts.length, 1); assert.equal(h.capture.diagnostics().failure, 'late-first-audio');
  await h.capture.close();
});

// Execute the real page harness with fake media ports, so refusal returned from
// page.evaluate retains the trace rather than throwing past the run coordinator.
async function pageFixture(reason) {
  const source = (await readFile(new URL('../ops/qualification-page.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gmu, '');
  let onTiming, sourceTiming, started = false, connected = false, closed = false;
  const runtime = { setTimeout, clearTimeout,
    createPCMPlayer(options) { onTiming = options.onTiming; return { async close() {} }; },
    createPCMCapture: () => {}, createNetworkRelayClient: () => {},
    createComposedBrowserMedia: () => ({ async connect() {
      connected = true;
      return { events: (async function* () { yield { type: 'waiting', reason }; })(), async close() {} };
    } }),
    qualificationScriptedCapture: { subscribe(fn) { sourceTiming = fn; return () => {}; },
      startUtterance() {
        assert.equal(connected, true); started = true;
        sourceTiming({ kind: 'capture', captureAt: 1, voiced: true, durationMs: 64 });
        onTiming({ kind: 'playback-scheduled', scheduledAt: 10 });
      }, firstAudio() {}, async close() { closed = true; } },
  };
  runtime.window = runtime;
  runInNewContext(source, runtime);
  return { run: () => runtime.composedQualification.run({ grant: {}, headers: {} }), state: () => ({ started, closed }) };
}

test('candidate ready precedes utterance; media waiting limit returns one value-free refusal and trace', async () => {
  const h = await pageFixture('limit'), result = await h.run();
  assert.equal(result.refusal, 'media-wait-limit'); assert.equal(result.trace.length, 2);
  assert.deepEqual(h.state(), { started: true, closed: true });
});

test('unrelated media waiting errors keep abort semantics', async () => {
  const h = await pageFixture('transport-failed');
  await assert.rejects(h.run(), /Qualification media waiting: transport-failed/);
});
