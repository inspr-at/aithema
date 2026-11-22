import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Session } from 'node:inspector';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { WARNING_ICON } from '../src/concept-view.js';
import { UPLOAD_LIMITS, uploadRetryDelay, planUploads, refusalText, formatBytes, uploadStateText, uploadStateTexts, filePartBytes, formBytes, limitsText, dropText, uploadsPossible } from '../src/uploads.js';
// Node's own FormData and File encode a real multipart body; the component tests below use the window's.
const { FormData: NodeFormData, File: NodeFile } = globalThis;
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const warningFixture = document.createElement('span'); warningFixture.innerHTML = WARNING_ICON;
const tick = () => new Promise(r => setImmediate(r));
// Component tests build files and forms the way the page does: with the window's own classes.
globalThis.FormData = window.FormData;
const file = (name, size = 4) => new window.File(['x'.repeat(size)], name);
const at = second => new Date(Date.UTC(2026, 9, 10, 12, 0, second)).toISOString();
const pending = (id, extra = {}) => ({ id, state: 'pending', filename: `${id}.txt`, mediaType: 'text/plain', bytes: 2048, at: at(10), ...extra });

// A connected component on a fixture server: owner routes answer like the B1 handlers.
function setup(t, { copy = en, baseUrl = '', uploads = [], transcript = [], feature = { available: true, reason: null }, limits = UPLOAD_LIMITS, get, post, withdraw, entrance = 'choice', images = false } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.transcript = transcript; session.uploads = uploads; session.inputRevision = transcript.length;
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, uploads: feature, ...(images ? { imageInput: { available: true } } : {}) } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/locale') && options.method === 'POST') return Response.json({ event: {
      sessionId: c.session.id, seq: c.session.seq + 1, type: 'session.locale-changed', data: { locale: JSON.parse(options.body).locale },
    } });
    if (url.endsWith('/uploads') && !options.method) return get ? get() : Response.json({ uploads: c.session.uploads, limits });
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const response = await post?.(options.body, options);
      if (response) return response;
      const events = options.body.getAll('files').map((f, i) => ({ sessionId: c.session.id, seq: c.session.seq + 1 + i, type: 'upload.state',
        data: { id: `u-${f.name}`, state: 'pending', filename: f.name, bytes: f.size, at: at(30 + i) } }));
      return Response.json({ accepted: true, uploads: events.map(e => e.data), events, replayed: false, limits }, { status: 202 });
    }
    if (url.endsWith('/withdraw')) {
      if (withdraw) return withdraw();
      const id = /\/uploads\/([^/]+)\/withdraw$/u.exec(url)[1];
      return Response.json({ withdrawn: id, event: { sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { id, state: 'withdrawn', erased: true, withdrawn: true } } });
    }
    return Response.json(c.session);
  });
  c.configure({ copy, copyForLocale: locale => ({ en, de })[locale], session, sessionToken: 'owner-fixture', baseUrl, entrance }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls };
}
const choose = async (root, files) => {
  const input = root.querySelector('.attach-input'), transfer = new window.DataTransfer();
  for (const f of files) transfer.items.add(f);
  input.files = transfer.files; input.dispatchEvent(new window.Event('change')); await tick(); await tick();
};
const state = (c, upload) => c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: upload });
const rows = root => [...root.querySelectorAll('ol > li')].map(row => row.classList.contains('upload')
  ? `file ${row.querySelector('.upload__name').textContent}` : row.querySelector('span').textContent);
const owned = calls => calls.filter(call => !call.url.endsWith('/events') && new Headers(call.options.headers).get('x-aithema-session-token') === 'owner-fixture');

test('client limits: type and size refused per file, count and session totals per batch, requests packed under the request ceiling', () => {
  const limits = { ...UPLOAD_LIMITS, maxBytes: 100, maxRequestBytes: 4096, maxFilesPerRequest: 2, maxDocumentsPerSession: 4, maxSessionBytes: 300 };
  const plan = planUploads([file('notes.txt', 50), file('tool.exe'), file('huge.pdf', 101), file('README'), file('table.CSV', 60)], { limits });
  assert.deepEqual(plan.refused, [{ name: 'tool.exe', reason: 'type' }, { name: 'huge.pdf', reason: 'size', limit: 100 }]);
  assert.deepEqual(plan.batches.map(batch => batch.map(f => f.name)), [['notes.txt', 'README'], ['table.CSV']], 'two files per request; no extension is left to the server');
  assert.equal(plan.blocked, null);
  assert.equal(refusalText(en, plan, 'en'), 'Not attached: tool.exe (file type not accepted), huge.pdf (too large, up to 100 B per file).');
  assert.equal(refusalText(de, plan, 'de'), 'Nicht angehängt: tool.exe (Dateityp wird nicht angenommen), huge.pdf (zu groß, höchstens 100 B pro Datei).');
  const existing = [pending('a', { bytes: 90 }), pending('b', { bytes: 90 }), { id: 'gone', state: 'withdrawn', erased: true, withdrawn: true }];
  const full = planUploads([file('c.txt', 10), file('d.txt', 10), file('e.txt', 10)], { limits, uploads: existing });
  assert.equal(full.blocked, 'count'); assert.deepEqual(full.batches, [], 'an overfull batch is refused as a whole; withdrawn uploads free their slot');
  assert.equal(refusalText(en, full, 'en'), 'No more files fit in this conversation (up to 4).');
  const heavy = planUploads([file('c.txt', 99), file('d.txt', 99)], { limits, uploads: existing });
  assert.equal(heavy.blocked, 'session'); assert.equal(refusalText(de, heavy, 'de'), 'Diese Dateien passen nicht mehr in dieses Gespräch (höchstens 300 B insgesamt).');
  // The default ceilings, in plain words in both languages.
  assert.equal(formatBytes(UPLOAD_LIMITS.maxBytes, 'en'), '20 MB'); assert.equal(formatBytes(1536, 'de'), '1,5 KB'); assert.equal(formatBytes(820, 'en'), '820 B');
  const packed = planUploads(Array.from({ length: 4 }, (_, i) => file(`p${i}.pdf`, 20 * 1024 * 1024 - 4096)));
  assert.deepEqual(packed.batches.map(batch => batch.length), [1, 1, 1, 1], 'each 20 MiB document needs its own request under 21 MiB');
});

// The real body, as Node's fetch encodes it (the same HTML multipart/form-data algorithm as a browser).
async function encoded(files) {
  const form = new NodeFormData(); form.append('clientEventId', crypto.randomUUID());
  for (const f of files) form.append('files', f, f.name);
  const body = new Uint8Array(await new Response(form).arrayBuffer()), boundary = new TextDecoder().decode(body).split('\r\n')[0].slice(2);
  return { bytes: body.length, boundary: boundary.length };
}

test('multipart overhead is the exact encoded body: boundary, every part header with the escaped UTF-8 filename and type, and clientEventId', async () => {
  const cases = [[new NodeFile(['hello'], 'a.txt', { type: 'text/plain' })],
    [new NodeFile(['x'.repeat(300)], 'Übersicht "Q3"\r\nfinal 📄.pdf', { type: 'application/pdf' }), new NodeFile([''], 'leer'), new NodeFile(['{}'], 'données.json', { type: 'application/json' })]];
  for (const files of cases) {
    const real = await encoded(files);
    assert.equal(formBytes(real.boundary) + files.reduce((sum, f) => sum + filePartBytes(f, real.boundary) + f.size, 0), real.bytes, files.map(f => f.name).join(', '));
  }
  // The browser picks the boundary; the count assumes the longest the server accepts (70), so it never falls
  // short: the boundary appears once per field, once per file and once to close.
  const [one] = cases[0], real = await encoded([one]);
  assert.equal(formBytes() + filePartBytes(one) + one.size, real.bytes + 3 * (70 - real.boundary));
});

