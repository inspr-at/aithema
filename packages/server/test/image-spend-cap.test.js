import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createSpendCap } from '../src/index.js';
import { createOpenAIImages } from '../../../plugins/openai-images/src/index.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { png } from '../../../test/image-fixtures.js';

const spec = { prompt: 'A fixture workspace' };
const request = { system: '', messages: [{ role: 'user', content: 'Hello' }],
  schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] } };
const options = () => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
const imagePayload = cost => ({ id: 'gen-shared-image', data: [{ b64_json: png.toString('base64') }], usage: { cost } });
const reasoningPayload = cost => ({ id: 'gen-shared-reasoning', usage: { cost },
  choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }] });
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
