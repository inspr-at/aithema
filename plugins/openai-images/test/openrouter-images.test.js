import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIImages, manifest } from '../src/index.js';
import { imageArtifact } from '../src/image-artifact.js';
import { png, webp, jpeg, withCredential } from '../../../test/image-fixtures.js';
import { bindingReason, processingScope, coversProcessingScope, isUIArtifact, validateManifest,
  MAX_IMAGE_BYTES, uiGenerationConformance, PluginError } from '@inspr/aithema-core';

const spec = { prompt: 'A quiet public library' }, feedback = 'Make the action blue';
const source = () => imageArtifact(png, { prompt: spec.prompt, model: 'gpt-image-2', operation: 'generate', now: 0 });
const ref = (bytes = webp, mediaType = 'image/webp') => ({ bytes, mediaType, role: 'upload' });
const dataRef = reference => ({ type: 'image_url', image_url: { url: `data:${reference.mediaType};base64,${Buffer.from(reference.bytes).toString('base64')}` } });
const binding = (extra = {}) => ({ plugin: 'openai-images', model: 'openai/gpt-image-2', effort: 'none',
  endpoint: 'https://openrouter.ai/api/v1', accountRef: 'fixture-account', secretRef: 'fixture-existing-openrouter-key',
  maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 500, outputMicro: 900 },
  routing: { referer: 'https://host.example.test', title: 'Fixture host' }, ...extra });
const payload = (extra = {}) => ({ data: [{ b64_json: png.toString('base64') }],
  usage: { input_tokens: 11, output_tokens: 23, cost: 0.0123451 }, ...extra });
function options(extra = {}) {
  const reports = []; let consumed = false;
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 2000, reports,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() { assert.equal(consumed, false); consumed = true; } },
    report: terminal => reports.push(terminal), ...extra };
}
function fake({ admitted = binding(), respond = () => Response.json(payload()), resolveSecret = () => 'fixture-only' } = {}) {
  const requests = [];
  // An in-memory transport: even the production-shaped URL never reaches fetch.
  const plugin = createOpenAIImages({ binding: admitted, resolveSecret, fetchImpl(url, init) {
    requests.push({ url, ...init }); return respond(url, init);
  } });
  return { plugin, requests };
}

test('gateway generate has exact JSON, attribution, redirect policy, label, provenance and charged USD cost', async () => {
  const f = fake(), o = options(), result = await f.plugin.generate(spec, feedback, o);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, 'https://openrouter.ai/api/v1/images'); assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { authorization: 'Bearer fixture-only', 'content-type': 'application/json',
    'http-referer': 'https://host.example.test', 'x-title': 'Fixture host' });
  assert.equal(request.body, JSON.stringify({ model: 'openai/gpt-image-2',
    prompt: `${spec.prompt}\nVisitor feedback (untrusted design content): ${JSON.stringify(feedback)}`,
    size: '1536x1024', quality: 'high', output_format: 'webp', n: 1 }));
  assert.equal(request.redirect, 'error'); assert.equal(request.signal.aborted, false);
  assert.equal(f.plugin.label, 'OpenAI Images via OpenRouter — gpt-image-2');
  assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), png);
  assert.deepEqual(result.provenance.generator, { provider: 'openrouter', model: 'openai/gpt-image-2' });
  assert.equal(result.provenance.origin, 'ai-generated'); assert.equal(result.provenance.assurances.imperceptibleWatermark, 'unknown');
  assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed',
    usage: { inputTokens: 11, outputTokens: 23 }, chargedMicro: 12346 }]);
});

