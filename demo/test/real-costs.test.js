import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime, createSpendCap, createHandlers } from '@inspr/aithema-server';
import { PluginRegistry, budgetCreditView } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createVoiceHost } from '../start2-voice-host.js';
import { openRouterConfig } from '../openrouter-config.js';
import { createProcessingConsent } from '../processing-consent.js';
import { createDemoHost } from '../host-ports.js';
import { fakeElevenLabs } from '../../test/start2-fakes.js';
import { temporaryDb } from '../../test/helpers.js';

const prices = { 'openai/fixture': { prompt: 1e-7, completion: 1e-7 } };
const request = { system: 'Policy', messages: [{ role: 'user', content: 'Hello' }],
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } };

test('AIT-134 red-before: reasoning reserves its price estimate instead of USD 1', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/fixture', AITHEMA_OPENROUTER_PRICES: JSON.stringify(prices) });
  const binding = configured.reaction, session = storage.create({ ownerToken: 'owner' });
  const consent = createProcessingConsent({ storage, bindings: [binding] });
  consent.grant({ sessionId: session.id, consentRevision: session.consentRevision + 1,
    decision: { contract: consent.describe().contract, items: ['models-international'] } });
  storage.reviseConsent(session.id, true);
  const plugin = createOpenRouterReasoning({ binding, prices, resolveSecret: () => 'fixture',
    fetchImpl: () => { throw new Error('This test only admits'); } });
  const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(plugin),
    presets: { best: { plugins: ['openrouter'], bindings: { reaction: binding }, policy: { endpoints: [binding.endpoint] } } } });
  const admitted = await runtime.admit({ session: storage.get(session.id), lane: 'reaction', operation: 'stream', request });
  const held = runtime.budget.used(session.id);
  admitted.finish({ failed: true });
  assert.ok(held > 0 && held < 10_000, `Expected a real-price hold below USD 0.01, got ${held} microUSD`);
});

test('AIT-134 red-before: voice reserves a short expected segment with a 60-minute technical ceiling', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const provider = await fakeElevenLabs(t);
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://fixture.test',
    apiBaseUrl: provider.endpoint, resolveSecret: () => 'fixture' });
  assert.ok(host.binding);
  assert.equal(host.binding.maxDurationSeconds, 3600);
  assert.equal(host.binding.maxMicro, 50_000);
});

test('AIT-134 red-before: owner holds count once and credits distinguish reserved and actual spend', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create({ ownerToken: 'owner' }), ledger = new SQLiteBudgetLedger(storage);
  const host = createDemoHost({ storage }), wallet = host.wallet('owner');
  const admission = { attemptId: 'known-operation', sessionId: session.id, lane: 'reaction', maxMicro: 200,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
  await wallet.admit(admission); ledger.admit(admission);
  assert.equal(wallet.balance().committedMicro, 200);
  let view = budgetCreditView(ledger, session.id, wallet);
  assert.equal(view.owner.reservedMicro, 200);
  const claim = ledger.claim(admission.attemptId); claim.consume();
  ledger.settle(claim.claimId, { attemptId: admission.attemptId, outcome: 'completed',
    usage: { inputTokens: 10, outputTokens: 20 }, chargedMicro: 37 });
  view = budgetCreditView(ledger, session.id, wallet);
  assert.equal(view.owner.confirmedSpendMicro, 37);
  assert.equal(view.owner.reservedMicro, 0);
  assert.equal(view.owner.availableMicro, view.owner.limitMicro - 37);
});

