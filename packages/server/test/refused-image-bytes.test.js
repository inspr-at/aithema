// AIT-610 (Desk 203dfe1c, option a): the browser admission check is best effort.
// Image bytes may reach the server under a stale client verdict; the server is
// authoritative and refused bytes are never stored, logged or forwarded.
//
// Inventory of server paths where image bytes can arrive (see also
// docs/plugins.md, "Image input: the server is authoritative"):
//   P1 POST /api/sessions/:id/uploads (upload, paste and drop share this route;
//      a client retry is the same request again, replayed by clientEventId).
//      Admission refusals (per file, receipt `refused[]`, HTTP 202/200):
//      consent, configuration, verification, normalizer health, image quota,
//      a consent revision during admission.
//      Whole-request refusals (nothing admitted): purpose pause 409,
//      file/request size 413, part count 413, malformed multipart 400,
//      documents unavailable 403.
//   P2 the staged normalization job (upload-handlers start()): refusals after
//      admission. Consent/configuration changed before the job runs (the
//      normalizer is not called), or the local normalizer refuses the bytes
//      (type, size, dimensions, malformed). The normalizer is the server's own
//      verifier (local, free, credential-free child); nothing else sees them.
//      LEAD option A: the original waits in memory only (bounded; above the
//      bound a request is refused before its body is read). No row, WAL frame,
//      backup snapshot or file ever holds it; only an accepted image's
//      normalized output is stored. A restart leaves staged-refused 'unavailable'.
//   P3 POST /api/sessions/:id/turns with `attachments`: carries upload ids
//      only, never bytes; a refused or still pending id is refused before any
//      model work.
//   Not byte paths for images: concept routes (JSON requests; they only serve
//   generated images), voice start (POST /api/sessions/:id/voice, JSON),
//   host/plugin routes (JSON). A JSON route that receives bytes treats them as
//   text and refuses invalid JSON with 400 before any storage.
//   Out of scope, own rules: the composed-voice relay's binary audio ingress
//   (audio transport, not image input); images embedded in PDF/Office
//   documents (document input for the local text extractor; never image input
//   to a model lane, asserted for an embedded DOCX image below).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFacadeSecrets, createHandlers, createPluginRuntime, SQLiteStorage, SERVER_UPLOAD_LIMITS, mockPresets } from '../src/index.js';
import { listen } from '../src/http.js';
import { createMockReasoning, imageReferences, PluginRegistry, reasoningRequest } from '@inspr/aithema-core';
import { registerDemoExtractors } from '../../../demo/uploads.js';
import { mockConsent, testToken, ownedRequest, temporaryDb } from '../../../test/helpers.js';
import * as uploadModule from '../src/upload-handlers.js';
import { bytes as textBytes, docxWithInlineImage, pdf } from '../../../test/extractor-fixtures.js';

// Captured before any fixture hooks the fs write APIs (a control writes a
// synthetic rollback journal without passing through the hook).
const rawWriteFile = writeFile;
const chunkText = chunk => typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array || ArrayBuffer.isView(chunk)
  ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1') : '';
// Records every byte written through Node's fs write APIs while a fixture is
// alive, so a file written and deleted between two temp-dir samples is still
// seen. SQLite writes natively and is covered by the database file scans.
function hookFsWrites(t, writes) {
  const mocks = [];
  const record = (api, data) => { writes.push(`${api}:${chunkText(data)}`); };
  const wrapStream = stream => {
    for (const method of ['write', 'end']) {
      const original = stream[method];
      stream[method] = function (chunk, ...rest) { if (chunk && typeof chunk !== 'function') record(`stream.${method}`, chunk); return original.call(this, chunk, ...rest); };
    }
    return stream;
  };
  const wrapHandle = handle => {
    for (const method of ['write', 'writeFile', 'appendFile']) {
      const original = handle[method];
      handle[method] = function (data, ...rest) { record(`handle.${method}`, data); return original.call(this, data, ...rest); };
    }
    return handle;
  };
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
    const original = fs[name];
    mocks.push(t.mock.method(fs, name, function (path, data, ...rest) { record(`fs.${name}`, data); return original.call(this, path, data, ...rest); }));
  }
  for (const name of ['write', 'writeSync']) {
    const original = fs[name];
    mocks.push(t.mock.method(fs, name, function (fd, data, ...rest) { record(`fs.${name}`, data); return original.call(this, fd, data, ...rest); }));
  }
  const createWriteStream = fs.createWriteStream;
  mocks.push(t.mock.method(fs, 'createWriteStream', function (...args) { return wrapStream(createWriteStream.apply(this, args)); }));
  for (const name of ['writeFile', 'appendFile']) {
    const original = fsp[name];
    mocks.push(t.mock.method(fsp, name, function (path, data, ...rest) { record(`fsp.${name}`, data); return original.call(this, path, data, ...rest); }));
  }
  const open = fsp.open;
  mocks.push(t.mock.method(fsp, 'open', async function (...args) { return wrapHandle(await open.apply(this, args)); }));
  syncBuiltinESMExports();
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
}

// A failing assertion must fail its test, never hang the file.
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
// A gated normalizer still ends when the job is aborted (handler close after a failure).
const gated = (gate, options) => Promise.race([gate, new Promise((resolve, reject) => {
  if (options?.signal?.aborted) reject(options.signal.reason);
  options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
})]);
let serial = 0;
// A PNG signature makes the server classify the bytes as an image regardless of
// the filename. The sentinel lets every scan find even a partial copy.
function sentinelImage() {
  const marker = `AIT610-REFUSED-SENTINEL-${process.pid}-${++serial}`;
  return { marker, bytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`${marker}|${marker}|${marker}`)]) };
}
const encodings = image => [image.marker, image.bytes.toString('base64'), image.bytes.toString('base64url'), Buffer.from(image.marker).toString('base64'),
  Buffer.from(image.marker).toString('hex'), image.bytes.toString('hex')];
