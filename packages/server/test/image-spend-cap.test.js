import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createSpendCap } from '../src/index.js';
import { createOpenAIImages } from '../../../plugins/openai-images/src/index.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { png } from '../../../test/image-fixtures.js';
import { imageArtifact } from '../../../plugins/openai-images/src/image-artifact.js';
import { createImageBinding, imagePluginBinding, localImageBinding } from '../src/index.js';

const spec = { prompt: 'A fixture workspace' };
const request = { system: '', messages: [{ role: 'user', content: 'Hello' }],
  schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] } };
const options = () => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
const imagePayload = cost => ({ id: 'gen-shared-image', data: [{ b64_json: png.toString('base64') }], usage: { cost } });
const reasoningPayload = cost => ({ id: 'gen-shared-reasoning', usage: { cost },
  choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }] });

test('AIT-308 round 2: real image binding with zero common rates charges the direct ceiling', async t => {
  for (const operation of ['generate', 'edit']) {
    const h = fixture(t, { capMicro: 40 });
    const binding = createImageBinding({ ...localImageBinding, plugin: 'openai-images', model: 'gpt-image-2',
      endpoint: 'https://api.openai.com/v1', maxMicro: 40,
      imageCost: { inputMicro: 2, outputMicro: 3, maxInputTokens: 10, maxOutputTokens: 5 } });
    const plugin = createOpenAIImages({ binding: imagePluginBinding(binding), spendCap: h.cap,
      resolveSecret: () => 'fixture-only', fetchImpl: async () => Response.json({ id: 'gen-zero-common-rates',
        data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 1, output_tokens: 2 } }) });
    const o = options();
    if (operation === 'generate') await plugin.generate(spec, '', o);
    else await plugin.edit(imageArtifact(png, { prompt: spec.prompt, model: binding.model, operation: 'generate' }), spec, 'Make it blue', o);
    assert.deepEqual(h.cap.snapshot(), { spentMicro: 40, reservedMicro: 0, uncertainMicro: 0, capMicro: 40, breached: false });
    assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { generationId: 'gen-zero-common-rates', chargedMicro: 40 });
    await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
  }
});

test('AIT-308 round 2: real image binding charges the per-call admitted imageCost', async t => {
  const h = fixture(t);
  const binding = createImageBinding({ ...localImageBinding, plugin: 'openai-images', model: 'gpt-image-2',
    endpoint: 'https://api.openai.com/v1', maxMicro: 40,
    imageCost: { inputMicro: 2, outputMicro: 3, maxInputTokens: 10, maxOutputTokens: 5 } });
  const plugin = createOpenAIImages({ binding: imagePluginBinding(binding), spendCap: h.cap,
    resolveSecret: () => 'fixture-only', fetchImpl: async () => Response.json({ id: 'gen-admitted-image-cost',
      data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 1, output_tokens: 2 } }) });
  const o = { ...options(), imageCost: binding.imageCost };
  await plugin.generate(spec, '', o);
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 8, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: false });
  assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { generationId: 'gen-admitted-image-cost', chargedMicro: 8 });
});
function fixture(t, { capMicro = 100, imageCeiling = 40, cost = 0.00004, imageFetch, reasoningFetch } = {}) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const cap = createSpendCap({ storage, account: 'start-openrouter', capMicro }), fetches = { images: 0, reasoning: 0 };
  const common = { effort: 'none', endpoint: 'https://openrouter.ai/api/v1', accountRef: 'start-openrouter',
    secretRef: 'fixture-only', maxMicro: imageCeiling, maxTokens: 5, rates: { inputMicro: 0, outputMicro: 0 } };
  const images = createOpenAIImages({ binding: { ...common, plugin: 'openai-images', model: 'openai/gpt-image-2' },
    spendCap: cap, resolveSecret: () => 'fixture-only', fetchImpl: async () => {
      fetches.images++; return imageFetch ? imageFetch() : Response.json(imagePayload(cost));
    } });
  const reasoning = createOpenRouterReasoning({ binding: { ...common, plugin: 'openrouter', model: 'openai/fixture' },
    prices: { 'openai/fixture': { prompt: 5e-7, completion: 1.4e-6 } }, spendCap: cap,
    resolveSecret: () => 'fixture-only', fetchImpl: async () => {
      fetches.reasoning++; return reasoningFetch ? reasoningFetch() : Response.json(reasoningPayload(cost));
    } });
  return { storage, cap, fetches, images, reasoning };
}