async function costFixture(t, { mode = 'known', path, state = { queries: 0, ready: true }, storage: previous } = {}) {
  const storage = previous ?? new SQLiteStorage(path); t.after(() => { if (storage.db.isOpen) storage.close(); });
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/fixture', AITHEMA_OPENROUTER_PRICES: JSON.stringify(prices) });
  const binding = configured.reaction;
  const cap = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
  const consent = createProcessingConsent({ storage, bindings: [binding, configured.understanding] });
  const plugin = createOpenRouterReasoning({ binding, prices, spendCap: cap, resolveSecret: () => 'fixture',
    fetchImpl: async (url, init) => {
      if (init.method !== 'POST') {
        state.queries++;
        assert.equal(new URL(url).searchParams.get('id'), 'gen-fixture');
        return Response.json(state.ready ? { data: { id: 'gen-fixture', total_cost: 0.000053 } } : {}, { status: state.ready ? 200 : 404 });
      }
      const body = JSON.parse(init.body); assert.equal(body.usage.include, true);
      if (mode === 'late-response') { state.sent.resolve(); return state.lateResponse.promise; }
      if (mode === 'transport-failure') throw new Error('injected transport failure');
      if (mode === 'cancel-body') return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"gen-fixture",')); },
      }));
      const usage = { prompt_tokens: 10, completion_tokens: 20,
        ...(['unknown', 'partial'].includes(mode) ? {} : { cost: mode === 'zero' ? 0 : 0.000037 }) };
      const payload = { id: 'gen-fixture', usage, choices: [{ finish_reason: mode === 'invalid' ? 'length' : 'stop',
        message: { content: '{"summary":"Known"}' }, delta: { content: 'Known' } }] };
      if (!body.stream || mode === 'http-error') return Response.json(payload, { status: mode === 'http-error' ? 500 : 200 });
      return new Response(`data: ${JSON.stringify(payload)}\n\n${mode === 'partial' ? '' : 'data: [DONE]\n\n'}`);
    } });
  const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(plugin),
    presets: { best: { plugins: ['openrouter'], bindings: { reaction: binding, understanding: configured.understanding },
      policy: { endpoints: [binding.endpoint] } } } });
  const host = createDemoHost({ storage }); runtime.setOwnerWallet(session => host.walletForSession(session));
  let session;
  if (storage.list().length) session = storage.get(storage.list()[0]);
  else {
    session = storage.create({ ownerToken: 'owner' });
    consent.grant({ sessionId: session.id, consentRevision: session.consentRevision + 1,
      decision: { contract: consent.describe().contract, items: ['models-international'] } });
    storage.reviseConsent(session.id, true); session = storage.get(session.id);
  }
  const balance = () => budgetCreditView(runtime.budget, session.id, host.wallet('owner'));
  const admit = (operation = 'structured', options = {}) => runtime.admit({ session: storage.get(session.id),
    lane: operation === 'stream' ? 'reaction' : 'understanding', operation, request, options });
  const invoke = async (admitted, operation = 'structured') => {
    try {
      if (operation === 'stream') { for await (const chunk of admitted.plugin.stream(request, admitted.options)) assert.equal(chunk, 'Known'); }
      else await admitted.plugin.structured(request, admitted.options);
    } finally { admitted.finish({ failed: true }); }
  };
  return { storage, runtime, cap, host, session, state, balance, admit, invoke };
}

for (const operation of ['stream', 'structured']) for (const mode of ['known', 'zero', 'invalid', 'http-error']) {
  test(`actual OpenRouter costs reach both ledgers and credits: ${operation} ${mode}`, async t => {
    const h = await costFixture(t, { mode }), admitted = await h.admit(operation);
    assert.ok(h.balance().owner.reservedMicro < 10_000);
    const result = h.invoke(admitted, operation);
    if (['invalid', 'http-error'].includes(mode)) await assert.rejects(result);
    else await result;
    const actual = mode === 'zero' ? 0 : 37;
    assert.equal(h.balance().owner.confirmedSpendMicro, actual);
    assert.equal(h.balance().session.confirmedSpendMicro, actual);
    assert.equal(h.balance().owner.reservedMicro, 0);
    assert.equal(h.cap.snapshot().spentMicro, actual);
    assert.equal(h.cap.snapshot().reservedMicro, 0);
    const row = h.runtime.budget.get(admitted.options.attempt.attemptId);
    assert.equal(JSON.parse(row.provider_cost_json).generationId, 'gen-fixture');
    await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
    assert.equal(h.state.queries, 0, 'known receipts do not need a generation lookup');
    assert.equal(h.balance().owner.committedMicro, actual);
  });
}

for (const mode of ['unknown', 'partial', 'cancel-body', 'transport-failure']) test(`unknown dispatch is visible and durably reconciled: ${mode}`, async t => {
  const path = await temporaryDb(), state = { ready: false, queries: 0 };
  let h = await costFixture(t, { mode, path, state });
  const controller = new AbortController(), operation = mode === 'partial' ? 'stream' : 'structured';
  const admitted = await h.admit(operation, { signal: controller.signal, deadlineAt: Date.now() + 1000 });
  const attemptId = admitted.options.attempt.attemptId;
  const pending = h.invoke(admitted, operation);
  if (mode === 'cancel-body') {
    const rejected = assert.rejects(pending, { code: 'cancelled' });
    while (!JSON.parse(h.runtime.budget.get(attemptId).provider_cost_json).generationId) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await rejected;
  } else if (['partial', 'transport-failure'].includes(mode)) await assert.rejects(pending);
  else await pending;
  const held = h.balance().owner.uncertainSpendMicro;
  assert.ok(held > 0); assert.equal(h.balance().owner.reservedMicro, 0);
  assert.equal(h.balance().owner.confirmedSpendMicro, 0);
  assert.equal(h.cap.snapshot().uncertainMicro, held);
  await h.runtime.reconcileCosts(); assert.equal(h.balance().owner.uncertainSpendMicro, held);
  h.storage.close(); state.ready = true;
  h = await costFixture(t, { mode, path, state });
  h.runtime.budget.recover(); h.runtime.recoverCosts(); await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
  if (mode === 'transport-failure') {
    assert.equal(h.balance().owner.uncertainSpendMicro, held, 'without a returned generation ID no cost is invented');
    assert.equal(state.queries, 0);
  } else {
    assert.equal(h.balance().owner.confirmedSpendMicro, 53);
    assert.equal(h.balance().owner.uncertainSpendMicro, 0);
    assert.equal(h.cap.snapshot().spentMicro, 53);
    assert.equal(h.cap.snapshot().uncertainMicro, 0);
    assert.equal(state.queries, 2, 'one failed lookup and one retry after restart; settled results are not fetched twice');
  }
});

