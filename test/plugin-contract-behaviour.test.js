import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PluginError, PluginRegistry, SessionLanes, createMockReasoning, createSession, applyEvent,
  reasoningRequest, inputRevision } from '@inspr/aithema-core';
import { PLUGIN_ERROR_CODES, normalizedError } from '../packages/core/src/invocation.js';
import { collectPurposeReply } from '../packages/core/src/safeguards.js';
import { ReplyStream, replySchema } from '../packages/core/src/reply.js';
import { createChatCompletions } from '../packages/core/src/chat-completions.js';
import { createHandlers, createPluginRuntime } from '@inspr/aithema-server';
import { createExternalHost, externalBinding } from './fixtures/external-plugin-host.js';
import { manifest, consentItem } from './fixtures/external-plugin/index.js';
import { ownedRequest, testToken } from './helpers.js';

const guide = readFileSync(new URL('../docs/plugins.md', import.meta.url), 'utf8');
function rule(anchor, body) {
  test(`docs/plugins.md#${anchor}`, async t => {
    assert.ok(guide.includes(`<a id="${anchor}"></a>`), `restore docs/plugins.md#${anchor}`);
    await body(t);
  });
}
const policy = { purpose: 'Clarify project needs', offTopicLimit: 3, outputCheck: true, canary: 'PRIVATE_TEST_CANARY' };
const answer = { content: 'Describe the project.', question_short: null, options: [], scope: 'in' };
const request = () => reasoningRequest(createSession({ locale: 'en' }), 'reaction', false, '', { purposePolicy: policy });
const chunks = async function* (value) { for (let i = 0; i < value.length; i += 7) yield value.slice(i, i + 7); };
function operationOptions() {
  const reports = [], observations = []; let dispatches = 0, consumed = 0;
  return { reports, observations, get dispatches() { return dispatches; }, get consumed() { return consumed; },
    signal: new AbortController().signal, deadlineAt: Date.now() + 10000,
    attempt: { attemptId: 'contract-attempt', claimId: 'contract-claim', consume() { consumed++; },
      observeCost(e) { observations.push(e); }, dispatchCost() { dispatches++; } }, report: t => reports.push(t) };
}

rule('contract-manifest-freeze', () => {
  const frozen = new PluginRegistry().register(createMockReasoning()).get('mock').manifest;
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen.models[0]));
  const plugin = { ...createMockReasoning(), manifest: frozen };
  assert.equal(new PluginRegistry().register(plugin).get('mock').manifest, frozen);
  const mutable = structuredClone(frozen), registry = new PluginRegistry().register({ ...plugin, manifest: mutable });
  assert.notEqual(registry.get('mock').manifest, mutable);
  mutable.models[0].languages.push('xx');
  assert.ok(!registry.get('mock').manifest.models[0].languages.includes('xx'));
  assert.ok(Object.isFrozen(registry.get('mock').manifest.models[0].languages));
});

rule('contract-reply-request', () => {
  const guarded = request(), plain = reasoningRequest(createSession(), 'reaction');
  assert.deepEqual(plain.schema, replySchema); assert.equal(plain.purposePolicy, undefined);
  assert.ok(guarded.schema.required.includes('scope')); assert.equal(guarded.purposePolicy.canary, policy.canary);
  assert.equal(guarded.offTopicTurns, 0); assert.equal(typeof guarded.hiddenGuidance, 'string');
  assert.equal(reasoningRequest(createSession(), 'reaction', false, '', { voiceReply: true }).schema, undefined);
  assert.ok(reasoningRequest(createSession(), 'reaction', false, '', { voiceReply: true, purposePolicy: policy }).schema);
});

rule('contract-reply-policy', async () => {
  assert.deepEqual(await collectPurposeReply(request(), () => chunks('```json\n' + JSON.stringify(answer) + '\n```')), answer);
  for (const output of ['plain provider text', '{}', JSON.stringify({ ...answer, content: '' }),
    JSON.stringify({ ...answer, content: policy.canary })]) {
    let attempts = 0;
    const result = await collectPurposeReply(request(), () => { attempts++; return chunks(output); });
    assert.equal(attempts, 2); assert.ok(result.fallback); assert.notEqual(result.content, output);
    assert.ok(!result.content.includes(policy.canary));
  }
  const normalized = await collectPurposeReply(request(), () => chunks(JSON.stringify({
    content: answer.content, question_short: 'Which?', options: [{ nope: true }] })));
  assert.equal(normalized.content, answer.content); assert.equal(normalized.scope, 'unclear');
  assert.deepEqual(normalized.options, []);
  const off = await collectPurposeReply(request(), () => chunks(JSON.stringify({ ...answer, scope: 'off' })));
  assert.notEqual(off.content, answer.content); assert.equal(off.scope, 'off');
});

