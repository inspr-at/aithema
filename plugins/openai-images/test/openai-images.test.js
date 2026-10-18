import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createOpenAIImages, manifest } from '../src/index.js';
import { imageArtifact } from '../src/image-artifact.js';
import { jumbf, withCredential, credentialFixtures } from '../../../test/image-fixtures.js';
import { PluginError, PluginRegistry, validateManifest, isUIArtifact, uiGenerationConformance, IPTC_DIGITAL_SOURCE, imageInfo, usdCostMicro } from '@inspr/aithema-core';
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
    const form = req.method === 'POST' && multipart ? await new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes }).formData() : null;
    const body = req.method === 'POST' ? multipart ? Object.fromEntries(form) : JSON.parse(bytes) : null;
    const record = { path: req.url, headers: req.headers, body, images: form?.getAll('image[]') }; records.push(record);
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
test('generate sends Images JSON, returns real dimensions, bytes, digest and sidecar IPTC provenance', async t => {
  const f = await fake(t), o = options(), result = await f.plugin.generate(spec, feedback, o);
  assert.equal(isUIArtifact(result), true); assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(result.mediaType, 'image/png'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.generated);
  assert.deepEqual(Buffer.from(result.bytes), png);
  assert.equal(result.provenance.promptDigest, result.promptDigest);
  assert.deepEqual(result.provenance.credentials, { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' });
  assert.equal(result.provenance.assurances.imperceptibleWatermark, 'provider-declared');
  assert.match(result.provenance.assurances.watermarkSource, /OpenAI.*SynthID.*https:\/\/help.openai.com\/en\/articles\/8912793/u);
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
  const f = await fake(t), source = artifact(), o = options(), result = await f.plugin.edit(source, spec, feedback, o);
  assert.equal(f.records[0].path, '/v1/images/edits'); const body = f.records[0].body;
  assert.deepEqual(new Uint8Array(await body['image[]'].arrayBuffer()), source.bytes);
  assert.equal(body['image[]'].type, 'image/png'); assert.equal(body.model, 'gpt-image-2');
  assert.equal(body.n, '1'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.manipulated);
  assert.equal(o.reports.length, 1); assert.equal(o.reports[0].outcome, 'completed');
});
test('WebP dimensions survive without modifying the container', async t => {
  const f = await fake(t); f.respond((_req, res) => res.end(JSON.stringify({ data: [{ b64_json: webp.toString('base64') }] })));
  const o = options(), result = await f.plugin.generate(spec, '', o);
  assert.equal(result.mediaType, 'image/webp'); assert.deepEqual(imageInfo(result.bytes), {
    mediaType: 'image/webp', width: 1, height: 1, end: -1, extended: -1, alpha: false });
  assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), webp);
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
    const pending = operation === 'edit' ? f.plugin.edit(artifact(), { prompt: 'fixture-stall' }, 'fixture-stall', o) :
      f.plugin.generate({ prompt: 'fixture-stall' }, 'fixture-stall', o);
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
  await assert.rejects(f.plugin.edit({ url: 'https://example.invalid' }, spec, feedback, options()), { code: 'invalid-output' });
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

const references = () => [
  { bytes: png, mediaType: 'image/png', role: 'previous' },
  { bytes: webp, mediaType: 'image/webp', role: 'rejected' },
  // Minimal JPEG with a baseline SOF header and EOI: header validation is not pixel decoding.
  { bytes: Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217]), mediaType: 'image/jpeg', role: 'upload' },
];
test('generation carries ordered previous, rejected and upload references as private multipart bytes', async t => {
  const f = await fake(t), refs = references();
  const result = await f.plugin.generate({ ...spec, references: refs }, feedback, options());
  const record = f.records[0]; assert.equal(record.path, '/v1/images/edits');
  assert.equal(record.images.length, refs.length); assert.ok(record.body.prompt.startsWith(spec.prompt));
  assert.equal(result.provenance.origin, 'ai-manipulated');
  for (const [i, reference] of refs.entries()) {
    assert.deepEqual(new Uint8Array(await record.images[i].arrayBuffer()), new Uint8Array(reference.bytes));
    assert.equal(record.images[i].type, reference.mediaType);
  }
});
test('edit retains host prompt, output policy and additional references', async t => {
  const f = await fake(t), source = artifact(), refs = references().slice(1);
  const hostSpec = { prompt: 'Host-owned visual policy: a quiet public library', size: '1024x1536', quality: 'low', format: 'png', references: refs };
  await f.plugin.edit(source, hostSpec, feedback, options());
  const record = f.records[0]; assert.ok(record.body.prompt.startsWith(hostSpec.prompt));
  assert.match(record.body.prompt, /Make the action button blue/u);
  assert.equal(record.body.size, hostSpec.size); assert.equal(record.body.quality, hostSpec.quality);
  assert.equal(record.body.output_format, hostSpec.format); assert.equal(record.images.length, 3);
  assert.deepEqual(new Uint8Array(await record.images[0].arrayBuffer()), source.bytes);
});
test('references reject public URLs, unknown roles, nonimages, media mismatches and excess count/size before dispatch', async t => {
  const f = await fake(t), valid = references()[0];
  const cases = [
    [[{ url: 'https://example.invalid/ref.png', mediaType: 'image/png', role: 'upload' }], 'invalid-output'],
    [[{ ...valid, url: 'https://example.invalid' }], 'invalid-output'],
    [[{ ...valid, role: 'other' }], 'invalid-output'],
    [[{ ...valid, bytes: new Uint8Array() }], 'invalid-output'],
    [[{ ...valid, bytes: new Uint8Array([1, 2]) }], 'invalid-output'],
    [[{ ...valid, mediaType: 'image/webp' }], 'invalid-output'],
    [Array(10).fill(valid), 'limit'],
    [[{ ...valid, bytes: new Uint8Array(12 * 1024 * 1024 + 1) }], 'limit'],
    [{}, 'invalid-output'], [null, 'invalid-output'],
  ];
  for (const [refs, code] of cases) {
    const o = options(); await assert.rejects(f.plugin.generate({ ...spec, references: refs }, '', o), { code });
    assert.equal(f.requests.length, 0); assert.deepEqual(o.reports[0].usage, { inputTokens: 0, outputTokens: 0 });
  }
  await f.plugin.generate({ ...spec, references: Array(9).fill(valid) }, '', options());
  assert.equal(f.records[0].images.length, 9);
  const before = f.requests.length;
  await assert.rejects(f.plugin.edit(artifact(), { ...spec, references: Array(9).fill(valid) }, feedback, options()), { code: 'limit' });
  assert.equal(f.requests.length, before);
});
test('edit rejects a media type which disagrees with the private image bytes', async t => {
  const f = await fake(t), source = artifact();
  source.mediaType = 'image/webp'; source.provenance.subject.mediaType = 'image/webp';
  const o = options(); await assert.rejects(f.plugin.edit(source, spec, feedback, o), { code: 'invalid-output' });
  assert.equal(f.requests.length, 0); assert.equal(o.reports[0].usage.inputTokens, 0);
});
test('non-loopback HTTP endpoint and even allowlisted HTTP downloads are rejected', async t => {
  const f = await fake(t);
  assert.throws(() => createOpenAIImages({ binding: { ...f.binding, endpoint: 'http://example.invalid/v1' } }), /loopback/u);
  const plugin = createOpenAIImages({ binding: { ...f.binding, routing: { imageOrigins: ['http://example.invalid'] } },
    resolveSecret: () => 'local-fixture', fetchImpl: f.fetchImpl });
  f.respond((_req, res) => res.end(JSON.stringify({ data: [{ url: 'http://example.invalid/result.png' }] })));
  await assert.rejects(plugin.generate(spec, '', options()), { code: 'invalid-output' });
  assert.equal(f.requests.length, 1);
});
test('downloads over 12 MiB fail for declared and streamed lengths while retaining paid usage', async t => {
  const f = await fake(t, { allowDownloads: true });
  for (const declared of [true, false]) {
    f.respond((req, res) => {
      if (req.path !== '/oversize.png') return res.end(JSON.stringify({ data: [{ url: `${f.origin}/oversize.png` }], usage: { input_tokens: 11, output_tokens: 23 } }));
      res.writeHead(200, declared ? { 'content-length': 12 * 1024 * 1024 + 1 } : {});
      res.end(Buffer.alloc(12 * 1024 * 1024 + 1));
    });
    const o = options(); await assert.rejects(f.plugin.generate(spec, '', o), { code: 'limit' });
    assert.deepEqual(o.reports[0].usage, { inputTokens: 11, outputTokens: 23 });
  }
});
for (const [name, mutation] of [
  ['stale digest', result => ({ ...result, provenance: { ...result.provenance, subject: { ...result.provenance.subject,
    contentDigest: `sha-256=:${createHash('sha256').update('different bytes').digest('base64')}:` } } })],
  ['wrong media type', result => ({ ...result, mediaType: 'image/webp', provenance: { ...result.provenance,
    subject: { ...result.provenance.subject, mediaType: 'image/webp' } } })],
  ['fabricated dimensions', result => ({ ...result, width: 1536, height: 1024 })],
  ['missing credentials', result => { delete result.provenance.credentials; return result; }],
  ['missing prompt digest', result => { delete result.provenance.promptDigest; return result; }],
  ['legacy provenance', result => {
    delete result.provenance.credentials; delete result.provenance.promptDigest;
    result.provenance.techniques = ['embedded-metadata', 'response-field'];
    result.provenance.assurances = { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' };
    return result;
  }],
]) for (const operation of ['generate', 'edit']) test(`conformance rejects ${operation} ${name} against the actual bytes`, async t => {
  const f = await fake(t), broken = { ...f.plugin, async [operation](...args) { return mutation(await f.plugin[operation](...args)); } };
  const result = await uiGenerationConformance(broken, { spec, feedback, artifact: artifact() }, {
    stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length });
  assert.equal(result.ok, false); assert.ok(result.failures.includes(`${operation} bytes/provenance artifact`));
});
test('artifact provenance and generator reject extra fields including provider URLs', () => {
  for (const nested of ['provenance', 'generator', 'subject', 'assurances', 'credentials']) {
    const result = artifact();
    const target = nested === 'provenance' ? result.provenance : result.provenance[nested];
    target.url = 'https://example.invalid/provider'; assert.equal(isUIArtifact(result), false, nested);
  }
});
test('conformance compares optional expected usage and exercises reference generation', async t => {
  const f = await fake(t), input = { spec: { ...spec, references: references() }, feedback, artifact: artifact() };
  const settings = { stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length,
    expectedUsage: { inputTokens: 11, outputTokens: 23 } };
  assert.deepEqual(await uiGenerationConformance(f.plugin, input, settings), { ok: true, failures: [] });
  assert.equal(f.records.filter(r => r.images?.length === 3).length, 1);
  const under = { ...f.plugin };
  for (const operation of ['generate', 'edit']) under[operation] = (...args) => {
    const o = args.at(-1), original = o.report;
    return f.plugin[operation](...args.slice(0, -1), { ...o, report: report => original(report.outcome === 'completed' ?
      { ...report, usage: { inputTokens: 0, outputTokens: 0 } } : report) });
  };
  const result = await uiGenerationConformance(under, input, settings);
  assert.equal(result.ok, false); assert.ok(result.failures.includes('generate expected usage'));
  assert.ok(result.failures.includes('edit expected usage'));
});
for (const [name, bytes] of credentialFixtures) test(`${name} provider bytes and credential payload remain byte-identical`, async t => {
  const f = await fake(t); f.respond((_req, res) => res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })));
  const result = await f.plugin.generate(spec, '', options());
  assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), bytes);
  assert.equal(createHash('sha256').update(result.bytes).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.provenance.credentials, { c2pa: 'present', manifestByteLength: jumbf().length, verification: 'not-verified' });
  assert.equal(result.provenance.assurances.digitallySigned, false);
});
test('sidecar contains AI origin, generator, prompt digest, timestamp and original-byte digest', () => {
  const result = artifact();
  assert.deepEqual(result.provenance, { version: 1, origin: 'ai-generated', modality: 'image',
    digitalSourceType: IPTC_DIGITAL_SOURCE.generated, generatedAt: '1970-01-01T00:00:00.000Z',
    generator: { provider: 'openai', model: 'gpt-image-2' }, promptDigest: result.promptDigest,
    techniques: ['response-field', 'sidecar'],
    credentials: { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' },
    assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-declared',
      watermarkSource: 'OpenAI declares SynthID on API images: https://help.openai.com/en/articles/8912793' },
    subject: { contentDigest: `sha-256=:${createHash('sha256').update(png).digest('base64')}:`, mediaType: 'image/png' } });
});
test('fake/local sidecars report absent credentials and unknown watermarks', () => {
  const result = imageArtifact(png, { prompt: 'fake', model: 'deterministic-ui', provider: 'local-demo-fake', operation: 'generate' });
  assert.equal(isUIArtifact(result), true); assert.equal(result.provenance.generator.provider, 'local-demo-fake');
  assert.deepEqual(result.provenance.credentials, { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' });
  assert.deepEqual(result.provenance.assurances, { digitallySigned: false, imperceptibleWatermark: 'unknown', watermarkSource: null });
});
for (const provider of ['codex-imagegen', 'another-provider']) for (const marked of [false, true]) test(`${provider} detects credentials from ${marked ? 'marked' : 'unmarked'} bytes with unknown watermark`, () => {
  const bytes = marked ? withCredential(png) : png;
  const result = imageArtifact(bytes, { prompt: 'generate', model: 'fixture-model', provider, operation: 'generate' });
  assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), bytes);
  assert.deepEqual(result.provenance.credentials, { c2pa: marked ? 'present' : 'absent',
    manifestByteLength: marked ? jumbf().length : 0, verification: 'not-verified' });
  assert.deepEqual(result.provenance.assurances, { digitallySigned: false, imperceptibleWatermark: 'unknown', watermarkSource: null });
});
for (const [name, bytes, type] of [['PNG', png, 'iTXt'], ['WebP', webp, 'XMP ']]) test(`existing ${name} XMP remains intact through refinement`, () => {
  const source = withCredential(bytes, { type, payload: Buffer.from('XML:com.adobe.xmp\0<x:xmpmeta>legacy</x:xmpmeta>') });
  const result = imageArtifact(source, { prompt: 'refine', model: 'gpt-image-2', operation: 'edit' });
  assert.deepEqual(Buffer.from(result.bytes), source); assert.equal(result.provenance.origin, 'ai-manipulated');
  assert.deepEqual(result.provenance.credentials, { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' });
});
test('legacy embedded-metadata sidecars remain accepted as private edit references', async t => {
  const f = await fake(t), source = artifact();
  delete source.provenance.credentials; delete source.provenance.promptDigest;
  source.provenance.techniques = ['embedded-metadata', 'response-field'];
  source.provenance.assurances = { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' };
  assert.equal(isUIArtifact(source), false);
  assert.equal(isUIArtifact(source, { allowLegacy: true }), true);
  const result = await f.plugin.edit(source, spec, feedback, options());
  assert.deepEqual(new Uint8Array(await f.records[0].images[0].arrayBuffer()), source.bytes);
  assert.equal(result.provenance.origin, 'ai-manipulated');
});
test('credential and watermark records reject invented verification or inconsistent presence', () => {
  for (const change of [r => { r.provenance.credentials.verification = 'verified'; },
    r => { r.provenance.credentials.c2pa = 'present'; }, r => { r.provenance.credentials.manifestByteLength = -1; },
    r => { r.provenance.assurances.imperceptibleWatermark = 'verified'; },
    r => { r.provenance.assurances.watermarkSource = null; }, r => { r.provenance.promptDigest = 'sha256:' + '0'.repeat(64); }]) {
    const result = artifact(); change(result); assert.equal(isUIArtifact(result), false);
  }
});

test('AIT-306: exhausted image spend cap refuses with not-admitted and zero fetch calls', async () => {
  let fetches = 0;
  const spendCap = { reserve() { throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted'); } };
  const binding = { plugin: manifest.id, model: 'openai/gpt-image-2', effort: 'none', endpoint: 'https://openrouter.ai/api/v1',
    accountRef: 'fixture-account', secretRef: 'fixture-secret-ref', maxMicro: 100, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  const plugin = createOpenAIImages({ binding, spendCap, resolveSecret: () => 'local-fixture', fetchImpl: async () => {
    fetches++; return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.00001 } });
  } });
  const [result] = await Promise.allSettled([plugin.generate(spec, '', options())]);
  assert.equal(fetches, 0, 'exhausted cap must refuse before fetch');
  assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'not-admitted');
});

const cappedBinding = () => ({ plugin: manifest.id, model: 'openai/gpt-image-2', effort: 'none', endpoint: 'https://openrouter.ai/api/v1',
  accountRef: 'fixture-account', secretRef: 'fixture-secret-ref', maxMicro: 100, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
function cappedFixture({ payload = { id: 'gen-image-receipt', data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.0000101 } },
  status = 200, reserve, respond, binding = cappedBinding(), resolveSecret = () => 'local-fixture', spendCap: suppliedCap } = {}) {
  const calls = [], requests = [], handle = Symbol('opaque image reservation');
  const spendCap = suppliedCap === false ? undefined : suppliedCap ?? {
    reserve(ceiling, metadata) { calls.push(['reserve', ceiling, metadata]); reserve?.(); return handle; },
    dispatch(received) { assert.equal(received, handle); calls.push(['dispatch']); },
    record(received, evidence) { assert.equal(received, handle); calls.push(['record', evidence]); },
    settle(received, actual) { assert.equal(received, handle); calls.push(['settle', actual]); },
    uncertain(received) { assert.equal(received, handle); calls.push(['uncertain']); },
  };
  const plugin = createOpenAIImages({ binding, spendCap, resolveSecret, fetchImpl: async (url, init) => {
    requests.push({ url, ...init }); calls.push(['fetch']); return respond ? respond() : Response.json(payload, { status });
  } });
  return { plugin, calls, requests };
}
test('AIT-306: generate and edit reserve the admitted ceiling, record before settlement, and retain the port on bind', async () => {
  const f = cappedFixture(), plugin = f.plugin.bind({ ...f.plugin.binding, maxMicro: 80 });
  for (const operation of ['generate', 'edit']) {
    f.calls.length = 0;
    const o = options(), evidence = [];
    o.attempt.dispatchCost = () => evidence.push('dispatch'); o.attempt.observeCost = receipt => evidence.push(receipt);
    if (operation === 'generate') await plugin.generate(spec, '', o);
    else await plugin.edit(artifact(), spec, feedback, o);
    assert.deepEqual(f.calls, [['reserve', 80, { attemptId: o.attempt.attemptId, provider: 'openrouter' }], ['dispatch'], ['fetch'],
      ['record', { generationId: 'gen-image-receipt', chargedMicro: 11 }], ['settle', 11]]);
    assert.deepEqual(evidence, ['dispatch', { generationId: 'gen-image-receipt', chargedMicro: 11 }]);
    assert.equal(o.reports[0].chargedMicro, 11); assert.equal(o.reports[0].generationId, 'gen-image-receipt');
  }
});
test('AIT-326: gateway header and body generation IDs reach invocation and reservation receipts', async () => {
  const cases = [
    { header: 'gen-header-image', expected: 'gen-header-image' },
    { id: 'gen-body-image', expected: 'gen-body-image' },
    { header: 'gen-header-image', id: 'gen-body-image', expected: 'gen-header-image' },
    { header: 'request-not-generation', id: 'gen-body-image', expected: 'gen-body-image' },
    {},
  ];
  for (const operation of ['generate', 'edit']) for (const { header, id, expected } of cases) {
    const f = cappedFixture({ respond: () => Response.json({ ...(id ? { id } : {}),
      data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.0000101 } },
    { headers: header ? { 'X-Generation-Id': header } : {} }) });
    const o = options(), observed = [];
    o.attempt.observeCost = receipt => observed.push(receipt);
    if (operation === 'generate') await f.plugin.generate(spec, '', o);
    else await f.plugin.edit(artifact(), spec, feedback, o);
    const evidence = { ...(expected ? { generationId: expected } : {}), chargedMicro: 11 };
    assert.deepEqual(f.calls.slice(-2), [['record', evidence], ['settle', 11]]);
    assert.deepEqual(observed, [evidence]);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 }, ...evidence }]);
  }
});
test('AIT-326: invalid or unreadable generation headers leave cost settlement intact', async () => {
  for (const header of ['', 'req-image', 'gen-bad_id', 'gen-one, gen-two', `gen-${'a'.repeat(125)}`, null, 7, 'gen-bad\nvalue']) {
    const f = cappedFixture({ respond: () => {
      const response = Response.json({ id: 'invalid-body-id', data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.00002 } });
      const headers = response.headers;
      Object.defineProperty(response, 'headers', { value: { get: name => name === 'x-generation-id' ? header : headers.get(name) } });
      return response;
    } }), o = options();
    await f.plugin.generate(spec, '', o);
    assert.deepEqual(f.calls.slice(-2), [['record', { chargedMicro: 20 }], ['settle', 20]]);
    assert.equal(Object.hasOwn(o.reports[0], 'generationId'), false);
  }
  const f = cappedFixture({ respond: () => {
    const response = Response.json({ id: 'gen-body-fallback', data: [{ b64_json: png.toString('base64') }], usage: { cost: 0 } });
    const headers = response.headers;
    Object.defineProperty(response, 'headers', { value: { get(name) {
      if (name === 'x-generation-id') throw new Error('fixture header access');
      return headers.get(name);
    } } });
    return response;
  } }), o = options();
  await f.plugin.generate(spec, '', o);
  assert.deepEqual(f.calls.slice(-2), [['record', { generationId: 'gen-body-fallback', chargedMicro: 0 }], ['settle', 0]]);
  assert.equal(o.reports[0].generationId, 'gen-body-fallback');
});
test('AIT-326: header ID is retained with unknown spend, HTTP errors and invalid image output', async () => {
  for (const mode of ['unknown-cost', 'http-error', 'invalid-image']) {
    const f = cappedFixture({ respond: () => Response.json({ data: mode === 'invalid-image' ? [] : [{ b64_json: png.toString('base64') }],
      usage: mode === 'unknown-cost' ? {} : { cost: 0.00002 } },
    { status: mode === 'http-error' ? 500 : 200, headers: { 'x-generation-id': 'gen-image-error' } }) }), o = options();
    if (mode === 'unknown-cost') await f.plugin.generate(spec, '', o);
    else await assert.rejects(f.plugin.generate(spec, '', o), { code: mode === 'http-error' ? 'provider' : 'invalid-output' });
    assert.deepEqual(f.calls.slice(-2), [['record', { generationId: 'gen-image-error',
      ...(mode === 'unknown-cost' ? {} : { chargedMicro: 20 }) }], mode === 'unknown-cost' ? ['uncertain'] : ['settle', 20]]);
    assert.equal(o.reports[0].generationId, 'gen-image-error');
  }
});
test('AIT-326: uncapped gateway reports IDs while direct mode ignores the gateway header', async () => {
  for (const gateway of [false, true]) for (const id of [undefined, 'gen-body-uncapped']) {
    const f = cappedFixture({ spendCap: false,
      ...(gateway ? {} : { binding: { ...cappedBinding(), model: 'gpt-image-2', endpoint: 'https://api.openai.com/v1' } }),
      respond: () => Response.json({ ...(id ? { id } : {}), data: [{ b64_json: png.toString('base64') }],
        usage: { input_tokens: 1, output_tokens: 2, cost: 0.00002 } }, { headers: { 'X-Generation-Id': 'gen-header-uncapped' } }) }), o = options();
    await f.plugin.generate(spec, '', o);
    assert.deepEqual(f.calls, [['fetch']]);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 2 },
      ...(gateway ? { generationId: 'gen-header-uncapped', chargedMicro: 20 } : {}) }]);
  }
});
test('AIT-306: missing and unparsable dispatched costs retain an uncertain ceiling, explicit zero settles', async () => {
  for (const cost of [undefined, null, '0.001', -1, Infinity, 0]) {
    const f = cappedFixture({ payload: { id: 'gen-unknown-cost', data: [{ b64_json: png.toString('base64') }], usage: { cost } } });
    await f.plugin.generate(spec, '', options());
    assert.deepEqual(f.calls.at(-1), cost === 0 ? ['settle', 0] : ['uncertain']);
    assert.deepEqual(f.calls.at(-2), ['record', { generationId: 'gen-unknown-cost', ...(cost === 0 ? { chargedMicro: 0 } : {}) }]);
  }
});
test('AIT-306: abort and deadline after reservation release without dispatch or fetch', async () => {
  for (const mode of ['abort', 'deadline']) {
    const controller = new AbortController(), o = options({ signal: controller.signal });
    const f = cappedFixture({ reserve() { if (mode === 'abort') controller.abort(); else o.deadlineAt = Date.now() - 1; } });
    await assert.rejects(f.plugin.generate(spec, '', o), { code: mode === 'abort' ? 'cancelled' : 'deadline' });
    assert.deepEqual(f.calls, [['reserve', 100, { attemptId: o.attempt.attemptId, provider: 'openrouter' }], ['settle', 0]]);
    assert.equal(f.requests.length, 0);
  }
});
test('AIT-306: auth, invalid spec, pre-abort and expired deadline create no reservation', async () => {
  for (const mode of ['auth', 'spec', 'abort', 'deadline']) {
    const f = cappedFixture({ ...(mode === 'auth' ? { resolveSecret: () => '' } : {}) }), controller = new AbortController();
    if (mode === 'abort') controller.abort();
    await assert.rejects(f.plugin.generate(mode === 'spec' ? {} : spec, '', options({ signal: controller.signal,
      deadlineAt: Date.now() + (mode === 'deadline' ? -1 : 2000) })),
    { code: { auth: 'auth', spec: 'invalid-output', abort: 'cancelled', deadline: 'deadline' }[mode] });
    assert.deepEqual(f.calls, []);
  }
});
test('AIT-306: HTTP errors follow reasoning receipt and unbilled rejection rules', async () => {
  for (const status of [400, 401, 403, 408, 422, 429, 499, 500, 503]) {
    for (const usage of [undefined, { input_tokens: 1, output_tokens: 1 }, { cost: 0 }, { cost: 0.00002 }]) {
      const f = cappedFixture({ status, payload: { error: { message: 'fixture rejection' }, ...(usage ? { usage } : {}) } });
      await assert.rejects(f.plugin.generate(spec, '', options()), { code: [401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider' });
      const actual = usage?.cost !== undefined ? usdCostMicro(usage.cost) : !usage && status < 500 && ![408, 499].includes(status) ? 0 : null;
      assert.deepEqual(f.calls.at(-1), actual === null ? ['uncertain'] : ['settle', actual], `status ${status}, usage ${JSON.stringify(usage)}`);
    }
  }
  const plain = cappedFixture({ respond: () => new Response('rejected', { status: 400 }) });
  await assert.rejects(plain.plugin.generate(spec, '', options()), { code: 'provider' });
  assert.deepEqual(plain.calls.at(-1), ['settle', 0]);
});
test('AIT-306: interrupted rejection bodies and failed transports remain uncertain', async () => {
  for (const respond of [() => { throw new Error('fixture network failure'); },
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); c.error(new Error('fixture truncated')); } }), { status: 400 })]) {
    const f = cappedFixture({ respond });
    await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'provider' });
    assert.deepEqual(f.calls.at(-1), ['uncertain']);
  }
});
test('AIT-306: charged invalid image output settles its receipt before reporting failure', async () => {
  const f = cappedFixture({ payload: { id: 'gen-invalid-image', data: [], usage: { cost: 0.00002 } } });
  await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'invalid-output' });
  assert.deepEqual(f.calls.slice(-2), [['record', { generationId: 'gen-invalid-image', chargedMicro: 20 }], ['settle', 20]]);
});
test('AIT-308: direct mode without a spend cap preserves token-based reports', async () => {
  const f = cappedFixture({ binding: { ...cappedBinding(), model: 'gpt-image-2', endpoint: 'https://api.openai.com/v1' },
    payload: { data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 11, output_tokens: 23, cost: 0.00001 } },
    spendCap: false });
  const o = options(); await f.plugin.generate(spec, '', o);
  assert.deepEqual(f.calls, [['fetch']]);
  assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 11, outputTokens: 23 } }]);
});

