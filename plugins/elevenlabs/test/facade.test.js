import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createCompletionsHandler, bearerMatches, MAX_COMPLETION_REQUEST_BYTES } from '../src/facade.js';
import { beginInvocation, normalizedError, PluginError } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { invocationOptions, flush } from './fixtures.js';
import { SQLiteStorage, createPluginRuntime } from '../../../packages/server/src/index.js';
import { PluginRegistry } from '../../../packages/core/src/plugins.js';
import { createOpenRouterReasoning } from '../../openrouter/src/index.js';
import { binding, openRouterPrices } from '../../../test/plugin-fixtures.js';
import { testToken } from '../../../test/helpers.js';
import { createVoiceTurnOperations } from '../../../packages/server/src/voice-turns.js';
import { listen } from '../../../packages/server/src/http.js';

function runtimeFixture(t, { coverage, consentAvailable = true } = {}) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const created = storage.create({ demo: true, ownerToken: testToken });
  storage.postTurn(created.id, 'fixture_turn', Buffer.from('hello'), 'hello');
  const session = storage.get(created.id), upstream = [], queries = [];
  const raw = binding('openrouter', 'https://reasoning.example.test/chat', { maxMicro: 10_000 });
  const qualified = { ...raw, legal: { approved: true, countries: ['AT'], training: false, retention: 'fixture',
    purpose: 'requirements', recipient: 'fixture-provider', processors: ['fixture-processor'],
    dataCategories: ['conversation'], consentVersion: 'v1', evidence: { qualified: true,
      accountRef: raw.accountRef, secretRef: raw.secretRef, model: raw.model, endpoint: raw.endpoint,
      routing: {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 } } };
  const plugin = createOpenRouterReasoning({ binding: qualified, prices: openRouterPrices, resolveSecret: () => 'fixture-reasoning-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, raw.endpoint); upstream.push(JSON.parse(options.body));
      return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"cost":0.000011}}\n\ndata: [DONE]\n\n');
    } });
  const consent = { async coverage(query, options) {
    queries.push(query);
    if (coverage) return coverage(query, options, queries.length);
    return grantFor(query);
  } };
  const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(plugin),
    presets: { best: { plugins: ['openrouter'], bindings: { reaction: qualified }, policy: { endpoints: [raw.endpoint] } } },
    consent: consentAvailable ? consent : undefined });
  const call = { callId: 'call_runtime', providerSessionId: 'conv_runtime', facadeSecretRef: 'fixture-facade-ref',
    spendDeadlineAt: Date.now() + 5000, browserLivenessDeadlineAt: Date.now() + 5000 };
  const handler = createCompletionsHandler({ getCall: async () => call, resolveSecret: () => 'fixture-callback-key',
    buildRequest: async ({ messages }) => ({ system: 'Trusted session prompt', messages }),
    admitReasoning: ({ request, options }) => runtime.admit({ session: storage.get(session.id),
      lane: 'reaction', operation: 'stream', request, options }) });
  const request = () => new Request('https://host.example.test/voice/call_runtime/completions', {
    method: 'POST', headers: { authorization: 'Bearer fixture-callback-key' },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: call.callId }, stream: true,
      messages: [{ role: 'user', content: 'hello' }] }),
  });
  const rows = () => storage.db.prepare('SELECT * FROM budget_attempts').all();
  return { storage, session, runtime, upstream, queries, handler, request, rows };
}
const grantFor = ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision,
  checkedAt: Date.now(), expiresAt: Date.now() + 10_000 });

