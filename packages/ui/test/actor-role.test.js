import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { reasonSeparator } from '../src/consent-line.js';
import { ActorRole } from '../src/actor-role.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window({ url: 'http://localhost' });
const document = window.document; globalThis.document = document;
after(() => window.happyDOM.close());
const labels = { en: { private: 'Fixture private', company: 'Fixture company', representative: 'Fixture representative', agency: 'Fixture agency' },
  de: { private: 'Fixture privat', company: 'Fixture Firma', representative: 'Fixture Vertretung', agency: 'Fixture Agentur' } };
const initial = { available: true, roles: Object.keys(labels.en), role: 'company', source: 'inferred', reasoning: 'Fixture reasoning', revision: 4 };
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function fixture(t, options = {}) {
  const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<div class="footer-left"></div><div class="host-account"><slot name="account"></slot></div><button class="gear">Settings</button><button class="outside">Outside</button>';
  const session = { locale: options.locale ?? 'en', seq: 4, roleChoice: options.initial ?? initial,
    actor: options.initial?.role === null ? null : { type: 'company', evidence: 'inferred', reasoning: initial.reasoning } };
  const calls = [], pending = Promise.withResolvers(); let view = structuredClone(session.roleChoice);
  const actor = new ActorRole({ root, copy: session.locale === 'de' ? de : en, session: () => session, options: options.options ?? { labels }, settings: options.settings,
    request: async (path, body) => {
      calls.push({ path, body });
      return path === 'identity' ? { ok: true, body: { roleChoice: view } } : pending.promise;
    } });
  t.after(() => { actor.destroy(); host.remove(); });
  return { actor, root, session, calls, pending, view: value => { view = value; }, checked: surface => surface.querySelector('input:checked')?.value };
}
const key = (element, key) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

for (const [locale, copy] of [['de', de], ['en', en]]) {
  test(`AIT-281: ${locale} null role has no inference, unchecked radios and a first roving stop on both surfaces`, async t => {
    const f = fixture(t, { locale, initial: { ...initial, role: null, reasoning: null } });
    f.actor.open(true); await tick();
    assert.equal(f.root.querySelector('.actor-trigger-text').textContent, locale === 'de' ? 'Rolle: noch offen' : 'Role: not set');
    assert.equal(f.root.querySelector('.actor-trigger .actor-spark').hidden, true);
    assert.equal(f.root.querySelector('.actor-trigger .actor-value').hasAttribute('data-unset'), true);
    for (const surface of [f.actor.popover, f.actor.sheet]) {
      assert.equal(surface.querySelector('.actor-why').dataset.kind, 'unset');
      assert.equal(surface.querySelector('.actor-reason').textContent, locale === 'de' ? 'Noch nicht eingeschätzt.' : 'Not assessed yet.');
      assert.equal(surface.querySelector('.actor-reason b'), null);
      assert.equal(surface.querySelector('.actor-why').hasAttribute('title'), false);
      assert.equal(f.checked(surface), undefined);
      assert.deepEqual([...surface.querySelectorAll('input')].map(input => input.tabIndex), [0, -1, -1, -1]);
      assert.equal(surface.querySelector('.actor-status').textContent, copy.actorRole.hint);
    }
    assert.equal(f.root.activeElement, f.actor.popover.querySelector('input'));
    assert.equal(f.calls.filter(call => call.body).length, 0);
    f.session.seq++; f.session.actor = { type: 'company', evidence: 'inferred', reasoning: 'Later fixture inference' };
    f.actor.sync();
    assert.match(f.root.querySelector('.actor-trigger-text').textContent, new RegExp(labels[locale].company, 'u'));
    assert.equal(f.root.querySelector('.actor-trigger .actor-spark').hidden, false);
    assert.equal(f.root.querySelector('.actor-trigger .actor-value').hasAttribute('data-unset'), false);
    assert.equal(f.actor.popover.querySelector('.actor-reason').textContent, copy.actorRole.why+' Later fixture inference');
  });

  for (const phone of [false, true]) test(`AIT-281: ${locale} choosing from null in the ${phone ? 'sheet' : 'popover'} saves as chosen`, async t => {
    const f = fixture(t, { locale, initial: { ...initial, role: null, reasoning: null } });
    const media = window.matchMedia; window.matchMedia = () => ({ matches: phone }); t.after(() => { window.matchMedia = media; });
    if (phone) f.actor.openSheet(f.root.querySelector('.gear')); else f.actor.open(true);
    await tick();
    const surface = phone ? f.actor.sheet : f.actor.popover;
    if (phone) surface.querySelector('input[value=agency]').click();
    else {
      key(f.root.activeElement, 'ArrowLeft');
      assert.equal(f.root.activeElement.value, 'agency'); assert.equal(f.checked(surface), undefined);
      assert.equal(f.calls.filter(call => call.body).length, 0);
      key(f.root.activeElement, 'Enter');
    }
    assert.equal(f.calls.at(-1).body.role, 'agency'); assert.equal(f.calls.at(-1).body.baseRevision, 4);
    assert.equal(f.root.querySelector('.actor-trigger-text').textContent, copy.actorRole.label+': '+copy.actorRole.unset);
    assert.deepEqual([...surface.querySelectorAll('input')].map(input => input.tabIndex), [-1, -1, -1, 0]);
    f.pending.resolve({ ok: true, body: { roleChoice: { ...initial, role: 'agency', source: 'chosen', reasoning: null, revision: 5 } } }); await tick();
    assert.equal(f.checked(surface), 'agency');
    assert.equal(surface.querySelector('.actor-reason').textContent, copy.actorRole.chosen);
    assert.equal(f.root.querySelector('.actor-trigger .actor-spark').hidden, true);
    assert.equal(surface.querySelector('.actor-status').textContent, phone ? '✓ '+copy.actorRole.saved : copy.actorRole.hint);
    assert.equal(phone ? f.actor.sheet.open : f.actor.popover.hidden, true);
  });
}