test('AIT-326: gateway image generation ID persists on the SQLite reservation without affecting settlement', async t => {
  for (const variant of ['header', 'body', 'absent']) {
    const id = `gen-sqlite-image-${variant}`;
    const h = fixture(t, { imageFetch: () => Response.json({ ...imagePayload(0.00004),
      id: variant === 'body' ? id : undefined }, { headers: variant === 'header' ? { 'X-Generation-Id': id } : {} }) });
    const o = options();
    await h.images.generate(spec, '', o);
    assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { ...(variant === 'absent' ? {} : { generationId: id }), chargedMicro: 40 });
    const row = h.storage.db.prepare('SELECT id,generation_id,actual_micro,state FROM spend_reservations WHERE attempt_id=?').get(o.attempt.attemptId);
    assert.equal(typeof row.id, 'string');
    assert.equal(row.generation_id, variant === 'absent' ? null : id);
    assert.equal(row.actual_micro, 40); assert.equal(row.state, 'confirmed');
    assert.deepEqual(h.cap.snapshot(), { spentMicro: 40, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: false });
  }
});
test('AIT-306: one SQLite spend cap totals reasoning and images; either plugin can exhaust it for the other', async t => {
  for (const last of ['images', 'reasoning']) {
    const h = fixture(t, { capMicro: 80 }), calls = {
      images: () => h.images.generate(spec, '', options()), reasoning: () => h.reasoning.structured(request, options()),
    };
    const first = last === 'images' ? 'reasoning' : 'images';
    await calls[first](); await calls[last]();
    assert.deepEqual(h.cap.snapshot(), { spentMicro: 80, reservedMicro: 0, uncertainMicro: 0, capMicro: 80, breached: false });
    await assert.rejects(calls[first](), { code: 'not-admitted' });
    assert.deepEqual(h.fetches, { images: 1, reasoning: 1 });
  }
});
test('AIT-306: concurrent image and reasoning reservations occupy the same SQLite cap before settlement', async t => {
  const gate = Promise.withResolvers(), imageStarted = Promise.withResolvers(), reasoningStarted = Promise.withResolvers();
  const h = fixture(t, { imageCeiling: 60, imageFetch: async () => {
    imageStarted.resolve(); await gate.promise; return Response.json(imagePayload(0.00001));
  }, reasoningFetch: async () => {
    reasoningStarted.resolve(); await gate.promise; return Response.json(reasoningPayload(0.00001));
  } });
  const imageCall = h.images.generate(spec, '', options()); await imageStarted.promise;
  assert.equal(h.cap.snapshot().reservedMicro, 60);
  const reasoningCall = h.reasoning.structured(request, options()); await reasoningStarted.promise;
  try {
    assert.equal(h.cap.snapshot().reservedMicro, 100);
    await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
    await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
    assert.deepEqual(h.fetches, { images: 1, reasoning: 1 });
  } finally { gate.resolve(); await Promise.all([imageCall, reasoningCall]); }
  assert.equal(h.cap.snapshot().spentMicro, 20); assert.equal(h.cap.snapshot().reservedMicro, 0);
});
test('AIT-306: an image receipt above its admitted ceiling latches a SQLite breach and refuses the next reserve', async t => {
  const h = fixture(t, { cost: 0.00005 }), o = options();
  await h.images.generate(spec, '', o);
  assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { generationId: 'gen-shared-image', chargedMicro: 50 });
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 50, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: true });
  await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
  await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
  assert.deepEqual(h.fetches, { images: 1, reasoning: 0 });
});
test('AIT-306: a missing image receipt retains a SQLite uncertain hold and blocks reasoning', async t => {
  const h = fixture(t, { capMicro: 60, imageCeiling: 60, cost: undefined,
    imageFetch: () => Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  await h.images.generate(spec, '', options());
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 0, reservedMicro: 0, uncertainMicro: 60, capMicro: 60, breached: false });
  await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
  assert.deepEqual(h.fetches, { images: 1, reasoning: 0 });
});

