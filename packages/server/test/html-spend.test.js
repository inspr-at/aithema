import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createSpendCap } from '../src/index.js';
import { createClaudeHTML, buildMessages, callCeilingMicro } from '../../../plugins/claude-html/src/index.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { requestCeilingMicro } from '../../../plugins/openrouter/src/pricing.js';
import { temporaryDb } from '../../../test/helpers.js';

const spec = { prompt: 'Create a repair click-dummy', language: 'en', understanding: { summary: 'Repairs' } };
const html = '<!doctype html><html><head><title>Repairs</title></head><body><h1>Repairs</h1></body></html>';
const options = () => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
const price = { prompt: 0.0000014, completion: 0.000014 };
const htmlBinding = { plugin: 'claude-html', model: 'anthropic/claude-opus-5.5', endpoint: 'https://example.test/api/v1',
  effort: 'none', accountRef: 'shared', secretRef: 'fixture', maxMicro: 1000000, maxTokens: 5,
  rates: { inputMicro: 2, outputMicro: 14, inputUSD: price.prompt, outputUSD: price.completion },
  routing: { only: ['Anthropic'], ignore: ['Azure'], require_parameters: true } };
const reasoningBinding = { ...htmlBinding, plugin: 'openrouter', model: 'openai/fixture', endpoint: 'https://example.test/api/v1/chat/completions',
  rates: { inputMicro: 0, outputMicro: 0 } };
const reasoningRequest = { system: '', messages: [{ role: 'user', content: 'Hello' }], schema: { type: 'object', properties: { summary: { type: 'string' } } } };

for (const first of ['reasoning', 'html']) test(`${first} spending reduces the other plugin's headroom in one persistent SQLite cap`, async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  const htmlCeiling = callCeilingMicro(buildMessages(spec, '').messages, htmlBinding);
  let reasoningCeiling, dispatches = 0;
  // Capture the exact reasoning wire ceiling with a generous isolated setup.
  const probe = createOpenRouterReasoning({ binding: reasoningBinding, spendCap: createSpendCap({ storage, account: 'probe', capMicro: 1000000 }),
    prices: { [reasoningBinding.model]: price }, resolveSecret: () => 'fake', fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body); reasoningCeiling = requestCeilingMicro(body, price);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
    } });
  await probe.structured(reasoningRequest, options());
  const capMicro = htmlCeiling + reasoningCeiling - 1;
  let spend = createSpendCap({ storage, account: 'shared', capMicro });
  const plugins = () => {
    const fake = async (_, init) => {
      dispatches++; const body = JSON.parse(init.body), isHTML = body.model === htmlBinding.model;
      if (isHTML) {
        assert.deepEqual(body.provider.max_price, { prompt: 1.4, completion: 14 });
        assert.deepEqual(body.provider.only, ['Anthropic']); assert.deepEqual(body.provider.ignore, ['Azure']);
        assert.equal(body.provider.require_parameters, true);
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: isHTML ? html : '{"summary":"ok"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: (isHTML ? htmlCeiling : reasoningCeiling) / 1000000 } });
    };
    return {
      html: createClaudeHTML({ binding: htmlBinding, spend, capMicro, resolveSecret: () => 'fake', fetchImpl: fake }),
      reasoning: createOpenRouterReasoning({ binding: reasoningBinding, spendCap: spend,
        prices: { [reasoningBinding.model]: price }, resolveSecret: () => 'fake', fetchImpl: fake }),
    };
  };
  let p = plugins(); assert.equal(p.html.spend, spend);
  const run = kind => kind === 'html' ? p.html.generate(spec, '', options()) : p.reasoning.structured(reasoningRequest, options());
  await run(first); assert.equal(spend.snapshot().spentMicro, first === 'html' ? htmlCeiling : reasoningCeiling);
  storage.close(); storage = new SQLiteStorage(path); spend = createSpendCap({ storage, account: 'shared', capMicro }); p = plugins();
  await assert.rejects(run(first === 'html' ? 'reasoning' : 'html'));
  assert.equal(dispatches, 1); assert.equal(spend.snapshot().reservedMicro, 0);
});

test('HTML observes persistent shared-cap breaches even when total spend remains below the cap', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  let spend = createSpendCap({ storage, account: 'shared', capMicro: 1000000 });
  const hold = spend.reserve(10); spend.settle(hold, 11);
  storage.close(); storage = new SQLiteStorage(path); spend = createSpendCap({ storage, account: 'shared', capMicro: 1000000 });
  let dispatches = 0;
  const plugin = createClaudeHTML({ binding: htmlBinding, spend, capMicro: 1000000, resolveSecret: () => 'fake',
    fetchImpl: () => { dispatches++; assert.fail('breached cap must not dispatch'); } });
  assert.deepEqual(await plugin.health(options()), { available: false, reason: 'cost ceiling breached' });
  await assert.rejects(plugin.generate(spec, '', options()), { code: 'limit' }); assert.equal(dispatches, 0);
});
