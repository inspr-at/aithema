import { createServer } from 'node:http';
import { once } from 'node:events';
import { publicReasoningManifest } from '../packages/core/src/plugins.js';
export const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
export const request = { system: 'Fixture policy', messages: [{ role: 'user', content: 'Hello' }], schema };
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
  const bodies = [];
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
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, bodies };
}
// Deliberately broken: ignores authority/lifetime, lies about health and never reports a terminal.
export const brokenReasoning = { manifest: publicReasoningManifest('broken', 'Broken', 'https://example.test'),
  async health() { return { available: 'yes' }; }, async *stream() { yield 'oops'; }, async structured() { return { summary: 'oops' }; } };
