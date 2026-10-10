import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PluginError, PluginRegistry, createMockReasoning, inputRevision, reduceUnderstanding, verifyHTMLArtifact, HTML_PREVIEW_CSP, syncConceptIntent, reduceConceptIntent } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets, createMemoryConsentLedger,
  createLocalHTML, localHTMLBinding, createLocalImages, localImageBinding, createUIRenderLimiter, uiRenderLimitConfig } from '../src/index.js';
import { ownedRequest, temporaryDb, unzip } from '../../../test/helpers.js';

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
async function setup(t, { intercept, uiRenderLimits, both = false, path = ':memory:', consent = createMemoryConsentLedger(), understanding, htmlBinding = localHTMLBinding } = {}) {
  const storage = new SQLiteStorage(path), reasoning = createMockReasoning(), html = createLocalHTML(), presets = mockPresets();
  presets.best.plugins.push('fake-html'); presets.best.bindings.html = htmlBinding;
  presets.best.policy = { endpoints: [htmlBinding.endpoint] };
  const registry = new PluginRegistry().register(reasoning).register(htmlBinding === localHTMLBinding ? html : { ...html, binding: htmlBinding });
  if (both) { registry.register(createLocalImages({ delayMs: 1 })); presets.best.plugins.push('fake-images'); presets.best.bindings.images = localImageBinding; }
  const runtime = createPluginRuntime({ storage, registry, reasoning, presets, consent, uiRenderLimits });
  const records = [], admit = runtime.admit;
  runtime.admit = async function(args) {
    const admitted = await admit.call(this, args);
    if (args.lane === 'understanding' && understanding) return { ...admitted, plugin: { ...admitted.plugin,
      async structured(...args) { return understanding(await reasoning.structured(...args)); } } };
    if (args.lane !== 'concept' || args.options.visualKind !== 'html') return admitted;
    const render = (operation, previous, spec, feedback, options) => {
      records.push({ operation, previous, spec, feedback });
      const work = () => previous ? html.edit(previous, spec, feedback, options) : html.generate(spec, feedback, options);
      return intercept ? intercept({ operation, previous, spec, feedback, options, work }) : work();
    };
    return { ...admitted, plugin: { ...admitted.plugin,
      generate: (spec, feedback, options) => render('generate', undefined, spec, feedback, options),
      edit: (previous, spec, feedback, options) => render('edit', previous, spec, feedback, options) } };
  };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent });
  t.after(async () => { await handlers.close(); storage.close(); });
  const created = await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{"locale":"de"}' }));
  const { id } = await created.json();
  const call = (route = '', body, token = 'test-visitor') => handlers.handle(new Request(`http://localhost/api/sessions/${id}${route ? '/' + route : ''}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  await call('consent', { granted: true });
  async function turn(turnId, content = 'Wir brauchen eine Übersicht für unsere Reparaturen.') {
    assert.equal((await call('turns', { clientEventId: turnId, content })).status, 200); await handlers.idle();
  }
  function readiness(percent = 72, summary = 'Reparaturen <script>literal</script> & Details') {
    const session = storage.get(id), evidence = session.transcript.find(t => t.role === 'user' && !t.erased).content;
    const u = reduceUnderstanding(session.understanding, { summary, constraints: Object.fromEntries(session.preset.requiredSlots.map(s => [s, { value: 'Reparaturen', evidence }])),
      openQuestions: ['Wer gibt eine Reparatur frei?'], signals: [], progress: {
        talk: { value: percent < session.preset.talkMarker ? (percent + 1) / session.preset.talkMarker * session.preset.talkThreshold : session.preset.talkThreshold },
        build: { value: Math.max(0, (percent + 1 - session.preset.talkMarker) / (100 - session.preset.talkMarker)) } } },
    { transcript: session.transcript, inputRevision: inputRevision(session), preset: session.preset, locale: session.locale });
    storage.append(id, 'understanding.updated', u);
  }
  const request = (eventId = crypto.randomUUID(), artifactId) => call(`concepts${artifactId ? '/' + artifactId + '/regenerate' : ''}`, {
    clientEventId: eventId, intent: true, sourceTurnId: storage.get(id).transcript.filter(t => t.role === 'user' && !t.erased && !t.withdrawn).at(-1).id });
  async function render() {
    readiness(); assert.equal((await request()).status, 202); await handlers.idle();
    assert.equal(storage.get(id).conceptStatus.phase, 'ready', JSON.stringify(storage.get(id).conceptStatus));
    return storage.get(id).concepts.at(-1);
  }
  return { storage, handlers, runtime, records, presets, consent, id, call, turn, readiness, request, render };
}

test('HTML opt-in waits for a milestone; a new milestone uses edit with understanding, words, language and feedback', async t => {
  const h = await setup(t, { both: true }); await h.turn('first'); h.readiness();
  await h.handlers.conceptLane.run(h.id); assert.equal(h.records.length, 0);
  h.readiness(0); await h.request('wish'); await h.handlers.idle(); assert.equal(h.records.length, 0);
  h.readiness(25); await h.handlers.conceptLane.run(h.id); assert.equal(h.records.length, 1);
  const first = h.storage.get(h.id).concepts[0]; assert.equal(first.mediaType, 'text/html'); assert.equal(first.operation, 'generate');
  const generated = h.records[0]; assert.equal(generated.spec.language, 'de'); assert.equal(generated.spec.visitorWords.length, 1);
  assert.equal(generated.spec.understanding.slots.operations, 'Reparaturen'); assert.deepEqual(generated.spec.understanding.openQuestions, ['Wer gibt eine Reparatur frei?']);
  await h.call(`concepts/${first.id}/feedback`, { clientEventId: 'feedback', vote: 'up', chips: ['Mehr Kontrast'] });
  await h.turn('second', 'Auch offene Aufgaben sollen erscheinen.'); h.readiness(40);
  await h.handlers.conceptLane.run(h.id); await h.handlers.idle();
  assert.equal(h.records.length, 2); assert.equal(h.records[1].operation, 'edit'); assert.match(h.records[1].feedback, /Mehr Kontrast/);
  assert.deepEqual(h.records[1].previous.bytes, h.storage.conceptArtifact(h.id, first.id).bytes);
  const second = h.storage.get(h.id).concepts.at(-1); assert.equal(second.provenance.origin, 'ai-manipulated'); assert.equal(second.operation, 'edit');
  assert.match(new TextDecoder().decode(h.storage.conceptArtifact(h.id, second.id).bytes), /Revision 2/);
  await h.handlers.conceptLane.run(h.id); assert.equal(h.records.length, 2);
  assert.equal(h.runtime.visualKind(h.storage.get(h.id)), 'html');
});

test('HTML supports exact-full-message model opt-in and rejects a partial quote', async t => {
  let quote = 'Bitte zeigen Sie mir einen Entwurf.';
  const h = await setup(t, { understanding: raw => ({ ...raw, conceptIntent: { request_quote: quote } }) });
  await h.turn('wish', quote); h.readiness(25); await h.handlers.conceptLane.run(h.id);
  assert.equal(h.records.length, 1); assert.equal(h.storage.get(h.id).conceptIntent.visualIntent.sourceTurnId, 'wish');
  await h.call('consent', { granted: false }); await h.call('consent', { granted: true });
  quote = 'zeigen Sie'; await h.turn('partial', 'Bitte zeigen Sie einen anderen Entwurf.'); h.readiness();
  await h.handlers.conceptLane.run(h.id); assert.equal(h.records.length, 1); assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
});

test('HTML is owner-only uncached data, including download queries; image route cannot serve HTML', async t => {
  const h = await setup(t); await h.turn('first'); const item = await h.render();
  for (const suffix of ['', '?download=1']) {
    const response = await h.call(`concepts/${item.id}/html${suffix}`); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('vary'), /Cookie/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
    const artifact = { bytes, mediaType: item.mediaType, promptDigest: item.promptDigest, provenance: item.provenance };
    assert.equal(await verifyHTMLArtifact(artifact), true); assert.doesNotMatch(new TextDecoder().decode(bytes), /<script>literal<\/script>/);
  }
  for (const token of ['', 'other-owner']) for (const route of ['concepts', `concepts/${item.id}/html`, `concepts/${item.id}/provenance`, 'export']) {
    assert.equal((await h.call(route, undefined, token)).status, 404);
  }
  assert.equal((await h.call(`concepts/${item.id}/image`)).status, 404);
  const list = await (await h.call('concepts')).json(); assert.equal(list.visualKind, 'html'); assert.equal(list.items[0].mediaType, 'text/html');
  assert.equal(list.items[0].bytes, undefined); assert.equal(h.records.length, 1);
});

test('HTML export prepends the preview CSP and disables standalone scripts before untrusted content', async t => {
  const h = await setup(t); await h.turn('first'); const item = await h.render();
  const files = unzip(new Uint8Array(await (await h.call('export')).arrayBuffer()));
  const html = files[`concepts/${item.id}.html`]; assert.ok(html.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"`));
  assert.ok(Buffer.from(html).subarray(0, 1024).includes(Buffer.from('<meta charset="utf-8">')));
  assert.ok(html.indexOf('content="script-src \'none\'"') < html.indexOf('<html'));
  assert.equal(JSON.parse(files[`concepts/${item.id}.provenance.json`]).subject.contentDigest, item.provenance.subject.contentDigest);
  assert.deepEqual(JSON.parse(files['concepts-manifest.json']), { version: 1,
    included: [{ id: item.id, path: `concepts/${item.id}.html` }], withheld: [] });
  const manifest = JSON.parse(files['manifest.json']), exportedPath = `concepts/${item.id}.html`;
  const entry = manifest.files.find(file => file.path === exportedPath);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(entry.sha256, sha256(Buffer.from(html)));
  assert.equal(entry.originalSha256, sha256(h.storage.conceptArtifact(h.id, item.id).bytes));
  assert.notEqual(entry.sha256, entry.originalSha256);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), Object.keys(files).filter(path => path !== 'manifest.json').sort());
  for (const file of manifest.files) assert.equal(file.sha256, sha256(Buffer.from(files[file.path])), file.path);
});

