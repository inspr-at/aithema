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
function fixture(t, { granted = false, entrance = 'combined', active = true, client, refreshGranted = true } = {}) {
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
    if (url.endsWith('/withdraw')) return Response.json({ event: { seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: JSON.parse(options.body).turnId, reason: 'withdrawal', at: new Date(Date.now()).toISOString() } } });
    if (url.endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: [], features: {} });
    const snapshot = c.session;
    if (refreshGranted) snapshot.featureMatrix.best = { text: allowed, voice: allowed, analysis: allowed };
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
test('AIT-506: shared opener renders once before input and persists in the same row', t => {
  const f = fixture(t), source = f.c.session;
  source.opener = { text: 'Welcome from a host.', locale: source.locale };
  f.configure(f.c, source);
  const root = f.c.shadowRoot, selector = '[data-id="host:opener"]';
  assert.equal(root.querySelectorAll(selector).length, 1, 'one shared render-only row');
  const row = root.querySelector(selector);
  assert.equal(f.c.session.transcript.length, 0);
  assert.equal(root.querySelector('.workspace').dataset.understanding, 'absent');
  f.c.receive({ seq: 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: source.opener.text } });
  assert.equal(root.querySelectorAll(selector).length, 1);
  assert.equal(root.querySelector(selector), row, 'canonical persistence keeps row identity');
  assert.equal(root.querySelector('.workspace').dataset.understanding, 'absent');
});
for (const boundary of ['history', 'withdrawn', 'erased']) test(`AIT-506: shared opener respects ${boundary} projection boundary`, t => {
  const f = fixture(t), source = f.c.session;
  source.opener = { text: 'Welcome from a host.', locale: source.locale };
  if (boundary === 'history') source.transcript = [{ id: 'prior', role: 'user', content: 'Prior visitor input.' }];
  if (boundary === 'withdrawn') source.consentWithdrawn = true;
  if (boundary === 'erased') source.tombstone = { at: new Date(Date.now()).toISOString() };
  f.configure(f.c, source);
  assert.equal(f.c.shadowRoot.querySelectorAll('[data-id="host:opener"]').length, 0);
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

for (const pending of [false, true]) test(`AIT-506: settings update preserves the field draft, pending consent ${pending}`, async t => {
  const f = fixture(t, { granted: !pending }); f.input('Keep this when choosing processing');
  if (pending) f.send();
  f.c.receive({ seq: f.c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best',
    settings: { ...f.c.session.settings, revision: f.c.session.settings.revision + 1 } } });
  assert.equal(f.c.shadowRoot.querySelector('textarea').value, 'Keep this when choosing processing');
  assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, false);
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null, 'the old revision has no pending intent');
  await f.grant(); assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
});

for (const origin of ['own click', 'server retention', 'other tab']) for (const pending of [false, true]) {
  test(`AIT-506 M1: ${origin} withdrawal ${pending ? 'clears the pending snapshot' : 'preserves an unsent follow-up'}`, async t => {
    const f = fixture(t, { granted: !pending });
    f.c.receive({ seq: f.c.session.seq + 1, type: 'turn.final', data: { id: 'earlier', role: 'user', content: 'Earlier message' } });
    f.input('Unsent follow-up');
    if (pending) { f.send(); assert.ok(sessionStorage.getItem('aithema-start-intent')); }
    if (origin === 'own click') {
      const button = f.c.shadowRoot.querySelector('.turn[data-id="earlier"] .withdraw');
      assert.ok(button); button.click(); await tick();
    } else {
      f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'turn.withdrawn',
        data: { turnId: 'earlier', reason: origin === 'server retention' ? 'expiry' : 'withdrawal', at: new Date(Date.now()).toISOString() } });
    }
    assert.equal(f.c.session.transcript.find(turn => turn.id === 'earlier').withdrawn, true);
    assert.equal(f.c.shadowRoot.querySelector('textarea').value, pending ? '' : 'Unsent follow-up');
    assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, false);
    assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
    await f.grant(); assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  });
}

