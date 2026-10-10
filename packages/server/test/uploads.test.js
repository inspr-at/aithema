import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandlers, createPluginRuntime, SQLiteStorage, mockPresets, SERVER_UPLOAD_LIMITS, normalizeUploadLimits, uploadLimitConfig, sniffUploadDocument } from '../src/index.js';
import { createMockReasoning, PluginRegistry, reasoningRequest, inputRevision, conceptHTMLSpec, conceptPrompt, createSession, applyEvent } from '@inspr/aithema-core';
import { EXTRACTOR_LIMITS, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { createTextExtractor } from '@inspr/aithema-plugin-extract-text';
import { registerDemoExtractors } from '../../../demo/uploads.js';
import { qualifyStartBinding, createProcessingConsent, CONSENT_ITEMS } from '../../../demo/processing-consent.js';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { mockConsent, testToken, ownedRequest, temporaryDb, unzip } from '../../../test/helpers.js';
import { bytes, pdf, docx, xlsx, pptx, HANG, stallWorkerURL } from '../../../test/extractor-fixtures.js';
import { observeParsers, waitFor } from '../../../plugins/extract-text/test/extractor-test-helpers.js';

function setup(t, { storage = new SQLiteStorage(), consent = mockConsent, limits, textPlugin, reasoning = createMockReasoning(), presets = mockPresets(), manageStorage = true } = {}) {
  const registry = new PluginRegistry().register(reasoning);
  if (textPlugin) { registry.register(textPlugin); presets.best.plugins.push(textPlugin.manifest.id); presets.best.extractors = [{ plugin: textPlugin.manifest.id }]; }
  else registerDemoExtractors(registry, presets);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, uploads: { limits } });
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
  assert.ok(f.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='extractor'").all().every(a => a.state === 'settled'));
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
  assert.throws(() => normalizeUploadLimits({ maxBytes: SERVER_UPLOAD_LIMITS.maxBytes + 1 }), TypeError);
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
  const observer = observeParsers(t), f = setup(t, { textPlugin: createTextExtractor({ workerURL: stallWorkerURL }), limits: { requestBudgetMs: 200 } });
  await post(f, 'deadline', [['deadline.txt', bytes(HANG)]]); await f.handlers.idle();
  const upload = f.storage.get(f.session.id).uploads[0];
  assert.equal(upload.state, 'unreadable'); assert.equal(upload.reason, 'deadline'); assert.equal(observer.activeCount(), 0);
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
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
