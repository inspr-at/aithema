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
        if (state.failLookup) throw new Error('Injected generation lookup timeout');
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

for (const operation of ['stream', 'structured']) for (const promptPrice of [0, 1e-7]) {
  test(`AIT-134 gate: input bound blocks ${operation} before reservation and dispatch at prompt price ${promptPrice}`, async t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/fixture', OPENROUTER_MAX_INPUT_TOKENS: '96',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'openai/fixture': { prompt: promptPrice, completion: 1e-7 } }) });
    const binding = configured[operation === 'stream' ? 'reaction' : 'understanding'];
    const cap = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
    let dispatches = 0, reserves = 0; const reserve = cap.reserve;
    cap.reserve = (...args) => { reserves++; return reserve(...args); };
    const plugin = createOpenRouterReasoning({ binding, prices: configured.prices, spendCap: cap, resolveSecret: () => 'fixture',
      fetchImpl() { dispatches++; throw new Error('oversize input reached provider'); } });
    const consent = createProcessingConsent({ storage, bindings: [binding] });
    const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(plugin),
      presets: { best: { plugins: ['openrouter'], bindings: { reaction: binding, understanding: binding },
        policy: { endpoints: [binding.endpoint] } } } });
    const session = storage.create({ ownerToken: 'owner' });
    consent.grant({ sessionId: session.id, consentRevision: session.consentRevision + 1,
      decision: { contract: consent.describe().contract, items: ['models-international'] } });
    storage.reviseConsent(session.id, true);
    const oversized = { ...request, messages: [{ role: 'user', content: 'ö'.repeat(100) }] };
    await assert.rejects(runtime.admit({ session: storage.get(session.id),
      lane: operation === 'stream' ? 'reaction' : 'understanding', operation, request: oversized }), { code: 'not-admitted' });
    assert.equal(storage.db.prepare('SELECT count(*) n FROM budget_attempts').get().n, 0, 'no session hold for an oversized input');
    const options = { deadlineAt: Date.now() + 1000, attempt: { attemptId: 'direct', claimId: 'claim', consume() {} }, report() {} };
    await assert.rejects(operation === 'structured' ? plugin.structured(oversized, options) : (async () => {
      for await (const chunk of plugin.stream(oversized, options)) assert.fail(chunk);
    })(), { code: 'not-admitted' });
    assert.equal(reserves, 0); assert.equal(dispatches, 0);
    const sized = { ...request, messages: [{ role: 'user', content: 'x' }] };
    assert.doesNotThrow(() => plugin.estimateCost(sized, operation), 'a bounded input still prices normally');
  });
}

for (const mode of ['partial', 'transport-failure', 'unknown']) test(`AIT-163: ${mode} releases the ceiling after the evidence window and preserves late receipts`, async t => {
  const h = await costFixture(t, { mode, state: { ready: false, queries: 0, failLookup: mode === 'unknown' } });
  const operation = mode === 'partial' ? 'stream' : 'structured', admitted = await h.admit(operation);
  if (mode === 'unknown') await h.invoke(admitted, operation);
  else await assert.rejects(h.invoke(admitted, operation));
  const id = admitted.options.attempt.attemptId, before = h.runtime.budget.get(id);
  // Reproduce the older live rows: a USD 1 reservation and no acknowledged cost.
  h.storage.db.prepare('UPDATE budget_attempts SET max_micro=1000000,settled_micro=1000000 WHERE attempt_id=?').run(id);
  h.runtime.budget.observeCost(id, { settledAt: Date.now() - 600_000, estimateMicro: 600, observedCostMicro: 750 });
  assert.equal(h.balance().owner.uncertainSpendMicro, 1_000_000);
  const preview = await h.runtime.reconcileCosts({ dryRun: true });
  assert.equal(h.runtime.budget.get(id).settled_micro, 1_000_000);
  const first = await h.runtime.reconcileCosts(), replay = await h.runtime.reconcileCosts();
  assert.equal(h.runtime.budget.get(id).settled_micro, 750, 'estimate never falls below observed usage');
  assert.equal(preview.afterMicro, 750); assert.equal(first.corrected, 1); assert.equal(replay.corrected, 0);
  assert.equal(h.runtime.budget.get(id).terminal_json, before.terminal_json, 'original terminal history is retained');
  assert.equal(h.balance().owner.confirmedSpendMicro, 0, 'an estimate remains explicitly uncertain');
  assert.equal(h.balance().owner.uncertainSpendMicro, 750, 'the owner projection releases the old ceiling');
  assert.equal(h.runtime.budget.pendingCosts().length, 0, 'estimated rows leave the immediate pending set');
  assert.ok(h.cap.snapshot().uncertainMicro > 0, 'provider cap does not release an unresolved liability');
  const audit = () => h.storage.db.prepare('SELECT * FROM budget_corrections WHERE attempt_id=? ORDER BY id').all(id);
  assert.equal(audit().length, 1);
  // A late authenticated receipt supersedes an estimate exactly once, including an overrun.
  h.runtime.budget.observeCost(id, { generationId: 'gen-fixture', chargedMicro: 1_000_037 });
  await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
  assert.equal(h.runtime.budget.get(id).settled_micro, 1_000_037);
  assert.equal(h.runtime.budget.get(id).overrun, 1);
  assert.equal(audit().length, 2);
  assert.equal(h.cap.snapshot().spentMicro, 1_000_037);
  assert.throws(() => h.storage.db.prepare('UPDATE budget_corrections SET new_micro=0 WHERE attempt_id=?').run(id), /append only/u);
});

