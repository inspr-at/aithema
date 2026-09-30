import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledRenderer, DesignScheduler, EngineError } from '../runtime/engine/index.js';
import { FakeClock, fixture, bytes, snapshot } from './engine-helpers.test.js';

function scheduler({ plan, waitMs = 30_000 } = {}) {
  const clock = new FakeClock();
  const renderer = new ControlledRenderer({ clock, plan });
  let revision = 1;
  const errors = [];
  const design = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: revision, fixture: `revision-${revision}` }), waitMs, onError: (e) => errors.push(e) });
  const intent = (id, rev = ++revision) => { revision = rev; design.intent({ intent_id: id, working_rev: rev }); };
  return { clock, renderer, design, intent, errors };
}

// R4-n3/R5-M1: these assert measured injected-clock bounds, including the
// intent immediately after start, the busy run's retry and the next retry.
for (const [activeRetry, nextRetry, bound] of [[false, false, 150_000], [true, false, 210_000], [false, true, 210_000], [true, true, 270_000]]) {
  it(`freshness <=${bound / 1000}s: just-after-start intent, active retry=${activeRetry}, next retry=${nextRetry}`, async () => {
    const s = scheduler({ plan: ({ revision, attempt }) => ({ duration_ms: 60_000,
      fail: attempt === 1 && (revision.working_rev === 1 ? activeRetry : nextRetry) }) });
    s.intent('first', 1);
    await s.clock.advance(30_000);
    assert.equal(s.design.state.busy, true);
    await s.clock.advance(1);
    s.intent('just-after-start', 2);
    await s.clock.advance(bound - 1);
    const intent = s.design.state.intents.find((i) => i.intent_id === 'just-after-start');
    assert.equal(intent.state, 'rendered');
    assert.equal(intent.rendered_rev, 2);
    assert.equal(intent.served_at - intent.arrived_at, bound - 1, 'exercise the actual worst-case schedule');
    assert.ok(intent.served_at - intent.arrived_at <= bound);
    const [active, next] = s.design.state.runs;
    assert.equal(next.started_at - Math.max(intent.arrived_at, active.ended_at), 30_000);
    assert.ok(next.started_at >= active.ended_at, 'run + retry never overlap the next run');
    assert.equal(s.renderer.activeCount, 0);
    assert.equal(s.renderer.calls.length, 2 + Number(activeRetry) + Number(nextRetry));
    assert.equal(s.errors.length, 0);
  });
}

it('intents during the wait window coalesce into the newest revision without resetting the oldest deadline', async () => {
  const s = scheduler({ plan: () => ({ duration_ms: 10_000, fail: false }) });
  s.intent('one', 1);
  await s.clock.advance(20_000); s.intent('two', 2);
  await s.clock.advance(9999); s.intent('three', 3);
  await s.clock.advance(1);
  assert.equal(s.renderer.calls.length, 1);
  assert.equal(s.renderer.calls[0].revision.working_rev, 3);
  assert.equal(s.renderer.calls[0].started_at, 30_000);
  await s.clock.advance(10_000);
  for (const intent of s.design.state.intents) {
    assert.equal(intent.state, 'rendered');
    assert.equal(intent.rendered_rev, 3);
    assert.ok(intent.started_at - s.design.state.intents[0].arrived_at <= 30_000);
  }
  assert.deepEqual(s.design.state.runs[0].intent_ids, ['one', 'two', 'three']);
});

it('continuous revisions coalesce and cannot starve older intents or cancel a captured revision', async () => {
  const s = scheduler({ plan: ({ attempt }) => ({ duration_ms: 60_000, fail: attempt === 1 }) });
  s.intent('rev-1', 1);
  for (let revision = 2; revision <= 101; revision++) {
    await s.clock.advance(3000);
    s.intent(`rev-${revision}`, revision);
    assert.ok(s.renderer.activeCount <= 1);
  }
  await s.clock.advance(270_000);
  const state = s.design.state;
  assert.ok(state.runs.length < 10, 'coalescing avoids a render for each revision');
  assert.equal(state.intents.length, 101);
  for (const intent of state.intents) {
    assert.equal(intent.state, 'rendered');
    assert.ok(intent.rendered_rev >= intent.working_rev);
    assert.ok(intent.served_at - intent.arrived_at <= 270_000);
  }
  for (let i = 0; i < state.runs.length; i++) {
    const run = state.runs[i];
    assert.equal(run.attempts, 2);
    const calls = s.renderer.calls.slice(i * 2, i * 2 + 2);
    assert.deepEqual(calls.map((c) => c.revision.working_rev), [run.working_rev, run.working_rev]);
    assert.equal(calls[1].started_at, calls[0].started_at + 60_000, 'retry starts immediately');
    if (i) assert.ok(run.started_at >= state.runs[i - 1].ended_at);
    const oldest = Math.min(...state.intents.filter((intent) => run.intent_ids.includes(intent.intent_id)).map((intent) => intent.arrived_at));
    assert.ok(run.started_at <= Math.max(oldest, i ? state.runs[i - 1].ended_at : -Infinity) + 30_000);
  }
});