// Consent settlement is request-scoped: a host may retain callbacks after its UI closes.
for (const mode of ['text', 'voice']) test(`AIT-542: cancelling ${mode} immediately unlocks controls and retains the draft`, async t => {
  const f = fixture(t); f.input('Keep the visitor draft'); mode === 'text' ? f.send() : f.mic();
  const root = f.c.shadowRoot, request = f.events.at(-1);
  assert.equal(typeof request.requestId, 'string'); assert.ok(request.requestId.length > 0);
  assert.equal(typeof request.cancel, 'function');
  assert.equal(root.querySelector('textarea').readOnly, true);
  assert.equal(root.querySelector('.send').disabled, true);
  assert.equal(root.querySelector('.composer-mic').disabled, true);
  request.cancel();
  assert.equal(root.querySelector('textarea').readOnly, false);
  assert.equal(root.querySelector('textarea').value, 'Keep the visitor draft');
  assert.equal(root.querySelector('.send').disabled, false);
  assert.equal(root.querySelector('.composer-mic').disabled, false);
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  request.cancel();
  assert.equal(root.querySelector('textarea').value, 'Keep the visitor draft');
  await f.grant(); assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
});
test('AIT-542: duplicate and stale cancellation cannot cancel the next unique request', t => {
  const f = fixture(t); f.input('First draft'); f.send(); const first = f.events.at(-1);
  first.cancel(); f.input('Next draft'); f.send(); const second = f.events.at(-1);
  assert.notEqual(second.requestId, first.requestId);
  first.cancel();
  assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, true);
  assert.equal(JSON.parse(sessionStorage.getItem('aithema-start-intent')).draft, 'Next draft');
  second.cancel(); second.cancel();
  assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, false);
  assert.equal(f.c.shadowRoot.querySelector('textarea').value, 'Next draft');
});
test('AIT-542: cancel after a grant event cannot interrupt its pending feature refresh', async t => {
  const f = fixture(t); f.input('Granted snapshot'); f.send(); const request = f.events.at(-1);
  const granting = f.grant(); request.cancel(); await granting;
  assert.deepEqual(f.sends.map(s => s.content), ['Granted snapshot']);
  f.input('A newer draft'); request.cancel();
  assert.equal(f.c.shadowRoot.querySelector('textarea').value, 'A newer draft');
  assert.equal(f.sends.length, 1);
});
for (const [mode, ttl] of [['text', 180_000], ['voice', 60_000]]) {
  test(`AIT-542: an ignored ${mode} request retains its TTL and late cancel is inert`, t => {
    const f = fixture(t); f.input('TTL draft'); mode === 'text' ? f.send() : f.mic();
    const request = f.events.at(-1); f.advance(ttl - 1);
    assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, true);
    assert.equal(f.c.shadowRoot.querySelector('textarea').value, 'TTL draft');
    f.advance(1);
    assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, false);
    assert.equal(f.c.shadowRoot.querySelector('textarea').value, '');
    f.input('Written after expiry'); f.send(); request.cancel();
    assert.equal(f.c.shadowRoot.querySelector('textarea').readOnly, true);
    assert.equal(JSON.parse(sessionStorage.getItem('aithema-start-intent')).draft, 'Written after expiry');
  });
  test(`AIT-542: returning from a consent page without a ${mode} grant settles to idle`, async t => {
    const f = fixture(t, { refreshGranted: false }); f.input('Returned draft'); mode === 'text' ? f.send() : f.mic();
    const request = f.events.at(-1), snapshot = f.returnSnapshot(false);
    f.configure(document.createElement('aithema-session'), snapshot); await tick();
    const root = f.c.shadowRoot;
    assert.equal(root.querySelector('textarea').readOnly, false);
    assert.equal(root.querySelector('textarea').value, 'Returned draft');
    assert.equal(root.querySelector('.send').disabled, false);
    assert.equal(root.querySelector('.composer-mic').disabled, false);
    assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
    assert.equal(f.c.session.consentRevision, snapshot.consentRevision);
    request.cancel(); await f.grant();
    assert.equal(f.sends.length, 0); assert.equal(f.starts.length, 0);
  });
}
