// AIT-298: focused unit workers keep cumulative DOM work within the unchanged
// three-minute file deadline under merge-group CPU contention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { hostStyles } from '../src/host-styles.js';
import { window, tick, v, l, h, cr, identity, locked, pending, entry, balance, setup, userTurn, a2Setup } from './host-surface-helpers.js';

test('AIT-164: mail Settings saves and raises the tier before the confirmation request finishes', async t => {
  let finish, requested;
  const waiting = new Promise(resolve => { finish = resolve; });
  const { root, c, calls } = a2Setup(t, { delivery: true, link: async body => { requested = body; await waiting; return Response.json({ identity: identity({ status: 'verification-pending', address: body.address, delivery: 'sent' }) }); } });
  await tick(10); c.openSettings(undefined, { tab: 'general', anchor: '#email' }); await tick();
  root.querySelector('.verify-entry').click(); await tick();
  const form = root.querySelector('.verify-dialog .verify-form'); form.querySelector('input').value = 'mail-reader@example.test'; form.requestSubmit();
  await tick(12);
  assert.deepEqual(requested, { address: 'mail-reader@example.test' });
  assert.ok(calls.findIndex(call => call.method === 'PUT') < calls.findIndex(call => call.path === '/identity/request' && call.method === 'POST'));
  assert.match(root.querySelector('.host-credits__total').textContent, /1,800/u);
  assert.equal(form.querySelector('.verify-send').textContent, en.hostSurface.email.save);
  finish(); await tick(12); assert.equal(root.querySelector('.host-verify').dataset.emailState, 'pending');
});

test('AIT-164: mail Settings cannot bypass saving while its first privacy-notice read is still pending', async t => {
  let release, reads = 0;
  const first = new Promise(resolve => { release = resolve; });
  const { root, c, calls } = a2Setup(t, { delivery: true,
    visitorRead: read => ++reads === 1 ? first.then(read) : read(),
    link: body => Response.json({ identity: identity({ status: 'verification-pending', address: body.address, delivery: 'sent' }) }),
  });
  await tick(8); c.openSettings(undefined, { tab: 'general', anchor: '#email' }); await tick();
  root.querySelector('.verify-entry').click(); await tick();
  const form = root.querySelector('.verify-dialog .verify-form'); form.querySelector('input').value = 'mail-reader@example.test'; form.requestSubmit(); await tick(12);
  const put = calls.findIndex(call => call.method === 'PUT'), link = calls.findIndex(call => call.method === 'POST' && call.path === '/identity/request');
  assert.ok(put >= 0 && link > put, 'the saved-tier acknowledgement must precede C1');
  assert.deepEqual(calls[put].body, { address: 'mail-reader@example.test', noticeVersion: 'ait-135-v1' });
  assert.match(root.querySelector('.host-credits__total').textContent, /1,800/u);
  release(); await tick(8);
});

for (const copy of [de, en]) test(`AIT-135 A2 B: server tiers in a group, one unit line, no countdown (${copy === de ? 'de' : 'en'})`, async t => {
  const { c, root } = a2Setup(t, { copy }); await tick(8);
  const popup = root.querySelector('.host-credits .footer-popup');
  assert.equal(popup.getAttribute('role'), 'group');
  assert.equal(popup.querySelector('.host-credits__current').hidden, true, 'the anonymous balance already names its tier');
  assert.match(popup.querySelector('.host-credits__next').textContent, copy === de ? /1\.800 Credits/u : /1,800 Credits/u);
  assert.equal(popup.querySelector('.credits-email').textContent, copy === de ? 'E-Mail-Adresse angeben' : 'Add your email address');
  assert.equal(popup.querySelector('.host-credits__equivalence').textContent, copy === de ? '1 Credit = 1 US-Cent' : '1 Credit = 1 US cent');
  assert.equal(root.querySelector('.host-credits__deadline')?.textContent ?? '', '');
  popup.querySelector('.credits-email').click(); await tick(6);
  assert.equal(root.querySelector('dialog.settings').open, true);
  assert.equal(root.querySelector('[data-tab="general"]').getAttribute('aria-selected'), 'true');
  assert.equal(root.activeElement?.id, 'email-input');
  c.remove();
});

