import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { reasonSeparator } from '../src/reason-separator.js';
import { planUploads, isImageFile } from '../src/uploads.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'FormData']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, copy = en, available = true, options = {}) {
  // Match runtime.matrix: paused imageInput projects only available/reason;
  // consentPurposes belongs to generated visuals, not image input.
  const c = document.createElement('aithema-session'), session = options.session ?? createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput', 'images'].map(key => [key,
    { available: key === 'imageInput' ? available : key === 'uploads' ? options.documentsAvailable ?? true : true, reason: key === 'imageInput' && !available ? options.imageReason ?? 'current processing consent required' : key === 'uploads' && options.documentsAvailable === false ? 'current processing consent required' : null,
      ...(key === 'imageInput' && options.imageReason === 'session paused' ? { unpaused: { available: true, reason: null } } : {}) }])) };
  const configuredImageReason = options.imageReason;
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
    snapshot.featureMatrix.best.imageInput = { available: imageGranted, reason: imageGranted ? null : configuredImageReason ?? 'current processing consent required',
      ...(configuredImageReason === 'session paused' ? { unpaused: { available: true, reason: null } } : {}) };
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

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const path of ['mixed', 'sequential', 'binding-switch']) {
  test(`AIT-510 M1-double-prime: ${copy.display.locale} ${entrance} ${path} never advertises unavailable image formats`, async t => {
    const f = fixture(t, copy, path === 'binding-switch', { entrance, imageReason: 'image input not supported' });
    if (path === 'binding-switch') {
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (...args) => {
        const response = await fetch(...args);
        if (String(args[0]).endsWith(`/api/sessions/${f.c.session.id}`)) {
          const snapshot = await response.json();
          snapshot.featureMatrix.best.imageInput = { available: false, reason: 'image input not supported' };
          return Response.json(snapshot);
        }
        return response;
      });
      f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'settings.changed',
        data: { processingPreset: 'best', settings: { ...f.c.session.settings, model: 'text-only', revision: 1 } } });
      await tick(); await tick();
      assert.equal(f.c.session.featureMatrix.best.imageInput.reason, 'image input not supported');
    } else {
      await choose(f.root, [new window.File(['pixels'], 'photo.png', { type: 'image/png' }),
        ...(path === 'mixed' ? [new window.File(['fixture'], 'x.exe')] : [])]);
      assert.equal(f.root.querySelector('.image-refusals'), null);
    }
    assert.equal(f.root.querySelector('.composer').hasAttribute('data-image-input'), path === 'binding-switch', 'only a previously admitted image layout remains latched');
    if (path !== 'mixed') await choose(f.root, [new window.File(['fixture'], 'x.exe')]);
    const text = f.root.querySelector('.composer-reason').textContent;
    assert.equal(text, path === 'mixed'
      ? copy === en ? 'Not attached: photo.png (file type not accepted), x.exe (file type not accepted).' : 'Nicht angehängt: photo.png (Dateityp wird nicht angenommen), x.exe (Dateityp wird nicht angenommen).'
      : copy === en ? 'Not attached: x.exe (file type not accepted).' : 'Nicht angehängt: x.exe (Dateityp wird nicht angenommen).');
    assert.equal(text.includes('PNG'), false);
    assert.equal(f.calls.some(call => call.options.method === 'POST' && call.url.endsWith('/uploads')), false);
    assert.deepEqual(f.asks, []);
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
  if (key === 'paused') {
    assert.equal(f.root.querySelector('.image-refusal').textContent, `photo.png: ${copy.imageRefusals.paused}`);
  } else {
    assert.equal(f.root.querySelector('.image-refusals'), null);
    assert.equal(f.root.querySelector('.composer-reason').textContent, copy === en
      ? 'Not attached: photo.png (file type not accepted).' : 'Nicht angehängt: photo.png (Dateityp wird nicht angenommen).');
  }
  assert.equal(f.asks.length, 0);
});
for (const copy of [en, de]) for (const path of ['picker', 'paste']) {
  test(`AIT-556 L1: ${copy.display.locale} paused image-capable ${path} keeps the image refusal`, async t => {
    const session = createSession({ demo: true, locale: copy.display.locale }); session.paused = true;
    const f = fixture(t, copy, false, { session, imageReason: 'session paused' });
    const file = new window.File(['pixels'], 'photo.png', { type: 'image/png' });
    if (path === 'picker') await choose(f.root, [file]);
    else {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '' } });
      f.root.querySelector('textarea').dispatchEvent(event); await tick(); await tick();
      assert.equal(event.defaultPrevented, true, 'the paused image paste is handled');
    }
    assert.equal(f.root.querySelector('.composer-reason .image-refusal'), null, 'a full pause keeps the existing pause presentation');
    assert.equal(f.calls.some(call => call.options.method === 'POST' && call.url.endsWith('/uploads')), false);
    f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'session.paused', data: { paused: false } });
    await tick(); await tick();
    assert.equal(f.root.querySelector('.image-refusal')?.textContent, `photo.png: ${copy.imageRefusals.paused}`);
    assert.equal(f.calls.some(call => call.options.method === 'POST' && call.url.endsWith('/uploads')), false);
    assert.deepEqual(f.asks, []);
  });
}
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
  assert.equal(f.root.querySelector('.composer-reason').dataset.consentFeature, 'uploads');
  assert.equal(f.root.querySelector('.composer').hasAttribute('data-image-input'), false);
  f.grantDocuments(); for (let i = 0; i < 8; i++) await tick();
  const posts = f.calls.filter(call => call.url.endsWith('/uploads') && call.options.method === 'POST');
  assert.equal(posts.length, 1, 'the consent continuation uploads exactly once');
  assert.deepEqual(posts[0].options.body.getAll('files').map(file => file.name), ['notes.pdf']);
  assert.equal(f.root.querySelector('.upload__name').textContent, 'notes.pdf');
  assert.equal(f.root.querySelector('.image-refusals'), null);
  const refusal = f.root.querySelector('.composer-reason');
  assert.ok(refusal, 'the same pick retains its document type refusal after document consent');
  assert.ok(refusal.textContent.includes('photo.png'));
  assert.equal(refusal.textContent, copy === en
    ? 'Not attached: photo.png (file type not accepted).' : 'Nicht angehängt: photo.png (Dateityp wird nicht angenommen).');
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


