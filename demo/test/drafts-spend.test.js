import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '@inspr/aithema-server';
import { SQLiteBudgetLedger } from '../../packages/server/src/budget.js';
import { createClaudeHTML, createSpendLedger } from '@inspr/aithema-plugin-claude-html';
import { createPluginRuntime } from '@inspr/aithema-server';
import { PluginRegistry } from '@inspr/aithema-core';
import { temporaryDb } from '../../test/helpers.js';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';
import { htmlConfig } from '../html-config.js';

const model = 'anthropic/claude-opus-5.5';
const values = { AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: model,
  AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [model]: { prompt: 5e-6, completion: 25e-6 } }) };
const document = '<!doctype html><html lang="en"><head><!-- Revision 1: Repairs. --><meta charset="utf-8"><title>Repairs</title></head><body><button onclick="this.textContent=\'Open\'">Repairs</button></body></html>';

for (const mode of ['completed', 'invalid-output', 'http-error', 'http-zero', 'http-unknown-json', 'http-non-json', 'http-tokens-only',
  'cancelled-known', 'cancelled-unknown', 'unsent']) {
  test(`draft holds settle both ledgers: ${mode}`, async t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    const session = storage.create(), budget = new SQLiteBudgetLedger(storage);
    const configured = htmlConfig(values);
    const binding = configured.binding, spend = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'concept', maxMicro: binding.maxMicro,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    assert.equal(budget.used(session.id), 1_000_000);
    const claim = budget.claim(attemptId), controller = new AbortController();
    const started = Promise.withResolvers(); let calls = 0;
    const plugin = createClaudeHTML({ binding, spend, resolveSecret: () => mode === 'unsent' ? null : 'fixture',
      now: () => { if (mode === 'cancelled-known') controller.abort(); return Date.now(); },
      fetchImpl: async () => {
        calls++; assert.equal(budget.used(session.id), 1_000_000);
        assert.ok(spend.snapshot().reservedMicro > 0); started.resolve();
        if (mode === 'cancelled-unknown') return new Promise(() => {});
        if (mode === 'http-non-json') return new Response('Not JSON', { status: 500 });
        const usage = mode === 'http-unknown-json' ? undefined : { prompt_tokens: 10, completion_tokens: 20,
          ...(mode === 'http-tokens-only' ? {} : { cost: mode === 'http-zero' ? 0 : 0.001234 }) };
        return Response.json({ usage,
          choices: [{ finish_reason: mode === 'invalid-output' ? 'length' : 'stop', message: { content: document } }] },
        { status: mode.startsWith('http-') ? 500 : 200 });
      } });
    const pending = plugin.generate({ prompt: 'Repairs', language: 'en' }, '', { signal: controller.signal,
      deadlineAt: Date.now() + 5000, attempt: claim, report: terminal => budget.settle(claim.claimId, terminal, binding.rates) });
    if (mode === 'completed') await pending;
    else {
      const rejected = assert.rejects(pending, { code: { 'invalid-output': 'invalid-output', 'http-error': 'provider',
        'http-zero': 'provider', 'http-unknown-json': 'provider', 'http-non-json': 'provider', 'http-tokens-only': 'provider',
        'cancelled-known': 'cancelled', 'cancelled-unknown': 'cancelled', unsent: 'auth' }[mode] });
      if (mode === 'cancelled-unknown') { await started.promise; controller.abort(); }
      await rejected;
    }
    const row = budget.get(attemptId), account = spend.snapshot();
    assert.equal(row.state, 'settled'); assert.equal(account.reservedMicro, 0);
    if (['cancelled-unknown', 'http-unknown-json', 'http-non-json'].includes(mode)) {
      assert.equal(row.outcome, 'uncertain');
      assert.equal(account.spentMicro, 0); assert.ok(account.uncertainMicro > 0, 'unknown dispatch is an estimate, not confirmed spend');
      const reservation = storage.db.prepare('SELECT ceiling_micro FROM spend_reservations').get();
      assert.equal(account.uncertainMicro, reservation.ceiling_micro);
      assert.equal(row.settled_micro, account.uncertainMicro, 'unknown spend uses the same estimate in both ledgers');
    } else if (mode === 'http-tokens-only') {
      assert.equal(account.uncertainMicro, storage.db.prepare('SELECT ceiling_micro FROM spend_reservations').get().ceiling_micro);
      assert.equal(row.settled_micro, account.uncertainMicro, 'tokens without cost evidence stay uncertain in the wallet too');
    } else {
      const actual = ['unsent', 'http-zero'].includes(mode) ? 0 : 1234;
      assert.equal(account.spentMicro, actual);
      assert.equal(row.settled_micro, actual, 'credits and the deployment cap use the provider cost');
      assert.equal(row.outcome, mode === 'completed' ? 'completed' : 'cancelled');
    }
    assert.equal(calls, mode === 'unsent' ? 0 : 1);
  });
}

for (const mode of ['cancelled', 'deadline', 'oversized']) test(`HTTP error body reading stays bounded: ${mode}`, { timeout: 3000 }, async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const { binding } = htmlConfig(values), spend = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
  const controller = new AbortController(), reading = Promise.withResolvers();
  let cancelled = false;
  const plugin = createClaudeHTML({ binding, spend, resolveSecret: () => 'fixture',
    fetchImpl: async () => new Response(new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancelled = true; } }),
      { status: 500, headers: mode === 'oversized' ? { 'content-length': String(4 * 1024 * 1024 + 1) } : {} }) });
  const reports = [], pending = plugin.generate({ prompt: 'Repairs' }, '', { signal: controller.signal,
    deadlineAt: Date.now() + (mode === 'deadline' ? 100 : 2000),
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report: terminal => reports.push(terminal) });
  const rejected = assert.rejects(pending, { code: mode === 'oversized' ? 'provider' : mode });
  if (mode === 'cancelled') { await reading.promise; controller.abort(); }
  await rejected;
  assert.equal(cancelled, true); assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain');
  assert.equal(spend.snapshot().reservedMicro, 0); assert.equal(spend.snapshot().spentMicro, 0); assert.ok(spend.snapshot().uncertainMicro > 0);
});

