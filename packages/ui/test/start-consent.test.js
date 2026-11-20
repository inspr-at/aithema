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
const tick = () => new Promise(resolve => setTimeout(resolve, 450));
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
  const configure = (next = c, snapshot = session, extra = {}) => { c = next; c.configure({ ...options, ...extra, session: snapshot }); document.body.append(c); return c; };
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
    revise() { c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, changed: ['text', 'voice'], removed: [] } }); },
    async grant() { this.revise(); await tick(); },
    set covering(value) { covering = value; }, set lag(value) { lag = value; } };
}
for (const mode of ['type', 'voice']) test(`AIT-501: ${mode} Start resumes exactly once after a covering refresh`, async t => {
  const f = fixture(t, mode, true), events = [];
  f.c.addEventListener('aithema-consent', e => events.push(e.detail));
  f.start();
  assert.deepEqual(events, [{ sessionId: f.c.session.id, reason: 'ready', features: ['text', 'analysis', 'voice'], intent: 'start', mode, required: [mode === 'voice' ? 'voice' : 'text'], requestId: events[0].requestId, cancel: events[0].cancel }]);
  assert.equal(typeof events[0].requestId, 'string'); assert.ok(events[0].requestId.length > 0);
  assert.equal(typeof events[0].cancel, 'function');
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
  // AIT-574: consent timers run on a virtual clock, so no wall-clock sleep can
  // race the 2 s event deadline. Steps below mirror the loaded CI runner (~2x).
  const clock = consentClock(t), f = fixture(t, 'voice', true); f.start(); f.lag = true;
  f.revise(); await clock.flush();
  assert.ok(clock.has(2000, 'consentTimer'), 'the first event owns the 2 s deadline');
  assert.ok(clock.has(100, 'consentTimer'), 'the lagging ledger is re-read in 100 ms');
  await clock.advance(1000); f.revise(); await clock.flush(); await clock.advance(1000);
  assert.equal(f.starts.length, 0);
  f.lag = false;
  await clock.advance(300); await clock.advance(300);
  assert.equal(f.starts.length, 1);
});
for (const mode of ['type', 'voice']) test(`AIT-501: navigation restores ${mode} once; voice requires Start call`, async t => {
  const clock = consentClock(t), f = fixture(t, mode, true); f.start();
  const snapshot = f.c.session; snapshot.consentRevision++;
  f.c.remove(); const returned = f.configure(document.createElement('aithema-session'), snapshot);
  await tick(); await clock.elapse(2000);
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
  let currentTime = 1_000_000;
  if (action === 'expiry') t.mock.method(Date, 'now', () => currentTime);
  const f = fixture(t, action === 'mode' ? 'voice' : 'type'); f.start();
  if (action === 'expiry') {
    const { expiresAt } = JSON.parse(sessionStorage.getItem('aithema-start-intent'));
    assert.equal(expiresAt, currentTime + 180_000);
    currentTime = expiresAt + 1;
  }
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

test('AIT-501: back/forward cache return never auto-starts voice', async t => {
  const f = fixture(t, 'voice', true); f.start();
  window.dispatchEvent(new window.Event('pagehide'));
  await f.grant();
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.activeElement, f.c.shadowRoot.querySelector('.voice-start'));
});

test('AIT-501: selecting the current mode keeps the matching Start intent', async t => {
  const f = fixture(t, 'voice', true); f.start();
  f.c.shadowRoot.querySelector('.ready__mode[data-mode="voice"]').click();
  await f.grant(); assert.equal(f.starts.length, 1);
});

// Only consent and restored-Start timers are advanced; no wall-clock fixture dates are involved.
function consentClock(t) {
  const timers = new Map(), nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (!['consentTimer', 'startRetryTimer'].includes(callback.name)) return nativeSet(callback, delay, ...args);
    const id = { unref() {} }; timers.set(id, { callback, delay }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => { if (!timers.delete(id)) nativeClear(id); });
  return {
    has(delay, domain) { return [...timers.values()].some(timer => timer.delay === delay && (!domain || timer.callback.name === domain)); },
    async elapse(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay <= delay) { timers.delete(id); timer.callback(); }
        else timer.delay -= delay;
      }
      await tick();
    },
    async next(delay, domain) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay && (!domain || timer.callback.name === domain));
      assert.ok(entry, `pending consent timer at ${delay} ms`);
      timers.delete(entry[0]); entry[1].callback(); await tick();
    },
    // Event-loop turns only (the fetch fixture settles in microtasks): no wall clock.
    async flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); },
    // Virtual time: fire due timers in deadline order (ties in arming order),
    // settling each callback's async work before the next one runs.
    async advance(ms) {
      for (let left = ms; ;) {
        const due = Math.min(...[...timers.values()].map(timer => timer.delay));
        if (!(due <= left)) { for (const timer of timers.values()) timer.delay -= left; return; }
        for (const timer of timers.values()) timer.delay -= due;
        left -= due;
        for (const [id, timer] of [...timers]) {
          if (timer.delay > 0 || !timers.has(id)) continue;
          timers.delete(id); timer.callback(); await this.flush();
        }
      }
    } };
}
for (const mode of ['type', 'voice']) test(`AIT-501 v2.2: open/adopt/configure consumes the granted ${mode} snapshot without an event or GET`, async t => {
  const f = fixture(t, mode, true); f.start();
  const snapshot = f.c.session;
  snapshot.seq += 3; snapshot.consentRevision++;
  snapshot.settings.voice = 'fixture-voice'; // text intent must win over the default voice mode.
  snapshot.featureMatrix.best = { text: allowed, voice: allowed, analysis: allowed };
  f.c.remove();
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/events')) return new Response(new ReadableStream());
    throw new Error('no reconnect, credit change or feature GET on this return');
  });
  f.configure(document.createElement('aithema-session'), snapshot, { voiceClient: {} }); await tick();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.activeElement, f.c.shadowRoot.querySelector(mode === 'voice' ? '.voice-start' : 'textarea'));
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
  f.c.remove(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false, 'reload cannot reuse a consumed intent');
});
for (const covers of [true, false]) test(`AIT-501 v2.2: configure blocked snapshot uses 2/4/8 backoff, final coverage ${covers}`, async t => {
  const clock = consentClock(t), f = fixture(t); f.start(); f.covering = false;
  const snapshot = f.c.session; snapshot.consentRevision++;
  f.c.remove(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
  await clock.next(2000); await clock.next(4000);
  f.covering = covers; await clock.next(8000);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, covers);
  f.covering = true; await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, covers, 'exhaustion must clear the intent');
});
for (const covers of [true, false]) test(`AIT-501 gate1: verified overview stays normal throughout restored Start backoff, final coverage ${covers}`, async t => {
  const clock = consentClock(t), f = fixture(t); f.start(); f.covering = false;
  const snapshot = f.c.session; snapshot.consentRevision++;
  f.c.remove(); f.configure(document.createElement('aithema-session'), snapshot);
  const root = f.c.shadowRoot, samples = [];
  const sample = () => samples.push({ state: root.querySelector('.concept-access').dataset.state,
    failed: root.querySelector('.concept-access').hasAttribute('data-refresh-failed'),
    announcement: root.querySelector('.concept-withdrawn').textContent });
  const observer = new window.MutationObserver(sample);
  observer.observe(root.querySelector('.concept-access'), { subtree: true, childList: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  await tick(); sample();
  for (const delay of [2000, 4000, 8000]) {
    if (delay === 8000) f.covering = covers;
    await clock.next(delay); sample();
  }
  assert.equal(root.querySelector('.intro').hidden, covers, 'only a covering grant resumes Start');
  assert.ok(samples.length >= 4);
  assert.ok(samples.every(s => s.state !== 'gone' && !s.failed && s.announcement === ''),
    `a verified consent document must never announce Concept withdrawn: ${JSON.stringify(samples)}`);
});
test('AIT-501 v2.2: unrelated refreshes do not settle a pending Start', async t => {
  const f = fixture(t); f.covering = false; f.start();
  // pageshow and a pause acknowledgement both refresh features, without a consent window.
  window.dispatchEvent(new window.Event('pageshow')); await tick();
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } }); await tick();
  assert.ok(sessionStorage.getItem('aithema-start-intent'));
  f.covering = true; await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
});
test('AIT-501 v2.2: storage exists inside the navigating host listener and clears on Review', t => {
  const f = fixture(t); let record;
  f.c.addEventListener('aithema-consent', event => {
    if (event.detail.intent === 'start') record = JSON.parse(sessionStorage.getItem('aithema-start-intent'));
  });
  f.start(); assert.equal(record.sessionId, f.c.session.id);
  f.c.shadowRoot.querySelector('.ready__consent').click();
  assert.equal(sessionStorage.getItem('aithema-start-intent'), null);
});
test('AIT-501 v2.2: voice intent expires after 60 seconds', async t => {
  let currentTime = 1_000_000;
  t.mock.method(Date, 'now', () => currentTime);
  const f = fixture(t, 'voice', true);
  currentTime += 10; // Model work between the test's capture and the intent write.
  f.start();
  assert.ok(JSON.parse(sessionStorage.getItem('aithema-start-intent')).expiresAt <= Date.now() + 60_000);
  const { expiresAt } = JSON.parse(sessionStorage.getItem('aithema-start-intent'));
  assert.equal(expiresAt, currentTime + 60_000);
  currentTime = expiresAt + 1; await f.grant();
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
});
for (const [boundary, offset, starts] of [['just before', -1, 1], ['at', 0, 0]]) test(`AIT-501 v2.2: voice intent ${boundary} the 60-second deadline`, async t => {
  let currentTime = 1_000_000;
  t.mock.method(Date, 'now', () => currentTime);
  const f = fixture(t, 'voice', true); f.start();
  const { expiresAt } = JSON.parse(sessionStorage.getItem('aithema-start-intent'));
  assert.equal(expiresAt, currentTime + 60_000);
  currentTime = expiresAt + offset; await f.grant();
  assert.equal(f.starts.length, starts);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, starts === 1);
});
for (const mode of ['type', 'voice']) test(`AIT-501 v2.2: copied tab storage cannot auto-start ${mode}`, async t => {
  const f = fixture(t, mode, true); f.start();
  const snapshot = f.c.session; snapshot.consentRevision++;
  snapshot.featureMatrix.best = { text: allowed, voice: allowed, analysis: allowed };
  f.c.remove();
  // A live source tab answers the same identity ping used by the voice journal.
  t.mock.method(globalThis, 'BroadcastChannel', function () { return {
    unref() {}, close() {},
    postMessage(data) { if (data.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: { ...data, type: 'pong' } })); },
  }; });
  f.configure(document.createElement('aithema-session'), snapshot); await tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, mode === 'voice');
  if (mode === 'voice') assert.equal(f.c.shadowRoot.activeElement, f.c.shadowRoot.querySelector('.voice-start'));
});

