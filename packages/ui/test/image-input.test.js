import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { planUploads, isImageFile } from '../src/uploads.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'FormData']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, copy = en, available = true, options = {}) {
  const c = document.createElement('aithema-session'), session = options.session ?? createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput', 'images'].map(key => [key,
    { available: key === 'imageInput' ? available : key === 'uploads' ? options.documentsAvailable ?? true : true, reason: key === 'imageInput' && !available ? options.imageReason ?? 'current processing consent required' : key === 'uploads' && options.documentsAvailable === false ? 'current processing consent required' : null }])) };
  const calls = [], asks = []; let imageGranted = available, documentsGranted = options.documentsAvailable ?? true;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const files = options.body.getAll('files');
      return Response.json({ events: files.map((file, index) => ({ sessionId: session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
        id: `${isImageFile(file) ? 'fixture-image' : 'fixture-document'}${files.length > 1 ? '-' + index : ''}`, filename: file.name,
        kind: isImageFile(file) ? 'image' : 'document', state: isImageFile(file) ? 'staged-pending' : 'accepted',
        mediaType: file.type, bytes: file.size, at: new Date(0).toISOString() } })) }, { status: 202 });
    }
    if (url.endsWith('/uploads')) return Response.json({ uploads: [] });
    if (url.endsWith('/turns') && options.method === 'POST') { const body = JSON.parse(options.body);
      return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments } }); }
    const snapshot = c.session;
    snapshot.featureMatrix.best.imageInput = { available: imageGranted, reason: imageGranted ? null : 'current processing consent required' };
    snapshot.featureMatrix.best.uploads = { available: documentsGranted, reason: documentsGranted ? null : 'current processing consent required' };
    if (url.endsWith('/consent')) return Response.json({ consentRevision: snapshot.consentRevision, selected: imageGranted ? ['images', 'image-input'] : ['images'], features: { images: ['images'], imageInput: ['image-input'] } });
    return Response.json(snapshot);
  });
  c.addEventListener('aithema-consent', event => asks.push(event.detail));
  c.configure({ copy, session, sessionToken: 'fixture', ...options }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, asks, grantDocuments() { documentsGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['uploads'], removed: [] } }); }, grantImages() { imageGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); } };
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
  assert.equal(f.root.querySelector('.staged-image__status').textContent, 'fixture.png');
  assert.match(f.root.querySelector('.image-refusals').textContent, new RegExp(copy.imageRefusals.malformed, 'u'));
  assert.equal(f.root.querySelector('.staged-image').textContent.includes(copy.imageRefusals.malformed), false, 'the refusal is shown once');
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

for (const copy of [en, de]) for (const documentRefusal of [false, true]) {
  test(`AIT-510: successful send clears image refusals and preserves document notices ${copy.display.locale}/${documentRefusal}`, async t => {
    const f = fixture(t, copy);
    const files = [new window.File(['fixture'], 'photo.heic', { type: 'image/heic' })];
    if (documentRefusal) files.push(new window.File(['fixture'], 'blocked.exe'));
    await choose(f.root, files);
    assert.ok(f.root.querySelector('.image-refusals'));
    f.root.querySelector('textarea').value = 'Hello';
    f.root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    assert.equal(f.root.querySelector('.image-refusals'), null);
    const reason = f.root.querySelector('.composer-reason');
    assert.equal(reason.textContent.includes('photo.heic'), false, 'no duplicate image refusal remains after send');
    if (documentRefusal) {
      assert.equal(reason.textContent, (copy === en ? 'Not attached: blocked.exe (file type not accepted).'
        : 'Nicht angehängt: blocked.exe (Dateityp wird nicht angenommen).') + ' ' + copy.uploadsSupported);
      assert.equal(f.root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    } else assert.equal(reason.hasAttribute('data-shortcut'), true);
    assert.equal(f.root.querySelector('.composer-saved-announcement').textContent, copy.saved);
  });
}

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

for (const entrance of ['choice', 'combined']) test(`AIT-510: ${entrance} host opener and staged images are not visitor input`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { hasVisitorInput } = await import('@inspr/aithema-core');
  const source = createSession({ demo: true });
  source.opener = { text: 'Welcome from a host.', locale: 'en' };
  source.settings.origin = 'chosen'; source.emailOffer = { afterMessages: 2 };
  source.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput', 'images'].map(key => [key, { available: true }])) };
  const f = fixture(t, en, true, { entrance, session: source });
  if (entrance === 'choice') f.root.querySelector('.ready__start').click();
  assert.ok(f.root.querySelector('[data-id="host:opener"]'));
  assert.equal(hasVisitorInput(f.c.session), false);
  assert.equal(f.root.querySelector('.workspace').dataset.understanding, 'absent');
  await choose(f.root, [new window.File(['fixture'], 'fixture.png', { type: 'image/png' })]);
  assert.equal(hasVisitorInput(f.c.session), false);
  assert.equal(f.root.querySelector('.workspace').dataset.understanding, 'absent');
  assert.equal(f.root.querySelector('.email-offer'), null);
  assert.equal(f.c.session.transcript.length, 0, 'staging does not persist the render-only opener');
});

