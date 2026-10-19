import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, applyEvent } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { settingsGauges } from '../../core/src/settings.js';
import { manifest as voiceManifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const { hostSettingsGauges } = await import('../src/settings-dialog.js');
test.after(async () => window.happyDOM.close());
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const PRESETS = ['best', 'eu', 'device', 'custom'];
const available = { available: true, reason: null }, refused = reason => ({ available: false, reason });
const facts = (extra = {}) => ({ vendor: 'Mock reasoning', plugin: 'mock', model: 'mock', qualification: 'unverified', processingLocations: ['unverified'],
  streaming: true, structured: true, germanQuality: 'unverified', efforts: ['none', 'low', 'medium', 'high'], operations: ['stream', 'structured'],
  formats: ['text'], cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null }, free: true, ...extra });
const models = [{ id: 'mock', label: 'Mock reasoning', configured: true, efforts: ['none'], effort: 'none', facts: facts(), status: 'available', reason: null },
  { id: 'mock/deep', label: 'Deep (mock)', configured: true, efforts: ['low', 'medium', 'high'], effort: 'medium', facts: facts(), status: 'available', reason: null },
  { id: 'declared', label: 'Declared provider', configured: false, efforts: [], effort: null, facts: facts({ vendor: null, free: false }), status: 'unavailable', reason: 'not configured' }];
const voices = [{ id: 'fake-voice', label: 'Fake voice', configured: true, status: 'available', reason: null,
  facts: facts({ vendor: 'Local simulated agent', capabilities: { sendText: 'native', pause: 'emulated' } }) },
  { id: 'elevenlabs', label: 'ElevenLabs', configured: false, status: 'unavailable', reason: 'not configured', facts: facts({ vendor: null }) }];
const visuals = [{ id: 'fake-images', label: 'Fake images', configured: true, status: 'available', reason: null, facts: facts({ operations: ['generate', 'edit'] }) }];
const engineFor = (preset, settings) => preset === 'device' ? { preset, model: null, effort: null, voice: 'off', visuals: 'off', origin: settings.origin }
  : { preset, origin: settings.origin, effort: settings.effort, model: { id: settings.model, label: [...models].find(m => m.id === settings.model)?.label ?? settings.model, vendor: 'Mock reasoning', offered: true },
    voice: settings.voice === 'off' ? 'off' : { id: settings.voice, label: voices.find(v => v.id === settings.voice)?.label, offered: true },
    visuals: settings.visuals === 'off' ? 'off' : { id: settings.visuals, label: visuals.find(v => v.id === settings.visuals)?.label, offered: true } };
function catalogFor(session) {
  const preset = info => ({ offered: true, status: 'available', reason: null, legacy: false, policy: { residency: null, countries: null, noTraining: false }, ...info });
  return { processingPreset: session.processingPreset, settings: session.settings, engine: session.engine, voiceCallActive: false, presets: {
    best: preset({ defaults: { model: 'mock', effort: 'none', voice: 'fake-voice', visuals: 'off' }, models, voices, visuals }),
    eu: { offered: true, status: 'unavailable', reason: 'not configured' }, device: { offered: true, status: 'available', reason: null },
    custom: preset({ status: 'consent', reason: 'current processing consent required', defaults: { model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off' },
      models: models.slice(0, 2), voices, visuals }) } };
}
function fixture(t, { origin = 'default', model = 'mock', voice = 'fake-voice', turns = 0, voiceClient, deviceConnector, matrix = {}, respond, copy = en, host, identity, loadIdentity, loadCatalog } = {}) {
  let session = createSession({ demo: true });
  if (identity !== undefined) session.identity = identity;
  for (let i = 0; i < turns; i++) session = applyEvent(session, { seq: session.seq + 1, type: 'turn.final', data: { id: `t${i}`, role: 'user', content: 'Hello' } });
  session.settings = { revision: 0, model, effort: 'none', voice, visuals: 'off', origin, at: null };
  session.engine = engineFor('best', session.settings);
  session.featureMatrix = { best: { text: available, analysis: available, voice: available, transcription: refused('not configured'), images: refused('visuals off') },
    eu: { text: refused('not configured'), analysis: refused('not configured') }, custom: { text: refused('current processing consent required') }, ...matrix };
  const c = document.createElement('aithema-session'), posts = [], original = globalThis.fetch;
  // The server's truth: snapshots and catalogs describe it, acknowledgements advance it.
  const server = { session: structuredClone(session), apply(event) {
    this.session = { ...applyEvent(this.session, event), featureMatrix: this.session.featureMatrix };
    if (event.type === 'settings.changed') this.session.engine = engineFor(event.data.processingPreset, event.data.settings);
    return event;
  } };
  const ack = (body, extra = {}) => {
    const current = server.session, settings = { revision: current.settings.revision + 1, model: body.model ?? null, effort: body.effort ?? null,
      voice: body.voice ?? 'off', visuals: body.visuals ?? 'off', origin: 'chosen', at: new Date().toISOString() };
    const event = server.apply({ sessionId: current.id, seq: current.seq + 1, type: 'settings.changed', data: { processingPreset: body.processingPreset, settings } });
    return Response.json({ processingPreset: body.processingPreset, settings, engine: server.session.engine, unchanged: false, event,
      featureMatrix: current.featureMatrix, consent: { required: false, features: [] }, ...extra });
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/identity')) return Response.json({ identity: await loadIdentity?.() ?? null });
    if (String(url).endsWith('/settings') && init.method !== 'POST') return Response.json(await loadCatalog?.(catalogFor(server.session)) ?? catalogFor(server.session));
    if (String(url).endsWith('/settings')) { const body = JSON.parse(init.body); posts.push(body); return respond ? respond(body, posts.length, ack, server) : ack(body); }
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    return Response.json(server.session);
  };
  c.configure({ copy: structuredClone(copy), session, voiceClient, deviceConnector, host });
  // Focus only exists in a connected document; the SSE fetch above never ends.
  document.body.append(c);
  t.after(async () => { c.remove(); await tick(); globalThis.fetch = original; });
  const root = c.shadowRoot, dialog = root.querySelector('dialog.settings');
  const q = selector => dialog.querySelector(selector);
  const option = (name, label) => [...q(`#settings-options-${name}`).querySelectorAll('[role=option]')].find(node => node.querySelector('strong').textContent === label);
  return { c, root, dialog, q, posts, option, ack, server };
}
async function opened(h) { h.c.openSettings(); await tick(); return h; }

for (const [locale, copy] of Object.entries({ de, en })) {
  for (const [reason, text] of [
    ['processing residency unverified', locale === 'de' ? 'Verarbeitungsort nicht geprüft' : 'Processing location not verified'],
    ['processing residency denied', locale === 'de' ? 'Verarbeitungsort nicht erlaubt' : 'Processing location not allowed'],
    ['processing countries missing', locale === 'de' ? 'Verarbeitungsländer fehlen (legal.processingCountries)' : 'Processing countries missing (legal.processingCountries)'],
    ['recipient seat outside eu', locale === 'de' ? 'Empfängersitz außerhalb der EU' : 'Recipient seat outside the EU'],
  ]) {
    test(`AIT-271 ${locale}: unavailable eu preset shows ${reason} without changing the selection`, async t => {
      const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
        catalog.presets.eu = { ...catalog.presets.eu, reason }; return catalog;
      } }));
      const row = h.q('.preset-option[data-preset="eu"]');
      assert.equal(row.getAttribute('aria-disabled'), 'true');
      row.click(); await tick();
      assert.equal(h.q('.context-message').textContent,
        `${locale === 'de' ? 'Nicht verfügbar' : 'Unavailable'}\u00a0· ${text}`);
      assert.equal(h.posts.length, 0, 'unavailable eu never sends a preset change');
      assert.equal(h.c.session.processingPreset, 'best');
    });
  }
}

for (const [locale, copy] of Object.entries({ de, en })) test(`AIT-215 ${locale}: consent help keeps C1 and the safe-choice explanation on hover and focus`, async t => {
  const h = await opened(fixture(t, { copy }));
  const row = h.q('.preset-option[data-preset="custom"]');
  const expected = locale === 'de'
    ? 'Nachrichten brauchen Ihre Einwilligung\u00a0· Sie können diese Option wählen. Sie verarbeitet nichts, bis der Host Ihre Einwilligung dafür hat.'
    : 'Messages need your consent\u00a0· You can choose this option. It processes nothing until the host has your consent for it.';
  row.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(h.q('.context-message').textContent, expected, 'hover');
  row.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
  row.focus();
  assert.equal(h.root.activeElement, row);
  assert.equal(h.q('.context-message').textContent, expected, 'focus');
});