test('AIT-308: exhausted direct image spend cap refuses with not-admitted and zero fetch calls', async () => {
  let fetches = 0;
  const spendCap = { reserve() { throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted'); } };
  const binding = { plugin: manifest.id, model: 'gpt-image-2', effort: 'none', endpoint: 'https://api.openai.com/v1',
    accountRef: 'fixture-account', secretRef: 'fixture-secret-ref', maxMicro: 100, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  const plugin = createOpenAIImages({ binding, spendCap, resolveSecret: () => 'local-fixture', fetchImpl: async () => {
    fetches++; return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.00001 } });
  } });
  const [result] = await Promise.allSettled([plugin.generate(spec, '', options())]);
  assert.equal(fetches, 0, 'exhausted cap must refuse before fetch');
  assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'not-admitted');
});

const directBinding = () => ({ ...cappedBinding(), model: 'gpt-image-2', endpoint: 'https://api.openai.com/v1',
  rates: { inputMicro: 2, outputMicro: 3 } });
const directOptions = (extra = {}) => options({ imageCost: { inputMicro: 2, outputMicro: 3 }, ...extra });
const directPayload = (usage = { input_tokens: 11, output_tokens: 23 }) => ({
  id: 'gen-direct-image', data: [{ b64_json: png.toString('base64') }], usage });