const documentLimits = {
  en: 'Up to 8 files, 20 MB each: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON or XML. The original file is not stored.',
  de: 'Bis zu 8 Dateien, je höchstens 20 MB: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON oder XML. Die Originaldatei wird nicht aufbewahrt.',
};
const documentAccept = '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.xml';
for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) {
  for (const imageReason of ['image normalizer not configured', 'image input not supported']) {
    test(`AIT-556: ${copy.display.locale}/${entrance}/${imageReason} exact document help and picker`, t => {
      const f = fixture(t, copy, false, { entrance, imageReason });
      assert.equal(f.root.querySelector('.attach').title, documentLimits[copy.display.locale]);
      assert.equal(f.root.querySelector('#attach-limits').textContent, documentLimits[copy.display.locale]);
      assert.equal(f.root.querySelector('.attach-input').accept, documentAccept);
    });
    for (const name of ['x.heic', 'x.png', 'x.jpg', 'x.webp', 'x.gif', 'x.bmp', 'x.svg', 'x.avif', 'x.tiff']) {
      test(`AIT-556: ${copy.display.locale}/${entrance}/${imageReason}/${name} exact main type refusal`, async t => {
        const f = fixture(t, copy, false, { entrance, imageReason });
        await choose(f.root, [new window.File(['fixture'], name, { type: 'image/png' })]);
        assert.equal(f.root.querySelector('.composer-reason').textContent, copy === en
          ? `Not attached: ${name} (file type not accepted).` : `Nicht angehängt: ${name} (Dateityp wird nicht angenommen).`);
        assert.equal(f.root.querySelector('.image-refusals'), null);
        assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
        assert.equal(f.asks.length, 0);
      });
    }
  }
}