test('AIT-163 fix1: a completed lost analysis without identity uses its complete lane estimate', async t => {
  const h = await costFixture(t, { mode: 'transport-failure' }), admitted = await h.admit('structured');
  await assert.rejects(h.invoke(admitted));
  const id = admitted.options.attempt.attemptId, bound = h.runtime.budget.get(id).max_micro;
  h.runtime.budget.observeCost(id, { settledAt: Date.now() - 600_000 });
  await h.runtime.reconcileCosts();
  assert.equal(h.runtime.budget.get(id).settled_micro, bound);
  assert.equal(h.balance().owner.uncertainSpendMicro, bound);
  assert.equal(h.cap.snapshot().uncertainMicro, bound);
});

test('AIT-163 fix1: an invalid historical binding cannot abort repairs for other rows', async t => {
  const h = await costFixture(t);
  const orphan = h.storage.create({ ownerToken: 'orphan' });
  const { attemptId } = h.runtime.budget.admit({ sessionId: orphan.id, lane: 'reaction', maxMicro: 1_000_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = h.runtime.budget.claim(attemptId); claim.consume();
  h.runtime.budget.settle(claim.claimId, { attemptId, outcome: 'uncertain' });
  const get = h.storage.get.bind(h.storage);
  t.mock.method(h.storage, 'get', id => { if (id === orphan.id) throw new TypeError('Invalid historical binding'); return get(id); });
  const admitted = await h.admit(); await h.invoke(admitted);
  await assert.doesNotReject(h.runtime.reconcileCosts());
  assert.equal(h.runtime.budget.pendingCosts().length, 1, 'the valid receipt still settles');
});

test('AIT-163: pre-AIT-134 rows without provider metadata repair without rewriting terminal history', async t => {
  const h = await costFixture(t, { state: { ready: false, queries: 0 } });
  const budget = h.runtime.budget;
  const { attemptId } = budget.admit({ sessionId: h.session.id, lane: 'reaction', maxMicro: 1_000_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = budget.claim(attemptId); claim.consume();
  const original = budget.settle(claim.claimId, { attemptId, outcome: 'uncertain' }).terminal_json;
  const preview = await h.runtime.reconcileCosts({ dryRun: true });
  assert.equal(budget.get(attemptId).provider_cost_json, null);
  await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
  assert.equal(budget.get(attemptId).settled_micro, 10_000); assert.equal(preview.afterMicro, 10_000);
  assert.equal(budget.get(attemptId).terminal_json, original);
  budget.observeCost(attemptId, { generationId: 'gen-fixture' }); h.state.ready = true;
  await h.runtime.reconcileCosts(); await h.runtime.reconcileCosts();
  assert.equal(budget.get(attemptId).settled_micro, 53, 'authoritative cost supersedes the larger estimate');
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM budget_corrections WHERE attempt_id=?').get(attemptId).n, 2);
});
