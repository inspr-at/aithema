import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterReasoning } from '../src/index.js';
import { requestInputTokens, requestCeilingMicro } from '../src/pricing.js';
import { openRouterPrices } from '../../../test/plugin-fixtures.js';
const imageInput = { maxImages: 4, maxTokensPerImage: 1600, perImageMicro: 25 };
const image = { uploadId: 'image', digest: 'fixture', w: 2, h: 1, mediaType: 'image/png' };
const request = { system: 'Fixture policy', messages: [{ role: 'user', content: 'Caption', images: [image] }],
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } };
const binding = { plugin: 'openrouter', model: 'fixture/model', endpoint: 'https://example.test/chat', effort: 'none', accountRef: 'fixture', secretRef: 'fixture',
  maxMicro: 1000000, maxTokens: 100, rates: { inputMicro: 1, outputMicro: 1 }, imageInput };
for (const operation of ['stream', 'structured']) test(`AIT-510: ${operation} resolves owner references only after claim and sends pixel data`, async () => {
  let consumed = false, resolved = 0, wire;
  const pixels = Buffer.from('normalized-pixel-fixture');
  const plugin = createOpenRouterReasoning({ binding, prices: openRouterPrices, resolveSecret: () => 'fixture', fetchImpl: async (url, init) => {
    wire = JSON.parse(init.body);
    assert.equal(consumed, true); assert.equal(resolved, 1);
    const parts = wire.messages.at(-1).content;
    assert.deepEqual(parts, [{ type: 'text', text: 'Caption' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${pixels.toString('base64')}` } }]);
    assert.equal(JSON.stringify(wire).includes('uploadId'), false);
    return operation === 'stream' ? new Response('data: {"choices":[{"delta":{"content":"Known pixels"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1600,"completion_tokens":5,"cost":0}}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: '{"summary":"Known pixels"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1600, completion_tokens: 5, cost: 0 } });
  } });
  const options = { deadlineAt: Date.now() + 25000, signal: new AbortController().signal,
    attempt: { attemptId: 'fixture', claimId: 'fixture', consume() { consumed = true; } }, report() {},
    resolveImage(reference) { assert.equal(consumed, true); assert.deepEqual(reference, image); resolved++; return pixels; } };
  if (operation === 'stream') { for await (const delta of plugin.stream(request, options)) assert.equal(delta, 'Known pixels'); }
  else assert.deepEqual(await plugin.structured(request, options), { summary: 'Known pixels' });
  const body = { messages: [{ role: 'system', content: request.system }, ...request.messages], max_tokens: 100 };
  const plain = { ...body, messages: body.messages.map(({ images, ...message }) => message) };
  assert.equal(requestInputTokens(body, imageInput), requestInputTokens(plain) + 1600);
  assert.equal(requestCeilingMicro(body, { prompt: 0, completion: 0 }, imageInput), 25);
});
test('AIT-510: a text-only binding refuses image input before bytes or network access', async () => {
  const { imageInput: omitted, ...textOnly } = binding;
  const plugin = createOpenRouterReasoning({ binding: textOnly, prices: openRouterPrices, resolveSecret: () => 'fixture', fetchImpl: async () => assert.fail('No dispatch') });
  assert.throws(() => plugin.estimateCost(request, 'stream'), /image/iu);
});