test('a 1 KB request limit still takes a five-byte file; limits too small for any file say so, never a negative size', async t => {
  const limits = { ...UPLOAD_LIMITS, maxRequestBytes: 1024 }, small = new NodeFile(['hello'], 'notes.txt', { type: 'text/plain' });
  assert.ok((await encoded([small])).bytes <= 1024, 'its real body fits');
  const plan = planUploads([small], { limits });
  assert.deepEqual(plan.refused, []); assert.deepEqual(plan.batches.map(batch => batch.map(f => f.name)), [['notes.txt']]);
  // Two of them share one request; two 300-byte files no longer fit one 1 KB request together, so each goes alone.
  assert.deepEqual(planUploads([small, new NodeFile(['hello'], 'more.txt', { type: 'text/plain' })], { limits }).batches.map(batch => batch.length), [2]);
  const pair = ['a.txt', 'b.txt'].map(name => new NodeFile(['x'.repeat(300)], name, { type: 'text/plain' }));
  assert.ok((await encoded(pair)).bytes > 1024 && (await encoded(pair.slice(0, 1))).bytes <= 1024);
  assert.deepEqual(planUploads(pair, { limits }).batches.map(batch => batch.length), [1, 1]);
  const shown = limitsText(en, limits, 'en');
  assert.match(shown, /^Up to 8 files, \d+ B each:/u); assert.doesNotMatch(shown + dropText(de, limits, 'de'), /-\d/u);
  const big = new NodeFile(['x'.repeat(900)], 'big.txt', { type: 'text/plain' }), refused = planUploads([big], { limits });
  assert.equal(refused.refused[0].reason, 'size'); assert.ok(refused.refused[0].limit > 0 && refused.refused[0].limit < 900);
  assert.match(refusalText(en, refused, 'en'), /^Not attached: big\.txt \(too large, up to \d+ B per file\)\.$/u);
  // A host limit smaller than any file part: uploads are plainly not possible.
  for (const maxRequestBytes of [100, 300]) {
    const tiny = { ...UPLOAD_LIMITS, maxRequestBytes };
    assert.equal(uploadsPossible(tiny), false);
    assert.equal(limitsText(en, tiny, 'en'), en.uploads.impossible); assert.equal(dropText(de, tiny, 'de'), de.uploads.impossible);
    assert.equal(refusalText(en, planUploads([new NodeFile(['a'], 'a.txt')], { limits: tiny }), 'en'), 'Files cannot be uploaded: the upload limits of this host leave no room for a file.');
  }
  assert.equal(uploadsPossible(limits), true);
  // In the component: the five-byte file is sent under the host's 1 KB limit.
  const { root, calls } = setup(t, { limits });
  await choose(root, [file('notes.txt', 5)]);
  assert.equal(root.querySelector('.composer-reason').textContent.includes('Not attached'), false, root.querySelector('.composer-reason').textContent);
  assert.deepEqual(calls.find(call => call.options.method === 'POST')?.options.body.getAll('files').map(f => f.name), ['notes.txt']);
  // Once a host's limits leave no room, Attach says so and no longer opens the picker.
  const tiny = setup(t, { limits: { ...UPLOAD_LIMITS, maxRequestBytes: 100 } }), attach = tiny.root.querySelector('.attach');
  let picked = 0; t.mock.method(tiny.root.querySelector('.attach-input'), 'click', () => { picked++; });
  attach.click(); await tick(); await tick();
  assert.equal(picked, 1); assert.equal(attach.getAttribute('aria-disabled'), 'true'); assert.equal(attach.title, en.uploads.impossible);
  attach.click(); assert.equal(picked, 1); assert.equal(tiny.root.querySelector('.composer-reason').textContent, en.uploads.impossible);
});

test('an empty file is checked with its headers: under a 100-byte request limit dropping or picking empty.txt sends nothing and says uploads are not possible', async t => {
  const tiny = { ...UPLOAD_LIMITS, maxRequestBytes: 100 }, empty = new NodeFile([''], 'empty.txt', { type: 'text/plain' });
  assert.ok((await encoded([empty])).bytes > 100, 'its real body is over the limit');
  const plan = planUploads([empty], { limits: tiny });
  assert.deepEqual(plan.batches, []); assert.deepEqual(plan.refused, [{ name: 'empty.txt', reason: 'size', limit: 0 }]);
  assert.equal(refusalText(en, plan, 'en'), en.uploads.impossible);
  // Room for a one-byte file without a name or type, but not for this empty file's own headers.
  let tight = tiny; while (!uploadsPossible(tight)) tight = { ...tight, maxRequestBytes: tight.maxRequestBytes + 1 };
  assert.ok(formBytes() + filePartBytes(empty) > tight.maxRequestBytes);
  assert.deepEqual(planUploads([empty], { limits: tight }).batches, [], 'its part headers alone are over the request limit');
  // In the component: a drop before the host's limits are known, a drop once Attach is aria-disabled, and the picker.
  const { root, calls } = setup(t, { limits: tiny }), zone = root.querySelector('.conversation');
  const drop = async () => {
    for (const type of ['dragenter', 'drop']) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file('empty.txt', 0)], dropEffect: 'none' } }); zone.dispatchEvent(event);
    }
    await tick(); await tick();
  };
  const posts = () => calls.filter(call => call.options.method === 'POST').length;
  await drop();
  assert.equal(posts(), 0, 'dropping empty.txt sends no request');
  assert.equal(root.querySelector('.composer-reason').textContent, en.uploads.impossible);
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'true');
  await drop(); await choose(root, [file('empty.txt', 0)]);
  assert.equal(posts(), 0, 'no path sends while Attach is aria-disabled');
  assert.equal(root.querySelector('.composer-reason').textContent, en.uploads.impossible);
});

test('chips: pending, accepted and unreadable with the localized reason, keyed by upload id, names as text and placed where they arrived', t => {
  const { c, root } = setup(t, { transcript: [{ id: 't1', role: 'user', content: 'First', at: at(5) }, { id: 't2', role: 'user', content: 'Later', at: at(20) }] });
  state(c, pending('u1', { filename: '<img src=x onerror=alert(1)>.txt' }));
  const chip = root.querySelector('.upload');
  assert.equal(chip.querySelector('img'), null); assert.equal(chip.querySelector('.upload__name').textContent, '<img src=x onerror=alert(1)>.txt');
  assert.equal(chip.querySelector('.upload__size').textContent, '2 KB'); assert.equal(chip.querySelector('.upload__state').textContent, en.uploads.pending);
  assert.equal(chip.querySelector('.upload-withdraw').textContent, 'Withdraw upload');
  assert.deepEqual(rows(root), ['First', 'file <img src=x onerror=alert(1)>.txt', 'Later'], 'between the turns saved before and after it');
  state(c, { ...pending('u1', { filename: 'notes.txt' }), state: 'accepted', text: 'Never shown', truncated: false });
  assert.equal(root.querySelector('.upload'), chip, 'the chip keeps its node across states');
  assert.equal(chip.dataset.state, 'accepted'); assert.equal(chip.querySelector('.upload__state').textContent, en.uploads.accepted);
  assert.equal(root.innerHTML.includes('Never shown'), false, 'extracted text never reaches the page');
  state(c, { ...pending('u1', { filename: 'notes.txt' }), state: 'accepted', truncated: true });
  assert.equal(chip.querySelector('.upload__state').textContent, en.uploads.truncated);
  state(c, pending('u2', { filename: 'locked.pdf', state: 'unreadable', reason: 'encrypted', at: at(25) }));
  assert.equal(root.querySelector('[data-id="upload:u2"] .upload__state').textContent, 'Not readable: the file is password-protected. Please paste the relevant part as text.');
  assert.deepEqual(rows(root), ['First', 'file notes.txt', 'Later', 'file locked.pdf']);
  assert.equal(uploadStateText(de, { state: 'unreadable', reason: 'deadline' }), 'Nicht lesbar: das Auslesen hat zu lange gedauert. Bitte fügen Sie den relevanten Teil als Text ein.');
  assert.equal(uploadStateText(en, { state: 'unreadable', reason: 'future-reason' }), 'Not readable: reading is not available right now. Please paste the relevant part as text.');
  // Fixed slots: the action slot keeps the label's width after withdrawal, and the state slot holds every
  // state of this language invisibly, so it is as tall as the longest; the stand-ins are hidden from assistive technology.
  const sizers = [...chip.querySelectorAll('.upload__status .upload__sizer')].map(n => n.textContent);
  assert.deepEqual(sizers, uploadStateTexts(en)); assert.ok(sizers.includes(uploadStateText(en, { state: 'unreadable', reason: 'malformed' })));
  assert.equal(chip.querySelector('.upload__action .upload__sizer').textContent, en.uploads.withdraw);
  assert.ok([...chip.querySelectorAll('.upload__sizer')].every(n => n.getAttribute('aria-hidden') === 'true'));
  assert.match(root.querySelector('style').textContent, /\.upload \{ align-self:flex-end; width:min\(34rem,78%\);/u);
  assert.match(root.querySelector('style').textContent, /\.upload__sizer \{ visibility:hidden; \}/u);
});

test('Withdraw upload posts to the owner route, keeps the row in place as a tombstone and keeps focus there', async t => {
  const { c, root, calls } = setup(t, { uploads: [pending('u1', { state: 'accepted' })], transcript: [{ id: 't1', role: 'user', content: 'First', at: at(5) }] });
  c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: 'a1', role: 'assistant', content: 'Reply', at: at(15) } });
  const chip = root.querySelector('.upload'), button = chip.querySelector('.upload-withdraw');
  button.focus(); assert.ok(root.activeElement === button);
  // An unrelated live update keeps the focused button.
  state(c, pending('u2', { at: at(40) }));
  assert.ok(root.activeElement === button, 'focus survives a live update'); assert.equal(button.isConnected, true);
  button.click(); await tick(); await tick();
  const call = calls.find(entry => entry.url.endsWith('/withdraw'));
  assert.equal(call.url, `/api/sessions/${c.session.id}/uploads/u1/withdraw`); assert.equal(call.options.method, 'POST');
  assert.equal(new Headers(call.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  assert.equal(root.querySelector('[data-id="upload:u1"]'), chip, 'the withdrawn chip keeps its node and place');
  assert.equal(chip.dataset.state, 'withdrawn'); assert.equal(chip.querySelector('.upload__name').textContent, en.uploads.withdrawn);
  assert.equal(chip.querySelector('.upload__size').textContent, ''); assert.equal(chip.querySelector('.upload-withdraw'), null);
  assert.ok(root.activeElement === chip, 'focus moves to the row, not to the page');
  assert.deepEqual(rows(root), ['First', `file ${en.uploads.withdrawn}`, 'file u2.txt'], 'the reply built on the file is withdrawn with it');
  assert.equal(c.session.uploads.find(u => u.id === 'u1').filename, undefined);
});