for (const copy of [en, de]) for (const [reason, key] of [
  ['image normalizer not configured', 'unavailable'], ['image normalizer unavailable', 'unavailable'],
  ['session paused', 'paused'], ['image input not supported', 'model'],
]) test(`AIT-510 G-M3: ${copy.display.locale} mixed selection retains documents when images are refused (${reason})`, async t => {
  const f = fixture(t, copy, false, { imageReason: reason });
  await choose(f.root, [new window.File(['pixels'], 'photo.png', { type: 'image/png' }), new window.File(['document'], 'notes.pdf', { type: 'application/pdf' })]);
  const posts = f.calls.filter(call => call.url.endsWith('/uploads') && call.options.method === 'POST');
  assert.equal(posts.length, 1, 'documents still upload');
  assert.deepEqual(posts[0].options.body.getAll('files').map(file => file.name), ['notes.pdf']);
  assert.equal(f.root.querySelector('.upload__name').textContent, 'notes.pdf');
  assert.equal(f.root.querySelector('.staged-image'), null, 'the refused image was never staged');
  assert.match(f.root.querySelector('.image-refusals').textContent, new RegExp(copy.imageRefusals[key], 'u'));
  assert.equal(f.asks.length, 0);
});
for (const copy of [en, de]) test(`AIT-510 T-M3: ${copy.display.locale} withheld images use a sentence and release thumbnail dimensions`, async t => {
  const f = fixture(t, copy);
  await choose(f.root, [new window.File(['pixels'], 'photo.png', { type: 'image/png' })]);
  const image = f.c.session.uploads[0];
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', w: 2, h: 1, digest: 'fixture' } });
  f.root.querySelector('.send').click(); await tick(); await tick();
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: { ...f.c.session.uploads[0], state: 'withheld', withdrawn: true } });
  const tile = f.root.querySelector('.turn-image');
  assert.equal(tile.textContent, copy === de ? 'Bild nicht gesendet' : 'Image not sent');
  assert.equal(tile.style.width, ''); assert.equal(tile.style.height, '');
});
for (const copy of [en, de]) test(`AIT-510 L6: ${copy.display.locale} enabled Attach describes selection before consent`, t => {
  const f = fixture(t, copy, false, { documentsAvailable: false });
  assert.equal(f.root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  assert.equal(f.root.querySelector('.attach').title.includes(copy.uploads.unavailable.split('{reason}')[0]), false);
});

for (const copy of [en, de]) test(`AIT-510 L5: ${copy.display.locale} image-limit refusal resolves absent and overridden copy`, async () => {
  const { refusalText } = await import('../src/uploads.js');
  const plan = planUploads([new window.File(['pixels'], 'image.png')], { limits: { maxImagesPerSession: 1 }, uploads: [{ id: 'sent', kind: 'image', state: 'sent' }] });
  assert.equal(plan.blocked, 'images');
  const legacy = { ...copy }; delete legacy.imageRefusals;
  assert.equal(refusalText(legacy, plan, copy.display.locale), copy.imageRefusals.limit);
  assert.equal(refusalText({ ...copy, imageRefusals: { limit: 'Host image limit' } }, plan, copy.display.locale), 'Host image limit');
});

for (const copy of [en, de]) test(`AIT-510 G-M3 JIT: ${copy.display.locale} document consent retains the same mixed pick's image refusal`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = fixture(t, copy, false, { imageReason: 'image normalizer not configured', documentsAvailable: false });
  await choose(f.root, [new window.File(['pixels'], 'photo.png', { type: 'image/png' }), new window.File(['document'], 'notes.pdf', { type: 'application/pdf' })]);
  assert.equal(f.calls.some(call => call.url.endsWith('/uploads') && call.options.method === 'POST'), false, 'no document bytes before consent');
  assert.equal(f.asks.length, 1);
  assert.deepEqual(f.asks[0].features, ['uploads', 'text'], 'only the eligible documents request consent');
  f.grantDocuments(); for (let i = 0; i < 8; i++) await tick();
  const posts = f.calls.filter(call => call.url.endsWith('/uploads') && call.options.method === 'POST');
  assert.equal(posts.length, 1, 'the consent continuation uploads exactly once');
  assert.deepEqual(posts[0].options.body.getAll('files').map(file => file.name), ['notes.pdf']);
  assert.equal(f.root.querySelector('.upload__name').textContent, 'notes.pdf');
  const refusal = f.root.querySelector('.image-refusals');
  assert.ok(refusal, 'the same pick retains its image refusal after document consent');
  assert.ok(refusal.textContent.includes('photo.png'));
  assert.ok(refusal.textContent.includes(copy.imageRefusals.unavailable));
  assert.equal(f.root.querySelector('.staged-image'), null);
  assert.equal(f.asks.length, 1, 'document consent never requests unavailable image processing');
});