async function restoredBackoff(t, mode = 'voice') {
  const clock = consentClock(t), f = fixture(t, mode, true);
  f.start(); f.covering = false;
  const snapshot = f.c.session; snapshot.consentRevision++;
  f.c.remove(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  return { clock, f };
}
function normalOverview(c) {
  const root = c.shadowRoot, access = root.querySelector('.concept-access');
  assert.notEqual(access.dataset.state, 'gone', 'overview remains available');
  assert.equal(access.hasAttribute('data-refresh-failed'), false, 'no failed consent projection');
  assert.equal(root.querySelector('.concept-withdrawn').textContent, '', 'no Concept withdrawn announcement');
}
function snapshotOutcome(t, f, outcome) {
  const original = globalThis.fetch.bind(globalThis);
  let release, reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/events') || url.endsWith('/consent')) return original(url, options);
    reads++;
    if (outcome === '409') return new Response(null, { status: 409 });
    if (outcome === 'slow') await new Promise(resolve => { release = resolve; });
    if (outcome === 'stale') { const snapshot = f.c.session; snapshot.seq--; return Response.json(snapshot); }
    return original(url, options);
  });
  return { release() { assert.ok(release, 'snapshot read is pending'); release(); }, get reads() { return reads; } };
}
for (const outcome of ['stale', '409', 'slow']) test(`AIT-501 gate2: ${outcome} during restored Start retry preserves verified overview`, async t => {
  const { clock, f } = await restoredBackoff(t), read = snapshotOutcome(t, f, outcome);
  await clock.next(2000);
  if (outcome === 'slow') { await clock.elapse(2101); normalOverview(f.c); read.release(); await tick(); }
  normalOverview(f.c);
  assert.ok(read.reads > 0);
  assert.ok(clock.has(4000), 'retry outcome uses the next Start backoff');
});
for (const outcome of ['stale', '409', 'slow']) test(`AIT-501 gate2: ${outcome} refresh after restored Start exhaustion behaves like main`, async t => {
  const { clock, f } = await restoredBackoff(t);
  for (const delay of [2000, 4000, 8000]) await clock.next(delay);
  const read = snapshotOutcome(t, f, outcome);
  f.c.receive({ seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } }); await tick();
  if (outcome === 'slow') { await clock.elapse(2101); normalOverview(f.c); read.release(); await tick(); }
  normalOverview(f.c);
  assert.equal(clock.has(2000), false, 'ordinary refresh has no inherited consent watchdog');
  assert.equal(clock.has(4000), false);
  assert.equal(clock.has(8000), false);
});
test('AIT-501 gate2: switching to typing clears Start backoff and a later grant owns its deadline and ledger wait', async t => {
  const { clock, f } = await restoredBackoff(t);
  f.c.shadowRoot.querySelector('.ready__mode[data-mode="type"]').click();
  assert.equal(clock.has(2000), false, 'switching mode removes the restored Start window and its retry');
  f.lag = true;
  f.c.receive({ seq: f.c.session.seq + 1, type: 'consent.revised', data: { granted: true, changed: ['text'], removed: [] } }); await tick();
  normalOverview(f.c);
  assert.ok(clock.has(2000), 'later consent event has a new verification deadline');
  assert.ok(clock.has(100), 'new scoped grant waits for the host ledger');
  f.lag = false; f.covering = true; await clock.next(100);
  normalOverview(f.c);
  assert.equal(clock.has(2000), false, 'verified document clears the new deadline');
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false, 'cleared Start is never resumed');
});

