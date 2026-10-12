import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime } from '@inspr/aithema-server';
import { PluginRegistry, budgetCreditView } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createVoiceHost } from '../start2-voice-host.js';
import { openRouterConfig } from '../openrouter-config.js';
import { createProcessingConsent } from '../processing-consent.js';
import { createDemoHost } from '../host-ports.js';
import { fakeElevenLabs } from '../../test/start2-fakes.js';

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