// Exercise real lane selection/publication as well as the standalone decoders.
for (const guarded of [false, true]) test(`docs/plugins.md#contract-reply-${guarded ? 'policy' : 'plain'} lane publication`, async () => {
  let session = createSession({ demo: true, locale: 'en' }), calls = 0, admissions = 0, finishes = 0;
  session = applyEvent(session, { seq: session.seq + 1, type: 'turn.final', data: { role: 'user', content: 'A project' } });
  const partials = [], published = [], mock = createMockReasoning();
  const plugin = { ...mock, async *stream(input) {
    assert.ok(input.schema); assert.equal(Boolean(input.purposePolicy), guarded);
    calls++; for await (const chunk of chunks(guarded ? JSON.stringify(answer) : answer.content)) {
      if (guarded) assert.equal(published.length + partials.length, 0, 'policy stream must be buffered');
      yield chunk;
    }
  } };
  const lanes = new SessionLanes({ reasoning: plugin, purposePolicy: guarded ? policy : undefined,
    getSession: () => structuredClone(session), admit: async () => {
      admissions++; return { plugin, finish() { finishes++; } };
    }, publish(id, type, data, revision) {
      assert.equal(revision, inputRevision(session)); published.push({ type, data }); return true;
    }, transient: (_, event) => partials.push(event) });
  assert.equal(await lanes.run(session.id, 'reaction'), 'completed');
  assert.equal(calls, 1); assert.equal(admissions, 1); assert.equal(finishes, 1);
  assert.equal(published.at(-1).data.content, answer.content);
  assert.equal(partials.length === 0, guarded);
});

rule('contract-reply-plain', () => {
  const stream = new ReplyStream(); assert.equal(stream.push('Ordinary text'), 'Ordinary text');
  assert.deepEqual(stream.finish(), { content: 'Ordinary text', question_short: null, options: [] });
  const json = new ReplyStream(); assert.equal(json.push('{"content":"Hello'), 'Hello');
  assert.equal(json.push('","question_short":"Which?","options":[{"bad":1}]}'), '');
  assert.deepEqual(json.finish(), { content: 'Hello', question_short: 'Which?', options: [] });
  assert.throws(() => new ReplyStream().push('x'.repeat(16001)), TypeError);
});