function facadeFixture({ mode = 'normal', paused = false, deadlineAt = Date.now() + 5000, timeoutMs = 1000,
  admissionOptions = {}, pluginTimeoutMs = Infinity, maxRequestBytes, staticSecretRef, ports = {}, log } = {}) {
  const call = { callId: 'call_facade', providerSessionId: 'conv_facade', facadeSecretRef: 'fixture-per-call-ref', paused,
    ...(staticSecretRef ? { facadeCallId: 'call_facade' } : {}),
    spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt };
  const admissions = [], upstream = [], optionsList = [], logs = [];
  const handler = createCompletionsHandler({ timeoutMs, maxRequestBytes, staticSecretRef, log: log ?? (line => logs.push(line)),
    getCall: async () => ({ ...call }),
    resolveSecret: ref => { assert.equal(ref, staticSecretRef ?? call.facadeSecretRef); return 'fixture-per-call-secret'; },
    buildRequest: async ({ messages }) => ({ system: 'Trusted session prompt', messages }),
    async admitReasoning({ callId, request, options }) {
      assert.equal(callId, call.callId); admissions.push(request);
      const invocation = invocationOptions({ ...options, ...admissionOptions }); optionsList.push(invocation);
      const plugin = { async *stream(input, opts) {
        const accounting = await beginInvocation(opts);
        const scope = operationScope({ ...opts, deadlineAt: Math.min(opts.deadlineAt, Date.now() + pluginTimeoutMs) }); let completed = false;
        try {
          scope.signal.throwIfAborted(); accounting.dispatch(); upstream.push(input);
          if (mode === 'first-broken') throw new Error('fixture-per-call-secret must not escape');
          yield 'Hello';
          if (mode === 'stall') await new Promise((_, reject) => {
            const abort = () => reject(new PluginError('cancelled'));
            scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted) abort();
          });
          if (mode === 'broken') throw new Error('private error must not escape');
          yield ' world';
          // The broken fixture withholds usage too: AIT-97 cancels known usage, retaining uncertainty only without usage.
          if (mode !== 'omit-report') accounting.usage({ inputTokens: 13, outputTokens: 2 });
          completed = true;
        } catch (error) { throw normalizedError(error, scope.signal); }
        finally { scope.dispose(); if (mode !== 'omit-report') await accounting.finish(completed); }
      } };
      return { plugin, options: invocation, finish() {
        if (mode === 'finish-broken') throw new Error('fixture-per-call-secret settlement failed');
        if (mode === 'finish-stall') return new Promise(() => {});
        if (!invocation.reports.length) invocation.report({ attemptId: invocation.attempt.attemptId, outcome: 'uncertain' });
        assert.equal(invocation.reports.length, 1);
      } };
    },
    ...ports,
  });
  const request = (body = {}, headers = {}) => new Request('https://host.example.test/voice/call_facade/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-per-call-secret', ...headers },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: call.callId }, model: 'untrusted-provider-choice', stream: true,
      messages: [{ role: 'system', content: 'Untrusted provider system prompt' }, { role: 'user', content: 'hello' }], ...body }),
  });
  return { call, handler, request, admissions, upstream, optionsList, logs };
}
async function streamError(response, code) {
  assert.equal(response.status, 200); // Headers are already committed; the terminal SSE frame carries the failure.
  const text = await response.text();
  assert.ok(text.endsWith(`data: ${JSON.stringify({ error: code })}\n\n`), text);
  assert.equal(text.includes('[DONE]'), false); assert.equal(text.includes('"finish_reason":"stop"'), false);
  return text;
}
test('facade checks per-call bearer and call identity before reasoning admission', async () => {
  const local = facadeFixture();
  for (const authorization of ['', 'Bearer wrong', 'Basic fixture-per-call-secret']) {
    const response = await local.handler(local.request({}, { authorization })); assert.equal(response.status, 401);
  }
  assert.equal((await local.handler(local.request({ aithema_call: 'foreign' }))).status, 400);
  assert.deepEqual(local.admissions, []); assert.deepEqual(local.upstream, []);
  assert.equal(bearerMatches(null, ''), false); assert.equal(bearerMatches('Bearer', 'fixture'), false);
});
test('facade delegates to admitted session reasoning and streams OpenAI-compatible chunks; provider binding is ignored', async () => {
  const local = facadeFixture(), response = await local.handler(local.request());
  assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').startsWith('text/event-stream'));
  const text = await response.text();
  const chunks = text.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'Hello world');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop'); assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.deepEqual(local.upstream, [{ system: 'Trusted session prompt', messages: [{ role: 'user', content: 'hello' }] }]);
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'completed');
  assert.deepEqual(local.optionsList[0].reports[0].usage, { inputTokens: 13, outputTokens: 2 });
  assert.equal(text.includes('fixture-per-call-secret'), false); assert.equal(text.includes('untrusted-provider-choice'), false);
});
test('facade supports nonstream completions through the same admitted stream binding', async () => {
  const local = facadeFixture(), response = await local.handler(local.request({ stream: false }));
  const body = await response.json(); assert.equal(body.object, 'chat.completion');
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'Hello world' }); assert.equal(local.optionsList[0].reports.length, 1);
});

