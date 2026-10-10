import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, applyEvent } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest as voiceManifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
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
function fixture(t, { origin = 'default', turns = 0, voiceClient, deviceConnector, matrix = {}, respond } = {}) {
  let session = createSession({ demo: true });
  for (let i = 0; i < turns; i++) session = applyEvent(session, { seq: session.seq + 1, type: 'turn.final', data: { id: `t${i}`, role: 'user', content: 'Hello' } });
  session.settings = { revision: 0, model: 'mock', effort: 'none', voice: 'fake-voice', visuals: 'off', origin, at: null };
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
    if (String(url).endsWith('/settings') && init.method !== 'POST') return Response.json(catalogFor(server.session));
    if (String(url).endsWith('/settings')) { const body = JSON.parse(init.body); posts.push(body); return respond ? respond(body, posts.length, ack, server) : ack(body); }
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    return Response.json(server.session);
  };
  c.configure({ copy: structuredClone(en), session, voiceClient, deviceConnector });
  // Focus only exists in a connected document; the SSE fetch above never ends.
  document.body.append(c);
  t.after(async () => { c.remove(); await tick(); globalThis.fetch = original; });
  const root = c.shadowRoot, dialog = root.querySelector('dialog.settings');
  const q = selector => dialog.querySelector(selector);
  const option = (name, label) => [...q(`[data-select="${name}"] .select__menu`).querySelectorAll('[role=option]')].find(node => node.querySelector('strong').textContent === label);
  return { c, root, dialog, q, posts, option, ack, server };
}
async function opened(h) { h.c.openSettings(); await tick(); return h; }

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

test('choosing a model sends ids only and the panel shows the new choice only after the server acknowledges it', async t => {
  const held = Promise.withResolvers();
  const h = await opened(fixture(t, { respond: async (body, n, ack) => { await held.promise; return ack(body); } }));
  const button = h.q('[data-select="model"] .select__button');
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true'); assert.equal(h.q('#settings-options-model').hidden, false);
  const declared = h.option('model', 'Declared provider');
  assert.equal(declared.getAttribute('aria-disabled'), 'true'); assert.equal(declared.querySelector('.option-status').textContent, en.settings.unavailable);
  declared.click(); await tick();
  assert.equal(h.posts.length, 0, 'an unavailable option is never sent');
  assert.equal(h.q('.context-message').textContent, `Unavailable · ${en.reasons['not configured']}`);
  button.click(); h.option('model', 'Deep (mock)').click(); await tick();
  assert.deepEqual(h.posts, [{ processingPreset: 'best', model: 'mock/deep', effort: 'medium', voice: 'fake-voice', visuals: 'off', baseRevision: 0 }]);
  assert.match(h.root.querySelector('.engine__detail').textContent, /^Mock reasoning/, 'the panel still shows the acknowledged choice');
  assert.equal(h.q('.save-status').textContent, en.settings.saving); assert.equal(h.dialog.getAttribute('aria-busy'), 'true');
  held.resolve(); await tick(6);
  assert.match(h.root.querySelector('.engine__detail').textContent, /^Deep \(mock\) · Medium/);
  assert.equal(h.c.session.settings.model, 'mock/deep'); assert.equal(h.c.session.settings.origin, 'chosen');
  assert.equal(h.q('.save-status').textContent, en.settings.saved); assert.equal(h.dialog.dataset.saveState, 'saved');
  const effort = h.q('#settings-effort');
  assert.equal(effort.disabled, false); assert.equal(effort.max, '2'); assert.equal(effort.getAttribute('aria-valuetext'), 'Medium');
  effort.value = '2'; effort.dispatchEvent(new window.Event('input', { bubbles: true })); effort.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(6);
  assert.deepEqual(h.posts.at(-1), { processingPreset: 'best', model: 'mock/deep', effort: 'high', voice: 'fake-voice', visuals: 'off', baseRevision: 1 });
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
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Deep (mock)').click(); await tick(6);
  assert.equal(h.q('.notice-text').textContent, en.settings.notAllowed.replace('{reason}', en.reasons['model not offered']));
  assert.equal(h.q('[data-select="model"] .select__value').textContent, 'Mock reasoning'); assert.equal(h.q('.save-retry').dataset.visible, 'false');
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Deep (mock)').click(); await tick(6);
  assert.equal(h.q('.notice-text').textContent, en.settings.conflict);
  assert.equal(h.q('[data-select="model"] .select__value').textContent, 'Deep (mock)', 'the saved choice from the other window is shown');
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
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Deep (mock)').click(); await tick(6);
  assert.equal(h.posts.length, 0, 'no change is sent while the call runs');
  assert.equal(h.q('.notice-text').textContent, en.settings.callActive);
  assert.equal(h.q('.notice-action').textContent, en.settings.endCallApply); assert.equal(h.q('.notice-action').hidden, false);
  h.q('.notice-action').click(); await tick(10);
  assert.equal(closed.length, 1, 'the visitor ends the call explicitly');
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].model, 'mock/deep'); assert.equal(h.c.session.settings.model, 'mock/deep');
});

