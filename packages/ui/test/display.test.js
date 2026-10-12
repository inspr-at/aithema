import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { MODEL_DISPLAY_NAMES, modelDisplayName, wholeCredits, formatCredits, draftsLine, settingsFlag } from '../src/display.js';
import { ConversationsMenu } from '../src/conversations-menu.js';
import { styles } from '../src/styles.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const globals = (t, window, keys) => {
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
  t.after(() => { for (const key of keys) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key]; } });
};

test('AIT-131 display names: every served id maps to a name, arbitrary ids and prototype keys never reach the UI', () => {
  for (const copy of [de, en]) {
    for (const [id, name] of Object.entries(MODEL_DISPLAY_NAMES)) {
      assert.equal(modelDisplayName(id, copy), copy.catalogLabels?.[name] ?? name);
      assert.doesNotMatch(modelDisplayName(id, copy), /(?:~|[a-z-]+\/)/u);
    }
    for (const id of ['future/provider-route', 'openrouter/alias/anthropic/claude-haiku-latest', '__proto__', 'constructor', undefined, null, '']) {
      assert.equal(modelDisplayName(id, copy), copy.display.modelUnknown);
    }
  }
  assert.equal(modelDisplayName('anthropic/claude-haiku-5.5', de), 'Claude Haiku 5.5');
  assert.equal(modelDisplayName('anthropic/claude-opus-5.5', en), 'Claude Opus 5.5');
  assert.equal(modelDisplayName('~anthropic/claude-haiku-latest', en), 'Claude Haiku', 'an alias never claims a concrete served version');
});

test('AIT-131 drafts line: exactly one sentence/action for off, policy quote and insufficient credits, with unknown quotes closed', () => {
  for (const copy of [de, en]) {
    const off = draftsLine({ copy, feature: { available: false, reason: 'not configured' }, cost: null });
    assert.deepEqual(off, { state: 'off', text: copy.display.draftsOff, action: false });
    assert.deepEqual(draftsLine({ copy, feature: { available: true }, cost: { maxMicro: 400_000 } }),
      { state: 'on', text: copy.display.draftsOn.replace('{credits}', '40'), action: true });
    for (const reason of ['owner credits exhausted', 'spend cap reached', 'Ausgabenlimit für OpenRouter erreicht']) {
      assert.deepEqual(draftsLine({ copy, feature: { available: false, reason }, cost: { maxMicro: 400_000 } }),
        { state: 'low', text: copy.display.draftsLow, action: false });
    }
    for (const cost of [null, {}, { maxMicro: -1 }, { maxMicro: NaN }, { maxMicro: Infinity }]) {
      const line = draftsLine({ copy, feature: { available: true }, cost });
      assert.equal(line.action, false); assert.equal(line.text, copy.display.draftsOff);
      assert.doesNotMatch(line.text, /Kosten unbekannt|Cost unknown/u);
    }
    assert.equal(draftsLine({ copy, feature: { available: true }, cost: { maxMicro: 0 } }).text, copy.display.draftsOn.replace('{credits}', '0'));
    assert.equal(draftsLine({ copy, feature: { available: true }, cost: { maxMicro: 400_001 } }).text, copy.display.draftsOn.replace('{credits}', '41'));
  }
});

test('AIT-131 whole credits: one cent, floor available amounts, localized thousands and bounded invalid values', () => {
  for (const [micro, expected] of [[0, 0], [9999, 0], [10_000, 1], [6_559_999, 655], [10_000_000, 1000], [-1, 0], [NaN, 0], [Infinity, 0], [undefined, 0]]) {
    assert.equal(wholeCredits(micro), expected);
  }
  assert.equal(formatCredits(10_000_000, 'de'), '1.000'); assert.equal(formatCredits(10_000_000, 'en'), '1,000');
  assert.equal(formatCredits(6_550_000, 'de'), '655');
});

