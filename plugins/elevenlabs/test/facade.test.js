import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionsHandler, bearerMatches } from '../src/facade.js';
import { beginInvocation, PluginError } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { invocationOptions, flush } from './fixtures.js';

function facadeFixture({ mode = 'normal', paused = false, deadlineAt = Date.now() + 5000, timeoutMs = 1000 } = {}) {
  const call = { callId: 'call_facade', providerSessionId: 'conv_facade', facadeSecretRef: 'fixture-per-call-ref', paused,
    spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt };
  const admissions = [], upstream = [], optionsList = [];
  const handler = createCompletionsHandler({ timeoutMs,
    getCall: async () => ({ ...call }),
    resolveSecret: ref => { assert.equal(ref, call.facadeSecretRef); return 'fixture-per-call-secret'; },
    buildRequest: async ({ messages }) => ({ system: 'Trusted session prompt', messages }),
    async admitReasoning({ callId, request, options }) {
      assert.equal(callId, call.callId); admissions.push(request);
      const invocation = invocationOptions({ ...options }); optionsList.push(invocation);
      const plugin = { async *stream(input, opts) {
        const accounting = beginInvocation(opts); const scope = operationScope(opts); let completed = false;
        try {
          scope.signal.throwIfAborted(); accounting.dispatch(); upstream.push(input);
          yield 'Hello';
          if (mode === 'stall') await new Promise((_, reject) => {
            const abort = () => reject(new PluginError('cancelled'));
            scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted) abort();
          });
          if (mode === 'broken') throw new Error('private error must not escape');
          yield ' world'; accounting.usage({ inputTokens: 13, outputTokens: 2 }); completed = true;
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
    body: JSON.stringify({ aithema_call: call.callId, model: 'untrusted-provider-choice', stream: true,
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
test('facade accepts START extra_body callback identity and rejects conflicting identities', async () => {
  const local = facadeFixture();
  const response = await local.handler(local.request({ aithema_call: undefined, extra_body: { aithema_call: local.call.callId } }));
  assert.equal(response.status, 200); await response.text();
  assert.equal((await local.handler(local.request({ extra_body: { aithema_call: 'foreign' } }))).status, 400);
  assert.equal(local.admissions.length, 1);
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
  for (const body of [{ messages: [] }, { messages: [{ role: 'tool', content: 'bad' }] },
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
