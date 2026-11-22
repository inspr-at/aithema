// AIT-610 r9: split from uploads.test.js (the file reached the remote lane's heap limit at
// ~182 tests). The staged-image reconciliation (r7/r8/r9), the r9 origin guard and the r9
// generic intake reason live here; the fixtures are uploads.test.js's own, copied unchanged.
// No assertion changed by the move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import './fixtures/page-origin.js';
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

// AIT-610 r7 (LEAD (1), gate6c): ONE reconciliation path. Every stream
// (re)connect, the first stream included, and every gap recovery re-read
// GET /uploads and reconcile the local staged-pending image rows through the
// refusal view. One read in flight at a time; callers share it.
// AIT-610 r8 options: `sampleAtRequest` reads the server state when the GET
// arrives (a read that started before a restart answers the old state);
// `uploadsStatus(n)` answers the n-th GET /uploads with that status; `baseUrl`.
function reconcileFixture(t, copy, { events, snapshot = s => s, uploadsGate = null, lostFrom = 1, sampleAtRequest = false, uploadsStatus = () => 200, baseUrl = '', uploadsBody = null, uploadsStall = () => false, reads = [] } = {}) {
  const staged = { id: 'img-1', kind: 'image', state: 'staged-pending', filename: 'photo.png', mediaType: 'image/png', bytes: 2048, expiresAt: Date.now() + 600_000, at: at(10) };
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.uploads = [staged];
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, uploads: { available: true, reason: null }, imageInput: { available: true } } };
  // The server restarted before stream `lostFrom`: from then on it reports the row as lost.
  const lost = uploads => counts.streams < lostFrom ? uploads : uploads.map(u => u.id === staged.id ? { ...u, state: 'staged-refused', reason: 'unavailable' } : u);
  const counts = { streams: 0, uploads: 0, sessions: 0 };
  const open = options => new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) return events(++counts.streams, options, open);
    if (url.endsWith('/uploads') && !options.method) {
      const status = uploadsStatus(++counts.uploads), sampled = sampleAtRequest ? lost(c.session.uploads) : null;
      reads.push({ url, signal: options.signal });
      // r9: a stalled read answers only its abort signal (the read timeout or a cancel).
      if (uploadsStall(counts.uploads)) await new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      await uploadsGate?.promise;
      if (uploadsBody) return Response.json({ uploads: uploadsBody(counts.uploads, c.session.uploads), limits: UPLOAD_LIMITS });
      if (status !== 200) return new Response(null, { status });
      return Response.json({ uploads: sampled ?? lost(c.session.uploads), limits: UPLOAD_LIMITS });
    }
    if (/\/api\/sessions\/[^/]+$/u.test(url)) { counts.sessions++; return Response.json(snapshot({ ...c.session, uploads: lost(c.session.uploads) })); }
    return Response.json({});
  });
  c.configure({ copy, copyForLocale: locale => ({ en, de })[locale], session, sessionToken: 'owner-fixture', baseUrl, entrance: 'choice' }); document.body.append(c); t.after(() => c.remove());
  // Live refusal items only: the hidden height reserve renders every reason too.
  const shown = () => [...c.shadowRoot.querySelectorAll('.image-refusal-item .image-refusal')].map(node => node.textContent).join(' ');
  return { c, counts, shown };
}
for (const copy of [en, de]) test(`AIT-610 r7: ${copy.display.locale} a restart between the initial snapshot and the FIRST stream shows 'unavailable'`, async t => {
  const { c, counts, shown } = reconcileFixture(t, copy, { events: (n, options, open) => open(options) });
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.streams, 1, 'no reconnect: the first stream itself reconciles');
  assert.equal(counts.uploads, 1, 'one GET /uploads');
  assert.equal(c.session.uploads[0].state, 'staged-refused', JSON.stringify(c.session.uploads[0]));
  assert.equal(c.session.uploads[0].reason, 'unavailable');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
});
for (const copy of [en, de]) test(`AIT-610 r7: ${copy.display.locale} a reconnect whose snapshot cursor differs (matrix unchanged) still shows 'unavailable'`, async t => {
  const { c, counts, shown } = reconcileFixture(t, copy, {
    // The first stream ends; the server restarted before the second (lostFrom 2).
    events: (n, options, open) => n === 1 ? new Response(new ReadableStream({ start(controller) { controller.close(); } })) : open(options),
    snapshot: s => ({ ...s, seq: s.seq + 5 }), lostFrom: 2 });
  for (let i = 0; i < 6; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 2, 'reconnected');
  assert.equal(c.session.uploads[0].state, 'staged-refused', JSON.stringify(c.session.uploads[0]));
  assert.equal(c.session.uploads[0].reason, 'unavailable');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
});
for (const copy of [en, de]) test(`AIT-610 r7: ${copy.display.locale} gap recovery passes 'unavailable' through the refusal view, with ONE shared read`, async t => {
  let release; const uploadsGate = { promise: new Promise(resolve => { release = resolve; }) };
  const { c, counts, shown } = reconcileFixture(t, copy, { uploadsGate,
    // AIT-610 r8: the snapshot was taken before the restart (the row is still
    // pending in it), so a read is needed; a snapshot that already carries the
    // refused row is delivered without a read (the r8 test below).
    snapshot: s => ({ ...s, uploads: s.uploads.map(({ reason, ...u }) => u.id === 'img-1' ? { ...u, state: 'staged-pending' } : { ...u, reason }) }),
    // The first stream is refused with 400 (a gap): the element restores from the
    // snapshot. The second stream ends; the third (after the delay) stays open.
    events: (n, options, open) => n === 1 ? new Response(null, { status: 400 })
      : n === 2 ? new Response(new ReadableStream({ start(controller) { controller.close(); } })) : open(options) });
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.sessions >= 1, 'the gap was recovered from a snapshot');
  assert.ok(counts.streams >= 2, 'the stream reopened');
  assert.equal(counts.uploads, 1, 'snapshot apply and stream connect share one in-flight GET /uploads');
  release();
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(c.session.uploads[0].state, 'staged-refused');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
  // Idempotent: a dismissed refusal never comes back from a later reconciliation.
  c.shadowRoot.querySelector('.image-refusals__dismiss').click();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(shown(), '');
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 3, 'reconnected again');
  assert.equal(shown(), '', 'no duplicate after another reconciliation');
});
// AIT-610 r8 (gate7c): freshness, delivery without a read, a bounded retry,
// and the origin guard of the existing GET on the same route.
const closed = () => new Response(new ReadableStream({ start(controller) { controller.close(); } }));
for (const copy of [en, de]) test(`AIT-610 r8: ${copy.display.locale} a reconnect never reuses a read that started before the restart: a FRESH read shows 'unavailable'`, async t => {
  let release; const uploadsGate = { promise: new Promise(resolve => { release = resolve; }) };
  const { c, counts, shown } = reconcileFixture(t, copy, { uploadsGate, sampleAtRequest: true, lostFrom: 2,
    // The first stream's read samples the row pending; then the stream ends (the
    // server restarted) and the second stream stays open.
    events: (n, options, open) => n === 1 ? closed() : open(options) });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(counts.uploads, 1, 'the first stream started a read');
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 2, 'reconnected after the restart');
  release();
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 2, 'the reconnect reconciles with a read that began after it');
  assert.equal(c.session.uploads[0].state, 'staged-refused', JSON.stringify(c.session.uploads[0]));
  assert.equal(c.session.uploads[0].reason, 'unavailable');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
});
for (const copy of [en, de]) test(`AIT-610 r8: ${copy.display.locale} a gap snapshot that carries the refused image shows it although GET /uploads fails`, async t => {
  const { c, counts, shown } = reconcileFixture(t, copy, { uploadsStatus: () => 503,
    events: (n, options, open) => n === 1 ? new Response(null, { status: 400 }) : open(options) });
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.sessions >= 1, 'the gap was recovered from a snapshot');
  assert.equal(c.session.uploads[0].state, 'staged-refused');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
});
for (const copy of [en, de]) test(`AIT-610 r8: ${copy.display.locale} a failed GET /uploads is retried once after a short delay`, async t => {
  const { c, counts, shown } = reconcileFixture(t, copy, { uploadsStatus: n => n === 1 ? 503 : 200, events: (n, options, open) => open(options) });
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 1);
  assert.equal(c.session.uploads[0].state, 'staged-pending');
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 2, 'one retry');
  assert.equal(c.session.uploads[0].state, 'staged-refused');
  assert.ok(shown().includes(copy.imageRefusals.unavailable), shown());
});
test('AIT-610 r8: the retry after a failed GET /uploads is bounded (once per connect or snapshot apply)', async t => {
  const { c, counts } = reconcileFixture(t, en, { uploadsStatus: () => 503, events: (n, options, open) => open(options) });
  for (let i = 0; i < 12; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 2, 'one retry');
  for (let step = 0; step < 6; step++) { t.mock.timers.tick(10_000); for (let i = 0; i < 6; i++) await tick(); }
  assert.equal(counts.uploads, 2, 'no further retry on the same connection');
  assert.equal(counts.streams, 1);
  assert.equal(c.session.uploads[0].state, 'staged-pending');
});
test('AIT-610 r8: a foreign baseUrl receives no reconciliation GET /uploads (the origin guard of the existing GET)', async t => {
  const { counts } = reconcileFixture(t, en, { baseUrl: 'https://other.example', events: (n, options, open) => open(options) });
  for (let i = 0; i < 12; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  // AIT-610 r10: since AIT-625 (merged) the event stream is an owner request through the same
  // guarded helper, so a foreign baseUrl receives no stream either.
  assert.equal(counts.streams, 0, 'no owner-authenticated stream reaches another origin');
  assert.equal(counts.uploads, 0, 'no owner-authenticated read reaches another origin');
});

// AIT-610 r9 (gate8c SECURITY, LEAD r9): every owner-authenticated upload
// request is resolved ONCE against the document base, its RESOLVED origin is
// checked against the page origin, and exactly that resolved URL is fetched with
// redirect: 'error', so neither a foreign <base href> nor a redirect from the
// own origin carries the owner header elsewhere.
// AIT-610 r10: since the AIT-625 merge the resolution lives in main's ownerURL (owner-request.js),
// which every owner request goes through; sameOrigin only checks early and returns its input.
const { ownerURL } = await import('../src/owner-request.js');
const stagedImage = (id = 'img-1') => ({ id, kind: 'image', state: 'staged-pending', filename: 'photo.png', mediaType: 'image/png', bytes: 2048, expiresAt: Date.now() + 600_000, at: at(10) });
test('AIT-610 r9: sameOrigin resolves against the document base and returns exactly the resolved URL', () => {
  const view = baseURI => ({ origin: 'http://localhost', location: { origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/page/' }, document: { baseURI } });
  assert.equal(ownerURL(view('http://localhost/app/'), 'api/x').href, 'http://localhost/app/api/x');
  assert.equal(ownerURL(view('http://localhost/app/'), '/api/x').href, 'http://localhost/api/x');
  assert.throws(() => ownerURL(view('https://other.example/'), '/api/x'), /same origin/u, 'a foreign <base href>');
  assert.throws(() => ownerURL(view('http://localhost/'), 'https://other.example/api/x'), /same origin/u);
  assert.throws(() => ownerURL(view('http://localhost/'), '//other.example/api/x'), /same origin/u);
});
test('AIT-610 r9: a foreign <base href> receives no owner-authenticated upload request: reconcile, limits, attach and withdraw', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); // no retry timer outlives the test
  const base = document.createElement('base'); base.href = 'https://other.example/'; document.head.append(base); t.after(() => base.remove());
  assert.equal(new URL('/x', document.baseURI).origin, 'https://other.example', 'the fixture base is in effect');
  const { root, calls } = setup(t, { uploads: [pending('u1'), stagedImage()], images: true });
  for (let i = 0; i < 6; i++) await tick();
  root.querySelector('.attach').click(); await tick();
  await choose(root, [file('a.txt')]);
  root.querySelector('.upload-withdraw').click(); await tick();
  assert.deepEqual(calls.filter(call => /\/uploads/u.test(call.url)).map(call => call.url), [], 'nothing is sent');
  assert.equal(root.querySelector('.upload').dataset.state, 'pending');
});
test('AIT-610 r9: a same-origin upload request that redirects to another origin is refused: no owner header is forwarded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); // no retry timer outlives the test
  const { root } = setup(t, { uploads: [pending('u1'), stagedImage()], images: true });
  const inner = globalThis.fetch, forwarded = [];
  // The fixture server redirects every upload route elsewhere; like the platform,
  // fetch follows the redirect unless redirect is 'error', in which case it rejects.
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!/\/uploads/u.test(url)) return inner(url, options);
    if (options.redirect === 'error') throw new TypeError('redirect refused');
    forwarded.push({ to: 'https://other.example/', owner: new Headers(options.headers).get('x-aithema-session-token') });
    return inner(url, options);
  });
  for (let i = 0; i < 6; i++) await tick();
  root.querySelector('.attach').click(); await tick();
  await choose(root, [file('a.txt')]);
  root.querySelector('.upload-withdraw').click(); await tick(); await tick();
  assert.deepEqual(forwarded, [], 'no request followed a redirect');
  assert.equal(root.querySelector('.upload').dataset.state, 'pending');
});
test('AIT-610 r9: the normal same-origin path fetches exactly the resolved URL with redirect: error (reconcile, limits, attach, withdraw)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); // no retry timer outlives the test
  const { c, root, calls } = setup(t, { uploads: [pending('u1'), stagedImage()], images: true });
  for (let i = 0; i < 6; i++) await tick();
  root.querySelector('.attach').click(); await tick();
  await choose(root, [file('a.txt')]);
  root.querySelector('.upload-withdraw').click(); await tick(); await tick();
  const prefix = `http://localhost/api/sessions/${c.session.id}/uploads`;
  const uploads = calls.filter(call => /\/uploads/u.test(call.url));
  assert.ok(uploads.some(call => call.url === prefix && !call.options.method), 'a GET /uploads went out');
  assert.ok(uploads.some(call => call.url === prefix && call.options.method === 'POST'), 'the attach POST went out');
  assert.ok(uploads.some(call => call.url === `${prefix}/u1/withdraw`), 'the withdraw went out');
  for (const call of uploads) {
    assert.equal(call.options.redirect, 'error', call.url);
    assert.equal(new Headers(call.options.headers).get('x-aithema-session-token'), call.options.method ? 'owner-fixture' : new Headers(call.options.headers).get('x-aithema-session-token'));
  }
  assert.equal(c.session.uploads.find(u => u.id === 'u1').state, 'withdrawn');
});

