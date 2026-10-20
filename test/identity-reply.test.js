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
  await wire.frame({ choices: [{ delta: { content: purposePolicy ? '","scope":"in","question_short":null,"options":[]}' : 'Wie geht es weiter?' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 } });
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
