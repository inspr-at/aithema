import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TextEngine, ControlledRenderer, DesignScheduler, EngineError, applySpecPatch } from '../runtime/engine/index.js';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import { fixture, FakeClock, defaultOutput, authorizationFor, bytes, snapshot } from './engine-helpers.test.js';

const question = { question_id: 'format', text: 'Which format?', state: 'open' };

for (const echoState of ['asked', 'open']) {
for (const withMarker of [false, true]) {
  it(`lane B can echo a stored asked question after react (echo=${echoState}, marker included=${withMarker})`, async (t) => {
    const f = fixture(t, { handler: (lane, payload, request) => {
      if (lane === 'reaction') return defaultOutput(lane, payload);
      assert.match(request.system, /Question states: open, answered, dropped; asked may only echo/);
      const questions = structuredClone(payload.spec.questions);
      for (const row of questions) row.state = echoState;
      if (!withMarker) for (const row of questions) delete row.asked_in_reaction_seq;
      return { base_rev: payload.base_rev, items: [], questions };
    } });
    f.journal.append(bytes(snapshot({ spec: { items: [], questions: [question], brief: null, screens: [] } })), f.auth);
    const seq = f.personTurn(); await f.engine.start(); await f.engine.react(seq);
    const prior = f.engine.state.spec.questions[0];
    assert.equal((await f.engine.passSpec()).status, 'committed');
    assert.deepEqual(f.engine.state.spec.questions[0], prior);
    assert.equal(f.engine.state.spec.questions[0].state, 'asked');
    assert.ok(f.engine.state.consumed_seq >= seq);
    await f.engine.react(f.personTurn());
    assert.equal(f.calls.at(-1).payload.questions.some((q) => q.state === 'open'), false);
    assert.equal(f.records('reaction').filter((r) => r.document.data.text.includes(question.text)).length, 1);
  });
}
}

for (const changed of [
  { ...question, state: 'asked' },
  { ...question, text: 'Changed question?', state: 'asked' },
  { ...question, question_id: 'invented', state: 'asked' },
  { ...question, state: 'asked', asked_in_reaction_seq: 999 },
]) {
  it(`models cannot invent asked state or alter its engine-owned text/marker: ${canonicalJson(changed)}`, () => {
    const prior = { ...question, state: 'asked', asked_in_reaction_seq: 2 };
    // The first case attempts asked on a stored open question.
    const stored = canonicalJson(changed) === canonicalJson({ ...question, state: 'asked' }) ? question : prior;
    const state = snapshot({ spec: { items: [], questions: [stored], brief: null, screens: [] } });
    assert.throws(() => applySpecPatch(state, { claims: {} }, { base_rev: 1, items: [], questions: [changed] }, { records: [] }),
      (error) => error instanceof EngineError && error.reason === 'invalid_output');
  });
}

it('a failed silence-timer delivery re-arms and succeeds after another three seconds without activity', async (t) => {
  let fail = false;
  const f = fixture(t, { checkpoint: (point) => {
    if (fail && point === 'reaction.after_prepare') { fail = false; throw new Error('Transient local failure'); }
  } });
  const seq = f.personTurn(); await f.engine.start(); const delivered = await f.engine.react(seq);
  await f.engine.addCorrection({ correction_id: 'retry', claim_ref: 'claim', about_reaction_seq: delivered.reaction_seq, text: 'Correction survives retry.' });
  fail = true;
  await f.clock.advance(3000);
  assert.equal(f.errors.length, 1);
  assert.equal(f.engine.state.corrections[0].state, 'pending');
  await f.clock.advance(2999);
  assert.equal(f.engine.state.corrections[0].state, 'pending');
  await f.clock.advance(1);
  assert.equal(f.engine.state.corrections[0].state, 'delivered');
  assert.equal(f.records('reaction').filter((row) => row.document.data.text === 'Correction survives retry.').length, 1);
  assert.equal(f.calls.length, 1);
});

it('persistent silence-timer failures are retried with a bounded delay rather than a zero-time loop', async (t) => {
  let fail = false;
  const f = fixture(t, { checkpoint: (point) => { if (fail && point === 'snapshot.before_append') throw new Error('Still unavailable'); } });
  const seq = f.personTurn(); await f.engine.start(); const delivered = await f.engine.react(seq);
  await f.engine.addCorrection({ correction_id: 'retry', claim_ref: 'claim', about_reaction_seq: delivered.reaction_seq, text: 'Retained correction.' });
  fail = true;
  await f.clock.advance(9000);
  assert.equal(f.engine.state.corrections[0].state, 'pending');
  assert.equal(f.errors.length, 3);
  assert.equal(f.records('reaction').length, 1);
});

