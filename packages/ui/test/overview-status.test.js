import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { applyEvent, createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const { HostSurface } = await import('../src/host-surface.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(copy, options = {}) {
  const session = createSession({ demo: true, locale: copy.display.locale });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  session.transcript = [{ id: 'u', role: 'user', content: 'A project' }, { id: 'a', role: 'assistant', content: 'Tell me more', inputRevision: inputRevision(session) }];
  Object.assign(session.understanding, { readinessAssessed: true, inputRevision: inputRevision(session), summary: 'A project', draft: false });
  session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
  const c = document.createElement('aithema-session'); c.configure({ copy, session, ...options }); return c;
}
function event(c, type, data) { c.receive({ ...(type === 'lane.status' ? {} : { seq: c.session.seq + 1 }), type, data }); }
for (const [copy, current, idle] of [[en, 'Up to date', 'Showing the latest overview.'], [de, 'Auf dem neuesten Stand', 'Der letzte Stand des Überblicks wird angezeigt.']]) {
  test(`AIT-504 ${copy.display.locale}: named slot is current, pending, reaction first, understanding later, then idle with Retry`, () => {
    const c = setup(copy), root = c.shadowRoot, notice = root.querySelector('.notice');
    assert.equal(notice.getAttribute('aria-label'), copy.display.locale === 'de' ? 'Überblickstatus' : 'Overview status');
    assert.equal(notice.querySelector('.notice-text').textContent, current);
    event(c, 'turn.final', { id: 'next', role: 'user', content: 'More details' });
    assert.equal(notice.querySelector('.notice-text').textContent, copy.stale);
    const revision = inputRevision(c.session);
    const announcement = notice.querySelector('.notice-text').firstChild;
    event(c, 'lane.status', { inputRevision: revision, running: ['reaction'], failures: [], lastFailure: null });
    assert.equal(notice.querySelector('.notice-text').textContent, copy.stale);
    assert.equal(root.querySelector('.overview-retry').hidden, true);
    assert.equal(notice.querySelector('.notice-text').firstChild, announcement);
    event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: revision });
    event(c, 'lane.status', { inputRevision: revision, running: ['reaction'], failures: [], lastFailure: null });
    assert.equal(notice.querySelector('.notice-text').textContent, copy.stale, 'the current reply still owes understanding');
    event(c, 'lane.status', { inputRevision: revision, running: ['understanding'], failures: [], lastFailure: null });
    assert.equal(notice.querySelector('.notice-text').firstChild, announcement, 'announce Updating once across the handoff');
    event(c, 'lane.status', { inputRevision: revision, running: [], failures: [], lastFailure: null });
    assert.equal(root.querySelector('.overview-retry').hidden, false);
    c.remove();
  });
  test(`AIT-504 ${copy.display.locale}: old bundles get nonempty shipped statuses`, () => {
    const old = structuredClone(copy); delete old.overviewCurrent; delete old.staleIdle;
    const c = setup(old); assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, current);
    event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
    event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
    event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null });
    assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, idle); c.remove();
  });
}
for (const copy of [en, de]) {
  test(`AIT-504 N7 ${copy.display.locale}: current status preserves a host's final override`, () => {
    for (const omitNew of [false, true]) {
      const host = structuredClone(copy); host.final = 'Host current assessment';
      if (omitNew) delete host.overviewCurrent;
      const c = setup(host), notice = c.shadowRoot.querySelector('.notice');
      assert.equal(notice.querySelector('.notice-text').textContent, 'Host current assessment');
      assert.equal(notice.hasAttribute('data-current'), true, 'current state does not depend on copy');
      c.remove();
    }
    const host = { ...copy, final: 'Host current assessment', overviewCurrent: 'Host current status' };
    const c = setup(host);
    assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Host current status'); c.remove();
  });
  test(`AIT-504 N7 ${copy.display.locale}: idle status is independent of a host's Updating override`, () => {
    for (const omitNew of [false, true]) {
      const host = structuredClone(copy); host.stale = 'Host previous assessment';
      if (omitNew) delete host.staleIdle;
      const c = setup(host), notice = c.shadowRoot.querySelector('.notice');
      event(c, 'turn.final', { id: 'next', role: 'user', content: 'More details' });
      assert.equal(notice.querySelector('.notice-text').textContent, 'Host previous assessment');
      event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
      event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null });
      assert.equal(notice.querySelector('.notice-text').textContent, copy.staleIdle);
      assert.equal(notice.hasAttribute('data-current'), false);
      c.configure({ copy: { ...host, staleIdle: 'Host idle status' }, session: c.session });
      assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Host idle status'); c.remove();
    }
  });
}
test('AIT-504 pending expires at 18 seconds with one snapshot GET and no POST', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en), reads = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    reads.push({ url: String(url), method: init.method ?? 'GET' });
    return Response.json({ ...c.session, operations: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
  t.mock.timers.tick(17_999); await flush(); assert.equal(reads.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(reads.filter(r => /\/api\/sessions\/[^/]+$/.test(r.url)).length, 1);
  assert.ok(reads.every(r => r.method === 'GET'));
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Showing the latest overview.');
  t.mock.timers.tick(60_000); await flush(); assert.equal(reads.filter(r => /\/api\/sessions\/[^/]+$/.test(r.url)).length, 1);
  c.remove();
});

test('AIT-504 pending → authoritative understanding status retains the same live text node', () => {
  const c = setup(en), label = c.shadowRoot.querySelector('.notice-text');
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  const announcement = label.firstChild;
  event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: ['understanding'], failures: [], lastFailure: null });
  assert.equal(label.firstChild, announcement, 'no new live-region mutation for the same Updating notice');
  assert.equal(label.textContent, en.stale);
  c.remove();
});
for (const finish of ['status', 'disconnect', 'reconfigure']) test(`AIT-504 pending snapshot is cancelled by ${finish}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en), snapshots = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    snapshots.push(String(url)); return Response.json(c.session);
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  if (finish === 'status') event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: ['understanding'], failures: [], lastFailure: null });
  if (finish === 'disconnect') c.remove();
  if (finish === 'reconfigure') c.configure({ copy: en, session: c.session });
  t.mock.timers.tick(18_000); await flush(); assert.equal(snapshots.length, 0);
  c.remove();
});
test('AIT-504 explicit host values win and an empty new status uses the active locale', () => {
  const custom = { ...en, overviewCurrent: 'Host current' };
  const c = setup(custom); assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Host current');
  const session = c.session; session.locale = 'de';
  session.understanding.inputRevision = session.operations.inputRevision = inputRevision(session);
  session.transcript.at(-1).inputRevision = inputRevision(session);
  c.configure({ copy: { ...de, overviewCurrent: '' }, session });
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Auf dem neuesten Stand'); c.remove();
});

test('AIT-504 detached pending elements cannot leak snapshot reads into a later session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en), reads = [];
  t.mock.method(globalThis, 'fetch', async url => { reads.push(String(url)); return Response.json(c.session); });
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  t.mock.timers.tick(18_000); await flush(); assert.equal(reads.length, 0);
  c.remove();
});

for (const copy of [en, de]) test(`AIT-504 ${copy.display.locale}: deferred work cannot hide a later authoritative overview failure`, () => {
  const c = setup(copy);
  event(c, 'turn.final', { id: 'extra', role: 'user', content: 'More project details' });
  event(c, 'turn.final', { id: 'extra-reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
  const revision = inputRevision(c.session);
  event(c, 'lane.status', { inputRevision: revision, running: [], failures: [], lastFailure: null });
  c.receive({ type: 'lane.failed', data: { inputRevision: revision, lane: 'understanding', reason: 'budget reconciling' } });
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, copy.staleIdle,
    'local reconciliation is not an authoritative running understanding job');
  c.receive({ type: 'lane.failed', data: { inputRevision: revision, lane: 'understanding', error: 'reasoning-unavailable' } });
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, copy.understandingFailed);
  assert.equal(c.shadowRoot.querySelector('.overview-retry').hidden, false);
  c.remove();
});

for (const copy of [en, de]) test(`AIT-504 ${copy.display.locale}: consent Review is the only overview action`, () => {
  const c = setup(copy), session = c.session;
  session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
  c.configure({ copy, session });
  event(c, 'turn.final', { id: 'extra', role: 'user', content: 'More project details' });
  event(c, 'turn.final', { id: 'extra-reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
  event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null });
  assert.equal(c.shadowRoot.querySelector('.overview-retry').hidden, true);
  assert.equal(c.shadowRoot.querySelector('.notice').querySelectorAll('button:not([hidden])').length, 1);
  c.remove();
});

for (const copy of [en, de]) test(`AIT-504 ${copy.display.locale}: settled denial cannot retain a local Updating notice`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const c = setup(copy), calls = [];
  t.after(() => c.remove());
  let reason = 'budget reconciling';
  const matrix = () => ({ best: { text: { available: false, reason }, analysis: { available: false, reason } } });
  c.configure({ copy, session: { ...c.session, featureMatrix: matrix() } });
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return Response.json({ ...c.session, featureMatrix: matrix() });
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'extra', role: 'user', content: 'More project details' });
  event(c, 'turn.final', { id: 'extra-reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
  const revision = inputRevision(c.session);
  event(c, 'lane.status', { inputRevision: revision, running: [], failures: [], lastFailure: null });
  c.receive({ type: 'lane.failed', data: { inputRevision: revision, lane: 'understanding', reason } });
  reason = 'budget denied';
  c.receive({ type: 'voice.state', data: { state: 'ended' } });
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(c.session.featureMatrix.best.analysis.reason, reason);
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, copy.reasons[reason]);
  assert.equal(c.shadowRoot.querySelector('.overview-retry').hidden, true);
  assert.ok(calls.every(call => call.method === 'GET'), 'status rendering cannot start paid work');
});

for (const copy of [en, de]) test(`AIT-504 ${copy.display.locale}: first assessment preserves the host preparingOverview role`, () => {
  const c = setup({ ...copy, preparingOverview: 'Host preparing' }), session = c.session;
  session.understanding.readinessAssessed = false;
  c.configure({ copy: { ...copy, preparingOverview: 'Host preparing' }, session });
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  event(c, 'lane.status', { inputRevision: inputRevision(c.session), running: ['understanding'], failures: [] });
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Host preparing');
  c.remove();
});

for (const changeLocale of [false, true]) test(`AIT-504 ahead snapshot fully restores a stalled partial, pause and settings without reconnecting; locale change ${changeLocale}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let streamingState;
  const updateStreaming = HostSurface.prototype.updateStreaming;
  t.mock.method(HostSurface.prototype, 'updateStreaming', function () {
    if (this.verification && this.emailAsk) streamingState = { replyInFlight: this.verification.streaming(), streaming: this.emailAsk.streaming() };
    return updateStreaming.call(this);
  });
  const c = setup(en, { copyForLocale: locale => ({ en, de })[locale], host: { verification: true, credits: true } }), calls = [];
  let snapshot;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (!/\/api\/sessions\/[^/]+$/.test(String(url))) return Response.json({}, { status: 404 });
    return Response.json(snapshot ?? c.session);
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  const streamedRevision = inputRevision(c.session), finishedSeq = c.session.seq + 1;
  c.receive({ type: 'turn.partial', data: { id: 'finished', delta: 'Partial reply', inputRevision: inputRevision(c.session) } });
  assert.deepEqual(streamingState, { streaming: true, replyInFlight: true });
  snapshot = c.session;
  for (const [type, data] of [
    ['turn.final', { id: 'finished', role: 'assistant', content: 'Finished reply', inputRevision: inputRevision(snapshot) }],
    ...(changeLocale ? [['session.locale-changed', { locale: 'de' }]] : []),
    ['session.paused', { paused: true }],
    ['settings.changed', { processingPreset: 'device', settings: { ...snapshot.settings, revision: snapshot.settings.revision + 1, model: 'recovered-model' } }],
  ]) snapshot = applyEvent(snapshot, { seq: snapshot.seq + 1, type, data });
  snapshot.operations = { inputRevision: inputRevision(snapshot), running: [], failures: [], lastFailure: null };
  const streams = calls.filter(call => call.url.endsWith('/events')).length;
  t.mock.timers.tick(18_000); await flush(); await flush();
  const rows = [...c.shadowRoot.querySelectorAll('.turn')].filter(n => n.dataset.id === 'finished');
  assert.equal(rows.length, 1, 'finished reply replaces its partial, never duplicate nodes');
  assert.match(rows[0].textContent, /Finished reply/);
  assert.doesNotMatch(c.shadowRoot.querySelector('.transcript-shell ol').textContent, /Partial reply/);
  assert.equal(c.session.locale, changeLocale ? 'de' : 'en');
  const copy = changeLocale ? de : en;
  assert.equal(c.shadowRoot.querySelector('#understanding-title').textContent, copy.understanding);
  assert.equal(c.session.paused, true);
  assert.equal(c.shadowRoot.querySelector('.composer-resume').textContent, copy.resume);
  assert.equal(c.session.settings.model, 'recovered-model');
  assert.equal(c.shadowRoot.querySelector('.export').getAttribute('aria-disabled'), 'true', 'renderMode follows the skipped processing change');
  assert.deepEqual(streamingState, { streaming: false, replyInFlight: false });
  // The original stream can resume behind the snapshot cursor. Its durable
  // final is now a replay, so it cannot clean up a reopened transient partial.
  c.receive({ type: 'turn.partial', data: { id: 'finished', delta: 'Queued old stream tail', inputRevision: streamedRevision } });
  c.receive({ seq: finishedSeq, type: 'turn.final', data: { id: 'finished', role: 'assistant', content: 'Finished reply', inputRevision: streamedRevision } });
  assert.equal([...c.shadowRoot.querySelectorAll('.turn')].filter(n => n.dataset.id === 'finished').length, 1, 'queued fragments cannot reopen a finalized snapshot turn');
  assert.doesNotMatch(c.shadowRoot.querySelector('.transcript-shell ol').textContent, /Queued old stream tail/);
  assert.deepEqual(streamingState, { streaming: false, replyInFlight: false });
  assert.equal(calls.filter(call => call.url.endsWith('/events')).length, streams, 'no reconnect can schedule work');
  assert.ok(calls.every(call => call.method === 'GET'));
  c.remove();
});