const guestIdentity = { status: 'guest', address: null, verificationRequired: false, assessmentUnlocked: true, pollVerification: false };
const emailHelp = {
  de: 'Allgemein\u00a0· Hier können Sie ein neues Gespräch beginnen, die Einwilligung und Ihre Voreinstellungen prüfen und Ihre E-Mail-Adresse bestätigen.',
  en: 'General\u00a0· Start a new conversation, review consent and your defaults, and confirm your email address.',
};
const generalHelp = {
  de: 'Allgemein\u00a0· Hier können Sie ein neues Gespräch beginnen sowie die Einwilligung und Ihre Voreinstellungen prüfen.',
  en: 'General\u00a0· Start a new conversation, review consent and your defaults.',
};
for (const [locale, copy] of Object.entries({ de, en })) for (const state of ['off', 'guest', 'verification-pending', 'verified']) {
  test(`AIT-147 footer: ${locale}, verification ${state}`, async t => {
    const h = await opened(fixture(t, { copy, host: { verification: state !== 'off' },
      identity: { ...guestIdentity, status: state === 'off' ? 'guest' : state, address: state === 'verification-pending' || state === 'verified' ? 'visitor@example.com' : null } }));
    h.q('[data-tab="general"]').click();
    assert.equal(h.q('.host-verify').hidden, state === 'off');
    const needsVerification = state === 'guest' || state === 'verification-pending';
    if (state !== 'off') assert.equal(h.q('.verify-entry').hidden, !needsVerification);
    assert.equal(h.q('.context-message').textContent, state === 'verified' ? copy.help.generalEmailManage : needsVerification ? emailHelp[locale] : generalHelp[locale]);
  });
}

for (const [locale, copy] of Object.entries({ de, en })) {
  for (const status of ['guest', 'verified']) test(`AIT-147 footer repaint: ${locale}, delayed identity loads ${status} while General is open`, async t => {
    const held = Promise.withResolvers(); t.after(() => held.resolve(null));
    const h = await opened(fixture(t, { copy, host: { verification: true }, identity: null, loadIdentity: () => held.promise }));
    h.q('[data-tab="general"]').click();
    assert.equal(h.q('.host-verify').hidden, true);
    const identity = { ...guestIdentity, status, address: status === 'verified' ? 'visitor@example.com' : null };
    held.resolve(identity); await tick();
    assert.equal(h.dialog.open, true);
    assert.equal(h.q('[data-tab="general"]').getAttribute('aria-selected'), 'true');
    assert.equal(h.q('.host-verify').hidden, false);
    assert.equal(h.q('.verify-entry').hidden, status === 'verified');
    assert.equal(h.q('.context-message').textContent, status === 'guest' ? emailHelp[locale] : copy.help.generalEmailManage);
  });
  test(`AIT-147 footer repaint: ${locale}, identity state changes while General is open`, async t => {
    const h = await opened(fixture(t, { copy, host: { verification: true }, identity: guestIdentity }));
    h.q('[data-tab="general"]').click();
    for (const status of ['verification-pending', 'verified', 'guest', 'erased']) {
      const identity = status === 'erased' ? { erased: true } : { ...guestIdentity, status,
        address: status === 'guest' ? null : 'visitor@example.com' };
      h.c.receive({ sessionId: h.c.session.id, seq: h.c.session.seq + 1, type: 'identity.state', data: identity });
      const needsVerification = status === 'guest' || status === 'verification-pending';
      assert.equal(h.dialog.open, true);
      assert.equal(h.q('[data-tab="general"]').getAttribute('aria-selected'), 'true');
      assert.equal(h.q('.host-verify').hidden, status === 'erased');
      assert.equal(h.q('.verify-entry').hidden, !needsVerification);
      assert.equal(h.q('.context-message').textContent, status === 'verified' ? copy.help.generalEmailManage : needsVerification ? emailHelp[locale] : generalHelp[locale], status);
    }
  });
}

test('AIT-147 footer: an enabled host without an identity port keeps the original hint', async t => {
  const h = await opened(fixture(t, { host: { verification: true }, identity: null }));
  h.q('[data-tab="general"]').click();
  assert.equal(h.q('.host-verify').hidden, true);
  assert.equal(h.q('.context-message').textContent, en.help.general);
});

async function verificationDraft(t, options = {}) {
  const h = await opened(fixture(t, { copy: de, host: { verification: true }, identity: guestIdentity, ...options }));
  h.q('[data-select="model"] .select__button').click(); h.q('#settings-options-model [data-value="mock/deep"]').click(); await tick(6);
  assert.equal(h.c.session.settings.effort, 'medium');
  const effort = h.q('#settings-effort'); effort.value = '2'; effort.dispatchEvent(new window.Event('input', { bubbles: true }));
  h.q('[data-tab="general"]').click();
  assert.equal(h.posts.length, 1, 'the effort change is still inside the autosave debounce');
  assert.equal(h.q('.verify-entry').textContent, 'E-Mail-Adresse bestätigen');
  return h;
}

test('AIT-147 verify: flushes a draft inside the autosave debounce and waits for its acknowledgement', async t => {
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  const h = await verificationDraft(t, { respond: async (body, n, ack) => { if (n === 2) await held.promise; return ack(body); } });
  h.q('.verify-entry').click(); await tick(6);
  assert.equal(h.posts.length, 2, 'verification sends the pending draft before closing Settings');
  assert.equal(h.posts[1].effort, 'high');
  assert.equal(h.dialog.open, true, 'Settings stays open until the host acknowledges the draft');
  assert.equal(h.root.querySelector('dialog.verify-dialog').open, false);
  held.resolve(); await tick(12);
  assert.equal(h.c.session.settings.effort, 'high'); assert.equal(h.server.session.settings.effort, 'high');
  assert.equal(h.dialog.open, false); assert.equal(h.root.querySelector('dialog.verify-dialog').open, true);
  h.root.querySelector('.verify-dialog-close').click(); await tick();
  assert.equal(h.root.activeElement, h.root.querySelector('.settings-open'));
});

test('AIT-147 verify: a failed flush keeps the draft in Settings for retry', async t => {
  const h = await verificationDraft(t, { respond: (body, n, ack) => n === 2 ? new Response(null, { status: 503 }) : ack(body) });
  h.q('.verify-entry').click(); await tick(10);
  assert.equal(h.dialog.open, true); assert.equal(h.root.querySelector('dialog.verify-dialog').open, false);
  assert.equal(h.q('.save-status').textContent, de.settings.failed); assert.equal(h.q('#settings-effort').value, '2');
  h.q('.save-retry').click(); await tick(10);
  assert.equal(h.c.session.settings.effort, 'high');
  h.q('.verify-entry').click(); await tick(6);
  assert.equal(h.dialog.open, false); assert.equal(h.root.querySelector('dialog.verify-dialog').open, true);
});

test('AIT-147 verify: an explicit voice-call notice keeps the unsaved draft in Settings', async t => {
  const events = voiceEvents();
  const call = { callId: 'call', providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async sendText() {},
    async updateContext() {}, async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async close() { events.end(); return { closureConfirmed: true }; } };
  const h = await verificationDraft(t, { voiceClient: { manifest: voiceManifest, async start() { return call; } } });
  h.root.querySelector('.voice-start').click(); await tick(6);
  h.q('.verify-entry').click(); await tick(10);
  assert.equal(h.dialog.open, true); assert.equal(h.root.querySelector('dialog.verify-dialog').open, false);
  assert.equal(h.posts.length, 1); assert.equal(h.q('.notice-body .notice-text').textContent, de.settings.callActive);
  assert.equal(h.q('#settings-effort').value, '2');
});

test('Settings opens a labelled modal on the AI model tab with keyboard tabs and radios; Escape returns focus to the opener', async t => {
  const h = fixture(t), opener = h.root.querySelector('.settings-open');
  opener.click(); await tick();
  assert.equal(h.dialog.open, true); assert.equal(h.dialog.getAttribute('aria-labelledby'), 'settings-title');
  assert.equal(h.root.getElementById('settings-title').textContent, en.settings.title);
  assert.ok(h.root.activeElement === h.q('.done'), 'focus moves into the dialog');
  const tabs = [...h.dialog.querySelectorAll('[role=tab]')];
  assert.deepEqual(tabs.map(tab => [tab.textContent.trim(), tab.getAttribute('aria-selected'), tab.tabIndex]),
    [['General', 'false', -1], ['AI model', 'true', 0], ['Advanced', 'false', -1]]);
  assert.equal(h.q('#settings-panel-model').hidden, false); assert.equal(h.q('#settings-panel-local').hidden, true);
  tabs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true'); assert.ok(h.root.activeElement === tabs[2]); assert.equal(h.q('#settings-panel-local').hidden, false);
  tabs[2].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  tabs[0].click(); tabs[1].click();
  const radios = [...h.dialog.querySelectorAll('[role=radiogroup] [role=radio]')];
  assert.deepEqual(radios.map(r => [r.dataset.preset, r.getAttribute('aria-checked'), r.getAttribute('aria-disabled')]),
    [['best', 'true', 'false'], ['eu', 'false', 'true'], ['device', 'false', 'false'], ['custom', 'false', 'false']]);
  assert.equal(h.q('.presets').getAttribute('aria-label'), en.settings.processing);
  assert.equal(h.q('[data-select="model"] .select__button').getAttribute('aria-haspopup'), 'listbox');
  h.dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.dialog.open, false); assert.ok(h.root.activeElement === opener, 'focus returns to the opener');
  assert.equal(h.posts.length, 0, 'opening and closing never saves');
});