// Error message, stack and cause are not enumerable: JSON alone would drop them.
const serialize = value => JSON.stringify(value, (key, v) => v instanceof Uint8Array || v?.type === 'Buffer' && Array.isArray(v.data)
  ? Buffer.from(v instanceof Uint8Array ? v : v.data).toString('base64') : typeof v === 'bigint' ? String(v)
    : v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause } : v) ?? String(value);
function leaksIn(text, image) { return encodings(image).filter(encoding => text.includes(encoding)); }

// Every file below the temp dir, nested ones included (a lane run has its own
// temp dir). Bounded so a crowded temp dir cannot stall the proof.
async function tmpEntries(root = tmpdir(), out = new Map(), depth = 0) {
  if (depth > 8 || out.size > 20_000) return out;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await tmpEntries(path, out, depth + 1);
    else if (entry.isFile()) out.set(path, (await stat(path).catch(() => null))?.mtimeMs);
  }
  return out;
}
async function changedTemp(before) {
  const out = [];
  for (const [path, mtime] of await tmpEntries()) {
    if (before.get(path) === mtime) continue;
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > 64 * 1024 * 1024) continue;
    const file = await readFile(path).catch(() => null);
    if (file) out.push({ path, text: file.toString('latin1') });
  }
  return out;
}

async function fixture(t, { voice } = {}) {
  const path = await temporaryDb(), storage = new SQLiteStorage(path);
  const logs = [], writes = [], admitted = [], normalized = [], during = [], fsWrites = [], live = [];
  // Documents use the demo extractors so a mixed request runs the model lanes.
  const reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning), presets = mockPresets();
  registerDemoExtractors(registry, presets);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent: mockConsent });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent: mockConsent, log: entry => { logs.push(entry); }, ...(voice ? { voice } : {}) });
  const session = storage.create({ ownerToken: testToken, demo: true });
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, method, (...args) => { logs.push(args); });
  // Direct stream writes bypass console. Record them and pass them on (the test
  // runner reports through the same streams).
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    t.mock.method(stream, 'write', function (chunk, ...rest) { writes.push(Buffer.from(chunk).toString('latin1')); return write.call(this, chunk, ...rest); });
  }
  // Every model lane passes through runtime.admit with its full request.
  const admit = runtime.admit.bind(runtime);
  t.mock.method(runtime, 'admit', args => { admitted.push(serialize(args.request)); return admit(args); });
  // A fake local normalizer: records every byte it receives and refuses or accepts.
  // While it runs, the job is at its widest: capture a backup snapshot of the
  // database and every temp file (transient ones vanish before the job ends).
  const normalizer = { verdict: { status: 'staged-refused', reason: 'unsupported' },
    async normalize(bytes, metadata, options) {
      normalized.push(Buffer.from(bytes)); await f.duringJob();
      return typeof this.verdict === 'function' ? this.verdict(bytes, metadata, options) : this.verdict;
    } };
  const availability = { reason: undefined };
  const real = runtime.imageInputAvailability.bind(runtime);
  t.mock.method(runtime, 'imageInputAvailability', async (current, options) => availability.real ? real(current, options)
    : typeof availability.reason === 'function' ? availability.reason(current) : availability.reason ? { reason: availability.reason } : { plugin: normalizer, maxImages: 4 });
  const before = await tmpEntries();
  hookFsWrites(t, fsWrites);
  // Live events: the session's event stream, as a connected client receives it.
  const stream = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/events`));
  const reader = stream.body.getReader();
  (async () => { while (true) { const { done, value } = await reader.read(); if (done) break; live.push(Buffer.from(value).toString('latin1')); } })().catch(() => {});
  t.after(async () => { await reader.cancel().catch(() => {}); await handlers.close(); storage.close(); });
  let snapshots = 0;
  const f = { path, storage, runtime, handlers, session, logs, writes, admitted, normalized, normalizer, availability, during, fsWrites, live,
    // A backup through SQLite itself (VACUUM INTO, a second connection) plus the
    // temp dir, taken during the job.
    async duringJob() {
      const snapshot = join(dirname(path), `snapshot-${++snapshots}.sqlite`), db = new DatabaseSync(path);
      try { db.exec(`VACUUM INTO '${snapshot}'`); } finally { db.close(); }
      during.push({ label: 'backup snapshot', text: (await readFile(snapshot)).toString('latin1') });
      for (const file of await changedTemp(before)) during.push({ label: `transient temp file ${file.path}`, text: file.text });
    },
    // A concurrent reader holding its snapshot keeps WAL frames from being checkpointed away.
    holdReader() {
      const reader = new DatabaseSync(path);
      reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) AS n FROM uploads').get();
      t.after(() => { reader.exec('COMMIT'); reader.close(); });
      return reader;
    },
    upload(clientEventId, files, headers = {}) {
      const form = new FormData(); form.append('clientEventId', clientEventId);
      for (const [name, content, type = 'image/png'] of files) form.append('files', new File([content], name, { type }));
      return handlers.handle(new Request(`http://localhost/api/sessions/${session.id}/uploads`, { method: 'POST', body: form,
        headers: { 'x-aithema-session-token': testToken, ...headers } }));
    },
    // Proves: not stored (rows, journal, receipts, database file and WAL, temp
    // dir, fs writes), not logged (console, host log), not forwarded (model
    // lanes, stored and live events).
    async assertNoTrace(image, { responses = [] } = {}) {
      await handlers.idle();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(leaksIn(live.join(''), image), [], 'live events');
      for (const capture of during) assert.deepEqual(leaksIn(capture.text, image), [], capture.label);
      const db = storage.db;
      for (const row of db.prepare('SELECT id, bytes FROM uploads').all()) {
        if (row.bytes) assert.equal(leaksIn(Buffer.from(row.bytes).toString('latin1'), image).length, 0, 'no uploads row holds the refused bytes');
      }
      for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)) {
        assert.deepEqual(leaksIn(serialize(db.prepare(`SELECT * FROM "${table}"`).all()), image), [], `table ${table}`);
      }
      // The on-disk database and its WAL (secure_delete + checkpoint) hold no copy.
      for (const suffix of ['', '-wal', '-journal']) {
        const file = await readFile(`${path}${suffix}`).catch(() => null);
        if (file) assert.deepEqual(leaksIn(file.toString('latin1'), image), [], `database file${suffix}`);
      }
      assert.deepEqual(leaksIn(serialize(logs), image), [], 'console and host log');
      assert.deepEqual(leaksIn(writes.join(''), image), [], 'stdout/stderr');
      for (const file of await changedTemp(before)) assert.deepEqual(leaksIn(file.text, image), [], `temp file ${file.path}`);
      assert.deepEqual(leaksIn(fsWrites.join('\n'), image), [], 'fs write');
      assert.deepEqual(leaksIn(admitted.join('\n'), image), [], 'model lanes');
      assert.deepEqual(leaksIn(serialize(storage.read(session.id)), image), [], 'published events');
      const current = storage.get(session.id);
      for (const lane of ['reaction', 'understanding']) assert.deepEqual(leaksIn(serialize(reasoningRequest(current, lane)), image), [], `${lane} request`);
      for (const body of responses) assert.deepEqual(leaksIn(body, image), [], 'response body');
    },
  };
  return f;
}

