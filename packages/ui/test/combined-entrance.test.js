import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { AudioRail } from '../src/audio-rail.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fixture as voiceFixture, invocationOptions } from '../../../plugins/elevenlabs/test/fixtures.js';
const window = new Window({ url: 'https://example.test' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'sessionStorage']) globalThis[key] = window[key];
await import('../src/session-element.js');
const blocked = { available: false, reason: 'current processing consent required' }, allowed = { available: true, reason: null };
const tick = () => new Promise(resolve => setTimeout(resolve, 450));
function fixture(t, { granted = false, entrance = 'combined', active = true, client } = {}) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const timers = new Map(), nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (callback.name !== 'startIntentTimer') return nativeSet(callback, delay, ...args);
    const id = { unref() {} }; timers.set(id, { callback, deadline: now + delay }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => { if (!timers.delete(id)) nativeClear(id); });
  sessionStorage.clear();
  const starts = [], sends = [], events = [];
  if (!client) t.mock.method(AudioRail.prototype, 'start', function () { starts.push(this); return Promise.resolve(); });
  t.mock.getter(globalThis, 'navigator', () => ({ userActivation: { isActive: active }, permissions: { async query() { return { state: 'denied' }; } } }));
  let c = document.createElement('aithema-session');
  const session = createSession({ demo: true });
  session.settings = { ...session.settings, origin: 'chosen', voice: 'fixture' };
  session.featureMatrix = { best: { text: granted ? allowed : blocked, voice: blocked, analysis: allowed } };
  const configure = (next = c, snapshot = session) => {
    c = next; c.addEventListener('aithema-consent', e => events.push(e.detail));
    c.configure({ copy: en, session: snapshot, entrance, voiceClient: client ?? {} }); document.body.append(c); return c;
  };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/turns')) {
      const body = JSON.parse(options.body); sends.push(body);
      return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
    }
    if (url.endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: [], features: {} });
    const snapshot = c.session;
    snapshot.featureMatrix.best = { text: allowed, voice: allowed, analysis: allowed };
    return Response.json(snapshot);
  });
  configure();
  t.after(() => { c.remove(); document.body.replaceChildren(); sessionStorage.clear(); });
  return { get c() { return c; }, starts, sends, events, configure,
    input(value) { c.shadowRoot.querySelector('textarea').value = value; },
    send() { c.shadowRoot.querySelector('.send').click(); },
    mic() { assert.ok(c.shadowRoot.querySelector('.composer-mic'), 'combined composer has a microphone'); c.shadowRoot.querySelector('.composer-mic').click(); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.deadline <= now) { timers.delete(id); timer.callback(); } },
    async grant() { c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, changed: ['text', 'voice'], removed: [] } }); await tick(); },
    returnSnapshot(covered = true) { const snapshot = c.session; if (covered) { snapshot.consentRevision++; snapshot.featureMatrix.best = { text: allowed, voice: allowed, analysis: allowed }; } c.remove(); return snapshot; } };
}
test('AIT-506: combined entrance has one composer, notice and no mode choice or Start', t => {
  const f = fixture(t), root = f.c.shadowRoot;
  assert.equal(root.querySelector('.workspace').dataset.entrance, 'combined');
  assert.equal(root.querySelector('.ready__start'), null);
  assert.equal(root.querySelector('.ready__modes'), null);
  assert.equal(root.querySelector('[data-ready="microphone"]'), null);
  assert.equal(root.querySelector('[data-ready="speaker"]'), null);
  assert.ok(root.querySelector('.composer-notice').textContent.includes(en.aiNotice.text));
  assert.ok(root.querySelector('.composer-mic'));
  assert.equal(root.querySelector('textarea').disabled, false, 'consent does not prevent drafting');
  assert.equal(f.starts.length, 0);
});
test('AIT-506: legacy choice entrance keeps mode selection and Start', t => {
  const f = fixture(t, { entrance: 'choice' });
  assert.ok(f.c.shadowRoot.querySelector('.ready__start'));
  assert.ok(f.c.shadowRoot.querySelector('.ready__modes'));
  assert.equal(f.c.shadowRoot.querySelector('.composer-mic'), null);
});
test('AIT-506: Send snapshots text before consent, locks edits, sends once after Agree', async t => {
  const f = fixture(t); f.input('Snapshot at Send'); f.send();
  assert.equal(f.events.at(-1)?.mode, 'text');
  assert.equal(f.events.at(-1)?.intent, 'start');
  assert.equal(f.events.at(-1)?.reason, 'ready');
  assert.deepEqual(f.events.at(-1)?.required, ['text']);
  assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, true);
  assert.equal(JSON.parse(sessionStorage.getItem('aithema-start-intent')).draft, 'Snapshot at Send');
  f.input('programmatic replacement'); await f.grant(); await f.grant();
  assert.deepEqual(f.sends.map(s => s.content), ['Snapshot at Send']);
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, false);
});
test('AIT-506: text grant does not cover mic, and mic preserves the draft', t => {
  const f = fixture(t, { granted: true }); f.input('Keep this draft'); f.mic();
  assert.equal(f.events.at(-1).mode, 'voice');
  assert.deepEqual(f.events.at(-1).required, ['voice']);
  assert.equal(JSON.parse(sessionStorage.getItem('aithema-start-intent')).draft, 'Keep this draft');
  assert.equal(f.starts.length, 0);
});
for (const mode of ['text', 'voice']) test(`AIT-506: ${mode} navigation restores draft without sending or calling`, async t => {
  const f = fixture(t); f.input('A draft for either intent'); mode === 'text' ? f.send() : f.mic();
  const snapshot = f.returnSnapshot(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  const root = f.c.shadowRoot;
  assert.equal(root.querySelector('textarea').value, 'A draft for either intent');
  assert.equal(root.activeElement, root.querySelector(mode === 'voice' ? '.composer-mic' : 'textarea'));
  assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  if (mode === 'text') { f.send(); await tick(); assert.equal(f.sends.length, 1); }
});
for (const [mode, ttl] of [['text', 180_000], ['voice', 60_000]]) {
  for (const elapsed of [ttl - 1, ttl]) test(`AIT-506: ${mode} draft at ${elapsed}ms has its real TTL`, async t => {
    const f = fixture(t); f.input('Bounded draft'); mode === 'text' ? f.send() : f.mic();
    const record = JSON.parse(sessionStorage.getItem('aithema-start-intent'));
    assert.equal(record.expiresAt - Date.now(), ttl);
    const snapshot = f.returnSnapshot(); f.advance(elapsed);
    f.configure(document.createElement('aithema-session'), snapshot); await tick();
    assert.equal(f.c.shadowRoot.querySelector('textarea').value, elapsed < ttl ? 'Bounded draft' : '');
    assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  });
  test(`AIT-506: copied ${mode} intent refuses the draft with a live tabId owner`, async t => {
    const f = fixture(t); f.input('Private draft'); mode === 'text' ? f.send() : f.mic();
    const snapshot = f.returnSnapshot();
    t.mock.method(globalThis, 'BroadcastChannel', function () { return { unref() {}, close() {}, postMessage(data) {
      if (data.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: { ...data, type: 'pong' } }));
    } }; });
    f.configure(document.createElement('aithema-session'), snapshot); await tick();
    assert.equal(f.c.shadowRoot.querySelector('textarea').value, '');
    assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  });
}
for (const action of ['withdrawal', 'erasure', 'new-session']) test(`AIT-506: ${action} clears the pending draft and lock`, async t => {
  const f = fixture(t); f.input('Do not retain'); f.send();
  assert.ok(sessionStorage.getItem('aithema-start-intent'));
  if (action === 'withdrawal') f.c.receive({ seq: f.c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
  if (action === 'erasure') f.c.receive({ seq: f.c.session.seq + 1, type: 'session.erased', data: { at: new Date(Date.now()).toISOString() } });
  if (action === 'new-session') { const snapshot = f.c.session; snapshot.id = 'new-session'; f.configure(f.c, snapshot); }
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  assert.equal(f.c.shadowRoot.querySelector('textarea')?.value ?? '', '');
  await f.grant(); assert.equal(f.sends.length, 0);
});

test('AIT-506: real adapter admission precedes denied permission and settles zero charge', async t => {
  const trace = [], reports = [];
  const local = voiceFixture({ now: () => Date.now(), prepareCall: async () => { trace.push('admission'); },
    providerDetails: id => ({ conversation_id: id, status: 'done', metadata: { call_duration_secs: 0, cost: 0 } }) });
  const client = createElevenLabsClient({ sdk: local.sdk, AudioContext: local.sdk.AudioContext,
    mediaDevices: { async getUserMedia() { trace.push('permission'); throw Object.assign(new Error('fixture blocked'), { name: 'NotAllowedError' }); } },
    control: { ...local.control, start: (request, options) => local.control.start(request, invocationOptions({ ...options, report: value => reports.push(value) })) },
    persistEvent: async () => {} });
  // The SDK fixture acquires through its own mediaDevices, as the browser SDK does.
  local.sdk.mediaDevices.getUserMedia = async () => { trace.push('permission'); throw Object.assign(new Error('fixture blocked'), { name: 'NotAllowedError' }); };
  const f = fixture(t, { client }); f.c.addEventListener('aithema-consent', () => trace.push('consent'));
  f.mic(); assert.deepEqual(trace, ['consent']); await f.grant();
  assert.deepEqual(trace, ['consent', 'admission', 'permission']);
  assert.equal(reports.length, 1); assert.equal(reports[0].chargedMicro, 0);
  assert.equal(reports[0].usage.visitorMicro, 0);
  assert.equal(f.c.shadowRoot.querySelector('textarea').disabled, false);
});

for (const mode of ['text', 'voice']) test(`AIT-506: ${mode} return without a grant restores a draft and consumes the intent`, async t => {
  const f = fixture(t); f.input('Keep this after Back'); mode === 'text' ? f.send() : f.mic();
  const snapshot = f.returnSnapshot(false); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  const root = f.c.shadowRoot;
  assert.equal(root.querySelector('textarea').value, 'Keep this after Back');
  assert.equal(root.querySelector('textarea').readOnly, false);
  assert.equal(root.activeElement, root.querySelector(mode === 'voice' ? '.composer-mic' : 'textarea'));
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  await f.grant();
  assert.equal(f.sends.length, 0, 'a later grant has no pending Send');
  assert.equal(f.starts.length, 0, 'a later grant has no pending call');
});
