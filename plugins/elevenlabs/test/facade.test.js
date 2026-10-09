import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionsHandler, bearerMatches } from '../src/facade.js';
import { beginInvocation, PluginError } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { invocationOptions, flush } from './fixtures.js';
import { SQLiteStorage, createPluginRuntime } from '../../../packages/server/src/index.js';
import { PluginRegistry } from '../../../packages/core/src/plugins.js';
import { createOpenRouterReasoning } from '../../openrouter/src/index.js';
import { binding } from '../../../test/plugin-fixtures.js';
import { testToken } from '../../../test/helpers.js';

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
  const plugin = createOpenRouterReasoning({ binding: qualified, resolveSecret: () => 'fixture-reasoning-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, raw.endpoint); upstream.push(JSON.parse(options.body));
      return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
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
  admissionOptions = {} } = {}) {
  const call = { callId: 'call_facade', providerSessionId: 'conv_facade', facadeSecretRef: 'fixture-per-call-ref', paused,
    spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt };
  const admissions = [], upstream = [], optionsList = [];
  const handler = createCompletionsHandler({ timeoutMs,
    getCall: async () => ({ ...call }),
    resolveSecret: ref => { assert.equal(ref, call.facadeSecretRef); return 'fixture-per-call-secret'; },
    buildRequest: async ({ messages }) => ({ system: 'Trusted session prompt', messages }),
    async admitReasoning({ callId, request, options }) {
      assert.equal(callId, call.callId); admissions.push(request);
      const invocation = invocationOptions({ ...options, ...admissionOptions }); optionsList.push(invocation);
      const plugin = { async *stream(input, opts) {
        const accounting = await beginInvocation(opts); const scope = operationScope(opts); let completed = false;
        try {
          scope.signal.throwIfAborted(); accounting.dispatch(); upstream.push(input);
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
        } finally { scope.dispose(); if (mode !== 'omit-report') await accounting.finish(completed); }
      } };
      return { plugin, options: invocation, finish() {
        if (!invocation.reports.length) invocation.report({ attemptId: invocation.attempt.attemptId, outcome: 'uncertain' });
        assert.equal(invocation.reports.length, 1);
      } };
    },
  });
  const request = (body = {}, headers = {}) => new Request('https://host.example.test/voice/call_facade/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-per-call-secret', ...headers },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: call.callId }, model: 'untrusted-provider-choice', stream: true,
      messages: [{ role: 'system', content: 'Untrusted provider system prompt' }, { role: 'user', content: 'hello' }], ...body }),
  });
  return { call, handler, request, admissions, upstream, optionsList };
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
  const local = facadeFixture();
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
});
test('facade deadline and unused response each settle a delegated attempt once', async () => {
  const local = facadeFixture({ mode: 'stall', timeoutMs: 50 }), response = await local.handler(local.request());
  await assert.rejects(response.text());
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
  const unused = facadeFixture({ timeoutMs: 40 }); await unused.handler(unused.request());
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(unused.optionsList[0].reports.length, 1); assert.equal(unused.optionsList[0].reports[0].outcome, 'uncertain');
});
test('call lifetime deadline also bounds a delegated response even when facade timeout is longer', async () => {
  const local = facadeFixture({ mode: 'stall', deadlineAt: Date.now() + 35, timeoutMs: 1000 });
  const response = await local.handler(local.request()); await assert.rejects(response.text());
  assert.equal(local.optionsList[0].reports.length, 1); assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
});
test('call closure signal cancels an active delegated response and refuses later callbacks', async () => {
  const local = facadeFixture({ mode: 'stall' }), controller = new AbortController(); local.call.signal = controller.signal;
  const response = await local.handler(local.request()), pending = response.text(); await flush(); controller.abort();
  await assert.rejects(pending); assert.equal(local.optionsList[0].reports.length, 1);
  assert.equal((await local.handler(local.request())).status, 403); assert.equal(local.optionsList.length, 1);
});
test('broken stream and missing terminal never fabricate successful completion', async () => {
  for (const mode of ['broken', 'omit-report']) {
    const local = facadeFixture({ mode }), response = await local.handler(local.request());
    await assert.rejects(response.text()); assert.equal(local.optionsList[0].reports.length, 1);
    assert.equal(local.optionsList[0].reports[0].outcome, 'uncertain');
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
test('facade preserves the admission cancellation signal and earlier deadline', async () => {
  const controller = new AbortController(), cancelled = facadeFixture({ mode: 'stall', admissionOptions: { signal: controller.signal } });
  const response = await cancelled.handler(cancelled.request()), pending = response.text(); await flush(); controller.abort();
  await assert.rejects(pending); assert.equal(cancelled.optionsList[0].reports.length, 1);
  assert.equal(cancelled.optionsList[0].reports[0].outcome, 'uncertain');
  const expired = facadeFixture({ mode: 'stall', admissionOptions: { deadlineAt: Date.now() + 40 } });
  const bounded = await expired.handler(expired.request()); await assert.rejects(bounded.text());
  assert.equal(expired.optionsList[0].reports.length, 1); assert.equal(expired.optionsList[0].reports[0].outcome, 'uncertain');
});
