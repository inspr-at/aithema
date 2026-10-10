import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandlers, createPluginRuntime, SQLiteStorage, mockPresets, SERVER_UPLOAD_LIMITS, normalizeUploadLimits, uploadLimitConfig, sniffUploadDocument, readBody } from '../src/index.js';
import { scanUploadMultipart } from '../src/upload-multipart.js';
import { createMockReasoning, PluginRegistry, reasoningRequest, inputRevision, conceptHTMLSpec, conceptPrompt, createSession, applyEvent } from '@inspr/aithema-core';
import { EXTRACTOR_LIMITS, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { createTextExtractor } from '@inspr/aithema-plugin-extract-text';
import { registerDemoExtractors } from '../../../demo/uploads.js';
import { qualifyStartBinding, createProcessingConsent, CONSENT_ITEMS } from '../../../demo/processing-consent.js';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { mockConsent, testToken, ownedRequest, temporaryDb, unzip } from '../../../test/helpers.js';
import { bytes, pdf, docx, xlsx, pptx, HANG, stallWorkerURL } from '../../../test/extractor-fixtures.js';
import { observeParsers, waitFor } from '../../../plugins/extract-text/test/extractor-test-helpers.js';

function setup(t, { storage = new SQLiteStorage(), consent = mockConsent, limits, readUploadBody, textPlugin, reasoning = createMockReasoning(), presets = mockPresets(), manageStorage = true } = {}) {
  const registry = new PluginRegistry().register(reasoning);
  if (textPlugin) { registry.register(textPlugin); presets.best.plugins.push(textPlugin.manifest.id); presets.best.extractors = [{ plugin: textPlugin.manifest.id }]; }
  else registerDemoExtractors(registry, presets);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, uploads: { limits, ...(readUploadBody ? { readBody: readUploadBody } : {}) } });
  const session = storage.create({ ownerToken: testToken, demo: true });
  t.after(async () => { await handlers.close(); if (manageStorage) storage.close(); });
  return { storage, runtime, handlers, session };
}
function uploadRequest(id, clientEventId, files = [['requirements.txt', bytes('Document fixture words')]], options = {}) {
  const form = new FormData(); form.append('clientEventId', clientEventId);
  if (options.revision !== undefined) form.append('inputRevision', options.revision);
  for (const [name, content, type = 'image/png'] of files) form.append('files', new File([content], name, { type }));
  return new Request(`http://localhost/api/sessions/${id}/uploads`, { method: 'POST', body: form,
    headers: { 'x-aithema-session-token': options.token ?? testToken } });
}
const action = (id, path, body = {}) => ownedRequest(`http://localhost/api/sessions/${id}/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function post(f, clientId, files, options) {
  const response = await f.handlers.handle(uploadRequest(f.session.id, clientId, files, options));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  return response.json();
}

test('multipart pending acknowledgement, terminal extraction and no content in journal/receipts/snapshot', async t => {
  const f = setup(t), initial = inputRevision(f.session);
  const response = await post(f, 'document', [['requirements.txt', bytes('Document sentinel private content')]]);
  assert.equal(response.events[0].type, 'upload.state'); assert.equal(response.uploads[0].state, 'pending');
  const uploadId = response.uploads[0].id;
  assert.ok(f.storage.uploadBytes(f.session.id, uploadId));
  assert.notEqual(inputRevision(f.storage.get(f.session.id)), initial);
  await f.handlers.idle();
  const session = f.storage.get(f.session.id), upload = session.uploads[0];
  assert.equal(upload.state, 'accepted'); assert.equal(upload.mediaType, 'text/plain'); assert.equal(upload.extractor, 'extract-text');
  assert.equal(upload.text, 'Document sentinel private content'); assert.equal(f.storage.uploadBytes(session.id, uploadId), null);
  assert.equal(session.understanding.inputRevision, inputRevision(session), 'upload-only input refreshes understanding');
  assert.equal(session.transcript.some(t => t.role === 'user'), false, 'documents do not become person words');
  for (const table of ['events', 'receipts', 'sessions']) assert.equal(JSON.stringify(f.storage.db.prepare(`SELECT * FROM ${table}`).all()).includes('Document sentinel'), false, table);
  const attempts = f.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='extractor'").all();
  assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'settled'); assert.equal(attempts[0].outcome, 'completed'); assert.equal(attempts[0].settled_micro, 0);
  const prompt = reasoningRequest(session, 'reaction');
  assert.match(prompt.system, /document.*untrusted data/su); assert.match(prompt.messages.find(m => m.content.startsWith('UNTRUSTED')).content, /Document sentinel/u);
});

for (const [name, content, mediaType, extractor] of [
  ['readable.pdf', pdf(), EXTRACTOR_MEDIA_TYPES.pdf, 'extract-pdf'],
  ['readable.docx', docx(), EXTRACTOR_MEDIA_TYPES.docx, 'extract-ooxml'],
  ['readable.xlsx', xlsx(), EXTRACTOR_MEDIA_TYPES.xlsx, 'extract-ooxml'],
  ['readable.pptx', pptx(), EXTRACTOR_MEDIA_TYPES.pptx, 'extract-ooxml'],
  ['readable.txt', bytes('Text extraction fixture'), 'text/plain', 'extract-text'],
]) test(`accepted ${name} uses sniffed type despite a false client MIME`, { timeout: 15000 }, async t => {
  const f = setup(t); await post(f, 'readable', [[name, content]]); await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'accepted'); assert.equal(upload.mediaType, mediaType); assert.equal(upload.extractor, extractor);
  assert.match(upload.text, /fixture/iu);
});

for (const [name, content, reason] of [['empty.txt', bytes(''), 'empty'], ['broken.pdf', bytes('%PDF-broken'), 'malformed'],
  ['empty.docx', docx(''), 'empty'], ['fake.pdf', bytes('This is plain text'), 'unsupported'],
  ['disguised.txt', pdf(), 'unsupported'], ['binary.txt', Buffer.from([0, 1, 255]), 'unsupported'],
  ['large.txt', Buffer.alloc(EXTRACTOR_LIMITS.maxBytes + 1, 97), 'limit']]) test(`unreadable ${name} reports ${reason} and discards originals`, async t => {
  const f = setup(t); await post(f, 'unreadable', [[name, content]]); await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'unreadable'); assert.equal(upload.reason, reason); assert.equal(upload.text, undefined);
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
});

test('ownership precedes dedup, byte conflicts, revision checks and erased-session retries', async t => {
  const f = setup(t), revision = inputRevision(f.session), files = [['identity.txt', bytes('Exact receipt fixture')]];
  const first = await post(f, 'receipt', files, { revision }); await f.handlers.idle();
  const seq = f.storage.get(f.session.id).seq;
  const receipt = f.storage.uploadReceipt.bind(f.storage); let lookups = 0;
  f.storage.uploadReceipt = (...args) => { lookups++; return receipt(...args); };
  for (const token of ['wrong', '']) assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'receipt', files, { revision, token }))).status, 404);
  assert.equal(lookups, 0, 'unauthorized requests never reach dedup');
  const replay = await f.handlers.handle(uploadRequest(f.session.id, 'receipt', files, { revision }));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).uploads[0].id, first.uploads[0].id);
  assert.equal(f.storage.get(f.session.id).seq, seq);
  assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'receipt', [['identity.txt', bytes('Changed')]], { revision }))).status, 409);
  assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'new', files, { revision }))).status, 409);
  await f.handlers.handle(action(f.session.id, 'erase'));
  assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'receipt', files, { revision }))).status, 404);
});

test('retries without an inputRevision normalize multipart boundaries and replay withdrawn IDs', async t => {
  const f = setup(t), first = await post(f, 'retry'); await f.handlers.idle();
  assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'retry'))).status, 200);
  const id = first.uploads[0].id;
  assert.equal((await f.handlers.handle(action(f.session.id, `uploads/${id}/withdraw`))).status, 200);
  const response = await f.handlers.handle(uploadRequest(f.session.id, 'retry'));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).uploads, [{ id, state: 'withdrawn', erased: true, withdrawn: true }]);
});

test('file size, request file count and per-session byte/count ceilings include pending reservations', async t => {
  for (const limits of [{ maxBytes: 4 }, { maxFilesPerRequest: 1 }, { maxDocumentsPerSession: 1 }, { maxSessionBytes: 4 }]) {
    const f = setup(t, { limits });
    const files = limits.maxFilesPerRequest ? [['a.txt', bytes('a')], ['b.txt', bytes('b')]] : [['a.txt', bytes('abcde')]];
    if (limits.maxDocumentsPerSession) { await post(f, 'first', [['first.txt', bytes('a')]]); await f.handlers.idle(); }
    assert.equal((await f.handlers.handle(uploadRequest(f.session.id, 'overflow', files))).status, 413);
  }
});

test('streaming request body enforces the byte ceiling without Content-Length', async t => {
  const f = setup(t, { limits: { maxRequestBytes: 1024 } }); let cancelled = false;
  const request = ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
    body: new ReadableStream({ pull(c) { c.enqueue(Buffer.alloc(600, 97)); }, cancel() { cancelled = true; } }) });
  assert.equal((await f.handlers.handle(request)).status, 413); assert.equal(cancelled, true);
  const declared = ownedRequest(request.url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture', 'content-length': '1025' }, body: '' });
  assert.equal((await f.handlers.handle(declared)).status, 413);
});

test('many tiny multipart parts are refused before formData is called', async t => {
  const f = setup(t), form = new FormData();
  for (let i = 0; i < 1000; i++) form.append('files', 'x');
  const parser = t.mock.method(Request.prototype, 'formData', () => assert.fail('multipart parser must not run'));
  const request = ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST', body: form });
  assert.equal((await f.handlers.handle(request)).status, 413);
  assert.equal(parser.mock.callCount(), 0);
  assert.equal(f.storage.get(f.session.id).uploads.length, 0);
});

test('an oversized multipart header is refused before formData is called', async t => {
  const f = setup(t), boundary = 'header-fixture';
  const parser = t.mock.method(Request.prototype, 'formData', () => assert.fail('multipart parser must not run'));
  const request = ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="clientEventId"\r\nX-Padding: ${'a'.repeat(8192)}\r\n\r\nheader\r\n--${boundary}--\r\n` });
  assert.equal((await f.handlers.handle(request)).status, 413);
  assert.equal(parser.mock.callCount(), 0);
  assert.equal(f.storage.get(f.session.id).uploads.length, 0);
});

