import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, stopReason, spendGuard, diagnosticRecords, disruptionAt, schedule, validateOptions } from './live/soak-model.js';
import { createSoakLog } from './live/diagnostic-host.js';
import * as model from './live/soak-model.js';
import { canonicalWav } from './live/offline-audio.js';

test('AIT-139: scheduled WAV duration ends at the last speech sample, not padding', () => {
  const bytes = Buffer.alloc(44 + 48_000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(96_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  bytes.writeInt16LE(-1000, 44 + (24_000 - 1) * 2);
  const wav = canonicalWav(bytes);
  assert.equal(wav.readUInt32LE(40) / 96_000, .5, 'half a second of trailing silence cannot extend speech end');
  assert.deepEqual(wav.subarray(44), bytes.subarray(44, 44 + 24_000 * 2));
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.throws(() => canonicalWav(Buffer.alloc(44)), /PCM WAV/);
});

test('AIT-139: client latency and five-second deadlines start at speech end', () => {
  const turns = [
    { atMs: 100, speechEndMs: 8100, firstResponseAtMs: 9100 },
    { atMs: 20_000, speechEndMs: 28_000, firstResponseAtMs: 33_000 },
    { atMs: 40_000, speechEndMs: 48_000, firstResponseAtMs: 53_001 },
    { atMs: 60_000, speechEndMs: 68_000 },
  ];
  const client = model.summarizeClient({ turns, mode: 'live', firstTokenMs: 5000 });
  assert.deepEqual(client.firstResponse, { samples: 3, p50Ms: 5000, p95Ms: 5001, reference: 'speech-end' });
  assert.equal(client.missingResponses, 1);
  assert.equal(client.deadlineMisses, 2);
  assert.equal(client.turnTimings[0].firstResponseMs, 1000, 'eight seconds of speech do not consume the response deadline');
});

test('AIT-139: unmeasurable live speech end reports gate timing without failing', () => {
  const turns = [{ atMs: 100, firstResponseAtMs: 10_100 }, { atMs: 20_000 }];
  const client = model.summarizeClient({ turns, mode: 'live', firstTokenMs: 5000 });
  assert.equal(client.firstResponse.p95Ms, null, 'gate timing must not enter speech-end quantiles');
  assert.equal(client.gateOpenResponse.p95Ms, 10_000);
  assert.equal(client.unmeasurableSpeechEnds, 2);
  assert.equal(client.missingResponses, 1);
  assert.equal(client.deadlineMisses, 0);
  assert.equal(model.summarizeClient({ turns, mode: 'fake', firstTokenMs: 5000 }).deadlineMisses, 2);
});

test('AIT-139: responses before speech end cannot become negative or satisfy the deadline', () => {
  const client = model.summarizeClient({ mode: 'live', firstTokenMs: 5000,
    turns: [{ atMs: 0, speechEndMs: 8000, firstResponseAtMs: 500 },
      { atMs: 20_000, speechEndMs: 28_000, firstResponseAtMs: 28_000 }] });
  assert.equal(client.firstResponse.samples, 1);
  assert.equal(client.firstResponse.p50Ms, 0);
  assert.equal(client.deadlineMisses, 1);
});

test('AIT-139: live combined rate floor cannot disable the elapsed-time cost bound', () => {
  const live = { mode: 'live', ops: true, url: 'https://example.invalid', diagnostics: '/tmp/sanitized.jsonl' };
  for (const rateUsd of [0, .000001, .119999]) assert.throws(() => validateOptions({ ...live, rateUsd }), /rate/);
  assert.equal(validateOptions({ ...live, rateUsd: .12 }).rateMicroPerMinute, 120_000);
  assert.equal(validateOptions({}).rateMicroPerMinute, 0, 'fake mode has no paid upstream');
});

test('AIT-139: nearest-rank report percentiles preserve zero and empty samples', () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([100, 0, 20, 30, 10], .5), 20);
  assert.equal(percentile([100, 0, 20, 30, 10], .95), 100);
});

test('AIT-139: report joins attempts, keeps retries, and counts missing/failed deadlines', () => {
  const identity = { callHash: 'a', generationHash: 'b', turnHash: 'c', attemptHash: 'd' };
  const report = summarize({ records: [
    { ...identity, event: 'voice.turn.admission' },
    { ...identity, event: 'voice.turn.first-token', firstTokenMs: 0 },
    { ...identity, event: 'voice.turn.completion', totalMs: 90, outcome: 'completed' },
    { ...identity, event: 'voice.turn.closure', closureConfirmed: true },
    { ...identity, event: 'voice.turn.retry' },
    { ...identity, attemptHash: 'e', event: 'voice.turn.admission' },
    { ...identity, attemptHash: 'e', event: 'voice.turn.first-token', firstTokenMs: 20 },
    { ...identity, attemptHash: 'e', event: 'voice.turn.completion', totalMs: 200, outcome: 'failed' },
    { ...identity, turnHash: 'other', attemptHash: 'f', event: 'voice.turn.admission' },
  ], events: [{ type: 'recovering' }, { type: 'recovered' }], firstTokenMs: 50, totalMs: 100 });
  assert.deepEqual(report.firstToken, { samples: 2, p50Ms: 0, p95Ms: 20, missed: 1 }, 'an on-time first token stays on time after a later completion failure');
  assert.deepEqual(report.total, { samples: 2, p50Ms: 90, p95Ms: 200, missed: 2 });
  assert.equal(report.attempts, 3); assert.equal(report.retries, 1);
  assert.equal(report.recoveries, 1); assert.equal(report.failed, 1);
  assert.equal(report.unclosed, 1, 'generation/turn closure also covers earlier retry attempts');
});