test('AIT-281: arrows move focus only; Space and Enter confirm, including the inferred checked role', async t => {
  for (const confirm of [' ', 'Enter']) {
    const f = fixture(t); f.actor.open(true); await tick();
    const radios = [...f.actor.popover.querySelectorAll('input')];
    assert.equal(f.root.activeElement, radios[1]);
    key(radios[1], 'ArrowRight'); assert.equal(f.root.activeElement, radios[2]);
    assert.equal(f.checked(f.actor.popover), 'company'); assert.equal(f.calls.filter(c => c.body).length, 0);
    key(radios[2], 'ArrowLeft'); key(radios[1], confirm);
    assert.equal(f.calls.at(-1).body.role, 'company'); assert.equal(f.calls.at(-1).body.baseRevision, 4);
    assert.equal(f.actor.element.dataset.phase, 'saving');
    assert.ok(radios.every(r => r.value === 'company' ? !r.disabled : r.disabled));
    f.pending.resolve({ ok: true, body: { roleChoice: { ...initial, source: 'chosen', revision: 5 } } }); await tick();
    assert.equal(f.actor.popover.hidden, true); assert.equal(f.root.activeElement, f.root.querySelector('.actor-trigger'));
    assert.equal(f.root.querySelector('.actor-trigger .actor-spark').hidden, true);
    assert.ok([...f.root.querySelectorAll('.actor-reservation .actor-spark')].every(marker => !marker.hidden), 'every reservation keeps its marker width');
  }
});

test('AIT-281: saving has no optimistic footer flip; error rechecks and retry keeps its id', async t => {
  const f = fixture(t); f.actor.open(); await tick();
  f.actor.popover.querySelector('input[value=agency]').click();
  assert.match(f.root.querySelector('.actor-trigger-text').textContent, /Fixture company/u);
  assert.equal(f.checked(f.actor.popover), 'agency');
  assert.equal(f.actor.popover.querySelector('[data-pending] input').value, 'agency');
  assert.equal(f.actor.popover.querySelector('.actor-status').textContent, en.actorRole.saving);
  const command = f.calls.at(-1).body;
  f.pending.resolve({ ok: false, status: 500 }); await tick();
  assert.equal(f.actor.popover.hidden, false); assert.equal(f.checked(f.actor.popover), 'company');
  assert.equal(f.actor.popover.querySelector('.actor-status').textContent, en.actorRole.error+reasonSeparator+en.actorRole.retry);
  f.actor.popover.querySelector('.actor-retry').click(); await tick();
  assert.equal(f.calls.at(-1).body.clientEventId, command.clientEventId);
});

test('AIT-281: stale refreshes role and notice without closing', async t => {
  const f = fixture(t); f.actor.open(); await tick();
  const saving = f.actor.choose('agency');
  f.pending.resolve({ ok: false, status: 409, body: { error: 'role-conflict', roleChoice: { ...initial, role: 'representative', source: 'chosen', revision: 6 } } }); await saving;
  assert.equal(f.checked(f.actor.popover), 'representative'); assert.equal(f.actor.popover.hidden, false);
  assert.equal(f.actor.popover.querySelector('.actor-status').textContent, en.actorRole.stale);
  assert.equal(f.actor.popover.querySelector('.actor-reason').textContent, en.actorRole.chosen);
});

test('AIT-281: Esc restores focus; outside click and Tab-out close; chosen role makes no command', async t => {
  const f = fixture(t); f.actor.open(true); await tick();
  key(f.root.activeElement, 'Escape'); assert.equal(f.actor.popover.hidden, true); assert.equal(f.root.activeElement, f.root.querySelector('.actor-trigger'));
  f.actor.open(true); f.root.querySelector('.outside').focus(); assert.equal(f.actor.popover.hidden, true);
  f.actor.open(); f.root.querySelector('.outside').click(); assert.equal(f.actor.popover.hidden, true);
  f.actor.open(true); key(f.root.activeElement, 'Tab');
  f.root.activeElement.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  assert.equal(f.actor.popover.hidden, true, 'Tab into browser chrome also closes');
  f.actor.set({ ...initial, source: 'chosen' }); f.actor.open(); await f.actor.choose('company');
  assert.equal(f.calls.filter(c => c.body).length, 0);
});