test('Settings menu keyboard navigation, Escape and Tab survive the menu layer', async t => {
  const h = await opened(fixture(t));
  const button = h.q('#settings-select-model'), menu = h.q('#settings-options-model');
  const key = (node, value) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key(button, 'ArrowDown');
  const rows = [...menu.querySelectorAll('[role=option]')];
  assert.equal(menu.hidden, false);
  assert.equal(h.root.activeElement, rows.find(row => row.getAttribute('aria-selected') === 'true'));
  key(h.root.activeElement, 'End');
  assert.equal(h.root.activeElement, rows.at(-1));
  key(h.root.activeElement, 'Home');
  assert.equal(h.root.activeElement, rows[0]);
  key(h.root.activeElement, 'ArrowDown');
  assert.equal(h.root.activeElement, rows[1]);
  key(h.root.activeElement, 'Escape');
  assert.equal(menu.hidden, true);
  assert.equal(h.root.activeElement, button);
  assert.equal(h.dialog.open, true, 'Escape closes the menu before the dialog');
  button.click(); key(menu.querySelector('[role=option]'), 'Tab');
  assert.equal(menu.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(h.posts.length, 0, 'navigation never saves a setting');
});

test('choosing a model sends ids only and the panel shows the new choice only after the server acknowledges it', async t => {
  const held = Promise.withResolvers();
  const h = await opened(fixture(t, { respond: async (body, n, ack) => { await held.promise; return ack(body); } }));
  const button = h.q('[data-select="model"] .select__button');
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true'); assert.equal(h.q('#settings-options-model').hidden, false);
  const declared = h.option('model', en.display.modelUnknown);
  assert.equal(declared.getAttribute('aria-disabled'), 'true'); assert.equal(declared.querySelector('.option-status').textContent, en.settings.unavailable);
  declared.click(); await tick();
  assert.equal(h.posts.length, 0, 'an unavailable option is never sent');
  assert.equal(h.q('.context-message').textContent, `Unavailable\u00a0· ${en.reasons['not configured']}`);
  button.click(); h.option('model', 'Demo only: thorough replies').click(); await tick();
  assert.deepEqual(h.posts, [{ processingPreset: 'best', model: 'mock/deep', effort: 'medium', voice: 'fake-voice', visuals: 'off', baseRevision: 0, confirm: true }]);
  assert.match(h.root.querySelector('.engine__detail').textContent, /Replies: Demo only: sample replies/, 'the panel still shows the acknowledged choice');
  assert.equal(h.q('.save-status').textContent, en.settings.saving); assert.equal(h.dialog.getAttribute('aria-busy'), 'true');
  held.resolve(); await tick(6);
  assert.match(h.root.querySelector('.engine__detail').textContent, /Replies: Demo only: thorough replies/);
  assert.equal(h.c.session.settings.model, 'mock/deep'); assert.equal(h.c.session.settings.origin, 'chosen');
  assert.equal(h.q('.save-status').textContent, en.settings.saved); assert.equal(h.dialog.dataset.saveState, 'saved');
  const effort = h.q('#settings-effort');
  assert.equal(effort.disabled, false); assert.equal(effort.max, '2'); assert.equal(effort.getAttribute('aria-valuetext'), 'Medium');
  effort.value = '2'; effort.dispatchEvent(new window.Event('input', { bubbles: true })); effort.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(6);
  assert.deepEqual(h.posts.at(-1), { processingPreset: 'best', model: 'mock/deep', effort: 'high', voice: 'fake-voice', visuals: 'off', baseRevision: 1, confirm: true });
  h.q('.done').click(); await tick(); assert.equal(h.dialog.open, false);
});

test('a failed save keeps the dialog open with Try again, which resends the same choice', async t => {
  const h = await opened(fixture(t, { respond: (body, n, ack) => n === 1 ? new Response(null, { status: 503 }) : ack(body) }));
  h.q('[data-select="visuals"] .select__button').click(); h.option('visuals', 'Fake images').click(); await tick(6);
  assert.equal(h.q('.save-status').textContent, en.settings.failed); assert.equal(h.q('.save-retry').dataset.visible, 'true');
  assert.equal(h.dialog.dataset.saveState, 'failed'); assert.equal(h.c.session.settings.visuals, 'off');
  h.q('.done').click(); await tick(); assert.equal(h.dialog.open, true, 'Done never discards a failed change silently');
  h.q('.save-retry').click(); await tick(6);
  assert.deepEqual(h.posts[1], h.posts[0]); assert.equal(h.c.session.settings.visuals, 'fake-images');
  assert.equal(h.q('.save-retry').dataset.visible, 'false');
  h.q('.done').click(); await tick(); assert.equal(h.dialog.open, false);
});

test('host refusals and conflicts never retry: the acknowledged choice stays and the reason is shown', async t => {
  let deliver;
  const h = await opened(fixture(t, { respond: (body, n, ack, server) => {
    if (n === 1) return Response.json({ error: 'setting-not-allowed', field: 'model', reason: 'model not offered' }, { status: 409 });
    // Another window saved first; its event reaches this one while the stale write is refused.
    const settings = { revision: 1, model: 'mock/deep', effort: 'low', voice: 'off', visuals: 'off', origin: 'chosen', at: new Date().toISOString() };
    deliver(server.apply({ sessionId: server.session.id, seq: server.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings } }));
    return Response.json({ error: 'settings-conflict', processingPreset: 'best', settings }, { status: 409 });
  } }));
  deliver = event => h.c.receive(event);
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); await tick(6);
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.notAllowed.replace('{reason}', en.reasons['model not offered']));
  assert.equal(h.q('[data-select="model"] .select__value').textContent, 'Demo only: sample replies'); assert.equal(h.q('.save-retry').dataset.visible, 'false');
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); await tick(6);
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.conflict);
  assert.equal(h.q('[data-select="model"] .select__value').textContent, 'Demo only: thorough replies', 'the saved choice from the other window is shown');
  assert.equal(h.posts.length, 2);
});

test('a running voice call keeps its choice until the visitor explicitly ends it and applies the change', async t => {
  const events = voiceEvents(), closed = [];
  const call = { callId: 'call', providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async sendText() {},
    async updateContext() {}, async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async close() { closed.push(true); events.end(); return { closureConfirmed: true }; } };
  const h = fixture(t, { origin: 'chosen', voiceClient: { manifest: voiceManifest, async start() { return call; } } });
  h.root.querySelector('.voice-start').click(); await tick(6);
  assert.ok(h.root.querySelector('.voice-close').disabled === false, 'the call is running');
  await opened(h);
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); await tick(6);
  assert.equal(h.posts.length, 0, 'no change is sent while the call runs');
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.callActive);
  const tallest = [en.settings.callActive, en.settings.toDevice, en.settings.fromDevice, en.settings.consentRequired, en.settings.running,
    en.settings.conflict, en.settings.notAllowed.replace('{reason}', '')].reduce((a, b) => b.length > a.length ? b : a);
  assert.equal(h.q('.notice-measure .notice-text').textContent, tallest, 'AIT-245: the hidden measurement copy keeps the tallest notice');
  assert.equal(h.q('.notice-body .notice-action').textContent, en.settings.endCallApply); assert.equal(h.q('.notice-body .notice-action').hidden, false);
  h.q('.notice-body .notice-action').click(); await tick(10);
  assert.equal(closed.length, 1, 'the visitor ends the call explicitly');
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].model, 'mock/deep'); assert.equal(h.c.session.settings.model, 'mock/deep');
});

test('a choice that needs consent is saved and the host is asked for consent outside the modal', async t => {
  const h = await opened(fixture(t, { respond: (body, n, ack) => ack(body, { consent: { required: true, features: ['text', 'analysis'] } }) }));
  let asked; h.c.addEventListener('aithema-consent', event => { asked = event.detail; });
  h.q('.preset-option[data-preset="custom"]').click(); await tick(6);
  assert.deepEqual(h.posts[0], { processingPreset: 'custom', model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off', baseRevision: 0, confirm: true });
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.consentRequired);
  h.q('.notice-body .notice-action').click(); await tick();
  assert.equal(h.dialog.open, false, 'the host consent interface is outside the modal');
  assert.deepEqual(asked, { sessionId: h.c.session.id, reason: 'settings', features: ['text', 'analysis'] });
});

test('crossing the device boundary in a started conversation starts a new conversation only on explicit action', async t => {
  const h = await opened(fixture(t, { turns: 1 }));
  let requested; h.c.addEventListener('aithema-new-conversation', event => { requested = event.detail; });
  h.q('.preset-option[data-preset="device"]').click(); await tick(6);
  assert.equal(h.posts.length, 0);
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.toDevice); assert.equal(h.q('.notice-body .notice-action').textContent, en.settings.startDevice);
  assert.equal(h.q('[data-select="voice"] .select__button').getAttribute('aria-disabled'), 'true', 'device keeps voice unavailable');
  h.q('.notice-body .notice-action').click(); await tick();
  assert.deepEqual(requested, { processingPreset: 'device', settings: {}, previousSessionId: h.c.session.id, confirm: true });
  assert.equal(h.dialog.open, false);
});

