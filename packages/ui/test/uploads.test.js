import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { UPLOAD_LIMITS, planUploads, refusalText, formatBytes, uploadStateText } from '../src/uploads.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(r => setImmediate(r));
// Component tests build files and forms the way the page does: with the window's own classes.
globalThis.FormData = window.FormData;
const file = (name, size = 4) => new window.File(['x'.repeat(size)], name);
const at = second => new Date(Date.UTC(2026, 9, 10, 12, 0, second)).toISOString();
const pending = (id, extra = {}) => ({ id, state: 'pending', filename: `${id}.txt`, mediaType: 'text/plain', bytes: 2048, at: at(10), ...extra });

// A connected component on a fixture server: owner routes answer like the B1 handlers.
function setup(t, { copy = en, baseUrl = '', uploads = [], transcript = [], feature = { available: true, reason: null }, limits = UPLOAD_LIMITS, post, withdraw } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.transcript = transcript; session.uploads = uploads; session.inputRevision = transcript.length;
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, uploads: feature } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/uploads') && !options.method) return Response.json({ uploads: c.session.uploads, limits });
    if (url.endsWith('/uploads') && options.method === 'POST') {
      if (post) return post(options.body);
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
  c.configure({ copy, session, sessionToken: 'owner-fixture', baseUrl }); document.body.append(c); t.after(() => c.remove());
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
  assert.deepEqual(plan.refused, [{ name: 'tool.exe', reason: 'type' }, { name: 'huge.pdf', reason: 'size' }]);
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
  assert.deepEqual(packed.batches.map(batch => batch.length), [3, 1], 'four 20 MB files go in two requests under 64 MB');
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
  assert.equal(root.querySelector('.status').textContent, en.uploads.withdrawFailed);
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
  assert.equal(root.querySelector('.status').textContent, '2 files received. Reading them…');
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
});

test('server refusals say what happened: limits, a busy route and an unavailable feature', async t => {
  for (const [response, words] of [[Response.json({ error: 'size-limit' }, { status: 413 }), en.uploads.overLimit],
    [Response.json({ error: 'upload-rate-limit' }, { status: 429 }), en.uploads.busy],
    [Response.json({ error: 'uploads-unavailable', reason: 'extractor unhealthy' }, { status: 403 }), 'Files cannot be attached: Document extractor is not responding'],
    [new Response('nope', { status: 500 }), en.uploads.failed]]) {
    const { c, root } = setup(t, { post: () => response });
    await choose(root, [file('a.txt')]);
    assert.equal(root.querySelector('.composer-reason').textContent, words); assert.equal(root.querySelectorAll('.upload').length, 0);
    c.remove();
  }
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
  assert.equal(paused.root.querySelector('.attach').title, 'Files cannot be attached: Session paused');
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
  assert.equal(root.querySelector('.status').textContent, en.uploads.withdrawFailed);
  assert.equal(root.querySelector('.upload').dataset.state, 'pending');
});