test('native multipart parsing receives bounded metadata and admission reuses body byte views', async t => {
  let body;
  const f = setup(t, { readUploadBody: async (...args) => { body = await readBody(...args); return body; } });
  const original = Request.prototype.formData, admitted = f.storage.postUploads.bind(f.storage);
  t.mock.method(Request.prototype, 'formData', async function() {
    const metadata = await this.clone().arrayBuffer();
    assert.ok(metadata.byteLength < 1024, 'native parser never receives document payloads');
    const form = await original.call(this);
    assert.equal(form.get('files').size, 0);
    return form;
  });
  t.mock.method(File.prototype, 'arrayBuffer', () => assert.fail('no document File copy'));
  t.mock.method(f.storage, 'postUploads', (id, clientId, digest, files, ...rest) => {
    assert.equal(files[0].bytes.buffer, body.buffer);
    assert.equal(files[0].bytes.byteLength, 60000);
    return admitted(id, clientId, digest, files, ...rest);
  });
  await post(f, 'views', [['Straße.txt', bytes('Document fixture words. '.repeat(2500))]]);
  await f.handlers.idle();
  assert.equal(f.storage.get(f.session.id).uploads[0].filename, 'Straße.txt');
});

test('multipart scanning preserves boundary-like payload bytes and refuses malformed framing', () => {
  const type = 'multipart/form-data; boundary="fixture"';
  const payload = 'literal\r\n--fixtureX\r\nmore';
  const body = Buffer.from(`--fixture\r\nContent-Disposition: form-data; name="files"; filename="literal.txt"\r\n\r\n${payload}\r\n--fixture--\r\n`);
  const { parts } = scanUploadMultipart(body, type, 1);
  assert.equal(parts[0].bytes.toString(), payload); assert.equal(parts[0].bytes.buffer, body.buffer);
  for (const invalid of [body.subarray(1), body.subarray(0, body.length - 5), Buffer.concat([body, Buffer.from('junk')])]) {
    assert.throws(() => scanUploadMultipart(invalid, type, 1), TypeError);
  }
  assert.throws(() => scanUploadMultipart(body, 'multipart/form-data; boundary=' + 'a'.repeat(71), 1), TypeError);
});

