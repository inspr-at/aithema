// AIT-298: focused unit workers keep cumulative DOM work within the unchanged
// three-minute file deadline under merge-group CPU contention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { hostStyles } from '../src/host-styles.js';
import { HostSurface } from '../src/host-surface.js';
import { window, tick, v, l, h, cr, identity, locked, pending, entry, balance, setup, userTurn, a2Setup, a2Allowances } from './host-surface-helpers.js';

for (const copy of [de, en]) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
  test(`AIT-261: ${reason} disables every conversation control and retains export (${copy === de ? 'de' : 'en'})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { c, root } = setup(t, { copy, host: { credits: true }, voiceClient: {} }); await tick(8); userTurn(c);
    c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason } });
    c.receive({ seq: c.session.seq + 1, type: 'conversation.end-requested', data: { reason, preserveTranscript: true, settleOutstanding: true } });
    await tick(8);
    assert.ok(copy.hostSurface.credits.ended[reason], 'translated terminal copy exists');
    assert.equal(root.querySelector('form.composer').inert, true);
    assert.equal(root.querySelector('.qcard').inert, true);
    assert.equal(root.querySelector('.voice-start').disabled, true);
    assert.equal(root.querySelector('.composer-out__export').getAttribute('aria-hidden'), 'false');
    assert.ok(root.querySelector('.composer-out__export').href.endsWith(`/api/sessions/${c.session.id}/export`));
    assert.equal(c.session.transcript[0].content, 'We need a preorder app.');
    t.mock.timers.tick(15_001); await tick(12);
    assert.equal(root.querySelector('form.composer').inert, true, 'an unrelated credit refresh cannot clear a terminal reason');
  });
}

for (const copy of [de, en]) for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
  test(`AIT-261: reconnecting to saved ${reason} keeps controls disabled and export available (${copy === de ? 'de' : 'en'})`, async t => {
    const { root } = setup(t, { copy, host: { credits: true }, session: { credits: { status: 'ending', endReason: reason } } });
    await tick(8);
    assert.equal(root.querySelector('form.composer').inert, true);
    assert.equal(root.querySelector('.composer-out__body').textContent, copy.hostSurface.credits.ended[reason].body);
    assert.equal(root.querySelector('.composer-out__export').getAttribute('aria-hidden'), 'false');
  });
}

const releaseLimits = {
  de: {
    'one-hour': ['Die Gesprächszeit ist abgelaufen.', 'Ein Gespräch dauert hier höchstens eine Stunde. Ihr Verlauf bleibt gespeichert.', false],
    session: ['Die Credits dieses Gesprächs sind aufgebraucht.', 'Ihr Verlauf bleibt gespeichert.', true],
    voiceVisitor: ['Die Sprach-Credits sind aufgebraucht.', 'Sprechen ist in diesem Gespräch nicht mehr möglich.', true],
    'host-limit': ['Hier sind gerade keine Gespräche möglich.', 'Das Budget dieses Angebots ist ausgeschöpft. Ihr Gespräch bleibt gespeichert.', false],
  },
  en: {
    'one-hour': ['The conversation time has run out.', 'A conversation here lasts at most one hour. Your transcript stays saved.', false],
    session: ['The credits for this conversation are used up.', 'Your transcript stays saved.', true],
    voiceVisitor: ['The voice credits are used up.', 'Speaking is no longer possible in this conversation.', true],
    'host-limit': ['Conversations are not available here right now.', 'The budget for this service is used up. Your conversation stays saved.', false],
  },
};
for (const [locale, copy] of Object.entries({ de, en })) for (const [reason, [title, body, footer]] of Object.entries(releaseLimits[locale])) {
  for (const textAvailable of reason === 'voiceVisitor' ? [true, false] : [true]) {
    test(`AIT-291 ${locale}: ${reason}, text verdict ${textAvailable}, final copy and one announcement`, async t => {
      const { c, root } = setup(t, { copy, host: { credits: true, verification: true }, voiceClient: {},
        session: { featureMatrix: { best: { text: { available: textAvailable }, voice: { available: true } } } },
        routes: { 'GET /credits': () => Response.json({ balance, tiers: { current: 'anonymous', next: reason === 'host-limit' ? null : 'emailGiven',
          delta: 1_000_000, allowancesMicro: { anonymous: 5_000_000, emailGiven: 6_000_000 } } }) } });
      await tick(8); userTurn(c);
      const statusBefore = root.querySelector('.status__label').textContent;
      c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason } });
      await tick(8);
      assert.equal(root.querySelector('.composer-out__title').textContent, title);
      assert.equal(root.querySelector('.composer-out__body').textContent, body);
      const none = root.querySelector('.composer-out__none');
      assert.equal(none.hidden, !footer);
      assert.equal(none.textContent, footer ? copy.hostSurface.usedUp.none : '');
      assert.equal(none.getAttribute('aria-hidden'), String(!footer));
      assert.equal(root.querySelector('.host-credits__next').hidden, !footer);
      const link = root.querySelector('.composer-out__export');
      assert.equal(link.getAttribute('aria-hidden'), 'false');
      assert.equal(link.inert, false);
      assert.equal(link.textContent.trim(), locale === 'de' ? 'Gespräch exportieren' : 'Export conversation');
      assert.ok(link.href.endsWith(`/api/sessions/${c.session.id}/export`));
      if (reason === 'one-hour') {
        const label = locale === 'de' ? 'Zeit abgelaufen' : 'Time up';
        assert.equal(root.querySelector('.voice-state').textContent, label);
        assert.equal(root.querySelector('.composer-reason').textContent, label);
        assert.equal(root.querySelector('.pause').title, label);
        for (const size of ['full', 'short']) assert.equal(root.querySelector(`.host-credits__used-up-${size}`).textContent, label);
      }
      if (reason === 'voiceVisitor') {
        // Even an available raw text verdict cannot bypass the existing terminal host gate.
        assert.equal(root.querySelector('form.composer').inert, true);
        assert.equal(root.querySelector('textarea').disabled, true);
        assert.doesNotMatch(body, /Schreiben geht weiter|keep writing/iu);
      }
      const announcement = root.querySelector('.credit-announcement');
      assert.equal(announcement.getAttribute('aria-live'), 'polite');
      assert.equal(announcement.textContent, `${title} ${body}`);
      assert.equal(root.querySelector('.status__label').textContent, statusBefore);
      assert.equal(root.querySelector('.voice-state').getAttribute('aria-live'), 'off');
      const changes = [];
      const observer = new window.MutationObserver(records => changes.push(...records));
      observer.observe(announcement, { childList: true, characterData: true, subtree: true });
      c.receive({ seq: c.session.seq + 1, type: 'conversation.end-requested', data: { reason } });
      c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason } });
      await tick(8); observer.disconnect();
      assert.equal(changes.length, 0, 'repeated end events do not reannounce');
    });
  }
}


for (const [locale, copy] of Object.entries({ de, en })) for (const variant of ['missing', 'unconfirmed', 'no-next', 'operator-budget']) for (const restored of [false, true]) {
  test(`AIT-291 r2 ${locale}: host-limit ${variant}, restored ${restored} has one announcement and independent upgrade/export`, async t => {
    const next = variant === 'missing' ? 'give' : variant === 'unconfirmed' ? 'confirm' : 'none';
    const { c, root } = a2Setup(t, { copy, delivery: variant === 'unconfirmed',
      address: ['unconfirmed', 'no-next'].includes(variant) ? 'reader@example.test' : null,
      privacy: variant !== 'operator-budget', confirmed: variant === 'no-next', endReason: restored ? 'host-limit' : null });
    const announcement = root.querySelector('.credit-announcement'), changes = [];
    const observer = new window.MutationObserver(records => changes.push(...records));
    observer.observe(announcement, { childList: true, characterData: true, subtree: true });
    await waitForText(root.querySelector('.host-credits__measure-amount'), locale === 'de' ? '2.400' : '2,400'); userTurn(c);
    if (!restored) c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
    const title = next === 'none' ? releaseLimits[locale]['host-limit'][0] : copy.hostSurface.usedUp.title;
    const body = next === 'none' ? releaseLimits[locale]['host-limit'][1] : locale === 'de'
      ? next === 'give' ? 'Mit Ihrer E-Mail-Adresse erhalten Sie +600 weitere Credits. Ihr Gespräch bleibt gespeichert.' : 'Bestätigen Sie Ihre E-Mail-Adresse, dann erhalten Sie +600 weitere Credits.'
      : next === 'give' ? 'Add your email address to get +600 more Credits. Your conversation stays saved.' : 'Confirm your email address to get +600 more Credits.';
    await waitForText(announcement, `${title} ${body}`);
    const out = root.querySelector('.composer-out'), upgrade = out.querySelector('.composer-out__upgrade'), link = out.querySelector('.composer-out__export');
    assert.equal(out.dataset.next, next);
    assert.equal(out.querySelector('.composer-out__title').textContent, title);
    assert.equal(out.querySelector('.composer-out__body').textContent, body);
    assert.equal(upgrade.inert, next === 'none');
    assert.equal(upgrade.getAttribute('aria-hidden'), String(next === 'none'));
    if (next !== 'none') assert.equal(upgrade.querySelector(`[data-next="${next}"]`).textContent, copy.hostSurface.credits[next === 'give' ? 'give' : 'confirm']);
    assert.equal(root.querySelector('.credits-email').hidden, next === 'none', 'tier offer survives host-limit');
    assert.equal(link.inert, false); assert.equal(link.getAttribute('aria-hidden'), 'false');
    assert.equal(link.textContent.trim(), copy.hostSurface.usedUp.export);
    assert.equal(link.hasAttribute('data-next'), false, 'export owns its own slot');
    assert.ok(link.href.endsWith(`/api/sessions/${c.session.id}/export`));
    assert.equal(announcement.getAttribute('aria-live'), 'polite');
    assert.equal(announcement.textContent, `${title} ${body}`);
    assert.equal(changes.length, 1);
    c.receive({ seq: c.session.seq + 1, type: 'conversation.end-requested', data: { reason: 'host-limit' } });
    c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
    await tick(8); observer.disconnect();
    assert.equal(changes.length, 1, 'repeated events cannot announce again');
    if (next !== 'none') {
      upgrade.click(); await tick(6);
      assert.equal(root.querySelector('dialog.settings').open, true);
      assert.equal(root.querySelector('[data-tab="general"]').getAttribute('aria-selected'), 'true');
      if (next === 'give') assert.equal(root.activeElement?.id, 'email-input');
      else assert.ok(root.activeElement?.classList.contains('verify-entry'), 'confirmation entry receives focus');
    }
  });
}

for (const restored of [false, true]) test(`AIT-299: a pre-limit receipt cannot erase host-limit or announce an intermediate title (restored ${restored})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const { c, root } = a2Setup(t, { privacy: false, endReason: restored ? 'host-limit' : null,
    creditsRead: read => { started.resolve(); return pending.promise.then(read); } });
  t.after(() => pending.resolve());
  const announcement = root.querySelector('.credit-announcement'), changes = [];
  const observer = new window.MutationObserver(records => changes.push(...records));
  observer.observe(announcement, { childList: true, characterData: true, subtree: true });
  t.after(() => observer.disconnect());
  await started.promise;
  if (!restored) c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  pending.resolve();
  await waitForText(root.querySelector('.host-credits__measure-amount'), '2,400');
  assert.equal(root.querySelector('.composer-out__title').textContent, releaseLimits.en['host-limit'][0]);
  assert.equal(announcement.textContent, releaseLimits.en['host-limit'].slice(0, 2).join(' '));
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  assert.equal(changes.length, 1, 'only the final host-limit copy is announced');
});