test('AIT-139: cap counts confirmed, uncertain and the conservative time bound', () => {
  const opts = { elapsedMs: 1000, maxDurationMs: 60_000, capMicro: 8_000_000,
    confirmedMicro: 1_000_000, uncertainMicro: 0, rateMicroPerMinute: 120_000, stopReserveMicro: 100_000 };
  assert.equal(stopReason(opts), null);
  assert.equal(stopReason({ ...opts, confirmedMicro: 7_900_000 }), 'cost-cap');
  assert.equal(stopReason({ ...opts, uncertainMicro: 6_900_000 }), 'cost-cap');
  assert.equal(stopReason({ ...opts, elapsedMs: 60_000 }), 'max-duration');
  assert.equal(stopReason({ ...opts, confirmedMicro: NaN }), 'invalid-cost');
  assert.equal(stopReason({ ...opts, confirmedMicro: -1 }), 'invalid-cost');
  assert.equal(stopReason({ ...opts, elapsedMs: 4_000_000, maxDurationMs: 5_000_000 }), 'cost-cap');
});

test('AIT-139: disruption windows have exact boundaries and recover to normal', () => {
  const plan = [{ atMs: 10, durationMs: 5, offline: true, latencyMs: 0 },
    { atMs: 20, durationMs: 10, offline: false, latencyMs: 400 }];
  assert.equal(disruptionAt(plan, 9), null);
  assert.equal(disruptionAt(plan, 10), plan[0]);
  assert.equal(disruptionAt(plan, 14), plan[0]);
  assert.equal(disruptionAt(plan, 15), null);
  assert.equal(disruptionAt(plan, 20), plan[1]);
  assert.equal(disruptionAt(plan, 30), null);
});

test('AIT-139: hard cap invokes abort once and arms a deadline independent of wallet requests', () => {
  const reasons = [], timers = [], cleared = [];
  const config = { maxDurationMs: 3_600_000, capMicro: 8_000_000, stopReserveMicro: 250_000, rateMicroPerMinute: 1_000_000 };
  const guard = spendGuard(config, { abort: reason => reasons.push(reason),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 42; }, clearTimer: id => cleared.push(id) });
  assert.equal(timers[0].ms, 465_000);
  guard.check({ elapsedMs: 10, confirmedMicro: 7_750_000, uncertainMicro: 0 });
  timers[0].fn();
  assert.deepEqual(reasons, ['cost-cap']);
  guard.dispose(); assert.deepEqual(cleared, [42]);
});

test('AIT-139: diagnostic projection refuses other calls and drops private/free-form data', () => {
  const hash = 'a'.repeat(64);
  const records = diagnosticRecords(JSON.stringify({ event: 'voice.turn.first-token', callHash: hash,
    firstTokenMs: 42, text: 'private', cause: 'private', url: 'private' }) + '\n'
    + JSON.stringify({ event: 'voice.turn.retry', callHash: 'b'.repeat(64) }) + '\nnot json', hash);
  assert.deepEqual(records, [{ event: 'voice.turn.first-token', callHash: hash, firstTokenMs: 42 }]);
});

test('AIT-139: OPS host exports JSON and legacy object records without private fields', () => {
  const lines = [], log = createSoakLog(line => lines.push(JSON.parse(line))), hash = 'a'.repeat(64);
  log(JSON.stringify({ event: 'voice.turn.admission', callHash: hash, admissionMs: 1, text: 'private' }));
  log({ event: 'voice.cost-reconciled', callHash: hash, chargedMicro: 10, closureConfirmed: true, secret: 'private' });
  log({ event: 'voice-availability', reason: 'private' }); log('not json');
  assert.deepEqual(lines, [
    { event: 'voice.turn.admission', callHash: hash, admissionMs: 1 },
    { event: 'voice.cost-reconciled', callHash: hash, chargedMicro: 10, closureConfirmed: true },
  ]);
});

test('AIT-139: 5/60-minute plans fit the cap, contain turns, barge-in and both disruptions', () => {
  for (const minutes of [5, 60]) {
    const plan = schedule(minutes * 60_000);
    assert.ok(plan.turns.length >= minutes);
    assert.ok(plan.turns.some(t => t.bargeIn));
    assert.ok(plan.disruptions.some(d => d.offline));
    assert.ok(plan.disruptions.some(d => d.latencyMs > 0));
    assert.ok(plan.disruptions.every(d => d.atMs + d.durationMs < minutes * 60_000));
    assert.ok(plan.turns.every(t => t.atMs < minutes * 60_000));
  }
});

test('AIT-139: CLI defaults to fake, bounds duration/cap, and refuses implicit live starts', () => {
  assert.equal(validateOptions({}).mode, 'fake');
  assert.throws(() => validateOptions({ minutes: 61 }), /duration/);
  assert.throws(() => validateOptions({ capUsd: 8.01 }), /cap/);
  assert.throws(() => validateOptions({ maxDuration: 0 }), /duration/);
  assert.throws(() => validateOptions({ mode: 'live' }), /OPS/);
  assert.throws(() => validateOptions({ mode: 'live', ops: true, locale: 'en' }), /DE/);
});