test('AIT-504 same-sequence snapshot applies operations only', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en);
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    return Response.json({ ...c.session, paused: true, understanding: { ...c.session.understanding, summary: 'Unjournaled state' }, operations: { inputRevision: inputRevision(c.session), running: ['understanding'], failures: [] } });
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  t.mock.timers.tick(18_000); await flush();
  assert.equal(c.session.locale, 'en'); assert.equal(c.session.paused, false);
  assert.equal(c.session.understanding.summary, 'A project');
  assert.deepEqual(c.session.operations.running, ['understanding']);
  c.remove();
});

test('AIT-504 one snapshot read cannot flash idle before its response settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en), pending = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    return pending.promise;
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) });
  const text = c.shadowRoot.querySelector('.notice-text'), announcement = text.firstChild;
  t.mock.timers.tick(18_000); await flush();
  assert.equal(text.textContent, en.stale, 'status is still unreported while the one read is in flight');
  assert.equal(text.firstChild, announcement);
  assert.equal(c.shadowRoot.querySelector('.overview-retry').hidden, true);
  pending.resolve(Response.json({ ...c.session, operations: { inputRevision: inputRevision(c.session), running: [], failures: [] } }));
  await flush(); assert.equal(text.textContent, en.staleIdle);
  c.remove();
});