test('gauges are computed from the catalog facts of the draft and explain themselves in the help line', async t => {
  const h = await opened(fixture(t));
  const value = kind => h.q(`[data-gauge="${kind}"] .gauge__value`).textContent;
  assert.deepEqual(['quality', 'speed', 'cost', 'privacy', 'voice', 'images'].map(value), ['Unverified', '5/5', 'None', 'Unverified', 'Unverified', 'Off']);
  assert.equal(h.q('[data-gauge="speed"] .gauge__level').style.getPropertyValue('--empty'), '0%');
  assert.equal(h.q('[data-gauge="voice"] .gauge__level').style.getPropertyValue('--empty'), '25%', 'one native and one emulated capability');
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); await tick(6);
  assert.equal(value('speed'), '4/5');
  h.q('[data-select="voice"] .select__button').click(); h.option('voice', en.settings.voiceOff).click(); await tick(6);
  assert.equal(value('voice'), 'Off');
  const quality = h.q('[data-gauge="quality"]');
  quality.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(h.q('.context-message').textContent, 'AI quality\u00a0· Unverified: The plugin manifest marks this model unverified');
  assert.match(quality.getAttribute('aria-label'), /^AI quality: Unverified, /);
});

for (const [locale, copy] of Object.entries({ de, en })) for (const host of [false, true]) {
  test(`AIT-262 ${locale}: gauge captions and help ${host ? 'use host summaries' : 'keep manifest fallback'}`, async t => {
    const summary = host ? { hostQualified: true, hostCountries: ['FR', 'US'], hostTraining: false, hostPriceReviewed: true } : {};
    const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
      const result = structuredClone(catalog), preset = result.presets.best;
      preset.models[0].facts = facts({ free: false, ...summary });
      preset.defaults.voice = 'off';
      result.settings.voice = 'off';
      return result;
    } }));
    for (const [kind, state, short, detail] of [
      ['quality', host ? 'hostQualified' : 'unverified', host ? copy.gauges.short.quality.hostQualified : copy.gauges.short.quality.unverified,
        host ? copy.gauges.details.quality.hostQualified : copy.gauges.details.quality.unverified],
      ['cost', host ? 'hostPriceReviewed' : 'unverified', host ? copy.gauges.short.cost.hostPriceReviewed : copy.gauges.short.cost.unverified,
        host ? copy.gauges.details.cost.hostPriceReviewed : copy.gauges.details.cost.unverified],
      ['privacy', host ? 'hostCountries' : 'unverified', host ? copy.gauges.short.privacy.hostCountries.replace('{countries}', locale === 'de' ? 'Frankreich und USA' : 'France and the US') : copy.gauges.short.privacy.unverified,
        host ? copy.gauges.details.privacy.hostCountries.replace('{countries}', locale === 'de' ? 'Frankreich und USA' : 'France and the US') : copy.gauges.details.privacy.unverified],
    ]) {
      const gauge = h.q(`[data-gauge="${kind}"]`);
      assert.equal(gauge.dataset.state, state);
      assert.equal(gauge.querySelector('.gauge__value').textContent, state === 'hostCountries' ? (locale === 'de' ? 'Frankreich, USA' : 'France, US') : copy.gauges.values[state]);
      assert.equal(gauge.querySelector('.gauge__detail').textContent, short);
      assert.ok(gauge.getAttribute('aria-label').endsWith(detail));
      gauge.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
      assert.ok(h.q('.context-message').textContent.endsWith(detail));
    }
  });
}

test('AIT-262 host summaries preserve ratings, free/device states and the least private selected lane', () => {
  const model = { facts: facts({ free: false, hostQualified: true, hostCountries: ['FR'], hostTraining: true, hostPriceReviewed: true }) };
  const input = { preset: 'best', model, effort: 'none' };
  assert.deepEqual(hostSettingsGauges(input).cost, { state: 'hostPriceReviewed', fill: 0 }, 'a boolean cannot set a relative price level');
  assert.equal(hostSettingsGauges(input).privacy.state, 'hostCountries', 'EU countries alone do not claim no training');
  assert.equal(hostSettingsGauges({ ...input, voice: { facts: facts({ free: false }) } }).cost.state, 'unverified');
  assert.equal(hostSettingsGauges({ ...input, voice: { facts: facts() } }).privacy.state, 'unverified');
  assert.equal(hostSettingsGauges({ ...input, visuals: { facts: facts({ processingLocations: ['US'] }) } }).privacy.state, 'declared');
  assert.deepEqual(hostSettingsGauges({ ...input, voice: { facts: facts({ hostCountries: ['DE', 'FR'] }) } }).privacy.countries, ['FR', 'DE']);
  model.facts.free = true;
  assert.equal(hostSettingsGauges(input).cost.state, 'free');
  assert.equal(hostSettingsGauges({ ...input, preset: 'device' }).quality.state, 'local');
  model.facts.quality = { score: 80, source: { name: 'Fixture', url: 'https://example.test/rating', asOf: '2026-10-16' } };
  assert.equal(hostSettingsGauges(input).quality.state, 'rated');
});

for (const lane of ['model', 'voice', 'visuals']) {
  test(`AIT-262 host countries preserve the stronger EU policy for ${lane}`, () => {
    const input = { preset: 'eu', info: { policy: { residency: 'eu', countries: null, noTraining: true } },
      model: { facts: facts() }, voice: { facts: facts() }, visuals: { facts: facts() } };
    input[lane].facts.hostCountries = ['FR'];
    assert.deepEqual(hostSettingsGauges(input).privacy, { state: 'eu', fill: 70, enforced: true, countries: null });
  });
  for (const preset of ['best', 'custom']) test(`AIT-262 host countries strengthen ${preset} privacy for ${lane}`, () => {
    for (const processingLocations of [['unverified'], ['US']]) {
      const input = { preset, [lane]: { facts: facts({ processingLocations, hostCountries: ['FR'] }) } };
      assert.deepEqual(hostSettingsGauges(input).privacy, { state: 'hostCountries', fill: 55, enforced: false, countries: ['FR'] });
    }
  });
}

test('AIT-262 host countries preserve stronger manifest privacy', () => {
  for (const processingLocations of [['EU'], ['device']]) {
    const input = { preset: 'best', model: { facts: facts({ processingLocations, hostCountries: ['FR'] }) } };
    assert.deepEqual(hostSettingsGauges(input).privacy, settingsGauges(input).privacy);
  }
});

test('AIT-262 without host countries all base gauges stay unchanged', () => {
  for (const preset of PRESETS) for (const hostCountries of [undefined, []]) {
    const input = { preset, info: { policy: { residency: preset === 'eu' ? 'eu' : null, countries: null, noTraining: preset === 'eu' } },
      model: { facts: facts({ hostCountries }) }, voice: { facts: facts() }, visuals: { facts: facts() }, effort: 'none' };
    assert.deepEqual(hostSettingsGauges(input), settingsGauges(input));
  }
});

