import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledRenderer, DesignScheduler } from '../runtime/engine/index.js';
import { validate } from '../contracts/validate.js';
import { FakeClock, fixture, defaultOutput } from './engine-helpers.test.js';

const results = (f) => JSON.parse(f.engine.state.patch.canonical).engine_state.design_results;
const requestDesign = (lane, payload) => lane === 'reaction'
  ? { say: 'Design requested.', question_id: null, tools: [{ name: 'design_intent' }] } : defaultOutput(lane, payload);

for (const recover of ['timer', 'recoverJournal']) {
  it(`design.before_finalize throw retains completion and ${recover} persists it without a second render or stopping a reaction`, async (t) => {
    let fail = true, designRequested = true;
    const clock = new FakeClock(), renderer = new ControlledRenderer({ clock });
    const f = fixture(t, { clock, renderer, designWaitMs: 0,
      handler: (lane, payload) => designRequested ? requestDesign(lane, payload) : defaultOutput(lane, payload),
      checkpoint: (point) => { if (fail && point === 'design.before_finalize') throw new Error('Local completion failed'); } });
    const seq = f.personTurn(); await f.engine.start(); const first = await f.engine.react(seq);
    await clock.advance(0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.engine.design.state.stopped, false);
    assert.equal(f.engine.design.state.busy, false);
    assert.equal(f.engine.design.state.pending_completions.length, 1);
    assert.equal(results(f).length, 0);
    assert.equal(f.engine.design.intent({ intent_id: `reaction:${first.reaction_seq}`, working_rev: first.working_rev }).state, 'rendered');
    designRequested = false;
    assert.equal((await f.engine.react(f.personTurn())).status, 'delivered', 'a completion error cannot poison a later reaction without design tools');
    assert.equal(renderer.calls.length, 1);
    fail = false;
    if (recover === 'timer') { await clock.advance(2999); assert.equal(results(f).length, 0); await clock.advance(1); }
    else await f.engine.recoverJournal();
    assert.equal(results(f).length, 1);
    assert.equal(f.engine.design.state.pending_completions.length, 0);
    assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
    assert.equal(f.records('budget.hold').filter((r) => r.document.data.lane === 'design').length, 1);
    designRequested = true;
    await f.engine.react(f.personTurn()); await clock.advance(0);
    assert.equal(renderer.calls.length, 2);
    assert.equal(results(f).length, 2);
    assert.equal(f.engine.design.state.stopped, false);
  });
}

for (const ackLost of [false, true]) {
  it(`a 500 on the design snapshot is recovered byte-exact and subsequent reactions schedule normally (stored=${ackLost})`, async (t) => {
    let f, fail = true;
    const failedBytes = [], clock = new FakeClock(), renderer = new ControlledRenderer({ clock });
    f = fixture(t, { clock, renderer, designWaitMs: 0, handler: requestDesign,
      journalOverrides: { append: (original, auth) => {
        const doc = JSON.parse(original);
        const completion = doc.contract === 'aithema.spec.snapshot' && JSON.parse(doc.patch.canonical).operation?.lane === 'design';
        if (completion && fail) {
          failedBytes.push(Buffer.from(original));
          if (ackLost) f.journal.append(original, auth);
          throw Object.assign(new Error('Completion host unavailable'), { status: 500 });
        }
        if (completion && failedBytes.length && failedBytes.length === 1) {
          assert.deepEqual(Buffer.from(original), failedBytes[0], 'journal flush retries the exact retained snapshot');
          failedBytes.push(Buffer.from(original));
        }
        return f.journal.append(original, auth);
      } } });
    await f.engine.start(); const first = await f.engine.react(f.personTurn()); await clock.advance(0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.engine.design.state.pending_completions.length, 1);
    assert.equal(f.engine.design.state.stopped, false);
    assert.throws(() => f.engine.react(f.personTurn()), (e) => e.reason === 'ack_uncertain');
    fail = false;
    await f.engine.recoverJournal();
    assert.equal(results(f).length, 1);
    assert.equal(results(f)[0].intent_id, `reaction:${first.reaction_seq}`);
    assert.equal(f.engine.design.state.pending_completions.length, 0);
    assert.equal(f.engine.design.state.stopped, false);
    assert.equal(renderer.calls.length, 1);
    const second = await f.engine.react(f.personTurn()); await clock.advance(0);
    assert.equal(second.status, 'delivered');
    assert.equal(results(f).length, 2);
    assert.equal(renderer.calls.length, 2);
    const rev = f.engine.state.working_rev;
    await f.engine.recoverJournal(); await clock.advance(9000);
    assert.equal(renderer.calls.length, 2);
    assert.equal(f.engine.state.working_rev, rev, 'recovery and retry cannot duplicate completion snapshots');
    assert.equal(f.records('budget.hold').filter((r) => r.document.data.lane === 'design').length, 2);
  });
}