const directFixture = (settings = {}) => cappedFixture({ binding: directBinding(), payload: directPayload(), ...settings });
test('AIT-308: direct generate and edit reserve before fetch, price private tokens, and retain the cap on bind', async () => {
  const f = directFixture(), plugin = f.plugin.bind({ ...f.plugin.binding, maxMicro: 95 });
  for (const operation of ['generate', 'edit']) {
    f.calls.length = 0;
    const o = directOptions(), evidence = [];
    o.attempt.dispatchCost = () => evidence.push('dispatch'); o.attempt.observeCost = receipt => evidence.push(receipt);
    if (operation === 'generate') await plugin.generate(spec, '', o);
    else await plugin.edit(artifact(), spec, feedback, o);
    assert.deepEqual(f.calls, [['reserve', 95, { attemptId: o.attempt.attemptId, provider: 'openai' }], ['dispatch'], ['fetch'],
      ['record', { generationId: 'gen-direct-image', chargedMicro: 91 }], ['settle', 91]]);
    assert.deepEqual(evidence, ['dispatch', { generationId: 'gen-direct-image', chargedMicro: 91 }]);
    assert.equal(o.reports[0].chargedMicro, 91); assert.equal(o.reports[0].generationId, 'gen-direct-image');
    assert.deepEqual(o.reports[0].usage, { inputTokens: 11, outputTokens: 23 });
    assert.equal(o.reports[0].outcome, 'completed');
  }
});
test('AIT-308: direct unpriced responses charge the ceiling including absent usage, retained on bind', async () => {
  const { rates, ...binding } = directBinding();
  for (const usage of [undefined, { input_tokens: 11, output_tokens: 23 }, { cost: 0 }]) {
    const f = directFixture({ binding, payload: { ...directPayload(), usage } }), o = options();
    const plugin = f.plugin.bind({ ...f.plugin.binding, maxMicro: 75 });
    await plugin.generate(spec, '', o);
    assert.deepEqual(f.calls.at(-1), ['settle', 75]);
    assert.equal(o.reports[0].chargedMicro, 75); assert.equal(o.reports[0].outcome, 'completed');
  }
});
test('AIT-308: direct missing or invalid tokens and overflowing private charges remain uncertain; zero is charged', async () => {
  for (const usage of [undefined, {}, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: '1', output_tokens: 2 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 },
    { input_tokens: 0, output_tokens: 0 }]) {
    const f = directFixture({ payload: { ...directPayload(), usage } }), o = directOptions();
    await f.plugin.generate(spec, '', o);
    const zero = usage?.input_tokens === 0 && usage?.output_tokens === 0;
    assert.deepEqual(f.calls.at(-1), zero ? ['settle', 0] : ['uncertain']);
    assert.equal(o.reports[0].outcome, zero ? 'completed' : 'uncertain');
  }
});
test('AIT-308: direct cost fields cannot replace private rates or unpriced ceiling charging', async () => {
  for (const cost of [undefined, null, '0.001', -1, Infinity, 0, 1]) {
    const f = directFixture({ payload: directPayload({ input_tokens: 1, output_tokens: 2, cost }) });
    await f.plugin.generate(spec, '', directOptions());
    assert.deepEqual(f.calls.at(-1), ['settle', 8]);
  }
});
test('AIT-308: direct abort and deadline after reservation release without dispatch or fetch', async () => {
  for (const mode of ['abort', 'deadline']) {
    const controller = new AbortController(), o = options({ signal: controller.signal });
    const f = directFixture({ reserve() { if (mode === 'abort') controller.abort(); else o.deadlineAt = Date.now() - 1; } });
    await assert.rejects(f.plugin.generate(spec, '', o), { code: mode === 'abort' ? 'cancelled' : 'deadline' });
    assert.deepEqual(f.calls, [['reserve', 100, { attemptId: o.attempt.attemptId, provider: 'openai' }], ['settle', 0]]);
    assert.equal(f.requests.length, 0);
  }
});
test('AIT-308: direct auth, invalid spec, pre-abort and expired deadline create no reservation', async () => {
  for (const mode of ['auth', 'spec', 'abort', 'deadline']) {
    const f = directFixture({ ...(mode === 'auth' ? { resolveSecret: () => '' } : {}) }), controller = new AbortController();
    if (mode === 'abort') controller.abort();
    await assert.rejects(f.plugin.generate(mode === 'spec' ? {} : spec, '', options({ signal: controller.signal,
      deadlineAt: Date.now() + (mode === 'deadline' ? -1 : 2000) })),
    { code: { auth: 'auth', spec: 'invalid-output', abort: 'cancelled', deadline: 'deadline' }[mode] });
    assert.deepEqual(f.calls, []);
  }
});
test('AIT-308: direct interrupted rejection bodies and failed transports remain uncertain', async () => {
  for (const respond of [() => { throw new Error('fixture network failure'); },
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); c.error(new Error('fixture truncated')); } }), { status: 400 })]) {
    const f = directFixture({ respond });
    await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'provider' });
    assert.deepEqual(f.calls.at(-1), ['uncertain']);
  }
});

