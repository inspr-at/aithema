import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { EmailOffer } from '../src/email-offer.js';
import { emailOfferEligibility, visitorMessageCount } from '../../core/src/email-offer.js';
import { en } from '../src/i18n/en.js';

const tiers = { current: 'anonymous', next: 'emailGiven', delta: 3_000_000, canConfirm: true,
  allowancesMicro: { anonymous: 1_000_000, emailGiven: 4_000_000, emailConfirmed: 6_000_000 } };
test('AIT-507 eligibility: give, confirm, lock only, delivery and privacy', () => {
  const base = { privacyCapability: true, delivery: true, tiers };
  assert.deepEqual(emailOfferEligibility(base), { eligible: true, nextTier: 'emailGiven', delta: 3_000_000 });
  const confirm = { ...tiers, next: 'emailConfirmed', delta: 5_000_000 };
  assert.equal(emailOfferEligibility({ ...base, tiers: confirm }).nextTier, 'emailConfirmed');
  assert.equal(emailOfferEligibility({ ...base, tiers: { canConfirm: true }, lock: true }).eligible, true);
  assert.equal(emailOfferEligibility({ ...base, tiers: { canConfirm: false }, lock: true }).eligible, false);
  assert.equal(emailOfferEligibility({ ...base, privacyCapability: false }).eligible, false);
  assert.equal(emailOfferEligibility({ ...base, delivery: false }).eligible, false);
});
test('AIT-507 counts accepted visitor finals only, deduplicated, never documents or the opener', () => {
  assert.equal(visitorMessageCount({ transcript: [
    { id: 'host:opener', role: 'assistant' }, { id: 'a1', role: 'assistant' },
    { id: 'u1', role: 'user' }, { id: 'u1', role: 'user' },
    { id: 'u2', role: 'user', source: 'voice' }, { id: 'gone', role: 'user', erased: true },
  ], uploads: [{ id: 'document' }] }), 2);
});
function fixture(t, { address = '', next = 'emailGiven', lock = false } = {}) {
  const window = new Window({ url: 'http://local/' }), root = window.document.createElement('div');
  window.document.body.append(root);
  const email = { address, canCollect: true, delivery: true, identity: { verificationRequired: lock },
    paintNotice(n) { n.textContent = 'Privacy notice'; } };
  const calls = [], session = { locale: 'en', emailOffer: { afterMessages: 2 }, transcript: [
    { id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' },
  ] };
  const verification = { email, locked: lock, async saveAndConfirm(value) { calls.push(['save', value]); email.address = value; return { ok: true, sent: true }; },
    async resend() { calls.push(['resend']); return { ok: true, sent: true }; } };
  const offer = new EmailOffer({ root, copy: en, verification, session: () => session, streaming: () => false,
    changed() {}, request: async (_, body) => { calls.push(body); return { ok: true, body: { accepted: true,
      emailOffer: { offered: true, open: body.action === 'show', at: 'a2', dismissed: body.action === 'dismiss' } } }; } });
  t.after(() => { offer.destroy(); window.happyDOM.abort(); });
  const credits = { tiers: { ...tiers, next, delta: next ? tiers.delta : 0 }, emailOffer: {}, exhausted: false };
  return { offer, root, calls, email, session, credits };
}
for (const [next, lock, key] of [['emailGiven', false, 'hostGive'], ['emailConfirmed', false, 'hostConfirm'], [null, true, 'lockLead']]) {
  test(`AIT-507 inline variant ${key} renders notice without changing transcript`, async t => {
    const f = fixture(t, { next, lock }); f.offer.setCredits(f.credits); await Promise.resolve(); await Promise.resolve();
    const row = f.root.ownerDocument.createElement('li'); f.root.append(row); f.offer.paintRow(row);
    assert.equal(f.offer.entry.at, 'a2');
    assert.equal(row.querySelector('.email-offer__lead').textContent, key === 'lockLead' ? en.hostSurface.verify[key] : en.hostSurface.usedUp[key].replace('{delta}', '300'));
    assert.equal(row.querySelector('.m-notice').textContent, 'Privacy notice');
    assert.equal(f.session.transcript.length, 4);
    assert.equal(row.inert, false);
  });
}
test('AIT-507 saved address uses resend; dismiss remains latched', async t => {
  const f = fixture(t, { address: 'saved@example.test' }); f.offer.setCredits(f.credits); await Promise.resolve(); await Promise.resolve();
  const row = f.root.ownerDocument.createElement('li'); f.root.append(row); f.offer.paintRow(row);
  assert.equal(row.querySelector('input').hidden, true);
  assert.equal(row.querySelector('.email-offer__send').textContent, en.hostSurface.verify.resend);
  await f.offer.save(); assert.deepEqual(f.calls.at(-1), ['resend']);
  await f.offer.dismiss(); f.offer.update(); await Promise.resolve();
  assert.equal(f.calls.filter(c => c.why === 'offer' && c.action === 'show').length, 1);
});
