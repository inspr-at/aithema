import { createServer } from 'node:http';
import { once } from 'node:events';
import { publicReasoningManifest } from '../packages/core/src/plugins.js';
import { beginInvocation, normalizedError } from '../packages/core/src/invocation.js';
import { operationScope } from '../packages/core/src/reasoning.js';
export const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
export const request = { system: 'Fixture policy', messages: [{ role: 'user', content: 'Hello' }], schema };
export const openRouterPrices = {
  'fixture/model': { prompt: 1e-9, completion: 1e-9 },
  'fixture/understanding': { prompt: 1e-9, completion: 1e-9 },
  'other/model': { prompt: 1e-9, completion: 1e-9 },
};
export function invocationOptions(extra = {}) {
  const reports = []; let burned = false;
  return { reports, signal: new AbortController().signal, deadlineAt: Date.now() + 2000,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {
      if (burned) { const error = new Error('already-claimed'); error.code = 'already-claimed'; throw error; } burned = true;
    } }, report: terminal => reports.push(terminal), ...extra };
}
export function binding(plugin, endpoint, extra = {}) {
  return { plugin, model: plugin === 'openrouter' ? 'fixture/model' : 'fixture-model', endpoint, effort: 'none',
    accountRef: 'fixture-account', secretRef: 'FIXTURE_ONLY', maxMicro: 1000, maxTokens: 40,
    rates: { inputMicro: 1, outputMicro: 2 }, ...extra };
}
export async function chatServer(t, { handler } = {}) {
  const bodies = [], requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
    if (handler) { handler(body, res); return; }
    if (body.messages[0].content === 'stall') {
      res.writeHead(200); res.write(body.stream ? 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n' : '{'); return;
    }
    const usage = { prompt_tokens: 3, completion_tokens: 4 };
    res.end(body.stream ? 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\r\n\r\n' +
      `data: ${JSON.stringify({ choices: [], usage })}\r\n\r\ndata: [DONE]\r\n\r\n`
      : JSON.stringify({ usage, choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Known"}' } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, bodies, requests,
    fetchImpl(url, options) { requests.push(JSON.parse(options.body)); return fetch(url, options); } };
}
// Deliberately broken: ignores authority/lifetime, lies about health and never reports a terminal.
export const brokenReasoning = { manifest: publicReasoningManifest('broken', 'Broken', 'https://example.test'),
  async health() { return { available: 'yes' }; }, async *stream() { yield 'oops'; }, async structured() { return { summary: 'oops' }; } };

// Third-party shape: consume happens inside try, so finally also runs on authority refusal.
export function consumeInFinallyReasoning(plugin, { refusedReport = terminal => terminal } = {}) {
  const terminal = options => refusedReport({ attemptId: options.attempt.attemptId,
    outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
  const consumedOptions = options => ({ ...options, attempt: { ...options.attempt, consume() {} } });
  return { ...plugin,
    async *stream(request, options) {
      let consumed = false;
      try { await options.attempt.consume(); consumed = true; yield* plugin.stream(request, consumedOptions(options)); }
      finally { if (!consumed) await options.report(terminal(options)); }
    },
    async structured(request, options) {
      let consumed = false;
      try { await options.attempt.consume(); consumed = true; return await plugin.structured(request, consumedOptions(options)); }
      finally { if (!consumed) await options.report(terminal(options)); }
    },
  };
}

// Correct stream/authority/reporting, but structured only checks lifetime before opening the fixture.
export function brokenPreflightReasoning(plugin, { fetchImpl = globalThis.fetch } = {}) {
  return { ...plugin, async structured(request, options) {
    const invocation = await beginInvocation(options), scope = operationScope(options); let completed = false;
    try {
      scope.signal.throwIfAborted();
      invocation.dispatch();
      // Independent cleanup deadline limits this deliberately broken fixture's lifetime.
      const response = await fetchImpl(plugin.binding.endpoint, { method: 'POST', signal: AbortSignal.timeout(250),
        body: JSON.stringify({ messages: [{ role: 'system', content: request.system }], stream: false }) });
      const result = await response.json();
      invocation.usage({ inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens });
      completed = true; return JSON.parse(result.choices[0].message.content);
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { scope.dispose(); await invocation.finish(completed); }
  } };
}