// P1 admission refusals: the per-file receipt names the reason; nothing reaches
// storage, the normalizer, a model or a log. Retries replay the same receipt.
for (const reason of ['current processing consent required', 'consent expired', 'verification required', 'image normalizer not configured',
  'image normalizer unavailable', 'image input not supported', 'binding evidence unverified', 'limit']) {
  test(`AIT-610 P1: an admission refusal (${reason}) never stores, logs or forwards the image bytes`, async t => {
    const f = await fixture(t), image = sentinelImage();
    if (reason === 'limit') for (let i = 0; i < 8; i++) f.storage.postUploads(f.session.id, `existing-${i}`, `existing-${i}`,
      [{ kind: 'image', filename: `existing-${i}.png`, mediaType: 'image/png', bytes: Buffer.from(`existing ${i}`), deadlineAt: Date.now() + 25000 }], {});
    else f.availability.reason = reason;
    const files = [['refused.png', image.bytes], ['notes.txt', textBytes('Document words'), 'text/plain']];
    const responses = [];
    for (const status of [202, 200]) {
      const response = await f.upload('refusal', files), body = await response.text();
      assert.equal(response.status, status, body); responses.push(body);
      const result = JSON.parse(body);
      assert.deepEqual(result.refused, [{ index: 0, name: 'refused.png', kind: 'image', reason }], 'the receipt states the refusal reason');
      assert.deepEqual(result.uploads.map(upload => upload.filename), ['notes.txt']);
    }
    assert.equal(f.normalized.length, 0, 'the normalizer is never called');
    assert.equal(f.storage.get(f.session.id).uploads.some(upload => upload.filename === 'refused.png'), false);
    await f.assertNoTrace(image, { responses });
  });
}