for (const action of ['withdraw', 'consent', 'erase']) test(`${action} removes HTML bytes and feedback; replay and export cannot resurrect them`, async t => {
  const h = await setup(t); await h.turn('first'); const item = await h.render();
  await h.call(`concepts/${item.id}/feedback`, { clientEventId: 'feedback', vote: 'up', chips: ['private HTML guidance'] });
  const body = action === 'withdraw' ? { turnId: 'first' } : action === 'consent' ? { granted: false } : {};
  assert.equal((await h.call(action, body)).status, 200);
  assert.equal(h.storage.conceptArtifact(h.id, item.id).erased, true);
  const row = h.storage.db.prepare('SELECT bytes,tombstone FROM concept_artifacts WHERE id=?').get(item.id); assert.equal(row.bytes, null); assert.ok(row.tombstone);
  assert.ok(h.storage.read(h.id).filter(e => e.data.artifact).every(e => e.data.artifact.erased));
  assert.equal((await h.call(`concepts/${item.id}/html`)).status, 404);
  assert.ok(h.storage.db.prepare("SELECT bytes FROM content WHERE kind='concept-feedback'").all().every(r => r.bytes === null));
  if (action !== 'erase') {
    const files = unzip(new Uint8Array(await (await h.call('export')).arrayBuffer()));
    assert.ok(Object.keys(files).every(name => !name.startsWith('concepts/')));
    assert.deepEqual(JSON.parse(files['concepts-manifest.json']).withheld, [{ id: item.id, reason: 'erased' }]);
    const manifest = JSON.parse(files['manifest.json']);
    assert.deepEqual(manifest.withheld, JSON.parse(files['concepts-manifest.json']).withheld);
    assert.ok(manifest.erased.some(entry => entry.kind === 'concept' && entry.id === item.id));
    assert.ok(manifest.files.every(file => !file.path.startsWith('concepts/')));
  }
});

