import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMistralReasoning } from '../src/index.js';
import { reasoningConformance } from '@inspr/aithema-core';
import { chatServer, binding, invocationOptions, request } from '../../../test/plugin-fixtures.js';

test('Mistral reasoning passes the full reusable conformance kit against a local fake', async t => {
  const fake = await chatServer(t);
  const plugin = createMistralReasoning({ binding: binding('mistral', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  assert.deepEqual(await reasoningConformance(plugin, request, { stallRequest: { ...request, system: 'stall' }, requestCount: () => fake.requests.length }), { ok: true, failures: [] });
  assert.equal(fake.bodies[0].provider, undefined);
  assert.ok(fake.bodies.some(b => b.response_format?.type === 'json_schema' && b.response_format.json_schema.strict));
});
test('Mistral both operations report usage, refuse missing/reused claims and emit sanitized error codes', async t => {
  const fake = await chatServer(t), plugin = createMistralReasoning({ binding: binding('mistral', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  for (const operation of ['stream', 'structured']) {
    const options = invocationOptions();
    if (operation === 'stream') for await (const delta of plugin.stream(request, options)) assert.equal(delta, 'Hello');
    else assert.deepEqual(await plugin.structured(request, options), { summary: 'Known' });
    assert.deepEqual(options.reports, [{ attemptId: options.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 4 } }]);
    await assert.rejects(operation === 'stream' ? plugin.stream(request, options).next() : plugin.structured(request, options), { code: 'already-claimed' });
  }
  await assert.rejects(plugin.structured(request, {}), { code: 'not-admitted' });
  const bad = await chatServer(t, { handler: (_, res) => { res.writeHead(429); res.end('private-detail'); } });
  const failed = createMistralReasoning({ binding: binding('mistral', bad.endpoint), resolveSecret: () => 'local-fixture' });
  const options = invocationOptions(); await assert.rejects(failed.structured(request, options), { code: 'rate-limit' });
  assert.equal(options.reports[0].outcome, 'uncertain');
});
test('Mistral cancels active streams and structured bodies; deadlines charge uncertain after dispatch', async t => {
  const fake = await chatServer(t), plugin = createMistralReasoning({ binding: binding('mistral', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  const stalled = { ...request, system: 'stall' };
  for (const operation of ['stream', 'structured']) for (const mode of ['cancelled', 'deadline']) {
    const controller = new AbortController(), options = invocationOptions({ signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? 40 : 2000) });
    if (operation === 'stream') {
      const stream = plugin.stream(stalled, options); assert.equal((await stream.next()).value, 'first');
      if (mode === 'cancelled') controller.abort();
      await assert.rejects(stream.next(), { code: mode });
    } else {
      const pending = plugin.structured(stalled, options);
      if (mode === 'cancelled') setTimeout(() => controller.abort(), 30);
      await assert.rejects(pending, { code: mode });
    }
    assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain');
  }
});
