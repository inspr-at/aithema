import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditHoldFixture } from '../../test/fixtures/credit-hold.js';
import { lowCredit } from '../../packages/ui/src/email-ask.js';
import { admitCredits } from '../../packages/core/src/credits.js';

const credits = async f => (await f.call('/credits')).json();
for (const ownerGuard of [false, true]) test(`AIT-173: in-call hold uses expected spend, admission keeps maxima (guard ${ownerGuard})`, async t => {
  const f = await creditHoldFixture({ ownerGuard }); t.after(() => f.close());
  const before = f.storage.read(f.session.id), view = await credits(f);
  assert.equal(view.balance.owner.availableMicro, 6_000_000, '1000 - 390 settled - 10 expected = 600 Credits');
  assert.equal(lowCredit(view), false); assert.equal(view.exhausted, false);
  assert.equal((await (await f.call('/email-ask', { action: 'show', why: 'low' })).json()).accepted, false);
  assert.equal((await (await f.call('/email-ask', { action: 'line' })).json()).accepted, false);
  assert.equal(f.host.wallet(f.owner).balance().committedMicro, 9_800_000, 'wallet still holds the maximum');
  assert.equal(f.ledger.used(f.session.id), 9_800_000);
  assert.equal(f.ledger.canAdmit(f.session.id, 91_000_000), false, 'session admission retains maxima');
  assert.equal((await admitCredits(f.ledger, f.request('reaction', 200_001), f.host.wallet(f.owner))).ok, false);
  assert.deepEqual(f.storage.read(f.session.id), before, 'read/display checks do not end the conversation');
});

test('AIT-173: closing and uncertain voice retain liability without a false low point; receipts still reconcile', async t => {
  const f = await creditHoldFixture(); t.after(() => f.close());
  f.ledger.retainVoiceExposure(f.claim.attemptId);
  f.advance(60_000);
  assert.equal((await credits(f)).balance.owner.availableMicro, 6_000_000, 'freeze expected duration at hangup');
  const terminal = { attemptId: f.claim.attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: 60_000_000 };
  f.ledger.settleVoice(f.claim.claimId, terminal);
  f.advance(86_400_000);
  const before = f.ledger.get(f.claim.attemptId), view = await credits(f);
  assert.equal(view.balance.owner.availableMicro, 6_000_000);
  assert.equal(view.exhausted, false); assert.equal(lowCredit(view), false);
  assert.equal((await (await f.call('/email-ask', { action: 'show', why: 'low' })).json()).accepted, false);
  assert.equal(f.host.wallet(f.owner).balance().committedMicro, 63_900_000);
  assert.equal(f.host.wallet(f.owner).canAdmit({ maxMicro: 1 }), false);
  assert.deepEqual(f.ledger.get(f.claim.attemptId), before, 'display never rewrites uncertainty or terminal evidence');
  f.ledger.reconcileVoice(f.claim.attemptId, { closureConfirmed: true, usage: { providerSeconds: 60, providerMinutes: 1,
    visitorSeconds: 60, pausedSeconds: 0, upstreamMicro: 150_000, visitorMicro: 150_000, costEstimated: false } });
  assert.equal((await credits(f)).balance.owner.availableMicro, 5_950_000);
  assert.equal(f.ledger.get(f.claim.attemptId).terminal_json, before.terminal_json);
});

for (const closing of [false, true]) test(`AIT-173: genuine expected low spend still warns and opens the low ask (closing ${closing})`, async t => {
  const f = await creditHoldFixture({ settledMicro: 8_950_000, holdMicro: 1_000_000 }); t.after(() => f.close());
  if (closing) f.ledger.retainVoiceExposure(f.claim.attemptId);
  const view = await credits(f);
  assert.equal(view.balance.owner.availableMicro, 950_000); assert.equal(lowCredit(view), true); assert.equal(view.exhausted, false);
  assert.equal((await (await f.call('/email-ask', { action: 'show', why: 'low' })).json()).accepted, true);
});

test('AIT-173: expected spend reaching the allowance shows used-up, capped estimates do not overcharge', async t => {
  const f = await creditHoldFixture({ settledMicro: 9_950_000, holdMicro: 50_000 }); t.after(() => f.close());
  const view = await credits(f);
  assert.equal(view.balance.owner.availableMicro, 0); assert.equal(view.exhausted, true);
  assert.equal(f.ledger.get(f.claim.attemptId).settled_micro, null, 'display is not settlement');
});

test('AIT-173: display uses the capped AIT-163 lane/byte fallback and uncapped actual receipts', async t => {
  const f = await creditHoldFixture(); t.after(() => f.close());
  const { attemptId } = f.ledger.admit(f.request('reaction', 500_000, { providerCost: { estimateMicro: 20_000, observedCostMicro: 30_000 } }));
  const claim = f.ledger.claim(attemptId); claim.consume();
  assert.equal((await credits(f)).balance.owner.availableMicro, 5_970_000);
  f.ledger.observeCost(attemptId, { observedCostMicro: 900_000 });
  assert.equal((await credits(f)).balance.owner.availableMicro, 5_500_000, 'bytes cannot exceed the reservation');
  f.ledger.settle(claim.claimId, { attemptId, outcome: 'uncertain' });
  assert.equal((await credits(f)).balance.owner.availableMicro, 5_500_000, 'uncertain settlement keeps the same estimate');
  f.ledger.observeCost(attemptId, { chargedMicro: 700_000 });
  assert.equal((await credits(f)).balance.owner.availableMicro, 5_300_000, 'actual provider costs can overrun');
});

test('AIT-173: voice display follows extensions, survives recovery and isolates owners', async t => {
  const f = await creditHoldFixture({ settledMicro: 0, holdMicro: 50_000 }); t.after(() => f.close());
  assert.equal((await credits(f)).balance.owner.availableMicro, 9_950_000, 'duration estimate is capped');
  f.ledger.extendVoice(f.claim.attemptId, { maxMicro: 200_000, maxVisitorMicro: 200_000 });
  assert.equal((await credits(f)).balance.owner.availableMicro, 9_900_000, 'extending the hold does not spend the extension');
  const other = f.storage.create({ ownerToken: 'another-owner' });
  const extra = f.ledger.admit({ ...f.request('reaction', 100_000), sessionId: other.id });
  const foreign = f.ledger.claim(extra.attemptId); foreign.consume();
  f.ledger.settle(foreign.claimId, { attemptId: extra.attemptId, outcome: 'completed', chargedMicro: 100_000, usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal((await credits(f)).balance.owner.availableMicro, 9_900_000);
  f.ledger.recover(f.session.id); f.advance(86_400_000);
  assert.equal((await credits(f)).balance.owner.availableMicro, 9_900_000, 'recovery freezes display duration but retains liability');
  assert.equal(f.ledger.used(f.session.id), 60_000_000);
});
