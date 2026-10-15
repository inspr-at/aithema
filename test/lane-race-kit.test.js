import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaneRaceHarness, lanePairs, laneNames } from './fixtures/lane-race-harness.js';
import { start2PurposePolicy } from '../demo/safeguards.js';
import { createFakeProviderKit, providerRuleViolation } from './fixtures/fake-provider-kit.js';

function balanced(h, { idle = true } = {}) {
  const counts = h.runtime.budget.outcomeCounters();
  for (const [lane, c] of Object.entries(counts)) {
    assert.equal(c.started, c.completed + c.superseded + c.deferred + c.aborted + c.uncertain + c.failed + c.inFlight, lane);
    if (idle) assert.equal(c.inFlight, 0, lane);
    const prefix = lane === 'reaction' ? 'reply' : lane;
    for (const key of ['started', 'completed', 'superseded', 'deferred', 'aborted', 'uncertain', 'failed']) {
      assert.equal(h.logs.filter(e => e.event === `${prefix}.${key}`).length, c[key], `${lane}.${key} diagnostic matches ledger`);
    }
  }
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
  for (const row of rows) {
    if (idle) {
      assert.equal(row.state, 'settled'); assert.ok(row.terminal_json);
      assert.equal(h.settlements.filter(id => id === row.attempt_id).length, 1, 'one terminal settlement per admitted attempt');
    }
    if (row.state === 'settled' && row.settled_micro === row.max_micro) assert.equal(row.outcome, 'uncertain', 'only genuinely unknown costs retain the maximum');
  }
  return counts;
}

for (const [a, b] of lanePairs) for (const order of [[a, b], [b, a]]) {
  for (const scenario of ['publish', 'supersede', 'pause/resume']) test(`AIT-201 ${a} × ${b}: ${scenario}, ${order.join(' → ')}`, { timeout: 15_000 }, async t => {
    const h = await createLaneRaceHarness(); t.after(() => h.close());
    const runs = Object.fromEntries([a, b].map(lane => [lane, h.run(lane)]));
    const pending = Object.fromEntries(await Promise.all([a, b].map(async lane => [lane, await h.next(lane)])));
    assert.notEqual(pending[a], pending[b]); balanced(h, { idle: false });
    for (const call of Object.values(pending)) assert.equal(call.violation, null);
    if (scenario === 'supersede') h.turn('A new person turn while both providers are pending.');
    if (scenario === 'pause/resume') assert.equal((await h.route('pause', { paused: true })).status, 200);
    for (const lane of order) {
      if (!pending[lane].released) h.resolve(pending[lane]);
      await Promise.allSettled([runs[lane]]);
    }
    await Promise.allSettled(Object.values(runs));
    const counts = balanced(h);
    for (const lane of [a, b]) assert.equal(counts[lane].started, 1);
    if (scenario === 'publish') for (const lane of [a, b]) assert.equal(counts[lane].completed, 1, lane);
    if (scenario === 'supersede') {
      // Unknown dispatched costs stay uncertain; concept keeps paid history.
      assert.ok(counts[a].superseded + counts[a].uncertain + counts[a].completed === 1);
      assert.ok(counts[b].superseded + counts[b].uncertain + counts[b].completed === 1);
    }
    if (scenario === 'pause/resume') {
      // Resume through the actual handler schedules the missing reply/assessment.
      assert.equal((await h.route('pause', { paused: false })).status, 200);
      const scheduled = h.handlers.idle();
      // Existing successful paid work is cached. Any missing background lane is explicit.
      if (![a, b].includes('reaction')) { const call = await h.next('reaction'); h.resolve(call); }
      if (![a, b].includes('understanding')) { const call = await h.next('understanding'); h.resolve(call); }
      await scheduled; balanced(h);
      const snapshot = await (await h.route()).json(); assert.deepEqual(snapshot.operations.running, []);
    }
  });
}

test('AIT-198 reply published before analysis dispatch remains user-final under thinking', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const reaction = h.run('reaction'), reply = await h.next('reaction'); h.resolve(reply); assert.equal(await reaction, 'completed');
  const analysis = h.run('understanding'), call = await h.next('understanding');
  assert.equal(call.body.reasoning.effort, 'low');
  h.resolve(call);
  assert.equal(await analysis, 'completed', 'provider must accept reply-before-analysis request');
  assert.equal(call.violation, null); assert.equal(call.body.messages.at(-1).role, 'user');
  assert.equal(h.runtime.budget.outcomeCounters().understanding.completed, 1); balanced(h);
});