test('declared-length streaming bodies fill one buffer and reject length mismatches', async () => {
  const request = length => new Request('http://localhost/upload', { method: 'POST', duplex: 'half',
    headers: { 'content-length': String(length) }, body: new ReadableStream({ start(c) {
      c.enqueue(Buffer.from('abc')); c.enqueue(Buffer.from('def')); c.close();
    } }) });
  assert.equal((await readBody(request(6), 10)).toString(), 'abcdef');
  await assert.rejects(readBody(request(5), 10), TypeError);
  await assert.rejects(readBody(request(7), 10), TypeError);
});

test('undeclared streaming bodies grow without concatenating a second complete body', async t => {
  const request = new Request('http://localhost/upload', { method: 'POST', duplex: 'half',
    body: new ReadableStream({ start(c) {
      for (const chunk of ['abc', 'def', 'ghi']) c.enqueue(Buffer.from(chunk));
      c.close();
    } }) });
  const concat = t.mock.method(Buffer, 'concat', () => assert.fail('no full-body concat'));
  const body = await readBody(request, 10);
  assert.equal(body.toString(), 'abcdefghi'); assert.equal(body.buffer.resizable, true);
  assert.equal(concat.mock.callCount(), 0);
});

for (const cap of ['session', 'deployment']) test(`${cap} upload concurrency is capped before reading or parsing, and slots are released`, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(); let reads = 0;
  const limits = cap === 'session' ? { maxConcurrentRequestsPerSession: 1 } : { maxConcurrentRequestsPerDeployment: 1 };
  const readUploadBody = async (...args) => { if (++reads === 1) { started.resolve(); await release.promise; } return readBody(...args); };
  const first = setup(t, { limits, readUploadBody });
  const second = cap === 'session' ? first : setup(t, { limits, readUploadBody });
  const parser = t.mock.method(Request.prototype, 'formData');
  const held = first.handlers.handle(uploadRequest(first.session.id, 'held'));
  try {
    await waitFor(started.promise, 'held upload body');
    assert.equal((await second.handlers.handle(uploadRequest(second.session.id, 'overflow'))).status, 429);
    assert.equal(reads, 1); assert.equal(parser.mock.callCount(), 0);
  } finally { release.resolve(); }
  assert.equal((await held).status, 202); await first.handlers.idle();
  assert.equal((await second.handlers.handle(uploadRequest(second.session.id, 'after-release'))).status, 202);
  await second.handlers.idle();
  assert.equal(parser.mock.callCount(), 2);
});