it('double failure terminates after two attempts, marks every served intent, and schedules newer work', async () => {
  const s = scheduler({ plan: ({ revision }) => ({ duration_ms: 60_000, fail: revision.working_rev < 3 }) });
  s.intent('one', 1); s.intent('two', 2);
  await s.clock.advance(30_001); s.intent('newer', 3);
  await s.clock.advance(119_999);
  assert.deepEqual(s.design.state.intents.slice(0, 2).map((i) => i.state), ['render_failed', 'render_failed']);
  assert.equal(s.design.state.runs[0].attempts, 2);
  await s.clock.advance(90_000);
  const newest = s.design.state.intents[2];
  assert.equal(newest.state, 'rendered');
  assert.ok(newest.served_at - newest.arrived_at <= 210_000);
  assert.equal(s.renderer.calls.length, 3);
  assert.equal(s.design.state.busy, false);
  await s.clock.advance(300_000);
  assert.equal(s.renderer.calls.length, 3, 'double failure is terminal, never an endless retry loop');
});

it('sustained audio deferral uses <=20s inside the start window and cannot reset it', async () => {
  const s = scheduler({ waitMs: 0, plan: () => ({ duration_ms: 60_000, fail: false }) });
  s.design.setAudioBusy(true); s.intent('one', 1);
  for (let n = 0; n < 19; n++) { await s.clock.advance(1000); s.design.setAudioBusy(true); }
  assert.equal(s.renderer.calls.length, 0);
  await s.clock.advance(1000);
  assert.equal(s.renderer.calls[0].started_at, 20_000);
  await s.clock.advance(1); s.intent('two', 2);
  for (let n = 0; n < 99; n++) { await s.clock.advance(1000); s.design.setAudioBusy(true); }
  await s.clock.advance(60_000);
  const second = s.design.state.intents[1];
  assert.equal(second.state, 'rendered');
  assert.equal(second.started_at - s.design.state.runs[0].ended_at, 20_000);
  assert.ok(second.served_at - second.arrived_at <= 150_000);
});

it('audio deferral never adds twenty seconds outside a full thirty-second wait', async () => {
  const s = scheduler(); s.design.setAudioBusy(true); s.intent('one', 1);
  await s.clock.advance(30_000);
  assert.equal(s.design.state.runs[0].started_at, 30_000);
});

it('stop prevents new runs but never cancels an active run or its immediate retry', async () => {
  const s = scheduler({ waitMs: 0, plan: ({ attempt }) => ({ duration_ms: 5000, fail: attempt === 1 }) });
  s.intent('one', 1); await s.clock.advance(0);
  s.design.stop();
  assert.throws(() => s.intent('two', 2), EngineError);
  await s.clock.advance(10_000);
  assert.equal(s.renderer.calls.length, 2);
  assert.equal(s.design.state.intents[0].state, 'rendered');
  assert.equal(s.design.state.runs[0].attempts, 2);
});

it('renderer plans longer than sixty seconds fail explicitly; no hidden continuing work overlaps', async () => {
  const s = scheduler({ waitMs: 0, plan: () => ({ duration_ms: 60_001, fail: false }) });
  s.intent('one', 1); await s.clock.advance(0);
  assert.equal(s.design.state.intents[0].state, 'render_failed');
  assert.equal(s.renderer.activeCount, 0);
  assert.equal(s.renderer.calls.length, 0);
  assert.equal(s.design.state.runs[0].attempts, 2);
  assert.throws(() => new DesignScheduler({ renderer: {}, getRevision() {} }), EngineError);
});

it('engine design attempts each claim before the controlled renderer, including its immediate retry', async (t) => {
  const clock = new FakeClock();
  let f;
  const renderer = new ControlledRenderer({ clock, plan: ({ attempt }) => {
    assert.equal(f.ledger.listOpen({}, f.auth).body.holds[0].claimed, true);
    return { duration_ms: 1000, fail: attempt === 1 };
  } });
  f = fixture(t, { clock, renderer, designWaitMs: 0 });
  f.journal.append(bytes(snapshot()), f.auth);
  await f.engine.start(); f.engine.design.intent({ intent_id: 'one', working_rev: 1 });
  await clock.advance(2000);
  assert.equal(f.engine.design.state.intents[0].state, 'rendered');
  assert.equal(f.records('budget.hold').length, 2);
  assert.equal(f.records('budget.claim').length, 2);
  assert.deepEqual(f.records('budget.settle').map((r) => r.document.data.outcome), ['unknown', 'settled']);
});

it('budget denial terminates design scheduling cleanly before any renderer attempt', async (t) => {
  const clock = new FakeClock(); const renderer = new ControlledRenderer({ clock });
  const f = fixture(t, { cap: 0, clock, renderer, designWaitMs: 0 });
  f.journal.append(bytes(snapshot()), f.auth); await f.engine.start();
  f.engine.design.intent({ intent_id: 'one', working_rev: 1 }); await clock.advance(0);
  assert.equal(renderer.calls.length, 0);
  assert.equal(f.engine.design.state.intents[0].state, 'blocked');
  assert.equal(f.engine.design.state.runs[0].attempts, 1);
});

it('a stalled admission/settlement wrapper fails each attempt by sixty seconds and cannot render late', async () => {
  const clock = new FakeClock(); const renderer = new ControlledRenderer({ clock });
  const late = [];
  const design = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: 1 }), waitMs: 0,
    execute: (request) => new Promise((resolve, reject) => late.push(() => renderer.render(request).then(resolve, reject))) });
  design.intent({ intent_id: 'one', working_rev: 1 });
  await clock.advance(120_000);
  assert.equal(design.state.intents[0].state, 'render_failed');
  assert.equal(design.state.intents[0].served_at, 120_000);
  assert.equal(design.state.runs[0].attempts, 2);
  for (const open of late) assert.throws(open, EngineError);
  assert.equal(renderer.calls.length, 0);
  assert.equal(renderer.activeCount, 0);
});