for (const outcome of ['409', 'slow', 'stale']) test(`AIT-501 gate3: grant during restored backoff gets its own full retry budget after ${outcome}`, async t => {
  const { clock, f } = await restoredBackoff(t);
  await clock.next(2000); await clock.next(4000);
  const original = globalThis.fetch.bind(globalThis);
  let fault = outcome, release, reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!url.endsWith(`/api/sessions/${f.c.session.id}`)) return original(url, options);
    reads++;
    if (fault === '409') return new Response(null, { status: 409 });
    if (fault === 'stale') { const snapshot = f.c.session; snapshot.seq--; return Response.json(snapshot); }
    if (fault === 'slow') await new Promise(resolve => { release = resolve; });
    return original(url, options);
  });
  f.c.openSettings(); f.covering = true;
  await f.grant();
  if (outcome === 'slow') await clock.elapse(2101);
  if (outcome === 'stale') assert.equal(reads, 2, 'one immediate stale retry belongs to the new consent window');
  assert.equal(f.c.shadowRoot.querySelector('.concept-access').hasAttribute('data-refresh-failed'), true);
  assert.ok(clock.has(2000, 'consentTimer'), 'grant owns a fresh 2 second retry');
  // Keep failing through 2 and 4 seconds, then recover on the grant's 8 second retry.
  fault = '409';
  await clock.next(2000, 'consentTimer');
  assert.ok(clock.has(4000, 'consentTimer'));
  if (clock.has(8000, 'startRetryTimer')) await clock.next(8000, 'startRetryTimer');
  assert.ok(clock.has(4000, 'consentTimer'), 'Start must not accelerate or spend the consent retry budget');
  await clock.next(4000, 'consentTimer');
  assert.ok(clock.has(8000, 'consentTimer'));
  fault = null;
  await clock.next(8000, 'consentTimer');
  if (release) { release(); await tick(); }
  normalOverview(f.c);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true, 'verified later grant consumes the restored intent');
  assert.equal(f.starts.length, 0, 'navigation never starts voice automatically');
});
test('AIT-501 gate3: ledger lag after a grant during backoff has an absolute event deadline', async t => {
  const { clock, f } = await restoredBackoff(t);
  await clock.next(2000); await clock.next(4000);
  f.lag = true; f.covering = true; await f.grant();
  assert.ok(clock.has(2000, 'consentTimer'), 'deadline begins at the event');
  assert.ok(clock.has(100, 'consentTimer'), 'grant waits for its ledger');
  await clock.elapse(1900); normalOverview(f.c);
  assert.ok(clock.has(100, 'consentTimer'), 'ledger polling does not extend the remaining deadline');
  await clock.elapse(100);
  assert.equal(f.c.shadowRoot.querySelector('.concept-access').hasAttribute('data-refresh-failed'), true, 'fails closed exactly 2 seconds after the event');
  assert.ok(clock.has(2000, 'consentTimer'), 'failure owns its full recovery budget');
  f.lag = false; await clock.next(2000, 'consentTimer'); normalOverview(f.c);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
});
for (const action of ['typing', 'review', 'new-conversation']) test(`AIT-501 gate3: ${action} clears only Start timers during an unverified grant`, async t => {
  const { clock, f } = await restoredBackoff(t);
  await clock.next(2000); await clock.next(4000);
  f.lag = true; await f.grant();
  if (action === 'typing') f.c.shadowRoot.querySelector('.ready__mode[data-mode="type"]').click();
  if (action === 'review') f.c.shadowRoot.querySelector('.ready__consent').click();
  if (action === 'new-conversation') { f.c.openSettings(); f.c.shadowRoot.querySelector('.general-new').click(); }
  assert.equal(clock.has(8000), false, 'clearing intent cancels the remaining Start retry');
  assert.ok(clock.has(2000, 'consentTimer'), 'consent deadline survives intent clear');
  assert.ok(clock.has(100, 'consentTimer'), 'ledger polling survives intent clear');
  f.lag = false; f.covering = true; await clock.next(100, 'consentTimer');
  normalOverview(f.c);
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false, 'cleared Start cannot resume');
});
for (const action of ['disconnect', 'reconfigure', 'erasure']) test(`AIT-501 gate3: ${action} stops the independent Start retry`, async t => {
  const { clock, f } = await restoredBackoff(t);
  await clock.next(2000);
  assert.ok(clock.has(4000, 'startRetryTimer'), 'Start owns an independent timer');
  if (action === 'disconnect') f.c.remove();
  if (action === 'reconfigure') f.configure(f.c, f.c.session);
  if (action === 'erasure') f.c.receive({ seq: f.c.session.seq + 1, type: 'session.erased', data: { at: new Date().toISOString() } });
  assert.equal(clock.has(4000, 'startRetryTimer'), false);
  await clock.elapse(16000);
  assert.equal(f.starts.length, 0);
});
test('AIT-501 gate3: restored text starts once through a later consent window', async t => {
  const { clock, f } = await restoredBackoff(t, 'type');
  await clock.next(2000); await clock.next(4000);
  assert.ok(clock.has(8000, 'startRetryTimer'));
  f.lag = true; f.covering = true; await f.grant();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false);
  f.lag = false; await clock.next(100, 'consentTimer');
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, true);
  assert.equal(clock.has(8000, 'startRetryTimer'), false, 'consumption cancels Start retry');
  assert.equal(f.c.shadowRoot.activeElement, f.c.shadowRoot.querySelector('textarea'));
  const snapshot = f.c.session;
  f.c.remove(); f.configure(document.createElement('aithema-session'), snapshot); await tick();
  assert.equal(f.c.shadowRoot.querySelector('.intro').hidden, false, 'consumed intent cannot resume twice');
});
