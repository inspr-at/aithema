import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Verification } from '../src/verification.js';
import { EmailOffer } from '../src/email-offer.js';
import * as offerExports from '../../core/src/email-offer.js';
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
  assert.equal(emailOfferEligibility({ ...base, tiers: { canConfirm: false }, lock: true, canConfirm: true }).eligible, true, 'a lock can confirm independently of a credit increase');
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

test('AIT-507 saved guest requests its first link; pending resend preserves cooldown and address', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const window = new Window({ url: 'http://local/' }); globalThis.document = window.document;
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
  root.append(entry, lock, dialog);
  const calls = [], address = 'saved@example.test';
  const pending = { status: 'verification-pending', address, assessmentUnlocked: true, pollVerification: false, resendAfterMs: 10_000, delivery: 'sent' };
  const verification = new Verification({ root, entry, lock, dialog, copy: en, demo: true,
    identity: { ...pending, status: 'guest', resendAfterMs: 0 },
    request: async (path, body) => { calls.push({ path, body }); return { ok: true, body: { identity: pending } }; } });
  t.after(async () => { verification.destroy(); delete globalThis.document; await window.happyDOM.close(); });
  assert.equal((await verification.resend()).sent, true);
  assert.deepEqual(calls, [{ path: 'identity/request', body: { address } }]);
  assert.equal((await verification.resend()).status, 429);
  assert.equal(calls.length, 1, 'cooldown blocks another delivery');
  verification.set({ ...pending, resendAfterMs: 0 });
  assert.equal((await verification.resend()).ok, true);
  assert.deepEqual(calls.at(-1), { path: 'identity/resend', body: {} });
});

// Exercise the real save route's AIT-494 refusal through Verification, rather
// than stubbing saveAndConfirm (which would miss the save acknowledgement).
for (const status of [400, 503]) test(`AIT-507 save ${status} preserves capture and reports the save result`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const { SQLiteStorage, createHandlers } = await import('../../server/src/index.js');
  const { createDemoHost } = await import('../../../demo/host-ports.js');
  const storage = new SQLiteStorage(), owner = 'offer-save-fixture';
  const session = storage.create({ id: `offer-save-${status}`, ownerToken: owner });
  const host = createDemoHost({ storage, demo: true, ownerGuard: false, now: () => Date.now(), emailOffer: {} });
  const handlers = createHandlers({ storage, host });
  const window = new Window({ url: 'http://local/' }); globalThis.document = window.document;
  const element = window.document.createElement('div'); window.document.body.append(element);
  const root = element.attachShadow({ mode: 'open' });
  const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
  root.append(entry, lock, dialog);
  const requests = [];
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    if (!path.startsWith('/api/')) path = `/api/sessions/${session.id}/${path}`;
    requests.push({ path, method, body });
    const response = status === 503 && method === 'PUT' ? Response.json({ error: 'unavailable' }, { status: 503 })
      : await handlers.handle(new Request(`http://local${path}`, { method,
        headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { ok: response.ok, status: response.status, body: await response.json() };
  };
  const verification = new Verification({ root, entry, lock, dialog, copy: en, demo: true, request });
  const offer = new EmailOffer({ root, copy: en, verification, request, session: () => session, streaming: () => false });
  t.after(async () => { offer.destroy(); verification.destroy(); await handlers.close(); storage.close(); delete globalThis.document; await window.happyDOM.close(); });
  await verification.load();
  const row = window.document.createElement('li'); root.append(row); offer.paintRow(row);
  const address = status === 400 ? 'a(b)@example.com' : 'visitor@example.test';
  row.querySelector('input').value = address;
  await offer.save();
  assert.equal(row.querySelector('.email-offer__message').textContent, status === 400 ? en.hostSurface.verify.invalid : en.hostSurface.email.failed);
  assert.equal(row.querySelector('input').getAttribute('aria-invalid'), String(status === 400));
  assert.equal(row.querySelector('input').hidden, false);
  assert.equal(row.querySelector('input').value, address);
  assert.equal(verification.email.address, '');
  assert.equal(requests.filter(r => /identity\/(request|change|resend)$/u.test(r.path)).length, 0);
  assert.deepEqual(requests.find(r => r.method === 'PUT').body, { address, noticeVersion: 'ait-135-v1' });
});

test('AIT-507 saving uses the save copy before confirmation delivery', async t => {
  const f = fixture(t), row = f.root.ownerDocument.createElement('li'); f.root.append(row); f.offer.paintRow(row);
  let finish; f.offer.verification.saveAndConfirm = () => new Promise(resolve => { finish = resolve; });
  row.querySelector('input').value = 'visitor@example.test';
  const saving = f.offer.save();
  const message = row.querySelector('.email-offer__message').textContent;
  finish({ ok: true, sent: false }); await saving;
  assert.equal(message, en.hostSurface.email.saving);
  assert.equal(row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.deliveryFailed);
});

test('AIT-507 b7 saving keeps capture focusable and blocks duplicate submits', async t => {
  const f = fixture(t), row = f.root.ownerDocument.createElement('li'); f.root.append(row); f.offer.paintRow(row);
  let finish, saves = 0;
  f.offer.verification.saveAndConfirm = () => { saves++; return new Promise(resolve => { finish = resolve; }); };
  const input = row.querySelector('input'); input.value = 'a(b)@example.com'; input.focus();
  const saving = f.offer.save();
  // Snapshot first, then finish the pending operation even on the red head.
  const busy = { disabled: input.disabled, aria: input.getAttribute('aria-disabled'), button: row.querySelector('button[type="submit"]').getAttribute('aria-disabled') };
  await f.offer.save(); finish({ ok: false, status: 400 }); await saving;
  assert.equal(busy.disabled, false, 'saving must preserve a focusable capture input');
  assert.equal(busy.aria, 'true'); assert.equal(busy.button, 'true');
  assert.equal(saves, 1); assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-disabled'), 'false');
});

test('AIT-507 integration: temporary visitor-input bridge is not public API', () => {
  assert.equal('hasOfferVisitorInput' in offerExports, false);
});


test('AIT-540 M6: only an accepted current show claim permits one reveal', async t => {
  const f = fixture(t);
  f.offer.setCredits({ ...f.credits, emailOffer: { offered: true, open: true, at: 'a2', revision: 2 } });
  assert.equal(f.offer.takeReveal('a2'), false, 'restored credits never request a reveal');
  f.offer.request = async () => ({ ok: true, body: { accepted: false, emailOffer: f.offer.state } });
  await f.offer.act('show', 2);
  assert.equal(f.offer.takeReveal('a2'), false, 'a rejected claim never requests a reveal');
  f.offer.request = async () => ({ ok: true, body: { accepted: true, emailOffer: { offered: true, open: true, at: 'a2', revision: 1 } } });
  await f.offer.act('show', 2);
  assert.equal(f.offer.takeReveal('a2'), false, 'a stale response never requests a reveal');
  f.offer.request = async () => ({ ok: true, body: { accepted: true, emailOffer: { offered: true, open: true, at: 'a2', revision: 3 } } });
  await f.offer.act('show', 2);
  assert.equal(f.offer.takeReveal('a1'), false, 'only the claimed anchor can consume a reveal');
  assert.equal(f.offer.takeReveal('a2'), true, 'a new accepted show requests a reveal');
  assert.equal(f.offer.takeReveal('a2'), false, 'later re-renders cannot repeat it');
  f.offer.setCredits({ ...f.credits, emailOffer: { offered: true, open: true, at: 'a2', revision: 3 } });
  assert.equal(f.offer.takeReveal('a2'), false, 'credit refresh cannot re-arm it');
});