test('long HTML conversations retain the newest 24k visitor characters and still generate and edit', async t => {
  const h = await setup(t); await h.turn('first');
  const older = 'old requirements '.repeat(5000), recent = 'recent requirements '.repeat(500), latest = 'Show the latest open repairs.';
  h.storage.postTurn(h.id, 'older', Buffer.from(older), older);
  h.storage.postTurn(h.id, 'recent', Buffer.from(recent), recent);
  h.storage.postTurn(h.id, 'latest', Buffer.from(latest), latest);
  const first = await h.render(), spec = h.records[0].spec;
  assert.deepEqual(spec.visitorWords, [latest, recent, older.slice(-(24000 - latest.length - recent.length))]);
  assert.equal(spec.visitorWords.join('').length, 24000);
  const oversized = 'single very long message '.repeat(3000);
  h.storage.postTurn(h.id, 'oversized', Buffer.from(oversized), oversized);
  h.readiness(); await h.request('edit-long', first.id); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).conceptStatus.phase, 'ready');
  assert.equal(h.records.at(-1).operation, 'edit');
  assert.deepEqual(h.records.at(-1).spec.visitorWords, [oversized.slice(-24000)]);
});

test('a slow HTML render keeps superseded paid history but source withdrawal discards dependent edits', async t => {
  let started, release;
  const began = new Promise(r => { started = r; }), held = new Promise(r => { release = r; }); t.after(() => release());
  let hold = true;
  const h = await setup(t, { intercept: async ({ work }) => { const artifact = await work(); if (hold) { started(); await held; } return artifact; } });
  await h.turn('first'); h.readiness(); await h.request('wish'); await began;
  h.storage.postTurn(h.id, 'later', Buffer.from('later'), 'Eine neue Anforderung.');
  hold = false; release(); await h.handlers.idle(); const first = h.storage.get(h.id).concepts[0]; assert.equal(first.disposition, 'history');
  await h.call('withdraw', { turnId: 'first' }); assert.equal(h.storage.conceptArtifact(h.id, first.id).erased, true);
  assert.equal(h.storage.get(h.id).conceptIntent.visualIntent, null);
});