test('a failed withdrawal says so and keeps the chip', async t => {
  const { root } = setup(t, { uploads: [pending('u1')], withdraw: () => new Response(null, { status: 500 }) });
  root.querySelector('.upload-withdraw').click(); await tick(); await tick();
  assert.equal(root.querySelector('.status__label').textContent, en.uploads.withdrawFailed);
  assert.equal(root.querySelector('.upload').dataset.state, 'pending'); assert.equal(root.querySelector('.upload-withdraw').hasAttribute('aria-disabled'), false);
});

test('attaching sends one multipart request with the owner header, announces it and shows the chip from the acknowledgement', async t => {
  const { c, root, calls } = setup(t);
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  assert.equal(root.querySelector('.attach').title, 'Up to 8 files, 20 MB each: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON or XML. The original file is not stored.');
  assert.equal(root.querySelector('#attach-limits').textContent, root.querySelector('.attach').title);
  await choose(root, [file('brief.pdf', 1200), file('notes.md', 30)]);
  const post = calls.find(call => call.options.method === 'POST');
  assert.equal(post.url, `/api/sessions/${c.session.id}/uploads`);
  assert.equal(new Headers(post.options.headers).get('x-aithema-session-token'), 'owner-fixture');
  assert.equal(new Headers(post.options.headers).has('content-type'), false, 'the browser sets the multipart boundary');
  assert.match(post.options.body.get('clientEventId'), /^[0-9a-f-]{36}$/u); assert.deepEqual(post.options.body.getAll('files').map(f => f.name), ['brief.pdf', 'notes.md']);
  assert.deepEqual(rows(root), ['file brief.pdf', 'file notes.md']);
  assert.equal(root.querySelector('.status__label').textContent, '2 files received. Reading them…');
  assert.equal(root.querySelector('.intro').hidden, true, 'an upload starts the conversation');
});

test('client-side refusals in plain words before sending, with the host limits; only fitting files are sent', async t => {
  const { root, calls } = setup(t, { copy: de, limits: { ...UPLOAD_LIMITS, maxBytes: 100 } });
  await choose(root, [file('angebot.pdf', 120), file('skript.sh'), file('liste.csv', 40)]);
  assert.equal(root.querySelector('.composer-reason').textContent, 'Nicht angehängt: angebot.pdf (zu groß, höchstens 100 B pro Datei), skript.sh (Dateityp wird nicht angenommen).');
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].options.body.getAll('files').map(f => f.name), ['liste.csv']);
  assert.equal(root.querySelector('.attach').title, 'Bis zu 8 Dateien, je höchstens 100 B: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON oder XML. Die Originaldatei wird nicht aufbewahrt.');
  // Typing clears the refusal; a choice that fits nothing sends nothing.
  root.querySelector('textarea').dispatchEvent(new window.Event('input'));
  assert.match(root.querySelector('.composer-reason').textContent, /^(?:Strg|⌘) \+ Enter zum Senden$/u);
  await choose(root, [file('bild.png')]);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(root.querySelector('.composer-reason').textContent, 'Nicht angehängt: bild.png (Dateityp wird nicht angenommen).');
  assert.equal(root.querySelector('.image-refusals'), null, 'AIT-556 preserves main type refusals without image input');
});

test('server refusals say what happened: limits and an unavailable feature', async t => {
  for (const [response, words] of [[Response.json({ error: 'size-limit' }, { status: 413 }), en.uploads.overLimit],
    [Response.json({ error: 'uploads-unavailable', reason: 'extractor unhealthy' }, { status: 403 }), 'Files cannot be attached: Document extractor is not responding'],
    [new Response('nope', { status: 500 }), en.uploads.failed]]) {
    const { c, root } = setup(t, { post: () => response });
    await choose(root, [file('a.txt')]);
    assert.equal(root.querySelector('.composer-reason').textContent, words); assert.equal(root.querySelectorAll('.upload').length, 0);
    c.remove();
  }
});