test('AIT-135 A2 B: used-up composer preserves the form, offers the actual delta and disables new work', async t => {
  const { root } = a2Setup(t, { spent: 12_000_000, voiceClient: {} }); await tick(8);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  assert.equal(root.querySelector('form.composer').inert, true);
  assert.match(root.querySelector('.composer-out__give').textContent, /600 more Credits/u);
  assert.equal(root.querySelector('.voice-state').textContent, 'Credits used up');
  assert.equal(root.querySelector('.voice-state').getAttribute('aria-live'), 'off', 'one region announces exhaustion');
  assert.equal(root.querySelector('.voice-start').disabled, true);
  assert.equal(root.querySelector('.host-credits__amount').textContent, '0');
  assert.equal(root.querySelector('.host-credits__used-up').getAttribute('aria-hidden'), 'false');
});

test('AIT-135 A2 B: no next tier offers export, including the privacy release gate', async t => {
  for (const options of [{ address: 'reader@example.test', spent: 18_000_000 }, { privacy: false, spent: 12_000_000 }]) {
    const { c, root } = a2Setup(t, options); await tick(8);
    assert.equal(root.querySelector('.composer-out').dataset.next, 'none');
    assert.equal(root.querySelector('.composer-out__export').getAttribute('aria-hidden'), 'false');
    assert.equal(root.querySelector('.credits-email').hidden, true);
    c.remove();
  }
});

test('AIT-135 A2 B: Escape dismisses a pinned credits group and returns focus to the credits button', async t => {
  const { root } = a2Setup(t); await tick(8);
  const line = root.querySelector('.host-credits'), button = root.querySelector('.host-credits__button');
  button.click(); root.querySelector('.credits-email').focus();
  root.querySelector('.credits-email').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(line.hasAttribute('data-dismissed'), true);
  assert.equal(root.activeElement, button);
});

