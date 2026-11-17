import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Verification } from '../src/verification.js';
import { EmailOffer } from '../src/email-offer.js';
import * as offerExports from '../../core/src/email-offer.js';
import { emailOfferEligibility, visitorMessageCount } from '../../core/src/email-offer.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { confirmationHost } from '../../../test/fixtures/confirmation-host.js';

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


test('AIT-543: a host without a visitor store sends the offer through identity and grants credit only on confirmation', async t => {
  const f = await confirmationHost(t), window = new Window({ url: 'http://local/' });
  globalThis.document = window.document;
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
  root.append(entry, lock, dialog);
  const verification = new Verification({ root, entry, lock, dialog, copy: en, request: f.call, identity: f.session.identity, demo: true });
  const offer = new EmailOffer({ root, copy: en, verification, request: f.call, session: () => f.session, streaming: () => false });
  t.after(async () => { offer.destroy(); verification.destroy(); delete globalThis.document; await window.happyDOM.close(); });
  await verification.load(); verification.setCredits({ tiers: f.tiers() });
  const row = window.document.createElement('li'); root.append(row); offer.paintRow(row);
  const address = 'visitor@example.test'; row.querySelector('input').value = address;
  await offer.save();
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('identity/')), [{ path: 'identity/request', body: { address } }]);
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email' && call.body).length, 0, 'never attempt a refused visitor PUT');
  assert.equal(f.deliveries.at(-1)?.address, address, 'the host sent the link');
  assert.equal(row.dataset.step, 'sent');
  assert.equal(row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.sent);
  assert.equal(f.tiers().current, 'anonymous', 'sending a link does not grant credit');
  const confirmed = await f.call('identity/confirm', { token: 'fixture-confirmation' });
  assert.equal(confirmed.ok, true); verification.set(confirmed.body.identity); offer.paint();
  assert.equal(row.dataset.step, 'confirmed');
  assert.equal(f.tiers().current, 'emailConfirmed');
});

async function capabilityOffer(t, { canSave = false, identity = {}, reply, copy = en, loaded = true } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const window = new Window({ url: 'http://local/' }); globalThis.document = window.document;
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
  root.append(entry, lock, dialog);
  let current = { status: 'guest', address: null, assessmentUnlocked: true, pollVerification: false, resendAfterMs: 0, ...identity };
  const calls = [], address = 'visitor@example.test';
  const request = async (path, body, method) => {
    calls.push({ path, body, method });
    if (path === 'identity') return { ok: true, body: { identity: current, visitorEmail: { canSave, canDelete: canSave } } };
    if (path === '/api/visitor/email') return canSave ? { ok: true, body: { visitor: { address: body?.address ?? null }, notice: { version: 'fixture-notice' } } }
      : { ok: false, status: 404, body: { error: 'visitor-unavailable' } };
    const response = reply ? await reply(path, body) : { ok: true, body: { identity: { ...current, status: 'verification-pending', address: body?.address ?? current.address, delivery: 'sent' } } };
    if (response.body?.identity) current = response.body.identity;
    return response;
  };
  const verification = new Verification({ root, entry, lock, dialog, copy, request, identity: current, demo: true });
  const offer = new EmailOffer({ root, copy, verification, request, session: () => ({ locale: copy.display.locale }), streaming: () => false });
  t.after(async () => { offer.destroy(); verification.destroy(); delete globalThis.document; await window.happyDOM.close(); });
  if (loaded) await verification.load();
  const row = window.document.createElement('li'); root.append(row); offer.paintRow(row); row.querySelector('input').value = address;
  return { offer, row, calls, address, verification };
}

test('AIT-543: explicit store capability keeps save-before-confirm and the saved-tier failure copy', async t => {
  const f = await capabilityOffer(t, { canSave: true, reply: () => ({ ok: false, status: 503 }) });
  await f.offer.save();
  assert.deepEqual(f.calls.filter(call => call.body).map(call => [call.path, call.body, call.method]), [
    ['/api/visitor/email', { address: f.address, noticeVersion: 'fixture-notice' }, 'PUT'],
    ['identity/request', { address: f.address }, undefined],
  ]);
  assert.equal(f.verification.email.address, f.address, 'save succeeds even if delivery fails');
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.deliveryFailed);
});

test('AIT-543: a store-backed offer acknowledges saving before sending its link', async t => {
  const f = await capabilityOffer(t, { canSave: true });
  await f.offer.save();
  assert.deepEqual(f.calls.filter(call => call.body).map(call => call.path), ['/api/visitor/email', 'identity/request']);
  assert.equal(f.calls.find(call => call.method === 'PUT').body.noticeVersion, 'fixture-notice');
  assert.equal(f.row.dataset.step, 'sent');
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.sent);
});