for (const copy of [en, de]) test(`AIT-556: ${copy.display.locale} additive image limits preserve host overrides`, async () => {
  const { limitsText, UPLOAD_LIMITS } = await import('../src/uploads.js');
  const locale = copy.display.locale;
  const legacy = { ...copy, uploads: { ...copy.uploads, limits: 'Host legacy {files} / {size}' } };
  assert.equal(limitsText(legacy, UPLOAD_LIMITS, locale), 'Host legacy 8 / 20 MB');
  assert.equal(limitsText(legacy, UPLOAD_LIMITS, locale, true), 'Host legacy 8 / 20 MB');
  const both = { ...legacy, uploads: { ...legacy.uploads, limitsWithImages: 'Host images {files} / {size}' } };
  assert.equal(limitsText(both, UPLOAD_LIMITS, locale), 'Host legacy 8 / 20 MB');
  assert.equal(limitsText(both, UPLOAD_LIMITS, locale, true), 'Host images 8 / 20 MB');
  const oldBundle = { ...copy, uploads: { ...copy.uploads } }; delete oldBundle.uploads.limitsWithImages;
  assert.equal(limitsText(oldBundle, UPLOAD_LIMITS, locale, true), copy.uploads.limitsWithImages.replace('{files}', '8').replace('{size}', '20 MB'));
});