test('rejected parsing and refused admission release upload concurrency slots', async t => {
  const f = setup(t, { consent: { coverage: () => ({ covered: false }) }, limits: { maxConcurrentRequestsPerSession: 1, maxConcurrentRequestsPerDeployment: 1 } });
  const invalid = ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads`, { method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=fixture' }, body: 'invalid' });
  assert.equal((await f.handlers.handle(invalid)).status, 400);
  for (const id of ['refusal-one', 'refusal-two']) assert.equal((await f.handlers.handle(uploadRequest(f.session.id, id))).status, 403);
});

test('concurrent admission cannot exceed the per-session count', async t => {
  const f = setup(t, { limits: { maxDocumentsPerSession: 1 } });
  const responses = await Promise.all(['one', 'two'].map(id => f.handlers.handle(uploadRequest(f.session.id, id))));
  assert.equal(responses.filter(r => r.status === 202).length, 1);
  assert.ok(responses.some(r => [409, 413].includes(r.status)));
  await f.handlers.idle(); assert.equal(f.storage.get(f.session.id).uploads.length, 1);
});

for (const operation of ['withdraw', 'erase', 'consent']) test(`${operation} kills and reaps a running parser before acknowledgement`, { timeout: 10000 }, async t => {
  const observer = observeParsers(t), f = setup(t, { textPlugin: createTextExtractor({ workerURL: stallWorkerURL }) });
  const started = observer.spawned(); const posted = await post(f, 'stall', [['stall.txt', bytes(HANG)]]);
  const record = await waitFor(started, 'parser spawn'); assert.equal(await waitFor(record.started, 'parser start'), true);
  const uploadId = posted.uploads[0].id;
  const request = operation === 'withdraw' ? ownedRequest(`http://localhost/api/sessions/${f.session.id}/uploads/${uploadId}`, { method: 'DELETE' })
    : action(f.session.id, operation, operation === 'consent' ? { granted: false } : {});
  assert.equal((await f.handlers.handle(request)).status, 200);
  assert.equal(observer.activeCount(), 0); assert.equal(observer.killedCount(), 1);
  assert.equal(f.storage.uploadBytes(f.session.id, uploadId), null);
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, operation === 'consent' ? 'unreadable' : 'withdrawn');
  await f.handlers.idle();
  const attempts = f.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='extractor'").all();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'settled'); assert.equal(attempts[0].outcome, 'uncertain');
  assert.equal(attempts[0].usage, null); assert.equal(attempts[0].settled_micro, attempts[0].max_micro); assert.equal(attempts[0].max_micro, 0);
});

