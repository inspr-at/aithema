import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticTransport } from '../scripts/understanding-diagnostic-transport.mjs';

const privateValue = 'PRIVATE_CANARY_DO_NOT_PRINT';
const request = {
  model: 'anthropic/fixture', messages: [{ role: 'system', content: privateValue }, { role: 'user', content: privateValue }],
  stream: false, max_tokens: 8000, reasoning: { effort: 'high' },
  response_format: { type: 'json_schema', json_schema: { name: privateValue, schema: { type: 'object',
    properties: { summary: { type: 'string', description: privateValue }, progress: { properties: { privateValue: {} } } } } } },
  provider: { only: [privateValue], ignore: [privateValue], allow_fallbacks: false, require_parameters: true },
};
async function run(response, body = request) {
  const rows = [], times = [100, 112];
  const fetch = createDiagnosticTransport({ fetchImpl: async () => response, write: row => rows.push(row), now: () => times.shift() });
  const observed = await fetch('https://diagnostic.invalid', { body: JSON.stringify(body), headers: { authorization: privateValue } });
  const bytes = await observed.text();
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|description|authorization|content|message"|privateValue/u);
  return { row: rows[0], bytes };
}

test('AIT-198 wire record has exactly the value-free shape, including zero cost and numeric provider code', async () => {
  const payload = { usage: { cost: 0 }, error: { code: 400, message: privateValue, metadata: { raw: privateValue } },
    choices: [{ finish_reason: 'stop', message: { content: privateValue } }] };
  const { row, bytes } = await run(Response.json(payload, { status: 400 }));
  assert.deepEqual(JSON.parse(bytes), payload);
  assert.deepEqual(row, {
    case: 'provider-call', lane: 'understanding', call_order: 1, offset_ms: 12,
    http_status_class: '4xx', http_status: 400, provider_error_code: 400, provider_error_type: null, finish_reason: 'stop',
    usage_present: true, usage_cost_present: true,
    request_shape: {
      parameter_keys: Object.keys(request).sort(), message_count: 2, roles: ['system', 'user'],
      response_format_present: true, response_format_type: 'json_schema', schema_property_keys: ['progress', 'summary'],
      provider_routing_present: { only: true, ignore: true, allow_fallbacks: true, require_parameters: true },
      reasoning_present: true, effort_present: true, max_tokens: 8000, model: 'anthropic/fixture',
    },
    stream_end: { requested: false, done_seen: false, terminal_event_seen: false, state: 'eof' },
    observation_truncated: false,
  });
});

test('AIT-198 absent request options remain explicit and ordered calls get dispatch offsets', async () => {
  const rows = [], ticks = [0, 1, 7];
  const fetch = createDiagnosticTransport({ fetchImpl: async () => new Response(''), write: row => rows.push(row), now: () => ticks.shift() });
  for (let index = 0; index < 2; index++) await (await fetch('', { body: JSON.stringify({ model: 'fixture', messages: [], stream: true }) })).text();
  assert.deepEqual(rows.map(row => [row.call_order, row.offset_ms, row.lane]), [[1, 1, 'reply'], [2, 7, 'reply']]);
  assert.deepEqual(rows[0].request_shape, {
    parameter_keys: ['messages', 'model', 'stream'], message_count: 0, roles: [], response_format_present: false,
    response_format_type: null, schema_property_keys: [], provider_routing_present: { only: false, ignore: false, allow_fallbacks: false, require_parameters: false },
    reasoning_present: false, effort_present: false, max_tokens: null, model: 'fixture',
  });
});

for (const [name, frames, done, terminal, finish] of [
  ['DONE and finish', 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"cost":0}}\r\n\r\ndata: [DONE]\r\n\r\n', true, true, 'stop'],
  ['finish without DONE', 'data: {"choices":[{"finish_reason":"length"}]}\n\n', false, true, 'length'],
  ['DONE without finish', 'data: [DONE]\n\n', true, false, null],
  ['Anthropic terminal', 'event: message_stop\ndata: {"type":"message_stop"}\n\n', false, true, null],
  ['empty stream', '', false, false, null],
]) test(`AIT-198 raw stream end: ${name}, across byte boundaries`, async () => {
  const chunks = new TextEncoder().encode(frames);
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of chunks) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const { row, bytes } = await run(response, { ...request, stream: true });
  assert.equal(bytes, frames);
  assert.deepEqual(row.stream_end, { requested: true, done_seen: done, terminal_event_seen: terminal, state: 'eof' });
  assert.equal(row.finish_reason, finish);
});

test('AIT-198 stream error captures only code/type, never the rejection message', async () => {
  const { row } = await run(new Response(`event: error\ndata: ${JSON.stringify({ error: { code: 'rate_limit', type: 'rate_limit_error', message: privateValue } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }), { ...request, stream: true });
  assert.equal(row.provider_error_code, 'rate_limit');
  assert.equal(row.provider_error_type, 'rate_limit_error');
  assert.equal(row.stream_end.terminal_event_seen, true);
  assert.equal(row.stream_end.done_seen, false);
});

test('AIT-198 transport rejection emits all fields without error text', async () => {
  const rows = [];
  const fetch = createDiagnosticTransport({ fetchImpl: async () => { throw new Error(privateValue); }, write: row => rows.push(row) });
  await assert.rejects(fetch('', { body: JSON.stringify(request) }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].http_status, null);
  assert.equal(rows[0].http_status_class, null);
  assert.equal(rows[0].stream_end.state, 'transport-error');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/u);
});

test('AIT-198 wrapped upstream rejection extracts only its type from metadata.raw', async () => {
  const { row } = await run(Response.json({ error: { code: 400, message: privateValue, metadata: {
    raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: privateValue } }),
  } } }, { status: 400 }));
  assert.equal(row.provider_error_code, 400);
  assert.equal(row.provider_error_type, 'invalid_request_error');
});

test('AIT-198 oversized observation is bounded while the response remains intact', async () => {
  const payload = 'x'.repeat(1_000_001);
  const { row, bytes } = await run(new Response(payload));
  assert.equal(bytes, payload);
  assert.equal(row.observation_truncated, true);
  assert.equal(row.usage_present, false);
});

test('AIT-198 consumer cancellation records observed DONE without draining the source', async () => {
  let reads = 0, cancelled = false;
  const rows = [];
  const fetch = createDiagnosticTransport({ write: row => rows.push(row), fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  const response = await fetch('', { body: JSON.stringify({ ...request, stream: true }) });
  assert.equal(reads, 0);
  const reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].stream_end, { requested: true, done_seen: true, terminal_event_seen: false, state: 'cancelled' });
});