test('four 11 MiB files succeed without manual retry after a failed limits GET and a busy fourth request', async t => {
  let attempts = 0;
  const { root, calls } = setup(t, { get: () => new Response(null, { status: 503 }), post: () => {
    if (++attempts === 4) return Response.json({ error: 'upload-rate-limit' }, { status: 429 });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, Array.from({ length: 4 }, (_, i) => file(`large-${i}.txt`, 11 * 1024 * 1024)));
  assert.equal(attempts, 4); assert.equal(root.querySelectorAll('.upload').length, 3);
  assert.notEqual(root.querySelector('.composer-reason').textContent, en.uploads.busy);
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'true');
  t.mock.timers.tick(4999); await tick(); assert.equal(attempts, 4);
  t.mock.timers.tick(1); await tick(); await tick();
  assert.equal(attempts, 5); assert.equal(root.querySelectorAll('.upload').length, 4);
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  assert.notEqual(root.querySelector('.composer-reason').textContent, en.uploads.busy);
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.ok(posts.every(call => call.options.body.getAll('files').length === 1), 'the fallback splits under 21 MiB');
  assert.equal(posts[3].options.body.get('clientEventId'), posts[4].options.body.get('clientEventId'), 'retry keeps the receipt ID');
});

test('the truthful retry line appears only after three failed attempts, honoring Retry-After', async t => {
  let attempts = 0;
  const { root } = setup(t, { post: () => {
    attempts++;
    return Response.json({ error: 'upload-rate-limit' }, { status: 429, headers: { 'Retry-After': '7' } });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, [file('a.txt')]);
  t.mock.timers.tick(6999); await tick(); assert.equal(attempts, 1);
  assert.notEqual(root.querySelector('.composer-reason').textContent, en.uploads.busy);
  t.mock.timers.tick(1); await tick(); await tick(); assert.equal(attempts, 2);
  t.mock.timers.tick(9999); await tick(); assert.equal(attempts, 2);
  t.mock.timers.tick(1); await tick(); await tick(); assert.equal(attempts, 3);
  assert.equal(root.querySelector('.composer-reason').textContent, '1 file not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard');
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  t.mock.timers.tick(60_000); await tick(); assert.equal(attempts, 3, 'no fourth attempt');
});

for (const copy of [de, en]) for (const count of [1, 2]) test(`AIT-219: ${copy.display.locale} exhausted ${count} file(s) retry the retained files without picking again`, async t => {
  let failing = true;
  const { c, root, calls } = setup(t, { copy, post: () => failing ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : undefined });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const files = Array.from({ length: count }, (_, i) => file(`retained-${i}.txt`, 10 + i));
  const descriptors = files => files.map(f => ({ name: f.name, size: f.size }));
  const posts = () => calls.filter(call => call.options.method === 'POST');
  await choose(root, files);
  assert.equal(root.querySelector('.upload-retry'), null, 'no exhausted action during the first attempt');
  t.mock.timers.tick(5000); await tick(); await tick();
  assert.equal(root.querySelector('.upload-retry'), null, 'no exhausted action during the second attempt');
  t.mock.timers.tick(10000); await tick(); await tick();
  const expected = copy === de
    ? `${count} ${count === 1 ? 'Datei' : 'Dateien'} nicht hochgeladen: Der Server ist gerade ausgelastet\u00a0· Erneut versuchen\u00a0· Verwerfen`
    : `${count} ${count === 1 ? 'file' : 'files'} not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard`;
  assert.equal(root.querySelector('.composer-reason').textContent, expected);
  assert.equal(posts().length, 3); assert.equal(c.session.uploads.length, 0);
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  root.querySelector('textarea').dispatchEvent(new window.Event('input'));
  assert.equal(root.querySelector('.composer-reason').textContent, expected, 'typing keeps the retained-file action available');
  failing = false;
  root.querySelector('.upload-retry').click(); await tick(); await tick();
  assert.equal(posts().length, 4);
  assert.deepEqual(descriptors(posts().at(-1).options.body.getAll('files')), descriptors(files));
  assert.deepEqual(await Promise.all(posts().at(-1).options.body.getAll('files').map(f => f.text())), await Promise.all(files.map(f => f.text())));
  assert.equal(c.session.uploads.length, count); assert.equal(root.querySelector('.upload-retry'), null);
});

test('AIT-219: retry retains only unsent batches after an earlier batch succeeds', async t => {
  let attempts = 0, failing = true;
  const { c, root, calls } = setup(t, { limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 1 }, post: () => {
    if (++attempts > 1 && failing) return Response.json({ error: 'upload-rate-limit' }, { status: 429 });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, [file('accepted.txt'), file('refused.txt', 8), file('unsent.txt', 12)]);
  t.mock.timers.tick(5000); await tick(); await tick();
  t.mock.timers.tick(10000); await tick(); await tick();
  assert.equal(c.session.uploads.length, 1);
  assert.equal(root.querySelector('.composer-reason').textContent, '2 files not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard');
  failing = false;
  root.querySelector('.upload-retry').click(); await tick(); await tick();
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').slice(4).map(call => call.options.body.getAll('files').map(f => f.name)), [['refused.txt'], ['unsent.txt']]);
  assert.equal(c.session.uploads.length, 3);
});

// Inspect private storage without exposing a production getter or keeping extra File references.
async function retainedFiles(c) {
  const inspector = new Session(); inspector.connect();
  const post = (method, params) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  globalThis.ait219Probe = c;
  try {
    const { result } = await post('Runtime.evaluate', { expression: 'globalThis.ait219Probe' });
    const { privateProperties } = await post('Runtime.getProperties', { objectId: result.objectId });
    const files = privateProperties.find(property => property.name === '#retryFiles');
    assert.ok(files, 'inspect the actual retained File list');
    const value = await post('Runtime.callFunctionOn', { objectId: files.value.objectId,
      functionDeclaration: 'function() { return this.map(file => file.name); }', returnByValue: true });
    return value.result.value;
  } finally { delete globalThis.ait219Probe; inspector.disconnect(); }
}
async function exhaust(t, root, files = [file('retained.txt')]) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, files);
  t.mock.timers.tick(5000); await tick(); await tick();
  t.mock.timers.tick(10000); await tick(); await tick();
}
for (const copy of [de, en]) for (const count of [1, 2]) test(`AIT-219 round 7: ${copy.display.locale} ${count} retained file(s) keep a complete retry line across locale changes`, async t => {
  const { c, root, calls } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
  const files = Array.from({ length: count }, (_, i) => file(`retained-${i}.txt`));
  const source = copy === de ? 'de' : 'en', target = source === 'de' ? 'en' : 'de';
  const busy = locale => locale === 'de'
    ? `${count} ${count === 1 ? 'Datei' : 'Dateien'} nicht hochgeladen: Der Server ist gerade ausgelastet\u00a0· Erneut versuchen\u00a0· Verwerfen`
    : `${count} ${count === 1 ? 'file' : 'files'} not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard`;
  const line = () => root.querySelector('.composer-reason').textContent;
  const shortcut = line();
  await exhaust(t, root, files);
  assert.equal(line(), busy(source));
  assert.equal(await c.changeLocale(target), true);
  assert.equal(line(), busy(target));
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(Boolean(root.querySelector('.upload-retry')), false, 'a pause removes retry without a refused click');
  assert.equal(await c.changeLocale(source), true);
  assert.equal(line(), copy === de
    ? 'Dateien können nicht angehängt werden: Gespräch pausiert\u00a0· Verwerfen'
    : 'Files cannot be attached: Conversation paused\u00a0· Discard');
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
  assert.equal(await c.changeLocale(target), true);
  assert.equal(line(), busy(target), 'a resolved refusal returns to the full retained-file count');
  assert.deepEqual(await retainedFiles(c), files.map(f => f.name));
  assert.equal(calls.filter(call => call.url.endsWith('/uploads') && call.options.method === 'POST').length, 3, 'locale changes never resend files');
  root.querySelector('.upload-discard').click();
  assert.equal(await c.changeLocale(source), true);
  assert.equal(line(), shortcut, 'no retry fragment remains after discard');
  assert.equal(root.querySelector('.upload-retry'), null);
  assert.equal(root.querySelector('.upload-discard'), null);
  assert.deepEqual(await retainedFiles(c), []);
});
for (const copy of [de, en]) {
  test(`AIT-219 round 8: ${copy.display.locale} pause keeps files with Discard only; resume restores manual retry`, async t => {
    const { c, root, calls } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    await exhaust(t, root);
    const busy = root.querySelector('.composer-reason').textContent;
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
    const refusal = copy.uploads.unavailable.replace('{reason}', copy.reasons['session paused']);
    assert.equal(Boolean(root.querySelector('.upload-retry')), false, 'no retry while paused');
    assert.equal(root.querySelector('.composer-reason').textContent, `${refusal}\u00a0· ${copy.uploads.discard}`);
    assert.deepEqual(await retainedFiles(c), ['retained.txt']);
    const discard = root.querySelector('.upload-discard');
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
    assert.equal(root.querySelector('.composer-reason').textContent, busy);
    assert.ok(root.querySelector('.upload-retry'), 'resume makes a manual retry available');
    assert.equal(root.querySelector('.upload-discard'), discard, 'the shared action survives repaint');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 3, 'resume never uploads automatically');
    assert.deepEqual(await retainedFiles(c), ['retained.txt']);
    discard.click();
    assert.deepEqual(await retainedFiles(c), []);
    assert.equal(root.querySelector('.upload-retry'), null);
  });
  for (const ceiling of ['count', 'session']) test(`AIT-219 round 8: ${copy.display.locale} ${ceiling} limit keeps files with Discard only until room returns`, async t => {
    const limits = { ...UPLOAD_LIMITS, ...(ceiling === 'count' ? { maxDocumentsPerSession: 1 } : { maxSessionBytes: 4 }) };
    const { c, root, calls } = setup(t, { copy, limits, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    await exhaust(t, root);
    const busy = root.querySelector('.composer-reason').textContent;
    state(c, pending('takes-last-slot', { bytes: 4 }));
    const refusal = ceiling === 'count' ? copy.uploads.tooMany.replace('{files}', '1')
      : copy.uploads.sessionFull.replace('{size}', '4 B');
    assert.equal(Boolean(root.querySelector('.upload-retry')), false, 'no retry while over limits');
    assert.equal(root.querySelector('.composer-reason').textContent, `${refusal}\u00a0· ${copy.uploads.discard}`);
    assert.deepEqual(await retainedFiles(c), ['retained.txt']);
    state(c, { id: 'takes-last-slot', state: 'withdrawn', withdrawn: true, erased: true });
    assert.equal(root.querySelector('.composer-reason').textContent, busy);
    assert.ok(root.querySelector('.upload-retry'), 'freeing room restores manual retry');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 3, 'freeing room never uploads automatically');
    assert.deepEqual(await retainedFiles(c), ['retained.txt']);
    root.querySelector('.upload-discard').click();
    assert.deepEqual(await retainedFiles(c), []);
  });
  test(`AIT-219 round 6: ${copy.display.locale} mixed batch keeps refusal and exhaustion facts together`, async t => {
    const { c, root } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    await exhaust(t, root, [file('retained.txt'), file('tool.exe')]);
    const refused = copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'tool.exe'));
    assert.equal(root.querySelector('.composer-reason').textContent,
      `${refused}\u00a0· ${copy.uploads.notUploaded.one}\u00a0· ${copy.uploads.tryAgain}\u00a0· ${copy === de ? 'Verwerfen' : 'Discard'}`);
    root.querySelector('textarea').dispatchEvent(new window.Event('input'));
    assert.ok(root.querySelector('.composer-reason').textContent.startsWith(refused), 'typing cannot swallow a refusal while files are retained');
    assert.deepEqual(await retainedFiles(c), ['retained.txt']);
  });
}
for (const copy of [de, en]) test(`AIT-219 round 6: ${copy.display.locale} a busy new pick names the replacement and keeps only its own files`, async t => {
  const { c, root } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
  await exhaust(t, root);
  await choose(root, [file('new-a.txt'), file('new-b.txt')]);
  assert.deepEqual(await retainedFiles(c), [], 'the previous retained list is released as soon as the new pick starts');
  t.mock.timers.tick(5000); await tick(); await tick();
  t.mock.timers.tick(10000); await tick(); await tick();
  assert.deepEqual(await retainedFiles(c), ['new-a.txt', 'new-b.txt']);
  const replacement = copy === de ? 'Die zuvor nicht hochgeladenen Dateien wurden durch die neue Auswahl ersetzt.'
    : 'The previously unuploaded files were replaced by the new selection.';
  assert.equal(root.querySelector('.composer-reason').textContent,
    `${replacement}\u00a0· ${copy.uploads.notUploaded.other.replace('{count}', '2')}\u00a0· ${copy.uploads.tryAgain}\u00a0· ${copy === de ? 'Verwerfen' : 'Discard'}`);
  root.querySelector('.upload-discard').click();
  assert.deepEqual(await retainedFiles(c), []);
});
for (const action of ['discard', 'configure', 'disconnect', 'new pick']) test(`AIT-219 round 6: ${action} releases exhausted files from internal storage`, async t => {
  let failing = true;
  const { c, root, calls } = setup(t, { post: () => failing ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : undefined });
  await exhaust(t, root);
  assert.deepEqual(await retainedFiles(c), ['retained.txt']);
  if (action === 'discard') {
    root.querySelector('.upload-discard').click();
    assert.equal(root.querySelector('.composer-reason').textContent.includes(en.uploads.notUploaded.one), false);
    assert.equal(root.querySelector('.upload-discard'), null);
  } else if (action === 'configure') c.configure({ copy: en, session: c.session });
  else if (action === 'disconnect') c.remove();
  else {
    failing = false;
    await choose(root, [file('replacement.txt')]);
    assert.equal(root.querySelector('.composer-reason').textContent, 'The previously unuploaded files were replaced by the new selection.');
    assert.deepEqual(calls.filter(call => call.options.method === 'POST').at(-1).options.body.getAll('files').map(f => f.name), ['replacement.txt']);
  }
  assert.deepEqual(await retainedFiles(c), [], 'no exhausted File references remain');
});