test('AIT-543: an offer resolves an unloaded capability before choosing persistence', async t => {
  const f = await capabilityOffer(t, { loaded: false });
  await f.offer.save();
  assert.deepEqual(f.calls.map(call => call.path), ['identity', 'identity/request']);
  assert.equal(f.row.dataset.step, 'sent');
});

for (const status of [400, 429, 503, 'delivery-failed', 'network']) test(`AIT-543: no-store initial ${status} uses identity failure copy and retains focus`, async t => {
  const f = await capabilityOffer(t, { reply: () => {
    if (status === 'network') throw new Error('fixture network failure');
    return status === 'delivery-failed' ? { ok: true, body: { identity: { status: 'verification-pending', address: 'visitor@example.test', delivery: 'failed', pollVerification: false } } }
      : { ok: false, status };
  } });
  const input = f.row.querySelector('input'); input.focus();
  await f.offer.save();
  const key = status === 400 ? 'invalid' : status === 429 ? 'rateLimited' : 'failed';
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify[key]);
  assert.equal(input.getAttribute('aria-invalid'), String(status === 400));
  if (status !== 'delivery-failed') {
    assert.equal(input.hidden, false); assert.equal(input.value, f.address); assert.equal(f.row.getRootNode().activeElement, input);
  }
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email').length, 0);
});

test('AIT-543: no-store sending copy, pending resend, local cooldown and server 429 match identity', async t => {
  let finish, count = 0;
  const pending = { status: 'verification-pending', address: 'visitor@example.test', delivery: 'sent', pollVerification: false, resendAfterMs: 10_000 };
  const f = await capabilityOffer(t, { reply: () => {
    count++;
    if (count === 1) return new Promise(resolve => { finish = resolve; });
    return { ok: false, status: 429, body: { identity: { ...pending, resendAfterMs: 20_000 } } };
  } });
  const sending = f.offer.save();
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.sending);
  await f.offer.save(); assert.equal(count, 1, 'duplicate submits do not dispatch');
  finish({ ok: true, body: { identity: pending } }); await sending;
  await f.offer.save(); assert.equal(count, 1, 'local cooldown makes no request');
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.rateLimited);
  t.mock.timers.tick(10_000); await f.offer.save();
  assert.equal(count, 2); assert.equal(f.calls.at(-1).path, 'identity/resend'); assert.deepEqual(f.calls.at(-1).body, {});
  assert.equal(f.row.querySelector('.email-offer__message').textContent, en.hostSurface.verify.rateLimited);
  await f.offer.save(); assert.equal(count, 2, 'server 429 anchors the new cooldown');
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email').length, 0);
});

test('AIT-543: no-store confirmation uses the lock-form request/change rule', async t => {
  const f = await capabilityOffer(t, { identity: { status: 'verification-pending', address: 'first@example.test' } });
  assert.equal((await f.verification.saveAndConfirm('changed@example.test')).sent, true);
  assert.equal(f.calls.at(-1).path, 'identity/change');
  f.verification.set({ status: 'guest', address: 'saved@example.test', pollVerification: false });
  assert.equal((await f.verification.saveAndConfirm('changed@example.test')).sent, true);
  assert.equal(f.calls.at(-1).path, 'identity/request');
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email').length, 0);
});

for (const locale of ['en', 'de']) test(`AIT-543: ${locale} identity offer promises credit at confirmation and never promises saving`, async t => {
  const copy = { en, de }[locale];
  const f = await capabilityOffer(t, { copy });
  f.offer.state = { nextTier: 'emailConfirmed', deltaMicro: 3_000_000 }; f.offer.paint();
  assert.equal(f.row.querySelector('.email-offer__lead').textContent, copy.hostSurface.usedUp.hostConfirm.replace('{delta}', '300'));
  f.offer.state = { nextTier: 'emailGiven', deltaMicro: 3_000_000 }; f.offer.paint();
  assert.equal(f.row.querySelector('.email-offer__lead').textContent, copy.hostSurface.verify.entry, 'an unsupported saved-tier promise is omitted');
});

test('AIT-543 r3: an unloaded store capability resolves before showing confirmation sending', async t => {
  let finish;
  const f = await capabilityOffer(t, { canSave: true, loaded: false, reply: () => new Promise(resolve => { finish = resolve; }) });
  const saving = f.offer.save();
  const unresolvedMessage = f.row.querySelector('.email-offer__message').textContent;
  for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
  const storeMessage = f.row.querySelector('.email-offer__message').textContent;
  finish({ ok: true, body: { identity: { status: 'verification-pending', address: f.address, delivery: 'sent', pollVerification: false } } });
  await saving;
  assert.equal(unresolvedMessage, '', 'the loading state makes no delivery claim');
  assert.equal(storeMessage, en.hostSurface.email.saving);
  assert.equal(f.row.dataset.step, 'sent');
});