test('a choice that needs consent is saved and the host is asked for consent outside the modal', async t => {
  const h = await opened(fixture(t, { respond: (body, n, ack) => ack(body, { consent: { required: true, features: ['text', 'analysis'] } }) }));
  let asked; h.c.addEventListener('aithema-consent', event => { asked = event.detail; });
  h.q('.preset-option[data-preset="custom"]').click(); await tick(6);
  assert.deepEqual(h.posts[0], { processingPreset: 'custom', model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off', baseRevision: 0 });
  assert.equal(h.q('.notice-text').textContent, en.settings.consentRequired);
  h.q('.notice-action').click(); await tick();
  assert.equal(h.dialog.open, false, 'the host consent interface is outside the modal');
  assert.deepEqual(asked, { sessionId: h.c.session.id, reason: 'settings', features: ['text', 'analysis'] });
});

test('crossing the device boundary in a started conversation starts a new conversation only on explicit action', async t => {
  const h = await opened(fixture(t, { turns: 1 }));
  let requested; h.c.addEventListener('aithema-new-conversation', event => { requested = event.detail; });
  h.q('.preset-option[data-preset="device"]').click(); await tick(6);
  assert.equal(h.posts.length, 0);
  assert.equal(h.q('.notice-text').textContent, en.settings.toDevice); assert.equal(h.q('.notice-action').textContent, en.settings.startDevice);
  assert.equal(h.q('[data-select="voice"] .select__button').getAttribute('aria-disabled'), 'true', 'device keeps voice unavailable');
  h.q('.notice-action').click(); await tick();
  assert.deepEqual(requested, { processingPreset: 'device', settings: {}, previousSessionId: h.c.session.id });
  assert.equal(h.dialog.open, false);
});

test('gauges are computed from the catalog facts of the draft and explain themselves in the help line', async t => {
  const h = await opened(fixture(t));
  const value = kind => h.q(`[data-gauge="${kind}"] .gauge__value`).textContent;
  assert.deepEqual(['quality', 'speed', 'cost', 'privacy', 'voice', 'images'].map(value), ['Unverified', '5/5', 'None', 'Unverified', 'Unverified', 'Off']);
  assert.equal(h.q('[data-gauge="speed"] .gauge__level').style.getPropertyValue('--empty'), '0%');
  assert.equal(h.q('[data-gauge="voice"] .gauge__level').style.getPropertyValue('--empty'), '25%', 'one native and one emulated capability');
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Deep (mock)').click(); await tick(6);
  assert.equal(value('speed'), '4/5');
  h.q('[data-select="voice"] .select__button').click(); h.option('voice', en.settings.voiceOff).click(); await tick(6);
  assert.equal(value('voice'), 'Off');
  const quality = h.q('[data-gauge="quality"]');
  quality.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(h.q('.context-message').textContent, 'AI quality · Unverified: The plugin manifest marks this model unverified');
  assert.match(quality.getAttribute('aria-label'), /^AI quality: Unverified, /);
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
  const h = fixture(t);
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
  assert.deepEqual(h.posts, [{ processingPreset: 'best', baseRevision: 0, model: 'mock', effort: 'none', voice: 'fake-voice', visuals: 'off' }]);
  assert.equal(root.querySelector('.intro').dataset.mode, 'ready'); assert.equal(root.querySelector('.audio-rail').inert, false);
  const rows = Object.fromEntries([...root.querySelectorAll('.ready__row')].map(row => [row.dataset.ready, [row.querySelector('dd').textContent.replace('✓', ''), row.dataset.state]]));
  assert.deepEqual(rows, { model: ['Mock reasoning', 'selected'], consent: [en.ready.granted, 'confirmed'], microphone: [en.ready.checkOnStart, 'pending'],
    speaker: [en.ready.onOnStart, 'selected'], visuals: [en.ready.off, 'off'] });
  h.c.receive({ seq: h.c.session.seq + 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'Hello' } });
  assert.equal(root.querySelector('.intro').hidden, true, 'the first message replaces the start screen');
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
  h.q('[data-select="model"] .select__button').click(); h.option('model', 'Mock reasoning').click(); await tick(6);
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
  assert.match(root.querySelector('.engine__detail').textContent, /local-7b/);
  assert.match(root.querySelector('[data-ready="model"] dd').textContent, /local-7b/);
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