for (const asyncObserver of [false, true]) {
  it(`silence retry is armed before a throwing onError observer (async=${asyncObserver})`, async (t) => {
    let fail = false;
    const f = fixture(t, { checkpoint: (point) => {
      if (fail && point === 'snapshot.before_append') { fail = false; throw new Error('Transient failure'); }
    }, onError: () => {
      if (asyncObserver) return Promise.reject(new Error('Observer rejected'));
      throw new Error('Observer threw');
    } });
    const seq = f.personTurn(); await f.engine.start(); const delivered = await f.engine.react(seq);
    await f.engine.addCorrection({ correction_id: 'observer', claim_ref: 'claim', about_reaction_seq: delivered.reaction_seq, text: 'Retry despite observer.' });
    fail = true;
    await f.clock.advance(3000);
    assert.equal(f.errors.length, 1);
    assert.equal(f.engine.metrics.error_observer_failures, 1);
    assert.equal(f.engine.state.corrections[0].state, 'pending');
    await f.clock.advance(2999);
    assert.equal(f.engine.state.corrections[0].state, 'pending');
    await f.clock.advance(1);
    assert.equal(f.engine.state.corrections[0].state, 'delivered');
    assert.equal(f.records('reaction').filter((r) => r.document.data.text === 'Retry despite observer.').length, 1);
    assert.equal(f.calls.length, 1);
  });
}

it('a correction id with different segment text never marks the stored correction delivered', async (t) => {
  const f = fixture(t); const seq = f.personTurn(); await f.engine.start(); const delivered = await f.engine.react(seq);
  await f.engine.addCorrection({ correction_id: 'c', claim_ref: 'claim', about_reaction_seq: delivered.reaction_seq, text: 'Exact correction.' });
  const { seq: storedSeq, ...state } = f.engine.state;
  const metadata = JSON.parse(state.patch.canonical).engine_state;
  metadata.outbox = { client_event_id: randomUUID(), recorded_at: new Date(f.clock.wallNow()).toISOString(), turn_seq: 0,
    text: 'Different correction.', segments: [{ kind: 'correction', correction_id: 'c', start: 0, end: 'Different correction.'.length }], tools: [] };
  const canonical = canonicalJson({ operation: { fixture: 'mismatched correction' }, engine_state: metadata });
  f.journal.append(bytes({ ...state, client_event_id: randomUUID(), working_rev: state.working_rev + 1, expected_prev_rev: state.working_rev,
    patch: { canonical, sha256: sha256Hex(canonical) } }), f.auth);
  f.engine.close();
  const resumed = fixture(t, { path: f.path, initialize: false, clock: f.clock });
  await resumed.engine.resume({ authorizationFor, replay: false });
  assert.equal(resumed.engine.state.corrections[0].state, 'pending');
  await f.clock.advance(3000);
  assert.equal(resumed.engine.state.corrections[0].state, 'delivered');
  assert.equal(resumed.records('reaction').filter((row) => row.document.data.text === 'Exact correction.').length, 1);
});

for (const lane of ['reaction', 'spec', 'design']) {
  it(`zero maxMicro is explicitly invalid_configuration for ${lane}`, (t) => {
    const f = fixture(t);
    assert.throws(() => new TextEngine({ journal: f.client, journalPort: f.port, budget: f.budget, authorization: f.authz,
      reasoning: { streamChat() { throw new Error('No provider allowed'); }, understand() {} },
      maxMicro: { reaction: 100, spec: 100, design: 100, [lane]: 0 }, priceUsage: () => 0, clock: f.clock }),
    (error) => error instanceof EngineError && error.reason === 'invalid_configuration');
    assert.equal(f.records('budget.hold').length, 0);
  });

  it(`zero settings provider_max refuses ${lane} before admission or dispatch`, async (t) => {
    const f = fixture(t);
    const settings = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/settings.executable.json', import.meta.url))).doc;
    settings.defaults.preset = 'eu-e1';
    settings.policy.spend.provider_max[lane] = 0;
    let providerCalls = 0;
    const renderer = new ControlledRenderer({ clock: f.clock, plan: () => { providerCalls++; return { duration_ms: 0, fail: false }; } });
    const errors = [];
    const engine = new TextEngine({ journal: f.client, journalPort: f.port, budget: f.budget, authorization: f.authz,
      reasoning: { streamChat() { providerCalls++; throw new Error('No provider allowed'); }, understand() {} },
      maxMicro: { reaction: 100, spec: 100, design: 100 }, priceUsage: () => 0, settings, clock: f.clock,
      renderer, designWaitMs: 0, onError: (error) => errors.push(error) });
    t.after(() => engine.close());
    const seq = f.personTurn(); await engine.start();
    if (lane === 'design') {
      // A revision is needed for a design intent, but not any inference.
      f.journal.append(bytes(snapshot()), f.auth); await engine.transcript();
      engine.design.intent({ intent_id: 'zero', working_rev: 1 }); await f.clock.advance(0);
      assert.ok(errors.some((error) => error.reason === 'invalid_configuration')
        || engine.design.state.runs[0]?.error === 'invalid_configuration');
    } else await assert.rejects(lane === 'reaction' ? engine.react(seq) : engine.passSpec(),
      (error) => error instanceof EngineError && error.reason === 'invalid_configuration');
    assert.equal(providerCalls, 0);
    assert.equal(f.records('budget.hold').length, 0);
    assert.equal(f.records('budget.claim').length, 0);
  });
}

