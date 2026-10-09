import { test as nodeTest } from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets, createLocalImages, localImageBinding,
  createMemoryConsentLedger, createImageBinding, SQLiteBudgetLedger, createFacadeSecrets } from '../src/index.js';
import { PluginRegistry, createMockReasoning, inputRevision, reduceUnderstanding, beginInvocation } from '@inspr/aithema-core';
import { ownedRequest, testToken, temporaryDb, unzip } from '../../../test/helpers.js';
import { createLocalVoiceProvider, localVoiceBinding } from '../src/local-voice.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, { path = ':memory:', intercept, references, budgetOptions, consent: supplied, imageBinding = localImageBinding, voice = false, understanding } = {}) {
  const storage = new SQLiteStorage(path), reasoning = createMockReasoning(), images = createLocalImages({ delayMs: 1 });
  const consent = supplied ?? createMemoryConsentLedger(), presets = mockPresets();
  presets.best.plugins.push(images.manifest.id); presets.best.bindings.images = imageBinding; presets.best.policy = { endpoints: [imageBinding.endpoint] };
  const { imageCost, ...common } = imageBinding;
  const selectedImages = imageBinding.maxMicro === 0 ? images : { ...images, binding: common };
  const registry = new PluginRegistry().register(reasoning).register(selectedImages), budget = new SQLiteBudgetLedger(storage, budgetOptions);
  const secrets = createFacadeSecrets();
  if (voice) { registry.register(createLocalVoiceProvider({ storage, revokeFacade: secrets.revoke, provisionFacade: () => {} })); presets.best.plugins.push('fake-voice'); presets.best.bindings.voice = localVoiceBinding; }
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent, budget });
  const records = [], admit = runtime.admit;
  runtime.admit = async function (args) {
    const result = await admit.call(this, args);
    if (args.lane === 'understanding' && understanding) return { ...result, plugin: { ...result.plugin, async structured(...args) { return understanding(await reasoning.structured(...args)); } } };
    if (args.lane !== 'concept') return result;
    return { ...result, plugin: { ...result.plugin, generate(spec, feedback, options) {
      records.push({ spec, feedback, options });
      return intercept ? intercept(spec, feedback, options, images) : images.generate(spec, feedback, options);
    } } };
  };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, concepts: { references }, ...(voice ? { voice: { secrets } } : {}) });
  t.after(async () => { await handlers.close(); storage.close(); });
  const created = await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{}' }));
  const session = await created.json(), id = session.id;
  const call = (action = '', body, token = testToken) => handlers.handle(new Request(`http://localhost/api/sessions/${id}${action ? '/' + action : ''}`,
    { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  await call('consent', { granted: true });
  async function turn(turnId = crypto.randomUUID(), content = 'We need a clear dashboard for our public API.') {
    const response = await call('turns', { clientEventId: turnId, content }); assert.equal(response.status, 200);
    await handlers.idle(); return turnId;
  }
  function readiness(percent = 72) {
    const current = storage.get(id);
    const u = reduceUnderstanding(current.understanding, { summary: 'A public API dashboard', constraints: Object.fromEntries(current.preset.requiredSlots.map(slot => [slot, { value: 'fixture answer', evidence: current.transcript.find(t => t.role === 'user' && !t.erased).content }])), signals: [], openQuestions: [],
      progress: { talk: { value: percent < current.preset.talkMarker ? (percent + 1) / current.preset.talkMarker * current.preset.talkThreshold : current.preset.talkThreshold },
        build: { value: Math.max(0, (percent - current.preset.talkMarker) / (100 - current.preset.talkMarker)) } } }, { transcript: current.transcript, inputRevision: inputRevision(current), preset: current.preset });
    storage.append(id, 'understanding.updated', u); return u;
  }
  async function request(clientEventId = crypto.randomUUID(), suffix = '', sourceTurnId = storage.get(id).transcript.filter(t => t.role === 'user' && !t.erased).at(-1)?.id) {
    return call('concepts' + suffix, { clientEventId, intent: true, sourceTurnId });
  }
  return { storage, handlers, runtime, consent, session, id, records, call, turn, readiness, request, images, presets, registry };
}
async function rendered(h) {
  h.readiness(); const response = await h.request(); assert.equal(response.status, 202, JSON.stringify((await h.runtime.matrix(h.storage.get(h.id))).best.images)); await h.handlers.idle();
  const session = h.storage.get(h.id); assert.equal(session.conceptStatus.phase, 'ready', JSON.stringify(session.conceptStatus));
  return session.concepts.at(-1);
}
test('intent is required; thresholds arm only; initial explicit wish waits for understanding', async t => {
  const h = await setup(t); await h.turn('first'); h.readiness(72);
  await h.handlers.conceptLane.run(h.id); assert.equal(h.records.length, 0);
  assert.equal((await h.call('concepts', { clientEventId: 'no-intent', sourceTurnId: 'first' })).status, 400);
  h.readiness(0); assert.equal((await h.request('intent')).status, 202); await h.handlers.idle(); assert.equal(h.records.length, 0);
  h.readiness(25); await h.handlers.conceptLane.run(h.id); await h.handlers.idle(); assert.equal(h.records.length, 1);
  assert.equal(h.storage.get(h.id).concepts.length, 1);
});
test('ordinary requirements talk never records intent; the Request control does', async t => {
  const h = await setup(t);
  for (const [id, content] of [['validate', 'We want to validate the concept with users'], ['explain', 'Ich will das Konzept erklären']]) {
    await h.turn(id, content); assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
  }
  h.readiness(); assert.equal((await h.request('explicit')).status, 202); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent.id, 'explicit'); assert.equal(h.records.length, 1);
});
test('model-selected intent requires an exact quote from the current person turn', async t => {
  let quote = 'please show a concept';
  const h = await setup(t, { understanding: raw => ({ ...raw, conceptIntent: { request_quote: quote } }) });
  await h.turn('wish', 'For our API, please show a concept.');
  assert.deepEqual(h.storage.get(h.id).understanding.conceptIntent, { request_quote: quote });
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent?.sourceTurnId, 'wish');
  quote = 'invented unmatched quote';
  await h.call('consent', { granted: false }); await h.call('consent', { granted: true });
  await h.turn('unmatched', 'The assistant suggested a layout.');
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
  assert.equal(h.storage.get(h.id).understanding.conceptIntent, null);
});
test('viewer/list/provenance/download reads do not spend; bytes are owner-bound and uncached', async t => {
  const h = await setup(t); await h.turn('first'); const item = await rendered(h);
  for (const route of ['concepts', `concepts/${item.id}/image`, `concepts/${item.id}/image?download=1`, `concepts/${item.id}/provenance`]) {
    const response = await h.call(route); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  const image = await h.call(`concepts/${item.id}/image`); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('vary'), /Cookie/); assert.match(image.headers.get('content-disposition'), /inline/);
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert.equal(image.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
  for (const token of ['', 'another-owner']) assert.equal((await h.call(`concepts/${item.id}/image`, undefined, token)).status, 404);
  assert.equal((await h.call('concepts/nonexistent/image')).status, 404);
  await h.handlers.conceptLane.run(h.id); await h.handlers.idle(); assert.equal(h.records.length, 1);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE lane='concept'").get().n, 1);
});
test('feedback and removable guidance change next request private references; reject archives without generating', async t => {
  const h = await setup(t); await h.turn('first'); const first = await rendered(h);
  const response = await h.call(`concepts/${first.id}/feedback`, { clientEventId: 'feedback', vote: 'up', chips: ['More contrast', '<script>literal guidance</script>'] });
  assert.equal(response.status, 200); assert.equal(h.records.length, 1);
  assert.equal((await h.request('refine', `/${first.id}/regenerate`)).status, 202); await h.handlers.idle();
  const second = h.storage.get(h.id).concepts.at(-1);
  assert.equal(h.records.length, 2); assert.equal(h.records[1].spec.references[0].role, 'previous');
  assert.deepEqual(h.records[1].spec.references[0].bytes, h.storage.conceptArtifact(h.id, first.id).bytes);
  assert.match(h.records[1].feedback, /More contrast/); assert.equal(second.provenance.origin, 'ai-manipulated');
  await h.call(`concepts/${first.id}/feedback`, { clientEventId: 'clear', vote: 'clear', chips: [] });
  const reject = await h.call(`concepts/${second.id}/reject`, { clientEventId: 'reject' }); assert.equal(reject.status, 200);
  assert.equal(h.storage.get(h.id).concepts.at(-1).archived, true); assert.equal(h.records.length, 2);
  await h.request('after-reject', `/${first.id}/regenerate`); await h.handlers.idle();
  assert.deepEqual(h.records[2].spec.references.map(r => r.role), ['previous', 'rejected']);
  assert.match(h.records[2].feedback, /"rejected":true/); assert.doesNotMatch(h.records[2].feedback, /More contrast/);
  const journal = h.storage.db.prepare("SELECT event FROM events WHERE session_id=? AND json_extract(event,'$.type')='concept.feedback'").all(h.id);
  assert.ok(journal.every(row => !row.event.includes('literal guidance')), 'feedback content lives in erasable records');
});
test('request idempotency is byte-bound and never repeats a paid image; pause blocks fresh work but permits cached image reads', async t => {
  const h = await setup(t); await h.turn('first'); h.readiness();
  await h.request('same'); await h.handlers.idle(); const first = h.storage.get(h.id).concepts[0];
  const replay = await h.request('same'); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  assert.equal((await h.call('concepts', { clientEventId: 'same', intent: true, sourceTurnId: 'other' })).status, 409);
  await h.call('pause', { paused: true }); assert.equal((await h.request('paused', `/${first.id}/regenerate`)).status, 403);
  assert.equal((await h.call(`concepts/${first.id}/image`)).status, 200); assert.equal(h.records.length, 1);
});
test('images and provenance restore after process restart; lost host consent fails closed until renewed', async t => {
  const path = await temporaryDb(), h = await setup(t, { path }); await h.turn('first'); const item = await rendered(h);
  const bytes = h.storage.conceptArtifact(h.id, item.id).bytes;
  await h.handlers.close(); h.storage.close();
  // The original fixture's cleanup is replaced after this explicit restart.
  h.storage.close = () => {};
  const storage = new SQLiteStorage(path), images = createLocalImages(), reasoning = createMockReasoning(), consent = createMemoryConsentLedger(), presets = mockPresets();
  presets.best.plugins.push('fake-images'); presets.best.bindings.images = localImageBinding;
  const runtime = createPluginRuntime({ storage, reasoning, registry: new PluginRegistry().register(reasoning).register(images), presets, consent });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, reasoning, consent }); t.after(async () => { await handlers.close(); storage.close(); }); await handlers.resume();
  const imageRequest = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.id}/concepts/${item.id}/image`));
  assert.equal((await imageRequest()).status, 403);
  const grant = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.id}/consent`, { method: 'POST', body: '{"granted":true}' })); assert.equal(grant.status, 200);
  assert.deepEqual(new Uint8Array(await (await imageRequest()).arrayBuffer()), bytes);
  assert.deepEqual(storage.get(h.id).concepts[0].provenance, item.provenance);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE lane='concept'").get().n, 1);
});
test('withdrawal invalidates dependent pending renders and bytes, keeps unrelated history, and never resurrects on replay', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = await setup(t, { intercept: async (spec, feedback, options, images) => {
    const artifact = await images.generate(spec, feedback, options);
    if (h.records.length === 2) { started(); await held; } return artifact;
  } });
  await h.turn('first'); const first = await rendered(h); await h.turn('later'); h.readiness();
  await h.request('pending', `/${first.id}/regenerate`); await began;
  const withdrawal = await h.call('withdraw', { turnId: 'later' }); assert.equal(withdrawal.status, 200);
  assert.equal(h.storage.get(h.id).concepts.length, 1); assert.equal(h.storage.get(h.id).concepts[0].id, first.id);
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null, 'removed intent source is cleared');
  release(); await h.handlers.idle(); assert.equal(h.storage.get(h.id).concepts.length, 1);
  await h.call('withdraw', { turnId: 'first' });
  assert.equal(h.storage.conceptArtifact(h.id, first.id).erased, true);
  assert.ok(h.storage.read(h.id).filter(e => e.type === 'concept.state' && e.data.artifact).every(e => e.data.artifact.erased));
  assert.equal((await h.call(`concepts/${first.id}/image`)).status, 404);
});
test('unrelated removal while a slow image runs preserves its intent and keeps the render as history', async t => {
  let release, started; const began = new Promise(r => { started = r; }), held = new Promise(r => { release = r; }); t.after(() => release());
  const h = await setup(t, { intercept: async (...args) => { const images = args.pop(), artifact = await images.generate(...args); started(); await held; return artifact; } });
  await h.turn('first'); h.readiness(); await h.request('wish'); await began;
  // New ordinary inputs are not part of the frozen render dependencies.
  h.storage.postTurn(h.id, 'later', Buffer.from('later'), 'Unrelated later detail');
  const response = await h.call('withdraw', { turnId: 'later' }); assert.equal(response.status, 200);
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent.id, 'wish');
  release(); await h.handlers.idle(); assert.equal(h.storage.get(h.id).concepts.length, 1);
  assert.equal(h.storage.get(h.id).concepts[0].disposition, 'history');
});
test('consent withdrawal cancels an unresponsive dispatched image and settles its claim before acknowledgement', async t => {
  let started, release; const began = new Promise(r => { started = r; }), held = new Promise(r => { release = r; }); t.after(() => release());
  const h = await setup(t, { intercept: async (spec, feedback, options) => {
    const invocation = await beginInvocation(options); invocation.dispatch(); started();
    try { await held; return null; } finally { await invocation.finish(false); }
  } });
  await h.turn('first'); h.readiness(); await h.request('wish'); await began;
  const response = await h.call('consent', { granted: false }); assert.equal(response.status, 200);
  const rows = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='concept'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'settled'); assert.equal(rows[0].outcome, 'uncertain');
  assert.equal(h.storage.get(h.id).concepts.length, 0); release(); await tick();
  assert.equal(h.storage.get(h.id).concepts.length, 0); assert.equal((await h.request('denied')).status, 403);
});
test('upload reference port supplies private bytes; removal aborts dependent work with namespaced identity', async t => {
  let extras = [], release, started; const began = new Promise(r => { started = r; }), held = new Promise(r => { release = r; }); t.after(() => release());
  const h = await setup(t, { references: () => extras, intercept: async (spec, feedback, options, images) => {
    const artifact = await images.generate(spec, feedback, options); if (h.records.length === 2) { started(); await held; } return artifact;
  } });
  await h.turn('same'); const first = await rendered(h), artifact = h.storage.conceptArtifact(h.id, first.id);
  extras = [{ id: 'same', bytes: artifact.bytes, mediaType: artifact.mediaType, role: 'upload' }];
  await h.request('with-upload', `/${first.id}/regenerate`); await began;
  assert.equal(h.records[1].spec.references.at(-1).role, 'upload'); extras = [];
  await h.handlers.removeConceptReference(h.id, 'same'); release(); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).concepts.length, 1); assert.equal(h.storage.get(h.id).conceptIntent.visualIntent.id, 'with-upload');
  assert.equal(h.storage.get(h.id).transcript.find(t => t.id === 'same').erased, undefined);
});
test('full erasure removes bytes, guidance and pending artifacts while retaining only metadata', async t => {
  const h = await setup(t); await h.turn('first'); const item = await rendered(h);
  await h.call(`concepts/${item.id}/feedback`, { clientEventId: 'feedback', vote: 'down', chips: ['private guidance'] });
  await h.call('erase', {}); assert.equal(h.storage.get(h.id).concepts.length, 0);
  assert.ok(h.storage.db.prepare('SELECT bytes,tombstone FROM concept_artifacts').all().every(row => row.bytes === null && row.tombstone));
  assert.ok(h.storage.db.prepare('SELECT bytes,tombstone FROM content').all().every(row => row.bytes === null && row.tombstone));
  assert.equal((await h.call(`concepts/${item.id}/image`)).status, 404);
});
test('private image cost binding rejects missing or underfunded ceilings; deterministic fake is a decodable PNG', async t => {
  assert.throws(() => createImageBinding({ ...localImageBinding, imageCost: undefined }), /image cost/);
  assert.throws(() => createImageBinding({ ...localImageBinding, imageCost: { ...localImageBinding.imageCost, inputMicro: 1 } }), /image cost/);
  const h = await setup(t); await h.turn('first'); const item = await rendered(h), bytes = Buffer.from(h.storage.conceptArtifact(h.id, item.id).bytes);
  const idat = []; for (let offset = 8; offset < bytes.length;) { const size = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  assert.equal(inflateSync(Buffer.concat(idat)).length, (480 * 3 + 1) * 320);
  assert.equal(item.provenance.generator.provider, 'local-demo-fake');
});

function paidBinding() {
  const common = { ...localImageBinding, maxMicro: 400300 };
  return { ...common, imageCost: { inputMicro: 2, outputMicro: 3, maxInputTokens: 200000, maxOutputTokens: 100 },
    legal: { approved: true, countries: ['FR'], training: false, retention: 'host fixture', purpose: 'requirements',
      recipient: 'fixture', processors: ['fixture'], dataCategories: ['conversation', 'images'], consentVersion: 'v1',
      evidence: { qualified: true, accountRef: common.accountRef, secretRef: common.secretRef, model: common.model,
        endpoint: common.endpoint, routing: {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 } } };
}
const exactConsent = { grant() {}, coverage({ scope, consentRevision }) {
  return { covered: true, ...scope, scope, checkedAt: Date.now(), consentRevision, expiresAt: Date.now() + 60000 };
} };
test('image usage settles through the ledger with private image rates, and feature output exposes only the cost ceiling', async t => {
  const h = await setup(t, { imageBinding: paidBinding(), consent: exactConsent }); await h.turn('first'); await rendered(h);
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='concept'").get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'completed'); assert.equal(row.max_micro, 400300); assert.equal(row.settled_micro, 5);
  const snapshot = await (await h.call()).json(); assert.deepEqual(snapshot.conceptCost, { maxMicro: 400300 });
  assert.equal(JSON.stringify(snapshot).includes('inputMicro'), false); assert.equal(JSON.stringify(snapshot).includes('secretRef'), false);
});
test('the image budget denies underfunded work before claim consumption or private byte dispatch', async t => {
  const h = await setup(t, { imageBinding: paidBinding(), consent: exactConsent, budgetOptions: { sessionCapMicro: 400299 } });
  await h.turn('first'); h.readiness(); assert.equal((await h.request()).status, 403);
  assert.equal(h.records.length, 0); assert.equal(h.storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE lane='concept'").get().n, 0);
});
test('unknown paid image usage retains the maximum, and coverage revoked before publication discards late bytes', async t => {
  let started, release; const began = new Promise(r => { started = r; }), held = new Promise(r => { release = r; }); t.after(() => release());
  const h = await setup(t, { imageBinding: paidBinding(), consent: exactConsent, intercept: async (spec, feedback, options) => {
    const invocation = await beginInvocation(options); invocation.dispatch(); started(); try { await held; return null; } finally { await invocation.finish(false); }
  } });
  await h.turn('first'); h.readiness(); await h.request(); await began;
  await h.call('consent', { granted: false });
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='concept'").get();
  assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, 400300); release(); await tick(); assert.equal(h.storage.get(h.id).concepts.length, 0);
});
test('current host coverage is checked again after a successful image before durable publication', async t => {
  let covered = true;
  const consent = { grant() {}, coverage(args) { return covered ? exactConsent.coverage(args) : { covered: false }; } };
  const h = await setup(t, { imageBinding: paidBinding(), consent, intercept: async (spec, feedback, options, images) => {
    const artifact = await images.generate(spec, feedback, options); covered = false; return artifact;
  } });
  await h.turn('first'); h.readiness(); await h.request(); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).concepts.length, 0); assert.equal(h.storage.get(h.id).conceptStatus.phase, 'failed');
  assert.equal(h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='concept'").get().settled_micro, 5);
});

test('ZIP export carries saved images and provenance; expiry removes dependent images and guidance before the next export', async t => {
  const h = await setup(t); await h.turn('first'); const item = await rendered(h);
  await h.call(`concepts/${item.id}/feedback`, { clientEventId: 'guidance', vote: 'up', chips: ['private export guidance'] });
  const exported = await h.call('export'); assert.equal(exported.status, 200);
  const files = unzip(new Uint8Array(await exported.arrayBuffer()));
  assert.ok(files[`concepts/${item.id}.png`]); assert.equal(JSON.parse(files[`concepts/${item.id}.provenance.json`]).subject.contentDigest, item.provenance.subject.contentDigest);
  assert.equal(JSON.parse(files['concepts.json'])[0].feedback.chips[0], 'private export guidance');
  await h.handlers.expire(Date.now() + 1000); await h.handlers.idle();
  const after = unzip(new Uint8Array(await (await h.call('export')).arrayBuffer()));
  assert.ok(Object.keys(after).every(name => !name.startsWith('concept'))); assert.ok(Object.values(after).every(value => !value.includes('private export guidance')));
  assert.equal(h.storage.conceptArtifact(h.id, item.id).erased, true);
});
test('refinements use exact edit processing scope for admission, claim consumption and publication', async t => {
  const scopes = [], consent = { grant() {}, coverage(args) { scopes.push(args.scope.operation); return exactConsent.coverage(args); } };
  const h = await setup(t, { imageBinding: paidBinding(), consent }); await h.turn('first'); const first = await rendered(h);
  scopes.length = 0; await h.request('edit', `/${first.id}/regenerate`); await h.handlers.idle();
  assert.equal(h.records.length, 2); assert.equal(h.records[1].options.operation, 'edit');
  assert.ok(scopes.filter(operation => operation === 'edit').length >= 3);
});
test('startup conservatively recovers a dispatched image hold and marks its pending intent failed without dispatch', async t => {
  const h = await setup(t); await h.turn('first'); h.readiness();
  await h.request('wish'); await h.handlers.idle(); const current = h.storage.get(h.id);
  const pending = { ...current.conceptIntent.lastAttempt, id: 'interrupted' };
  h.storage.append(h.id, 'concept.state', { intent: { ...current.conceptIntent, pending }, status: { phase: 'pending', requestId: 'interrupted' } });
  const admitted = h.runtime.budget.admit({ sessionId: h.id, lane: 'concept', maxMicro: 100, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  h.runtime.budget.claim(admitted.attemptId).consume();
  await h.handlers.resume(); await h.handlers.idle();
  assert.equal(h.runtime.budget.get(admitted.attemptId).outcome, 'uncertain'); assert.equal(h.runtime.budget.get(admitted.attemptId).settled_micro, 100);
  assert.equal(h.storage.get(h.id).conceptStatus.error, 'restart'); assert.equal(h.storage.get(h.id).conceptIntent.pending, null);
  assert.equal(h.records.length, 1);
});

const conceptAttempts = h => h.storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE lane='concept'").get().n;
for (const end of ['voice-close', 'erase', 'expiry', 'page-hidden']) test(`${end} records durable ineligibility and cannot spend after idleMs`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const h = await setup(t, { voice: end === 'voice-close' });
  let grant;
  if (end === 'voice-close') { const start = await h.call('voice', { callId: 'call' }); assert.equal(start.status, 201); grant = await start.json(); }
  await h.turn('first'); h.readiness(25); await h.request('wish'); await h.handlers.idle();
  await h.turn('later'); h.readiness(25);
  const before = conceptAttempts(h);
  if (end === 'voice-close') assert.equal((await h.call(`voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId })).status, 200);
  else if (end === 'erase') assert.equal((await h.call('erase', {})).status, 200);
  else if (end === 'expiry') await h.handlers.expire(Date.now() + 1);
  else assert.equal((await h.call('concepts/eligibility', { eligible: false })).status, 200);
  await h.handlers.idle();
  // Keep this assertion first: the old server timer must fail on actual spending.
  t.mock.timers.tick(121000); await h.handlers.idle();
  assert.equal(conceptAttempts(h), before);
  assert.equal(h.storage.get(h.id).conceptIntent.eligible, false);
  const durable = JSON.parse(h.storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(h.id).snapshot);
  assert.equal(durable.conceptIntent.eligible, false);
});
test('assistant voice events and resume cannot revive intent cleared by consent', async t => {
  const h = await setup(t, { voice: true, understanding: raw => ({ ...raw, conceptIntent: { request_quote: 'I would like a visual concept' } }) });
  let response = await h.call('voice', { callId: 'before' }), grant = await response.json(); assert.equal(response.status, 201);
  const event = async (role, text, turnId) => {
    const response = await h.call(`voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:${turnId}`, role, text } }); assert.equal(response.status, 200); await h.handlers.idle();
  };
  await event('user', 'I would like a visual concept', 'wish');
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent?.sourceTurnId, `${grant.providerSessionId}:wish`);
  await h.call('consent', { granted: false }); await h.call('consent', { granted: true }); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
  response = await h.call('voice', { callId: 'after' }); grant = await response.json(); assert.equal(response.status, 201);
  await event('assistant', 'I can help you explain the project.', 'reply');
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
  await h.call(`voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  await h.call(`voice/${grant.callId}/resume`, { providerSessionId: grant.providerSessionId }); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
});
test('skipped planning reads no reference bytes and elapsed time scans no sessions', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  let byteReads = 0, extras = [];
  const h = await setup(t, { references: () => extras }); await h.turn('first'); const first = await rendered(h);
  const artifact = h.storage.conceptArtifact(h.id, first.id);
  extras = [{ id: 'upload', role: 'upload', mediaType: artifact.mediaType, get bytes() { byteReads++; return artifact.bytes; } }];
  h.readiness(0);
  const read = t.mock.method(h.storage, 'conceptArtifact');
  await h.handlers.conceptLane.run(h.id); assert.equal(read.mock.callCount(), 0); assert.equal(byteReads, 0);
  const get = t.mock.method(h.storage, 'get'), list = t.mock.method(h.storage, 'list');
  t.mock.timers.tick(121000); await tick(); await h.handlers.idle();
  assert.equal(list.mock.callCount(), 0); assert.equal(get.mock.callCount(), 0);
  h.readiness(); await h.request('again'); await h.handlers.idle(); assert.equal(h.records.length, 2); assert.equal(byteReads, 1);
});
test('export retains transcript and understanding when image publication is unavailable', async t => {
  const h = await setup(t); await h.turn('first'); const first = await rendered(h);
  await h.call(`concepts/${first.id}/feedback`, { clientEventId: 'feedback', vote: 'up', chips: ['private image guidance'] });
  for (const unavailable of ['off', 'plugin', 'consent']) {
    const binding = h.presets.best.bindings.images;
    let plugin;
    if (unavailable === 'off') delete h.presets.best.bindings.images;
    else if (unavailable === 'plugin') plugin = t.mock.method(h.registry, 'get', id => id === binding.plugin ? undefined : h.images);
    else await h.consent.withdraw({ sessionId: h.id });
    const artifact = t.mock.method(h.storage, 'conceptArtifact');
    const response = await h.call('export'); assert.equal(response.status, 200, unavailable);
    const files = unzip(new Uint8Array(await response.arrayBuffer()));
    assert.ok(files['transcript.json'].includes('public API')); assert.ok(files['understanding.json']);
    assert.equal(JSON.parse(files['concepts.json'])[0].id, first.id);
    assert.ok(Object.keys(files).every(name => !name.startsWith('concepts/')));
    assert.equal(files['concepts.json'].includes('private image guidance'), false); assert.equal(artifact.mock.callCount(), 0);
    h.presets.best.bindings.images = binding; plugin?.mock.restore(); artifact.mock.restore();
  }
});
test('a fresh Request control after a concept renders immediately without new person turns', async t => {
  const h = await setup(t); await h.turn('first'); await rendered(h);
  assert.equal((await h.request('second-request')).status, 202); await h.handlers.idle();
  assert.equal(h.records.length, 2); assert.equal(h.storage.get(h.id).conceptIntent.lastAttempt.trigger, 'manual');
});
test('references prefer latest liked base and exactly one archived rejection', async t => {
  const h = await setup(t); await h.turn('first'); const first = await rendered(h);
  const feedback = (id, vote, clientEventId) => h.call(`concepts/${id}/feedback`, { clientEventId, vote });
  await feedback(first.id, 'up', 'liked');
  await h.request('second', `/${first.id}/regenerate`); await h.handlers.idle(); const second = h.storage.get(h.id).concepts.at(-1);
  await feedback(second.id, 'down', 'disliked');
  await h.request('third', `/${second.id}/regenerate`); await h.handlers.idle(); const third = h.storage.get(h.id).concepts.at(-1);
  assert.deepEqual(h.records[2].spec.references.map(r => r.role), ['previous']);
  assert.deepEqual(h.records[2].spec.references[0].bytes, h.storage.conceptArtifact(h.id, first.id).bytes);
  for (const [item, eventId] of [[second, 'reject-second'], [third, 'reject-third']]) await h.call(`concepts/${item.id}/reject`, { clientEventId: eventId });
  await h.request('fourth', `/${first.id}/regenerate`); await h.handlers.idle();
  assert.deepEqual(h.records[3].spec.references.map(r => r.role), ['previous', 'rejected']);
  assert.deepEqual(h.records[3].spec.references[1].bytes, h.storage.conceptArtifact(h.id, third.id).bytes);
});
