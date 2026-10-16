import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installQualificationOutputProbe } from '../ops/qualification-output-timing.js';

function fixture() {
  class Node { connect(destination) { return destination; } disconnect() {} }
  const runtime = { AudioNode: Node, setTimeout, clearTimeout };
  runtime.window = runtime;
  runInNewContext(`(${installQualificationOutputProbe.toString()})()`, runtime);
  return runtime.qualificationOutputProbe;
}

const block = (at, durationMs, rms = 0) => ({ at, durationMs, rms, voiced: rms >= .015,
  timestamp: { contextTime: (at + durationMs) / 1000, performanceTime: at + durationMs } });
const silence = (at, durationMs, rms = 0) => Array.from({ length: Math.ceil(durationMs / 20) }, (_, i) => block(at + i * 20, Math.min(20, durationMs - i * 20), rms));
const reply = () => [block(0, 100, .2)];

for (const gap of [120, 250, 600, 980]) test(`sustained output stop rejects a ${gap} ms gap followed by speech`, () => {
  const probe = fixture();
  const trace = [...reply(), block(100, gap), block(100 + gap, 20, .1)];
  assert.equal(probe.stop(trace, 100), undefined);
});

test('sustained output stop is confirmed only after 1000 ms and timestamps the run start', () => {
  const probe = fixture(), trace = [...reply(), ...silence(100, 980)];
  assert.equal(probe.stop(trace, 100), undefined);
  trace.push(block(1080, 20));
  const stop = probe.stop(trace, 100);
  assert.equal(stop.stoppedAt, 100);
  assert.equal(stop.confirmedAt, 1100);
  assert.equal(stop.silenceDurationMs, 1000);
  assert.equal(stop.outputRmsThreshold, .002);
  assert.equal(stop.origin, 'rendered-silence');
});

test('sustained output stop resets on a voiced block, including a quiet fade-out tail', () => {
  const probe = fixture();
  const trace = [...reply(), ...silence(100, 250), block(360, 20, .01),
    block(380, 20, .0021), ...silence(400, 1000, .0019)];
  assert.equal(probe.stop(trace, 100).stoppedAt, 400, 'tail above 1% of reply RMS is still output');
});

test('sustained output threshold scales with the reply level, independently of capture VAD', () => {
  for (const level of [.2, .002, .00002]) {
    const trace = [block(0, 100, level), block(100, 20, level * .011), ...silence(120, 1000, level * .009)];
    const stop = fixture().stop(trace, 100);
    assert.equal(stop.stoppedAt, 120);
    assert.equal(stop.outputRmsThreshold, level * .01);
  }
});

test('sustained output stop requires contiguous complete blocks after barge-in and before teardown', () => {
  const probe = fixture();
  assert.equal(probe.stop([...reply(), ...silence(100, 500), ...silence(620, 500)], 100), undefined, 'missing blocks are not silence');
  assert.equal(probe.stop([...reply(), ...silence(100, 1000)], 110), undefined, 'a straddling block cannot start the run');
  assert.equal(probe.stop([...reply(), ...silence(100, 1000)], 100, 1099), undefined, 'confirmation must precede teardown');
  assert.equal(probe.stop([...reply(), ...silence(100, 1000)], 100, 1100).stoppedAt, 100);
  assert.equal(probe.stop([block(100, NaN)], 100), undefined, 'unknown duration cannot prove silence');
  assert.equal(probe.stop(silence(100, 1000), 100), undefined, 'silence alone cannot establish a reply level');
});

test('sustained output stop orders rendered blocks and ignores late source callback delivery', () => {
  const trace = [...reply(), ...silence(100, 1000)].reverse();
  assert.equal(fixture().stop(trace, 100).stoppedAt, 100);
});

test('sustained output stop uses device continuity despite performance timestamp jitter', () => {
  const trace = [...reply(), ...silence(100, 1000).map((entry, i) => ({ ...entry,
    contextTime: entry.at / 1000, at: entry.at + (i % 2 ? .4 : -.4) }))];
  assert.equal(fixture().stop(trace, 99).stoppedAt, 99.6);
  trace.splice(20, 1);
  assert.equal(fixture().stop(trace, 99), undefined, 'clock jitter cannot conceal a missing device block');
});

test('output tap waits for the entire PCM block to render before reporting evidence', () => {
  const timers = [], rendered = [];
  class Node { connect(destination) { return destination; } disconnect() {} }
  const runtime = { AudioNode: Node, setTimeout(fn) { timers.push(fn); }, clearTimeout() {} };
  runtime.window = runtime;
  runInNewContext(`(${installQualificationOutputProbe.toString()})()`, runtime);
  const sink = new Node(); let renderedTime = .01;
  const context = { sampleRate: 48000, destination: new Node(), createScriptProcessor: () => sink,
    createGain: () => Object.assign(new Node(), { gain: {} }),
    getOutputTimestamp: () => ({ contextTime: renderedTime, performanceTime: renderedTime * 1000 }) };
  runtime.qualificationOutputProbe.tap({ context }, block => rendered.push(block));
  const samples = new Float32Array(1024).fill(.002), duration = 1024 / 48000;
  sink.onaudioprocess({ playbackTime: duration, inputBuffer: { duration, getChannelData: () => samples } });
  assert.equal(rendered.length, 0, '10 ms of a 21.3 ms block is not fully rendered');
  renderedTime = duration; timers.shift()();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].rms, Math.fround(.002));
  assert.equal(rendered[0].voiced, true, 'quiet output does not inherit capture VAD');
  runtime.qualificationOutputProbe.close();
});