test('AIT-281: no labels or capability hides both surfaces, with no product fallback labels', t => {
  for (const options of [{}, { labels: { en: { private: 'Fixture incomplete' } } }]) {
    const f = fixture(t, { options }); assert.equal(f.actor.available, false); assert.equal(f.root.querySelector('.actor-trigger').hidden, true); assert.equal(f.actor.sheet.open, false);
  }
  const f = fixture(t); f.actor.set({ ...initial, available: false });
  assert.equal(f.root.querySelector('.actor-trigger').hidden, true); assert.equal(f.actor.openSheet(f.root.querySelector('.gear')), false);
  assert.equal(f.actor.popover.querySelector('.actor-account').hidden, true);
});

test('AIT-281: phone has only the role sheet, no account, and keeps the saved acknowledgement', async t => {
  const f = fixture(t); const media = window.matchMedia; window.matchMedia = () => ({ matches: true }); t.after(() => { window.matchMedia = media; });
  assert.equal(f.actor.openSheet(f.root.querySelector('.gear')), true); await tick();
  assert.equal(f.actor.sheet.querySelector('[name=account]'), null);
  assert.equal(f.actor.sheet.getAttribute('aria-labelledby'), 'actor-sheet-title');
  assert.equal(f.actor.sheet.querySelector('#actor-sheet-title').textContent, en.settings.title);
  assert.equal(f.actor.popover.hidden, true);
  const saving = f.actor.choose('agency'); f.pending.resolve({ ok: true, body: { roleChoice: { ...initial, role: 'agency', source: 'chosen', revision: 5 } } }); await saving;
  assert.equal(f.actor.sheet.open, true); assert.equal(f.actor.sheet.querySelector('.actor-status').textContent, '✓ '+en.actorRole.saved);
  assert.equal(f.actor.sheet.querySelector('.actor-reason').textContent, en.actorRole.chosen);
  f.session.locale = 'de'; f.actor.setCopy(de); assert.equal(f.actor.sheet.querySelector('.actor-status').textContent, '✓ '+de.actorRole.saved);
});

test('AIT-281: a revoked command capability removes both controls', async t => {
  const f = fixture(t); f.actor.open(); await tick();
  const saving = f.actor.choose('agency');
  f.pending.resolve({ ok: false, status: 503, body: { error: 'role-unavailable' } }); await saving;
  assert.equal(f.actor.available, false); assert.equal(f.actor.popover.hidden, true);
  assert.equal(f.root.querySelector('.actor-trigger').hidden, true);
});

test('AIT-281: account content is exclusively the host slot and returns on capability removal', async t => {
  const f = fixture(t), host = f.root.host;
  const account = document.createElement('span'); account.slot = 'account'; account.textContent = 'Fixture host account'; host.append(account);
  await tick(); f.actor.set(initial);
  assert.equal(f.actor.popover.querySelector('.actor-account').hidden, false);
  assert.equal(f.root.querySelector('slot[name=account]').parentNode.className, 'actor-account');
  assert.equal(f.actor.sheet.querySelector('slot[name=account]'), null);
  f.actor.set({ ...initial, available: false });
  assert.equal(f.root.querySelector('slot[name=account]').parentNode.className, 'host-account');
});

test('AIT-281: clicking the checked inferred radio makes a durable choice', async t => {
  const f = fixture(t); f.actor.open(); await tick();
  f.actor.popover.querySelector('input[value=company]').click();
  assert.equal(f.calls.at(-1).body.role, 'company');
  assert.equal(f.actor.element.dataset.phase, 'saving');
  f.pending.resolve({ ok: true, body: { roleChoice: { ...initial, source: 'chosen', revision: 5 } } }); await tick();
  assert.equal(f.root.querySelector('.actor-trigger .actor-spark').hidden, true);
  assert.ok([...f.root.querySelectorAll('.actor-reservation .actor-spark')].every(marker => !marker.hidden), 'every reservation keeps its marker width');
  assert.equal(f.actor.popover.hidden, true);
});


test('AIT-281: unavailable phone settings retain only AI processing, with no role section', async t => {
  const f = fixture(t), media = window.matchMedia; window.matchMedia = () => ({ matches: true }); t.after(() => { window.matchMedia = media; });
  f.view({ ...initial, available: false }); f.actor.set({ ...initial, available: false });
  assert.equal(f.actor.openSheet(f.root.querySelector('.gear')), true); await tick();
  assert.equal(f.actor.sheet.open, true);
  assert.equal(f.actor.sheet.querySelector('.actor-sheet-section').hidden, true);
  assert.equal(f.root.querySelector('.actor-trigger').hidden, true);
  assert.ok(f.actor.sheet.querySelector('.actor-processing'));
});