for (const lane of laneNames) for (const failure of ['400', '401', '422', '408', '499', '503', 'timeout', 'abort', 'no usage', 'no cost']) {
  test(`AIT-201 ${lane}: ${failure} settles once`, { timeout: 10_000 }, async t => {
    const h = await createLaneRaceHarness(); t.after(() => h.close());
    const pending = h.run(lane), call = await h.next(lane);
    if (/^\d/u.test(failure)) call.httpError(Number(failure));
    else if (failure === 'timeout') call.timeout();
    else if (failure === 'abort') call.abort();
    else h.resolve(call, { usage: failure !== 'no usage', cost: false });
    await Promise.allSettled([pending]);
    const c = balanced(h)[lane]; assert.equal(c.started, 1);
    const row = h.storage.db.prepare('SELECT * FROM budget_attempts').get();
    if (['400', '401', '422'].includes(failure)) { assert.equal(row.settled_micro, 0); assert.equal(c.failed, 1); }
    else if (lane === 'concept' && ['408', '499'].includes(failure)) { assert.equal(row.settled_micro, 0); assert.equal(c.failed, 1); }
    else { assert.equal(row.outcome, 'uncertain'); assert.equal(c.uncertain, 1); }
    const before = h.runtime.budget.outcomeCounters();
    assert.equal(h.runtime.budget.finishOutcome(row.attempt_id, 'failed'), false, 'late finish cannot add another outcome');
    assert.deepEqual(h.runtime.budget.outcomeCounters(), before);
  });
}

test('AIT-201 provider rules accept coalesced roles and reject only documented text request violations', async () => {
  const base = { model: 'anthropic/race', reasoning: { effort: 'low' }, messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  assert.equal(providerRuleViolation(base), null);
  assert.equal(providerRuleViolation({ ...base, messages: [...base.messages, { role: 'assistant', content: 'Prefill' }] }), 'Assistant prefill is not supported when thinking is enabled');
  assert.equal(providerRuleViolation({ ...base, reasoning: { enabled: false }, messages: [...base.messages, { role: 'assistant', content: 'A' }, { role: 'assistant', content: 'B' }] }), null);
  for (const messages of [[], [{ role: 'wat', content: 'A' }], [{ role: 'user', content: '' }], [{ role: 'user', content: 'A' }, { role: 'system', content: 'Misplaced' }]]) {
    const kit = createFakeProviderKit(), pending = kit.fetchImpl('fake', { body: JSON.stringify({ ...base, messages }) });
    const call = await kit.next(); assert.ok(call.violation); call.resolve();
    const response = await pending, value = await response.json(); assert.equal(response.status, 400); assert.equal(value.error.type, 'invalid_request_error'); assert.equal(value.usage, undefined);
  }
  assert.equal(providerRuleViolation({ ...base, reasoning: { enabled: false }, messages: [...base.messages, { role: 'assistant', content: '' }] }), null, 'optional final assistant prefill is permitted without thinking');
  assert.equal(providerRuleViolation({ messages: [{ role: 'system', content: 'Wrong place' }] }, 'anthropic'), 'Messages use user/assistant; system belongs outside messages');
  assert.equal(providerRuleViolation({ model: 'openai/race', messages: [{ role: 'system', content: '' }, { role: 'user', content: '' }] }), null);
});

for (const lane of laneNames) for (const transition of ['superseded', 'deferred', 'aborted']) test(`AIT-201 ${lane}: ${transition} before dispatch releases zero`, { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), admit = h.runtime.admit.bind(h.runtime);
  h.runtime.admit = async args => {
    const result = await admit(args), attempt = result.options.attempt;
    return { ...result, options: { ...result.options, attempt: { ...attempt, async consume() {
      entered.resolve(); await release.promise; return attempt.consume();
    } } } };
  };
  const pending = h.run(lane); await entered.promise;
  if (transition === 'superseded') {
    h.turn('New person input during admission.');
    // A facade owns callback input across append-only turns. A changed model
    // choice is a strict supersession fence for that already admitted request.
    if (lane === 'voice-facade') h.storage.append(h.id, 'settings.changed', { processingPreset: 'best', settings: { ...h.storage.get(h.id).settings, effort: 'medium' } });
  }
  if (transition === 'deferred') h.storage.pause(h.id, true);
  if (transition === 'aborted') { h.controller.abort(); h.callController.abort(); }
  release.resolve(); await Promise.allSettled([pending]);
  assert.equal(h.kit.calls.length, 0, 'no provider call before valid dispatch');
  const counts = balanced(h)[lane]; assert.equal(counts[transition], 1);
  assert.equal(h.storage.db.prepare('SELECT settled_micro n FROM budget_attempts').get().n, 0);
});

