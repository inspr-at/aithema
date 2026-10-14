import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, stopReason, spendGuard, diagnosticRecords, disruptionAt, schedule, validateOptions } from './live/soak-model.js';

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
    { ...identity, attemptHash: 'e', event: 'voice.turn.completion', totalMs: 200, outcome: 'failed' },
    { ...identity, attemptHash: 'f', event: 'voice.turn.admission' },
  ], events: [{ type: 'recovering' }, { type: 'recovered' }], firstTokenMs: 50, totalMs: 100 });
  assert.deepEqual(report.firstToken, { samples: 1, p50Ms: 0, p95Ms: 0, missed: 2 });
  assert.deepEqual(report.total, { samples: 2, p50Ms: 90, p95Ms: 200, missed: 2 });
  assert.equal(report.attempts, 3); assert.equal(report.retries, 1);
  assert.equal(report.recoveries, 1); assert.equal(report.failed, 1);
  assert.equal(report.unclosed, 2);
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