for (const copy of [en, de]) test(`AIT-510 feedback race: ${copy.display.locale} a decoder refusal before the receipt survives that selection's success`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = fixture(t, copy);
  await choose(f.root, [new window.File(['pixels'], 'old.heic', { type: 'image/heic' })]);
  assert.ok(f.root.querySelector('.image-refusals').textContent.includes('old.heic'));
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const response = await originalFetch(url, options);
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const body = await response.clone().json();
      for (const event of body.events) f.c.receive(event);
      const pending = body.events.find(event => event.data.kind === 'image');
      // The event stream can deliver normalization before the POST receipt.
      f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: {
        ...pending.data, state: 'staged-refused', reason: 'malformed', at: new Date().toISOString() } });
    }
    return response;
  });
  await choose(f.root, [new window.File(['pixels'], 'fresh.png', { type: 'image/png' })]);
  assert.equal(f.c.session.uploads[0].state, 'staged-refused');
  const refusal = f.root.querySelector('.image-refusals');
  assert.ok(refusal, 'successful intake keeps a refusal produced during that selection');
  assert.ok(refusal.textContent.includes('fresh.png'));
  assert.ok(refusal.textContent.includes(copy.imageRefusals.malformed));
  assert.equal(refusal.textContent.includes('old.heic'), false, 'the new selection clears older feedback');
  assert.equal(f.root.querySelector('.staged-image__status').textContent, 'fresh.png', 'the reason is shown once in the refusal list');
});

for (const copy of [en, de]) for (const reason of ['malformed', 'unsupported']) test(`AIT-510 r14: ${copy.display.locale}/${reason} accepted extension with unreadable content gives a sentence without a type list`, async t => {
  const f = fixture(t, copy);
  await choose(f.root, [new window.File(['not image bytes'], 'broken.png', { type: 'image/png' })]);
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: {
    ...f.c.session.uploads[0], state: 'staged-refused', reason } });
  const sentence = f.root.querySelector('.image-refusal').textContent;
  assert.equal(sentence, copy === de ? 'broken.png ist kein lesbares Bild.' : 'broken.png is not a readable image.');
  assert.equal(sentence.includes('JPEG'), false);
});

for (const copy of [en, de]) test(`AIT-510 r15: ${copy.display.locale} supported-format sentence has its final full stop`, () => {
  assert.ok(copy.uploadsSupported.endsWith('.'));
});
