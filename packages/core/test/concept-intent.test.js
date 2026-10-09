import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConceptIntent, reduceConceptIntent as reduce, planConceptIntent as plan, progressTrigger, conceptResultDisposition } from '../src/concept-intent.js';
const event = (type, value = {}, now = 0) => ({ type, now, ...value });
function ready({ percent = 25, now = 0, turnIds = ['t1'], referenceIds = [] } = {}) {
  let s = createConceptIntent({ now, consented: true, consentRevision: 1 });
  s = reduce(s, event('input-recorded', { revision: 'r1', turnIds, referenceIds }, now));
  s = reduce(s, event('intent-recorded', { id: 'intent1', sourceTurnId: 't1' }, now));
  return reduce(s, event('readiness', { percent }, now));
}
function render(s, now = 0) {
  s = reduce(s, event('request', { id: 'job1', trigger: 'progress' }, now));
  return reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }, now));
}
function input(s, { revision = 'r2', turnIds = ['t1', 't2'], referenceIds = s.referenceIds, now = 1 } = {}) {
  return reduce(s, event('input-recorded', { revision, turnIds, referenceIds }, now));
}
// START oracle: generated-ui.test.ts idle plateau, cadence, passive intent and
// slow render/invalidation cases. Final-on-pause is tightened to engine-wide
// pause; manual same-revision refresh requires a new revision in this contract.
test('25/40/72 percent only arm; milestones, viewing and conversation end never record intent', () => {
  for (const [percent, trigger] of [[24, null], [25, 'early'], [39, 'early'], [40, 'midpoint'], [71, 'midpoint'], [72, 'late']]) {
    assert.equal(progressTrigger(percent), trigger);
    let s = createConceptIntent({ consented: true });
    s = input(s, { revision: 'r1', turnIds: ['t1'] }); s = reduce(s, event('readiness', { percent }));
    for (const type of ['viewer-open', 'conversation-ended']) s = reduce(s, event(type));
    assert.equal(s.visualIntent, null);
    for (const trigger of ['progress', 'idle', 'manual']) assert.deepEqual(plan(s, { trigger, now: 200000 }), { kind: 'skip', reason: 'not-requested' });
    assert.equal(s.pending, null);
  }
  for (const invalid of [undefined, null, NaN, Infinity, '72']) assert.equal(progressTrigger(invalid), null);
});
test('recorded intent must refer to a stored substantive visitor turn and covered consent', () => {
  let s = createConceptIntent();
  s = input(s, { revision: 'r1', turnIds: ['t1'] });
  assert.equal(reduce(s, event('intent-recorded', { id: 'i', sourceTurnId: 't1' })), s);
  s = reduce(s, event('consent', { covered: true, revision: 1 }));
  assert.equal(reduce(s, event('intent-recorded', { id: 'i', sourceTurnId: 'assistant' })), s);
  s = reduce(s, event('intent-recorded', { id: 'i', sourceTurnId: 't1' }));
  assert.equal(plan(s, { trigger: 'manual', now: 1 }).kind, 'generate');
  assert.deepEqual(plan(s, { trigger: 'progress', now: 1 }), { kind: 'skip', reason: 'before-threshold' });
});
test('pause blocks every fresh request, including manual, without rejecting an admitted render', () => {
  let s = ready(); const job = plan(s, { trigger: 'progress', now: 0 }).plan;
  s = reduce(s, event('pause', { paused: true }, 500));
  for (const trigger of ['progress', 'idle', 'manual']) assert.deepEqual(plan(s, { trigger, now: 200000 }), { kind: 'skip', reason: 'paused' });
  assert.deepEqual(conceptResultDisposition(s, job), { kind: 'current' });
  s = reduce(s, event('pause', { paused: false }, 200000));
  assert.deepEqual(plan(s, { trigger: 'idle', now: 200001 }), { kind: 'skip', reason: 'not-idle' });
});
test('idle fallback waits 120 seconds from substantive input or the last completed render', () => {
  let s = ready(); assert.deepEqual(plan(s, { trigger: 'idle', now: 119999 }), { kind: 'skip', reason: 'not-idle' });
  assert.equal(plan(s, { trigger: 'idle', now: 120000 }).kind, 'generate');
  s = render(s, 120000); s = input(s, { now: 300000 });
  assert.deepEqual(plan(s, { trigger: 'idle', now: 419999 }), { kind: 'skip', reason: 'not-idle' });
  assert.equal(plan(s, { trigger: 'idle', now: 420000 }).kind, 'generate');
  s = { ...s, history: [{ ...s.history[0], createdAt: 400000 }] };
  assert.deepEqual(plan(s, { trigger: 'idle', now: 420000 }), { kind: 'skip', reason: 'not-idle' });
  assert.equal(plan(s, { trigger: 'idle', now: 520000 }).kind, 'generate');
});
test('time, assistant activity and changed assessment alone cannot refresh a revision', () => {
  let s = render(ready()); s = reduce(s, event('activity', {}, 1));
  s = reduce(s, event('readiness', { percent: 72 }, 2));
  assert.deepEqual(plan(s, { trigger: 'idle', now: 999999 }), { kind: 'skip', reason: 'duplicate' });
  assert.deepEqual(plan(s, { trigger: 'progress', now: 999999 }), { kind: 'skip', reason: 'duplicate' });
  s = input(s, { revision: 'assessment-only', turnIds: ['t1'] });
  assert.equal(plan(s, { trigger: 'idle', now: 999999 }).reason, 'milestone-complete');
  assert.equal(plan(s, { trigger: 'progress', now: 999999 }).reason, 'milestone-complete');
});
test('progress cadence requires two new answers in a milestone; idle may refresh after one', () => {
  let s = input(render(ready()));
  assert.deepEqual(plan(s, { trigger: 'progress', now: 200000 }), { kind: 'skip', reason: 'milestone-complete' });
  assert.equal(plan(s, { trigger: 'idle', now: 200000 }).kind, 'generate');
  s = input(s, { revision: 'r3', turnIds: ['t1', 't2', 't3'] });
  assert.equal(plan(s, { trigger: 'progress', now: 200000 }).kind, 'generate');
});
test('a new reference or recorded visual feedback earns a progress refresh before two answers', () => {
  let s = render(ready()); s = input(s, { turnIds: ['t1'], referenceIds: ['ref1'] });
  assert.equal(plan(s, { trigger: 'progress', now: 1 }).kind, 'generate');
  s = input(render(ready())); s = reduce(s, event('intent-recorded', { id: 'intent2', sourceTurnId: 't2' }, 1));
  assert.equal(plan(s, { trigger: 'progress', now: 1 }).kind, 'generate');
});
test('a new earned milestone permits a refresh with a new substantive answer', () => {
  let s = input(render(ready())); s = reduce(s, event('readiness', { percent: 72 }));
  assert.equal(plan(s, { trigger: 'progress', now: 1 }).plan.trigger, 'late');
});
test('deduplicates by revision including failed attempts and freezes a single running job', () => {
  let s = ready(); s = reduce(s, event('request', { id: 'job1', trigger: 'progress' }));
  const frozen = structuredClone(s.pending); s = input(s);
  s = reduce(s, event('intent-recorded', { id: 'intent2', sourceTurnId: 't2' }, 1));
  assert.deepEqual(s.pending, frozen);
  assert.equal(reduce(s, event('request', { id: 'job2', trigger: 'manual' }, 2)), s);
  s = reduce(s, event('render-failed', { id: 'job1' }, 3));
  assert.equal(s.pending, null); assert.equal(plan(s, { trigger: 'manual', now: 4 }).kind, 'generate');
  let failed = ready(); failed = reduce(failed, event('request', { id: 'job1', trigger: 'idle' }, 120000));
  failed = reduce(failed, event('render-failed', { id: 'job1' }, 120001));
  assert.equal(plan(failed, { trigger: 'idle', now: 999999 }).reason, 'duplicate');
  assert.equal(plan(failed, { trigger: 'manual', now: 999999 }).reason, 'duplicate');
});
test('normal revision advance preserves a slow render as honest history', () => {
  let s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
  s = input(s); assert.deepEqual(conceptResultDisposition(s, s.pending), { kind: 'history' });
  s = reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }, 200000));
  assert.equal(s.history.length, 1); assert.equal(s.history[0].inputRevision, 'r1');
  assert.deepEqual(s.history[0].turnIds, ['t1']); assert.equal(s.inputRevision, 'r2');
});
test('failed attempts still require new substantive input before an automatic refresh', () => {
  let s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
  s = reduce(s, event('render-failed', { id: 'job1' }, 1));
  s = input(s, { revision: 'assessment-only', turnIds: ['t1'] });
  s = reduce(s, event('readiness', { percent: 72 }));
  assert.equal(plan(s, { trigger: 'progress', now: 999999 }).reason, 'milestone-complete');
  assert.equal(plan(s, { trigger: 'idle', now: 999999 }).reason, 'milestone-complete');
  s = input(s, { revision: 'r3', turnIds: ['t1', 't2'] });
  assert.equal(plan(s, { trigger: 'idle', now: 999999 }).kind, 'generate');
});
test('explicit retry earns a distinct recorded revision but cannot reuse a failed revision', () => {
  let s = reduce(ready(), event('request', { id: 'job1', trigger: 'manual' }));
  s = reduce(s, event('render-failed', { id: 'job1' }, 1));
  assert.equal(plan(s, { trigger: 'manual', now: 2 }).reason, 'duplicate');
  s = input(s, { revision: 'r1-retry-intent2', turnIds: ['t1'] });
  s = reduce(s, event('intent-recorded', { id: 'intent2', sourceTurnId: 't1' }, 2));
  assert.equal(plan(s, { trigger: 'manual', now: 2 }).kind, 'generate');
});
test('source removal and consent withdrawal reject late results even after consent is restored', () => {
  for (const revoke of ['source-removed', 'consent']) {
    let s = reduce(ready({ referenceIds: ['ref1'] }), event('request', { id: 'job1', trigger: 'progress' }));
    s = reduce(s, event(revoke, revoke === 'consent' ? { covered: false, revision: 2 } : { id: 'ref1' }, 1));
    if (revoke === 'consent') s = reduce(s, event('consent', { covered: true, revision: 3 }, 2));
    assert.deepEqual(conceptResultDisposition(s, s.pending), { kind: 'reject', reason: 'state-changed' });
    s = reduce(s, event('render-completed', { id: 'job1', artifactId: 'discarded' }, 3));
    assert.deepEqual(s.history, []); assert.equal(s.visualIntent, null);
  }
});
test('implicit removal in recorded input also invalidates; removing and readding a source cannot resurrect a render', () => {
  let s = reduce(ready({ turnIds: ['t1', 't2'] }), event('request', { id: 'job1', trigger: 'progress' }));
  s = input(s, { turnIds: ['t1'] }); s = input(s, { revision: 'r3', turnIds: ['t1', 't2'] });
  assert.equal(conceptResultDisposition(s, s.pending).reason, 'state-changed');
  assert.equal(s.visualIntent, null);
});
test('source removal drops dependent history; consent withdrawal clears all history references', () => {
  const s = render(ready({ referenceIds: ['ref1'] }));
  assert.deepEqual(reduce(s, event('source-removed', { id: 'ref1' }, 1)).history, []);
  assert.deepEqual(reduce(s, event('consent', { covered: false, revision: 2 }, 1)).history, []);
});
test('hidden or busy idle time cannot earn an immediate return attempt', () => {
  let s = ready(); s = reduce(s, event('eligibility', { eligible: false }, 100));
  assert.equal(plan(s, { trigger: 'idle', now: 500000 }).reason, 'ineligible');
  s = reduce(s, event('eligibility', { eligible: true }, 500000));
  assert.equal(plan(s, { trigger: 'idle', now: 500001 }).reason, 'not-idle');
  assert.equal(plan(s, { trigger: 'idle', now: 620000 }).kind, 'generate');
});
test('host config changes thresholds/cadence/storage bounds and invalid policy fails closed', () => {
  const policy = { thresholds: [10, 30, 60], idleMs: 10, refreshTurns: 1, historyMax: 1 };
  assert.equal(progressTrigger(30, policy), 'midpoint');
  assert.equal(plan(ready(), { trigger: 'idle', now: 10 }, policy).kind, 'generate');
  assert.equal(plan(input(render(ready())), { trigger: 'progress', now: 2 }, policy).reason, 'limit');
  assert.throws(() => progressTrigger(50, { thresholds: [25, 20, 72] }), /policy/u);
  assert.throws(() => plan(ready(), { trigger: 'progress', now: NaN }), /time/u);
});
test('duplicate completion and unrelated failure ids cannot overwrite the running job', () => {
  const s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
  assert.equal(reduce(s, event('render-failed', { id: 'other' })), s);
  assert.equal(reduce(s, event('render-completed', { id: 'other', artifactId: 'wrong' })), s);
  const completed = reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }));
  assert.equal(reduce(completed, event('render-completed', { id: 'job1', artifactId: 'image2' })), completed);
  assert.deepEqual(conceptResultDisposition(completed, s.pending), { kind: 'reject', reason: 'duplicate' });
});
test('reducer is immutable and replayable with host timestamps', () => {
  const initial = createConceptIntent(), copy = structuredClone(initial);
  const events = [event('consent', { covered: true, revision: 1 }),
    event('input-recorded', { revision: 'r1', turnIds: ['t1'], referenceIds: [] }),
    event('intent-recorded', { id: 'intent1', sourceTurnId: 't1' }), event('readiness', { percent: 25 }),
    event('request', { id: 'job1', trigger: 'progress' }), event('render-completed', { id: 'job1', artifactId: 'image1' }, 1)];
  const replay = () => events.reduce((s, e) => reduce(s, e), initial);
  assert.deepEqual(replay(), replay()); assert.deepEqual(initial, copy);
});