rule('contract-error-codes', async t => {
  const rows = [...guide.matchAll(/^\| `([a-z-]+)` \| (\d+) \|$/gmu)].map(m => [m[1], Number(m[2])]);
  assert.deepEqual(rows.map(([code]) => code), [...PLUGIN_ERROR_CODES]);
  const host = createExternalHost(); t.after(() => host.close());
  const session = host.storage.create({ ownerToken: testToken });
  for (const [code, status] of rows) {
    const handlers = createHandlers({ storage: host.storage, pluginRuntime: { ...host.pluginRuntime,
      async matrix() { throw new PluginError(code, 'private provider message'); } } });
    try {
      const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}`));
      assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: code });
    } finally { await handlers.close(); }
    const error = new PluginError(code); assert.equal(normalizedError(error), error);
  }
  assert.equal(normalizedError(new Error()).code, 'provider');
  for (const [reason, code] of [[new DOMException('timeout', 'TimeoutError'), 'deadline'], [new Error(), 'cancelled']]) {
    const controller = new AbortController(); controller.abort(reason);
    assert.equal(normalizedError(new PluginError('auth'), controller.signal).code, code);
  }
});

rule('contract-reply-retry', async () => {
  for (const providerErrorClass of ['4xx', undefined]) {
    const inputs = [];
    const result = await collectPurposeReply(request(), (input, index) => {
      inputs.push(input);
      if (!index) return (async function* () { throw Object.assign(new PluginError('provider'), {
        responseFormatUnsupported: true, providerErrorClass }); })();
      return chunks(JSON.stringify(answer));
    });
    assert.equal(inputs.length, 2); assert.equal(inputs[1].replySchemaConstrained, false);
    assert.deepEqual(inputs[1].schema, inputs[0].schema); assert.match(inputs[1].system, /previous output was rejected/u);
    assert.equal(result.fallback.kind, 'prompt-only-retry');
    assert.equal(result.fallback.reason, providerErrorClass ? 'provider-4xx' : 'schema-unsupported');
  }
  for (const code of ['auth', 'rate-limit', 'cancelled', 'deadline', 'provider']) {
    let calls = 0;
    await assert.rejects(collectPurposeReply(request(), () => (async function* () {
      calls++; throw new PluginError(code);
    })()), { code }); assert.equal(calls, 1);
  }
  for (const error of [new TypeError(), new PluginError('invalid-output'),
    Object.assign(new PluginError('provider'), { providerErrorClass: '5xx' })]) {
    let calls = 0;
    const result = await collectPurposeReply(request(), () => (async function* () {
      if (++calls === 1) yield 'bad'; else throw error;
    })());
    assert.equal(calls, 2); assert.equal(result.fallback.kind, 'neutral');
  }
});

rule('contract-http-settlement', async () => {
  for (const status of [400, 401, 403, 408, 422, 429, 499, 500, 503]) {
    for (const body of [{ error: { message: 'response_format json_schema unsupported' } },
      { error: { message: 'unrelated failure' } }, { usage: { prompt_tokens: 2, completion_tokens: 1 } },
      { usage: { cost: 0.000007 } }]) {
      for (const constrained of [false, true]) {
        const options = operationOptions(); let wire;
        const plugin = createChatCompletions({ manifest, binding: externalBinding(), resolveSecret: () => 'fake',
          authoritativeCost: true, streamSchema: true, fetchImpl: async (_, init) => {
            wire = JSON.parse(init.body); return Response.json(body, { status });
          } });
        await assert.rejects(async () => { for await (const _ of plugin.stream({ ...request(),
          ...(constrained ? {} : { replySchemaConstrained: false }) }, options)) {} }, error => {
          assert.equal(error.providerErrorClass, status < 500 ? '4xx' : '5xx');
          assert.equal(error.code, [401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider');
          assert.equal(error.responseFormatUnsupported === true, constrained && [400, 422].includes(status) && body.error?.message.includes('unsupported') === true);
          return true;
        });
        assert.equal(Boolean(wire.response_format), constrained);
        assert.equal(options.consumed, 1); assert.equal(options.dispatches, 1); assert.equal(options.reports.length, 1);
        const terminal = options.reports[0], zero = status < 500 && ![408, 499].includes(status) && !body.usage;
        assert.equal(terminal.outcome, zero || body.usage?.cost !== undefined ? 'cancelled' : 'uncertain');
        assert.equal(terminal.chargedMicro, zero ? 0 : body.usage?.cost !== undefined ? 7 : undefined);
        if (zero) assert.ok(options.observations.some(e => e.chargedMicro === 0));
      }
    }
  }
  const options = operationOptions();
  const plugin = createChatCompletions({ manifest, binding: externalBinding(), resolveSecret: () => 'fake', authoritativeCost: true,
    fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(new Error('broken body')); } }), { status: 400 }) });
  await assert.rejects(async () => { for await (const _ of plugin.stream(request(), options)) {} });
  assert.equal(options.reports[0].outcome, 'uncertain');
});

async function admittedHost(t, hooks = {}) {
  const host = createExternalHost(); t.after(() => host.close());
  const plugin = host.registry.get(manifest.id); delete plugin.bind; Object.assign(plugin, hooks);
  const session = host.storage.create({ ownerToken: testToken });
  host.consent.grant({ sessionId: session.id, consentRevision: 1,
    decision: { contract: host.consent.describe().contract, items: [consentItem.id] } });
  host.storage.reviseConsent(session.id, true);
  return { ...host, plugin, session: host.storage.get(session.id) };
}
rule('contract-cost-reservation', async t => {
  const calls = [], providerCalls = [];
  const host = await admittedHost(t, { estimateCost(input, op) { calls.push([input, op]); return 10000; },
    providerOptions(stream) { providerCalls.push(stream); return { fixtureOption: true }; } });
  const input = request(), admitted = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: input });
  assert.ok(calls.length >= 2); assert.ok(calls.every(([r, op]) => r === input && op === 'stream'));
  assert.ok(providerCalls.includes(true)); assert.equal(host.pluginRuntime.budget.get(admitted.options.attempt.attemptId).max_micro, 10000);
  assert.equal(admitted.options.attempt.observeCost, undefined); assert.equal(admitted.options.attempt.dispatchCost, undefined);
  await admitted.options.attempt.consume(); admitted.options.report({ attemptId: admitted.options.attempt.attemptId, outcome: 'uncertain' }); admitted.finish();
  assert.equal(host.pluginRuntime.budget.get(admitted.options.attempt.attemptId).settled_micro, 10000);
  // Adapter options contribute to the separate byte/token ceiling even with an estimate.
  host.plugin.providerOptions = () => ({ large: 'x'.repeat(host.binding.maxMicro) });
  await assert.rejects(host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: input }), { code: 'not-admitted' });
  delete host.plugin.estimateCost; delete host.plugin.providerOptions;
  const fallback = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: input });
  assert.equal(host.pluginRuntime.budget.get(fallback.options.attempt.attemptId).max_micro, host.binding.maxMicro);
  fallback.options.report({ attemptId: fallback.options.attempt.attemptId, outcome: 'uncertain' }); fallback.finish();
});

rule('contract-cost-reconciliation', async t => {
  const lookups = [], repaired = [], saved = [];
  const host = await admittedHost(t, { uncertainEstimateMicro: 50,
    estimateUncertainCost: () => 60, costEvidence(id) { saved.push(id); }, usageCost: () => 80,
    reconcileSpend(...args) { repaired.push(args); },
    reconcileCost(record, options) { lookups.push({ record, options }); return { chargedMicro: 90 }; } });
  const admitted = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: request() });
  const attempt = admitted.options.attempt;
  assert.equal(typeof attempt.observeCost, 'function'); assert.equal(typeof attempt.dispatchCost, 'function');
  await attempt.consume(); attempt.dispatchCost(); attempt.observeCost({ generationId: 'gen-contract', observedCostMicro: 80 });
  admitted.options.report({ attemptId: attempt.attemptId, outcome: 'uncertain' }); admitted.finish();
  const before = host.pluginRuntime.budget.get(attempt.attemptId), record = JSON.parse(before.provider_cost_json);
  assert.equal(record.generationId, 'gen-contract'); assert.equal(record.observedCostMicro, 80); assert.equal(record.estimateMicro, 60);
  assert.equal(record.dispatchStarted, 1);
  const start = Date.now(); await host.pluginRuntime.reconcileCosts();
  assert.equal(lookups.length, 1); assert.equal(saved[0], attempt.attemptId);
  assert.equal(lookups[0].record.generationId, 'gen-contract');
  assert.ok(lookups[0].options.deadlineAt >= start && lookups[0].options.deadlineAt <= Date.now() + 5000);
  assert.equal(host.pluginRuntime.budget.get(attempt.attemptId).settled_micro, 90);
  assert.deepEqual(repaired, [[attempt.attemptId, 90]]);
});

rule('contract-reply-retry', async t => {
  const host = await admittedHost(t), ids = [];
  const result = await collectPurposeReply(request(), async function* (input, index) {
    const admitted = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: input });
    const { attempt, report } = admitted.options; ids.push(attempt.attemptId);
    try {
      await attempt.consume();
      report({ attemptId: attempt.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, chargedMicro: 7 });
      yield index ? JSON.stringify(answer) : 'invalid JSON';
    } finally { admitted.finish(); }
  });
  assert.equal(result.content, answer.content); assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.equal(host.pluginRuntime.budget.get(id).settled_micro, 7);
});

rule('contract-cost-reconciliation', async t => {
  for (const configured of [undefined, 50]) {
    const host = await admittedHost(t, { reconcileCost: async () => null,
      ...(configured === undefined ? {} : { uncertainEstimateMicro: configured }) });
    const admitted = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: request() });
    const { attempt, report } = admitted.options;
    await attempt.consume(); attempt.dispatchCost(); attempt.observeCost({ observedCostMicro: 80 });
    report({ attemptId: attempt.attemptId, outcome: 'uncertain' }); admitted.finish();
    // Deterministically advance only the runtime's reconciliation clock.
    const runtime = createPluginRuntime({ storage: host.storage, reasoning: host.plugin, registry: host.registry,
      budget: host.pluginRuntime.budget, now: () => Date.now() + 600000 });
    await runtime.reconcileCosts();
    const row = runtime.budget.get(attempt.attemptId);
    assert.equal(row.settled_micro, configured === undefined ? host.binding.maxMicro : 80);
    if (configured !== undefined) {
      assert.equal(JSON.parse(row.cost_reconciliation_json).estimated, true);
      attempt.observeCost({ chargedMicro: 90 }); await runtime.reconcileCosts();
      assert.equal(runtime.budget.get(attempt.attemptId).settled_micro, 90);
    } else assert.equal(row.cost_reconciliation_json, null);
  }
});

rule('contract-cost-reconciliation', async t => {
  const costCalls = [], usageCalls = []; let lookups = 0;
  const host = await admittedHost(t, { reconcileCost() { lookups++; },
    costEvidence(id) { costCalls.push(id); return { chargedMicro: 3 }; },
    usageCost(value, model) { usageCalls.push([value, model]); return 3; } });
  const admitted = await host.pluginRuntime.admit({ session: host.session, lane: 'reaction', operation: 'stream', request: request() });
  const { attempt, report } = admitted.options;
  await attempt.consume(); attempt.dispatchCost();
  report({ attemptId: attempt.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 } }); admitted.finish();
  await host.pluginRuntime.reconcileCosts();
  assert.equal(lookups, 0); assert.deepEqual(costCalls, [attempt.attemptId]);
  assert.deepEqual(usageCalls, [[{ inputTokens: 1, outputTokens: 1 }, host.binding.model]]);
  assert.equal(host.pluginRuntime.budget.get(attempt.attemptId).settled_micro, 3);
});