for (const fail of [false, true]) {
  for (const entry of ['start', 'resume']) {
    it(`terminal design intents survive ${entry} and are never re-admitted (double failure=${fail})`, async (t) => {
      const clock = new FakeClock();
      const renderer = new ControlledRenderer({ clock, plan: () => ({ duration_ms: 1000, fail }) });
      const handler = (lane, payload) => lane === 'reaction'
        ? { say: 'Design requested.', question_id: null, tools: [{ name: 'design_intent' }] } : defaultOutput(lane, payload);
      const f = fixture(t, { clock, renderer, handler, designWaitMs: 30_000 });
      const seq = f.personTurn(); await f.engine.start();
      const first = await f.engine.react(seq);
      const second = await f.engine.react(f.personTurn());
      await clock.advance(32_000);
      const states = f.engine.design.state.intents.map((intent) => intent.state);
      assert.deepEqual(states, [fail ? 'render_failed' : 'rendered', fail ? 'render_failed' : 'rendered']);
      const persisted = JSON.parse(f.engine.state.patch.canonical).engine_state.design_results;
      assert.deepEqual(persisted.map((result) => result.intent_id), [`reaction:${first.reaction_seq}`, `reaction:${second.reaction_seq}`]);
      assert.deepEqual(persisted.map((result) => result.state), states);
      assert.equal(validate(f.engine.state.contract, f.engine.state).ok, true);
      const holds = f.records('budget.hold').length;
      f.engine.close();
      const resumedRenderer = new ControlledRenderer({ clock });
      const resumed = fixture(t, { path: f.path, initialize: false, clock, renderer: resumedRenderer, handler, designWaitMs: 0 });
      if (entry === 'resume') await resumed.engine.resume({ authorizationFor, replay: false }); else await resumed.engine.start();
      assert.deepEqual(resumed.engine.design.state.intents.map((intent) => intent.state), states);
      await clock.advance(300_000);
      assert.equal(resumedRenderer.calls.length, 0);
      assert.equal(resumed.records('budget.hold').length, holds);
      await resumed.engine.react(resumed.personTurn());
      await clock.advance(0);
      assert.equal(resumedRenderer.calls.length, 1, 'only the new receipt schedules a run');
      assert.equal(resumed.engine.design.state.intents.at(-1).state, 'rendered');
    });
  }
}

it('scheduler restoration rejects malformed completions and immutable-id conflicts with normalized errors', () => {
  const clock = new FakeClock(); const renderer = new ControlledRenderer({ clock });
  const scheduler = new DesignScheduler({ clock, renderer, getRevision: () => ({ working_rev: 1 }) });
  const result = { intent_id: 'completed', state: 'render_failed', working_rev: 1, rendered_rev: 1, attempts: 2 };
  scheduler.restore([result]);
  assert.equal(scheduler.intent({ intent_id: 'completed', working_rev: 1 }).state, 'render_failed');
  assert.throws(() => scheduler.restore([{ ...result, state: 'rendered' }]), (error) => error.code === 'idempotency_conflict');
  assert.throws(() => scheduler.restore([result, result]), EngineError);
  assert.throws(() => scheduler.restore(null), EngineError);
  assert.throws(() => scheduler.restore([{ ...result, state: 'queued' }]), EngineError);
});