for (const copy of [de, en]) test(`AIT-135 A2 C: inline save, edit and normal delete use acknowledged tiers (${copy === de ? 'de' : 'en'})`, async t => {
  const { c, root, calls } = a2Setup(t, { copy }); await tick(8);
  c.openSettings(undefined, { tab: 'general' }); await tick();
  const section = root.querySelector('.host-verify'), input = section.querySelector('#email-input');
  assert.match(section.querySelector('.m-lead').textContent, copy === de ? /1\.200.*1\.800/u : /1,200.*1,800/u);
  assert.equal(section.querySelector('.m-pp').getAttribute('href'), '/privacy?locale=' + (copy === de ? 'de' : 'en'));
  input.value = 'reader@example.test'; section.querySelector('.m-form').requestSubmit(); await tick(10);
  const savedReads = calls.filter(call => call.path === '').length;
  assert.ok(savedReads > 0, 'saving a higher tier refreshes features below the ceiling');
  assert.deepEqual(calls.find(call => call.method === 'PUT').body, { address: 'reader@example.test', noticeVersion: 'ait-135-v1' });
  assert.equal(section.dataset.emailState, 'saved');
  assert.match(section.querySelector('.m-tier').textContent, copy === de ? /Guthaben: 1\.800 Credits/u : /Credit: 1,800 Credits/u);
  assert.doesNotMatch(section.querySelector('.m-tier').textContent, /1[.,]455/u, 'Settings shows the tier only');
  assert.equal(root.activeElement, section.querySelector('.m-change'));
  const select = t.mock.method(input, 'select'); section.querySelector('.m-change').click();
  assert.equal(input.value, 'reader@example.test'); assert.equal(root.activeElement, input); assert.equal(select.mock.callCount(), 1);
  section.querySelector('.m-cancel').click(); section.querySelector('.m-delete').click();
  assert.equal(root.activeElement, section.querySelector('.m-keep'));
  assert.match(section.querySelector('.m-delete-normal').textContent, copy === de ? /1\.200.*855/u : /1,200.*855/u);
  section.querySelector('.m-del').click(); await tick(10);
  assert.ok(calls.filter(call => call.path === '').length > savedReads, 'deleting a tier refreshes features below the ceiling');
  assert.equal(section.dataset.emailState, 'capture'); assert.equal(root.activeElement, input);
  assert.equal(input.value, '', 'acknowledged deletion clears the cancelled edit');
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('AIT-135 A2 C: validation is calm, clears while typing, and saving keeps the button label', async t => {
  let finish; const saving = new Promise(resolve => { finish = resolve; });
  const { root, calls } = a2Setup(t, { save: () => saving }); await tick(8);
  const input = root.querySelector('#email-input'), form = root.querySelector('.host-verify .m-form'), button = root.querySelector('.host-verify .m-save');
  input.value = 'reader'; form.requestSubmit(); await tick();
  assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
  input.value = 'reader@example.test'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(input.getAttribute('aria-invalid'), 'false'); form.requestSubmit(); await tick();
  assert.equal(button.textContent, 'Save'); assert.match(root.querySelector('.host-verify .m-msg').textContent, /Saving/u);
  finish(); await tick(10);
});

test('AIT-135 A2 C: deleting an over-spent address works and restores the used-up state', async t => {
  const { root, calls } = a2Setup(t, { address: 'reader@example.test', spent: 15_000_000 }); await tick(8);
  root.querySelector('.host-verify .m-delete').click();
  assert.match(root.querySelector('.host-verify .m-delete-over').textContent, /1,500 Credits.*used up/u);
  root.querySelector('.host-verify .m-del').click(); await tick(10);
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  assert.match(root.querySelector('.host-verify .m-msg').textContent, /deleted.*used up/u);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
});

test('AIT-135 A2 C: no privacy document offers no collection input or confirmation dialog', async t => {
  const { root, calls } = a2Setup(t, { privacy: false }); await tick(8);
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'unavailable');
  assert.equal(root.querySelector('.host-verify .m-form').inert, true);
  assert.equal(root.querySelector('.verify-entry').hidden, true);
  assert.equal(root.querySelector('dialog.verify-dialog').open, false);
  assert.equal(calls.filter(c => ['POST', 'PUT'].includes(c.method)).length, 0);
});

test('AIT-135 A2 C: handover purpose and the short 90-day notice accompany the host privacy link', async t => {
  const { root } = a2Setup(t, { handover: true }); await tick(8);
  assert.match(root.querySelector('.host-verify .m-notice').textContent, /For a personal follow-up we ask you separately\./u);
  assert.match(root.querySelector('.host-verify .m-notice').textContent, /After 90 days without use, we delete it automatically\./u);
  assert.doesNotMatch(root.querySelector('.host-verify .m-notice').textContent, /Use means|cookie/u);
  assert.equal(root.querySelector('.host-verify .m-pp').getAttribute('href'), '/privacy?locale=en');
});


test('AIT-135 A2 B: the supplied open question stays readable and its answers rest when credit runs out', async t => {
  const { root } = a2Setup(t, { spent: 12_000_000, voiceClient: {}, question: { question_short: 'What would help next?', options: [{ text: 'Discuss the goals', likely: true }, { text: 'Discuss resources' }] } }); await tick(8);
  const card = root.querySelector('.question-card');
  assert.equal(card.hidden, false); assert.equal(card.inert, true);
  assert.equal(card.querySelector('.qtext').textContent, 'What would help next?');
  assert.ok([...card.querySelectorAll('button')].every(button => button.disabled));
  assert.equal(root.querySelector('.pause').disabled, true);
});

test('AIT-135 A2 C: an address saved before the privacy gate closes remains deletable', async t => {
  const { root, calls } = a2Setup(t, { privacy: false, address: 'reader@example.test', spent: 18_000_000 }); await tick(8);
  root.querySelector('.host-verify .m-change').click();
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'saved');
  root.querySelector('.host-verify .m-delete').click(); root.querySelector('.host-verify .m-del').click(); await tick(10);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(root.querySelector('.host-verify').dataset.emailState, 'unavailable');
});


