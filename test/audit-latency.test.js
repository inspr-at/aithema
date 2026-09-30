import { it } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyLedger, LATENCY_SCOPES, AuditWriter } from '../runtime/audit/index.js';
import { SqliteJournal } from '../runtime/journal/index.js';
import { authority, bytes, now, otherSid, session, sid } from './fixtures/journal/helpers.mjs';

it('(c) every latency scope uses an injectable monotonic clock and records milliseconds per session', () => {
  let time = 100;
  const ledger = new LatencyLedger({ now: () => time });
  for (const scope of LATENCY_SCOPES) {
    const handle = ledger.start(sid, scope);
    assert.deepEqual(handle, {});
    time += 12.5;
    assert.equal(ledger.finish(handle), 12.5);
    assert.deepEqual(ledger.stats(sid, scope), { count: 1, p50_ms: 12.5, p95_ms: 12.5 });
  }
  assert.equal(ledger.size, LATENCY_SCOPES.length);
  assert.equal(ledger.activeCount, 0);
  assert.equal(Object.isFrozen(LATENCY_SCOPES), true);
});

it('(c) p50/p95 use nearest rank, sort numerically and isolate session and scope', () => {
  const ledger = new LatencyLedger();
  for (let duration = 20; duration > 0; duration--) ledger.record(sid, 'spec_pass', duration);
  ledger.record(otherSid, 'spec_pass', 999);
  ledger.record(sid, 'design_render', 888);
  assert.deepEqual(ledger.stats(sid, 'spec_pass'), { count: 20, p50_ms: 10, p95_ms: 19 });
  assert.deepEqual(ledger.stats(otherSid, 'spec_pass'), { count: 1, p50_ms: 999, p95_ms: 999 });
  assert.deepEqual(ledger.stats(sid, 'design_render'), { count: 1, p50_ms: 888, p95_ms: 888 });
  assert.deepEqual(ledger.stats(sid, 'host_ack'), { count: 0, p50_ms: null, p95_ms: null });
  assert.equal(ledger.samples({ scope: 'spec_pass' }).length, 21);
});

it('(c) completed samples have a global bound even across arbitrarily many sessions', () => {
  const ledger = new LatencyLedger({ maxSamples: 3 });
  for (let i = 1; i <= 20; i++) {
    const sessionId = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    ledger.record(sessionId, 'host_ack', i);
    assert.equal(ledger.size, Math.min(i, 3));
  }
  assert.deepEqual(ledger.samples().map((s) => s.duration_ms), [18, 19, 20]);
});

it('(c) percentiles reflect only the bounded retained window after repeated ring wraparound', () => {
  const ledger = new LatencyLedger({ maxSamples: 3 });
  for (const duration of [1, 2, 3, 40, 50, 60, 70]) ledger.record(sid, 'host_ack', duration);
  assert.deepEqual(ledger.samples().map((s) => s.duration_ms), [50, 60, 70]);
  assert.deepEqual(ledger.stats(sid, 'host_ack'), { count: 3, p50_ms: 60, p95_ms: 70 });
  const single = new LatencyLedger({ maxSamples: 1 });
  single.record(sid, 'host_ack', 1);
  single.record(sid, 'host_ack', 0);
  assert.deepEqual(single.stats(sid, 'host_ack'), { count: 1, p50_ms: 0, p95_ms: 0 });
});

it('(c) open spans are independently bounded, finish once, and reject foreign handles', () => {
  let time = 0;
  const ledger = new LatencyLedger({ now: () => time, maxSpans: 2 });
  const first = ledger.start(sid, 'spec_pass');
  const second = ledger.start(otherSid, 'design_render');
  assert.throws(() => ledger.start(sid, 'host_ack'), /bound/);
  assert.equal(ledger.activeCount, 2);
  assert.throws(() => ledger.finish({}), /Unknown/);
  assert.throws(() => new LatencyLedger().finish(first), /Unknown/);
  time = 4;
  ledger.finish(first);
  assert.throws(() => ledger.finish(first), /Unknown/);
  ledger.cancel(second);
  assert.throws(() => ledger.finish(second), /Unknown/);
  assert.throws(() => ledger.cancel(second), /Unknown/);
  assert.equal(ledger.activeCount, 0);
  assert.equal(ledger.size, 1);
  assert.doesNotThrow(() => ledger.start(sid, 'host_ack'));
});

it('(c) backwards/nonfinite clocks and negative/nonfinite durations are explicit errors', () => {
  let time = 10;
  const ledger = new LatencyLedger({ now: () => time });
  const handle = ledger.start(sid, 'spec_pass');
  for (const invalid of [9, NaN, Infinity, -Infinity]) {
    time = invalid;
    assert.throws(() => ledger.finish(handle), RangeError);
    assert.equal(ledger.size, 0);
  }
  time = 10;
  assert.equal(ledger.finish(handle), 0);
  time = 9;
  assert.throws(() => ledger.start(sid, 'spec_pass'), RangeError);
  for (const invalid of [-1, NaN, Infinity, -Infinity, '1', null, { message: 'synthetic text' }]) {
    assert.throws(() => ledger.record(sid, 'spec_pass', invalid), RangeError);
  }
});