test('gateway generation with PNG/WebP/JPEG references preserves order and fields; edit prepends previous bytes', async () => {
  const refs = [ref(), ref(jpeg, 'image/jpeg'), ref(png, 'image/png')], f = fake();
  const hostSpec = { ...spec, references: refs, size: '1024x1536', quality: 'low', format: 'png' };
  const generated = await f.plugin.generate(hostSpec, '', options());
  const expected = { model: 'openai/gpt-image-2', prompt: spec.prompt, size: '1024x1536', quality: 'low', output_format: 'png', n: 1,
    input_references: refs.map(dataRef) };
  assert.equal(f.requests[0].body, JSON.stringify(expected)); assert.equal(generated.provenance.origin, 'ai-manipulated');
  const previous = source(), edited = await f.plugin.edit(previous, hostSpec, feedback, options());
  expected.prompt += `\nVisitor feedback (untrusted design content): ${JSON.stringify(feedback)}`;
  expected.input_references.unshift(dataRef(previous));
  assert.equal(f.requests[1].body, JSON.stringify(expected));
  assert.equal(f.requests[1].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(edited.provenance.origin, 'ai-manipulated');
});

test('gateway bindings require exact host/model pairs and matching baseUrl, with loopback fixtures excepted', () => {
  for (const endpoint of ['https://api.openai.com/v1', 'https://openrouter.ai.evil.test/api/v1', 'https://example.test/api/v1',
    'https://openrouter.ai:444/api/v1', 'https://openrouter.ai/v1', 'https://www.openrouter.ai/api/v1']) {
    assert.throws(() => fake({ admitted: binding({ endpoint }) }), /route/u);
  }
  for (const endpoint of ['https://openrouter.ai/api/v1', 'https://example.test/v1', 'https://api.openai.com/images']) {
    assert.throws(() => fake({ admitted: binding({ endpoint, model: 'gpt-image-2' }) }), /route/u);
  }
  assert.throws(() => fake({ admitted: binding({ endpoint: 'http://openrouter.ai/api/v1' }) }), /loopback/u);
  assert.throws(() => createOpenAIImages({ binding: binding(), baseUrl: 'https://api.openai.com/v1' }), /match/u);
  for (const model of ['other', 'openai/gpt-image-1']) assert.throws(() => fake({ admitted: binding({ model }) }), /binding/u);
  assert.throws(() => fake({ admitted: binding({ effort: 'high' }) }), /effort/u);
  assert.doesNotThrow(() => fake({ admitted: binding({ endpoint: 'https://openrouter.ai/api/v1/' }) }));
  assert.doesNotThrow(() => fake({ admitted: binding({ endpoint: 'https://api.openai.com/v1', model: 'gpt-image-2' }) }));
  for (const model of ['gpt-image-2', 'openai/gpt-image-2']) for (const endpoint of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) {
    assert.doesNotThrow(() => fake({ admitted: binding({ endpoint, model }) }));
  }
});

test('routing attribution is optional, validated and never sent in the JSON or direct-mode headers', async () => {
  for (const routing of [{}, { title: 'Host' }, { referer: 'https://host.example.test' }]) {
    const f = fake({ admitted: binding({ routing }) }); await f.plugin.generate(spec, '', options());
    assert.deepEqual(f.requests[0].headers, { authorization: 'Bearer fixture-only', 'content-type': 'application/json',
      ...(routing.title ? { 'x-title': routing.title } : {}), ...(routing.referer ? { 'http-referer': routing.referer } : {}) });
    assert.equal('routing' in JSON.parse(f.requests[0].body), false);
  }
  for (const field of ['referer', 'title']) for (const value of [null, 1, '', ' ', 'bad\r\ninjected: header', 'bad\u0000']) {
    assert.throws(() => fake({ admitted: binding({ routing: { [field]: value } }) }), /attribution/u);
  }
  const f = fake({ admitted: binding({ model: 'gpt-image-2', endpoint: 'https://api.openai.com/v1' }) });
  await f.plugin.generate(spec, '', options());
  assert.deepEqual(f.requests[0].headers, { authorization: 'Bearer fixture-only', 'content-type': 'application/json' });
  assert.equal(f.plugin.label, 'OpenAI Images — gpt-image-2');
  assert.equal(f.plugin.bind(binding()).label, 'OpenAI Images via OpenRouter — gpt-image-2');
});

test('gateway references share the nine-image bound including the previous artifact', async () => {
  const f = fake(), references = Array(9).fill(ref());
  await f.plugin.generate({ ...spec, references }, '', options());
  assert.equal(JSON.parse(f.requests[0].body).input_references.length, 9);
  await f.plugin.edit(source(), { ...spec, references: references.slice(1) }, feedback, options());
  assert.equal(JSON.parse(f.requests[1].body).input_references.length, 9);
  for (const operation of ['generate', 'edit']) {
    const o = options(), input = { ...spec, references: Array(operation === 'edit' ? 9 : 10).fill(ref()) };
    await assert.rejects(operation === 'edit' ? f.plugin.edit(source(), input, feedback, o) : f.plugin.generate(input, '', o), { code: 'limit' });
    assert.deepEqual(o.reports[0].usage, { inputTokens: 0, outputTokens: 0 });
  }
  assert.equal(f.requests.length, 2);
});

test('gateway validates reference bytes, media types, roles and size before dispatch for generate and edit', async () => {
  const f = fake(), valid = ref();
  const cases = [[[{ ...valid, bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) }], 'limit'],
    [[{ ...valid, mediaType: 'image/png' }], 'invalid-output'], [[{ ...valid, role: 'other' }], 'invalid-output'],
    [[{ url: 'https://example.test/image', mediaType: 'image/webp', role: 'upload' }], 'invalid-output'],
    [[{ ...valid, bytes: Buffer.from('text') }], 'invalid-output'], [null, 'invalid-output']];
  for (const [references, code] of cases) for (const operation of ['generate', 'edit']) {
    const o = options(), input = { ...spec, references };
    await assert.rejects(operation === 'edit' ? f.plugin.edit(source(), input, feedback, o) : f.plugin.generate(input, '', o), { code });
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
  const invalid = source(); invalid.width = 2;
  await assert.rejects(f.plugin.edit(invalid, spec, feedback, options()), { code: 'invalid-output' });
  assert.equal(f.requests.length, 0);
});

test('gateway keeps the exact 12 MiB input boundary and rejects an oversized previous artifact', async () => {
  const bytes = withCredential(png, { type: 'tEXt', payload: Buffer.alloc(MAX_IMAGE_BYTES - png.length - 12) });
  assert.equal(bytes.length, MAX_IMAGE_BYTES);
  const f = fake(); await f.plugin.generate({ ...spec, references: [ref(bytes, 'image/png')] }, '', options());
  const previous = source(); previous.bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
  await assert.rejects(f.plugin.edit(previous, spec, feedback, options()), { code: 'limit' });
  assert.equal(f.requests.length, 1);
});

test('gateway preserves fieldsFor input policy and rejects empty edit feedback before dispatch', async () => {
  const f = fake();
  for (const [input, code] of [[null, 'invalid-output'], [{ prompt: ' ' }, 'invalid-output'],
    [{ ...spec, size: 'auto' }, 'invalid-output'], [{ ...spec, quality: 'ultra' }, 'invalid-output'],
    [{ ...spec, format: 'jpeg' }, 'invalid-output'], [{ prompt: 'x'.repeat(32001) }, 'limit']]) {
    await assert.rejects(f.plugin.generate(input, '', options()), { code });
  }
  await assert.rejects(f.plugin.edit(source(), spec, ' ', options()), { code: 'invalid-output' });
  assert.equal(f.requests.length, 0);
});

test('gateway accepts PNG and WebP bytes intact and refuses JPEG, invalid base64, broken containers and multiple outputs', async () => {
  for (const bytes of [png, webp, withCredential(png)]) {
    const f = fake({ respond: () => Response.json(payload({ data: [{ b64_json: bytes.toString('base64') }] })) });
    const result = await f.plugin.generate(spec, '', options());
    assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), bytes);
  }
  for (const data of [[{ b64_json: jpeg.toString('base64') }], [{ b64_json: '!!!=' }], [{ b64_json: 'Zh==' }],
    [{ b64_json: png.subarray(0, -1).toString('base64') }], [{ b64_json: '' }], [{ b64_json: 1 }], [], [{}, {}], [{}]]) {
    const f = fake({ respond: () => Response.json(payload({ data })) }), o = options();
    await assert.rejects(f.plugin.generate(spec, '', o), { code: 'invalid-output' });
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'cancelled',
      usage: { inputTokens: 11, outputTokens: 23 }, chargedMicro: 12346 }]);
  }
  const f = fake({ respond: () => new Response('{broken') });
  await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'invalid-output' });
});

