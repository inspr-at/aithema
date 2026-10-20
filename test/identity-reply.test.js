import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaneRaceHarness } from './fixtures/lane-race-harness.js';
import { inputRevision } from '../packages/core/src/session.js';
import { start2PurposePolicy } from '../demo/safeguards.js';

for (const purposePolicy of [undefined, start2PurposePolicy]) test(`AIT-418: admitted streaming reply survives identity revision (${purposePolicy ? 'purpose' : 'plain'})`, { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness({ purposePolicy }); t.after(() => h.close());
  h.storage.append(h.id, 'identity.state', { status: 'verified', address: 'before@example.test', identified: true });
  const revision = inputRevision(h.storage.get(h.id));
  const pending = h.run('reaction'), call = await h.next('reaction'), wire = call.openStream();
  await wire.frame({ choices: [{ delta: { content: purposePolicy ? '{"content":"Welche Arbeit?' : 'Welche Arbeit? ' } }] });
  h.storage.append(h.id, 'identity.state', { status: 'verification-pending', address: 'after@example.test', identified: false });
  assert.notEqual(inputRevision(h.storage.get(h.id)), revision, 'identity-dependent assessment remains invalidated');
  await wire.frame({ choices: [{ delta: { content: purposePolicy ? '","scope":"in","question_short":null,"options":[]}' : 'Wie geht es weiter?' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 } }).catch(() => {});
  await wire.end().catch(() => {});
  assert.equal(await pending, 'completed');
  const session = h.storage.get(h.id), replies = session.transcript.filter(turn => turn.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].inputRevision, inputRevision(session));
  assert.match(replies[0].content, /Welche Arbeit/u);
  assert.equal(h.kit.calls.length, 1, 'the accepted reply never needs a second paid attempt');
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'settled');
  assert.equal(rows[0].settled_micro, 110); assert.equal(rows[0].visitor_credit_released, 0);
  assert.deepEqual(h.settlements, [rows[0].attempt_id]);
});

test('AIT-418: an undelivered paid reply releases visitor credits and retains the provider receipt', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const pending = h.run('reaction'), call = await h.next('reaction');
  call.resolve('', { costUSD: 0.00011 });
  await assert.rejects(pending, /Empty reasoning stream/u);
  const row = h.storage.db.prepare('SELECT * FROM budget_attempts').get();
  assert.equal(row.state, 'settled'); assert.equal(row.settled_micro, 110);
  assert.equal(row.visitor_credit_released, 1);
  assert.equal(h.runtime.budget.breakdown(h.id, { visitorCredits: true }).confirmedSpendMicro, 0);
  assert.deepEqual(h.settlements, [row.attempt_id]);
  assert.equal(h.storage.get(h.id).transcript.filter(turn => turn.role === 'assistant').length, 0);
});

test('AIT-418: identity changes still discard an in-flight assessment', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  h.storage.append(h.id, 'identity.state', { status: 'verified', identified: true });
  const pending = h.run('understanding'), call = await h.next('understanding');
  h.storage.append(h.id, 'identity.state', { status: 'verification-pending', identified: false });
  h.resolve(call);
  assert.equal(await pending, 'stale');
  assert.equal(h.storage.get(h.id).understanding.inputRevision, null);
});

test('AIT-418: a new turn cannot refund a paid reply whose partial text was shown', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness(); t.after(() => h.close());
  const shown = Promise.withResolvers(), transient = h.handlers.lanes.transient;
  h.handlers.lanes.transient = (id, event) => { transient(id, event); if (event.type === 'turn.partial' && event.data.delta) shown.resolve(event.data.delta); };
  const pending = h.run('reaction'), call = await h.next('reaction'), wire = call.openStream();
  await wire.frame({ choices: [{ delta: { content: 'Welche Arbeit, ' } }], usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 } });
  assert.equal(await shown.promise, 'Welche Arbeit, ');
  h.turn('A quick follow-up supersedes the visible partial reply.');
  await Promise.allSettled([pending]);
  const row = h.storage.db.prepare('SELECT * FROM budget_attempts').get();
  assert.equal(h.storage.get(h.id).transcript.filter(turn => turn.role === 'assistant').length, 0);
  assert.equal(row.state, 'settled'); assert.equal(row.settled_micro, 110);
  assert.equal(row.visitor_credit_released, 0, 'shown partial text keeps its visitor charge');
  assert.equal(h.runtime.budget.breakdown(h.id, { visitorCredits: true }).confirmedSpendMicro, 110);
  assert.deepEqual(h.settlements, [row.attempt_id]);
});

test('AIT-418: the simulator-owned spoken reply keeps its visitor charge', { timeout: 10_000 }, async t => {
  const h = await createLaneRaceHarness({ purposePolicy: start2PurposePolicy }); t.after(() => h.close());
  h.handlers.lanes.replyVisible = () => false;
  const pending = h.run('reaction'), call = await h.next('reaction');
  h.resolve(call);
  assert.equal(await pending, 'completed');
  assert.equal(h.storage.get(h.id).transcript.filter(turn => turn.role === 'assistant').length, 0, 'the simulator owns delivery; no duplicate text reply');
  const row = h.storage.db.prepare('SELECT * FROM budget_attempts').get();
  assert.equal(row.state, 'settled'); assert.equal(row.settled_micro, 110);
  assert.equal(row.visitor_credit_released, 0, 'a spoken reply is delivered work');
  assert.equal(h.runtime.budget.breakdown(h.id, { visitorCredits: true }).confirmedSpendMicro, 110);
  assert.deepEqual(h.settlements, [row.attempt_id]);
});