test('busy retry delays handle Retry-After seconds and HTTP dates, with backoff for missing or invalid headers', () => {
  const now = Date.UTC(2026, 9, 16), delay = (value, attempt = 0) => uploadRetryDelay(new Response(null,
    { headers: value === null ? {} : { 'Retry-After': value } }), attempt, now);
  assert.equal(delay(null), 5000); assert.equal(delay('invalid', 1), 10000);
  assert.equal(delay('7'), 7000); assert.equal(delay('0'), 5000);
  assert.equal(delay(new Date(now + 12_000).toUTCString()), 12000);
  assert.equal(delay(new Date(now - 1000).toUTCString()), 5000);
  assert.equal(delay('3600'), 30000);
  assert.equal(delay(new Date(Date.UTC(2099, 0, 1)).toUTCString(), 1), 30000);
  assert.equal(delay('-3600'), 5000); assert.equal(delay('-9999', 1), 10000);
});

test('an hour or a distant HTTP date in Retry-After waits 30 seconds before the next POST', async t => {
  for (const header of ['3600', 'Thu, 01 Jan 2099 00:00:00 GMT']) await t.test(header, async t => {
    let attempts = 0;
    const { root } = setup(t, { post: () => {
      if (++attempts === 1) return Response.json({ error: 'upload-rate-limit' }, { status: 429, headers: { 'Retry-After': header } });
    } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await choose(root, [file('a.txt')]);
    t.mock.timers.tick(29999); await tick(); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await tick(); await tick(); assert.equal(attempts, 2);
    assert.equal(root.querySelectorAll('.upload').length, 1);
    assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false');
  });
});

test('removing the element during busy backoff stops all remaining POSTs and leaves its messages alone', async t => {
  const { c, root, calls } = setup(t, { limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 1 },
    post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, [file('a.txt'), file('b.txt')]);
  c.remove();
  const messages = () => ['.composer-reason', '.status__label'].map(selector => root.querySelector(selector).textContent);
  const before = messages();
  t.mock.timers.tick(60000); await tick(); await tick();
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1, 'neither retries nor later batches are sent');
  assert.equal(posts[0].options.signal?.aborted, true);
  assert.deepEqual(messages(), before, 'no failure or busy message is painted while detached');
  document.body.append(c); await tick();
  assert.equal(root.querySelector('.attach').getAttribute('aria-disabled'), 'false', 'a cancelled batch releases Attach on reconnect');
  t.mock.timers.tick(60000); await tick(); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('removing the element while limits load sends no POST and leaves its messages alone', async t => {
  let release;
  const { c, root, calls } = setup(t, { get: () => new Promise(resolve => { release = resolve; }) });
  await choose(root, [file('a.txt')]);
  c.remove();
  const before = root.querySelector('.status__label').textContent;
  release(Response.json({ limits: UPLOAD_LIMITS })); await tick(); await tick();
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(root.querySelector('.status__label').textContent, before);
});

test('removal or reconfiguration aborts an in-flight upload without painting a failure', async t => {
  for (const action of ['remove', 'configure']) await t.test(action, async t => {
    let signal, aborted = false;
    const { c, root, calls } = setup(t, { post: (_form, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    await choose(root, [file('a.txt')]);
    if (action === 'remove') c.remove();
    else c.configure({ copy: en, session: c.session, sessionToken: 'new-owner' });
    const before = root.querySelector('.composer-reason').textContent;
    await tick(); await tick();
    assert.equal(aborted, true); assert.equal(signal.aborted, true);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(root.querySelector('.composer-reason').textContent, before);
    assert.notEqual(before, en.uploads.failed);
  });
});

test('a new session during busy backoff receives no retry of the old files', async t => {
  const { c, root, calls } = setup(t, { post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await choose(root, [file('a.txt')]);
  c.configure({ copy: en, session: createSession({ demo: true }), sessionToken: 'new-owner' });
  assert.equal(calls.find(call => call.options.method === 'POST').options.signal?.aborted, true);
  t.mock.timers.tick(5000); await tick(); await tick();
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('gating: unavailable uploads keep Attach focusable, say the server reason and never open the picker or send', async t => {
  const { root, calls } = setup(t, { copy: de, feature: { available: false, reason: 'document text not covered by reasoning scope' } });
  const attach = root.querySelector('.attach'), reason = 'Dateien können nicht angehängt werden: Der Verarbeitungsumfang des gewählten Modells deckt den Text hochgeladener Dateien nicht ab';
  assert.equal(attach.disabled, false); assert.equal(attach.getAttribute('aria-disabled'), 'true'); assert.equal(attach.title, reason);
  assert.equal(root.querySelector('#attach-limits').textContent, reason);
  let picked = 0; t.mock.method(root.querySelector('.attach-input'), 'click', () => { picked++; });
  attach.click(); assert.equal(picked, 0); assert.equal(root.querySelector('.composer-reason').textContent, reason);
  const zone = root.querySelector('.conversation'), drag = type => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file('a.txt')], dropEffect: 'none' } }); zone.dispatchEvent(event); return event;
  };
  drag('dragenter'); assert.equal(zone.hasAttribute('data-dropping'), true);
  assert.equal(zone.querySelector('.drop-overlay strong').textContent, reason, 'the overlay says why before the drop');
  assert.equal(drag('drop').defaultPrevented, true, 'a refused drop never navigates the page'); await tick();
  assert.equal(zone.hasAttribute('data-dropping'), false);
  assert.equal(owned(calls).length, 0);
  // A pause closes uploading with its own reason.
  const paused = setup(t, { feature: { available: true, reason: null } });
  paused.c.receive({ sessionId: paused.c.session.id, seq: paused.c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(paused.root.querySelector('.attach').title, 'Files cannot be attached: Conversation paused');
});

test('dropping files on the conversation uploads them; the overlay is absolutely placed and leaves on drop', async t => {
  const { root, calls } = setup(t);
  const zone = root.querySelector('.conversation'), drag = (type, target = zone) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file('dropped.txt')], dropEffect: 'none' } }); target.dispatchEvent(event); return event;
  };
  drag('dragenter'); drag('dragenter', root.querySelector('textarea')); drag('dragleave', root.querySelector('textarea'));
  assert.equal(zone.hasAttribute('data-dropping'), true, 'leaving a child keeps the overlay');
  assert.equal(zone.querySelector('.drop-overlay strong').textContent, 'Release to attach');
  assert.equal(drag('dragover').defaultPrevented, true);
  drag('drop'); await tick(); await tick();
  assert.equal(zone.hasAttribute('data-dropping'), false);
  assert.deepEqual(calls.find(call => call.options.method === 'POST').options.body.getAll('files').map(f => f.name), ['dropped.txt']);
  assert.match(root.querySelector('style').textContent, /\.drop-overlay \{ position:absolute;/u);
  // Text drags (not files) are left to the page.
  const text = new window.Event('dragover', { bubbles: true, cancelable: true }); Object.defineProperty(text, 'dataTransfer', { value: { types: ['text/plain'] } });
  zone.dispatchEvent(text); assert.equal(text.defaultPrevented, false);
});

test('a foreign baseUrl receives no owner-authenticated upload request: limits, attach and withdraw are refused before sending', async t => {
  const { root, calls } = setup(t, { baseUrl: 'https://other.example', uploads: [pending('u1')] });
  root.querySelector('.attach').click(); await tick();
  await choose(root, [file('a.txt')]);
  root.querySelector('.upload-withdraw').click(); await tick();
  const foreign = calls.filter(call => /\/uploads/u.test(call.url));
  assert.deepEqual(foreign, [], 'nothing reaches another origin');
  assert.equal(root.querySelector('.composer-reason').textContent, en.uploads.failed);
  assert.equal(root.querySelector('.status__label').textContent, en.uploads.withdrawFailed);
  assert.equal(root.querySelector('.upload').dataset.state, 'pending');
});

for (const copy of [de, en]) for (const status of ['upload notice', 'retry', 'pause'])
  test(`AIT-280 ${copy.display.locale}: ${status} wins visually while a saved turn announces politely`, async t => {
    const { c, root } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    if (status === 'upload notice') await choose(root, [file('blocked.exe')]);
    if (status === 'retry') await exhaust(t, root);
    const reason = root.querySelector('.composer-reason'), before = reason.textContent;
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (!url.endsWith('/turns')) return fetch(url, options);
      if (status === 'pause') c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
      return Response.json({ seq: c.session.seq + 1, type: 'turn.final',
        data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: 'Hello' } });
    });
    root.querySelector('textarea').value = 'Hello';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
    assert.equal(root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    assert.equal(root.querySelector('.composer-saved span').textContent, '');
    assert.equal(root.querySelector('.composer-saved-announcement').textContent, copy.saved);
    if (status === 'pause') { assert.equal(root.querySelector('.composer-paused').hidden, false); assert.equal(root.querySelector('.composer-paused span').textContent, copy.composerPaused); }
    else assert.equal(reason.textContent, before, 'notice and its retry/discard actions remain intact');
    assert.equal(root.querySelector('.composer-dock > .status__label'), null, 'no Saved elsewhere');
  });

for (const copy of [de, en]) for (const notice of [false, true])
  test(`AIT-280 ${copy.display.locale}: failed send replaces ${notice ? 'upload notice' : 'shortcut'} until a successful retry`, async t => {
    const { c, root } = setup(t, { copy });
    if (notice) await choose(root, [file('blocked.exe')]);
    const before = root.querySelector('.composer-reason').textContent, fetch = globalThis.fetch;
    let fail = true;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (!url.endsWith('/turns')) return fetch(url, options);
      return fail ? Response.json({}, { status: 503 }) : Response.json({ seq: c.session.seq + 1, type: 'turn.final',
        data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: 'Hello' } });
    });
    const submit = async () => { root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); };
    root.querySelector('textarea').value = 'Hello'; await submit();
    assert.equal(root.querySelector('.composer-reason').textContent, copy.failed);
    assert.equal(root.querySelector('.composer-reason .warning svg').outerHTML, warningFixture.firstChild.outerHTML);
    assert.equal(root.querySelector('.composer-reason .warning .question-why').textContent, copy.failed.split('. ')[0] + '.');
    assert.equal(root.querySelector('.composer-reason').hasAttribute('data-shortcut'), false);
    assert.equal(root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    assert.equal(root.querySelector('.composer-saved-announcement').textContent, '');
    assert.equal(root.querySelector('textarea').value, 'Hello');
    const warning = root.querySelector('.composer-reason .warning');
    const detail = root.querySelector('.send-failure-detail');
    c.receive({ type: 'lane.status', data: { running: [], failures: [] } });
    assert.equal(root.querySelector('.composer-reason').textContent, copy.failed, 'unrelated repaint cannot clear the failure');
    assert.equal(root.querySelector('.composer-reason .warning'), warning, 'unrelated repaint does not remount the live warning');
    assert.equal(root.querySelector('.send-failure-detail'), detail, 'AIT-294: unrelated repaint preserves the full polite sentence node');
    await submit(); assert.equal(root.querySelector('.composer-reason').textContent, copy.failed, 'failed retry retains it');
    fail = false; await submit();
    assert.equal(root.querySelector('.composer-reason').textContent, before, 'successful retry restores the notice or hint');
    assert.equal(root.querySelector('.composer-saved-announcement').textContent, copy.saved);
  });