test('gateway refuses URL-only responses even with a direct-mode origin allowlist and retains actual charges', async () => {
  const f = fake({ admitted: binding({ routing: { imageOrigins: ['https://images.example.test'] } }),
    respond: () => Response.json(payload({ data: [{ url: 'https://images.example.test/result.png' }] })) }), o = options();
  await assert.rejects(f.plugin.generate(spec, '', o), { code: 'invalid-output' });
  assert.equal(f.requests.length, 1); assert.equal(o.reports[0].chargedMicro, 12346);
});

test('gateway cost is authoritative, rounded up once, independent of tokens and never capped to private rates', async () => {
  for (const [cost, chargedMicro] of [[0, 0], [0.07, 70000], [0.00000001, 1], [1.0000001, 1000001], [2, 2000000]]) {
    const f = fake({ respond: () => Response.json(payload({ usage: { cost } })) }), o = options();
    await f.plugin.generate(spec, '', o);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 }, chargedMicro }]);
  }
  const f = fake({ respond: () => Response.json(payload({ usage: { prompt_tokens: 3, completion_tokens: 5, cost: 0.000001 } })) }), o = options();
  await f.plugin.generate(spec, '', o); assert.deepEqual(o.reports[0].usage, { inputTokens: 3, outputTokens: 5 });
});

