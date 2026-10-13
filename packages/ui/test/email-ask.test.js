import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { EmailAsk, emailAskIntent, lowCredit, EMAIL_ASK_IDLE_MS } from '../src/email-ask.js';
import { emailAskStyles } from '../src/email-ask-styles.js';
import { en } from '../src/i18n/en.js';

const ready = { count: 5, replied: true, streaming: false, callActive: false, typing: false, eligible: true, low: false, desktop: true, dayReady: true };
test('AIT-164: after the fifth completed reply, and once per visitor day', () => {
  assert.equal(emailAskIntent({ ...ready, count: 4 }), null);
  assert.equal(emailAskIntent(ready), 'turn5');
  assert.equal(emailAskIntent({ ...ready, count: 20, dayReady: false }), null);
  assert.equal(emailAskIntent({ ...ready, replied: false }), null);
});
for (const blocker of ['streaming', 'callActive', 'typing']) test(`AIT-164: never while ${blocker}, including at the low point`, () => {
  assert.equal(emailAskIntent({ ...ready, low: true, [blocker]: true }), null);
});
test('AIT-164: the low ask overrides the day limit after a dismissal, once per conversation', () => {
  assert.equal(emailAskIntent({ ...ready, count: 2, dayReady: false, low: true, state: { shown5: true } }), 'low');
  assert.equal(emailAskIntent({ ...ready, dayReady: false, low: true, state: { shownLow: true } }), null);
  assert.equal(emailAskIntent({ ...ready, low: true, state: { shownLow: true } }), null, 'no fifth-turn repeat while already low');
  assert.equal(emailAskIntent({ ...ready, eligible: false, low: true }), null);
});
test('AIT-164: an ignored panel gate folds after two more completed visitor turns', () => {
  const state = { open: true, openedAt: 5 };
  assert.equal(emailAskIntent({ ...ready, state, count: 6 }), null);
  assert.equal(emailAskIntent({ ...ready, state, count: 7 }), 'fold');
  assert.equal(emailAskIntent({ ...ready, state, count: 7, desktop: false }), null);
  assert.equal(emailAskIntent({ ...ready, state: { ...state, saved: true }, count: 7 }), null);
});
test('AIT-164: low uses the acknowledged server threshold and zero stays used up', () => {
  const credits = { balance: { owner: { availableMicro: 1_000_000 } }, lowAtMicro: 1_000_000 };
  assert.equal(lowCredit(credits), true);
  assert.equal(lowCredit({ ...credits, lowAtMicro: 999_999 }), false);
  assert.equal(lowCredit({ ...credits, exhausted: true }), false);
  assert.equal(lowCredit({ ...credits, balance: { owner: { availableMicro: 0 } } }), false);
  assert.equal(lowCredit({ balance: credits.balance }), false);
});

function fixture(t) {
  const window = new Window({ url: 'http://local/' }), host = window.document.createElement('div');
  window.document.body.append(host); const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="workspace" data-understanding="present"><div class="audio-rail" data-call="none" data-state="idle"></div><div class="analysis-content"></div><div class="email-ask-pane"></div><button class="email-ask-fold"></button><div class="transcript-shell"></div><div class="concept-bar"></div><div class="composer-shell"><form class="composer"><textarea id="message"></textarea></form></div><div class="qcard"></div><div class="email-ask-dock"></div><p class="email-ask-announcement"></p></div>`;
  let now = 100_000, stream = false;
  const session = { locale: 'en', transcript: Array.from({ length: 5 }, (_, i) => [{ id: `u${i}`, role: 'user' }, { id: `a${i}`, role: 'assistant' }]).flat() };
  const email = { canCollect: true, address: '', delivery: false, numbers: { email: '1,500', confirmed: '2,000' }, paintNotice() {} };
  const requests = [];
  const ask = new EmailAsk({ root, copy: en, verification: { email }, session: () => session, streaming: () => stream, now: () => now,
    request: async (_, body) => { requests.push(body); return { ok: true, body: { accepted: true, nowMs: now, emailAskAfter: now + 86_400_000, emailAsk: { revision: requests.length, open: body.action === 'show', why: body.why, openedAt: 5, shown5: true } } }; } });
  t.after(() => { ask.destroy(); window.happyDOM.abort(); });
  return { ask, root, email, session, requests, at: value => { now = value; }, streaming: value => { stream = value; } };
}
const credits = { exhausted: false, lowAtMicro: 1_000_000, balance: { owner: { availableMicro: 6_550_000, limitMicro: 10_000_000 } },
  tiers: { next: 'emailGiven', delta: 5_000_000 }, emailAsk: {}, emailAskAfter: 0, nowMs: 100_000 };
test('AIT-164: automatic opening preserves focus; no phone keyboard and Escape returns to composer', async t => {
  const { ask, root } = fixture(t);
  root.querySelector('.email-ask-fold').focus(); const focused = root.activeElement;
  ask.setCredits(credits); await Promise.resolve(); await Promise.resolve();
  assert.equal(ask.open, true); assert.equal(root.activeElement, focused);
  assert.equal(ask.input.value, '', 'no sample address');
  ask.input.focus(); await ask.dismiss(true);
  assert.equal(root.activeElement, root.querySelector('#message'));
});
test('AIT-164: typing and partial replies defer the server claim until the composer rests', async t => {
  const f = fixture(t), input = f.root.querySelector('#message');
  input.value = 'draft'; input.focus(); f.ask.setCredits(credits); await Promise.resolve();
  assert.equal(f.requests.length, 0);
  input.value = ''; input.blur(); f.ask.lastInput = 100_000; f.at(100_000 + EMAIL_ASK_IDLE_MS - 1); f.ask.update();
  assert.equal(f.requests.length, 0);
  f.at(100_000 + EMAIL_ASK_IDLE_MS); f.streaming(true); f.ask.update(); assert.equal(f.requests.length, 0);
  f.streaming(false); f.ask.update(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.requests.length, 1);
});
test('AIT-164: starting a phone call dismisses the gate even while an email save is pending', async t => {
  const f = fixture(t); f.ask.credits = credits; f.ask.open = true; f.ask.state = { open: true, openedAt: 5 }; f.ask.step = 'saving';
  f.root.querySelector('.workspace').dataset.understanding = 'absent';
  const rail = f.root.querySelector('.audio-rail'); rail.dataset.call = 'active'; rail.dataset.state = 'connecting';
  f.ask.update(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.ask.open, false); assert.equal(f.ask.state.open, false); assert.equal(f.requests.at(-1).action, 'dismiss');
});
test('AIT-164: a mail host with confirmation disabled never promises its unavailable tier', t => {
  const f = fixture(t); f.email.delivery = true; f.email.address = 'visitor@example.test'; f.ask.sent = true; f.ask.step = 'done';
  f.ask.credits = { ...credits, tiers: { ...credits.tiers, canConfirm: false, allowancesMicro: { emailGiven: 15_000_000, emailConfirmed: 20_000_000 } } };
  f.ask.paint();
  assert.equal(f.ask.q('.m-tier').textContent, 'Credit: 1,500 Credits');
  assert.doesNotMatch(f.ask.q('.email-ask__benefit').textContent, /2,000|confirmed/u);
});
test('AIT-164: footer digits are tabular and reserve the server limit at every breakpoint', () => {
  assert.match(emailAskStyles, /host-credits__stack \{ font-variant-numeric:tabular-nums/u);
  assert.match(emailAskStyles, /host-credits__measure \{ visibility:hidden; white-space:nowrap/u);
});