test('withdrawing a previous dummy source aborts an unresponsive HTML edit and settles the claim', async t => {
  let release, started; const held = new Promise(r => { release = r; }), began = new Promise(r => { started = r; }); t.after(() => release());
  const h = await setup(t, { intercept: async ({ operation, work }) => { const artifact = await work(); if (operation === 'edit') { started(); await held; } return artifact; } });
  await h.turn('first'); const first = await h.render(); await h.turn('second'); h.readiness(); await h.request('edit', first.id); await began;
  await h.call('withdraw', { turnId: 'first' }); release(); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).concepts.length, 0); assert.equal(h.storage.conceptArtifact(h.id, first.id).erased, true);
  assert.ok(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='concept'").all().every(r => r.state === 'settled'));
});

test('all visual kinds share the session limit; limited sessions can still read/export saved HTML', async t => {
  const h = await setup(t, { both: true, uiRenderLimits: { perSession: 1, perDay: 20 } }); await h.turn('first'); const item = await h.render();
  const denied = await h.request('denied', item.id); assert.equal(denied.status, 429); assert.match((await denied.json()).reason, /this session/);
  assert.equal((await h.call(`concepts/${item.id}/html`)).status, 200); assert.equal((await h.call('export')).status, 200);
  assert.equal((await h.runtime.matrix(h.storage.get(h.id))).best.images.available, false);
  h.presets.best.bindings.visuals = 'images'; assert.equal((await h.request('image')).status, 429); assert.equal(h.records.length, 1);
});

test('render counters persist across restart and erasure; daily limits are global, atomic and roll over at UTC midnight', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  const first = storage.create(), second = storage.create(); let now = Date.parse('2026-10-10T23:59:59Z');
  const limiter = () => createUIRenderLimiter({ storage, perSession: 2, perDay: 1, now: () => now });
  limiter().consume('one', first.id, () => {});
  assert.match(limiter().reason(second.id), /UTC day/); assert.throws(() => limiter().consume('two', second.id, () => assert.fail('denied dispatch')), { code: 'rate-limit' });
  storage.erase(first.id); storage.close(); storage = new SQLiteStorage(path);
  assert.match(limiter().reason(second.id), /UTC day/);
  now += 1000; assert.equal(limiter().reason(second.id), null); limiter().consume('two', second.id, () => {});
  now += 86400000; limiter().consume('three', second.id, () => {}); assert.match(limiter().reason(second.id), /this session/);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM ui_render_claims').get().n, 3);
});