const countryCopy = {
  de: { single: 'USA', pair: 'USA und Irland', other: 'Irland',
    short: 'Sitz der Anbieter',
    detail: countries => `Die Anbieter, die Ihre Eingaben erhalten, haben ihren Sitz in ${countries}. Wo verarbeitet wird, kann davon abweichen; Details stehen in der Datenschutzerklärung.`,
    policy: 'Datenschutzerklärung' },
  en: { single: 'the US', pair: 'the US and Ireland', other: 'Ireland',
    short: 'Providers’ seat',
    detail: countries => `The providers that receive your input are based in ${countries}. Processing may take place elsewhere; see the privacy policy for details.`,
    policy: 'privacy policy' },
};
for (const [locale, copy] of Object.entries({ de, en })) {
  for (const countries of [['US'], ['US', 'IE'], ['IE']]) for (const privacyLink of ['none', 'wrapped', 'direct']) {
    test(`AIT-270 ${locale}: provider seats ${countries} with ${privacyLink} privacy link`, async t => {
      const h = fixture(t, { copy, loadCatalog(catalog) {
        catalog.settings.voice = 'off';
        catalog.presets.best.models[0].facts = facts({ hostCountries: countries, hostTraining: true });
        return catalog;
      } });
      // Labels and URL names are deliberately unrelated to privacy: only the marker counts.
      h.c.innerHTML = '<a slot="legal" href="/wrong">Privacy / Datenschutz</a>';
      if (privacyLink !== 'none') {
        const link = '<a data-aithema-privacy href="https://host.example.test/legal?lang=' + locale + '" target="_blank">Host terms</a>';
        h.c.insertAdjacentHTML('beforeend', privacyLink === 'direct' ? link.replace('<a ', '<a slot="legal" ') : '<nav slot="legal">' + link + '</nav>');
      }
      await opened(h);
      const gauge = h.q('[data-gauge="privacy"]'), expected = countryCopy[locale];
      const names = countries.length === 2 ? expected.pair : countries[0] === 'US' ? expected.single : expected.other;
      assert.equal(gauge.dataset.state, 'hostCountries');
      assert.equal(gauge.querySelector('.gauge__detail').textContent, expected.short);
      assert.ok(gauge.getAttribute('aria-label').endsWith(expected.detail(names)));
      assert.doesNotMatch(gauge.textContent + gauge.getAttribute('aria-label'), /beschränkt auf|restricted to|limited to|ohne Training|without training|no training/iu);
      gauge.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
      const message = h.q('.context-message');
      assert.ok(message.textContent.endsWith(expected.detail(names)));
      const link = message.querySelector('a');
      assert.equal(Boolean(link), privacyLink !== 'none');
      if (link) {
        assert.equal(link.textContent, expected.policy);
        assert.equal(link.href, `https://host.example.test/legal?lang=${locale}`);
        assert.equal(link.target, '_blank'); assert.ok(link.rel.includes('noopener'));
        gauge.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
        assert.equal(message.querySelector('a'), link, 'the link survives moving from the gauge to the help line');
        link.focus();
        assert.equal(h.root.activeElement, link, 'rendering help keeps the focused link');
      } else assert.ok(message.textContent.includes(expected.policy));
    });
  }
  test(`AIT-270 ${locale}: enforced restrictions and the EU preset keep their wording`, async t => {
    for (const [policy, state, countries] of [[{ countries: ['US'] }, 'restricted', ['US']],
      [{ residency: 'eu', noTraining: true }, 'eu', null]]) {
      const input = { preset: state === 'eu' ? 'eu' : 'custom', info: { policy }, model: { facts: facts({ hostCountries: ['IE'] }) } };
      assert.deepEqual(hostSettingsGauges(input).privacy, { state, fill: state === 'eu' ? 70 : 55, enforced: true, countries });
    }
    const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
      catalog.settings.voice = 'off';
      catalog.presets.best.policy = { residency: 'eu', noTraining: true };
      catalog.presets.best.models[0].facts = facts({ hostCountries: ['US'], hostTraining: false });
      return catalog;
    } }));
    const gauge = h.q('[data-gauge="privacy"]');
    assert.equal(gauge.dataset.state, 'eu');
    assert.equal(gauge.querySelector('.gauge__detail').textContent, copy.gauges.short.privacy.eu);
    assert.ok(gauge.getAttribute('aria-label').endsWith(copy.gauges.details.privacy.eu));
  });
  for (const lane of ['model', 'voice', 'visuals']) for (const countries of [['US'], ['FR']]) {
    test(`AIT-270 ${locale}: training:true for ${lane} in ${countries} never claims no training`, () => {
      for (const processingLocations of [['unverified'], ['EU']]) for (const policy of [undefined, { residency: 'eu' }]) {
        const input = { preset: 'best', info: { policy }, [lane]: { facts: facts({ processingLocations, hostTraining: true, hostCountries: countries }) } };
        const gauge = hostSettingsGauges(input).privacy;
        assert.equal(gauge.state, 'hostCountries');
        assert.doesNotMatch(copy.gauges.short.privacy[gauge.state] + copy.gauges.details.privacy[gauge.state], /ohne Training|without training|no training/iu);
      }
    });
  }
}
test('AIT-270 privacy links require a legal-slot marker and a web URL', async t => {
  const h = fixture(t, { loadCatalog(catalog) {
    catalog.settings.voice = 'off'; catalog.presets.best.models[0].facts = facts({ hostCountries: ['US'] }); return catalog;
  } });
  h.c.innerHTML = '<a data-aithema-privacy href="https://wrong.example.test/">Outside legal slot</a><a slot="legal" data-aithema-privacy href="javascript:alert(1)">Invalid</a>';
  await opened(h);
  h.q('[data-gauge="privacy"]').dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(h.q('.context-message a'), null);
});

test('hover, focus and saves change text in fixed boxes only: no control moves under the pointer', async t => {
  const h = await opened(fixture(t));
  const context = h.q('.context-text');
  assert.equal(context.querySelectorAll('.context-measure').length, Object.keys(en.help).length, 'the help box reserves its tallest text');
  assert.ok(h.q('.notice-measure'), 'the notice box reserves its tallest notice');
  const effortArea = h.q('.effort-area');
  assert.equal(effortArea.children.length, 2); assert.equal(h.q('.effort').style.visibility, 'hidden'); assert.equal(h.q('.effort-note').style.visibility, '');
  const before = [...h.dialog.querySelectorAll('button, input')];
  const frame = () => h.dialog.innerHTML.replace(/<p class="context-message"[^>]*>.*?<\/p>/u, '');
  const snapshot = frame();
  for (const node of [h.q('.preset-option[data-preset="custom"]'), h.q('[data-select="voice"] .select__button'), h.q('[data-gauge="cost"]')]) {
    node.dispatchEvent(new window.Event('pointerover', { bubbles: true })); node.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
  }
  assert.equal(frame(), snapshot, 'hovering changes only the help text');
  const after = [...h.dialog.querySelectorAll('button, input')];
  assert.ok(after.length === before.length && after.every((node, i) => node === before[i]), 'no control is replaced');
  const css = h.root.querySelector('style').textContent;
  assert.match(css, /dialog\.settings \{[^}]*height:min\(47rem, calc\(100dvh - 1rem\)\)/u, 'a fixed dialog box');
  assert.match(css, /\.select__menu \{ position:absolute/u, 'menus overlay instead of pushing content');
  assert.match(css, /\.gauge__level \{[^}]*transform:translateY\(var\(--empty,100%\)\)/u, 'gauges move liquid, not layout');
  assert.match(css, /@media\(max-width:40rem\) \{\s*dialog\.settings \{ width:calc\(100vw - \.5rem\); height:calc\(100dvh - \.5rem\)/u, 'the dialog fills a 400px viewport');
  assert.match(css, /\.save-retry\[data-visible=false\] \{ visibility:hidden; \}/u, 'Try again keeps its place');
});

test('the conversation starts with the preset chooser, then the acknowledged ready card', async t => {
  // A host voice client: the ready card offers speaking (AIT-128), and nothing starts it before the explicit start.
  const starts = [];
  const h = fixture(t, { voiceClient: { manifest: voiceManifest, async start() { starts.push('start'); throw new Error('unused'); } } });
  let root = h.root, cards = () => [...root.querySelectorAll('.chooser-option')];
  assert.equal(root.querySelector('.intro').dataset.mode, 'chooser');
  assert.equal(root.querySelector('.audio-rail').inert, true, 'rails wait for a choice');
  assert.deepEqual(cards().map(card => [card.querySelector('strong').textContent, card.getAttribute('aria-pressed'), card.getAttribute('aria-disabled')]),
    [['Best models', 'true', 'false'], ['In the EU', 'false', 'true'], ['On my device', 'false', 'false'], ['Custom', 'false', 'false']]);
  cards()[1].click(); await tick();
  assert.equal(root.querySelector('.chooser__error').textContent, `In the EU: ${en.reasons['not configured']}`); assert.equal(h.posts.length, 0);
  cards()[2].click(); await tick();
  assert.equal(cards()[2].getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('.chooser__summary [role=status]').textContent, en.chooser.summary.device);
  cards()[0].click(); root.querySelector('.chooser__continue').click(); await tick(6);
  assert.deepEqual(h.posts, [{ processingPreset: 'best', baseRevision: 0, confirm: true, model: 'mock', effort: 'none', voice: 'fake-voice', visuals: 'off' }]);
  assert.equal(root.querySelector('.intro').dataset.mode, 'ready'); assert.equal(root.querySelector('.audio-rail').inert, true, 'the call waits for the explicit start');
  const rows = Object.fromEntries([...root.querySelectorAll('.ready__row')].map(row => [row.dataset.ready, [row.querySelector('dd').textContent.replace('✓', ''), row.dataset.state]]));
  assert.deepEqual(rows, { model: ['Demo only: sample replies', 'selected'], consent: [en.ready.granted, 'confirmed'], microphone: [en.ready.checkOnStart, 'pending'],
    speaker: [en.ready.onOnStart, 'selected'], visuals: [en.ready.off, 'off'] });
  assert.deepEqual(starts, [], 'the ready card starts no call');
  h.c.receive({ seq: h.c.session.seq + 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'Hello' } });
  assert.equal(root.querySelector('.intro').hidden, true, 'the first message replaces the start screen');
});

test('AIT-237: unchanged entrance confirmation is chosen and remains ready after reconfiguration', async t => {
  const h = fixture(t);
  h.root.querySelector('.chooser__continue').click(); await tick(6);
  assert.equal(h.posts[0].confirm, true);
  assert.equal(h.c.session.settings.origin, 'chosen');
  assert.equal(h.c.session.settings.revision, 1);
  assert.equal(h.root.querySelector('.intro').dataset.mode, 'ready');
  assert.equal(h.root.activeElement, h.root.querySelector('.ready__start'));
  h.c.configure({ copy: en, session: structuredClone(h.server.session) });
  assert.equal(h.root.querySelector('.intro').dataset.mode, 'ready', 'the durable confirmation survives the consent return');
});

for (const action of ['reopen', 'navigate', 'tab', 'edit']) test(`AIT-237: held Done confirmation cannot close Settings after ${action}`, async t => {
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  const h = await opened(fixture(t, { respond: async (body, n, ack) => { if (n === 1) await held.promise; return ack(body); } }));
  h.q('.done').click(); await tick();
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].confirm, true);
  assert.equal(h.dialog.open, true, 'Done waits for its save');
  if (action === 'reopen') {
    h.dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(h.dialog.open, false);
    h.c.openSettings();
  } else if (action === 'navigate') h.c.openSettings(undefined, { tab: 'general', anchor: '.general-new' });
  else if (action === 'tab') h.q('[data-tab=general]').click();
  else { h.q('[data-select=model] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); }
  const body = h.q('.settings__body'); body.scrollTop = 123;
  held.resolve(); await tick(12);
  assert.equal(h.c.session.settings.origin, 'chosen', 'the explicit confirmation is still durable');
  assert.equal(h.dialog.open, true, 'the earlier Done cannot dismiss the later interaction');
  assert.equal(body.scrollTop, 123);
  h.q('.done').click(); await tick(6);
  assert.equal(h.dialog.open, false, 'a fresh Done can close the current dialog');
});

for (const debounce of [false, true]) test(`AIT-237: Done awaiting ${debounce ? 'debounced' : 'in-flight'} edits cannot close reopened Settings`, async t => {
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  const h = await opened(fixture(t, { origin: 'chosen', respond: async (body, n, ack) => { if (n === (debounce ? 2 : 1)) await held.promise; return ack(body); } }));
  h.q('[data-select=model] .select__button').click(); h.option('model', 'Demo only: thorough replies').click(); await tick();
  if (debounce) { const effort = h.q('#settings-effort'); effort.value = '2'; effort.dispatchEvent(new window.Event('input', { bubbles: true })); }
  h.q('.done').click(); await tick();
  assert.equal(h.dialog.getAttribute('aria-busy'), 'true');
  h.dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  h.c.openSettings();
  const body = h.q('.settings__body'); body.scrollTop = 123;
  held.resolve(); await tick(12);
  assert.equal(h.dialog.open, true, 'Done belongs to the dismissed dialog');
  assert.equal(body.scrollTop, 123);
});

test('AIT-237: Settings Done explicitly confirms unchanged defaults', async t => {
  const h = await opened(fixture(t));
  assert.equal(h.posts.length, 0);
  h.q('.done').click(); await tick(6);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].confirm, true);
  assert.equal(h.c.session.settings.origin, 'chosen');
  assert.equal(h.dialog.open, false);
  assert.equal(h.root.querySelector('.intro').dataset.mode, 'ready');
});