for (const copy of [de, en]) test(`AIT-135 A2 C: delivery saves the given tier before AIT-131 sends the confirmation (${copy.display.locale})`, async t => {
  let address = null, status = 'guest';
  const h = setup(t, { copy, session: { identity: identity(), demo: true }, host: { verification: true, credits: true }, routes: {
    'GET /visitor/email': () => Response.json({ visitor: { address }, notice: { version: 'ait-135-v1', deliveryEnabled: true } }),
    'GET /identity': () => Response.json({ identity: identity({ address, status }), delivery: true }),
    'GET /credits': () => Response.json({ balance, limitSlot: null, tiers: { allowancesMicro: a2Allowances, current: address ? 'emailGiven' : 'anonymous', next: 'emailConfirmed', delta: 6_000_000, canConfirm: true } }),
    'PUT /visitor/email': body => { address = body.address; return Response.json({ visitor: { address } }); },
    'POST /identity/request': body => { address = body.address; status = 'verification-pending'; return Response.json({ identity: identity({ address, status }) }); },
  } }); await tick(10);
  h.root.querySelector('.verify-entry').click(); await tick(6);
  const dialog = h.root.querySelector('dialog.verify-dialog');
  assert.match(dialog.querySelector('.verify__lead').textContent, copy === de ? /1\.800.*2\.400/u : /1,800.*2,400/u);
  assert.match(dialog.querySelector('.m-notice').textContent, /90/u);
  dialog.querySelector('input').value = 'reader@example.test'; dialog.querySelector('form').requestSubmit(); await tick(12);
  const writes = h.calls.filter(call => ['PUT', 'POST'].includes(call.method) && ['/visitor/email', '/identity/request'].includes(call.path));
  assert.deepEqual(writes.map(call => [call.method, call.path]), [['PUT', '/visitor/email'], ['POST', '/identity/request']]);
  assert.equal(h.root.querySelector('.host-verify').dataset.emailState, 'pending');
});


test('AIT-135 A2 C: equal allowances and disabled confirmation never promise an increase', async t => {
  const { root } = setup(t, { session: { demo: true, identity: identity() }, host: { verification: true, credits: true }, routes: {
    'GET /credits': () => Response.json({ balance, limitSlot: null, tiers: { current: 'anonymous', next: null, delta: 0, canConfirm: false,
      allowancesMicro: { anonymous: 5_000_000, emailGiven: 5_000_000, emailConfirmed: 8_000_000 } } }),
  } }); await tick(8);
  assert.equal(root.querySelector('.host-verify .m-lead-mail').textContent, 'Credit: 500 Credits');
  assert.equal(root.querySelector('.credits-email').hidden, true);
  root.querySelector('.verify-entry').click(); await tick();
  assert.equal(root.querySelector('.verify__lead-mail').textContent, 'Credit: 500 Credits');
});


test('AIT-135 A2 B: saving after exhaustion refreshes the authoritative verdict instead of keeping budget denied', async t => {
  const { root, calls } = a2Setup(t, { spent: 12_000_000, blocked: true }); await tick(8);
  assert.equal(root.querySelector('textarea').disabled, true);
  root.querySelector('#email-input').value = 'reader@example.test'; root.querySelector('.host-verify .m-form').requestSubmit(); await tick(16);
  assert.ok(calls.some(call => call.path === ''), 'the host snapshot is read after the allowance rises');
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(root.querySelector('textarea').disabled, false);
});

test('AIT-135 A2 B: an exhausted visible app notices a CLI allowance increase without an SSE event', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let raised = false;
  const { c, root, calls } = setup(t, { host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance: { owner: { limitMicro: raised ? 18_000_000 : 12_000_000, committedMicro: 12_000_000, availableMicro: raised ? 6_000_000 : 0 } }, exhausted: !raised, limitSlot: null }),
  } }); await tick(8);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  raised = true; t.mock.timers.tick(15_001); await tick(12);
  assert.equal(calls.filter(call => call.path === '/credits').length, 2);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  c.remove(); const reads = calls.length; t.mock.timers.tick(15_001); await tick(); assert.equal(calls.length, reads, 'detached apps stop polling');
});

