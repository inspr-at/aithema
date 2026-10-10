import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenRouterReasoning } from '../src/index.js';
import { openRouterPrices } from '../../../test/plugin-fixtures.js';
import { openRouterConfig } from '../../../demo/openrouter-config.js';
const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
const request = { system: 'Generic policy', messages: [{ role: 'user', content: 'Hello' }], schema };
const options = (extra = {}) => {
  let consumed = false;
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 2000,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() { assert.equal(consumed, false); consumed = true; } }, report() {}, ...extra };
};
async function fake(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return createOpenRouterReasoning({ prices: openRouterPrices, resolveSecret: () => 'local-fixture', model: 'fixture/model', endpoint: `http://127.0.0.1:${server.address().port}/chat/completions` });
}
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); }

test('streaming parser handles comments, CRLF, split Unicode and JSON chunks', async t => {
  let sent;
  const plugin = await fake(t, async (req, res) => {
    sent = await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const data = Buffer.from(': comment\r\n\r\ndata: {"choices":[{"delta":{"content":"Hé"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (let i = 0; i < data.length; i += 3) { res.write(data.subarray(i, i + 3)); await new Promise(r => setImmediate(r)); }
    res.end();
  });
  const deltas = []; for await (const delta of plugin.stream(request, options())) deltas.push(delta);
  assert.equal(deltas.join(''), 'Héllo'); assert.equal(sent.model, 'fixture/model'); assert.equal(sent.stream, true);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.provider.require_parameters, true);
  assert.deepEqual(sent.reasoning, { enabled: false });
});
test('structured output uses strict JSON Schema and requires parameter-capable routing', async t => {
  let sent;
  const plugin = await fake(t, async (req, res) => {
    sent = await body(req); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] }));
  });
  assert.deepEqual(await plugin.structured(request, options()), { summary: 'Known' });
  assert.equal(sent.response_format.type, 'json_schema'); assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(sent.response_format.json_schema.schema, schema); assert.equal(sent.provider.require_parameters, true);
  assert.deepEqual(sent.reasoning, { enabled: false });
});