test('withdrawal clears projections and text across restart, physical storage, replay and export', async t => {
  const path = await temporaryDb(), f = setup(t, { storage: new SQLiteStorage(path), manageStorage: false });
  const response = await post(f, 'erase-content', [['private-name.txt', bytes('upload-erasure-sentinel')]]); await f.handlers.idle();
  const uploadId = response.uploads[0].id;
  const withdrawal = await f.handlers.handle(action(f.session.id, `uploads/${uploadId}/withdraw`));
  assert.equal(withdrawal.status, 200); await f.handlers.idle();
  assert.equal(f.storage.get(f.session.id).understanding.inputRevision, null);
  const exported = unzip(await (await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/export`))).arrayBuffer());
  assert.deepEqual(JSON.parse(exported['uploads.json']), [{ id: uploadId }]);
  for (const table of ['events', 'receipts', 'sessions', 'content']) {
    const value = JSON.stringify(f.storage.db.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(value.includes('upload-erasure-sentinel'), false); assert.equal(value.includes('private-name'), false);
  }
  for (const file of [path, path + '-wal']) assert.equal((await readFile(file).catch(e => { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; })).includes(bytes('upload-erasure-sentinel')), false);
  await f.handlers.close(); f.storage.close();
  const restored = new SQLiteStorage(path);
  try {
    assert.equal(restored.get(f.session.id).uploads[0].state, 'withdrawn');
    let replay = createSession({ id: f.session.id }); for (const event of restored.read(f.session.id)) replay = applyEvent(replay, event);
    assert.equal(JSON.stringify(replay).includes('upload-erasure-sentinel'), false);
    assert.equal(replay.uploads[0].state, 'withdrawn');
    assert.equal(inputRevision(replay), inputRevision(restored.get(f.session.id)), 'tombstone replay preserves the original revision transitions');
  } finally { restored.close(); }
});

test('export includes full extracted text and metadata, without original document bytes', async t => {
  const f = setup(t); await post(f, 'export', [['source.pdf', pdf(['Full extracted export fixture text'])]]); await f.handlers.idle();
  const response = await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/export`));
  assert.equal(response.status, 200);
  const files = unzip(await response.arrayBuffer()), uploads = JSON.parse(files['uploads.json']);
  assert.equal(uploads[0].state, 'accepted'); assert.equal(uploads[0].filename, 'source.pdf');
  assert.match(uploads[0].text, /Full extracted export fixture/u);
  assert.equal(Object.keys(files).some(k => k.endsWith('.pdf')), false); assert.equal(JSON.stringify(files).includes('%PDF'), false);
  const session = f.storage.get(f.session.id);
  assert.deepEqual(conceptHTMLSpec(session).visitorWords, []);
  assert.match(conceptPrompt(session), /untrusted-upload/u);
});