for (const copy of [de, en]) test(`AIT-155 / AIT-135 A2: full hold keeps the call running and switches the placeholder back (${copy === de ? 'de' : 'en'})`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(); let closes = 0;
  const voiceClient = { async start({ callId }) { return { callId, providerSessionId: 'held-provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { closes++; events.end(); return { closureConfirmed: true }; } }; } };
  const f = a2Setup(t, { copy, spent: 0, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  const input = f.root.querySelector('textarea');
  assert.equal(input.placeholder, copy.placeholderVoice);
  f.setReserved(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.c.session.featureMatrix.best.voice.available, false, 'server preview denies another reservation');
  assert.equal(closes, 0, 'a full reservation must not close the admitted segment');
  assert.equal(f.root.querySelector('.host-credits__amount').textContent, '0', 'the fully reserved wallet read was applied');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceStates.listening);
  assert.equal(input.placeholder, copy === de ? 'Sprechen Sie einfach weiter.' : 'Just keep talking.');
  assert.equal(input.disabled, true);
  assert.equal(f.root.querySelector('.voice-close').disabled, false);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(f.root.querySelector('.credit-announcement').textContent, '');
  f.setReserved(0);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(input.placeholder, copy.placeholderVoice, 'released credit restores the ordinary listening placeholder');
  assert.equal(input.disabled, false);
  f.root.querySelector('.voice-close').click(); await tick(8);
  assert.equal(input.placeholder, copy.placeholder, 'ending the call restores the typing placeholder');
});

test('AIT-135 A2 fix 1: a zero available balance without an exhaustion verdict keeps the normal state', async t => {
  const { root } = setup(t, { host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance: { owner: { limitMicro: 12_000_000, committedMicro: 12_000_000, availableMicro: 0 } }, limitSlot: null }),
  } }); await tick(8);
  assert.equal(root.querySelector('.host-credits').dataset.ended, 'false');
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
});

test('AIT-135 A2 fix 1: an admission refusal stays authoritative through a full-hold read and clears after recovery', async t => {
  const f = a2Setup(t, { spent: 0, reserved: 12_000_000 }); await tick(8);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'true', 'a balance refresh cannot erase a retained admission refusal while the hold remains');
  f.topUp(); f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false');
});

for (const recovery of ['email', 'CLI']) for (const waiting of [false, true]) test(`AIT-135 A2 fix 2: ${waiting ? 'waiting-call Resume' : 'Retry'} after a ${recovery} top-up clears the retained host-limit denial`, async t => {
  if (recovery === 'CLI') t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), requests = []; let recovered = false;
  const waitingCall = waiting ? { callId: 'waiting-call', providerSessionId: 'waiting-provider', state: 'waiting' } : undefined;
  const voiceClient = { async start(request) {
    requests.push(request);
    if (!recovered) throw Object.assign(new Error('host allowance refused admission'), { code: 'not-admitted', reason: 'host-limit' });
    return { callId: request.callId, providerSessionId: 'recovered-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient, waitingCall }); await tick(8);
  f.root.querySelector(waiting ? '.pause' : '.voice-start').click(); await tick(8);
  assert.equal(requests.length, 1);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, waiting ? 'waiting' : 'failed');
  f.setSpent(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true);
  recovered = true;
  if (recovery === 'email') {
    f.root.querySelector('#email-input').value = 'reader@example.test'; f.root.querySelector('.host-verify .m-form').requestSubmit();
  } else { f.topUp(); t.mock.timers.tick(15_001); }
  await tick(16);
  assert.equal(f.c.session.featureMatrix.best.voice.available, true, 'the server confirms new voice admission');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false, 'the old refusal cannot override the recovered verdict');
  assert.notEqual(f.root.querySelector('.voice-state').textContent, en.voiceStates.usedUp);
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, false);
  f.root.querySelector(waiting ? '.pause' : '.voice-retry').click(); await tick(8);
  assert.equal(requests.length, 2); assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  if (waiting) assert.deepEqual(requests[1], { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId }, 'Resume retains the logical call');
  for (const selector of ['.voice-input', '.voice-output', '.voice-close']) assert.equal(f.root.querySelector(selector).disabled, false);
});