for (const copy of [de, en]) test(`AIT-237 ${copy.display.locale}: drafts off action opens Settings at visuals without saving`, async t => {
  const h = fixture(t, { copy });
  const line = h.root.querySelector('.concept-activity-text');
  assert.equal(line.textContent, `${copy.display.draftsDisabled}\u00a0· ${copy.display.draftsEnable}`);
  const action = line.querySelector('.consent-action'); action.click(); await tick();
  assert.equal(h.dialog.open, true);
  assert.equal(h.q('[data-tab="model"]').getAttribute('aria-selected'), 'true');
  assert.equal(h.q('[data-select="visuals"]').closest('[data-panel]').hidden, false);
  assert.deepEqual(h.posts, []);
  h.server.session.featureMatrix.best.images = refused('current processing consent required');
  h.q('[data-select="visuals"] .select__button').click(); h.option('visuals', 'Fake images').click(); await tick(6);
  assert.equal(line.querySelector('.drafts-settings-action'), null);
  assert.equal(line.dataset.consentFeature, 'images');
});

test('the Custom card opens settings with Continue and preselects the host\'s Custom preset; a last choice is announced', async t => {
  const h = fixture(t, { origin: 'last', matrix: { custom: { text: available } } });
  assert.match(h.root.querySelector('.chooser__hint > span').textContent, new RegExp(en.chooser.lastChoice));
  [...h.root.querySelectorAll('.chooser-option')][3].click(); h.root.querySelector('.chooser__continue').click(); await tick(6);
  assert.equal(h.dialog.open, true); assert.equal(h.q('.done-label').textContent, en.settings.continue);
  assert.equal(h.posts[0].processingPreset, 'custom'); assert.equal(h.posts[0].model, 'mock/deep');
  h.q('.done').click(); await tick(6);
  assert.equal(h.dialog.open, false); assert.equal(h.root.querySelector('.intro').dataset.mode, 'ready');
});

test('focus returns to a stable control when saving replaced the card that opened settings', async t => {
  const h = fixture(t, { matrix: { custom: { text: available } } });
  // Chooser path: Continue opens settings, the save turns the chooser into the ready card.
  [...h.root.querySelectorAll('.chooser-option')][3].click();
  const opener = h.root.querySelector('.chooser__continue'); opener.click(); await tick(6);
  assert.equal(h.dialog.open, true); assert.equal(h.posts.length, 1);
  assert.equal(opener.isConnected, false, 'the save replaced the opener');
  h.q('.done').click(); await tick(6);
  assert.equal(h.dialog.open, false);
  assert.ok(h.root.activeElement === h.root.querySelector('.settings-open'), 'focus falls back to the settings button');
  // Ready card path: the save updates the card in place, so its Change button keeps its node and focus.
  const change = h.root.querySelector('.ready__change'); change.click(); await tick();
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Demo only: sample replies').click(); await tick(6);
  assert.equal(h.posts.length, 2); assert.equal(change.isConnected, true, 'the keyed Change button survives the save');
  h.q('.done').click(); await tick(6);
  assert.ok(h.root.activeElement === change, 'focus returns to the Change button');
});

test('live refreshes update the chooser and ready card in place: hovered and focused controls keep their nodes (AIT-116 D2)', async t => {
  const h = fixture(t, { matrix: { eu: { text: available, analysis: available } } }), root = h.root;
  const option = preset => root.querySelector(`.chooser-option[data-preset="${preset}"]`);
  const refresh = async matrix => {
    // A paused-state acknowledgement re-reads the host verdicts, as any live refresh does.
    Object.assign(h.server.session.featureMatrix, matrix);
    h.c.receive(h.server.apply({ sessionId: h.c.session.id, seq: h.server.session.seq + 1, type: 'session.paused', data: { paused: false } }));
    await tick(6);
  };
  const before = PRESETS.map(option), device = option('device'), note = device.querySelector('.chooser-option__note');
  device.focus(); assert.ok(root.activeElement === device);
  await refresh({ eu: { text: refused('not configured'), analysis: refused('not configured') } });
  assert.equal(option('eu').getAttribute('aria-disabled'), 'true', 'the refresh reached the chooser');
  assert.equal(option('eu').querySelector('.chooser-option__note').textContent, en.chooser.unavailable);
  assert.ok(PRESETS.every((preset, i) => option(preset) === before[i]), 'every option keeps its node');
  assert.ok(device.querySelector('.chooser-option__note') === note && device.isConnected);
  assert.ok(root.activeElement === device, 'focus stays on the same Device node');
  option('eu').click(); await tick();
  assert.equal(root.querySelector('.chooser__error').textContent, `In the EU: ${en.reasons['not configured']}`, 'a click reads the current verdict');
  option('best').click(); root.querySelector('.chooser__continue').click(); await tick(6);
  // The ready card: a consent the host dropped adds Review consent beside the same Change button.
  const change = root.querySelector('.ready__change'), rows = [...root.querySelectorAll('.ready__row')];
  change.focus();
  await refresh({ best: { ...h.server.session.featureMatrix.best, text: refused('current processing consent required') } });
  assert.ok(root.querySelector('.ready__consent'), 'the refresh reached the ready card');
  assert.equal(root.querySelector('[data-ready="consent"]').dataset.state, 'pending');
  assert.ok(root.querySelector('.ready__change') === change && root.activeElement === change, 'Change keeps its node and focus');
  assert.ok([...root.querySelectorAll('.ready__row')].every((row, i) => row === rows[i]), 'ready rows keep their nodes');
});

