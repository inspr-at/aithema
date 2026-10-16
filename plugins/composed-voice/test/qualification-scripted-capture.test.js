import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
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

import { pageFixture } from './qualification-page-fixture.js';

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

for (const options of [{ missingDiagnostics: true }, { sourceFailure: 'start-failed' }, { productError: true }, { closeError: true }, { errorAfterStop: true }])
test(`candidate errors abort even with complete timing: ${JSON.stringify(options)}`, async t => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true, ...options });
  await assert.rejects(h.run());
  const persisted = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true, ...options });
  await assertFailureDiagnostic(t, persisted.run);
});

for (const stopBeforeSource of [false, true]) test(`candidate waits for rendered silence; source-clock onset survives reversed callback delivery (${stopBeforeSource})`, async () => {
  const h = await pageFixture(undefined, { firstAudio: true, bargeIn: true, productStop: true, stopBeforeSource });
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

for (const deadlineSeconds of [1, 20, 50, 51, 60, 120]) test(`candidate observation fits ${deadlineSeconds}s sample deadline`, async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true,
    deadlineSeconds, deadlineElapsedMs: 100 });
  assert.equal((await h.run()).refusal, 'missing-playback-stop');
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].ms <= Math.min(50_000, deadlineSeconds * 1000 - 600));
  assert.ok(h.timers[0].ms >= Math.min(50_000, deadlineSeconds * 1000 - 650));
});

for (const teardownStop of [false, true]) test(`explicit stop alone cannot qualify (teardown ${teardownStop})`, async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true,
    productStop: true, teardownStop, silentOutput: teardownStop });
  const result = await h.run();
  assert.equal(result.refusal, 'missing-playback-stop');
  assert.equal(result.trace.some(row => row.kind === 'playback-stop'), false);
  assert.equal(result.trace.find(row => row.kind === 'playback-stop-request').origin, teardownStop ? 'teardown' : 'interrupt');
});

test('evidence probe refuses teardown-originated stop events', () => {
  const probe = createQualificationMediaProbe();
  for (const event of [{ kind: 'capture', voiced: true, captureAt: 1, durationMs: 4 },
    { kind: 'playback-start', firstAudioAt: 10 }, { kind: 'capture', voiced: true, captureAt: 810, durationMs: 64 },
    { kind: 'playback-stop', stoppedAt: 910, origin: 'teardown' }]) probe.onTiming(event);
  assert.throws(() => probe.evidence(), error => error.reason === 'missing-playback-stop');
});

test('candidate rendered silence qualifies without an explicit player stop', async () => {
  const h = await pageFixture(undefined, { firstAudio: true, bargeIn: true, productStop: true, explicitStop: false });
  const result = await h.run();
  assert.equal(result.refusal, undefined);
  assert.equal(result.trace.find(row => row.kind === 'playback-stop').stoppedAt, 910);
  assert.equal(result.trace.some(row => row.kind === 'playback-stop-request'), false);
});

for (const at of [840, 850, 910]) test(`teardown cannot create a qualifying silent output block at ${at} ms`, async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true,
    teardownStop: true, outputTrace: [{ at, durationMs: 21, voiced: false, timestamp: { contextTime: at / 1000, performanceTime: at } }] });
  const result = await h.run();
  assert.equal(result.refusal, 'missing-playback-stop');
  assert.equal(result.trace.some(row => row.kind === 'playback-stop'), false);
});

test('a fully rendered silent block before teardown remains valid evidence', async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true,
    teardownStop: true, outputTrace: [{ at: 820, durationMs: 21, voiced: false, timestamp: { contextTime: .82, performanceTime: 820 } }] });
  const result = await h.run();
  assert.equal(result.refusal, undefined);
  assert.equal(result.trace.find(row => row.kind === 'playback-stop').stoppedAt, 820);
});

for (const gap of [120, 250]) test(`candidate sustained output stop refuses a ${gap} ms word gap before resumed speech`, async () => {
  const h = await pageFixture('closed', { type: 'ended', firstAudio: true, bargeIn: true, productStop: true,
    outputTrace: [{ at: 10, durationMs: 800, rms: .2, voiced: true },
      { at: 910, durationMs: gap, rms: 0, voiced: false },
      { at: 910 + gap, durationMs: 20, rms: .2, voiced: true }] });
  const run = h.run();
  // The sample deadline has arrived with no sustained quiet run. No sleep and
  // no explicit stop request can manufacture the missing rendered evidence.
  await Promise.resolve(); await Promise.resolve();
  h.timers[0].fn();
  const result = await run;
  assert.equal(result.refusal, 'missing-playback-stop');
  assert.equal(result.trace.some(row => row.kind === 'playback-stop'), false);
});