test('missing upload content hydrates as a tombstone and never blocks export', async t => {
  const f = setup(t); await post(f, 'missing'); await f.handlers.idle();
  f.storage.db.prepare("DELETE FROM content WHERE kind='upload'").run();
  const session = f.storage.get(f.session.id);
  assert.equal(session.uploads[0].state, 'withdrawn');
  assert.equal((await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/export`))).status, 200);
  const removed = await f.handlers.handle(action(session.id, `uploads/${session.uploads[0].id}/withdraw`));
  assert.equal(removed.status, 200); assert.equal((await removed.json()).event.data.state, 'withdrawn');
  assert.equal(f.storage.get(session.id).understanding.inputRevision, null);
});

test('local demo upload feature uses the existing mock grant and unavailable presets carry reasons', async t => {
  const f = setup(t), matrix = await f.runtime.matrix(f.session);
  assert.deepEqual(matrix.best.uploads, { available: true, reason: null });
  assert.equal(matrix.eu.uploads.available, false); assert.equal(matrix.device.uploads.reason, 'unavailable on device');
  const noGrant = setup(t, { consent: { coverage: () => ({ covered: false }) } });
  const response = await noGrant.handlers.handle(uploadRequest(noGrant.session.id, 'blocked'));
  assert.equal(response.status, 403); assert.equal((await response.json()).reason, 'current processing consent required');
  assert.equal(noGrant.storage.get(noGrant.session.id).uploads.length, 0);
});

test('START reasoning item covers file text exactly; lacking file-text disables uploads', async t => {
  for (const includeDocuments of [true, false]) {
    const storage = new SQLiteStorage();
    let binding = qualifyStartBinding({ plugin: 'openrouter', model: 'openai/fixture', effort: 'none', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      accountRef: 'fixture-account', secretRef: 'fixture-ref', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
    if (!includeDocuments) binding = { ...binding, legal: { ...binding.legal, dataCategories: ['messages', 'conversation-history', 'assessment'] } };
    const reasoning = createOpenRouterReasoning({ binding, prices: { 'openai/fixture': { prompt: 0, completion: 0 } },
      resolveSecret: () => 'local-fixture', fetchImpl: () => assert.fail('provider dispatch forbidden') });
    const presets = { best: { plugins: ['openrouter'], policy: { endpoints: [binding.endpoint] }, bindings: { reaction: binding, understanding: binding } } };
    const consent = createProcessingConsent({ storage, bindings: [binding] }), f = setup(t, { storage, reasoning, presets, consent });
    const decision = consent.describe();
    assert.match(CONSENT_ITEMS[0].text, /text read from uploaded files/u);
    assert.equal(consent.grant({ sessionId: f.session.id, consentRevision: 1, decision: { contract: decision.contract, items: ['models-international'] } }), true);
    storage.reviseConsent(f.session.id, true);
    const availability = await f.runtime.uploadAvailability(storage.get(f.session.id));
    assert.equal(availability.reason, includeDocuments ? undefined : 'document text not covered by reasoning scope');
    if (!includeDocuments) {
      // Existing accepted documents cannot bypass this guard after a host changes
      // its allowed processing scope. No provider is invoked by this test.
      const pending = storage.postUploads(f.session.id, 'old-scope', 'fixture-digest', [{ filename: 'old.txt', mediaType: 'text/plain',
        bytes: bytes('Existing document scope fixture'), deadlineAt: Date.now() + 25000 }], SERVER_UPLOAD_LIMITS);
      storage.completeUpload(f.session.id, pending.events[0].data.id, { status: 'accepted', text: 'Existing document scope fixture', truncated: false });
      const current = storage.get(f.session.id);
      await assert.rejects(f.runtime.admit({ session: current, lane: 'reaction', operation: 'stream', request: reasoningRequest(current, 'reaction'),
        options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } }), error => error.code === 'not-admitted' && error.message === 'document text not covered by reasoning scope');
    }
  }
});

test('defaults, lowering-only config and extension/content sniffing are explicit', () => {
  assert.equal(SERVER_UPLOAD_LIMITS.maxBytes, 20 * 1024 * 1024); assert.equal(SERVER_UPLOAD_LIMITS.maxDocumentsPerSession, 8);
  assert.equal(SERVER_UPLOAD_LIMITS.maxRequestBytes, 64 * 1024 * 1024);
  assert.equal(uploadLimitConfig({ AITHEMA_UPLOAD_MAX_BYTES: '1024' }).maxBytes, 1024);
  assert.equal(uploadLimitConfig({ AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS: '2', AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS_PER_SESSION: '1' }).maxConcurrentRequestsPerDeployment, 2);
  assert.equal(uploadLimitConfig({ AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS_PER_SESSION: '1' }).maxConcurrentRequestsPerSession, 1);
  assert.throws(() => normalizeUploadLimits({ maxBytes: SERVER_UPLOAD_LIMITS.maxBytes + 1 }), TypeError);
  assert.throws(() => normalizeUploadLimits({ maxConcurrentRequestsPerDeployment: SERVER_UPLOAD_LIMITS.maxConcurrentRequestsPerDeployment + 1 }), TypeError);
  assert.throws(() => uploadLimitConfig({ AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS: '0' }), TypeError);
  assert.throws(() => uploadLimitConfig({ AITHEMA_UPLOAD_MAX_FILES: 'NaN' }), TypeError);
  assert.equal(sniffUploadDocument(bytes('plain markdown'), 'notes.md').mediaType, 'text/markdown');
  assert.equal(sniffUploadDocument(pdf(), 'fake.csv').reason, 'unsupported');
});

test('document input supersedes held understanding and late results cannot overwrite its refresh', { timeout: 10000 }, async t => {
  const f = setup(t), started = Promise.withResolvers(), held = Promise.withResolvers(); let calls = 0, oldSignal;
  const admit = f.runtime.admit.bind(f.runtime);
  f.runtime.admit = async args => {
    const admitted = await admit(args);
    if (args.lane !== 'understanding') return admitted;
    return { ...admitted, plugin: { ...admitted.plugin, async structured(request, options) {
      const value = await admitted.plugin.structured(request, options);
      if (++calls === 1) { oldSignal = options.signal; started.resolve(); await held.promise; }
      return value;
    } } };
  };
  t.after(() => held.resolve());
  await post(f, 'first-refresh', [['first.txt', bytes('First document context')]]);
  await waitFor(started.promise, 'held understanding');
  await post(f, 'second-refresh', [['second.txt', bytes('Second document context')]]);
  await f.handlers.idle(); assert.equal(oldSignal.aborted, true); assert.ok(calls >= 2);
  const session = f.storage.get(f.session.id), seq = session.seq;
  assert.equal(session.understanding.inputRevision, inputRevision(session));
  held.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.storage.get(f.session.id).seq, seq);
});

test('batch deadline produces a durable unreadable reason and no live parser', { timeout: 10000 }, async t => {
  const observer = observeParsers(t), f = setup(t, { textPlugin: createTextExtractor({ workerURL: stallWorkerURL }), limits: { requestBudgetMs: 1000 } });
  const started = observer.spawned();
  await post(f, 'deadline', [['deadline.txt', bytes(HANG)]]);
  const record = await waitFor(started, 'deadline parser spawn');
  assert.equal(await waitFor(record.started, 'deadline parser start'), true);
  await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'unreadable'); assert.equal(upload.reason, 'deadline'); assert.equal(observer.activeCount(), 0);
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
  const attempts = f.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='extractor'").all();
  assert.equal(attempts.length, 1); assert.equal(attempts[0].outcome, 'uncertain'); assert.equal(attempts[0].usage, null);
  assert.equal(attempts[0].settled_micro, attempts[0].max_micro); assert.equal(attempts[0].max_micro, 0);
});

test('restart resumes pending local work and preserves accepted document IDs/text', async t => {
  const path = await temporaryDb(), storage = new SQLiteStorage(path), session = storage.create({ ownerToken: testToken, demo: true });
  const posted = storage.postUploads(session.id, 'restart', 'fixture-digest', [{ filename: 'restart.txt', mediaType: 'text/plain',
    bytes: bytes('Durable restart document'), deadlineAt: Date.now() + 25000 }], SERVER_UPLOAD_LIMITS, { ownerToken: testToken });
  storage.close();
  const f = setup(t, { storage: new SQLiteStorage(path) });
  await f.handlers.resume(); await f.handlers.idle();
  const restored = f.storage.get(session.id).uploads[0];
  assert.equal(restored.id, posted.events[0].data.id); assert.equal(restored.state, 'accepted'); assert.equal(restored.text, 'Durable restart document');
});

test('expiry applies upload tombstones and releases capacity', async t => {
  const f = setup(t, { limits: { maxDocumentsPerSession: 1 } }); await post(f, 'expired'); await f.handlers.idle();
  await f.handlers.expire(Date.now() + 1000); await f.handlers.idle();
  const removed = f.storage.get(f.session.id).uploads[0]; assert.equal(removed.state, 'withdrawn');
  assert.equal(f.storage.uploadBytes(f.session.id, removed.id), null);
  await post(f, 'replacement'); await f.handlers.idle();
  assert.equal(f.storage.get(f.session.id).uploads.filter(u => u.state === 'accepted').length, 1);
});

test('expiry cancels only expired pending uploads and preserves newer and other-session work', { timeout: 10000 }, async t => {
  const observer = observeParsers(t), f = setup(t, { textPlugin: createTextExtractor({ workerURL: stallWorkerURL }) });
  const started = observer.spawned();
  const old = await post(f, 'old-pending', [['old.txt', bytes(HANG)]]), expiredId = old.uploads[0].id;
  const record = await waitFor(started, 'expired parser spawn');
  assert.equal(await waitFor(record.started, 'expired parser start'), true);
  const newer = await post(f, 'new-pending', [['new.txt', bytes('Newer pending document')]]);
  const other = f.storage.create({ ownerToken: testToken, demo: true });
  const response = await f.handlers.handle(uploadRequest(other.id, 'other-pending'));
  assert.equal(response.status, 202);
  const get = f.storage.get.bind(f.storage);
  t.mock.method(f.storage, 'get', id => {
    const session = get(id);
    return { ...session, uploads: session.uploads.map(u => ({ ...u, at: u.id === expiredId ? '2000-01-01T00:00:00Z' : '2030-01-01T00:00:00Z' })) };
  });
  await f.handlers.expire(Date.parse('2020-01-01T00:00:00Z')); await f.handlers.idle();
  const uploads = f.storage.get(f.session.id).uploads;
  assert.equal(uploads.find(u => u.id === expiredId).state, 'withdrawn');
  assert.equal(uploads.find(u => u.id === newer.uploads[0].id).state, 'accepted');
  assert.equal(f.storage.get(other.id).uploads[0].state, 'accepted');
  assert.equal(observer.activeCount(), 0);
});