it('(c) fixed scopes, contract UUIDs and numeric samples prevent retaining message content', () => {
  const ledger = new LatencyLedger();
  const content = 'Synthetic message body for a rejected metric label';
  for (const invalidSid of [content, { message: content }, '', null, undefined]) {
    assert.throws(() => ledger.start(invalidSid, 'host_ack'), TypeError);
    assert.throws(() => ledger.record(invalidSid, 'host_ack', 1), TypeError);
  }
  for (const invalidScope of [content, { message: content }, '', null, undefined]) {
    assert.throws(() => ledger.start(sid, invalidScope), TypeError);
    assert.throws(() => ledger.record(sid, invalidScope, 1), TypeError);
  }
  // Extra metadata has no storage field, even when a JS caller supplies it.
  ledger.record(sid, 'host_ack', 2, { message: content });
  const samples = ledger.samples();
  assert.deepEqual(Object.keys(samples[0]), ['sid', 'scope', 'duration_ms']);
  assert.equal(JSON.stringify(samples).includes(content), false);
  samples[0].duration_ms = 999;
  samples[0].message = content;
  assert.deepEqual(ledger.stats(sid, 'host_ack'), { count: 1, p50_ms: 2, p95_ms: 2 });
  assert.equal(JSON.stringify(ledger.samples()).includes(content), false);
});

it('(c) purge removes one session and invalidates its unfinished spans while preserving ring order', () => {
  const ledger = new LatencyLedger({ now: () => 0, maxSamples: 4 });
  ledger.record(sid, 'spec_pass', 1);
  ledger.record(otherSid, 'spec_pass', 2);
  ledger.record(sid, 'spec_pass', 3);
  ledger.record(otherSid, 'spec_pass', 4);
  ledger.record(sid, 'spec_pass', 5);
  const removed = ledger.start(sid, 'host_ack');
  const kept = ledger.start(otherSid, 'host_ack');
  ledger.clearSession(sid);
  assert.equal(ledger.activeCount, 1);
  assert.throws(() => ledger.finish(removed), /Unknown/);
  assert.deepEqual(ledger.samples().map((s) => s.duration_ms), [2, 4]);
  ledger.finish(kept);
  for (const value of [6, 7, 8]) ledger.record(otherSid, 'spec_pass', value);
  assert.deepEqual(ledger.samples().map((s) => s.duration_ms), [0, 6, 7, 8]);
  assert.deepEqual(ledger.stats(sid, 'spec_pass'), { count: 0, p50_ms: null, p95_ms: null });
  ledger.clearSession(otherSid);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.activeCount, 0);
});

it('(c) measurements of overlapping spans use their own start time and one monotonic origin', () => {
  let time = 0;
  const ledger = new LatencyLedger({ now: () => time });
  const first = ledger.start(sid, 'turn_to_reaction_token');
  time = 5;
  const second = ledger.start(otherSid, 'reaction_first_audio');
  time = 12;
  assert.equal(ledger.finish(first), 12);
  time = 15;
  assert.equal(ledger.finish(second), 10);
});

it('(c) host ack is measurable around the actual write-ahead boundary without recording content', async (t) => {
  let time = 100;
  const ledger = new LatencyLedger({ now: () => time });
  const journal = new SqliteJournal(':memory:', { now });
  t.after(() => journal.close());
  journal.createSession(bytes(session()));
  const audit = new AuditWriter({ authority: authority(), now, port: {
    cursor: (a) => journal.cursor(a),
    async append(b, a) { time += 45; return journal.append(b, a); },
  } });
  await audit.start();
  const span = ledger.start(sid, 'host_ack');
  await audit.critical('ui.confirm', { item_ref: 'REQ-fixture', version: 1,
    content_sha256: 'a'.repeat(64), principal_ref: 'fixture-person' }, () => ledger.finish(span));
  assert.deepEqual(ledger.stats(sid, 'host_ack'), { count: 1, p50_ms: 45, p95_ms: 45 });
});

it('(c) invalid capacities and filters fail without silently changing retention', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new LatencyLedger({ maxSamples: value }), RangeError);
    assert.throws(() => new LatencyLedger({ maxSpans: value }), RangeError);
  }
  assert.throws(() => new LatencyLedger({ now: 1 }), TypeError);
  const ledger = new LatencyLedger();
  assert.throws(() => ledger.samples({ sid: 'content' }), TypeError);
  assert.throws(() => ledger.samples({ scope: 'content' }), TypeError);
  assert.throws(() => ledger.stats(sid, 'content'), TypeError);
  assert.throws(() => ledger.clearSession('content'), TypeError);
});