for (const copy of [en, de]) for (const reason of ['image normalizer not configured', 'image input not supported', 'image normalizer unavailable', 'current processing consent required', 'limit']) {
  test(`AIT-559: ${copy.display.locale}/${reason} detected images have per-file outcomes and later documents continue`, async t => {
    const consent = reason === 'current processing consent required';
    const f = fixture(t, copy, reason === 'limit', { imageReason: reason });
    const originalFetch = globalThis.fetch, posts = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (url.endsWith('/uploads') && options.method !== 'POST') return Response.json({ limits: { maxFilesPerRequest: 2 } });
      if (url.endsWith('/uploads') && options.method === 'POST') {
        const files = options.body.getAll('files'); posts.push(files.map(file => file.name));
        const refused = [], events = [];
        for (const [index, file] of files.entries()) {
          const image = !file.name.startsWith('eligible');
          if (image && !(consent && posts.length > 3)) refused.push({ index, name: file.name, kind: 'image', reason });
          else events.push({ sessionId: f.c.session.id, seq: f.c.session.seq + events.length + 1, type: 'upload.state', data: {
            id: `attached-${file.name}`, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-pending' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
        }
        return Response.json({ events, refused }, { status: 202 });
      }
      return originalFetch(url, options);
    });
    await choose(f.root, [new window.File(['png'], 'clipboard'), new window.File(['pdf'], 'eligible.pdf'),
      new window.File(['png'], 'typed.pdf', { type: 'image/png' }), new window.File(['pdf'], 'eligible-typed.pdf'),
      new window.File(['jpeg'], 'scan.pdf'), new window.File(['pdf'], 'eligible-later.pdf')]);
    assert.deepEqual(posts.slice(0, 3), [['clipboard', 'eligible.pdf'], ['typed.pdf', 'eligible-typed.pdf'], ['scan.pdf', 'eligible-later.pdf']]);
    assert.deepEqual(f.c.session.uploads.filter(upload => upload.kind === 'document').map(upload => upload.filename), ['eligible.pdf', 'eligible-typed.pdf', 'eligible-later.pdf']);
    if (consent) {
      assert.equal(f.asks.length, 1); assert.deepEqual(f.asks[0].features, ['imageInput']);
      assert.ok(f.root.querySelector('.consent-action'), 'existing image consent action is visible');
      f.grantImages(); await tick(); await tick(); await tick();
      assert.deepEqual(posts.slice(3), [['clipboard', 'typed.pdf'], ['scan.pdf']], 'only detected images resume after consent');
      assert.equal(f.c.session.uploads.filter(upload => upload.kind === 'image').length, 3);
    } else if (reason === 'limit') {
      assert.deepEqual([...f.root.querySelectorAll('.image-refusals .image-refusal')].map(row => row.textContent), ['clipboard', 'typed.pdf', 'scan.pdf'].map(name => `${name}: ${copy.imageRefusals.limit}`));
    } else {
      const expected = copy.uploads.refused.replace('{list}', ['clipboard', 'typed.pdf', 'scan.pdf'].map(name => copy.uploads.type.replace('{name}', name)).join(', '));
      assert.equal(f.root.querySelector('.composer-reason').textContent, expected);
      assert.equal(f.root.querySelector('.image-refusals'), null, 'documents-only surface keeps main type treatment');
    }
  });
}

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} only excess recognised images are refused while documents continue`, async t => {
  const f = fixture(t, copy), originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options = {}) => url.endsWith('/uploads') && options.method !== 'POST'
    ? Promise.resolve(Response.json({ limits: { maxImagesPerSession: 1 } })) : originalFetch(url, options));
  await choose(f.root, ['first.png', 'excess.png', 'eligible.pdf'].map(name => new window.File(['fixture'], name)));
  assert.deepEqual(f.c.session.uploads.map(upload => upload.filename), ['first.png', 'eligible.pdf']);
  assert.equal(f.root.querySelector('.image-refusal').textContent, `excess.png: ${copy.imageRefusals.limit}`);
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} every refusal remains visible beyond one batch`, async t => {
  const f = fixture(t, copy);
  await choose(f.root, Array.from({ length: 10 }, (_, index) => new window.File(['fixture'], `excluded-${index}.heic`, { type: 'image/heic' })));
  assert.deepEqual([...f.root.querySelectorAll('.image-refusals .image-refusal')].map(row => row.textContent),
    Array.from({ length: 10 }, (_, index) => `excluded-${index}.heic: ${copy.imageRefusals.unsupported}`));
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} duplicate filenames still have one refusal per file`, async t => {
  const f = fixture(t, copy);
  await choose(f.root, [1, 2].map(() => new window.File(['fixture'], 'same.heic', { type: 'image/heic' })));
  assert.deepEqual([...f.root.querySelectorAll('.image-refusals .image-refusal')].map(row => row.textContent), [1, 2].map(() => `same.heic: ${copy.imageRefusals.unsupported}`));
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} bytes of an excess detected image cannot hold an otherwise fitting document`, async t => {
  const session = createSession({ demo: true, locale: copy.display.locale });
  session.uploads = [{ id: 'earlier', kind: 'image', state: 'sent', filename: 'earlier.png', bytes: 1, at: new Date(0).toISOString() }];
  const f = fixture(t, copy, true, { session }), originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/uploads') && options.method !== 'POST') return Response.json({ limits: { maxImagesPerSession: 1, maxSessionBytes: 2 } });
    if (url.endsWith('/uploads') && options.method === 'POST') return Response.json({
      refused: [{ index: 0, name: 'scan.pdf', kind: 'image', reason: 'limit' }],
      events: [{ sessionId: session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: { id: 'eligible', filename: 'eligible.pdf', state: 'accepted', bytes: 1, at: new Date(0).toISOString() } }],
    }, { status: 202 });
    return originalFetch(url, options);
  });
  await choose(f.root, [new window.File(['large rejected image'], 'scan.pdf'), new window.File(['x'], 'eligible.pdf')]);
  assert.deepEqual(f.c.session.uploads.map(upload => upload.filename), ['earlier.png', 'eligible.pdf']);
  assert.equal(f.root.querySelector('.image-refusal').textContent, `scan.pdf: ${copy.imageRefusals.limit}`);
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} detected-image consent preserves the selection's document refusal and busy retained files`, async t => {
  const f = fixture(t, copy, false), originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, posts = [];
  let busy = true;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => originalTimeout(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/uploads') && options.method !== 'POST') return Response.json({ limits: { maxFilesPerRequest: 2 } });
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const files = options.body.getAll('files'); posts.push(files.map(file => file.name));
      if (busy && files.some(file => file.name === 'eligible-later.pdf')) return Response.json({ error: 'upload-rate-limit' }, { status: 429 });
      const events = [], refused = [];
      for (const [index, file] of files.entries()) {
        const image = file.name === 'clipboard';
        if (image && !f.c.session.featureMatrix.best.imageInput.available) refused.push({ index, name: file.name, kind: 'image', reason: 'current processing consent required' });
        else events.push({ sessionId: f.c.session.id, seq: f.c.session.seq + events.length + 1, type: 'upload.state', data: {
          id: `continued-${file.name}`, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-pending' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
      }
      return Response.json({ events, refused }, { status: 202 });
    }
    return originalFetch(url, options);
  });
  const until = async predicate => { for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(predicate()); };
  await choose(f.root, ['clipboard', 'eligible.pdf', 'eligible-later.pdf', 'blocked.exe'].map(name => new window.File(['fixture'], name)));
  await until(() => f.asks.length === 1 && f.root.querySelector('.upload-retry'));
  f.grantImages();
  await until(() => f.c.session.uploads.some(upload => upload.filename === 'clipboard'));
  assert.ok(f.root.querySelector('.upload-retry'), 'image continuation preserves retained documents');
  assert.ok(f.root.querySelector('.composer-reason').textContent.includes(copy.uploads.type.replace('{name}', 'blocked.exe')), 'the same selection keeps its per-file document reason');
  busy = false; f.root.querySelector('.upload-retry').click();
  await until(() => f.c.session.uploads.some(upload => upload.filename === 'eligible-later.pdf'));
  assert.deepEqual(posts.at(-1), ['eligible-later.pdf'], 'the document remains available for explicit retry');
  assert.equal(f.c.session.uploads.filter(upload => upload.filename === 'eligible.pdf').length, 1);
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} a detected consent refusal fences a stale available feature until a grant`, async t => {
  const f = fixture(t, copy, true), originalFetch = globalThis.fetch, posts = [];
  let granted = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const files = options.body.getAll('files'); posts.push(files.map(file => file.name));
      // Bound a broken continuation so the regression fails without a request loop.
      if (!granted && posts.length > 1) return Response.json({ error: 'uploads-unavailable', reason: 'current processing consent required' }, { status: 403 });
      const refused = [], events = [];
      for (const [index, file] of files.entries()) {
        if (file.name === 'scan.pdf' && !granted) refused.push({ index, name: file.name, kind: 'image', reason: 'current processing consent required' });
        else events.push({ sessionId: f.c.session.id, seq: f.c.session.seq + events.length + 1, type: 'upload.state', data: {
          id: `fenced-${file.name}`, filename: file.name, kind: file.name === 'scan.pdf' ? 'image' : 'document', state: file.name === 'scan.pdf' ? 'staged-pending' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
      }
      return Response.json({ events, refused }, { status: 202 });
    }
    return originalFetch(url, options);
  });
  await choose(f.root, ['scan.pdf', 'eligible.pdf'].map(name => new window.File(['fixture'], name)));
  await tick(); await tick();
  assert.equal(f.asks.length, 1); assert.deepEqual(f.asks[0].features, ['imageInput']);
  assert.deepEqual(posts, [['scan.pdf', 'eligible.pdf']], 'a stale available feature cannot resubmit refused images');
  assert.deepEqual(f.c.session.uploads.map(upload => upload.filename), ['eligible.pdf']);
  granted = true; f.grantImages(); await tick(); await tick(); await tick();
  assert.deepEqual(posts[1], ['scan.pdf']);
  assert.deepEqual(f.c.session.uploads.map(upload => upload.filename), ['eligible.pdf', 'scan.pdf']);
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} unavailable image intake keeps main type refusal despite an existing full image quota`, async t => {
  const session = createSession({ demo: true, locale: copy.display.locale });
  session.uploads = [{ id: 'earlier', kind: 'image', state: 'sent', filename: 'earlier.png', bytes: 1, at: new Date(0).toISOString() }];
  const f = fixture(t, copy, false, { session, imageReason: 'image normalizer not configured' }), originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/uploads') && options.method !== 'POST') return Response.json({ limits: { maxImagesPerSession: 1 } });
    if (url.endsWith('/uploads') && options.method === 'POST') return Response.json({
      refused: [{ index: 0, name: 'clipboard', kind: 'image', reason: 'image normalizer not configured' }],
      events: [{ sessionId: session.id, seq: f.c.session.seq + 1, type: 'upload.state', data: { id: 'eligible', filename: 'eligible.pdf', state: 'accepted', bytes: 1, at: new Date(0).toISOString() } }],
    }, { status: 202 });
    return originalFetch(url, options);
  });
  await choose(f.root, [new window.File(['pixels'], 'clipboard', { type: 'image/png' }), new window.File(['x'], 'eligible.pdf')]);
  assert.deepEqual(f.c.session.uploads.map(upload => upload.filename), ['earlier.png', 'eligible.pdf']);
  assert.equal(f.root.querySelector('.composer-reason').textContent, copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'clipboard')));
  assert.equal(f.root.querySelector('.image-refusals'), null);
});