test('AIT-308: direct HTTP errors price usable tokens, release unbilled rejections, and retain unknown holds', async () => {
  for (const priced of [true, false]) for (const status of [400, 401, 403, 408, 422, 429, 499, 500, 503]) {
    const { rates, ...unpriced } = directBinding();
    for (const usage of [undefined, {}, { input_tokens: 1, output_tokens: 2 }, { input_tokens: 0, output_tokens: 0 }, { cost: 0 }]) {
      const f = directFixture({ binding: priced ? directBinding() : unpriced,
        status, payload: { error: { message: 'fixture rejection' }, usage } }), o = options({
          ...(priced ? { imageCost: { inputMicro: 2, outputMicro: 3 } } : {}) });
      await assert.rejects(f.plugin.generate(spec, '', o), { code: [401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider' });
      const actual = usage?.input_tokens !== undefined ? priced ? usage.input_tokens * 2 + usage.output_tokens * 3 : 100 :
        !usage && status < 500 && ![408, 499].includes(status) ? 0 : null;
      assert.deepEqual(f.calls.at(-1), actual === null ? ['uncertain'] : ['settle', actual], `status ${status}, priced ${priced}, usage ${JSON.stringify(usage)}`);
    }
  }
  const plain = directFixture({ respond: () => new Response('rejected', { status: 400 }) });
  await assert.rejects(plain.plugin.generate(spec, '', options()), { code: 'provider' });
  assert.deepEqual(plain.calls.at(-1), ['settle', 0]);
});
test('AIT-308: direct charged invalid output retains the private token charge or unpriced ceiling', async () => {
  const { rates, ...unpriced } = directBinding();
  for (const binding of [directBinding(), unpriced]) {
    const f = directFixture({ binding, payload: { ...directPayload(), data: [] } }), o = options({
      ...(binding.rates ? { imageCost: { inputMicro: 2, outputMicro: 3 } } : {}) });
    await assert.rejects(f.plugin.generate(spec, '', o), { code: 'invalid-output' });
    const actual = binding.rates ? 91 : 100;
    assert.deepEqual(f.calls.slice(-2), [['record', { generationId: 'gen-direct-image', chargedMicro: actual }], ['settle', actual]]);
    assert.equal(o.reports[0].chargedMicro, actual);
  }
});
test('AIT-308: direct cancellation and deadlines after dispatch retain an uncertain ceiling', async () => {
  for (const priced of [true, false]) for (const mode of ['abort', 'deadline']) {
    const { rates, ...unpriced } = directBinding(), started = Promise.withResolvers(), controller = new AbortController();
    const f = directFixture({ binding: priced ? directBinding() : unpriced, respond() { started.resolve(); return new Promise(() => {}); } });
    const o = options({ signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? 50 : 2000) });
    const pending = f.plugin.generate(spec, '', o); await started.promise;
    if (mode === 'abort') controller.abort();
    await assert.rejects(pending, { code: mode === 'abort' ? 'cancelled' : 'deadline' });
    assert.deepEqual(f.calls.at(-1), ['uncertain']); assert.equal(o.reports[0].outcome, 'uncertain');
  }
});
test('AIT-308: direct malformed successful response bodies retain an uncertain ceiling', async () => {
  const { rates, ...binding } = directBinding();
  for (const respond of [() => new Response('{'), () => new Response(new ReadableStream({ start(c) { c.error(new Error('fixture truncated')); } }))]) {
    const f = directFixture({ binding, respond });
    await assert.rejects(f.plugin.generate(spec, '', options()));
    assert.deepEqual(f.calls.at(-1), ['uncertain']);
  }
});

test('AIT-308 round 2: common rates never price capped direct images, including nonzero rates', async () => {
  for (const rates of [undefined, { inputMicro: 0, outputMicro: 0 }, { inputMicro: 2, outputMicro: 3 }]) {
    for (const imageCost of [undefined, {}, { inputMicro: -1, outputMicro: 3 }, { inputMicro: 2, outputMicro: '3' }]) {
      const f = directFixture({ binding: { ...directBinding(), rates } }), o = options({ imageCost });
      await f.plugin.generate(spec, '', o);
      assert.deepEqual(f.calls.at(-1), ['settle', 100]);
      assert.equal(o.reports[0].chargedMicro, 100);
    }
  }
});