test('manual requests require a fresh intent after success or failure, even at a new revision', () => {
  for (const outcome of ['render-completed', 'render-failed']) {
    let s = reduce(ready(), event('request', { id: 'job1', trigger: 'manual' }));
    s = reduce(s, event(outcome, { id: 'job1', artifactId: 'image1' }, 1));
    s = input(s, { revision: 'assessment-only', turnIds: ['t1'] });
    assert.deepEqual(plan(s, { trigger: 'manual', now: 2 }), { kind: 'skip', reason: 'not-requested' });
    s = reduce(s, event('intent-recorded', { id: 'intent2', sourceTurnId: 't1' }, 2));
    assert.equal(plan(s, { trigger: 'manual', now: 2 }).kind, 'generate');
  }
});
test('missing or unknown request triggers throw before planning or recording a job', () => {
  for (const trigger of [undefined, null, '', 'surprise', 'final']) {
    assert.throws(() => plan(ready(), { trigger, now: 0 }), /trigger/u);
    assert.throws(() => reduce(ready(), event('request', { id: 'job1', trigger })), /trigger/u);
  }
});
test('removing dependencies added after dispatch preserves the paid render and existing history', () => {
  for (const source of ['turn', 'reference']) for (const removal of ['source-removed', 'input-recorded']) {
    let s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
    const job = structuredClone(s.pending);
    s = input(s, { turnIds: source === 'turn' ? ['t1', 't2'] : ['t1'], referenceIds: source === 'reference' ? ['ref2'] : [] });
    s = removal === 'source-removed' ? reduce(s, event(removal, { id: source === 'turn' ? 't2' : 'ref2' }, 2)) :
      input(s, { revision: 'r3', turnIds: ['t1'], referenceIds: [] });
    assert.deepEqual(s.pending, job);
    assert.deepEqual(conceptResultDisposition(s, job), { kind: 'history' });
    s = reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }, 3));
    assert.equal(s.history.length, 1);
    assert.equal(reduce(s, event('source-removed', { id: 'unrelated' }, 4)).history.length, 1);
  }
});
test('removing and readding a used reference permanently rejects that pending job', () => {
  let s = reduce(ready({ referenceIds: ['ref1'] }), event('request', { id: 'job1', trigger: 'progress' }));
  s = input(s, { turnIds: ['t1'], referenceIds: [] });
  s = input(s, { revision: 'r3', turnIds: ['t1'], referenceIds: ['ref1'] });
  assert.deepEqual(conceptResultDisposition(s, s.pending), { kind: 'reject', reason: 'state-changed' });
});
test('unchanged consent and a renewal with unchanged coverage preserve intent, history and pending results', () => {
  for (const revision of [1, 2]) {
    const completed = render(ready());
    const renewed = reduce(completed, event('consent', { covered: true, revision }, 1));
    assert.deepEqual(renewed.history, completed.history);
    assert.deepEqual(renewed.visualIntent, completed.visualIntent);
    let s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
    s = reduce(s, event('consent', { covered: true, revision }, 1));
    s = reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }, 2));
    assert.equal(s.history.length, 1);
  }
});
test('pausing after request still records the admitted result', () => {
  let s = reduce(ready(), event('request', { id: 'job1', trigger: 'progress' }));
  s = reduce(s, event('pause', { paused: true }, 1));
  s = reduce(s, event('render-completed', { id: 'job1', artifactId: 'image1' }, 2));
  assert.equal(s.paused, true); assert.equal(s.pending, null);
  assert.equal(s.history.length, 1); assert.equal(s.history[0].artifactId, 'image1');
});
