import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
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
  const session = { locale: 'en', seq: 4, roleChoice: initial, actor: { type: 'company', evidence: 'inferred', reasoning: initial.reasoning } };
  const calls = [], pending = Promise.withResolvers(); let view = structuredClone(initial);
  const actor = new ActorRole({ root, copy: en, session: () => session, options: options.options ?? { labels }, settings: options.settings,
    request: async (path, body) => {
      calls.push({ path, body });
      return path === 'identity' ? { ok: true, body: { roleChoice: view } } : pending.promise;
    } });
  t.after(() => { actor.destroy(); host.remove(); });
  return { actor, root, session, calls, pending, view: value => { view = value; }, checked: surface => surface.querySelector('input:checked')?.value };
}
const key = (element, key) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

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
    assert.equal(f.root.querySelector('.actor-spark').hidden, true);
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
  assert.match(f.actor.popover.querySelector('.actor-status').textContent, /Could not be saved · Try again/u);
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
