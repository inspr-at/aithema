import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { conceptProgress } from '../src/concept-view.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(r => setImmediate(r));
function item(id, extra = {}) { return { id, mediaType: 'image/png', width: 480, height: 320, turnIds: ['first'], referenceIds: [], archived: false,
  feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } }, ...extra }; }
function setup(t, { concepts = [item('image1')], copy = en, sessionToken = 'owner-fixture', baseUrl = '' } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  session.transcript = [{ id: 'first', role: 'user', content: 'An API dashboard' }]; session.inputRevision = 1;
  session.concepts = concepts; session.conceptCost = { maxMicro: 1234 }; session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, images: { available: true } } };
  const calls = [], downloads = [], revoked = []; let blobId = 0;
  t.mock.method(URL, 'createObjectURL', () => 'blob:concept-fixture-' + ++blobId); t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { downloads.push({ href: this.href, name: this.download }); });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/image') || url.includes('/image?')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    if (!options.body) return Response.json(c.session);
    const body = JSON.parse(options.body); let event;
    if (url.endsWith('/feedback') || url.endsWith('/reject')) event = { seq: c.session.seq + 1, type: 'concept.feedback', data: { artifactId: url.includes('image1') ? 'image1' : 'image2',
      vote: body.vote, chips: body.chips, archived: url.endsWith('/reject') } };
    else event = { seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'waiting' } } };
    return Response.json({ event });
  });
  c.configure({ copy, session, sessionToken, baseUrl }); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, downloads, revoked };
}
test('viewer opens cached bytes without spending and has accessible title, count, keyboard navigation and disclosure', async t => {
  const { c, root, calls } = setup(t, { concepts: [item('image1'), item('image2', { provenance: { origin: 'ai-manipulated', generator: { provider: 'openai' } } })] });
  await tick(); root.querySelector('.concept-tab').click(); await tick();
  const dialog = root.querySelector('.concept-viewer'); assert.equal(dialog.open, true);
  assert.equal(root.querySelector('#concept-title').textContent, 'Visual concept 2');
  assert.equal(root.querySelector('.concept-count').textContent, '2 of 2'); assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptManipulated);
  assert.ok(root.querySelector('.concept-image').src.startsWith('blob:')); assert.equal(root.querySelector('.concept-next').disabled, true);
  dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft' })); await tick();
  assert.equal(root.querySelector('.concept-count').textContent, '1 of 2'); assert.equal(root.querySelector('.concept-disclosure').textContent, en.conceptFake);
  dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(dialog.open, false);
  assert.ok(calls.every(c => !c.options.body), 'opening, navigation and close are GET-only');
  assert.ok(calls.every(c => new Headers(c.options.headers).get('x-aithema-session-token') === 'owner-fixture'));
  assert.equal(root.innerHTML.includes('owner-fixture'), false); assert.equal(c.session.conceptIntent.visualIntent, null);
});
test('thumbs and removable guidance persist on their artifact; regenerate shows cost and records explicit intent', async t => {
  const { c, root, calls } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  assert.match(root.querySelector('.concept-regenerate').textContent, /1234/);
  root.querySelector('.concept-up').click(); await tick(); assert.equal(c.session.concepts[0].feedback.vote, 'up');
  root.querySelector('.concept-guidance-options button').click(); await tick();
  assert.deepEqual(c.session.concepts[0].feedback.chips, ['Simpler layout']);
  root.querySelector('.concept-guidance-selected button').click(); await tick(); assert.deepEqual(c.session.concepts[0].feedback.chips, []);
  root.querySelector('.concept-regenerate').click(); await tick();
  const spending = calls.filter(c => c.url.endsWith('/regenerate')); assert.equal(spending.length, 1);
  assert.deepEqual(JSON.parse(spending[0].options.body), { clientEventId: JSON.parse(spending[0].options.body).clientEventId, intent: true, sourceTurnId: 'first' });
  assert.equal(calls.filter(c => c.options.body).length, 4, 'feedback never generates implicitly');
});
test('reject archives the exact item and returns to conversation without a paid request', async t => {
  const { c, root, calls } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-reject').click(); await tick();
  assert.equal(c.session.concepts[0].archived, true); assert.equal(root.querySelector('.concept-viewer').open, false);
  assert.equal(root.querySelector('.concept-tab').disabled, true);
  assert.equal(calls.filter(c => c.options.body).length, 1); assert.ok(calls.find(c => c.url.endsWith('/reject')));
});
test('download is a real same-origin owner-authenticated GET and revokes its temporary URL', async t => {
  const { root, calls, downloads, revoked } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  root.querySelector('.concept-download').click(); await tick();
  const get = calls.find(c => c.url.endsWith('/image?download=1')); assert.ok(get); assert.equal(get.options.body, undefined);
  assert.equal(new Headers(get.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  assert.match(downloads[0].name, /^concept-image1.png$/); assert.ok(revoked.includes(downloads[0].href));
});
test('foreign image URLs cannot receive ownership headers or become download targets', async t => {
  const { root, calls, downloads } = setup(t, { baseUrl: 'https://other.example' });
  root.querySelector('.concept-tab').click(); await tick(); root.querySelector('.concept-download').click(); await tick();
  assert.equal(calls.length, 0); assert.equal(downloads.length, 0); assert.equal(root.querySelector('.concept-image').hasAttribute('src'), false);
});
test('automatic concept arrivals wait for pointer leave; composer, tabs and viewer controls keep their nodes and fixed geometry', async t => {
  const { c, root } = setup(t); root.querySelector('.concept-tab').click(); await tick();
  const composer = root.querySelector('.composer'), tab = root.querySelector('.concept-tab'), controls = root.querySelector('.concept-viewer-controls');
  const regenerate = root.querySelector('.concept-regenerate'), count = root.querySelector('.concept-count');
  controls.dispatchEvent(new window.Event('pointerenter'));
  const prior = root.querySelector('#concept-title').textContent;
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'ready' }, artifact: item('image2') } });
  assert.equal(root.querySelector('#concept-title').textContent, prior); assert.equal(count.textContent, '1 of 1');
  assert.equal(root.querySelector('.composer'), composer); assert.equal(root.querySelector('.concept-tab'), tab); assert.equal(root.querySelector('.concept-regenerate'), regenerate);
  controls.dispatchEvent(new window.Event('pointerleave')); assert.equal(count.textContent, '1 of 2');
  const css = root.querySelector('style').textContent;
  assert.match(css, /grid-template-rows:3.6rem 8rem 5.4rem minmax\(0,1fr\) 10rem/);
  assert.match(css, /grid-template-rows:4rem minmax\(0,1fr\) 17rem/);
  assert.match(css, /concept-guidance-selected \{ height:2.3rem/);
});
test('progress never reports estimated completion; failure offers an explicit retry; pause disables spending without hiding cached viewer', async t => {
  assert.deepEqual(conceptProgress({ startedAt: 0, estimateMs: 45000 }, 50000), { percent: 99, seconds: 0, overdue: true });
  const { c, root, calls } = setup(t);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent,
    status: { phase: 'pending', startedAt: Date.now(), estimateMs: 45000 } } });
  assert.match(root.querySelector('.concept-countdown').textContent, /estimate/); assert.equal(root.querySelector('.concept-request').disabled, true);
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'failed' } } });
  assert.match(root.querySelector('.concept-request').textContent, /Retry/);
  root.querySelector('.concept-request').click(); await tick(); assert.equal(calls.filter(c => c.options.body).length, 1);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(root.querySelector('.concept-request').disabled, true); root.querySelector('.concept-tab').click(); await tick();
  assert.equal(root.querySelector('.concept-viewer').open, true); assert.equal(root.querySelector('.concept-regenerate').disabled, true);
  assert.equal(root.querySelector('.concept-regenerate').title, en.paused);
});
test('withdrawal revokes dependent images immediately while hovered; host copy remains literal and device gives a reason', async t => {
  const copy = { ...en, conceptTitle: '<script>Concept {number}</script>', conceptView: 'Bild ansehen', conceptGuidance: ['<b>literal</b>'] };
  const { c, root, revoked } = setup(t, { copy }); root.querySelector('.concept-tab').click(); await tick();
  assert.equal(root.querySelector('#concept-title script'), null); assert.match(root.querySelector('#concept-title').textContent, /<script>/);
  root.querySelector('.concept-viewer-controls').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(root.querySelector('.concept-image').hasAttribute('src'), false); assert.equal(root.querySelector('.concept-viewer').open, false); assert.ok(revoked.length > 0);
  c.configure({ copy, session: createSession({ processingPreset: 'device' }) });
  assert.equal(root.querySelector('.concept-request').disabled, true); assert.match(root.querySelector('.concept-request').title, /unavailable on device/);
});

test('closing an already closed viewer during withdrawal leaves composer focus in place', async t => {
  const { c, root } = setup(t); t.mock.method(c, 'connectedCallback', () => {}); document.body.append(c); await tick();
  const trigger = root.querySelector('.concept-tab'); trigger.focus(); trigger.click(); await tick();
  root.querySelector('.concept-close').click(); assert.equal(root.activeElement === trigger, true);
  const composer = root.querySelector('textarea'); composer.focus();
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'first', at: new Date().toISOString() } });
  assert.equal(root.activeElement === composer, true);
});
test('hiding the page sends durable ineligibility without requesting a concept', async t => {
  const { c, calls } = setup(t); await tick();
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  const signal = calls.find(c => c.url.endsWith('/concepts/eligibility'));
  assert.ok(signal); assert.deepEqual(JSON.parse(signal.options.body), { eligible: false });
  assert.equal(calls.filter(c => c.options.body && !c.url.endsWith('/concepts/eligibility')).length, 0);
});
