import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { planUploads } from '../src/uploads.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'FormData']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, copy = en, available = true) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput', 'images'].map(key => [key,
    { available: key === 'imageInput' ? available : true, reason: key === 'imageInput' && !available ? 'current processing consent required' : null }])) };
  const calls = [], asks = []; let imageGranted = available;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/uploads') && options.method === 'POST') return Response.json({ events: [{ sessionId: session.id, seq: c.session.seq + 1, type: 'upload.state',
      data: { id: 'fixture-image', filename: 'fixture.png', kind: 'image', state: 'staged-pending', mediaType: 'image/png', bytes: 70, at: new Date(0).toISOString() } }] }, { status: 202 });
    if (url.endsWith('/uploads')) return Response.json({ uploads: [] });
    if (url.endsWith('/turns') && options.method === 'POST') { const body = JSON.parse(options.body);
      return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments } }); }
    const snapshot = c.session;
    snapshot.featureMatrix.best.imageInput = { available: imageGranted, reason: imageGranted ? null : 'current processing consent required' };
    if (url.endsWith('/consent')) return Response.json({ consentRevision: snapshot.consentRevision, selected: imageGranted ? ['images', 'image-input'] : ['images'], features: { images: ['images'], imageInput: ['image-input'] } });
    return Response.json(snapshot);
  });
  c.addEventListener('aithema-consent', event => asks.push(event.detail));
  c.configure({ copy, session, sessionToken: 'fixture' }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, asks, grantImages() { imageGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); } };
}
async function choose(root, files) {
  const input = root.querySelector('.attach-input'), transfer = new window.DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new window.Event('change')); await tick(); await tick();
}
for (const copy of [en, de]) test(`AIT-510: ${copy === en ? 'EN' : 'DE'} start-granted image purposes stage with no consent line or ask`, async t => {
  const f = fixture(t, copy);
  await choose(f.root, [new window.File(['fixture'], 'fixture.png', { type: 'image/png' })]);
  assert.equal(f.calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/uploads')).length, 1);
  assert.equal(f.root.querySelectorAll('.staged-image').length, 1);
  assert.equal(f.root.querySelector('.composer-reason .consent-action'), null);
  assert.deepEqual(f.asks, []);
  const revision = f.c.session.inputRevision;
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: {
    ...f.c.session.uploads[0], state: 'staged-refused', reason: 'malformed' } });
  assert.equal(f.c.session.inputRevision, revision);
  assert.match(f.root.querySelector('.staged-image').textContent, new RegExp(copy.imageRefusals.malformed, 'u'));
});
test('AIT-510: supported image types include clipboard names without extension; HEIC remains refused', () => {
  const files = ['image.png', 'image.JPG', 'image.webp', 'image.gif', 'image.heic', 'clipboard'].map(name => new window.File(['fixture'], name, { type: name === 'clipboard' ? 'image/png' : '' }));
  const plan = planUploads(files);
  assert.equal(plan.batches.flat().length, 5);
  assert.deepEqual(plan.refused.map(r => r.name), ['image.heic']);
});
test('AIT-510: refusal records survive typing until explicitly dismissed', async t => {
  const f = fixture(t);
  await choose(f.root, [new window.File(['fixture'], 'image.heic')]);
  assert.ok(f.root.querySelector('.image-refusals'));
  const input = f.root.querySelector('textarea'); input.value = 'A caption'; input.dispatchEvent(new window.Event('input'));
  assert.ok(f.root.querySelector('.image-refusals'));
  f.root.querySelector('.image-refusals button').click();
  assert.equal(f.root.querySelector('.image-refusals'), null);
});

test('AIT-510: staging and decoding do not clear a reply in flight; pending images cannot send', async t => {
  const { inputRevision } = await import('@inspr/aithema-core');
  const f = fixture(t);
  f.c.receive({ sessionId: f.c.session.id, type: 'turn.partial', data: { id: 'running-reply', delta: 'A reply in flight', inputRevision: inputRevision(f.c.session), settingsRevision: 0 } });
  const partial = f.root.querySelector('.partial')?.textContent;
  assert.ok(partial?.includes('A reply in flight'));
  await choose(f.root, [new window.File(['fixture'], 'fixture.png', { type: 'image/png' })]);
  assert.equal(f.root.querySelector('.partial')?.textContent, partial);
  assert.equal(f.root.querySelector('.send').disabled, true);
  f.root.querySelector('.send').click(); await tick();
  assert.equal(f.calls.some(call => call.url.endsWith('/turns') && call.options.method === 'POST'), false);
});

test('AIT-510: image-only send carries staged IDs in the user turn', async t => {
  const f = fixture(t);
  await choose(f.root, [new window.File(['fixture'], 'fixture.png', { type: 'image/png' })]);
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: { ...f.c.session.uploads[0], state: 'staged-ready', w: 2, h: 1, digest: 'fixture' } });
  f.root.querySelector('.send').click(); await tick(); await tick();
  const sends = f.calls.filter(call => call.url.endsWith('/turns') && call.options.method === 'POST');
  assert.equal(sends.length, 1);
  assert.equal(JSON.parse(sends[0].options.body).content, '');
  assert.deepEqual(JSON.parse(sends[0].options.body).attachments, ['fixture-image']);
  assert.equal(f.c.session.uploads[0].state, 'sent');
  assert.ok(f.root.querySelector('.turn-images'));
});
test('AIT-510: attach asks once after selection, retains files in memory, and resumes after image consent', async t => {
  const f = fixture(t, en, false);
  await choose(f.root, [new window.File(['fixture'], 'fixture.png', { type: 'image/png' })]);
  assert.equal(f.calls.some(call => call.url.endsWith('/uploads') && call.options.method === 'POST'), false);
  assert.equal(f.asks.length, 1); assert.equal(f.asks[0].reason, 'use'); assert.equal(f.asks[0].intent, 'attach');
  assert.deepEqual(f.asks[0].features, ['imageInput']);
  f.grantImages(); for (let i = 0; i < 8; i++) await tick();
  assert.equal(f.calls.filter(call => call.url.endsWith('/uploads') && call.options.method === 'POST').length, 1);
  assert.equal(f.asks.length, 1); assert.equal(f.root.querySelector('.composer-reason .consent-line-copy'), null);
});