test('Advanced connects a local model through the host factory, with model choice, a test chat and recovery help', async t => {
  const selected = [], streamed = [];
  const factory = ({ endpoint }) => {
    let models = [], model = null;
    return { endpoint, get model() { return model; }, models: () => models,
      async connect() { if (endpoint.includes('9999')) throw Object.assign(new Error('blocked'), { code: 'unavailable', local: 'cors' }); models = ['alpha', 'beta']; model ??= 'alpha'; return models; },
      select(next) { selected.push(next); model = next; return next; }, disconnect() { models = []; model = null; },
      async *stream(input) { streamed.push(input.messages); yield 'Local '; yield 'reply'; } };
  };
  const h = fixture(t, { deviceConnector: factory });
  h.c.openSettings(undefined, { tab: 'local' }); await tick();
  const local = selector => h.dialog.querySelector(`.local ${selector}`);
  assert.equal(local('#local-endpoint').value, 'http://127.0.0.1:8000');
  local('.local-connect').click(); await tick(6);
  assert.equal(local('.local-status').textContent, en.local.ready.replace('{model}', 'alpha'));
  assert.deepEqual([...local('#local-model').options].map(o => o.value), ['alpha', 'beta']);
  local('#local-model').value = 'beta'; local('#local-model').dispatchEvent(new window.Event('change')); assert.deepEqual(selected, ['beta']);
  local('.local-test').click(); assert.equal(local('.local-test').getAttribute('aria-expanded'), 'true'); assert.equal(local('#local-chat').hidden, false);
  assert.equal(local('.badge').textContent, en.local.textBadge, 'the test chat badge comes from the i18n bundle');
  local('#local-message').value = 'Say hi'; local('.local__composer').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(6);
  assert.deepEqual(streamed, [[{ role: 'user', content: 'Say hi' }]]); assert.match(local('.local__messages').textContent, /Local reply/);
  assert.equal(h.posts.length, 0, 'the local connector never contacts the host server');
  local('.local-disconnect').click(); await tick();
  assert.equal(local('.local-status').textContent, en.local.cleared); assert.equal(local('.local__messages').textContent.includes('Local reply'), false);
  local('#local-endpoint').value = 'http://127.0.0.1:9999'; local('#local-endpoint').dispatchEvent(new window.Event('input'));
  local('.local-connect').click(); await tick(6);
  assert.equal(local('.local-error').textContent, en.local.errors.cors); assert.equal(local('.recovery').hidden, false);
  assert.deepEqual([...local('.recovery-steps').children].map(li => li.textContent), en.local.recovery.cors);
  assert.equal(local('.browser-help').open, true); assert.equal(local('.setup-details').open, true);
});

test('a device conversation uses the locally connected model and keeps analysis, voice and images unavailable', async t => {
  const factory = () => { let models = []; return { get model() { return models[0] ?? null; }, models: () => models, select() {}, disconnect() { models = []; },
    async connect() { models = ['local-7b']; return models; }, async *stream() { yield 'From device'; } }; };
  const h = fixture(t, { deviceConnector: factory });
  h.c.configure({ copy: en, session: { ...createSession({ processingPreset: 'device', settings: { origin: 'chosen', voice: 'off', visuals: 'off' } }) }, deviceConnector: factory });
  const root = h.c.shadowRoot;
  assert.equal(root.querySelector('.intro').dataset.mode, 'ready');
  assert.match(root.querySelector('[data-ready="model"] dd').textContent, new RegExp(en.ready.notConnected));
  h.c.openSettings(undefined, { tab: 'local' }); await tick();
  root.querySelector('.local .local-connect').click(); await tick(6);
  root.querySelector('dialog.settings .done').click(); await tick();
  assert.match(root.querySelector('.engine__detail').textContent, /Local model/);
  assert.match(root.querySelector('[data-ready="model"] dd').textContent, /Local model/);
  assert.ok(root.querySelector('.features').textContent.includes(en.reasons['unavailable on device']));
  root.querySelector('textarea').value = 'Hello device'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(6);
  assert.deepEqual(h.c.session.transcript.map(turn => turn.content), ['Hello device', 'From device']);
  assert.equal(h.c.session.transcript[0].origin, undefined);
  assert.equal(h.c.session.transcript[1].origin, 'ai-generated'); assert.equal(h.c.session.transcript[1].model, 'local-7b');
});

test('confirming an uncovered choice continues into the host consent interface, and the ready card keeps offering it', async t => {
  const h = fixture(t, { matrix: { best: { text: refused('current processing consent required'), analysis: refused('current processing consent required') } },
    respond: (body, n, ack) => ack(body, { consent: { required: true, features: ['text', 'analysis'] } }) });
  const asked = []; h.c.addEventListener('aithema-consent', event => asked.push(event.detail));
  h.root.querySelector('.chooser__continue').click(); await tick(6);
  assert.deepEqual(asked, [{ sessionId: h.c.session.id, reason: 'chooser', features: ['text', 'analysis'] }]);
  const consentRow = h.root.querySelector('[data-ready="consent"]');
  assert.equal(consentRow.dataset.state, 'pending'); assert.match(consentRow.textContent, new RegExp(en.ready.missing));
  h.root.querySelector('.ready__consent').click();
  assert.equal(asked.at(-1).reason, 'ready');
});

test('a host can map each voice option to its own browser client; the rail starts the mapped one', async t => {
  const started = [];
  const client = name => ({ manifest: voiceManifest, async start() { started.push(name); throw Object.assign(new Error('fixture'), { code: 'not-admitted' }); } });
  const h = fixture(t, { origin: 'chosen' });
  h.c.configure({ copy: en, session: h.c.session, voiceClient: client('default'), voiceClients: { 'fake-voice': client('fake-voice') } });
  const start = h.c.shadowRoot.querySelector('.voice-start');
  assert.equal(start.disabled, false, start.title);
  start.click(); await tick(6);
  assert.deepEqual(started, ['fake-voice']);
});

for (const [locale, copy] of Object.entries({ de, en })) test(`AIT-267 ${locale}: model labels wait for the first catalog and survive a pending refresh`, async t => {
  const loads = [Promise.withResolvers(), Promise.withResolvers()];
  t.after(() => loads.forEach(load => load.resolve()));
  let reads = 0;
  const h = fixture(t, { copy, origin: 'chosen', model: 'default', loadCatalog: async catalog => {
    await loads[reads++].promise;
    catalog.presets.best.models = [{ ...models[0], id: 'default', label: 'Anthropic via OpenRouter' }];
    return catalog;
  } });
  h.c.openSettings();
  const value = () => h.q('[data-select="model"] .select__value').textContent;
  assert.equal(value(), copy.settings.loadingOption, 'the first render must not claim a fallback model label');
  await tick();
  assert.equal(value(), copy.settings.loadingOption, 'the label stays pending until the catalog resolves');
  assert.equal(h.q('[data-select="model"] .select__button').disabled, true);
  assert.equal(h.q('#settings-options-model').children.length, 0, 'no provisional model options');
  loads[0].resolve(); await tick();
  const expected = copy.catalogLabels['Anthropic via OpenRouter'];
  assert.equal(value(), expected);
  assert.equal(h.q('#settings-options-model [data-value="default"] strong').textContent, expected);
  assert.equal(h.q('[data-select="model"] .select__button').disabled, false);
  assert.deepEqual(h.posts, [], 'opening settings does not save a selection');
  h.dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  h.c.openSettings(); await tick();
  assert.equal(reads, 2);
  assert.equal(value(), expected, 'reopening reuses the catalog while its refresh is pending');
  loads[1].resolve(); await tick();
  assert.equal(value(), expected);
});