// Change the acknowledged verdict without configure (which resets send failures).
for (const copy of [de, en]) for (const blockedReason of ['current processing consent required', 'budget reconciling', 'budget denied', 'not admitted', 'session paused'])
  test(`AIT-280 r2 ${copy.display.locale}: ${blockedReason} supersedes failure and recovery enables Send`, async t => {
    const { c, root } = setup(t, { copy });
    const clean = setup(t, { copy });
    const fetch = globalThis.fetch;
    let verdict = { available: true };
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (url.endsWith('/turns')) return Response.json({}, { status: 503 });
      const component = url.endsWith(clean.c.session.id) ? clean.c : c;
      if (url.endsWith(component.session.id)) return Response.json({ ...component.session,
        featureMatrix: { best: { ...component.session.featureMatrix.best, text: verdict } } });
      return fetch(url, options);
    });
    root.querySelector('textarea').value = 'Keep this draft';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
    assert.equal(root.querySelector('.composer-reason').textContent, copy.failed);
    const refresh = async component => {
      component.receive({ seq: component.session.seq + 1, type: 'session.paused', data: { paused: false } });
      await tick(); await tick();
    };
    verdict = { available: false, reason: blockedReason };
    await refresh(clean.c); await refresh(c);
    assert.equal(root.querySelector('.composer-reason').textContent, clean.root.querySelector('.composer-reason').textContent,
      'a blocking verdict renders exactly as it does without a previous failure');
    assert.equal(root.querySelector('.send').disabled, true);
    assert.equal(root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    assert.equal(Boolean(root.querySelector('.composer-reason .consent-action')), blockedReason === 'current processing consent required');
    if (blockedReason === 'current processing consent required') {
      root.querySelector('.composer-reason .consent-action').click();
      assert.equal(root.querySelector('dialog.settings').open, true, 'the way out still opens');
    }
    verdict = { available: true }; await refresh(c);
    assert.equal(root.querySelector('.composer-reason').hasAttribute('data-shortcut'), true);
    assert.equal(root.querySelector('.composer-reason').textContent.includes(copy.failed), false);
    assert.equal(root.querySelector('.send').disabled, false);
    assert.equal(root.querySelector('textarea').value, 'Keep this draft');
  });

for (const copy of [de, en]) for (const action of ['retry', 'discard'])
  test(`AIT-280 r2 ${copy.display.locale}: failure keeps retained upload ${action} reachable`, async t => {
    let busy = true;
    const { c, root } = setup(t, { copy, post: () => busy ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : undefined });
    await exhaust(t, root);
    const fetch = globalThis.fetch;
    let verdict = { available: true };
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (url.endsWith('/turns')) return Response.json({}, { status: 503 });
      if (url.endsWith(c.session.id)) return Response.json({ ...c.session,
        featureMatrix: { best: { ...c.session.featureMatrix.best, text: verdict } } });
      return fetch(url, options);
    });
    root.querySelector('textarea').value = 'Hello';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
    const line = root.querySelector('.composer-reason');
    assert.equal(line.querySelector('.upload-retry-copy').textContent, copy.failed);
    assert.equal(line.querySelector('.upload-retry-actions').textContent, `${copy.uploads.tryAgain}\u00a0· ${copy.uploads.discard}`);
    assert.equal(line.querySelector('.send-failure-short')?.dataset.text ?? line.querySelector('.question-why').textContent, copy.failedShort);
    assert.equal(copy.failedShort, copy === de ? 'Nicht gespeichert.' : 'Not saved.');
    assert.equal(line.querySelector('.send-failure-detail').textContent, copy.failed.slice(copy.failed.indexOf('.') + 1));
    assert.equal(line.getAttribute('role'), 'status'); assert.equal(line.getAttribute('aria-live'), 'polite');
    assert.equal(line.hasAttribute('data-send-failed'), true);
    const warning = line.querySelector('.warning'), detail = line.querySelector('.send-failure-detail');
    c.receive({ type: 'lane.status', data: { running: [], failures: [] } });
    assert.equal(line.querySelector('.warning'), warning, 'AIT-294: retained-file repaint preserves the polite failure');
    assert.equal(line.querySelector('.send-failure-detail'), detail);
    assert.equal(line.querySelector('.upload-retry-copy .warning svg').outerHTML, warningFixture.firstChild.outerHTML);
    assert.equal(root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    assert.equal(root.querySelector('.composer-saved-announcement').textContent, '');
    assert.ok(line.querySelector('.upload-retry')); assert.ok(line.querySelector('.upload-discard'));
    assert.equal(line.querySelector('.upload-discard').getAttribute('aria-describedby'), 'upload-retry-reason');
    assert.equal(root.querySelector('#upload-retry-reason').textContent, copy.uploads.notUploaded.one, 'actions describe retained files, independently of send failure');
    // Consent wins over both the failed send and the upload notice, preserving all available ways out.
    verdict = { available: false, reason: 'current processing consent required' };
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } }); await tick(); await tick();
    assert.ok(line.querySelector('.consent-line-copy'));
    assert.ok(line.querySelector('.consent-action')); assert.ok(line.querySelector('.upload-discard'));
    assert.equal(line.querySelector('.consent-action').tagName, 'BUTTON');
    assert.equal(line.querySelector('.consent-action').type, 'button');
    assert.equal(line.querySelector('.warning'), null, 'consent supersedes the send warning');
    assert.equal(line.textContent.includes(copy.failed), false);
    if (action === 'discard') {
      line.querySelector('.upload-discard').click();
      assert.equal(line.querySelector('.upload-discard'), null, 'discard removes its actions even under consent');
      assert.ok(line.querySelector('.consent-line-copy'));
    }
    verdict = { available: true };
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } }); await tick(); await tick();
    assert.equal(line.textContent.includes(copy.failed), false, 'superseded failure cannot return');
    busy = false;
    if (action === 'retry') line.querySelector('.upload-retry').click();
    await tick(); await tick();
    assert.deepEqual(await retainedFiles(c), []);
    assert.equal(c.session.uploads.length, action === 'retry' ? 1 : 0);
  });

