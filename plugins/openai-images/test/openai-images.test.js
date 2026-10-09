import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createOpenAIImages, manifest } from '../src/index.js';
import { imageArtifact, imageInfo } from '../src/image-artifact.js';
import { PluginError, PluginRegistry, validateManifest, isUIArtifact, uiGenerationConformance, IPTC_DIGITAL_SOURCE } from '@inspr/aithema-core';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const spec = { prompt: 'A calm dispatch workspace', format: 'webp' }, feedback = 'Make the action button blue';
const artifact = () => imageArtifact(png, { prompt: spec.prompt, model: 'gpt-image-2', operation: 'generate', now: 0 });
function options(extra = {}) {
  const reports = []; let consumed = false;
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 2000, reports,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() { assert.equal(consumed, false); consumed = true; } },
    report: terminal => { reports.push(terminal); }, ...extra };
}
async function fake(t, { allowDownloads = false } = {}) {
  const records = [], requests = []; let respond = (_req, res) => res.end(JSON.stringify({
    data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 11, output_tokens: 23 } }));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), multipart = req.headers['content-type']?.startsWith('multipart/form-data');
    const body = req.method === 'POST' ? multipart ? Object.fromEntries(await new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes }).formData()) : JSON.parse(bytes) : null;
    const record = { path: req.url, headers: req.headers, body }; records.push(record);
    if (body?.prompt.includes('fixture-stall')) { res.writeHead(200); res.write('{'); return; }
    respond(record, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, baseUrl = `${origin}/v1`;
  const binding = { plugin: manifest.id, model: 'gpt-image-2', effort: 'none', endpoint: baseUrl,
    accountRef: 'fixture-account', secretRef: 'fixture-secret-ref', maxMicro: 1_000_000, maxTokens: 4096,
    rates: { inputMicro: 2, outputMicro: 3 }, routing: allowDownloads ? { imageOrigins: [origin] } : {} };
  const fetchImpl = (url, init) => { assert.equal(new URL(url).origin, origin, 'fixture must never call a provider'); requests.push({ url, init }); return fetch(url, init); };
  return { origin, baseUrl, binding, records, requests, fetchImpl,
    plugin: createOpenAIImages({ binding, baseUrl, resolveSecret: () => 'local-fixture', fetchImpl }),
    respond(fn) { respond = fn; } };
}
test('D4 manifest registers the exact image kind with no private or invented pricing data', async t => {
  const f = await fake(t); assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(new PluginRegistry().register(f.plugin).get(manifest.id).generate, f.plugin.generate);
  assert.equal(manifest.models[0].id, 'gpt-image-2'); assert.equal(manifest.models[0].cost.inputMicro, null);
  assert.equal(manifest.models[0].qualification, 'unverified'); assert.ok(Object.isFrozen(manifest.models[0]));
  assert.deepEqual(await f.plugin.health(options()), { available: true }); assert.equal(f.requests.length, 0);
});
test('generate sends Images JSON, returns real dimensions, bytes, digest and embedded IPTC provenance', async t => {
  const f = await fake(t), o = options(), result = await f.plugin.generate(spec, feedback, o);
  assert.equal(isUIArtifact(result), true); assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(result.mediaType, 'image/png'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.generated);
  assert.ok(Buffer.from(result.bytes).includes(Buffer.from('Iptc4xmpExt:DigitalSourceType')));
  assert.equal(result.provenance.subject.contentDigest, `sha-256=:${createHash('sha256').update(result.bytes).digest('base64')}:`);
  const record = f.records[0]; assert.equal(record.path, '/v1/images/generations');
  assert.equal(record.body.model, 'gpt-image-2'); assert.equal(record.body.output_format, 'webp');
  assert.equal(record.body.size, '1536x1024'); assert.equal(record.body.quality, 'high'); assert.equal(record.body.n, 1);
  assert.match(record.body.prompt, /Make the action button blue/u);
  assert.equal(result.promptDigest, `sha256:${createHash('sha256').update(record.body.prompt).digest('hex')}`);
  assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 11, outputTokens: 23 } }]);
  assert.equal(JSON.stringify(result).includes('local-fixture'), false); assert.equal('url' in result, false);
});
test('edit sends the private artifact as multipart bytes and marks manipulation', async t => {
  const f = await fake(t), source = artifact(), o = options(), result = await f.plugin.edit(source, feedback, o);
  assert.equal(f.records[0].path, '/v1/images/edits'); const body = f.records[0].body;
  assert.deepEqual(new Uint8Array(await body['image[]'].arrayBuffer()), source.bytes);
  assert.equal(body['image[]'].type, 'image/png'); assert.equal(body.model, 'gpt-image-2');
  assert.equal(body.n, '1'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.manipulated);
  assert.equal(o.reports.length, 1); assert.equal(o.reports[0].outcome, 'completed');
});
test('WebP dimensions and embedded XMP survive byte parsing', async t => {
  const f = await fake(t); f.respond((_req, res) => res.end(JSON.stringify({ data: [{ b64_json: webp.toString('base64') }] })));
  const o = options(), result = await f.plugin.generate(spec, '', o);
  assert.equal(result.mediaType, 'image/webp'); assert.deepEqual(imageInfo(result.bytes), {
    mediaType: 'image/webp', width: 1, height: 1, end: -1, extended: 12, alpha: false });
  assert.equal(isUIArtifact(result), true); assert.ok(Buffer.from(result.bytes).includes(Buffer.from('XMP ')));
  assert.equal(o.reports[0].outcome, 'uncertain', 'missing usage cannot imply a free image');
});
test('URL results are downloaded only on the server through the private origin allowlist', async t => {
  const f = await fake(t, { allowDownloads: true });
  f.respond((req, res) => req.path === '/result.png' ? res.end(png) : res.end(JSON.stringify({ data: [{ url: `${f.origin}/result.png` }], usage: { input_tokens: 1, output_tokens: 2 } })));
  const result = await f.plugin.generate(spec, '', options()); assert.equal(isUIArtifact(result), true);
  assert.equal(f.requests.length, 2); assert.equal(f.records[1].headers.authorization, undefined);
  assert.equal(f.requests[1].init.credentials, 'omit'); assert.equal(f.requests[1].init.redirect, 'error');
  assert.equal(JSON.stringify(result).includes(f.origin), false);
});
test('unsafe URLs and redirects never escape the admitted server download policy', async t => {
  const f = await fake(t);
  for (const url of ['https://example.invalid/image.png', 'file:///tmp/private', 'http://127.0.0.1/private']) {
    f.respond((_req, res) => res.end(JSON.stringify({ data: [{ url }] })));
    await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'invalid-output' });
  }
  assert.equal(f.requests.length, 3);
  f.respond((_req, res) => { res.writeHead(302, { location: 'https://example.invalid' }); res.end(); });
  await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'provider' });
});
test('preflight cancel/deadline consume and settle once at zero without dispatch', async t => {
  const f = await fake(t), controller = new AbortController(); controller.abort();
  for (const extra of [{ signal: controller.signal }, { deadlineAt: Date.now() - 1 }]) {
    const o = options(extra); await assert.rejects(f.plugin.generate(spec, '', o), { code: extra.signal ? 'cancelled' : 'deadline' });
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
  assert.equal(f.requests.length, 0);
});
test('active cancellation and deadlines bound stalled response bodies for generate and edit', async t => {
  const f = await fake(t);
  for (const operation of ['generate', 'edit']) for (const mode of ['cancelled', 'deadline']) {
    const controller = new AbortController(), o = options({ signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? 40 : 2000) });
    const pending = f.plugin[operation](operation === 'edit' ? artifact() : { prompt: 'fixture-stall' }, 'fixture-stall', o);
    let timer; if (mode === 'cancelled') timer = setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, { code: mode }); clearTimeout(timer);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'uncertain' }]);
  }
});
test('ignored transport cancellation still returns promptly with one uncertain terminal', async () => {
  let dispatched; const started = new Promise(resolve => { dispatched = resolve; });
  const binding = { plugin: manifest.id, model: 'gpt-image-2', effort: 'none', endpoint: 'http://127.0.0.1:1/v1',
    accountRef: 'fixture', secretRef: 'fixture', maxMicro: 1, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 } };
  const plugin = createOpenAIImages({ binding, resolveSecret: () => 'local-fixture', fetchImpl() { dispatched(); return new Promise(() => {}); } });
  const controller = new AbortController(), o = options({ signal: controller.signal });
  const pending = plugin.generate(spec, '', o); await started; controller.abort();
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(o.reports.length, 1); assert.equal(o.reports[0].outcome, 'uncertain');
});
test('awaits asynchronous claim consumption before dispatch and terminal persistence before return', async t => {
  const f = await fake(t); let consume, persist;
  const consuming = new Promise(resolve => { consume = resolve; }), persisting = new Promise(resolve => { persist = resolve; });
  const o = options(); o.attempt.consume = () => consuming; o.report = async terminal => { o.reports.push(terminal); await persisting; };
  let returned = false; const pending = f.plugin.generate(spec, '', o).then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests.length, 0); consume();
  while (!o.reports.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false); persist(); await pending; assert.equal(returned, true);
});
test('authority refusal does not dispatch or invent a second terminal report', async t => {
  const f = await fake(t), o = options();
  o.attempt.consume = () => { o.report({ attemptId: o.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }); throw new PluginError('not-admitted'); };
  await assert.rejects(f.plugin.generate(spec, '', o), { code: 'not-admitted' });
  assert.equal(o.reports.length, 1); assert.equal(f.requests.length, 0);
});
test('maps provider HTTP failures without exposing response details and leaves dispatched usage uncertain', async t => {
  const f = await fake(t);
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [500, 'provider']]) {
    f.respond((_req, res) => { res.writeHead(status); res.end('private-provider-detail'); });
    const o = options(); await assert.rejects(f.plugin.generate(spec, '', o), error => error.code === code && error.message === code);
    assert.equal(o.reports.length, 1); assert.equal(o.reports[0].outcome, 'uncertain');
  }
});
test('rejects invalid JSON/base64/non-images/multiple images and retains known usage on output errors', async t => {
  const f = await fake(t);
  for (const data of [[{ b64_json: '!!!' }], [{ b64_json: Buffer.from('text').toString('base64') }], [], [{}, {}]]) {
    f.respond((_req, res) => res.end(JSON.stringify({ data, usage: { input_tokens: 4, output_tokens: 7 } })));
    const o = options(); await assert.rejects(f.plugin.generate(spec, '', o), { code: 'invalid-output' });
    assert.deepEqual(o.reports[0].usage, { inputTokens: 4, outputTokens: 7 }); assert.equal(o.reports[0].outcome, 'cancelled');
  }
  f.respond((_req, res) => res.end('{private-broken-json'));
  await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'invalid-output' });
});
test('response and input bounds fail with limit, local invalid inputs remain undispatched', async t => {
  const f = await fake(t);
  f.respond((_req, res) => { res.writeHead(200, { 'content-length': 19 * 1024 * 1024 }); res.end('{}'); });
  await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'limit' });
  const before = f.requests.length, o = options();
  await assert.rejects(f.plugin.generate({ prompt: 'x'.repeat(32001) }, '', o), { code: 'limit' });
  assert.equal(f.requests.length, before); assert.equal(o.reports[0].usage.inputTokens, 0);
  await assert.rejects(f.plugin.edit({ url: 'https://example.invalid' }, feedback, options()), { code: 'invalid-output' });
});
test('missing credentials fail locally; secrets are resolved at invocation time', async t => {
  const f = await fake(t); let key;
  const plugin = createOpenAIImages({ binding: f.binding, resolveSecret: () => key, fetchImpl: f.fetchImpl });
  assert.deepEqual(await plugin.health(options()), { available: false }); const o = options();
  await assert.rejects(plugin.generate(spec, '', o), { code: 'auth' }); assert.equal(f.requests.length, 0);
  assert.equal(o.reports[0].outcome, 'cancelled'); key = 'local-fixture';
  await plugin.generate(spec, '', options()); assert.equal(f.requests.length, 1);
  assert.throws(() => createOpenAIImages({ binding: f.binding, baseUrl: 'http://localhost:1/v1' }), /match/u);
});
test('OpenAI Images passes reusable kind conformance with fake active stalls', async t => {
  const f = await fake(t);
  assert.deepEqual(await uiGenerationConformance(f.plugin, { spec, feedback, artifact: artifact() }, {
    stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length,
  }), { ok: true, failures: [] });
});
test('kind conformance rejects URL outputs, missing provenance and missing claim/report behaviour', async t => {
  const f = await fake(t);
  for (const mutation of [() => ({ url: 'https://example.invalid/image' }), result => ({ ...result, provenance: undefined })]) {
    const broken = { ...f.plugin, async generate(...args) { return mutation(await f.plugin.generate(...args)); } };
    const result = await uiGenerationConformance(broken, { spec, feedback, artifact: artifact() }, {
      stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length });
    assert.equal(result.ok, false); assert.ok(result.failures.includes('generate bytes/provenance artifact'));
  }
  const broken = { ...f.plugin, generate: async () => ({ url: 'https://example.invalid' }), edit: async () => ({ url: 'https://example.invalid' }) };
  const result = await uiGenerationConformance(broken, { spec, feedback, artifact: artifact() }, {
    stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length });
  assert.equal(result.ok, false); assert.ok(result.failures.includes('generate claim not consumed'));
  assert.ok(result.failures.includes('edit consume refusal missing'));
});