function directFixture(t, { rates, directFetch, ...settings } = {}) {
  const h = fixture(t, settings), directFetches = { count: 0 };
  const direct = createOpenAIImages({ binding: { plugin: 'openai-images', model: 'gpt-image-2', effort: 'none',
    endpoint: 'https://api.openai.com/v1', accountRef: 'start-openrouter', secretRef: 'fixture-only',
    maxMicro: settings.imageCeiling ?? 40, maxTokens: 5, ...(rates ? { rates } : {}) },
  spendCap: h.cap, resolveSecret: () => 'fixture-only', fetchImpl: async () => {
    directFetches.count++;
    return directFetch ? directFetch() : Response.json({ id: 'gen-direct-shared',
      data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 1, output_tokens: 2 } });
  } });
  return { ...h, direct, directFetches };
}
test('AIT-308: exhausted SQLite cap refuses direct generation and edits with zero fetches', async t => {
  const h = directFixture(t, { capMicro: 0 });
  await assert.rejects(h.direct.generate(spec, '', options()), { code: 'not-admitted' });
  await assert.rejects(h.direct.edit(imageArtifact(png, { prompt: spec.prompt, model: 'gpt-image-2', operation: 'generate' }), spec, 'Make it blue', options()), { code: 'not-admitted' });
  assert.equal(h.directFetches.count, 0);
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 0, reservedMicro: 0, uncertainMicro: 0, capMicro: 0, breached: false });
});
test('AIT-308: one SQLite cap totals direct images and gateway images or reasoning in either order', async t => {
  for (const peer of ['images', 'reasoning']) for (const first of ['direct', peer]) {
    const h = directFixture(t, { capMicro: 80 }), o = options(), calls = {
      direct: () => h.direct.generate(spec, '', o), images: () => h.images.generate(spec, '', options()),
      reasoning: () => h.reasoning.structured(request, options()),
    };
    await calls[first](); await calls[first === 'direct' ? peer : 'direct']();
    assert.deepEqual(h.cap.snapshot(), { spentMicro: 80, reservedMicro: 0, uncertainMicro: 0, capMicro: 80, breached: false });
    assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { generationId: 'gen-direct-shared', chargedMicro: 40 });
    for (const call of Object.values(calls)) await assert.rejects(call(), { code: 'not-admitted' });
    assert.equal(h.directFetches.count, 1);
    assert.deepEqual(h.fetches, { images: peer === 'images' ? 1 : 0, reasoning: peer === 'reasoning' ? 1 : 0 });
  }
});
test('AIT-308: concurrent direct and gateway images hold the same SQLite cap before settlement', async t => {
  const gate = Promise.withResolvers(), directStarted = Promise.withResolvers(), gatewayStarted = Promise.withResolvers();
  const h = directFixture(t, { imageCeiling: 50, rates: { inputMicro: 2, outputMicro: 3 }, directFetch: async () => {
    directStarted.resolve(); await gate.promise;
    return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 1, output_tokens: 2 } });
  }, imageFetch: async () => { gatewayStarted.resolve(); await gate.promise; return Response.json(imagePayload(0.00001)); } });
  const directCall = h.direct.generate(spec, '', { ...options(), imageCost: { inputMicro: 2, outputMicro: 3 } }); await directStarted.promise;
  const gatewayCall = h.images.generate(spec, '', options()); await gatewayStarted.promise;
  try {
    assert.equal(h.cap.snapshot().reservedMicro, 100);
    await assert.rejects(h.direct.generate(spec, '', options()), { code: 'not-admitted' });
    await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
    await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
    assert.equal(h.directFetches.count, 1); assert.deepEqual(h.fetches, { images: 1, reasoning: 0 });
  } finally { gate.resolve(); await Promise.all([directCall, gatewayCall]); }
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 18, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: false });
});
test('AIT-308: direct private token charge above its ceiling latches a SQLite breach for both gateways', async t => {
  const h = directFixture(t, { rates: { inputMicro: 10, outputMicro: 20 } }), o = { ...options(), imageCost: { inputMicro: 10, outputMicro: 20 } };
  await h.direct.generate(spec, '', o);
  assert.deepEqual(h.cap.evidence(o.attempt.attemptId), { generationId: 'gen-direct-shared', chargedMicro: 50 });
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 50, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: true });
  await assert.rejects(h.direct.generate(spec, '', options()), { code: 'not-admitted' });
  await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
  await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
  assert.equal(h.directFetches.count, 1); assert.deepEqual(h.fetches, { images: 0, reasoning: 0 });
});
test('AIT-308: unknown direct outcomes retain SQLite uncertain holds and block gateway images and reasoning', async t => {
  for (const rates of [undefined, { inputMicro: 2, outputMicro: 3 }]) {
    const h = directFixture(t, { capMicro: 60, imageCeiling: 60, rates, directFetch() { throw new Error('fixture network failure'); } });
    await assert.rejects(h.direct.generate(spec, '', options()), { code: 'provider' });
    assert.deepEqual(h.cap.snapshot(), { spentMicro: 0, reservedMicro: 0, uncertainMicro: 60, capMicro: 60, breached: false });
    await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
    await assert.rejects(h.reasoning.structured(request, options()), { code: 'not-admitted' });
    assert.deepEqual(h.fetches, { images: 0, reasoning: 0 });
    h.cap.recover(); assert.equal(h.cap.snapshot().uncertainMicro, 60);
  }
});
test('AIT-308: missing direct tokens with private rates stay uncertain while unpriced completion charges the ceiling', async t => {
  for (const priced of [true, false]) {
    const h = directFixture(t, { capMicro: 40, rates: priced ? { inputMicro: 2, outputMicro: 3 } : undefined,
      directFetch: () => Response.json({ data: [{ b64_json: png.toString('base64') }] }) });
    await h.direct.generate(spec, '', { ...options(), ...(priced ? { imageCost: { inputMicro: 2, outputMicro: 3 } } : {}) });
    assert.deepEqual(h.cap.snapshot(), { spentMicro: priced ? 0 : 40, reservedMicro: 0, uncertainMicro: priced ? 40 : 0, capMicro: 40, breached: false });
    await assert.rejects(h.images.generate(spec, '', options()), { code: 'not-admitted' });
  }
});
test('AIT-308: direct pre-dispatch abort releases a real SQLite reservation at zero', async t => {
  const h = directFixture(t), controller = new AbortController(), reserve = h.cap.reserve;
  h.cap.reserve = (...args) => { const handle = reserve(...args); controller.abort(); return handle; };
  await assert.rejects(h.direct.generate(spec, '', { ...options(), signal: controller.signal }), { code: 'cancelled' });
  assert.equal(h.directFetches.count, 0);
  assert.deepEqual(h.cap.snapshot(), { spentMicro: 0, reservedMicro: 0, uncertainMicro: 0, capMicro: 100, breached: false });
});