test('gateway missing/invalid costs remain uncertain while retaining known tokens; no missing cost becomes zero', async () => {
  for (const cost of [undefined, null, '0.01', -1, {}, 1e20]) {
    const f = fake({ respond: () => Response.json(payload({ usage: { input_tokens: 11, output_tokens: 23, cost } })) }), o = options();
    await f.plugin.generate(spec, '', o);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'uncertain', usage: { inputTokens: 11, outputTokens: 23 } }]);
  }
  const f = fake({ respond: () => Response.json(payload({ usage: undefined })) }), o = options();
  await f.plugin.generate(spec, '', o); assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'uncertain' }]);
});

for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [500, 'provider'], [503, 'provider']]) {
  test(`gateway HTTP ${status} maps to ${code} and leaves unknown spend uncertain`, async () => {
    const f = fake({ respond: () => new Response('private details', { status }) }), o = options();
    await assert.rejects(f.plugin.generate(spec, '', o), error => error.code === code && error.message === code);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'uncertain' }]);
  });
}

test('gateway response caps declared and streamed JSON at 18 MiB and decoded images at 12 MiB', async () => {
  for (const respond of [() => new Response('{}', { headers: { 'content-length': 18 * 1024 * 1024 + 1 } }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(18 * 1024 * 1024 + 1)); controller.close();
    } })), () => Response.json(payload({ data: [{ b64_json: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }] }))]) {
    const f = fake({ respond }); await assert.rejects(f.plugin.generate(spec, '', options()), { code: 'limit' });
  }
});

test('gateway active abort/deadline terminate uncooperative transport and body reads with one uncertain report', async () => {
  for (const stallBody of [false, true]) for (const deadline of [false, true]) {
    let started; const dispatched = new Promise(resolve => { started = resolve; });
    const f = fake({ respond: () => { started(); return stallBody ? new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{'));
    } })) : new Promise(() => {}); } });
    const controller = new AbortController(), o = options({ signal: controller.signal, deadlineAt: Date.now() + (deadline ? 100 : 2000) });
    const pending = f.plugin.generate(spec, '', o); await dispatched;
    if (!deadline) controller.abort();
    await assert.rejects(pending, { code: deadline ? 'deadline' : 'cancelled' });
    assert.equal(f.requests[0].signal.aborted, true);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'uncertain' }]);
  }
});