for (const copy of [en, de]) test(`AIT-561 Low 2: ${copy.display.locale} a document-only consent race keeps the type refusal`, async t => {
  const f = fixture(t, copy, false, { imageReason: 'image normalizer not configured' }), original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => url.endsWith('/uploads') && options.method === 'POST'
    ? Response.json({ events: [], refused: [{ index: 0, kind: 'image', reason: 'current processing consent required' }] }, { status: 202 }) : original(url, options));
  await choose(f.root, [new window.File(['pixels'], 'clipboard')]);
  assert.deepEqual(f.asks, []);
  assert.equal(f.root.querySelector('.composer-reason').textContent, copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'clipboard')));
});

for (const copy of [en, de]) for (const action of ['decline', 'expiry', 'new-selection'])
  test(`AIT-561 Low 3: ${copy.display.locale}/${action} detected-image consent ends visibly and old timers cannot replace a new notice`, async t => {
    const f = fixture(t, copy, false), original = globalThis.fetch, schedule = globalThis.setTimeout, timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
      return schedule(callback, delay, ...args);
    });
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => url.endsWith('/uploads') && options.method === 'POST'
      ? Response.json({ events: [], refused: [{ index: 0, kind: 'image', reason: 'current processing consent required' }] }, { status: 202 }) : original(url, options));
    await choose(f.root, [new window.File(['pixels'], 'clipboard'), new window.File(['x'], 'blocked.exe')]);
    assert.equal(f.asks.length, 1); assert.equal(timers.length, 1);
    if (action === 'decline') f.asks[0].cancel();
    else if (action === 'expiry') timers[0]();
    else await choose(f.root, [new window.File(['x'], 'newer.exe')]);
    const expected = action === 'new-selection'
      ? copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'newer.exe')) + ' ' + copy.uploadsSupported
      : copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'blocked.exe')) + reasonSeparator + copy.uploadsReselect.one;
    assert.equal(f.root.querySelector('.composer-reason').textContent, expected);
    timers[0]();
    assert.equal(f.root.querySelector('.composer-reason').textContent, expected, 'even an already queued callback cannot overwrite current feedback');
    assert.equal(f.root.querySelector('.composer-reason .consent-action'), null);
    assert.equal(f.calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/uploads')).length, 1);
  });