test('parallel session renders atomically share the daily gate and persist a clear failed status without dispatch', async t => {
  const h = await setup(t, { uiRenderLimits: { perSession: 20, perDay: 1 } });
  const ids = [h.id, h.storage.create().id];
  for (const id of ids) {
    const session = h.storage.get(id);
    if (session.consentRevision === 0) {
      h.consent.grant({ sessionId: id, consentRevision: 1 }); h.storage.reviseConsent(id, true);
    }
    h.storage.postTurn(id, 'needs', Buffer.from(id), 'Eine Reparaturübersicht.');
    const current = h.storage.get(id);
    h.storage.append(id, 'understanding.updated', reduceUnderstanding(current.understanding, { summary: 'Reparaturen',
      constraints: {}, openQuestions: [], progress: { talk: { value: .75 }, build: { value: 0 } } },
    { transcript: current.transcript, inputRevision: inputRevision(current), preset: current.preset }));
    let intent = syncConceptIntent(h.storage.get(id));
    intent = reduceConceptIntent(intent, { type: 'intent-recorded', id: 'wish', sourceTurnId: 'needs', now: Date.now() });
    h.storage.append(id, 'concept.state', { intent, status: { phase: 'waiting' } });
  }
  // Both runs are selected before either admission/claim is consumed.
  const results = await Promise.all(ids.map(id => h.handlers.conceptLane.run(id)));
  assert.deepEqual([...results].sort(), ['completed', 'failed']);
  const denied = ids.map(id => h.storage.get(id)).find(s => s.conceptStatus.phase === 'failed');
  assert.equal(denied.conceptStatus.error, 'rate-limit'); assert.match(denied.conceptStatus.reason, /UTC day/);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM ui_render_claims').get().n, 1);
  assert.equal(ids.map(id => h.storage.get(id).concepts.length).reduce((a, b) => a + b), 1);
});

test('render settings accept zero as off and reject partial, negative and unsafe integers', () => {
  assert.deepEqual(uiRenderLimitConfig(), { perSession: 20, perDay: 200 });
  assert.equal(uiRenderLimitConfig({ AITHEMA_UI_RENDERS_PER_SESSION: '0' }).perSession, 0);
  for (const value of ['-1', '1.5', '2tail', '9007199254740992']) assert.throws(() => uiRenderLimitConfig({ AITHEMA_UI_RENDERS_PER_DAY: value }), TypeError);
});

test('HTML reads and requests fail closed when host consent is lost and exports omit unpublishable bytes', async t => {
  const h = await setup(t); await h.turn('first'); const item = await h.render(); await h.consent.withdraw({ sessionId: h.id });
  assert.equal((await h.call(`concepts/${item.id}/html`)).status, 403); assert.equal((await h.request('retry')).status, 403);
  const files = unzip(new Uint8Array(await (await h.call('export')).arrayBuffer())); assert.equal(files[`concepts/${item.id}.html`], undefined);
  assert.deepEqual(JSON.parse(files['concepts-manifest.json']), { version: 1,
    included: [], withheld: [{ id: item.id, reason: 'publication-not-allowed' }] });
  await h.call('consent', { granted: true }); assert.equal((await h.call(`concepts/${item.id}/html`)).status, 200);
});

test('HTML bytes and provenance restore after restart but the owner must renew lost host coverage', async t => {
  const path = await temporaryDb(), h = await setup(t, { path }); await h.turn('first'); const item = await h.render();
  const bytes = h.storage.conceptArtifact(h.id, item.id).bytes;
  await h.handlers.close(); h.storage.close(); h.storage.close = () => {};
  const storage = new SQLiteStorage(path), reasoning = createMockReasoning(), html = createLocalHTML(), presets = mockPresets();
  presets.best.plugins.push('fake-html'); presets.best.bindings.html = localHTMLBinding;
  const consent = createMemoryConsentLedger(), runtime = createPluginRuntime({ storage, reasoning, presets, consent,
    registry: new PluginRegistry().register(reasoning).register(html) });
  const handlers = createHandlers({ storage, reasoning, consent, pluginRuntime: runtime }); t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.resume();
  const url = `http://localhost/api/sessions/${h.id}`;
  assert.equal((await handlers.handle(ownedRequest(`${url}/concepts/${item.id}/html`))).status, 403);
  await handlers.handle(ownedRequest(`${url}/consent`, { method: 'POST', body: '{"granted":true}' }));
  const response = await handlers.handle(ownedRequest(`${url}/concepts/${item.id}/html`)); assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.deepEqual(storage.get(h.id).concepts[0].provenance, item.provenance);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM ui_render_claims').get().n, 1);
});