test('AIT-610 P1: a consent revision during admission refuses with a reason and leaves no trace', async t => {
  const f = await fixture(t), image = sentinelImage();
  f.availability.reason = () => { f.storage.reviseConsent(f.session.id, true, {}, { conversationUnchanged: true, changed: ['images'] }); return { plugin: f.normalizer }; };
  const response = await f.upload('race', [['race.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  assert.deepEqual(JSON.parse(body).refused, [{ index: 0, name: 'race.png', kind: 'image', reason: 'current processing consent required' }]);
  assert.equal(f.normalized.length, 0);
  await f.assertNoTrace(image, { responses: [body] });
});

test('AIT-610 P1: the real runtime verdict (a binding without image input) refuses with a reason and leaves no trace', async t => {
  const f = await fixture(t), image = sentinelImage();
  f.availability.real = true;
  const response = await f.upload('unconfigured', [['photo.png', image.bytes, 'application/octet-stream']]), body = await response.text();
  assert.equal(response.status, 202, body);
  assert.deepEqual(JSON.parse(body).refused, [{ index: 0, name: 'photo.png', kind: 'image', reason: 'image input not supported' }]);
  await f.assertNoTrace(image, { responses: [body] });
});

// P1 whole-request refusals: no file of the request is admitted.
for (const [label, prepare, files, status, error] of [
  ['purpose pause', f => f.storage.append(f.session.id, 'session.paused', { paused: true, reason: 'purpose' }), image => [['paused.png', image.bytes]], 409, 'conversation-paused'],
  // Over the per-file limit, under the whole-request ceiling: the body is read and the per-file check refuses.
  ['file size limit', null, image => [['huge.png', Buffer.concat([image.bytes, Buffer.alloc(SERVER_UPLOAD_LIMITS.maxBytes, 7)])]], 413, 'size-limit'],
  ['file count limit', null, image => Array.from({ length: 10 }, (_, i) => [`many-${i}.png`, image.bytes]), 413, 'size-limit'],
  ['documents unavailable', f => { f.runtime.uploadAvailability = async () => ({ reason: 'consent expired' }); }, image => [['mixed.png', image.bytes], ['mixed.pdf', pdf(), 'application/pdf']], 403, 'uploads-unavailable'],
]) test(`AIT-610 P1: a whole-request refusal (${label}) never stores, logs or forwards the image bytes`, async t => {
  const f = await fixture(t), image = sentinelImage();
  prepare?.(f);
  if (label === 'file size limit') {
    const size = files(image)[0][1].length;
    assert.ok(size > SERVER_UPLOAD_LIMITS.maxBytes && size + 1024 < SERVER_UPLOAD_LIMITS.maxRequestBytes, 'the fixture reaches the per-file check');
  }
  const response = await f.upload(`whole-${status}`, files(image)), body = await response.text();
  assert.equal(response.status, status, body);
  assert.equal(JSON.parse(body).error, error, 'the response states the refusal');
  assert.equal(f.normalized.length, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, 0);
  assert.equal(f.storage.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE client_id LIKE 'upload:%'").get().n, 0);
  await f.assertNoTrace(image, { responses: [body] });
});

test('AIT-610 P1: a malformed multipart body carrying image bytes is refused without a trace', async t => {
  const f = await fixture(t), image = sentinelImage(), boundary = 'ait610boundary';
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientEventId"\r\n\r\nmalformed\r\n--${boundary}\r\n` +
    'Content-Disposition: form-data; name="smuggled"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n'), image.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response = await f.handlers.handle(new Request(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST', body: raw,
    headers: { 'x-aithema-session-token': testToken, 'content-type': `multipart/form-data; boundary=${boundary}` } }));
  const body = await response.text();
  assert.equal(response.status, 400, body);
  assert.equal(f.normalized.length, 0);
  await f.assertNoTrace(image, { responses: [body] });
});

// P2: refusals after admission. The original bytes were staged for the
// server's own verifier; a refusal erases them and nothing else sees them.
for (const [label, verdict] of [
  ['unsupported type', { status: 'staged-refused', reason: 'unsupported' }],
  ['dimensions', { status: 'staged-refused', reason: 'dimensions' }],
  ['malformed', { status: 'staged-refused', reason: 'malformed' }],
  ['normalizer size limit', { status: 'staged-refused', reason: 'limit' }],
  ['normalizer failure echoing the bytes', bytes => { throw new Error(`decoder failed on ${Buffer.from(bytes).toString('latin1')} ${Buffer.from(bytes).toString('base64')}`); }],
]) test(`AIT-610 P2: a normalizer refusal (${label}) erases the staged bytes and logs or forwards nothing`, async t => {
  const f = await fixture(t), image = sentinelImage();
  f.normalizer.verdict = verdict;
  f.holdReader();
  const response = await f.upload('normalize', [['staged.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  assert.equal(f.normalized.length, 1, 'only the local verifier received the bytes');
  assert.ok(f.during.some(capture => capture.label === 'backup snapshot'), 'a backup snapshot was taken during the job');
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'staged-refused');
  assert.equal(upload.reason, typeof verdict === 'function' ? 'unavailable' : verdict.reason, 'the refusal states its reason');
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
  const turn = await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/turns`, { method: 'POST',
    body: JSON.stringify({ clientEventId: 'attach-refused', content: 'Look', attachments: [upload.id] }) }));
  assert.equal(turn.status, 409, 'P3: a refused image cannot be attached to a turn');
  await f.assertNoTrace(image, { responses: [body, await turn.text()] });
});

for (const [label, change] of [
  ['availability lost', () => ({ reason: 'consent expired' })],
  ['consent revised', f => { f.storage.reviseConsent(f.session.id, true, {}, { conversationUnchanged: true, changed: ['images'] }); return { plugin: f.normalizer }; }],
]) test(`AIT-610 P2: a refusal before normalization (${label}) never calls the normalizer and erases the staged bytes`, async t => {
  const f = await fixture(t), image = sentinelImage();
  let calls = 0;
  // The first availability call is the request's admission; the second is the
  // staged job's re-check, which sees the change.
  f.availability.reason = () => ++calls === 1 ? { plugin: f.normalizer } : calls === 2 ? change(f) : { plugin: f.normalizer };
  const response = await f.upload('late-refusal', [['late.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  assert.ok(calls >= 2, 'the staged job re-checked admission');
  const upload = f.storage.get(f.session.id).uploads.find(item => item.filename === 'late.png');
  assert.equal(upload.state, 'staged-refused', 'the late refusal is a visible state');
  assert.equal(upload.reason, 'unavailable', 'the late refusal states its reason');
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
  assert.equal(f.normalized.length, 0, 'the normalizer is never called after a refusal');
  await f.assertNoTrace(image, { responses: [body] });
});

// The same refusals through the real HTTP adapter: its error path logs nothing
// and an early refusal discards the body without retaining it.
test('AIT-610 P1 over HTTP: admission and size refusals leave no trace through the node adapter', async t => {
  const f = await fixture(t), image = sentinelImage(), huge = sentinelImage();
  f.availability.reason = 'consent expired';
  const { server, url } = await listen(request => f.handlers.handle(request));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = (clientEventId, name, content) => {
    const form = new FormData(); form.append('clientEventId', clientEventId); form.append('files', new File([content], name, { type: 'image/png' }));
    return fetch(`${url}/api/sessions/${f.session.id}/uploads`, { method: 'POST', body: form, headers: { 'x-aithema-session-token': testToken } });
  };
  const refused = await send('http-refusal', 'wire.png', image.bytes), body = await refused.text();
  assert.equal(refused.status, 202, body);
  assert.deepEqual(JSON.parse(body).refused, [{ index: 0, name: 'wire.png', kind: 'image', reason: 'consent expired' }]);
  const oversized = await send('http-oversized', 'huge.png', Buffer.concat([huge.bytes, Buffer.alloc(21 * 1024 * 1024, 7)])), oversizedBody = await oversized.text();
  assert.equal(oversized.status, 413, oversizedBody);
  assert.equal(f.normalized.length, 0);
  await f.assertNoTrace(image, { responses: [body, oversizedBody] });
  await f.assertNoTrace(huge, { responses: [oversizedBody] });
});

// JSON routes never accept image bytes: a body that is not JSON is refused
// with 400 before any storage, and the error path logs nothing.
// `voice` is the voice start route (POST /api/sessions/:id/voice).
for (const route of ['turns', 'concepts', 'focus-question', 'locale', 'voice']) {
  test(`AIT-610 non-byte route ${route}: image bytes posted as a body are refused without a trace`, async t => {
    // Voice is enabled for its route, so a 404 (route absent) can never pass as a refusal.
    const f = await fixture(t, route === 'voice' ? { voice: { secrets: createFacadeSecrets() } } : {}), image = sentinelImage();
    const response = await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: image.bytes }));
    const body = await response.text();
    assert.ok(response.status >= 400 && response.status < 500 && response.status !== 404, `${response.status} ${body}`);
    assert.equal(f.normalized.length, 0);
    await f.assertNoTrace(image, { responses: [body] });
  });
}

// Positive control: the same scans do find bytes that were stored or logged,
// so a green proof above cannot come from a blind scanner.
// Each channel has its own control.
test('AIT-610 control: the trace scans detect stored, logged and forwarded sentinel bytes', async t => {
  // A fresh sentinel per channel: a control that writes to stdout must not
  // trip the next control through the runner's log file.
  let image = sentinelImage();
  // A document row stores its bytes by design; it stands in for a stored image.
  const stored = await fixture(t);
  stored.storage.postUploads(stored.session.id, 'control', 'control', [{ filename: 'control.txt', mediaType: 'text/plain', bytes: image.bytes, deadlineAt: Date.now() + 25000 }], {});
  await assert.rejects(stored.assertNoTrace(image), /uploads row|table uploads|database file/u);
  const nested = join(tmpdir(), `ait610-control-${process.pid}`);
  t.after(() => rm(nested, { recursive: true, force: true }));
  for (const [label, leak] of [
    ['console', f => console.error('upload body', image.bytes.toString('base64'))],
    ['host log', f => f.logs.push({ error: new Error(`decoder failed on ${image.marker}`) })],
    ['host log', f => { const error = new Error('decoder failed'); error.stack = `Error: decoder failed\n    at ${image.marker}`; f.logs.push(error); }],
    // Error.cause only: message and stack carry nothing.
    ['host log', f => { const cause = new Error('inner'); cause.stack = 'inner'; cause.message = `decoder failed on ${image.marker}`;
      const error = new Error('decoder failed', { cause }); error.stack = 'Error: decoder failed'; f.logs.push(error); }],
    ['stdout/stderr', f => { process.stderr.write(`AIT-610 control ${image.marker}\n`); }],
    ['stdout/stderr', f => { process.stdout.write(`# AIT-610 control ${image.bytes.toString('base64')}\n`); }],
    ['temp file', async f => { await mkdir(join(nested, 'deep', 'er'), { recursive: true }); await writeFile(join(nested, 'deep', 'er', 'part.bin'), image.bytes); }],
    ['transient temp file', async f => { const file = join(tmpdir(), `ait610-transient-${process.pid}.bin`); await writeFile(file, image.bytes); await f.duringJob(); await rm(file); }],
    ['backup snapshot', async f => {
      f.storage.postUploads(f.session.id, 'snap', 'snap', [{ filename: 'snap.txt', mediaType: 'text/plain', bytes: image.bytes, deadlineAt: Date.now() + 25000 }], {});
      await f.duringJob(); f.storage.withdrawUpload(f.session.id, f.storage.get(f.session.id).uploads[0].id);
    }],
    ['model lanes', f => f.admitted.push(image.marker)],
    // A committed write that a concurrent reader keeps in the WAL, deleted from
    // the table again: only the -wal file still holds it.
    ['database file-wal', f => {
      f.holdReader();
      f.storage.db.exec('CREATE TABLE IF NOT EXISTS wal_control (x BLOB)');
      f.storage.db.prepare('INSERT INTO wal_control VALUES (?)').run(image.bytes);
      f.storage.db.exec('DELETE FROM wal_control');
    }],
    // A synthetic rollback journal next to the database (WAL mode never writes
    // one; the scan reads it if a legacy/rollback-mode database leaves one).
    ['database file-journal', async f => { await rawWriteFile(`${f.path}-journal`, image.bytes); }],
    // Live events: a document whose name carries the marker reaches the live
    // stream (and, later in the scan order, the stored events).
    ['live events', async f => { const response = await f.upload('live-control', [[`${image.marker}.txt`, textBytes('Plain words'), 'text/plain']]); await response.text(); }],
    // A file written and deleted before any temp-dir sample: only the fs hook sees it.
    ['fs write', async f => { const file = join(tmpdir(), `ait610-gone-${process.pid}.bin`); await writeFile(file, image.bytes); await rm(file); }],
  ]) {
    image = sentinelImage();
    const f = await fixture(t);
    await leak(f);
    await assert.rejects(f.assertNoTrace(image), new RegExp(label, 'u'));
    await rm(nested, { recursive: true, force: true });
  }
});

// LEAD option A (Desk 203dfe1c): original image bytes are never written to a
// persistent store, not even while the local normalizer has not decided yet.
test('AIT-610 option A: a staged image is held in memory only; no row, WAL frame or backup holds the original while it waits', async t => {
  const f = await fixture(t), image = sentinelImage();
  f.holdReader();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { entered = resolve; });
  f.normalizer.verdict = async (bytes, metadata, options) => { entered(); await gated(gate, options); return { status: 'staged-refused', reason: 'dimensions' }; };
  const response = await f.upload('in-memory', [['waiting.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await running;
  // While the normalizer runs, nothing persistent holds the original.
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'staged-pending');
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null, 'the pending row has no bytes');
  for (const suffix of ['', '-wal', '-journal']) {
    const file = await readFile(`${f.path}${suffix}`).catch(() => null);
    if (file) assert.deepEqual(leaksIn(file.toString('latin1'), image), [], `pending: database file${suffix}`);
  }
  for (const capture of f.during) assert.deepEqual(leaksIn(capture.text, image), [], `pending: ${capture.label}`);
  // P3 with an id that is not erased yet: still refused, before any model work.
  const turn = await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/turns`, { method: 'POST',
    body: JSON.stringify({ clientEventId: 'attach-pending', content: 'Look', attachments: [upload.id] }) }));
  const turnBody = await turn.text();
  assert.equal(turn.status, 409, turnBody);
  release();
  await f.handlers.idle();
  const settled = f.storage.get(f.session.id).uploads[0];
  assert.equal(settled.state, 'staged-refused');
  assert.equal(settled.reason, 'dimensions');
  await f.assertNoTrace(image, { responses: [body, turnBody] });
});

test('AIT-610 option A: an accepted image persists only its normalized output', async t => {
  const f = await fixture(t), image = sentinelImage(), normalized = Buffer.from('normalized pixels without the original');
  f.normalizer.verdict = { status: 'staged-ready', bytes: normalized, mediaType: 'image/png', w: 2, h: 1 };
  const response = await f.upload('accepted', [['fine.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'staged-ready');
  assert.deepEqual(Buffer.from(f.storage.uploadBytes(f.session.id, upload.id)), normalized);
  await f.assertNoTrace(image, { responses: [body] });
});

test('AIT-610 option A: a normalization lost to a restart surfaces as unavailable; the original was never stored', async t => {
  const f = await fixture(t), image = sentinelImage();
  // The process committed the staged row and stopped before its normalizer ran:
  // this handler instance holds no original for it, as after a restart.
  const staged = f.storage.postUploads(f.session.id, 'before-restart', 'before-restart', [{ kind: 'image', filename: 'lost.png', mediaType: 'image/png',
    bytes: image.bytes, deadlineAt: Date.now() + 25000 }], SERVER_UPLOAD_LIMITS).events[0].data;
  assert.equal(staged.state, 'staged-pending');
  assert.equal(f.storage.uploadBytes(f.session.id, staged.id), null, 'the staged row never holds the original');
  await f.handlers.resume();
  await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'staged-refused', 'never a silent loss or a false ready');
  assert.equal(upload.reason, 'unavailable', 'the client renders this as unavailable; the visitor attaches again');
  assert.equal(f.normalized.length, 0);
  await f.assertNoTrace(image);
});

test('AIT-610 option A: above the pending-normalization cap a request is refused with a reason before its body is read', async t => {
  const f = await fixture(t), images = Array.from({ length: SERVER_UPLOAD_LIMITS.maxFilesPerRequest }, () => sentinelImage());
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { entered = resolve; });
  f.normalizer.verdict = async (bytes, metadata, options) => { entered(); await gated(gate, options); return { status: 'staged-refused', reason: 'unsupported' }; };
  const first = await f.upload('fill', images.map((image, i) => [`held-${i}.png`, image.bytes])), firstBody = await first.text();
  assert.equal(first.status, 202, firstBody);
  await running;
  let pulled = false;
  const later = sentinelImage(), form = new FormData();
  form.append('clientEventId', 'over-cap'); form.append('files', new File([later.bytes], 'later.png', { type: 'image/png' }));
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  const raw = Buffer.from(await encoded.arrayBuffer());
  const stream = new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(raw); controller.close(); } }, { highWaterMark: 0 });
  const response = await f.handlers.handle(new Request(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST', body: stream, duplex: 'half',
    headers: { 'x-aithema-session-token': testToken, 'content-type': encoded.headers.get('content-type') } }));
  const body = await response.text();
  assert.equal(response.status, 429, body);
  assert.deepEqual(JSON.parse(body), { error: 'upload-rate-limit', reason: 'image-normalizations' });
  assert.equal(pulled, false, 'refused before the body is read');
  release();
  await f.handlers.idle();
  for (const image of [...images, later]) await f.assertNoTrace(image, { responses: [firstBody, body] });
});

// Scope (gate M2): a document is document input. An image embedded in an Office
// package goes to the local text extractor under the document rules; no model
// lane receives it as image input, and the image normalizer never sees it.
test('AIT-610 scope: an image embedded in an Office document never becomes image input to a model lane', async t => {
  const f = await fixture(t), image = sentinelImage();
  // document.xml references the image as an inline picture (gate2c): a real
  // embedded image, not an unreferenced package member.
  const file = docxWithInlineImage('Quarterly report words.', image.bytes);
  assert.ok(file.includes(Buffer.from('r:embed="rIdImage1"')) && file.includes(Buffer.from('media/image1.png')), 'the fixture references its image');
  const response = await f.upload('embedded', [['report.docx', file, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]);
  const body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'accepted', JSON.stringify({ state: upload.state, reason: upload.reason }));
  assert.ok(f.admitted.length > 0, 'a model lane ran with the document');
  for (const request of f.admitted) assert.equal(imageReferences(JSON.parse(request)).length, 0, 'no image input on a model lane');
  assert.deepEqual(leaksIn(f.admitted.join('\n'), image), [], 'model lanes');
  assert.equal(f.normalized.length, 0, 'the image normalizer never sees document content');
});

// ---- AIT-610 r3 (gate2c) ----
const multipart = (clientEventId, files) => {
  const form = new FormData(); form.append('clientEventId', clientEventId);
  for (const [name, content, type = 'image/png'] of files) form.append('files', new File([content], name, { type }));
  return new Request('http://localhost/', { method: 'POST', body: form });
};
// A body the test owns chunk by chunk: `pulled` reports whether the server read it.
async function streamedUpload(f, sessionId, encoded, { chunks: split = 2, contentLength = false, failAfter } = {}) {
  const raw = Buffer.from(await encoded.arrayBuffer()), size = Math.ceil(raw.length / split), chunks = [];
  for (let offset = 0; offset < raw.length; offset += size) chunks.push(new Uint8Array(raw.subarray(offset, offset + size)));
  const state = { pulled: false, chunks, raw };
  let next = 0;
  const stream = new ReadableStream({ pull(controller) {
    state.pulled = true;
    if (failAfter !== undefined && next === failAfter) { controller.error(new TypeError('connection reset')); return; }
    if (next < chunks.length) controller.enqueue(chunks[next++]); else controller.close();
  } }, { highWaterMark: 0 });
  const headers = { 'x-aithema-session-token': testToken, 'content-type': encoded.headers.get('content-type'), ...(contentLength ? { 'content-length': String(raw.length) } : {}) };
  state.response = f.handlers.handle(new Request(`http://localhost/api/sessions/${sessionId}/uploads`, { method: 'POST', body: stream, duplex: 'half', headers }));
  return state;
}

// M1: the image-slot reservation is taken synchronously at the admission
// check, before any await; concurrent requests cannot all pass the check.
test('AIT-610 r3: three concurrent image requests at the cap: at most the cap is admitted, the rest get 429 image-normalizations before their body is read', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.normalizer.verdict = async (bytes, metadata, options) => { await gated(gate, options); return { status: 'staged-refused', reason: 'unsupported' }; };
  const sessions = [f.session, f.storage.create({ ownerToken: testToken, demo: true }), f.storage.create({ ownerToken: testToken, demo: true })];
  const images = sessions.map(() => Array.from({ length: 3 }, () => sentinelImage()));
  // All three handle() calls start in the same tick, as concurrent HTTP requests do.
  const encoded = images.map((set, i) => multipart(`concurrent-${i}`, set.map((image, j) => [`c${i}-${j}.png`, image.bytes])));
  const states = await Promise.all(sessions.map((session, i) => streamedUpload(f, session.id, encoded[i])));
  const responses = await Promise.all(states.map(async state => { const response = await state.response; return { status: response.status, body: await response.text(), pulled: state.pulled }; }));
  const admitted = responses.filter(r => r.status === 202), refused = responses.filter(r => r.status === 429);
  const admittedImages = admitted.reduce((n, r) => n + JSON.parse(r.body).uploads.filter(upload => upload.kind === 'image').length, 0);
  assert.ok(admittedImages <= 8, `at most the cap is admitted (${admittedImages} images in ${admitted.length} requests)`);
  assert.equal(admitted.length + refused.length, 3, JSON.stringify(responses.map(r => r.status)));
  assert.ok(refused.length >= 1, 'a concurrent request is refused');
  for (const r of refused) {
    assert.deepEqual(JSON.parse(r.body), { error: 'upload-rate-limit', reason: 'image-normalizations' });
    assert.equal(r.pulled, false, 'refused before its body is read');
  }
  release();
  await f.handlers.idle();
  assert.deepEqual({ ...uploadModule.uploadAdmissionState?.() }, { pendingUploadRequests: 0, imageSlots: 0 }, 'every reservation is released');
  for (const set of images) for (const image of set) await f.assertNoTrace(image, { responses: responses.map(r => r.body) });
});

// M2: every exit path zero-fills the whole request body (and the partial
// buffers of a failed read), not only the classified image views.
for (const [label, build, options] of [
  ['malformed multipart', image => {
    const boundary = 'ait610zero', raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientEventId"\r\n\r\nzero\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="files"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n'), image.bytes, Buffer.from(`\r\n--${boundary}-X\r\n`)]);
    return new Request('http://localhost/', { method: 'POST', body: raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  }, {}],
  ['excess parts', image => multipart('zero-parts', Array.from({ length: 10 }, (_, i) => [`p-${i}.png`, image.bytes])), { contentLength: true }],
  ['an unknown field', image => { const request = multipart('zero-field', [['f.png', image.bytes]]); return request; }, { field: true }],
  ['oversized file', image => multipart('zero-size', [['huge.png', Buffer.concat([image.bytes, Buffer.alloc(SERVER_UPLOAD_LIMITS.maxBytes, 7)])]]), { contentLength: true }],
  ['a read failure', image => multipart('zero-read', [['cut.png', image.bytes]]), { chunks: 3, failAfter: 2 }],
  ['a request over the limit while reading', image => multipart('zero-limit', [['big.png', Buffer.concat([image.bytes, Buffer.alloc(SERVER_UPLOAD_LIMITS.maxRequestBytes, 7)])]]), { chunks: 3 }],
  ['an admitted request', image => multipart('zero-admitted', [['ok.png', image.bytes], ['notes.txt', textBytes('Plain words'), 'text/plain']]), { contentLength: true }],
]) test(`AIT-610 r3: the whole request body is zero-filled on exit (${label})`, async t => {
  const f = await fixture(t), image = sentinelImage(), captured = [];
  let request = build(image);
  if (options.field) {
    const form = new FormData(); form.append('clientEventId', 'zero-field'); form.append('smuggled', new File([image.bytes], 'f.png', { type: 'image/png' }));
    request = new Request('http://localhost/', { method: 'POST', body: form });
  }
  const size = Buffer.from(await request.clone().arrayBuffer()).length;
  // The declared-length body buffer is allocated by readBody: keep a handle on it.
  const allocUnsafe = Buffer.allocUnsafe;
  t.mock.method(Buffer, 'allocUnsafe', function (n, ...rest) { const buffer = allocUnsafe.call(this, n, ...rest); if (n === size) captured.push(buffer); return buffer; });
  const state = await streamedUpload(f, f.session.id, request, options);
  const response = await state.response.catch(error => error), body = response instanceof Response ? await response.text() : String(response);
  await f.handlers.idle();
  t.mock.restoreAll();
  if (label === 'an admitted request') assert.equal(response.status, 202, body); else assert.ok(!(response instanceof Response) || response.status >= 400, body);
  assert.ok(state.pulled, 'the body was read');
  if (options.contentLength) assert.ok(captured.length >= 1, 'the declared-length body buffer was observed');
  for (const [i, chunk] of state.chunks.entries()) assert.deepEqual(leaksIn(Buffer.from(chunk).toString('latin1'), image), [], `request chunk ${i}`);
  for (const buffer of captured) assert.deepEqual(leaksIn(buffer.toString('latin1'), image), [], 'the declared-length body buffer');
  await f.assertNoTrace(image, { responses: [body] });
});

// M3: an exception after admission (an expiry checkpoint, for example) can
// never strand an owned original or a reservation.
test('AIT-610 r3: a throw in expiry after admission strands no original and releases the reservation', async t => {
  const f = await fixture(t), image = sentinelImage();
  let armed = false, thrown = 0;
  const postUploads = f.storage.postUploads.bind(f.storage), expireStagedUploads = f.storage.expireStagedUploads.bind(f.storage);
  t.mock.method(f.storage, 'postUploads', (...args) => { const result = postUploads(...args); armed = true; return result; });
  t.mock.method(f.storage, 'expireStagedUploads', (...args) => { if (armed) { armed = false; thrown++; throw new Error('Erasure checkpoint unavailable'); } return expireStagedUploads(...args); });
  const response = await f.upload('expiry-throws', [['strand.png', image.bytes]]).catch(error => error);
  const body = response instanceof Response ? await response.text() : String(response);
  await f.handlers.idle();
  assert.equal(thrown, 1, 'the injected expiry failure happened after admission');
  const upload = f.storage.get(f.session.id).uploads.find(item => item.filename === 'strand.png');
  assert.equal(upload.state, 'staged-refused', 'the job still ran and released its original');
  assert.equal(f.normalized.length, 1);
  assert.deepEqual({ ...uploadModule.uploadAdmissionState?.() }, { pendingUploadRequests: 0, imageSlots: 0 }, 'no original or reservation is stranded');
  await f.assertNoTrace(image, { responses: [body] });
});

// M4: restart recovery. A missing original is checked first; boot expiry runs
// after recovery, so an old pending row becomes 'unavailable', never discarded.
for (const [label, shift] of [['after the request deadline', 60_000], ['after the staging expiry (an old pending row at boot)', 31 * 60_000]]) {
  test(`AIT-610 r3: restart recovery ${label} surfaces as staged-refused 'unavailable'`, async t => {
    const f = await fixture(t), image = sentinelImage(), start = Date.now();
    f.storage.postUploads(f.session.id, 'before-restart', 'before-restart', [{ kind: 'image', filename: 'lost.png', mediaType: 'image/png',
      bytes: image.bytes, deadlineAt: start + 25_000 }], SERVER_UPLOAD_LIMITS);
    // One clock for every component: Date, read by the storage and the runtime.
    t.mock.timers.enable({ apis: ['Date'], now: start + shift });
    await f.handlers.resume();
    await f.handlers.idle();
    const upload = f.storage.get(f.session.id).uploads.find(item => item.filename === 'lost.png');
    assert.equal(upload.state, 'staged-refused', 'never discarded silently, never ready');
    assert.equal(upload.reason, 'unavailable', 'the client asks the visitor to attach it again');
    assert.equal(f.normalized.length, 0);
    t.mock.timers.reset();
    await f.assertNoTrace(image);
  });
}

// M5: image signatures the classifier missed (BMP, TIFF) and an image MIME on
// a document suffix are image input: held in memory, never stored if refused.
for (const [label, name, content, type] of [
  ['BMP bytes named as a PDF', 'scan.pdf', image => Buffer.concat([Buffer.from('BM'), Buffer.alloc(12, 0), image.bytes]), 'application/pdf'],
  ['little-endian TIFF bytes named as text', 'notes.txt', image => Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), image.bytes]), 'text/plain'],
  ['big-endian TIFF bytes without a suffix', 'photo', image => Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), image.bytes]), 'application/octet-stream'],
  ['an image MIME on a document suffix', 'chart.csv', image => image.bytes.subarray(8), 'image/png'],
]) test(`AIT-610 r3: ${label} is image input and never reaches SQLite, the WAL or a backup`, async t => {
  const f = await fixture(t), image = sentinelImage();
  f.holdReader();
  // clientEventId allows [a-zA-Z0-9_-] only; the filename's dot is not part of it.
  const response = await f.upload(`format-${name.replace(/[^a-zA-Z0-9_-]/gu, '-')}`, [[name, content(image), type]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload?.kind, 'image', JSON.stringify(upload));
  assert.equal(upload.state, 'staged-refused');
  assert.ok(upload.reason, 'the refusal states its reason');
  await f.assertNoTrace(image, { responses: [body] });
});