test('AIT-504 ahead snapshot fences a superseded mid-reply settings revision with no final', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let streamingState;
  const updateStreaming = HostSurface.prototype.updateStreaming;
  t.mock.method(HostSurface.prototype, 'updateStreaming', function () {
    if (this.verification && this.emailAsk) streamingState = { replyInFlight: this.verification.streaming(), streaming: this.emailAsk.streaming() };
    return updateStreaming.call(this);
  });
  const c = setup(en, { host: { verification: true, credits: true } });
  let snapshot;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    return Response.json(snapshot ?? c.session);
  });
  t.after(() => c.remove());
  document.body.append(c); await flush();
  event(c, 'turn.final', { id: 'next', role: 'user', content: 'More' });
  const revision = inputRevision(c.session), settingsRevision = c.session.settings.revision;
  c.receive({ type: 'turn.partial', data: { id: 'superseded', delta: 'Old partial', inputRevision: revision, settingsRevision } });
  assert.deepEqual(streamingState, { streaming: true, replyInFlight: true });
  // The stream stalls before the settings event. The server cancels this reply
  // without a final and the bounded GET sees the settings change first.
  const settingsEvent = { seq: c.session.seq + 1, type: 'settings.changed', data: {
    processingPreset: c.session.processingPreset, settings: { ...c.session.settings, revision: settingsRevision + 1, model: 'replacement-model' },
  } };
  snapshot = applyEvent(c.session, settingsEvent);
  snapshot = applyEvent(snapshot, { seq: snapshot.seq + 1, type: 'turn.final', data: {
    id: 'replacement-final', role: 'assistant', content: 'Replacement completed',
    inputRevision: inputRevision(snapshot), settingsRevision: settingsRevision + 1,
  } });
  snapshot.operations = { inputRevision: inputRevision(snapshot), running: [], failures: [], lastFailure: null };
  t.mock.timers.tick(18_000); await flush(); await flush();
  assert.equal(c.session.settings.revision, settingsRevision + 1);
  assert.deepEqual(streamingState, { streaming: false, replyInFlight: false });
  c.receive(settingsEvent); // Replayed at the snapshot cursor: dropped.
  c.receive({ type: 'turn.partial', data: { id: 'superseded', delta: 'Ghost tail', inputRevision: revision, settingsRevision } });
  assert.doesNotMatch(c.shadowRoot.querySelector('.transcript-shell ol').textContent, /Old partial|Ghost tail/);
  assert.equal(c.shadowRoot.querySelector('[data-id="superseded"]'), null);
  assert.deepEqual(streamingState, { streaming: false, replyInFlight: false });
  c.receive({ type: 'turn.partial', data: { id: 'replacement', delta: 'New reply', inputRevision: inputRevision(c.session), settingsRevision: settingsRevision + 1 } });
  assert.match(c.shadowRoot.querySelector('.transcript-shell ol').textContent, /New reply/);
  assert.deepEqual(streamingState, { streaming: true, replyInFlight: true });
});