test('gateway missing secret and preflight lifetimes remain cancelled-zero and never dispatch', async () => {
  const controller = new AbortController(); controller.abort();
  for (const [extra, code] of [[{ signal: controller.signal }, 'cancelled'], [{ deadlineAt: Date.now() - 1 }, 'deadline'], [{}, 'auth']]) {
    const f = fake({ resolveSecret: () => undefined }), o = options(extra);
    await assert.rejects(f.plugin.generate(spec, '', o), { code }); assert.equal(f.requests.length, 0);
    assert.deepEqual(o.reports, [{ attemptId: o.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
});

test('gateway awaits claim and terminal persistence; refused authority cannot dispatch', async () => {
  const f = fake(), o = options(); let claim, persist, returned = false;
  o.attempt.consume = () => new Promise(resolve => { claim = resolve; });
  o.report = terminal => { o.reports.push(terminal); return new Promise(resolve => { persist = resolve; }); };
  const pending = f.plugin.generate(spec, '', o).then(() => { returned = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests.length, 0); claim();
  while (!persist) await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false); persist(); await pending;
  const denied = options(); denied.attempt.consume = () => { throw new PluginError('not-admitted'); };
  await assert.rejects(f.plugin.generate(spec, '', denied), { code: 'not-admitted' }); assert.equal(f.requests.length, 1);
});

test('gateway passes reusable UI kind conformance with in-memory active stalls', async () => {
  const f = fake({ respond: (_url, init) => JSON.parse(init.body).prompt.includes('fixture-stall')
    ? new Promise(() => {}) : Response.json(payload()) });
  assert.deepEqual(await uiGenerationConformance(f.plugin, { spec: { ...spec, references: [ref()] }, feedback, artifact: source() },
    { stallSpec: { prompt: 'fixture-stall' }, stallFeedback: 'fixture-stall', requestCount: () => f.requests.length,
      expectedUsage: { inputTokens: 11, outputTokens: 23 } }), { ok: true, failures: [] });
});

test('gateway model manifest is unverified and host legal fixture yields OpenRouter recipient plus OpenAI processor in both scopes', () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  const model = manifest.models.find(model => model.id === 'openai/gpt-image-2');
  assert.deepEqual(model.operations, ['generate', 'edit']); assert.deepEqual(model.formats, ['image/png', 'image/webp']);
  assert.equal(model.qualification, 'unverified'); assert.equal(model.cost.inputMicro, null); assert.ok(model.evidence.length);
  const now = 1000, admitted = binding();
  // Synthetic account evidence: these values assert no real provider legal policy.
  admitted.legal = { approved: true, purpose: 'fixture-concept-images', recipient: 'OpenRouter, Inc.', processors: ['OpenAI'],
    countries: ['US'], processingCountries: ['US'], training: true, retention: 'fixture-only-unverified',
    dataCategories: ['prompt', 'reference-images'], consentVersion: 'fixture-images-v1',
    evidence: { qualified: true, accountRef: admitted.accountRef, secretRef: admitted.secretRef,
      model: admitted.model, endpoint: admitted.endpoint, routing: admitted.routing, verifiedAt: now - 1, expiresAt: now + 1000 } };
  const { plugin } = fake({ admitted });
  assert.equal(bindingReason({ binding: plugin.binding, plugin, preset: 'best', now, policy: { endpoints: [admitted.endpoint] } }), null);
  assert.equal(createOpenAIImages({ binding: binding() }).binding.legal, undefined, 'adapter must not invent host legal policy');
  for (const operation of ['generate', 'edit']) {
    const scope = processingScope(plugin.binding, operation);
    assert.deepEqual(scope.recipients, ['OpenRouter, Inc.']); assert.deepEqual(scope.upstreamProcessors, ['OpenAI']);
    const grant = { ...scope, scope, covered: true, consentRevision: 1, checkedAt: now, expiresAt: now + 1000 };
    assert.equal(coversProcessingScope(grant, scope, 1, now), true);
    assert.equal(coversProcessingScope({ ...grant, recipients: [] }, scope, 1, now), false);
    assert.equal(coversProcessingScope({ ...grant, upstreamProcessors: [] }, scope, 1, now), false);
  }
});