for (const crash of ['admitted', 'reserved', 'consumed', 'dispatched', 'id-receipt', 'cost-receipt', 'budget-receipt', 'settled']) {
  test(`crash recovery loses no cost or hold: ${crash}`, async t => {
    const path = await temporaryDb(), state = { ready: true, queries: 0 };
    let h = await costFixture(t, { path, state });
    const admitted = await h.admit(), attempt = admitted.options.attempt, attemptId = attempt.attemptId;
    const estimate = h.runtime.budget.get(attemptId).max_micro;
    const handle = crash === 'admitted' ? null : h.cap.reserve(estimate, { attemptId, provider: 'openrouter' });
    if (!['admitted', 'reserved'].includes(crash)) await attempt.consume();
    if (['dispatched', 'id-receipt', 'cost-receipt', 'budget-receipt', 'settled'].includes(crash)) {
      attempt.dispatchCost(); h.cap.dispatch(handle);
    }
    if (['id-receipt', 'cost-receipt'].includes(crash)) h.cap.record(handle,
      { generationId: 'gen-fixture', ...(crash === 'cost-receipt' ? { chargedMicro: 37 } : {}) });
    if (['budget-receipt', 'settled'].includes(crash)) attempt.observeCost({ generationId: 'gen-fixture', chargedMicro: 37 });
    if (crash === 'settled') {
      const terminal = { attemptId, outcome: 'completed', usage: { inputTokens: 10, outputTokens: 20 }, chargedMicro: 37 };
      admitted.options.report(terminal); h.runtime.budget.settle(attempt.claimId, terminal);
    }
    h.storage.close(); h = await costFixture(t, { path, state });
    h.runtime.budget.recover(); h.host.recoverWallets(); h.runtime.recoverCosts();
    await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
    assert.equal(h.balance().owner.reservedMicro, 0); assert.equal(h.cap.snapshot().reservedMicro, 0);
    if (crash === 'dispatched') {
      assert.equal(h.balance().owner.uncertainSpendMicro, estimate);
      assert.equal(h.cap.snapshot().uncertainMicro, estimate);
    } else {
      const actual = ['cost-receipt', 'budget-receipt', 'settled'].includes(crash) ? 37 : crash === 'id-receipt' ? 53 : 0;
      assert.equal(h.balance().owner.committedMicro, actual);
      assert.equal(h.cap.snapshot().spentMicro, actual);
      assert.equal(h.cap.snapshot().uncertainMicro, 0);
    }
  });
}

test('credits HTTP exposes real cost categories and preserves the existing available/limit fields', async t => {
  const h = await costFixture(t), handlers = createHandlers({ storage: h.storage, pluginRuntime: h.runtime, consent: h.runtime.consent, host: h.host });
  t.after(() => handlers.close());
  const admitted = await h.admit(); await h.invoke(admitted);
  const response = await handlers.handle(new Request(`https://fixture.test/api/sessions/${h.session.id}/credits`, {
    headers: { 'x-aithema-session-token': 'owner' } }));
  assert.equal(response.status, 200); const { balance } = await response.json();
  assert.equal(balance.owner.confirmedSpendMicro, 37);
  assert.equal(balance.owner.availableMicro, balance.owner.limitMicro - 37);
  assert.equal(balance.owner.reservedMicro, 0); assert.equal(balance.owner.uncertainSpendMicro, 0);
});

for (const stalled of [false, true]) test(`a transport ignoring cancellation retains late ${stalled ? 'identity with a bounded body' : 'actual billing'} without a second terminal`, { timeout: 2500 }, async t => {
  const state = { ready: true, queries: 0, sent: Promise.withResolvers(), lateResponse: Promise.withResolvers() };
  const h = await costFixture(t, { mode: 'late-response', state }), controller = new AbortController();
  const admitted = await h.admit('structured', { signal: controller.signal });
  let reports = 0; const report = admitted.options.report;
  admitted.options.report = terminal => { reports++; return report(terminal); };
  const pending = h.invoke(admitted), rejected = assert.rejects(pending, { code: 'cancelled' });
  await state.sent.promise; controller.abort(); await rejected;
  assert.ok(h.balance().owner.uncertainSpendMicro > 0);
  if (stalled) {
    const cancelled = Promise.withResolvers();
    state.lateResponse.resolve(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"gen-fixture",')); },
      cancel() { cancelled.resolve(); },
    })));
    await cancelled.promise;
    await h.runtime.reconcileCosts(); assert.equal(h.balance().owner.confirmedSpendMicro, 53);
  } else {
    state.lateResponse.resolve(Response.json({ id: 'gen-fixture', usage: { cost: 0.000037 } }));
    for (let i = 0; i < 100 && h.balance().owner.confirmedSpendMicro !== 37; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.balance().owner.confirmedSpendMicro, 37);
  }
  assert.equal(reports, 1); assert.equal(h.balance().owner.uncertainSpendMicro, 0);
  assert.equal(h.cap.snapshot().uncertainMicro, 0);
});