for (const recovery of ['email', 'CLI']) for (const waiting of [false, true]) test(`AIT-135 A2 round 2: denial-only ${waiting ? 'Resume' : 'Retry'} recovers after a ${recovery} top-up below the ceiling`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const events = voiceEvents(), requests = []; let recovered = false;
  const waitingCall = waiting ? { callId: 'waiting-call', providerSessionId: 'waiting-provider', state: 'waiting' } : undefined;
  const voiceClient = { async start(request) {
    requests.push(request);
    if (!recovered) throw Object.assign(new Error('host allowance refused admission'), { code: 'not-admitted', reason: 'host-limit' });
    return { callId: request.callId, providerSessionId: 'recovered-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient, waitingCall }); await tick(8);
  const idleReads = f.calls.length;
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(f.calls.length, idleReads, 'healthy apps do not poll');
  f.root.querySelector(waiting ? '.pause' : '.voice-start').click(); await tick(8);
  assert.equal(requests.length, 1);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, waiting ? 'waiting' : 'failed');
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true);
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, true);
  assert.equal(f.root.querySelector('.host-credits').dataset.ended, 'false', 'confirmed spend stays below the ceiling');
  assert.equal(f.root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true');
  const before = f.calls.filter(call => call.path === '').length;
  recovered = true;
  if (recovery === 'email') {
    f.root.querySelector('#email-input').value = 'reader@example.test'; f.root.querySelector('.host-verify .m-form').requestSubmit();
  } else { f.topUp(); t.mock.timers.tick(15_001); }
  await tick(16);
  assert.ok(f.calls.filter(call => call.path === '').length > before, 'recovery reads a fresh server verdict without a limit event');
  assert.equal(f.c.session.featureMatrix.best.voice.available, true);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), false, 'the fresh verdict clears the refusal');
  assert.equal(f.root.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, false);
  const recoveredReads = f.calls.length;
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(f.calls.length, recoveredReads, 'recovered apps stop polling');
  f.root.querySelector(waiting ? '.pause' : '.voice-retry').click(); await tick(8);
  assert.equal(requests.length, 2); assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
  if (waiting) assert.deepEqual(requests[1], { callId: waitingCall.callId, providerSessionId: waitingCall.providerSessionId }, 'Resume retains the logical call');
  for (const selector of ['.voice-input', '.voice-output', '.voice-close']) assert.equal(f.root.querySelector(selector).disabled, false);
});

test('AIT-135 A2 round 2: denial-only polling skips hidden pages, bounds wallet and feature reads, and stops on detach', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const voiceClient = { async start() { throw Object.assign(new Error('not admitted'), { code: 'not-admitted', reason: 'host-limit' }); } };
  const f = a2Setup(t, { spent: 11_990_000, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  f.setReserved(10_000); // The server keeps admission unavailable without exhausting confirmed spend.
  let finishCredits, finishFeatures, creditReads = 0, featureReads = 0, visible = false;
  const credits = new Promise(resolve => { finishCredits = resolve; }), features = new Promise(resolve => { finishFeatures = resolve; });
  t.after(() => { finishCredits(); finishFeatures(); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/credits')) { creditReads++; await credits; }
    if (String(url) === `/api/sessions/${f.c.session.id}`) { featureReads++; await features; }
    return fetch(url, options);
  });
  t.mock.getter(document, 'visibilityState', () => visible ? 'visible' : 'hidden');
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 0, 'hidden pages do not poll');
  visible = true; t.mock.timers.tick(15_001); await tick(8);
  assert.equal(creditReads, 1); assert.equal(featureReads, 0);
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 1, 'a pending wallet read cannot pile up more requests');
  finishCredits(); await tick(8);
  assert.equal(featureReads, 1, 'an unchanged wallet still refreshes a retained refusal');
  t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 1); assert.equal(featureReads, 1, 'a pending verdict read also bounds recovery polling');
  finishFeatures(); await tick(8);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-used-up'), true, 'an unavailable fresh verdict retains the refusal');
  t.mock.timers.tick(15_001); await tick(8);
  assert.equal(creditReads, 2); assert.equal(featureReads, 2, 'pending recovery can poll again after the previous cycle finishes');
  f.c.remove(); t.mock.timers.tick(45_001); await tick(8);
  assert.equal(creditReads, 2); assert.equal(featureReads, 2, 'detached pages stop polling');
});