test('AIT-131 flags follow START quality, EU, device and self-hosted kinds', () => {
  assert.match(settingsFlag('quality'), /#bd2940/u); assert.match(settingsFlag('eu'), /#0646aa/u);
  for (const kind of ['device', 'selfhosted']) assert.match(settingsFlag(kind), /settings-flag__machine/u);
  assert.notEqual(settingsFlag('device'), settingsFlag('selfhosted'));
});

test('AIT-131 conversations menu: order, arrow/Home/End, Escape focus, Tab exit and browser shortcut preservation', async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  globals(t, window, ['document', 'CustomEvent']);
  const host = window.document.createElement('div'), root = host.attachShadow({ mode: 'open' }); window.document.body.append(host);
  root.innerHTML = '<div class="conversations-wrap"><button class="conversations-toggle"></button><div class="conversations-menu" hidden><button class="conversations-new" role="menuitem"></button><div class="conversations-recent"></div><button class="library-open-dialog" role="menuitem"></button></div></div>';
  const adopted = [], requests = [], managed = [];
  const menu = new ConversationsMenu({ root, copy: de, current: () => 'b', locale: () => 'de', newLocale: () => 'en',
    request: async (path, body) => { requests.push([path, body]); return body ? { ok: true, body: { session: { id: 'next' } } }
      : { ok: true, body: { items: [{ id: 'a', title: 'Älter', updatedAt: '2026-10-11T08:00:00Z' }, { id: 'b', title: 'Aktuell', updatedAt: '2026-10-12T08:00:00Z' }] } }; },
    adopt: (s, reason) => adopted.push([s.id, reason]), manage: opener => managed.push(opener), status: assert.fail });
  t.after(() => menu.destroy());
  const trigger = root.querySelector('.conversations-toggle'), pop = root.querySelector('.conversations-menu');
  assert.equal(trigger.getAttribute('aria-label'), 'Gespräche'); assert.equal(trigger.title, 'Gespräche');
  menu.setCopy(en); assert.equal(trigger.getAttribute('aria-label'), 'Conversations'); assert.equal(trigger.title, 'Conversations'); menu.setCopy(de);
  const key = (target, value, extra = {}) => { const e = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(e); return e; };
  trigger.focus(); key(trigger, 'ArrowDown'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const items = [...pop.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(items.map(n => n.textContent), ['Neues Gespräch', 'Aktuelljetzt', 'Älter11. Okt.', 'Alle Gespräche verwalten']);
  assert.equal(root.activeElement, items[0]); key(items[0], 'ArrowDown'); assert.equal(root.activeElement, items[1]);
  key(items[1], 'End'); assert.equal(root.activeElement, items[3]); key(items[3], 'Home'); assert.equal(root.activeElement, items[0]);
  key(items[0], 'ArrowUp'); assert.equal(root.activeElement, items[3]);
  assert.equal(key(items[3], 'r', { metaKey: true }).defaultPrevented, false);
  assert.equal(key(items[3], 'ArrowDown', { ctrlKey: true }).defaultPrevented, false);
  key(items[3], 'Escape'); assert.equal(pop.hidden, true); assert.equal(root.activeElement, trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  menu.open(); items[0].click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(adopted, [['next', 'new']]); assert.deepEqual(requests.find(([p, b]) => p === '/api/library' && b)?.[1], { locale: 'en' });
  menu.open(); root.querySelector('.library-open-dialog').click(); assert.deepEqual(managed, [trigger]);
  menu.open(); assert.equal(key(root.activeElement, 'Tab').defaultPrevented, false); assert.equal(pop.hidden, true);
});

test('AIT-131 withdraw x: a fixed 44 px target and 20 px glyph, opacity-only reveal, same node through receive()', async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  globals(t, window, ['HTMLElement', 'customElements', 'document', 'CustomEvent']);
  await import('../src/session-element.js');
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: 'de' });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  c.configure({ copy: de, session });
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'user', role: 'user', content: 'Ja.' } });
  const row = c.shadowRoot.querySelector('.turn.user'), x = row.querySelector('.withdraw');
  assert.equal(x.getAttribute('aria-label'), de.display.withdraw); assert.equal(x.title, de.display.withdraw);
  assert.equal(x.textContent, ''); assert.ok(x.querySelector('svg[aria-hidden="true"]'));
  assert.match(styles, /\.withdraw \{[^}]*position:absolute;[^}]*width:44px; height:44px;/u);
  assert.match(styles, /\.withdraw svg \{ width:20px; height:20px;/u);
  assert.match(styles, /@media\(hover:none\) \{ \.turn \.withdraw \{ opacity:\.55;/u);
  c.receive({ seq: 2, type: 'turn.final', data: { id: 'assistant', role: 'assistant', content: 'Danke.', engine: { label: 'provider/raw-route' } } });
  assert.equal(c.shadowRoot.querySelector('.turn.user .withdraw'), x);
  assert.equal(c.shadowRoot.querySelector('.engine-tag'), null); assert.doesNotMatch(c.shadowRoot.textContent, /provider\/raw-route/u);
  assert.equal(c.shadowRoot.querySelector('.turn.user .speaker-name').textContent, 'Sie');
  assert.equal(c.shadowRoot.querySelector('.turn:not(.user) .speaker-name').textContent, 'KI-Assistenz');
  c.remove();
});