test('AIT-137 round 5: the streamed reply identity reaches metadata and the server completion port', async () => {
  const completions = [], local = facadeFixture({ ports: { onCompletion: event => completions.push(event) } });
  const response = await local.handler(local.request()), text = await response.text();
  const frames = text.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  assert.deepEqual(frames[0].metadata, { aithema_reply_id: frames[0].id });
  assert.equal(completions[0].replyId, frames[0].id);
  assert.ok(frames.every(frame => frame.id === completions[0].replyId));
});
test('AIT-130: facade accepts full conversation history above 64 KiB', async () => {
  const local = facadeFixture();
  const messages = Array.from({ length: 36 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}: ${'spoken history '.repeat(150)}`,
  }));
  const request = local.request({ stream: false, messages });
  assert.ok(Buffer.byteLength(await request.clone().text()) > 65_536);
  const response = await local.handler(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Hello world');
  assert.deepEqual(local.upstream[0].messages, messages);
});
for (const bytes of [1_048_576, 2_097_152, MAX_COMPLETION_REQUEST_BYTES]) {
  test(`AIT-130: callback accepts ${bytes} bytes of history including the exact limit`, async () => {
    const local = facadeFixture({ timeoutMs: 5000, deadlineAt: Date.now() + 10_000 });
    const messages = [{ role: 'user', content: '' }];
    const overhead = Buffer.byteLength(await local.request({ stream: false, messages }).text());
    messages[0].content = 'x'.repeat(bytes - overhead);
    const request = local.request({ stream: false, messages }), response = await local.handler(request);
    assert.equal(response.status, 200); const body = await response.json();
    const line = JSON.parse(local.logs[0]);
    assert.equal(line.requestBytes, bytes); assert.equal(line.responseBytes, Buffer.byteLength(JSON.stringify(body)));
    assert.equal(line.errorCode, null); assert.equal(local.logs.length, 1);
    assert.deepEqual(local.upstream[0].messages, messages);
  });
}
test('AIT-130: a callback exceeding the new limit returns JSON 413 before admission', async () => {
  const local = facadeFixture(), request = local.request({ messages: [{ role: 'user', content: 'x'.repeat(MAX_COMPLETION_REQUEST_BYTES) }] });
  const response = await local.handler(request);
  assert.equal(response.status, 413); assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'limit' }); assert.equal(local.admissions.length, 0);
  assert.equal(local.logs.length, 1);
  const line = JSON.parse(local.logs[0]); assert.equal(line.status, 413); assert.equal(line.errorCode, 'limit');
  assert.ok(line.requestBytes > MAX_COMPLETION_REQUEST_BYTES);
});
test('AIT-130: chunked oversized bodies are bounded even without Content-Length', async () => {
  const local = facadeFixture({ maxRequestBytes: 1024 }); let cancelled = false, sent = 0;
  const body = new ReadableStream({ pull(controller) { sent++; controller.enqueue(new Uint8Array(512)); },
    cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request(local.request().url, { method: 'POST', headers: local.request().headers, body, duplex: 'half' });
  assert.equal(request.headers.has('content-length'), false);
  const response = await local.handler(request);
  assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'limit' });
  assert.equal(sent, 3); assert.equal(cancelled, true); assert.equal(local.admissions.length, 0);
  assert.equal(JSON.parse(local.logs[0]).requestBytes, 1536);
});
for (const [name, status, error, authorization, sent] of [
  ['oversized', 413, 'limit', 'Bearer fixture-per-call-secret', 1025],
  ['unauthorized', 401, 'unauthorized', 'Bearer fixture-denied-secret', 1],
  ['stalled', 504, 'deadline', 'Bearer fixture-per-call-secret', 1],
]) test(`AIT-130: HTTP callback sends JSON ${status} while a ${name} upload is still in progress`, { timeout: 5000 }, async t => {
  const local = facadeFixture({ maxRequestBytes: 1024, timeoutMs: 100 }), { server, url } = await listen(local.handler);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await new Promise((resolve, reject) => {
    const upload = httpRequest(url, { method: 'POST', headers: { authorization,
      'content-type': 'application/json', 'content-length': '100000' } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
      incoming.on('end', () => { resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString(), connection: incoming.headers.connection }); upload.destroy(); });
    });
    upload.on('error', reject); t.after(() => upload.destroy());
    // Keep the remainder unsent, proving reader cancellation cannot destroy the socket before the JSON reply.
    upload.write('x'.repeat(sent));
  });
  assert.equal(response.status, status); assert.deepEqual(JSON.parse(response.body), { error });
  assert.equal(response.connection, 'close');
  assert.equal(local.admissions.length, 0); assert.equal(local.logs.length, 1);
  assert.equal(JSON.parse(local.logs[0]).errorCode, error);
});
test('AIT-130: stalled body reads and cancellation hooks cannot outlive the facade deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const entered = Promise.withResolvers();
  const local = facadeFixture({ timeoutMs: 30 }); let cancelled = false;
  const body = new ReadableStream({ pull() { entered.resolve(); return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const request = new Request(local.request().url, { method: 'POST', headers: local.request().headers, body, duplex: 'half' });
  const pending = local.handler(request); await entered.promise;
  t.mock.timers.tick(29); await flush(); assert.equal(cancelled, false); assert.equal(local.logs.length, 0);
  t.mock.timers.tick(1); const response = await pending;
  assert.equal(response.status, 504); assert.deepEqual(await response.json(), { error: 'deadline' });
  assert.equal(cancelled, true); assert.equal(body.locked, false); assert.equal(local.admissions.length, 0);
  assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'deadline');
});
test('AIT-130: static callback authenticates before reading its bounded history', async () => {
  const local = facadeFixture({ staticSecretRef: 'fixture-static-ref' });
  let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const denied = await local.handler(new Request(local.request().url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body, duplex: 'half' }));
  assert.equal(denied.status, 401); assert.equal(reads, 0);
  const response = await local.handler(local.request({ stream: false, messages: [{ role: 'user', content: 'hello '.repeat(12_000) }] }));
  assert.equal(response.status, 200); await response.json(); assert.equal(local.admissions.length, 1);
  assert.equal(JSON.parse(local.logs.at(-1)).callIdHash, createHash('sha256').update(local.call.callId).digest('hex').slice(0, 16));
});
test('AIT-130: stdout logs one value-free JSON line per success and failure', async t => {
  const output = []; t.mock.method(console, 'log', line => output.push(line));
  const local = facadeFixture({ log: console.log });
  const response = await local.handler(local.request({ messages: [{ role: 'user', content: 'private spoken text' }] },
    { cookie: 'fixture-cookie-secret', 'x-api-key': 'fixture-api-key' }));
  const text = await response.text();
  await local.handler(local.request({}, { authorization: 'Bearer fixture-denied-secret' }));
  assert.equal(output.length, 2);
  const success = JSON.parse(output[0]), failure = JSON.parse(output[1]);
  assert.deepEqual(Object.keys(success).sort(), ['time', 'level', 'event', 'status', 'latencyMs', 'requestBytes', 'responseBytes', 'errorCode', 'callIdHash'].sort());
  assert.ok(Number.isFinite(Date.parse(success.time))); assert.ok(success.latencyMs >= 0);
  assert.equal(success.status, 200); assert.equal(success.level, 'info'); assert.equal(success.errorCode, null);
  assert.equal(success.responseBytes, Buffer.byteLength(text));
  assert.equal(failure.status, 401); assert.equal(failure.level, 'error'); assert.equal(failure.errorCode, 'unauthorized');
  assert.equal(failure.requestBytes, 0);
  for (const secret of ['Bearer', 'fixture-per-call-secret', 'fixture-denied-secret', 'fixture-cookie-secret', 'fixture-api-key',
    'private spoken text', local.call.callId, local.call.providerSessionId, local.call.facadeSecretRef, 'host.example.test']) {
    assert.equal(output.join('\n').includes(secret), false, secret);
  }
});
test('AIT-130: rejected async callback logging falls back without an unhandled rejection', async t => {
  const output = []; t.mock.method(console, 'error', line => output.push(line));
  const local = facadeFixture({ log: async () => { await flush(); throw new Error('Bearer fixture-per-call-secret'); } });
  const response = await local.handler(local.request({ stream: false }));
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'Hello world');
  await flush(); await flush();
  assert.equal(output.length, 1); const line = JSON.parse(output[0]);
  assert.equal(line.status, 200); assert.equal(line.errorCode, null);
  assert.equal(output[0].includes('fixture-per-call-secret'), false);
});
for (const failure of ['throw', 'reject']) {
  test(`AIT-130: fallback callback logging can ${failure} without affecting JSON or SSE responses`, async t => {
    const output = []; t.mock.method(console, 'error', line => {
      output.push(line);
      if (failure === 'throw') throw new Error('Bearer fixture-per-call-secret');
      return Promise.reject(new Error('Bearer fixture-per-call-secret'));
    });
    const local = facadeFixture({ log: () => { throw new Error('Bearer fixture-per-call-secret'); } });
    const denied = await local.handler(local.request({}, { authorization: 'Bearer wrong' }));
    assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'unauthorized' });
    const response = await local.handler(local.request());
    assert.equal(response.status, 200); assert.ok((await response.text()).endsWith('data: [DONE]\n\n'));
    await flush();
    assert.equal(output.length, 2);
    assert.equal(JSON.parse(output[0]).errorCode, 'unauthorized'); assert.equal(JSON.parse(output[1]).errorCode, null);
    assert.equal(output.join('\n').includes('fixture-per-call-secret'), false);
  });
}
for (const port of ['getCall', 'resolveSecret', 'buildRequest', 'admitReasoning', 'onCompletion']) {
  test(`AIT-130: ${port} failure returns a stable JSON 502 and one secret-free log`, async () => {
    const local = facadeFixture({ ports: { [port]: () => { throw new Error('Bearer fixture-per-call-secret'); } } });
    const response = await local.handler(local.request({ stream: false }));
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'provider' });
    assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'provider');
    assert.equal(local.logs[0].includes('fixture-per-call-secret'), false);
  });
}
for (const mode of ['first-broken', 'finish-broken', 'finish-stall']) {
  test(`AIT-130: ${mode} cannot escape as an empty nonstream 5xx`, async () => {
    const local = facadeFixture({ mode });
    const response = await local.handler(local.request({ stream: false }));
    assert.equal(response.status, mode === 'finish-stall' ? 504 : 502);
    assert.deepEqual(await response.json(), { error: mode === 'finish-stall' ? 'deadline' : 'provider' });
    assert.equal(local.logs.length, 1); assert.equal(local.logs[0].includes('fixture-per-call-secret'), false);
  });
}
test('AIT-130: unknown plugin codes cannot leak credentials into errors or logs', async () => {
  const local = facadeFixture({ ports: { buildRequest: () => { throw new PluginError('Bearer fixture-per-call-secret'); } } });
  const response = await local.handler(local.request());
  assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'provider' });
  assert.equal(JSON.parse(local.logs[0]).errorCode, 'provider'); assert.equal(local.logs[0].includes('fixture-per-call-secret'), false);
});
test('AIT-130: method, malformed JSON and every known plugin failure return coded JSON', async () => {
  const local = facadeFixture();
  const method = await local.handler(new Request(local.request().url));
  assert.equal(method.status, 405); assert.deepEqual(await method.json(), { error: 'method-not-allowed' });
  const malformed = await local.handler(new Request(local.request().url, { method: 'POST', headers: local.request().headers, body: '{' }));
  assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: 'invalid-output' });
  for (const [code, status] of Object.entries({ auth: 401, 'not-admitted': 403, limit: 413, 'invalid-output': 400,
    deadline: 504, cancelled: 502, 'already-claimed': 502, unavailable: 502, 'rate-limit': 502, provider: 502 })) {
    const failed = facadeFixture({ ports: { buildRequest: () => { throw new PluginError(code, 'fixture-per-call-secret'); } } });
    const response = await failed.handler(failed.request());
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
    assert.equal(failed.logs.length, 1); assert.equal(JSON.parse(failed.logs[0]).errorCode, code);
    assert.equal(failed.logs[0].includes('fixture-per-call-secret'), false);
  }
});
test('facade accepts ElevenLabs platform and direct callback identities and rejects conflicting identities', async () => {
  const local = facadeFixture();
  for (const body of [{}, { elevenlabs_extra_body: undefined, aithema_call: local.call.callId }, { aithema_call: local.call.callId }]) {
    const response = await local.handler(local.request(body)); assert.equal(response.status, 200); await response.text();
  }
  for (const body of [{ aithema_call: 'foreign' }, { aithema_call: null }, { elevenlabs_extra_body: { aithema_call: 'foreign' } },
    { elevenlabs_extra_body: undefined }, { elevenlabs_extra_body: undefined, extra_body: { aithema_call: local.call.callId } }]) {
    assert.equal((await local.handler(local.request(body))).status, 400);
  }
  assert.equal(local.admissions.length, 3);
});
test('facade drops null content and safely ignores other provider roles without failing the turn', async () => {
  const local = facadeFixture(), response = await local.handler(local.request({ elevenlabs_extra_body: undefined,
    aithema_call: local.call.callId, stream: false, messages: [
    { role: 'system', content: 'untrusted' }, { role: 'assistant', content: null }, { role: 'tool', content: 'tool output' },
    { role: 'developer', content: 'untrusted instructions' }, { role: 'future-provider-role', content: null },
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'previous reply' },
  ] }));
  assert.equal(response.status, 200); await response.json();
  assert.deepEqual(local.admissions[0].messages, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'previous reply' }]);
});
test('omitted stream returns a normal OpenAI completion', async () => {
  const local = facadeFixture(), response = await local.handler(local.request({ elevenlabs_extra_body: undefined,
    aithema_call: local.call.callId, stream: undefined }));
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal((await response.json()).object, 'chat.completion');
});
test('paused, terminal and expired calls cannot start fresh delegated reasoning', async () => {
  for (const override of [{ paused: true }, { deadlineAt: Date.now() - 1 }]) {
    const local = facadeFixture(override); assert.equal((await local.handler(local.request())).status, 403); assert.equal(local.admissions.length, 0);
  }
  const local = facadeFixture(); local.call.terminal = { outcome: 'completed' };
  assert.equal((await local.handler(local.request())).status, 403); assert.equal(local.admissions.length, 0);
});
test('malformed, oversized and nontext requests reject before admission', async () => {
  const local = facadeFixture({ maxRequestBytes: 65_536 });
  for (const body of [{ messages: [] }, { messages: [null] },
    { messages: [{ role: 'user', content: [] }] }, { stream: 'yes' }]) assert.equal((await local.handler(local.request(body))).status, 400);
  assert.equal((await local.handler(local.request({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }))).status, 413);
  assert.equal(local.admissions.length, 0);
});
test('cancelling a stalled streamed response aborts reasoning and reports uncertain exactly once', async () => {
  const local = facadeFixture({ mode: 'stall' }), response = await local.handler(local.request()), reader = response.body.getReader();
  await reader.read(); await reader.read(); const pending = reader.read(); await flush();
  await reader.cancel(); await pending;
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'cancelled');
});
test('facade deadline and unused response each settle a delegated attempt once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const local = facadeFixture({ mode: 'stall', timeoutMs: 50 }), response = await local.handler(local.request());
  const pending = streamError(response, 'deadline'); await flush();
  t.mock.timers.tick(49); await flush();
  assert.equal(local.optionsList[0].reports.length, 0); assert.equal(local.logs.length, 0);
  t.mock.timers.tick(1); await pending;
  assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'deadline');
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
  const unused = facadeFixture({ timeoutMs: 40 }), unread = await unused.handler(unused.request());
  t.mock.timers.tick(39); await flush();
  assert.equal(unused.optionsList[0].reports.length, 0); assert.equal(unused.logs.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(unused.optionsList[0].reports.length, 1); assert.equal(unused.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(unused.logs.length, 1); assert.equal(JSON.parse(unused.logs[0]).errorCode, 'deadline');
  await streamError(unread, 'deadline'); assert.equal(unused.optionsList[0].reports.length, 1); assert.equal(unused.logs.length, 1);
});
test('call lifetime deadline also bounds a delegated response even when facade timeout is longer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const local = facadeFixture({ mode: 'stall', deadlineAt: Date.now() + 35, timeoutMs: 1000 });
  const response = await local.handler(local.request()), pending = streamError(response, 'deadline'); await flush();
  t.mock.timers.tick(34); await flush();
  assert.equal(local.optionsList[0].reports.length, 0); assert.equal(local.logs.length, 0);
  t.mock.timers.tick(1); await pending;
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'deadline');
});
test('call closure signal cancels an active delegated response and refuses later callbacks', async () => {
  const local = facadeFixture({ mode: 'stall' }), controller = new AbortController(); local.call.signal = controller.signal;
  const response = await local.handler(local.request()), pending = streamError(response, 'cancelled'); await flush(); controller.abort();
  await pending; assert.equal(local.optionsList[0].reports.length, 1);
  assert.equal((await local.handler(local.request())).status, 403); assert.equal(local.optionsList.length, 1);
});
test('broken stream, failed settlement and missing terminal emit JSON errors without successful completion', async () => {
  for (const mode of ['broken', 'omit-report', 'finish-broken']) {
    const local = facadeFixture({ mode }), response = await local.handler(local.request());
    const code = mode === 'omit-report' ? 'invalid-output' : 'provider';
    await streamError(response, code); assert.equal(local.optionsList[0].reports.length, 1);
    assert.equal(local.optionsList[0].reports[0].outcome, mode === 'finish-broken' ? 'completed' : 'uncertain');
    assert.equal(local.logs.length, 1); const line = JSON.parse(local.logs[0]);
    assert.equal(line.status, 200); assert.equal(line.errorCode, code); assert.equal(line.level, 'error');
  }
});
test('facade awaits fresh runtime consent before dispatch and settles the owned session token claim', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const local = runtimeFixture(t, { coverage: async (query, options, count) => {
    if (count === 2) { entered.resolve(); await gate.promise; }
    return grantFor(query);
  } });
  const pending = local.handler(local.request()); await entered.promise;
  assert.equal(local.upstream.length, 0); assert.equal(local.rows().length, 1); assert.equal(local.rows()[0].state, 'claimed');
  gate.resolve(); const response = await pending; assert.equal(response.status, 200); assert.ok((await response.text()).includes('[DONE]'));
  assert.equal(local.upstream.length, 1); assert.equal(local.queries.length, 2); assert.deepEqual(local.queries[0], local.queries[1]);
  assert.equal(local.queries[0].sessionId, local.session.id); assert.deepEqual(local.queries[0].scope.recipients, ['fixture-provider']);
  assert.equal(local.rows()[0].state, 'settled'); assert.equal(local.rows()[0].outcome, 'completed'); assert.equal(local.rows()[0].settled_micro, 11);
});
for (const action of ['consent', 'pause', 'revision', 'withdraw', 'erase', 'ownership']) {
  test(`facade refuses ${action} changes during async runtime consume without dispatch or duplicate settlement`, async t => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let granted = true;
    const local = runtimeFixture(t, { coverage: async (query, options, count) => {
      if (count === 2) { entered.resolve(); await gate.promise; }
      return { ...grantFor(query), covered: granted };
    } });
    const pending = local.handler(local.request()); await entered.promise;
    assert.equal(local.upstream.length, 0);
    if (action === 'consent') granted = false;
    if (action === 'pause') local.storage.pause(local.session.id, true);
    if (action === 'revision') local.storage.reviseConsent(local.session.id, true);
    if (action === 'withdraw') local.storage.withdraw(local.session.id, 'fixture_turn');
    if (action === 'erase') local.storage.erase(local.session.id);
    if (action === 'ownership') {
      const get = local.storage.get.bind(local.storage);
      local.storage.get = id => ({ ...get(id), ownerHash: 'another-owner' });
    }
    gate.resolve(); const response = await pending;
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'not-admitted' });
    assert.equal(local.upstream.length, 0); assert.equal(local.queries.length, 2); assert.equal(local.rows().length, 1);
    assert.equal(local.rows()[0].state, 'settled'); assert.equal(local.rows()[0].outcome, 'cancelled');
    assert.equal(local.rows()[0].settled_micro, 0); assert.deepEqual(JSON.parse(local.rows()[0].usage), { inputTokens: 0, outputTokens: 0 });
  });
}
test('facade runtime admission requires authoritative consent and an owned session', async t => {
  for (const missing of ['consent', 'ownership']) {
    const local = runtimeFixture(t, { consentAvailable: missing !== 'consent' });
    if (missing === 'ownership') {
      const get = local.storage.get.bind(local.storage);
      local.storage.get = id => ({ ...get(id), ownerHash: undefined });
    }
    assert.equal((await local.handler(local.request())).status, 403);
    assert.equal(local.upstream.length, 0); assert.equal(local.queries.length, 0); assert.equal(local.rows().length, 0);
  }
});
test('facade preserves the admission cancellation signal and earlier deadline', async t => {
  // Freeze admission time too: only advance after the response has reached the phase under test.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const controller = new AbortController(), cancelled = facadeFixture({ mode: 'stall', admissionOptions: { signal: controller.signal } });
  const response = await cancelled.handler(cancelled.request()), pending = streamError(response, 'cancelled'); await flush(); controller.abort();
  await pending; assert.equal(cancelled.optionsList[0].reports.length, 1);
  assert.equal(cancelled.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(cancelled.logs.length, 1); assert.equal(JSON.parse(cancelled.logs[0]).errorCode, 'cancelled');
  const expired = facadeFixture({ mode: 'stall', admissionOptions: { deadlineAt: Date.now() + 40 } });
  const bounded = await expired.handler(expired.request()), deadline = streamError(bounded, 'deadline'); await flush();
  t.mock.timers.tick(39); await flush();
  assert.equal(expired.optionsList[0].reports.length, 0); assert.equal(expired.logs.length, 0);
  t.mock.timers.tick(1); await deadline;
  assert.equal(expired.optionsList[0].reports.length, 1); assert.equal(expired.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(expired.logs.length, 1); assert.equal(JSON.parse(expired.logs[0]).errorCode, 'deadline');
  const unused = facadeFixture({ mode: 'stall', admissionOptions: { deadlineAt: Date.now() + 30 } });
  const unread = await unused.handler(unused.request());
  t.mock.timers.tick(29); await flush();
  assert.equal(unused.optionsList[0].reports.length, 0); assert.equal(unused.logs.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(unused.logs.length, 1); assert.equal(JSON.parse(unused.logs[0]).errorCode, 'deadline');
  assert.equal(unused.optionsList[0].reports.length, 1); assert.equal(unused.optionsList[0].reports[0].outcome, 'uncertain');
  await streamError(unread, 'deadline'); assert.equal(unused.optionsList[0].reports.length, 1); assert.equal(unused.logs.length, 1);
});
test('facade preserves a plugin-local deadline before the invocation lifetime expires', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const local = facadeFixture({ mode: 'stall', pluginTimeoutMs: 10 });
  const response = await local.handler(local.request()), pending = streamError(response, 'deadline'); await flush();
  t.mock.timers.tick(9); await flush();
  assert.equal(local.optionsList[0].reports.length, 0); assert.equal(local.logs.length, 0);
  t.mock.timers.tick(1); await pending;
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
  assert.equal(local.logs.length, 1); assert.equal(JSON.parse(local.logs[0]).errorCode, 'deadline');
});
test('AIT-130: delayed nonstream completion cannot return success past the admission deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const entered = Promise.withResolvers(), completion = Promise.withResolvers();
  let completions = 0;
  const local = facadeFixture({ admissionOptions: { deadlineAt: Date.now() + 100 }, ports: {
    async onCompletion() { completions++; entered.resolve(); await completion.promise; },
  } });
  const pending = local.handler(local.request({ stream: false })); await entered.promise;
  t.mock.timers.tick(99); await flush(); assert.equal(local.logs.length, 0);
  t.mock.timers.tick(1); const response = await pending;
  assert.equal(completions, 1); assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'deadline' });
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.logs.length, 1);
  assert.equal(JSON.parse(local.logs[0]).errorCode, 'deadline');
  completion.resolve(); await flush();
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.logs.length, 1);
});
test('AIT-130: admission cancellation while nonstream completion awaits cannot return success', async () => {
  const controller = new AbortController(); let completions = 0;
  const local = facadeFixture({ admissionOptions: { signal: controller.signal }, ports: {
    async onCompletion() { completions++; controller.abort(); await flush(); },
  } });
  const response = await local.handler(local.request({ stream: false }));
  assert.equal(completions, 1); assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'cancelled' });
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.logs.length, 1);
  assert.equal(JSON.parse(local.logs[0]).errorCode, 'cancelled');
});

// AIT-381: all clocks and provider/admission waits below are controlled; no live ports.
const spokenSegment = (content, scope = 'in') => JSON.stringify({ content, scope, question_short: null, options: [] });
function spokenFixture(t, { attempts, locale = 'en', admissionGate, turnOperations, timeoutMs = 6500, defaultTimeout = false, finalizationGate } = {}) {
  const snapshot = { system: 'Pinned private specification has twelve consecutive words that must never be spoken aloud here.',
    hiddenGuidance: 'Pinned private specification has twelve consecutive words that must never be spoken aloud here.',
    locale, purposePolicy: { offTopicLimit: 3, outputCheck: true, canary: 'PRIVATE_PINNED_CANARY',
      purpose: 'Clarify the project', redirect: { en: 'Which project should we clarify?', de: 'Welches Vorhaben klären wir?' } },
    schema: {}, messages: [{ role: 'user', content: 'A project' }] };
  const admissions = [], completions = [], reports = [], finishes = [], started = [], states = [];
  let live = 0, maxLive = 0;
  const local = facadeFixture({ timeoutMs, deadlineAt: Date.now() + 60_000, ports: {
    turnOperations, ...(defaultTimeout ? { timeoutMs: undefined } : {}),
    buildRequest: () => snapshot,
    async admitReasoning({ request, options }) {
      const index = admissions.length; admissions.push(request);
      await admissionGate?.promise;
      const opts = invocationOptions(options); reports.push(opts.reports);
      return { request: snapshot, options: opts, finish: () => { finishes.push(index);
        if (!opts.reports.length) opts.report({ attemptId: opts.attempt.attemptId, outcome: 'uncertain' }); },
        plugin: { async *stream(input, invocation) {
          started.push(input); live++; maxLive = Math.max(maxLive, live);
          const accounting = await beginInvocation(invocation); let completed = false;
          try {
            accounting.dispatch();
            for (const step of attempts[index] ?? []) {
              if (step.gate) await new Promise((resolve, reject) => {
                const abort = () => reject(new PluginError('cancelled'));
                invocation.signal.addEventListener('abort', abort, { once: true });
                step.gate.promise.then(() => { invocation.signal.removeEventListener('abort', abort); resolve(); });
                if (invocation.signal.aborted) abort();
              });
              if (step.text) yield step.text;
            }
            accounting.usage({ inputTokens: 1, outputTokens: 1 }); completed = true;
          } finally { await finalizationGate?.promise; live--; await accounting.finish(completed); }
        } } };
    },
    onCompletion: event => completions.push(event),
  } });
  const observe = () => {
    const state = { response: null, text: '', ended: false }; states.push(state);
    state.done = local.handler(local.request()).then(async response => {
      state.response = response;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      for (;;) { const item = await reader.read(); if (item.done) break; state.text += decoder.decode(item.value); }
      state.ended = true;
    });
    return state;
  };
  t.after(async () => { finalizationGate?.resolve(); for (const attempt of attempts) for (const step of attempt) step.gate?.resolve();
    admissionGate?.resolve(); await Promise.all(states.map(state => state.done)); });
  return { ...local, observe, snapshot, admissions, completions, reports, finishes, started, get maxLive() { return maxLive; } };
}
const spokenText = state => state.text.split('\n\n').filter(frame => frame.startsWith('data: {'))
  .map(frame => JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? '').join('');

for (const [locale, holding] of [['en', 'One moment, please.'], ['de', 'Einen Moment, bitte.']]) {
  test(`AIT-381: slow first token speaks one ${locale} holding line at 5 s, then validated content`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const source = Promise.withResolvers();
    const h = spokenFixture(t, { locale, attempts: [[{ gate: source, text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
    const state = h.observe(); await flush();
    t.mock.timers.tick(4999); await flush(); assert.equal(spokenText(state), '');
    t.mock.timers.tick(1); await flush(); assert.equal(spokenText(state), holding);
    t.mock.timers.tick(500); await flush(); assert.equal(spokenText(state), holding);
    source.resolve(); await state.done;
    assert.equal(spokenText(state), holding + ' What should improve?');
    assert.equal(h.admissions.length, 1); assert.equal(h.completions[0].content, spokenText(state));
    assert.equal(h.reports[0].length, 1); assert.equal(state.text.includes('[DONE]'), true);
  });
}

test('AIT-381: a fast committed segment streams before the rest and suppresses holding copy', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const rest = Promise.withResolvers();
  const h = spokenFixture(t, { attempts: [[{ text: `{"segments":[${spokenSegment('A focused start. ')}` },
    { gate: rest, text: `,${spokenSegment('What should improve?')}]}` }]] });
  const state = h.observe(); await flush();
  assert.equal(spokenText(state), 'A focused start. '); assert.equal(state.ended, false);
  t.mock.timers.tick(5000); await flush(); assert.equal(spokenText(state), 'A focused start. ');
  rest.resolve(); await state.done;
  assert.equal(spokenText(state), 'A focused start. What should improve?');
  assert.equal(h.completions.length, 1); assert.equal(h.completions[0].scope, 'in');
});

test('AIT-381: validation pins the turn-start policy through delayed admission and rejects a segment before output', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const admissionGate = Promise.withResolvers(), rest = Promise.withResolvers();
  const h = spokenFixture(t, { admissionGate, attempts: [[{ text: `{"segments":[${spokenSegment('A focused start. ')}` },
    { gate: rest, text: `,${spokenSegment('PRIVATE_PINNED_CANARY')}]}` }],
  [{ text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
  const state = h.observe(); await flush();
  h.snapshot.purposePolicy.canary = 'CHANGED_CANARY'; h.snapshot.purposePolicy.outputCheck = false;
  h.snapshot.hiddenGuidance = 'Changed analysis'; admissionGate.resolve(); await flush();
  assert.equal(spokenText(state), 'A focused start. ');
  rest.resolve(); await state.done;
  assert.equal(state.text.includes('PRIVATE_PINNED_CANARY'), false);
  assert.equal(h.admissions.length, 2); assert.equal(h.maxLive, 1);
  assert.equal(h.finishes.length, 2); assert.ok(h.reports.every(items => items.length === 1));
});

test('AIT-381: a stalled retry shares the original deadline and holding line; attempts are bounded', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const retry = Promise.withResolvers();
  const h = spokenFixture(t, { attempts: [[{ text: `{"segments":[${spokenSegment('const secret = 1;')}]}` }],
    [{ gate: retry, text: `{"segments":[${spokenSegment('const secret = 2;')}]}` }]] });
  const state = h.observe(); await flush();
  assert.equal(h.admissions.length, 2); assert.equal(h.maxLive, 1); assert.equal(spokenText(state), '');
  t.mock.timers.tick(5000); await flush(); assert.equal(spokenText(state), 'One moment, please.');
  t.mock.timers.tick(1499); await flush(); assert.equal(spokenText(state), 'One moment, please.');
  t.mock.timers.tick(1); await state.done;
  assert.equal(state.text.includes('"error":"deadline"'), true); assert.equal(h.admissions.length, 2);
  assert.equal((spokenText(state).match(/One moment, please\./gu) ?? []).length, 1);
  assert.equal(state.text.includes('const secret'), false); assert.equal(h.completions.length, 0);
});

test('AIT-381: delayed analysis never delays the reaction segment', async t => {
  const analysis = Promise.withResolvers(), rest = Promise.withResolvers(); let analysisDone = false;
  analysis.promise.then(() => { analysisDone = true; });
  t.after(() => analysis.resolve());
  const h = spokenFixture(t, { attempts: [[{ text: `{"segments":[${spokenSegment('What should improve?')}` }, { gate: rest, text: ']}' }]] });
  const state = h.observe(); await flush();
  assert.equal(analysisDone, false); assert.equal(spokenText(state), 'What should improve?');
  rest.resolve(); await state.done; assert.equal(analysisDone, false);
});

test('AIT-381: deferred admission still gets the holding line at 5 s and the default callback expires at 6.5 s', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const admissionGate = Promise.withResolvers(), source = Promise.withResolvers();
  const h = spokenFixture(t, { defaultTimeout: true, admissionGate,
    attempts: [[{ gate: source, text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
  const state = h.observe(); await flush();
  t.mock.timers.tick(5000); await flush(); assert.equal(spokenText(state), 'One moment, please.');
  admissionGate.resolve(); await flush();
  t.mock.timers.tick(1499); await flush(); assert.equal(state.ended, false);
  t.mock.timers.tick(1); await state.done;
  assert.equal(state.text.includes('"error":"deadline"'), true); assert.equal(h.completions.length, 0);
  source.resolve(); await flush(); assert.equal(spokenText(state), 'One moment, please.');
});

test('AIT-381: duplicate callbacks join the durable writer across the bounded safety retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const storage = new SQLiteStorage(), session = storage.create(), retry = Promise.withResolvers();
  const turns = createVoiceTurnOperations({ storage });
  t.after(async () => { retry.resolve(); await turns.idle(); storage.close(); });
  const h = spokenFixture(t, { turnOperations: { run: (context, execute, options) =>
    turns.run({ ...context, sessionId: session.id }, execute, options) },
  attempts: [[{ text: `{"segments":[${spokenSegment('const secret = 1;')}]}` }],
    [{ gate: retry, text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
  const first = h.observe(), duplicate = h.observe(); await flush();
  assert.equal(h.admissions.length, 2); assert.equal(h.maxLive, 1);
  t.mock.timers.tick(5000); await flush();
  assert.equal(spokenText(first), 'One moment, please.'); assert.equal(spokenText(duplicate), 'One moment, please.');
  retry.resolve(); await Promise.all([first.done, duplicate.done]);
  assert.equal(h.admissions.length, 2); assert.equal(h.started.length, 2); assert.equal(h.completions.length, 1);
  assert.equal(spokenText(first), spokenText(duplicate)); assert.equal(first.text.includes('const secret'), false);
  assert.equal(storage.voiceOperations(session.id).length, 1);
  const replay = h.observe(); await replay.done; assert.equal(spokenText(replay), spokenText(first));
  assert.equal(h.admissions.length, 2); assert.ok(h.reports.every(items => items.length === 1));
});

for (const content of ['Use const secret = 1;', 'PRIVATE_PINNED_CANARY',
  'Pinned private specification has twelve consecutive words that must never be spoken aloud here.']) {
  test(`AIT-381: a rejected ${content.startsWith('Use') ? 'code' : content.startsWith('PRIVATE') ? 'canary' : 'private specification'} segment never reaches TTS`, async t => {
    const h = spokenFixture(t, { attempts: [[{ text: `{"segments":[${spokenSegment(content)}]}` }],
      [{ text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
    const state = h.observe(); await state.done;
    assert.equal(spokenText(state).includes(content), false); assert.equal(h.admissions.length, 2);
    assert.equal(h.maxLive, 1); assert.equal(h.completions.length, 1); assert.equal(h.completions[0].scope, 'off');
  });
}

test('AIT-381: fragmented JSON and escaped braces commit only the complete scoped segment', async t => {
  const commit = Promise.withResolvers(), finish = Promise.withResolvers();
  const wire = spokenSegment('A "quoted" project {with braces}.');
  const h = spokenFixture(t, { attempts: [[{ text: `{"segments":[${wire.slice(0, -1)}` },
    { gate: commit, text: wire.slice(-1) }, { gate: finish, text: ']}' }]] });
  const state = h.observe(); await flush(); assert.equal(spokenText(state), '');
  commit.resolve(); await flush(); assert.equal(spokenText(state), 'A "quoted" project {with braces}.');
  finish.resolve(); await state.done; assert.equal(state.text.includes('[DONE]'), true);
});

test('AIT-381: provider cleanup that ignores abort cannot overlap another admitted generation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const finalizationGate = Promise.withResolvers();
  const h = spokenFixture(t, { finalizationGate,
    attempts: [[{ text: `{"segments":[${spokenSegment('PRIVATE_PINNED_CANARY')}]}` }],
      [{ text: `{"segments":[${spokenSegment('What should improve?')}]}` }]] });
  const state = h.observe(); await flush();
  t.mock.timers.tick(999); await flush(); assert.equal(h.admissions.length, 1);
  t.mock.timers.tick(1); await flush();
  finalizationGate.resolve(); await state.done;
  assert.equal(h.admissions.length, 1); assert.equal(h.maxLive, 1);
  assert.equal(state.response.status, 504); assert.equal(state.text.includes('"error":"deadline"'), true);
  assert.equal(spokenText(state), '');
});