test('AIT-135 A2 round 2: a tier-only credits event refreshes features without exhaustion or an admission refusal', async t => {
  let current = 'anonymous';
  const { c, calls } = setup(t, { host: { credits: true }, session: { featureMatrix: { best: { voice: { available: false } } } }, routes: {
    'GET /credits': () => Response.json({ balance, exhausted: false, limitSlot: null, tiers: { current } }),
    'GET ': () => Response.json({ ...c.session, featureMatrix: { best: { voice: { available: current === 'emailGiven' } } } }),
  } }); await tick(8);
  assert.equal(c.session.featureMatrix.best.voice.available, false);
  const before = calls.filter(call => call.path === '').length;
  current = 'emailGiven'; c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.ok(calls.filter(call => call.path === '').length > before, 'a changed tier refreshes even when its ceiling stays the same');
  assert.equal(c.session.featureMatrix.best.voice.available, true);
});

for (const copy of [de, en]) test(`AIT-138 d merge: ${copy.display.locale} exhausted old tab keeps ownership until an explicit take-back after top-up`, async t => {
  const { voiceEvents } = await import('../../core/src/live-voice.js');
  const requests = []; let closes = 0, takeovers = 0;
  const voiceClient = { tabId: 'old-tab', async start(request) {
    requests.push(request); const events = voiceEvents();
    return { callId: request.callId, providerSessionId: 'provider-' + requests.length, epoch: request.epoch ?? 1, tabId: 'old-tab', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
      async close() { closes++; events.end(); return { closureConfirmed: true }; } };
  }, async takeover(identity) {
    takeovers++; assert.equal(identity.epoch, 2);
    return { ...identity, epoch: 3, controllingTabId: 'old-tab', state: 'waiting' };
  } };
  const f = a2Setup(t, { copy, spent: 0, voiceClient }); await tick(8);
  f.root.querySelector('.voice-start').click(); await tick(8);
  const callId = requests[0].callId;
  f.c.receive({ type: 'voice.state', data: {
    callId, providerSessionId: 'other-provider', epoch: 2, controllingTabId: 'other-tab', state: 'active', reason: 'tab-takeover' } });
  assert.equal(f.root.querySelector('.pause').disabled, false);
  f.setSpent(12_000_000);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceStates.usedUp);
  assert.equal(f.root.querySelector('.pause').disabled, true);
  assert.equal(f.root.querySelector('.audio-rail').hasAttribute('data-moved'), true);
  assert.equal(closes, 0, 'the old tab must not close or forget the foreign logical call');
  f.root.querySelector('.pause').click(); await tick(8); assert.equal(takeovers, 0); assert.equal(requests.length, 1);
  f.topUp(); f.c.receive({ seq: f.c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  await new Promise(resolve => setTimeout(resolve, 350)); await tick(8);
  assert.equal(f.root.querySelector('.voice-state').textContent, copy.voiceMoved);
  assert.equal(f.root.querySelector('.pause').disabled, false);
  assert.equal(takeovers, 0, 'top-up alone never takes ownership');
  f.root.querySelector('.pause').click(); await tick(16);
  assert.equal(takeovers, 1); assert.equal(requests.length, 2);
  assert.equal(requests[1].callId, callId); assert.equal(requests[1].epoch, 3);
  assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'listening');
});