// AIT-234: hold the first catalog so a fast explicit choice precedes its defaults.
test('AIT-234: Custom chosen before the catalog loads applies Custom defaults, never Best values', async t => {
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  const h = fixture(t, { loadCatalog: async catalog => { await held.promise; return catalog; } });
  h.c.openSettings();
  h.q('[data-preset="custom"]').click();
  await tick();
  assert.deepEqual(h.posts, [], 'no partial preset can be saved');
  assert.equal(h.q('[data-preset="custom"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.dialog.getAttribute('aria-busy'), 'true');
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.loading);
  for (const name of ['model', 'voice', 'visuals']) {
    const button = h.q(`[data-select="${name}"] .select__button`);
    assert.equal(button.disabled, true);
    assert.equal(button.querySelector('.select__value').textContent, en.settings.loadingOption);
    assert.ok(button.querySelector('.select__spinner svg'));
  }
  assert.equal(h.q('.done').disabled, true);
  assert.equal(h.q('.done').getAttribute('aria-describedby'), h.q('.notice-body .notice-text').id);
  h.q('.done').click(); await tick();
  assert.equal(h.dialog.open, true, 'Done cannot confirm Best while Custom is pending');
  assert.deepEqual(h.posts, []);
  held.resolve(); await tick(10);
  assert.deepEqual(h.posts, [{ processingPreset: 'custom', model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off', baseRevision: 0, confirm: true }]);
  assert.equal(h.q('.done').disabled, false);
  assert.equal(h.q('.done').hasAttribute('aria-describedby'), false);
  assert.equal(h.q('.select__spinner'), null);
  assert.equal(h.q('[data-select="model"] .select__button').disabled, false);
  assert.equal(h.c.session.settings.origin, 'chosen');
  assert.equal(h.c.session.processingPreset, 'custom');
  assert.equal(h.c.session.settings.voice, 'off');
  assert.equal(h.c.session.settings.visuals, 'off');
});

for (const action of ['best', 'dismiss', 'reopen']) test(`AIT-234: ${action} cancels Custom waiting for the catalog`, async t => {
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  const h = fixture(t, { loadCatalog: async catalog => { await held.promise; return catalog; } });
  h.c.openSettings(undefined, { preset: 'custom' });
  await tick();
  if (action === 'best') h.q('[data-preset="best"]').click();
  else { h.dialog.dispatchEvent(new window.Event('cancel', { cancelable: true })); if (action === 'reopen') h.c.openSettings(); }
  held.resolve(); await tick(10);
  assert.deepEqual(h.posts, [], 'the stale choice never saves');
  assert.equal(h.c.session.processingPreset, 'best');
  if (h.dialog.open) assert.equal(h.q('[data-preset="best"]').getAttribute('aria-checked'), 'true');
});

test('AIT-234: a failed catalog retains Custom for explicit reload without saving Best', async t => {
  let reads = 0;
  const h = fixture(t, { loadCatalog: async catalog => { if (++reads === 1) throw new Error('offline'); return catalog; } });
  h.c.openSettings(); h.q('[data-preset="custom"]').click(); await tick();
  assert.deepEqual(h.posts, []);
  assert.equal(h.q('.notice-body .notice-text').textContent, en.settings.loadFailed);
  h.q('.done').click(); await tick(); assert.equal(h.dialog.open, true);
  h.q('.notice-body .notice-action').click(); await tick(10);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].model, 'mock/deep');
  assert.equal(h.posts[0].voice, 'off'); assert.equal(h.posts[0].visuals, 'off');
  assert.equal(h.c.session.settings.origin, 'chosen');
});

// Done is also the consent editor's save button; rendering Custom must respect that owner.
test('AIT-234: an invalid consent document keeps the shared Done button disabled', async t => {
  const h = fixture(t, { matrix: { best: { text: refused('current processing consent required') } } });
  h.root.querySelector('.composer-reason .consent-action').click(); await tick(10);
  assert.equal(h.q('.consent-status').textContent, en.host.consentFailed);
  assert.equal(h.q('.done').disabled, true);
  assert.equal(h.q('.done').getAttribute('aria-disabled'), 'true');
  assert.equal(h.q('.done').hasAttribute('aria-describedby'), false, 'consent failure is not catalog loading');
});

for (const copy of [de, en]) test(`AIT-266 ${copy.display.locale}: unavailable Custom agrees at entrance and Settings and arrow keys skip it`, async t => {
  const h = fixture(t, { copy, matrix: { custom: { text: refused('not configured') } }, loadCatalog(catalog) {
    catalog.presets.custom = { offered: true, status: 'unavailable', reason: 'not configured' }; return catalog;
  } });
  const entrance = h.root.querySelector('.chooser-option[data-preset="custom"]');
  assert.equal(entrance.getAttribute('aria-disabled'), 'true'); assert.equal(entrance.tabIndex, -1);
  assert.equal(entrance.querySelector('.chooser-option__note').textContent, copy.chooser.unavailable);
  entrance.click(); assert.equal(entrance.getAttribute('aria-pressed'), 'false'); assert.equal(h.posts.length, 0);
  const best = h.root.querySelector('.chooser-option[data-preset="best"]');
  best.focus(); best.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(h.root.activeElement.dataset.preset, 'device');
  best.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(h.root.activeElement.dataset.preset, 'device');
  await opened(h);
  const custom = h.q('.preset-option[data-preset="custom"]');
  assert.equal(custom.getAttribute('aria-disabled'), 'true');
  assert.equal(custom.querySelector('.option-status').textContent, copy.chooser.unavailable);
  custom.click(); await tick(); assert.equal(h.posts.length, 0);
  const selected = h.q('.preset-option[data-preset="best"]');
  selected.focus(); selected.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(h.root.activeElement.dataset.preset, 'device');
});

for (const [locale, copy] of Object.entries({ de, en })) {
  for (const host of [false, true]) test(`AIT-291 ${locale}: final ${host ? 'host' : 'plugin'} quality and operator price wording`, async t => {
    const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
      catalog.settings.voice = 'off';
      catalog.presets.best.models[0].facts = facts({ qualification: 'qualified', hostQualified: host, hostPriceReviewed: true, free: false });
      return catalog;
    } }));
    for (const [kind, value, short] of [
      ['quality', locale === 'de' ? 'Geprüft' : 'Checked', host ? (locale === 'de' ? 'vom Host, ohne Bewertung' : 'by the host, no rating') : (locale === 'de' ? 'Plugin, ohne Bewertung' : 'Plugin, no rating')],
      ['cost', locale === 'de' ? 'Festgelegt' : 'Set', locale === 'de' ? 'Preis vom Betreiber' : 'Operator price'],
    ]) {
      assert.equal(h.q(`[data-gauge="${kind}"] .gauge__value`).textContent, value);
      assert.equal(h.q(`[data-gauge="${kind}"] .gauge__detail`).textContent, short);
      assert.equal(h.q(`[data-gauge="${kind}"] .gauge__label`).textContent, copy.gauges.labels[kind]);
    }
    assert.doesNotMatch(h.q('.gauges').textContent, /Qualifiziert|Qualified/u);
  });
  for (const [countries, deValue, enValue] of [
    [['US'], 'USA', 'US'], [['US', 'IE'], 'USA, Irland', 'US, Ireland'],
    [['US', 'IE', 'FR'], 'USA, Irland +1', 'US, Ireland +1'],
    [['US', 'IE', 'FR', 'DE'], 'USA, Irland +2', 'US, Ireland +2'],
  ]) test(`AIT-291 ${locale}: compact provider country value ${countries}`, async t => {
    const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
      catalog.settings.voice = 'off';
      catalog.presets.best.models[0].facts = facts({ hostCountries: countries });
      return catalog;
    } }));
    const gauge = h.q('[data-gauge="privacy"]');
    assert.equal(gauge.querySelector('.gauge__value').textContent, locale === 'de' ? deValue : enValue);
    assert.equal(gauge.querySelector('.gauge__detail').textContent, locale === 'de' ? 'Sitz der Anbieter' : 'Providers’ seat');
    if (countries.length > 2) {
      assert.match(gauge.getAttribute('aria-label'), locale === 'de' ? /Frankreich/ : /France/);
      assert.doesNotMatch(gauge.getAttribute('aria-label').split(', The providers')[1] ?? gauge.getAttribute('aria-label').split(', Die Anbieter')[1], /\+\d/u);
    }
  });
}

for (const copy of [de, en]) for (const rated of [false, true]) {
  test(`AIT-292 ${copy.display.locale}: ${rated ? 'real zero' : 'no rating'} renders the correct vial class`, async t => {
    const h = await opened(fixture(t, { copy, loadCatalog(catalog) {
      catalog.presets.best.models[0].facts.quality = rated
        ? { score: 0, source: { name: 'Fixture', url: 'https://example.test/rating', asOf: '2026-10-17' } } : null;
      return catalog;
    } }));
    const gauge = h.q('[data-gauge="quality"]');
    assert.equal(gauge.classList.contains('gauge--unrated'), !rated);
    assert.equal(gauge.classList.contains('gauge--measured'), rated);
    assert.equal(gauge.querySelector('.gauge__unrated').textContent, '–');
    assert.equal(gauge.querySelector('.gauge__glass').getAttribute('aria-hidden'), 'true');
    assert.equal(gauge.querySelector('.gauge__level').dataset.fill, '0');
    assert.equal(h.q('[data-gauge="cost"]').classList.contains('gauge--measured'), true, 'known free cost is a real zero');
  });
}

for (const [copy, plain] of [[de, 'Sprache ist derzeit nicht verfügbar'], [en, 'Voice is currently unavailable']]) {
  for (const reason of ['binding evidence unverified', 'delegated reasoning: binding evidence unverified']) {
    for (const surface of ['settings', 'chooser']) {
      test(`AIT-380 round 3 ${copy.display.locale}: ${surface} refusal after offer stays neutral (${reason})`, async t => {
        const pending = Promise.withResolvers(); t.after(() => pending.resolve(new Response(null, { status: 503 })));
        const h = fixture(t, { copy, voice: surface === 'settings' ? 'off' : 'fake-voice', respond: () => pending.promise });
        if (surface === 'settings') {
          await opened(h);
          h.q('[data-select="voice"] .select__button').click();
          const option = h.option('voice', 'Fake voice');
          assert.equal(option.getAttribute('aria-disabled'), 'false', 'voice was offered before the server refusal');
          option.click();
        } else {
          assert.equal(h.root.querySelector('.chooser-option[data-preset="best"]').getAttribute('aria-disabled'), 'false');
          h.root.querySelector('.chooser__continue').click();
        }
        await tick(6);
        assert.equal(h.posts.length, 1);
        assert.equal(h.posts[0].voice, 'fake-voice');
        pending.resolve(Response.json({ error: 'setting-not-allowed', field: 'voice', reason }, { status: 409 }));
        await tick(6);
        const text = surface === 'settings' ? h.q('.notice-body .notice-text').textContent : h.root.querySelector('.chooser__error').textContent;
        assert.equal(text, copy.settings.notAllowed.replace('{reason}', plain));
        assert.doesNotMatch(text, /Provider contract not verified|Vertrag mit dem Anbieter nicht geprüft|Voice reasoning|Auswertung im Sprachgespräch/u);
        assert.equal(h.posts.length, 1, 'a refusal never retries the offered option');
        assert.equal(h.c.session.settings.revision, 0, 'the refused choice was never acknowledged');
      });
    }
  }
}