test('a separately qualified HTML scope needs its own current grant for generate/edit and publication', async t => {
  const base = { ...localHTMLBinding, maxMicro: 1000000, rates: { inputMicro: 1, outputMicro: 1, inputUSD: .000001, outputUSD: .000001 } };
  const binding = { ...base, legal: { approved: true, countries: ['FR'], training: false, retention: 'test fixture', purpose: 'fixture-html',
    recipient: 'fixture-html-processor', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: base.accountRef, secretRef: base.secretRef, model: base.model, endpoint: base.endpoint,
      routing: {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 } } };
  let covered = false, revokeAfterRender = false; const scopes = [];
  const consent = { grant() {}, coverage({ scope, consentRevision }) {
    scopes.push(scope);
    if (scope.purpose === 'fixture-html' && !covered) return { covered: false };
    return { covered: true, ...scope, scope, checkedAt: Date.now(), consentRevision, expiresAt: Date.now() + 60000 };
  } };
  const h = await setup(t, { htmlBinding: binding, consent, intercept: async ({ work }) => {
    const artifact = await work(); if (revokeAfterRender) covered = false; return artifact;
  } });
  await h.turn('first'); h.readiness(); assert.equal((await h.request('denied')).status, 403); assert.equal(h.records.length, 0);
  covered = true; const first = await h.render(); scopes.length = 0;
  await h.request('edit', first.id); await h.handlers.idle(); assert.equal(h.records.at(-1).operation, 'edit');
  assert.ok(scopes.filter(s => s.purpose === 'fixture-html' && s.operation === 'edit').length >= 3);
  revokeAfterRender = true; await h.request('revoked', first.id); await h.handlers.idle();
  assert.equal(h.storage.get(h.id).concepts.length, 2); assert.equal(h.storage.get(h.id).conceptStatus.phase, 'failed');
  assert.equal((await h.call(`concepts/${first.id}/html`)).status, 403);
});

test('a spend cap refusal during rendering persists its reason, so the viewer can say so (AIT-113 B2)', async t => {
  const h = await setup(t, { intercept: () => { throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted'); } });
  await h.turn('first'); h.readiness(); assert.equal((await h.request()).status, 202); await h.handlers.idle();
  assert.deepEqual(h.storage.get(h.id).conceptStatus, { ...h.storage.get(h.id).conceptStatus, phase: 'failed', reason: 'OpenRouter spend cap exhausted', retryable: true });
});

test('the local fake draft names its revision in the page language: "Fassung N" in German, "Revision N" in English (AIT-113 B2)', async () => {
  const html = createLocalHTML(), text = artifact => new TextDecoder().decode(artifact.bytes);
  const options = () => ({ deadlineAt: Date.now() + 5000, attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
  // The visible page, without the head comment that carries the revision number for the next edit.
  const visible = page => page.replace(/<!--[\s\S]*?-->/gu, '');
  const spec = language => ({ prompt: 'Click-dummy', language, understanding: { summary: 'Reparaturen' } });
  const first = await html.generate(spec('de'), '', options()), second = await html.edit(first, spec('de'), 'Mehr Kontrast', options());
  assert.match(visible(text(first)), /<p>Fassung 1<\/p>/u); assert.match(visible(text(second)), /<p>Fassung 2<\/p>/u);
  assert.doesNotMatch(visible(text(second)), /Revision/u, 'no English word on the German page');
  const english = await html.edit(await html.generate(spec('en'), '', options()), spec('en'), 'More contrast', options());
  assert.match(visible(text(english)), /<p>Revision 2<\/p>/u);
});