for (const copy of [de, en]) for (const retained of [false, true])
  test(`AIT-280 r2 ${copy.display.locale}: Saved stays assistive under consent${retained ? ' and retained actions' : ''}`, async t => {
    const { c, root } = setup(t, { copy, post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    if (retained) await exhaust(t, root);
    const fetch = globalThis.fetch;
    let blocked = false;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (url.endsWith('/turns')) return Response.json({ seq: c.session.seq + 1, type: 'turn.final',
        data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: 'Hello' } });
      if (url.endsWith(c.session.id)) return Response.json({ ...c.session,
        featureMatrix: { best: { ...c.session.featureMatrix.best, text: { available: !blocked, reason: blocked ? 'current processing consent required' : null } } } });
      return fetch(url, options);
    });
    root.querySelector('textarea').value = 'Hello';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
    blocked = true;
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } }); await tick(); await tick();
    assert.ok(root.querySelector('.composer-reason .consent-line-copy'));
    assert.equal(root.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
    assert.equal(root.querySelector('.composer-saved span').textContent, '');
    assert.equal(root.querySelector('.composer-saved-announcement').textContent, copy.saved);
    assert.equal(Boolean(root.querySelector('.upload-discard')), retained);
  });

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} legacy whole-request failure names its files and later batches continue`, async t => {
  let requests = 0;
  const { c, root, calls } = setup(t, { copy, limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 2 }, post: () => ++requests === 1
    ? Response.json({ error: 'uploads-unavailable', reason: 'image input not supported' }, { status: 403 }) : null });
  await choose(root, ['clipboard', 'eligible.pdf', 'eligible-later.pdf'].map(name => file(name)));
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => call.options.body.getAll('files').map(file => file.name)),
    [['clipboard', 'eligible.pdf'], ['eligible-later.pdf']]);
  assert.deepEqual(c.session.uploads.map(upload => upload.filename), ['eligible-later.pdf']);
  const notice = root.querySelector('.composer-reason').textContent;
  for (const name of ['clipboard', 'eligible.pdf']) assert.ok(notice.includes(`${name}: ${copy.uploads.unavailable.split('{reason}')[0]}`), notice);
});

for (const copy of [en, de]) test(`AIT-559: ${copy.display.locale} eight eligible PDFs plus a detected image reach both default-sized batches`, async t => {
  const attached = [], { c, root, calls } = setup(t, { copy, post: form => {
    const events = [], refused = [];
    for (const [index, file] of form.getAll('files').entries()) {
      if (file.name === 'scan.pdf') refused.push({ index, name: file.name, kind: 'image', reason: 'image normalizer not configured' });
      else { attached.push(file.name); events.push({ sessionId: c.session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: pending(`doc-${file.name}`, { filename: file.name, state: 'accepted' }) }); }
    }
    return Response.json({ events, refused }, { status: 202 });
  } });
  const names = ['scan.pdf', ...Array.from({ length: 8 }, (_, index) => `eligible-${index}.pdf`)];
  await choose(root, names.map(name => name === 'scan.pdf' ? new window.File([new Uint8Array([255, 216, 255, 224])], name, { type: 'application/pdf' }) : file(name)));
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => call.options.body.getAll('files').map(file => file.name)), [names.slice(0, 8), names.slice(8)]);
  assert.deepEqual(attached, names.slice(1));
  assert.equal(root.querySelector('.composer-reason').textContent, copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'scan.pdf')));
});

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const images of [false, true]) for (const capacity of ['count', 'session'])
  test(`AIT-561 Low 1: ${copy.display.locale}/${entrance}/${images}/${capacity} first pick keeps the specific capacity figure`, async t => {
    const limits = { ...UPLOAD_LIMITS, ...(capacity === 'session' ? { maxSessionBytes: 50 } : {}) };
    const { root, calls } = setup(t, { copy, entrance, images, limits });
    const files = Array.from({ length: capacity === 'count' ? 9 : 2 }, (_, i) => new window.File(['%PDF-' + 'x'.repeat(25)], `document-${i}.pdf`, { type: 'application/pdf' }));
    await choose(root, files);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
    assert.equal(root.querySelector('.composer-reason').textContent, capacity === 'count'
      ? copy.uploads.tooMany.replace('{files}', '8') : copy.uploads.sessionFull.replace('{size}', '50 B'));
  });

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const status of [401, 403, 409])
  test(`AIT-561 Low 4: ${copy.display.locale}/${entrance}/${status} final failure stops later batches and names every unsent file once`, async t => {
    const { root, calls } = setup(t, { copy, entrance, limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 2 },
      post: () => Response.json(status === 409 ? { error: 'conversation-paused', reason: 'purpose' } : { error: 'not-owner' }, { status }) });
    const names = ['first.pdf', 'second.pdf', 'later.pdf', 'last.pdf'];
    await choose(root, names.map(name => new window.File(['%PDF-fixture'], name)));
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    const failure = status === 409 ? copy.purposePaused : copy === en ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
    const notice = root.querySelector('.composer-reason').textContent;
    for (const name of names) assert.equal(notice.split(name).length - 1, 1, notice);
    assert.equal(notice.split(failure).length - 1, 1, notice);
    assert.equal(root.querySelector('.upload-retry'), null);
  });

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const images of [false, true]) for (const capacity of ['count', 'session'])
  test(`AIT-561 Low 1: ${copy.display.locale}/${entrance}/${images}/${capacity} retained retry keeps the specific capacity figure`, async t => {
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
    const { c, root, calls } = setup(t, { copy, entrance, images, limits: { ...UPLOAD_LIMITS, maxDocumentsPerSession: 2, maxSessionBytes: 100 },
      post: () => Response.json({ error: 'upload-rate-limit' }, { status: 429 }) });
    await choose(root, ['one.pdf', 'two.pdf'].map(name => new window.File(['%PDF-' + 'x'.repeat(25)], name)));
    for (let n = 0; n < 100 && !root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(root.querySelector('.upload-retry'));
    const attempts = calls.filter(call => call.options.method === 'POST').length;
    state(c, pending('other', { bytes: capacity === 'count' ? 1 : 50, kind: capacity === 'count' ? 'document' : 'image', state: 'accepted' }));
    assert.equal(root.querySelector('.composer-reason').textContent.includes(capacity === 'count'
      ? copy.uploads.tooMany.replace('{files}', '2') : copy.uploads.sessionFull.replace('{size}', '100 B')), true);
    assert.equal(root.querySelector('.upload-retry'), null);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, attempts);
  });

for (const copy of [en, de]) test(`AIT-561 Low 4: ${copy.display.locale} final failure after a successful batch names only unsent files`, async t => {
  let requests = 0;
  const { c, root, calls } = setup(t, { copy, limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 2 },
    post: () => ++requests === 1 ? null : Response.json({ error: 'conversation-paused', reason: 'purpose' }, { status: 409 }) });
  const names = Array.from({ length: 6 }, (_, i) => `document-${i}.pdf`);
  await choose(root, names.map(name => new window.File(['%PDF-fixture'], name)));
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
  assert.deepEqual(c.session.uploads.map(upload => upload.filename), names.slice(0, 2));
  const notice = root.querySelector('.composer-reason').textContent;
  for (const name of names.slice(0, 2)) assert.equal(notice.includes(name), false);
  for (const name of names.slice(2)) assert.equal(notice.split(name).length - 1, 1);
  assert.equal(notice.split(copy.purposePaused).length - 1, 1);
});

for (const copy of [en, de]) for (const entrance of ['choice', 'combined'])
  test(`AIT-561 Low 1: ${copy.display.locale}/${entrance} eight PDFs keep an ambiguous image available for retained retry`, async t => {
    const schedule = globalThis.setTimeout; let busy = true;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
    const { root, calls } = setup(t, { copy, entrance, post: form => {
      if (!form.getAll('files').some(file => file.name === 'scan.pdf')) return null;
      return busy ? Response.json({ error: 'upload-rate-limit' }, { status: 429 })
        : Response.json({ events: [], refused: [{ index: 0, kind: 'image', reason: 'image normalizer not configured' }] }, { status: 202 });
    } });
    await choose(root, [...Array.from({ length: 8 }, (_, i) => new window.File(['%PDF-fixture'], `eligible-${i}.pdf`)),
      new window.File([new Uint8Array([255, 216, 255, 224])], 'scan.pdf', { type: 'application/pdf' })]);
    for (let n = 0; n < 100 && !root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(root.querySelector('.upload-retry'), 'an ambiguous retained file still needs server classification');
    busy = false; root.querySelector('.upload-retry').click(); await tick(); await tick();
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 5);
    assert.equal(root.querySelector('.composer-reason').textContent, copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'scan.pdf')));
  });

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const capacity of ['count', 'session'])
  test(`AIT-561 Low 1: ${copy.display.locale}/${entrance}/${capacity} a known extensionless image on a document-only host cannot hold PDFs`, async t => {
    const limits = { ...UPLOAD_LIMITS, ...(capacity === 'session' ? { maxSessionBytes: 50 } : {}) };
    const { c, root, calls } = setup(t, { copy, entrance, limits, post: form => {
      const events = [], refused = [];
      for (const [index, file] of form.getAll('files').entries()) {
        if (file.name === 'clipboard') refused.push({ index, kind: 'image', reason: 'image normalizer not configured' });
        else events.push({ sessionId: c.session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: pending(`doc-${file.name}`, { filename: file.name, bytes: file.size, state: 'accepted' }) });
      }
      return Response.json({ events, refused }, { status: 202 });
    } });
    const names = Array.from({ length: capacity === 'count' ? 8 : 1 }, (_, i) => `eligible-${i}.pdf`);
    await choose(root, [...names.map(name => new window.File(['%PDF-' + 'x'.repeat(25)], name)),
      new window.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'x'.repeat(32)], 'clipboard', { type: 'image/png' })]);
    assert.deepEqual(c.session.uploads.map(upload => upload.filename), names);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, capacity === 'count' ? 2 : 1);
    assert.equal(root.querySelector('.composer-reason').textContent, copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'clipboard')));
  });

for (const copy of [en, de]) for (const status of [403, 409]) for (const count of [1, 4])
  test(`AIT-561 r2 M1: ${copy.display.locale}/${status}/${count} final reason precedes the named unsent files with correct number`, async t => {
    const { root } = setup(t, { copy, limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 2 },
      post: () => Response.json(status === 409 ? { reason: 'purpose' } : { error: 'not-owner' }, { status }) });
    const names = Array.from({ length: count }, (_, i) => `document-${i}.pdf`);
    await choose(root, names.map(name => new window.File(['%PDF-fixture'], name)));
    const failure = status === 409 ? copy.purposePaused : count === 1 ? copy.uploads.failed
      : copy === en ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
    assert.equal(root.querySelector('.composer-reason').textContent,
      failure + ' · ' + copy.uploads.refused.replace('{list}', names.join(', ')));
  });

for (const copy of [en, de]) for (const earlier of ['type', 'retained'])
  test(`AIT-561 r2 M1: ${copy.display.locale}/${earlier} terminal reason leads the complete notice even with other file facts`, async t => {
    const schedule = globalThis.setTimeout; let busy = earlier === 'retained';
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
    const { root } = setup(t, { copy, limits: { ...UPLOAD_LIMITS, maxFilesPerRequest: 2 },
      post: () => busy ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : Response.json({ reason: 'purpose' }, { status: 409 }) });
    if (busy) {
      await choose(root, [new window.File(['%PDF-fixture'], 'retained.pdf')]);
      for (let n = 0; n < 100 && !root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(root.querySelector('.upload-retry')); busy = false;
    }
    await choose(root, [...(earlier === 'type' ? [new window.File(['x'], 'blocked.exe')] : []),
      ...['first.pdf', 'later.pdf', 'last.pdf'].map(name => new window.File(['%PDF-fixture'], name))]);
    const notice = root.querySelector('.composer-reason').textContent;
    assert.ok(notice.startsWith(copy.purposePaused + ' · '), notice);
    assert.ok(notice.includes(earlier === 'type' ? copy.uploads.type.replace('{name}', 'blocked.exe') : copy.uploads.replaced));
    for (const name of ['first.pdf', 'later.pdf', 'last.pdf']) assert.equal(notice.split(name).length - 1, 1);
  });

for (const defaults of [en, de]) test(`AIT-563 Low 5: ${defaults.display.locale} custom uploads.failed wins over default failedMany for several files`, async t => {
  const failure = 'Host upload failure.', copy = { ...defaults, uploads: { ...defaults.uploads, failed: failure } };
  const { root, calls } = setup(t, { copy, post: () => Response.json({ error: 'not-owner' }, { status: 403 }) });
  await choose(root, [file('first.pdf'), file('second.pdf')]);
  const notice = root.querySelector('.composer-reason').textContent;
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(notice.startsWith(failure));
  assert.equal(notice.includes(defaults.uploads.failedMany), false);
  for (const name of ['first.pdf', 'second.pdf']) assert.equal(notice.split(name).length - 1, 1);
});

// AIT-610 r5 (LEAD condition 1): the server refuses a file that is not
// positively a supported document before storing it (kind 'document', reason
// 'unsupported'). The client names it with the existing unsupported wording.
for (const copy of [en, de]) for (const images of [false, true])
  test(`AIT-610 r5: ${copy.display.locale}${images ? ' with image input' : ''} a document refused at intake is named with the file-type wording`, async t => {
    const { c, root, calls } = setup(t, { copy, images, post: () => Response.json({ accepted: true, events: [], uploads: [],
      refused: [{ index: 0, name: 'notes.txt', kind: 'document', reason: 'unsupported' }] }, { status: 202 }) });
    await choose(root, [new window.File(['caf\xe9'], 'notes.txt', { type: 'text/plain' })]);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    assert.deepEqual(c.session.uploads, []);
    const notice = root.querySelector('.composer-reason')?.textContent ?? '';
    assert.ok(notice.startsWith(copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'notes.txt'))), notice);
  });

// AIT-610 r6 (gate5c defect b): a browser that consumed the pending event and
// then reconnects after a server restart gets no new event (the derived
// 'unavailable' is never written). The reconnect refresh re-reads the session
// and shows TICK's copy for the lost image.
for (const copy of [en, de]) test(`AIT-610 r6: ${copy.display.locale} a reconnect after the pending event shows the derived 'unavailable' for a lost image`, async t => {
  const staged = { id: 'img-1', kind: 'image', state: 'staged-pending', filename: 'photo.png', mediaType: 'image/png', bytes: 2048, expiresAt: Date.now() + 600_000, at: at(10) };
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.uploads = [staged];
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, uploads: { available: true, reason: null }, imageInput: { available: true } } };
  let streams = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) {
      // The first stream ends (the server restarted); later ones stay open.
      if (++streams === 1) return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
      return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    }
    if (url.endsWith('/uploads') && !options.method) return Response.json({ uploads: c.session.uploads.map(u => u.id === staged.id ? { ...u, state: 'staged-refused', reason: 'unavailable' } : u), limits: UPLOAD_LIMITS });
    if (/\/api\/sessions\/[^/]+$/u.test(url)) return Response.json({ ...c.session, uploads: c.session.uploads.map(u => u.id === staged.id ? { ...u, state: 'staged-refused', reason: 'unavailable' } : u) });
    return Response.json({});
  });
  c.configure({ copy, copyForLocale: locale => ({ en, de })[locale], session, sessionToken: 'owner-fixture', entrance: 'choice' }); document.body.append(c); t.after(() => c.remove());
  const root = c.shadowRoot;
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(c.session.uploads[0].state, 'staged-pending', 'before the reconnect the browser still holds the pending row');
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(streams >= 2, 'reconnected');
  assert.equal(c.session.uploads[0].state, 'staged-refused', JSON.stringify(c.session.uploads[0]));
  assert.equal(c.session.uploads[0].reason, 'unavailable');
  const shown = [...root.querySelectorAll('.image-refusal')].map(node => node.textContent).join(' ');
  assert.ok(shown.includes(copy.imageRefusals.unavailable), shown);
});

// AIT-610 r6 (LEAD 03:0x): the server names a certain intake reason for an
// Office suffix (password-protected, an older/different Office format,
// damaged); the client shows it with the existing reason copy, and the
// generic file-type wording otherwise.
for (const copy of [en, de]) for (const [reason, expected] of [
  ['encrypted', () => copy.uploads.reasons.encrypted], ['malformed', () => copy.uploads.reasons.malformed],
  ['legacy', () => copy.uploads.reasons.legacy], ['unsupported', () => null],
]) test(`AIT-610 r6: ${copy.display.locale} a document refused at intake as '${reason}' is named with its reason`, async t => {
  const { c, root } = setup(t, { copy, post: () => Response.json({ accepted: true, events: [], uploads: [],
    refused: [{ index: 0, name: 'report.docx', kind: 'document', reason }] }, { status: 202 }) });
  await choose(root, [new window.File(['x'], 'report.docx')]);
  assert.deepEqual(c.session.uploads, []);
  const notice = root.querySelector('.composer-reason')?.textContent ?? '';
  const named = expected() ? copy.uploads.typeReason.replace('{name}', 'report.docx').replace('{reason}', expected()) : copy.uploads.type.replace('{name}', 'report.docx');
  assert.ok(typeof (expected() ?? '') === 'string' && (expected() === null || expected().length > 0), `copy for ${reason}`);
  assert.ok(notice.startsWith(copy.uploads.refused.replace('{list}', named)), notice);
});
