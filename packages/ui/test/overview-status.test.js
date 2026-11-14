import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(copy) {
  const session = createSession({ demo: true, locale: copy.display.locale });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  session.transcript = [{ id: 'u', role: 'user', content: 'A project' }, { id: 'a', role: 'assistant', content: 'Tell me more', inputRevision: inputRevision(session) }];
  Object.assign(session.understanding, { readinessAssessed: true, inputRevision: inputRevision(session), summary: 'A project', draft: false });
  session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
  const c = document.createElement('aithema-session'); c.configure({ copy, session }); return c;
}
function event(c, type, data) { c.receive({ seq: c.session.seq + 1, type, data }); }
for (const [copy, current, idle] of [[en, 'Up to date', 'Showing the latest overview.'], [de, 'Auf dem neuesten Stand', 'Der letzte Stand des Überblicks wird angezeigt.']]) {
  test(`AIT-504 ${copy.display.locale}: named slot is current, pending, understanding-only running, then idle with Retry`, () => {
    const c = setup(copy), root = c.shadowRoot, notice = root.querySelector('.notice');
    assert.equal(notice.getAttribute('aria-label'), copy.display.locale === 'de' ? 'Überblickstatus' : 'Overview status');
    assert.equal(notice.querySelector('.notice-text').textContent, current);
    event(c, 'turn.final', { id: 'next', role: 'user', content: 'More details' });
    assert.equal(notice.querySelector('.notice-text').textContent, copy.stale);
    const revision = inputRevision(c.session);
    event(c, 'lane.status', { inputRevision: revision, running: ['understanding'], failures: [], lastFailure: null });
    assert.equal(notice.querySelector('.notice-text').textContent, copy.stale);
    event(c, 'turn.final', { id: 'reply', role: 'assistant', content: 'Thanks', inputRevision: revision });
    event(c, 'lane.status', { inputRevision: revision, running: ['reaction'], failures: [], lastFailure: null });
    assert.equal(notice.querySelector('.notice-text').textContent, idle, 'another lane cannot claim the overview is updating');
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
test('AIT-504 pending expires at 18 seconds with one snapshot GET and no POST', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const c = setup(en), reads = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    reads.push({ url: String(url), method: init.method ?? 'GET' });
    return Response.json({ ...c.session, operations: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
  });
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
  c.configure({ copy: { ...de, overviewCurrent: '' }, session: { ...c.session, locale: 'de' } });
  assert.equal(c.shadowRoot.querySelector('.notice-text').textContent, 'Auf dem neuesten Stand'); c.remove();
});
