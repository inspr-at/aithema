import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenRouterReasoning } from '../src/index.js';
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
  return createOpenRouterReasoning({ resolveSecret: () => 'local-fixture', model: 'fixture/model', endpoint: `http://127.0.0.1:${server.address().port}/chat/completions` });
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
  const fake = await chatServer(t), plugin = createOpenRouterReasoning({ binding: binding('openrouter', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  assert.deepEqual(await reasoningConformance(plugin, request, { stallRequest: { ...request, system: 'stall' }, requestCount: () => fake.requests.length }), { ok: true, failures: [] });
  assert.equal(fake.bodies[0].provider.allow_fallbacks, false);
  assert.equal(fake.bodies[0].max_tokens, 40);
});