test('AIT-201 schema compatibility retry owns two distinct balanced attempts', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const pending = h.run('understanding'), first = await h.next('understanding');
  first.httpError(400, { message: 'response_format json_schema is not supported' });
  const second = await h.next('understanding'); assert.equal(second.body.response_format, undefined); h.resolve(second);
  assert.equal(await pending, 'completed');
  const c = balanced(h).understanding; assert.equal(c.started, 2); assert.equal(c.completed, 1); assert.equal(c.failed, 1);
  assert.deepEqual(h.storage.db.prepare('SELECT settled_micro n FROM budget_attempts ORDER BY rowid').all().map(r => r.n), [0, 110]);
});

for (const lane of ['reaction', 'voice-facade']) test(`AIT-201 ${lane}: receipt before mid-stream abort never retains the maximum`, { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const observed = Promise.withResolvers(), observe = h.runtime.budget.observeCost.bind(h.runtime.budget);
  h.runtime.budget.observeCost = (id, evidence) => { const result = observe(id, evidence); if (evidence.chargedMicro === 110) observed.resolve(); return result; };
  const pending = h.run(lane), call = await h.next(lane), stream = call.openStream();
  await stream.frame({ usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 }, choices: [{ delta: { content: 'A partial clause, ' } }] });
  await observed.promise;
  h.controller.abort(); h.callController.abort();
  await Promise.allSettled([pending]);
  const c = balanced(h)[lane]; assert.equal(c.aborted, 1); assert.equal(c.uncertain, 0);
  assert.equal(h.storage.db.prepare('SELECT settled_micro n FROM budget_attempts').get().n, 110);
});

for (const lane of ['reaction', 'understanding']) test(`AIT-201 ${lane}: ignored abort and late receipt cannot overwrite a replacement`, { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness({ honorAbort: false }); t.after(() => h.close());
  const old = h.run(lane), obsolete = await h.next(lane);
  h.turn('New person input supersedes the old provider request.');
  await Promise.allSettled([old]);
  const replacement = h.run(lane), current = await h.next(lane); h.resolve(current); await replacement;
  const published = h.storage.read(h.id).filter(e => ['understanding.updated', 'turn.final'].includes(e.type));
  const receipt = Promise.withResolvers(), observe = h.runtime.budget.observeCost.bind(h.runtime.budget);
  h.runtime.budget.observeCost = (id, evidence) => { const result = observe(id, evidence); if (evidence.chargedMicro === 110) receipt.resolve(); return result; };
  h.resolve(obsolete); await receipt.promise;
  assert.deepEqual(h.storage.read(h.id).filter(e => ['understanding.updated', 'turn.final'].includes(e.type)), published, 'old result never publishes after replacement');
  assert.deepEqual(h.storage.db.prepare('SELECT settled_micro n FROM budget_attempts ORDER BY rowid').all().map(r => r.n), [110, 110], 'late authoritative receipt repairs the uncertain hold');
  balanced(h);
});


test('AIT-201 real start2 scheduler gates thinking behind reply and clears rejected overview work', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness({ purposePolicy: start2PurposePolicy }); t.after(() => h.close());
  assert.equal((await h.route('retry', {})).status, 202);
  const reaction = await h.next('reaction');
  assert.equal(h.kit.calls.length, 1, 'analysis cannot start before reply classifies scope');
  h.resolve(reaction);
  const analysis = await h.next('understanding');
  assert.equal(analysis.body.messages.at(-1).role, 'user'); assert.equal(analysis.violation, null);
  analysis.httpError(400); await h.handlers.idle();
  const snapshot = await (await h.route()).json();
  assert.deepEqual(snapshot.operations.running, []);
  assert.equal(snapshot.operations.lastFailure.lane, 'understanding');
  assert.equal(snapshot.operations.lastFailure.retryable, true);
  assert.equal(balanced(h).understanding.failed, 1);
  assert.equal((await h.route('retry', {})).status, 202);
  const retry = await h.next('understanding'); h.resolve(retry); await h.handlers.idle();
  const recovered = await (await h.route()).json();
  assert.deepEqual(recovered.operations.running, []); assert.equal(recovered.operations.lastFailure, null);
  assert.equal(recovered.understanding.summary, 'Ein Überblick. An overview.');
  balanced(h);
});
