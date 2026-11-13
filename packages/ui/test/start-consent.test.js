import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { AudioRail } from '../src/audio-rail.js';
const window = new Window({ url: 'https://example.test' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'sessionStorage']) globalThis[key] = window[key];
await import('../src/session-element.js');
const blocked = { available: false, reason: 'current processing consent required' };
const allowed = { available: true, reason: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, mode = 'type', active) {
  sessionStorage.clear();
  const starts = [];
  t.mock.method(AudioRail.prototype, 'start', function () { starts.push(this); return Promise.resolve(); });
  t.mock.getter(globalThis, 'navigator', () => ({ userActivation: active === undefined ? undefined : { isActive: active } }));
  let c = document.createElement('aithema-session'), covering = true, lag = false;
  const session = createSession({ demo: true });
  session.settings = { ...session.settings, origin: 'chosen', ...(mode === 'voice' ? { voice: 'fixture-voice' } : {}) };
  session.featureMatrix = { best: { text: blocked, voice: blocked, analysis: blocked } };
  const options = { copy: structuredClone(en), session, ...(mode === 'voice' ? { voiceClient: {} } : {}) };
  const configure = (next = c, snapshot = session) => { c = next; c.configure({ ...options, session: snapshot }); document.body.append(c); return c; };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (url.endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision - (lag ? 1 : 0), selected: [], features: {} });
    const snapshot = c.session;
    snapshot.featureMatrix.best = { text: covering ? allowed : blocked, voice: covering ? allowed : blocked, analysis: allowed };
    return Response.json(snapshot);
  });
  configure();
  t.after(() => { c.remove(); document.body.replaceChildren(); sessionStorage.clear(); });
  return { get c() { return c; }, starts, configure,
    start() { c.shadowRoot.querySelector('.ready__start').click(); },
    async grant() { c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, changed: ['text', 'voice'], removed: [] } }); await tick(); },
    set covering(value) { covering = value; }, set lag(value) { lag = value; } };
}
for (const mode of ['type', 'voice']) test(`AIT-501: ${mode} Start resumes exactly once after a covering refresh`, async t => {
  const f = fixture(t, mode, true), events = [];
  f.c.addEventListener('aithema-consent', e => events.push(e.detail));
  f.start();
  assert.deepEqual(events, [{ sessionId: f.c.session.id, reason: 'ready', features: ['text', 'analysis', 'voice'], intent: 'start', mode, required: [mode === 'voice' ? 'voice' : 'text'] }]);
  await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(f.starts.length, mode === 'voice' ? 1 : 0);
  await f.grant(); assert.equal(f.starts.length, mode === 'voice' ? 1 : 0);
});
test('AIT-501: closed Start dialog followed by Review never starts', async t => {
  const f = fixture(t), events = [];
  f.c.addEventListener('aithema-consent', e => events.push(e.detail));
  f.start(); f.c.shadowRoot.querySelector('.ready__consent').click(); await f.grant();
  assert.equal(events.at(-1).intent, 'review');
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
});
test('AIT-501: partial grant clears Start after refresh settles', async t => {
  const f = fixture(t); f.start(); f.covering = false; await f.grant();
  f.covering = true; await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
});
test('AIT-501: ledger lag and two revision events consume one Start', async t => {
  const f = fixture(t, 'voice', true); f.start(); f.lag = true; await f.grant(); await f.grant();
  assert.equal(f.starts.length, 0);
  f.lag = false;
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  assert.equal(f.starts.length, 1);
});
for (const mode of ['type', 'voice']) test(`AIT-501: navigation restores ${mode} once; voice requires Start call`, async t => {
  const f = fixture(t, mode, true); f.start();
  const snapshot = f.c.session; snapshot.consentRevision++;
  f.c.remove(); const returned = f.configure(document.createElement('aithema-session'), snapshot);
  await tick();
  assert.equal(returned.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(f.starts.length, 0, 'returning navigation never starts voice even with activation');
  assert.equal(returned.shadowRoot.activeElement, returned.shadowRoot.querySelector(mode === 'voice' ? '.voice-start' : 'textarea'));
  returned.remove(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false, 'stored intent was read and deleted');
});
for (const active of [false, undefined]) test(`AIT-501: voice activation ${active} selects and focuses Start call without media`, async t => {
  const f = fixture(t, 'voice', active); f.start(); await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.activeElement, f.c.shadowRoot.querySelector('.voice-start'));
});
for (const action of ['expiry', 'settings', 'mode', 'session', 'new-conversation', 'withdrawal']) test(`AIT-501: ${action} cancels the intent`, async t => {
  const f = fixture(t, action === 'mode' ? 'voice' : 'type'); f.start();
  if (action === 'expiry') { const now = Date.now(); t.mock.method(Date, 'now', () => now + 180_001); }
  if (action === 'settings') f.c.receive({ seq: f.c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...f.c.session.settings, revision: f.c.session.settings.revision + 1 } } });
  if (action === 'mode') f.c.shadowRoot.querySelector('[data-mode="type"]').click();
  if (action === 'session') { const snapshot = f.c.session; snapshot.id = 'another-session'; f.configure(f.c, snapshot); }
  if (action === 'new-conversation') { f.c.openSettings(); f.c.shadowRoot.querySelector('.general-new').click(); }
  if (action === 'withdrawal') f.c.receive({ seq: f.c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
  await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
});
test('AIT-501: consent continuation keeps focus on a host control', async t => {
  const f = fixture(t); f.start(); const host = document.createElement('button'); document.body.append(host); host.focus();
  await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(document.activeElement, host);
});

test('AIT-501: hidden page waits for a visible refresh before consuming Start', async t => {
  const f = fixture(t, 'voice', true); let visibility = 'hidden';
  t.mock.getter(document, 'visibilityState', () => visibility);
  f.start(); await f.grant(); assert.equal(f.starts.length, 0);
  visibility = 'visible'; document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  assert.equal(f.starts.length, 1);
});
test('AIT-501: erasure clears both memory and the tab mirror', async t => {
  const f = fixture(t, 'voice', true); f.start();
  assert.ok(sessionStorage.getItem('aithema-start-intent'));
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.erased', data: { at: new Date().toISOString() } });
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  await f.grant(); assert.equal(f.starts.length, 0);
});