it('a completion error after snapshot acknowledgement is reconciled without another render or revision', async (t) => {
  let fail = true;
  const clock = new FakeClock(), renderer = new ControlledRenderer({ clock });
  const f = fixture(t, { clock, renderer, designWaitMs: 0, handler: requestDesign,
    checkpoint: (point) => { if (fail && point === 'design.after_finalize') { fail = false; throw new Error('Post-ack failure'); } } });
  await f.engine.start(); await f.engine.react(f.personTurn()); await clock.advance(0);
  assert.equal(results(f).length, 1);
  assert.equal(f.engine.design.state.pending_completions.length, 1);
  const rev = f.engine.state.working_rev;
  await f.engine.recoverJournal(); await clock.advance(9000);
  assert.equal(f.engine.state.working_rev, rev);
  assert.equal(f.engine.design.state.pending_completions.length, 0);
  assert.equal(renderer.calls.length, 1);
});

it('completion retries are single-flight, survive observer throws and never delay newer runs', async () => {
  const clock = new FakeClock(), renderer = new ControlledRenderer({ clock });
  const waiting = Promise.withResolvers();
  let revision = 1, blocked = true, writes = 0;
  const design = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: revision }), waitMs: 0,
    onComplete: async () => { writes++; if (blocked) { await waiting.promise; throw new Error('Completion failure'); } },
    onError: () => { throw new Error('Observer failure'); } });
  design.intent({ intent_id: 'first', working_rev: 1 }); await clock.advance(0);
  assert.equal(design.state.busy, false, 'completion persistence does not extend the render run');
  const a = design.recoverCompletions(), b = design.recoverCompletions();
  const rejected = Promise.allSettled([a, b]);
  revision = 2; design.intent({ intent_id: 'second', working_rev: 2 }); await clock.advance(0);
  assert.equal(renderer.calls.length, 2, 'new render starts even while a completion write is pending');
  assert.equal(writes, 1);
  waiting.resolve(); assert.deepEqual((await rejected).map((result) => result.status), ['rejected', 'rejected']); await clock.advance(0);
  assert.equal(design.state.stopped, false);
  assert.equal(design.state.pending_completions.length, 2);
  assert.ok(design.state.error_observer_failures >= 1);
  blocked = false;
  await clock.advance(3000);
  assert.equal(writes, 2);
  assert.equal(design.state.pending_completions.length, 0);
  assert.equal(renderer.calls.length, 2);
  assert.equal(design.state.intents.every((row) => row.state === 'rendered'), true);
  design.stop();
});

it('intent returns an already-known immutable id after stop while rejecting a new id', () => {
  const clock = new FakeClock(), renderer = new ControlledRenderer({ clock });
  const design = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: 1 }) });
  const prior = design.intent({ intent_id: 'known', working_rev: 1 }); design.stop();
  assert.deepEqual(design.intent({ intent_id: 'known', working_rev: 1 }), prior);
  assert.throws(() => design.intent({ intent_id: 'new', working_rev: 1 }), (e) => e.reason === 'scheduler_stopped');
  assert.throws(() => design.intent({ intent_id: 'known', working_rev: 2 }), (e) => e.code === 'idempotency_conflict');
});