// Wait for the actual DOM acknowledgement; setImmediate counts cannot order a
// receipt's response.json(), SSE events, and MutationObserver delivery under load.
function waitForText(node, text) {
  if (node.textContent === text) return Promise.resolve();
  return new Promise(resolve => {
    const observer = new window.MutationObserver(() => {
      if (node.textContent === text) { observer.disconnect(); resolve(); }
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
  });
}

test('AIT-299: an unchanged post-limit visitor balance cannot recover an operator-budget limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let reads = 0;
  const { c, root } = a2Setup(t, { privacy: false, creditsRead: async read => {
    const receipt = await read().json();
    reads++;
    return Response.json({ ...receipt, reconciling: reads > 1, tiers: { ...receipt.tiers, canConfirm: reads > 1 } });
  } });
  await waitForText(root.querySelector('.host-credits__measure-amount'), '2,400');
  const announcement = root.querySelector('.credit-announcement'), changes = [];
  const observer = new window.MutationObserver(records => changes.push(...records));
  observer.observe(announcement, { childList: true, characterData: true, subtree: true }); t.after(() => observer.disconnect());
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  const button = root.querySelector('.host-credits__button');
  const received = new Promise(resolve => {
    const observer = new window.MutationObserver(() => {
      if (button.getAttribute('aria-description') === cr.reconciling) { observer.disconnect(); resolve(); }
    });
    observer.observe(button, { attributes: true, attributeFilter: ['aria-description'] }); t.after(() => observer.disconnect());
  });
  t.mock.timers.tick(301); await received;
  assert.equal(reads, 2, 'the post-event poll has landed');
  assert.equal(root.querySelector('.composer-out__title').textContent, releaseLimits.en['host-limit'][0]);
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
  assert.equal(announcement.textContent, releaseLimits.en['host-limit'].slice(0, 2).join(' '));
  assert.equal(changes.length, 1, 'the unchanged balance neither clears nor repeats the final announcement');
  c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  assert.equal(root.querySelector('.composer-out').getAttribute('aria-hidden'), 'true', 'a new durable active state can reopen the conversation');
  assert.equal(announcement.textContent, '');
});


for (const refused of [false, true]) test(`AIT-299 r2: releasing a full hold is not an operator-budget recovery signal (host-limit ${refused})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // Exercise the surface directly: the session projection must not mask its retained reason.
  const fixture = setup(t, { host: {} }); await tick(8); fixture.c.remove();
  const element = window.document.createElement('div'), root = element.attachShadow({ mode: 'open' });
  root.innerHTML = fixture.root.innerHTML;
  const session = createSession({ demo: false, locale: 'en' });
  let held = true, ack = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    balance: { owner: { limitMicro: 12_000_000, committedMicro: held ? 12_000_000 : 1_000_000,
      reservedMicro: held ? 12_000_000 : 0, availableMicro: held ? 0 : 11_000_000 } },
    exhausted: false, fullHold: held, reconciling: held, limitSlot: null,
  }));
  const surface = new HostSurface({ root, copy: en, options: { credits: true }, baseUrl: '', session: () => session,
    onCredits: () => ack.resolve() });
  t.after(() => surface.destroy()); surface.connect(); await ack.promise;
  assert.equal(surface.fullHold, true); assert.equal(surface.endReason, null);
  if (refused) surface.receive({ type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  held = false;
  surface.receive({ type: 'turn.final', data: { role: 'assistant' } });
  ack = Promise.withResolvers(); t.mock.timers.tick(301); await ack.promise;
  assert.equal(surface.endReason, refused ? 'host-limit' : null, 'settling a hold says nothing about operator-budget admission');
  if (refused) assert.equal(surface.limitCopy.title, releaseLimits.en['host-limit'][0]);
  else { assert.equal(surface.usedUp, false, 'settlement never shows a host-limit title'); assert.equal(root.querySelector('.host-credits').dataset.ended, 'false'); }
});

test('AIT-299 r3: an explicit exhausted receipt recognises operator-budget recovery without a visitor allowance increase', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fixture = setup(t, { host: {} }); await tick(8); fixture.c.remove();
  const element = window.document.createElement('div'), root = element.attachShadow({ mode: 'open' });
  root.innerHTML = fixture.root.innerHTML;
  const session = createSession({ demo: false, locale: 'en' });
  let exhausted = true, ack = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    // Visitor credit stays positive and unchanged through the operator top-up.
    balance: { owner: { limitMicro: 12_000_000, committedMicro: 1_000_000, availableMicro: 11_000_000 } },
    exhausted, reconciling: false, limitSlot: null,
  }));
  const surface = new HostSurface({ root, copy: en, options: { credits: true }, baseUrl: '', session: () => session,
    onCredits: () => ack.resolve() });
  t.after(() => surface.destroy()); surface.connect(); await ack.promise;
  surface.receive({ type: 'credits.limit-reached', data: { reason: 'host-limit' } });
  assert.equal(surface.endReason, 'host-limit'); assert.equal(surface.usedUp, true);
  exhausted = false;
  surface.receive({ type: 'turn.final', data: { role: 'assistant' } });
  ack = Promise.withResolvers();
  t.mock.timers.tick(301); await ack.promise;
  assert.equal(surface.endReason, null, 'exhausted true-to-false is an authoritative recovery signal');
  assert.equal(surface.usedUp, false);
  assert.equal(root.querySelector('.host-credits').dataset.ended, 'false');
});