test('START bindings send lane-specific routing and reserve the configured reply/analysis token ceilings', async () => {
  const prices = { 'openai/fixture': { prompt: 0.000001, completion: 0.000002 },
    'anthropic/fixture': { prompt: 0.000003, completion: 0.000004 },
    '~anthropic/claude-opus-latest': { prompt: 0.000001, completion: 0.000002 },
    '~anthropic/claude-haiku-latest': { prompt: 0.000003, completion: 0.000004 } };
  const messageBytes = new TextEncoder().encode(JSON.stringify([{ role: 'system', content: request.system }, ...request.messages])).byteLength;
  for (const [env, replyCap, analysisCap, only, ignore] of [
    [{}, 1200, 8000, undefined, ['Azure']],
    [{ OPENROUTER_MAX_TOKENS: '37', OPENROUTER_ANALYSIS_MAX_TOKENS: '63',
      OPENROUTER_PROVIDER_ONLY: ' Anthropic, ,OpenAI ', OPENROUTER_ANALYSIS_PROVIDER_IGNORE: 'Azure, Microsoft' },
    37, 63, ['Anthropic', 'OpenAI'], ['Azure', 'Microsoft']],
    [{ OPENROUTER_PROVIDER_ONLY: ',', OPENROUTER_ANALYSIS_PROVIDER_IGNORE: ',' }, 1200, 8000, undefined, undefined],
    [{ OPENROUTER_MODEL: '~anthropic/claude-opus-latest', OPENROUTER_SPEECH_MODEL: '~anthropic/claude-haiku-latest',
      OPENROUTER_ANALYSIS_EFFORT: 'low', OPENROUTER_PROVIDER_ONLY: 'Anthropic' }, 1200, 8000, ['Anthropic'], ['Azure']],
  ]) {
    const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/fixture', OPENROUTER_SPEECH_MODEL: 'anthropic/fixture',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify(prices), ...env });
    const bodies = [], ceilings = [], reports = [];
    const plugin = createOpenRouterReasoning({ binding: configured.reaction, prices: configured.prices,
      resolveSecret: () => 'local-fixture',
      spendCap: { reserve(ceiling) { ceilings.push(ceiling); return Symbol('hold'); }, settle() {} },
      fetchImpl: async (url, init) => {
        const sent = JSON.parse(init.body); bodies.push(sent);
        return sent.stream ? new Response(`data: ${JSON.stringify({ model: 'anthropic/claude-haiku-5.5',
          choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] })}\n\n` +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"cost":0}}\n\ndata: [DONE]\n\n')
          : Response.json({ model: 'anthropic/claude-opus-5.5', usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0 },
            choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] });
      } });
    const deltas = []; for await (const delta of plugin.stream(request, options({ report: terminal => reports.push(terminal) }))) deltas.push(delta);
    assert.equal(deltas.join(''), 'Hello');
    assert.deepEqual(await plugin.bind(configured.understanding).structured(request,
      options({ report: terminal => reports.push(terminal) })), { summary: 'Known' });
    assert.deepEqual(bodies.map(body => body.max_tokens), [replyCap, analysisCap]);
    assert.deepEqual(ceilings, [messageBytes * 3 + replyCap * 4, messageBytes + analysisCap * 2]);
    assert.deepEqual(bodies.map(body => body.model), [configured.reaction.model, configured.understanding.model]);
    assert.deepEqual(reports.map(report => [report.outcome, report.servedModel, report.usage]), [
      ['completed', 'anthropic/claude-haiku-5.5', { inputTokens: 3, outputTokens: 4 }],
      ['completed', 'anthropic/claude-opus-5.5', { inputTokens: 3, outputTokens: 4 }],
    ]);
    assert.deepEqual(bodies.map(body => body.reasoning), [{ enabled: false },
      env.OPENROUTER_ANALYSIS_EFFORT ? { effort: 'low' } : { enabled: false }]);
    for (const sent of bodies) {
      assert.equal(sent.provider.require_parameters, true);
      assert.deepEqual(sent.provider.only, only);
      assert.equal(Object.hasOwn(sent.provider, 'only'), Boolean(only));
    }
    assert.equal(Object.hasOwn(bodies[0].provider, 'ignore'), false);
    assert.deepEqual(bodies[1].provider.ignore, ignore);
    assert.equal(Object.hasOwn(bodies[1].provider, 'ignore'), Boolean(ignore));
    assert.deepEqual(bodies.map(body => body.provider.max_price), [{ prompt: 3, completion: 4 }, { prompt: 1, completion: 2 }]);
  }
});
test('decimal per-million ceilings stay exact in bindings and serialized provider requests', async () => {
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":0.0000042,"completion":2.3e-7}}' });
  const expected = { prompt: 4.2, completion: 0.23 };
  assert.deepEqual(configured.reaction.routing.max_price, expected);
  assert.deepEqual(configured.understanding.routing.max_price, expected);
  let sent;
  const plugin = createOpenRouterReasoning({ binding: configured.reaction, prices: configured.prices,
    resolveSecret: () => 'local-fixture', fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ usage: { cost: 0 }, choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] });
    } });
  await plugin.structured(request, options());
  assert.deepEqual(sent.provider.max_price, expected);
});
test('served model remains per call when usage is missing, and absent model metadata is not guessed', async () => {
  const model = '~anthropic/claude-opus-latest', reports = [];
  let servedModel = 'anthropic/claude-opus-5.5';
  const plugin = createOpenRouterReasoning({ model, prices: { [model]: { prompt: 1e-9, completion: 1e-9 } },
    resolveSecret: () => 'local-fixture', fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body), payload = { model: servedModel, choices: body.stream
        ? [{ delta: { content: 'Hello' }, finish_reason: 'stop' }]
        : [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] };
      return body.stream ? new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`) : Response.json(payload);
    } });
  for (const stream of [true, false]) {
    const opts = options({ report: terminal => reports.push(terminal) });
    if (stream) for await (const delta of plugin.stream(request, opts)) assert.equal(delta, 'Hello');
    else await plugin.structured(request, opts);
  }
  assert.deepEqual(reports.map(report => [report.outcome, report.servedModel]), [
    ['uncertain', 'anthropic/claude-opus-5.5'], ['uncertain', 'anthropic/claude-opus-5.5'],
  ]);
  servedModel = undefined;
  await plugin.structured(request, options({ report: terminal => reports.push(terminal) }));
  assert.equal(Object.hasOwn(reports[2], 'servedModel'), false);
});
test('served model receipts accept only 1–128 model-id characters in streaming and structured responses', async () => {
  const model = '~anthropic/claude-opus-latest';
  const valid = ['a', '~anthropic/Claude_opus-5.5:latest', 'a'.repeat(128)];
  const invalid = [undefined, null, 17, '', ' ', 'a'.repeat(129), 'anthropic/model name', 'anthropic/model\n',
    'anthropic/model\r', 'anthropic/model\t', 'anthropic/mödel', 'anthropic/<script>', 'anthropic/model?x=1'];
  for (const servedModel of [...valid, ...invalid]) {
    const reports = [], plugin = createOpenRouterReasoning({ model, prices: { [model]: { prompt: 1e-9, completion: 1e-9 } },
      resolveSecret: () => 'local-fixture', fetchImpl: async (url, init) => {
        const { stream } = JSON.parse(init.body), payload = { model: servedModel, usage: { prompt_tokens: 3, completion_tokens: 4 },
          choices: stream ? [{ delta: { content: 'Hello' }, finish_reason: 'stop' }]
            : [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] };
        return stream ? new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`) : Response.json(payload);
      } });
    for (const stream of [true, false]) {
      const opts = options({ report: terminal => reports.push(terminal) });
      if (stream) for await (const delta of plugin.stream(request, opts)) assert.equal(delta, 'Hello');
      else assert.deepEqual(await plugin.structured(request, opts), { summary: 'Known' });
    }
    assert.equal(reports.length, 2);
    for (const report of reports) {
      assert.equal(report.outcome, 'completed'); assert.deepEqual(report.usage, { inputTokens: 3, outputTokens: 4 });
      assert.equal(Object.hasOwn(report, 'servedModel'), valid.includes(servedModel));
      if (valid.includes(servedModel)) assert.equal(report.servedModel, servedModel);
    }
  }
});
test('AbortSignal cancels an active streaming response', async t => {
  const plugin = await fake(t, async (req, res) => { await body(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'); });
  const controller = new AbortController(), stream = plugin.stream(request, options({ signal: controller.signal }));
  assert.equal((await stream.next()).value, 'first'); controller.abort(); await assert.rejects(stream.next(), /abort/iu);
});
test('AbortSignal cancels structured output waiting for response body', async t => {
  let ready; const started = new Promise(r => { ready = r; });
  const plugin = await fake(t, async (req, res) => { await body(req); res.writeHead(200); res.write('{'); ready(); });
  const controller = new AbortController();
  const pending = plugin.structured(request, options({ signal: controller.signal }));
  await started; controller.abort(); await assert.rejects(pending, /abort/iu);
});
test('deadline cancels a stalled provider and an expired deadline never dispatches', async t => {
  let calls = 0;
  const plugin = await fake(t, () => { calls++; });
  await assert.rejects(plugin.structured(request, options({ deadlineAt: Date.now() + 30 })), /deadline/iu);
  const before = calls; await assert.rejects(plugin.structured(request, options({ deadlineAt: Date.now() - 1 })), /deadline/iu);
  assert.equal(calls, before);
});
test('malformed schema content and non-stop finish are sanitized failures', async t => {
  let finish = 'stop';
  const plugin = await fake(t, async (req, res) => { await body(req); res.end(JSON.stringify({ choices: [{ finish_reason: finish,
    message: { content: '{"wrong":"private-provider-detail"}' } }] })); });
  await assert.rejects(plugin.structured(request, options()), error => error.message === 'Invalid OpenRouter structured output');
  finish = 'length'; await assert.rejects(plugin.structured(request, options()), /Invalid OpenRouter/);
});
test('streaming provider error and truncated SSE never pass as completed', async t => {
  let error = true;
  const plugin = await fake(t, async (req, res) => { await body(req); res.end(error
    ? 'data: {"error":{"message":"private-provider-detail"}}\n\n' : 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
  const collect = async () => { for await (const chunk of plugin.stream(request, options())) void chunk; };
  await assert.rejects(collect(), err => err.message === 'OpenRouter stream failed'); error = false;
  await assert.rejects(collect(), /Incomplete/);
});

test('OpenRouter passes shared conformance with usage and no silent routing fallback', async t => {
  const { chatServer, binding, request } = await import('../../../test/plugin-fixtures.js');
  const { reasoningConformance } = await import('@inspr/aithema-core');
  const fake = await chatServer(t), plugin = createOpenRouterReasoning({ binding: binding('openrouter', fake.endpoint), prices: openRouterPrices, fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  assert.deepEqual(await reasoningConformance(plugin, request, { stallRequest: { ...request, system: 'stall' }, requestCount: () => fake.requests.length }), { ok: true, failures: [] });
  assert.equal(fake.bodies[0].provider.allow_fallbacks, false);
  assert.equal(fake.bodies[0].max_tokens, 40);
});