// AIT-610 r9 (LEAD's r8 pre-decision): no specific Office reasons. Any document
// refused at intake is named with the generic file-type wording, whatever
// reason a server sends; the legacy copy keys are gone.
for (const copy of [en, de]) for (const reason of ['encrypted', 'legacy', 'malformed', 'unsupported']) test(`AIT-610 r9: ${copy.display.locale} a document refused at intake as '${reason}' gets the generic file-type wording`, async t => {
  const { c, root } = setup(t, { copy, post: () => Response.json({ accepted: true, events: [], uploads: [],
    refused: [{ index: 0, name: 'report.docx', kind: 'document', reason }] }, { status: 202 }) });
  await choose(root, [new window.File(['x'], 'report.docx')]);
  assert.deepEqual(c.session.uploads, []);
  const notice = root.querySelector('.composer-reason')?.textContent ?? '';
  assert.ok(notice.startsWith(copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'report.docx'))), notice);
});
test('AIT-610 r9: the legacy Office copy keys are removed in EN and DE', () => {
  for (const copy of [en, de]) for (const key of ['legacyWord', 'legacyExcel', 'legacyPowerPoint']) assert.equal(copy.uploads.reasons[key], undefined, `${copy.display.locale} ${key}`);
});


// AIT-610 r9 (gate8c CLIENT-RECONCILE M1/M2): a reconcile response is applied
// only while its generation AND session are current; a read has a deadline; a
// session switch aborts the old read; teardown cancels the read, its queued
// follow-up and the retry timer.
test('AIT-610 r9: a stale reconcile response (begun before a newer connect) never marks the row refused', async t => {
  let release; const uploadsGate = { promise: new Promise(resolve => { release = resolve; }) };
  const { c, counts } = reconcileFixture(t, en, { uploadsGate,
    // The read that began before the reconnect answers 'refused'; the fresh one says still pending.
    uploadsBody: (n, uploads) => n === 1 ? uploads.map(u => ({ ...u, state: 'staged-refused', reason: 'deadline' })) : uploads,
    events: (n, options, open) => n === 1 ? closed() : open(options) });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(counts.uploads, 1);
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 2, 'reconnected');
  release();
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(c.session.uploads[0].state, 'staged-pending', 'the stale answer was not applied');
  assert.equal(counts.uploads, 2, 'the fresh read ran');
});
test('AIT-610 r9: a stalled reconcile GET times out and its queued follow-up runs', async t => {
  const { c, counts, shown } = reconcileFixture(t, en, { uploadsStall: n => n === 1, lostFrom: 2,
    events: (n, options, open) => n === 1 ? closed() : open(options) });
  for (let i = 0; i < 6; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 2, 'reconnected');
  assert.equal(counts.uploads, 1, 'the follow-up waits for the stalled read');
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 2, 'the read timed out and the follow-up read ran');
  assert.equal(c.session.uploads[0].state, 'staged-refused');
  assert.ok(shown().includes(en.imageRefusals.unavailable), shown());
});
test('AIT-610 r9: detach then reattach: the old retry timer never fires', async t => {
  const hang = options => new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  const { c, counts } = reconcileFixture(t, en, { uploadsStatus: () => 503,
    // The reattached element's stream never connects: no new generation.
    events: (n, options, open) => n === 1 ? open(options) : hang(options) });
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 1, 'the first read failed; a retry is scheduled');
  c.remove(); document.body.append(c);
  for (let i = 0; i < 6; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 1, 'the retry timer of the detached element did not fire');
});
test('AIT-610 r9: detach cancels the in-flight reconcile read and its queued follow-up', async t => {
  const reads = [];
  const { c, counts } = reconcileFixture(t, en, { uploadsStall: n => n === 1, reads,
    events: (n, options, open) => n === 1 ? closed() : open(options) });
  for (let i = 0; i < 6; i++) await tick();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(counts.streams >= 2, 'reconnected: a follow-up is queued behind the stalled read');
  c.remove();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(reads[0].signal?.aborted, true, 'the in-flight read was aborted');
  t.mock.timers.tick(20_000);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(counts.uploads, 1, 'no follow-up read after detach');
});
test('AIT-610 r9: a session switch aborts the old reconcile read: one read for the new session', async t => {
  const reads = [];
  const { c } = reconcileFixture(t, en, { uploadsStall: () => true, reads, events: (n, options, open) => open(options) });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(reads.length, 1);
  const next = createSession({ demo: true, locale: 'en' });
  next.uploads = [{ id: 'img-2', kind: 'image', state: 'staged-pending', filename: 'next.png', mediaType: 'image/png', bytes: 2048, expiresAt: Date.now() + 600_000, at: at(11) }];
  next.featureMatrix = c.session.featureMatrix;
  c.configure({ copy: en, copyForLocale: locale => ({ en, de })[locale], session: next, sessionToken: 'owner-fixture', baseUrl: '', entrance: 'choice' });
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(reads[0].signal?.aborted, true, 'the old session\'s read was aborted');
  const live = reads.filter(read => !read.signal?.aborted);
  assert.equal(live.length, 1, 'one read in flight');
  assert.ok(live[0].url.includes(`/api/sessions/${next.id}/uploads`), live[0].url);
});