test('AIT-134 gate: default JSON drafts ledger retains uncertain costs and reconciles in parity after restart', async t => {
  const path = await temporaryDb(), spendPath = `${path}.spend.json`, state = { final: false, queries: 0 };
  let storage, budget, plugin, runtime, spend;
  const reopen = () => {
    storage = new SQLiteStorage(path); budget = new SQLiteBudgetLedger(storage);
    const { binding } = htmlConfig(values);
    plugin = createClaudeHTML({ binding, spendPath, resolveSecret: () => 'fixture',
      fetchImpl: async (url, options) => {
        if (options.method === 'POST') return Response.json({ id: 'gen-json-ledger',
          usage: { prompt_tokens: 10, completion_tokens: 20 },
          choices: [{ finish_reason: 'stop', message: { content: document } }] });
        state.queries++; assert.equal(new URL(url).searchParams.get('id'), 'gen-json-ledger');
        return Response.json(state.final ? { data: { id: 'gen-json-ledger', total_cost: 0.001234 } } : {},
          { status: state.final ? 200 : 404 });
      } });
    spend = plugin.spend;
    runtime = createPluginRuntime({ storage, budget, registry: new PluginRegistry().register(plugin) });
  };
  reopen(); t.after(() => { if (storage.db.isOpen) storage.close(); });
  const session = storage.create(), { binding } = htmlConfig(values), request = { prompt: 'Repairs', language: 'en' };
  const ceiling = plugin.estimateCost(request);
  const { attemptId } = budget.admit({ sessionId: session.id, lane: 'concept', maxMicro: ceiling,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
    providerCost: { plugin: plugin.id, endpoint: binding.endpoint, secretRef: binding.secretRef } });
  const claim = budget.claim(attemptId);
  await plugin.generate(request, '', { deadlineAt: Date.now() + 1000,
    attempt: { ...claim, dispatchCost: () => budget.markCostDispatch(attemptId), observeCost: evidence => budget.observeCost(attemptId, evidence) },
    report: terminal => budget.settle(claim.claimId, terminal) });
  assert.equal(spend.snapshot().spentMicro, 0, 'unknown cost cannot become confirmed account spend');
  assert.equal(spend.snapshot().reservedMicro, 0); assert.equal(spend.snapshot().uncertainMicro, ceiling);
  assert.equal(budget.breakdown(session.id).uncertainSpendMicro, ceiling);
  assert.deepEqual(spend.evidence(attemptId), { generationId: 'gen-json-ledger' });
  await runtime.reconcileCosts(); assert.equal(spend.snapshot().uncertainMicro, ceiling);
  storage.close(); state.final = true; reopen(); runtime.recoverCosts();
  await runtime.reconcileCosts(); await runtime.reconcileCosts();
  assert.equal(spend.snapshot().spentMicro, 1234); assert.equal(spend.snapshot().uncertainMicro, 0);
  assert.equal(budget.breakdown(session.id).confirmedSpendMicro, 1234); assert.equal(state.queries, 2);
  assert.equal(JSON.parse(budget.get(attemptId).provider_cost_json).reconciled, 1);
});

test('AIT-134 gate: drafts reject an account port that cannot durably reconcile costs at startup', () => {
  assert.throws(() => createClaudeHTML({ binding: htmlConfig(values).binding,
    spend: { snapshot: () => ({ spentMicro: 0, reservedMicro: 0 }), reserve() {}, settle() {} } }),
  /reconciliation/u);
});

for (const crash of ['reserved', 'dispatched', 'id-receipt', 'cost-receipt', 'settled']) {
  test(`AIT-134 gate: JSON account ledger recovers ${crash} without lost or duplicated cost`, async () => {
    const path = `${await temporaryDb()}.spend.json`;
    let spend = createSpendLedger({ path, capMicro: 1000 });
    const handle = spend.reserve(100, { attemptId: 'draft-attempt', provider: 'openrouter' });
    assert.equal(typeof spend.dispatch, 'function', 'default ledger needs durable dispatch state');
    if (crash !== 'reserved') spend.dispatch(handle);
    if (['id-receipt', 'cost-receipt', 'settled'].includes(crash)) spend.record(handle,
      { generationId: 'gen-json-crash', ...(crash === 'id-receipt' ? {} : { chargedMicro: 37 }) });
    if (crash === 'settled') spend.settle(handle, 37);
    spend = createSpendLedger({ path, capMicro: 1000 }); spend.recover(); spend.recover();
    assert.equal(spend.snapshot().reservedMicro, 0);
    assert.equal(spend.snapshot().spentMicro, ['cost-receipt', 'settled'].includes(crash) ? 37 : 0);
    assert.equal(spend.snapshot().uncertainMicro, ['dispatched', 'id-receipt'].includes(crash) ? 100 : 0);
    if (crash === 'id-receipt') {
      assert.deepEqual(spend.evidence('draft-attempt'), { generationId: 'gen-json-crash' });
      spend.reconcileAttempt('draft-attempt', 37); spend.reconcileAttempt('draft-attempt', 37);
      assert.equal(spend.snapshot().totalMicro, 37);
      assert.throws(() => spend.reconcileAttempt('draft-attempt', 38), /already settled/u);
    }
  });
}
