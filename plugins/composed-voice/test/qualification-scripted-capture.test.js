import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { assertFailureDiagnostic } from './qualification-failure-fixture.js';
import { installScriptedCapture } from '../ops/qualification-scripted-capture.mjs';
import { createQualificationMediaProbe, IncompleteMediaEvidence } from '../src/live-qualification.js';

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
  assert.equal(h.starts.length, 1); assert.equal(h.capture.diagnostics().refusal, 'late-first-audio');
  assert.equal(h.capture.diagnostics().failure, undefined);
  await h.capture.close();
});

// Execute the real page harness with fake media ports, so refusal returned from
// page.evaluate retains the trace rather than throwing past the run coordinator.
async function pageFixture(reason, { type = 'waiting', firstAudio = false, bargeIn = false, sourceRefusal, sourceFailure,
  missingDiagnostics = false, closeError = false, productStop = false, productError = false } = {}) {
  const source = (await readFile(new URL('../ops/qualification-page.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gmu, '');
  let onTiming, sourceTiming, started = false, connected = false, closed = false, interrupts = 0, inputChanges = 0;
  const runtime = { setTimeout, clearTimeout,
    createPCMPlayer(options) { onTiming = options.onTiming; return { async close() {} }; },
    createPCMCapture: () => {}, createNetworkRelayClient: () => {},
    createComposedBrowserMedia: () => ({ async connect() {
      connected = true;
      return { events: (async function* () {
        if (bargeIn) {
          sourceTiming({ kind: 'capture', captureAt: 810, voiced: true, durationMs: 64 });
          assert.equal(interrupts, 0, 'source observation cannot interrupt');
          assert.equal(inputChanges, 0, 'capture stays open for product VAD');
        }
        if (productError) throw new Error('product event exception');
        if (productStop) onTiming({ kind: 'playback-stop', stoppedAt: 910 });
        else yield { type, reason };
      })(), async interrupt() { interrupts++; }, async setInput() { inputChanges++; },
        async close() { if (closeError) throw new Error('close failed'); } };
    } }),
    qualificationScriptedCapture: { subscribe(fn) { sourceTiming = fn; return () => {}; },
      diagnostics() { return missingDiagnostics ? undefined : { started, barged: firstAudio, failure: sourceFailure, refusal: sourceRefusal }; },
      startUtterance() {
        assert.equal(connected, true); started = true;
        sourceTiming({ kind: 'capture', captureAt: 1, voiced: true, durationMs: 4 });
        onTiming({ kind: 'playback-scheduled', scheduledAt: 10 });
        if (firstAudio) onTiming({ kind: 'playback-start', firstAudioAt: 10 });
      }, firstAudio() {
        if (sourceRefusal || sourceFailure) sourceTiming({ kind: 'capture-outcome',
          status: sourceFailure ? 'error' : 'refused', reason: sourceFailure || sourceRefusal });
      }, async close() { closed = true; } },
  };
  runtime.window = runtime;
  runInNewContext(source, runtime);
  return { run: () => runtime.composedQualification.run({ grant: {}, headers: {} }), state: () => ({ started, closed, interrupts, inputChanges }) };
}

for (const [type, reason] of [['waiting', 'limit'], ['waiting', 'transport-failed'], ['ended', 'closure-uncertain'],
  ['ended', 'start-failed'], ['ended', 'transport-failed'], ['ended', 'protocol-error']]) {
  test(`candidate ${type}:${reason} aborts instead of inferring a timing refusal`, async t => {
    const h = await pageFixture(reason, { type, firstAudio: true, bargeIn: true });
    await assert.rejects(h.run(), new RegExp(`Qualification media ${type}: ${reason}`));
    assert.equal(h.state().closed, true);
    const persisted = await pageFixture(reason, { type, firstAudio: true, bargeIn: true });
    await assertFailureDiagnostic(t, persisted.run);
  });
}

for (const firstAudio of [false, true]) test(`normal end refuses only a real timing miss (first audio ${firstAudio})`, async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio, bargeIn: firstAudio });
  const result = await h.run();
  assert.equal(result.refusal, firstAudio ? 'missing-playback-stop' : 'late-first-audio');
  assert.equal(h.state().interrupts, 0); assert.equal(h.state().inputChanges, 0);
});

test('source refusal reaches candidate immediately rather than falling through to a timer', async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, sourceRefusal: 'late-first-audio' });
  assert.equal((await h.run()).refusal, 'late-first-audio');
});

for (const options of [{ missingDiagnostics: true }, { sourceFailure: 'start-failed' }, { productError: true }, { closeError: true }])
test(`candidate errors abort even with complete timing: ${JSON.stringify(options)}`, async t => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true, ...options });
  await assert.rejects(h.run());
  const persisted = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true, ...options });
  await assertFailureDiagnostic(t, persisted.run);
});

test('candidate waits for product stop; bargeInAt uses the same source clock as the baseline', async () => {
  const h = await pageFixture(undefined, { firstAudio: true, bargeIn: true, productStop: true });
  const result = await h.run(), probe = createQualificationMediaProbe();
  result.trace.forEach(probe.onTiming);
  assert.equal(result.refusal, undefined);
  assert.equal(probe.evidence().bargeInAt, 810); assert.equal(probe.evidence().stoppedAt, 910);
  assert.deepEqual(h.state(), { started: true, closed: true, interrupts: 0, inputChanges: 0 });
});

test('external refusal reasons cannot insert values into diagnostics', () => {
  assert.throws(() => new IncompleteMediaEvidence('PRIVATE_EXTERNAL_REASON'), error => {
    assert.equal(error.message, 'Unknown qualification media refusal'); return true;
  });
});
