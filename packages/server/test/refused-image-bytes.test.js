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
//   P3 POST /api/sessions/:id/turns with `attachments`: carries upload ids
//      only, never bytes; a refused id is refused before any model work.
//   Not byte paths: concept routes (JSON requests; they only serve generated
//   images), voice/realtime (JSON control bodies; images require text mode),
//   host/plugin routes (JSON). A JSON route that receives bytes treats them as
//   text and refuses invalid JSON with 400 before any storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers, createPluginRuntime, SQLiteStorage, mockPresets } from '../src/index.js';
import { createMockReasoning, PluginRegistry, reasoningRequest } from '@inspr/aithema-core';
import { registerDemoExtractors } from '../../../demo/uploads.js';
import { mockConsent, testToken, ownedRequest, temporaryDb } from '../../../test/helpers.js';
import { bytes as textBytes, pdf } from '../../../test/extractor-fixtures.js';

let serial = 0;
// A PNG signature makes the server classify the bytes as an image regardless of
// the filename. The sentinel lets every scan find even a partial copy.
function sentinelImage() {
  const marker = `AIT610-REFUSED-SENTINEL-${process.pid}-${++serial}`;
  return { marker, bytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`${marker}|${marker}|${marker}`)]) };
}
const encodings = image => [image.marker, image.bytes.toString('base64'), image.bytes.toString('base64url'), Buffer.from(image.marker).toString('base64'),
  Buffer.from(image.marker).toString('hex'), image.bytes.toString('hex')];
const serialize = value => JSON.stringify(value, (key, v) => v instanceof Uint8Array || v?.type === 'Buffer' && Array.isArray(v.data)
  ? Buffer.from(v instanceof Uint8Array ? v : v.data).toString('base64') : typeof v === 'bigint' ? String(v) : v) ?? String(value);
function leaksIn(text, image) { return encodings(image).filter(encoding => text.includes(encoding)); }

async function tmpEntries() {
  const root = tmpdir(), out = new Map();
  for (const name of await readdir(root).catch(() => [])) out.set(name, (await stat(join(root, name)).catch(() => null))?.mtimeMs);
  return out;
}

async function fixture(t) {
  const path = await temporaryDb(), storage = new SQLiteStorage(path);
  const logs = [], admitted = [], normalized = [];
  // Documents use the demo extractors so a mixed request runs the model lanes.
  const reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning), presets = mockPresets();
  registerDemoExtractors(registry, presets);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent: mockConsent });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent: mockConsent, log: entry => { logs.push(entry); } });
  const session = storage.create({ ownerToken: testToken, demo: true });
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, method, (...args) => { logs.push(args); });
  // Every model lane passes through runtime.admit with its full request.
  const admit = runtime.admit.bind(runtime);
  t.mock.method(runtime, 'admit', args => { admitted.push(serialize(args.request)); return admit(args); });
  // A fake local normalizer: records every byte it receives and refuses or accepts.
  const normalizer = { verdict: { status: 'staged-refused', reason: 'unsupported' },
    async normalize(bytes, metadata) { normalized.push(Buffer.from(bytes)); return typeof this.verdict === 'function' ? this.verdict(bytes, metadata) : this.verdict; } };
  const availability = { reason: undefined };
  const real = runtime.imageInputAvailability.bind(runtime);
  t.mock.method(runtime, 'imageInputAvailability', async (current, options) => availability.real ? real(current, options)
    : typeof availability.reason === 'function' ? availability.reason(current) : availability.reason ? { reason: availability.reason } : { plugin: normalizer, maxImages: 4 });
  const before = await tmpEntries();
  t.after(async () => { await handlers.close(); storage.close(); });
  const f = { path, storage, runtime, handlers, session, logs, admitted, normalized, normalizer, availability,
    upload(clientEventId, files, headers = {}) {
      const form = new FormData(); form.append('clientEventId', clientEventId);
      for (const [name, content, type = 'image/png'] of files) form.append('files', new File([content], name, { type }));
      return handlers.handle(new Request(`http://localhost/api/sessions/${session.id}/uploads`, { method: 'POST', body: form,
        headers: { 'x-aithema-session-token': testToken, ...headers } }));
    },
    // Proves: not stored (rows, journal, receipts, database file and WAL, temp
    // dir), not logged (console, host log), not forwarded (model lanes, events).
    async assertNoTrace(image, { responses = [] } = {}) {
      await handlers.idle();
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
      const after = await tmpEntries();
      for (const [name, mtime] of after) {
        if (before.get(name) === mtime) continue;
        const file = await readFile(join(tmpdir(), name)).catch(() => null);
        if (file) assert.deepEqual(leaksIn(file.toString('latin1'), image), [], `temp file ${name}`);
      }
      assert.deepEqual(leaksIn(serialize(logs), image), [], 'console and host log');
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

test('AIT-610 P1: the real runtime verdict (no normalizer configured) refuses with a reason and leaves no trace', async t => {
  const f = await fixture(t), image = sentinelImage();
  f.availability.real = true;
  const response = await f.upload('unconfigured', [['photo.png', image.bytes, 'application/octet-stream']]), body = await response.text();
  assert.equal(response.status, 202, body);
  assert.deepEqual(JSON.parse(body).refused, [{ index: 0, name: 'photo.png', kind: 'image', reason: 'image normalizer not configured' }]);
  await f.assertNoTrace(image, { responses: [body] });
});

// P1 whole-request refusals: no file of the request is admitted.
for (const [label, prepare, files, status, error] of [
  ['purpose pause', f => f.storage.append(f.session.id, 'session.paused', { paused: true, reason: 'purpose' }), image => [['paused.png', image.bytes]], 409, 'conversation-paused'],
  ['file size limit', null, image => [['huge.png', Buffer.concat([image.bytes, Buffer.alloc(21 * 1024 * 1024, 7)])]], 413, 'size-limit'],
  ['file count limit', null, image => Array.from({ length: 10 }, (_, i) => [`many-${i}.png`, image.bytes]), 413, 'size-limit'],
  ['documents unavailable', f => { f.runtime.uploadAvailability = async () => ({ reason: 'consent expired' }); }, image => [['mixed.png', image.bytes], ['mixed.pdf', pdf(), 'application/pdf']], 403, 'uploads-unavailable'],
]) test(`AIT-610 P1: a whole-request refusal (${label}) never stores, logs or forwards the image bytes`, async t => {
  const f = await fixture(t), image = sentinelImage();
  prepare?.(f);
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
  const response = await f.upload('normalize', [['staged.png', image.bytes]]), body = await response.text();
  assert.equal(response.status, 202, body);
  await f.handlers.idle();
  assert.equal(f.normalized.length, 1, 'only the local verifier received the bytes');
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
  if (upload) {
    assert.notEqual(upload.state, 'staged-ready');
    assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
  }
  assert.equal(f.normalized.length, 0, 'the normalizer is never called after a refusal');
  await f.assertNoTrace(image, { responses: [body] });
});
