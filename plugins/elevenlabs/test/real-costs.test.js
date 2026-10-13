import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUsage, createElevenLabsServer } from '../src/server.js';
import { voiceCostConfig } from '../../../demo/voice-cost-config.js';
import { SQLiteStorage, SQLiteBudgetLedger, createVoiceHandlers, createVoiceProvider, createPluginRuntime, mockPresets } from '../../../packages/server/src/index.js';
import { PluginRegistry, createMockReasoning, budgetCreditView } from '@inspr/aithema-core';
import { qualifyStartBinding } from '../../../demo/processing-consent.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { temporaryDb } from '../../../test/helpers.js';

const binding = { agentId: 'agent', secretRef: 'fixture-ref', apiBaseUrl: 'https://fixture.test',
  upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000, usdPerCredit: 0.0002 };
const call = { providerSessionId: 'conversation', startedAt: 1000, pauses: [] };
const details = metadata => ({ conversation_id: 'conversation', status: 'done',
  metadata: { call_duration_secs: 120, start_time_unix_secs: 1, ...metadata } });

for (const [metadata, cost, source, estimated] of [
  [{ cost_fiat: 0.0042, cost: 99999 }, 4200, 'elevenlabs.cost_fiat', false],
  [{ cost: 42, charging: { call_charge: 900 } }, 8400, 'elevenlabs.cost', false],
  [{ charging: { call_charge: 12, llm_charge: 3, analysis: { total: { charge: 2 } } } }, 3400, 'elevenlabs.charging', false],
  [{ charging: { platform_charge: 10, call_charge: 12, llm_charge: 3, analysis: { total: { charge: 0 } } } }, 2600, 'elevenlabs.charging', false],
  [{ charging: { platform_charge: 0, llm_charge: 0, analysis: { total: { charge: 0 } } } }, 0, 'elevenlabs.charging', false],
  [{ cost: 0 }, 0, 'elevenlabs.cost', false],
  [{ cost_fiat: 0 }, 0, 'elevenlabs.cost_fiat', false],
  [{}, 200_000, 'duration-estimate', true],
  [{ cost: -1, charging: { call_charge: 'bad' } }, 200_000, 'duration-estimate', true],
]) test(`ElevenLabs uses ${source} with actual microUSD ${cost}`, () => {
  const terminal = reconcileUsage({ call, details: details(metadata), binding, maxMicro: 50_000 });
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.upstreamMicro, cost);
  assert.equal(terminal.usage.costSource, source);
  assert.equal(terminal.usage.costEstimated, estimated);
});

test('provider credit totals without a configured USD conversion remain labelled estimates', () => {
  const { usdPerCredit, ...unpriced } = binding;
  const terminal = reconcileUsage({ call, details: details({ cost: 42 }), binding: unpriced, maxMicro: 50_000 });
  assert.equal(terminal.usage.costEstimated, true); assert.equal(terminal.usage.providerCredits, 42);
  assert.equal(terminal.usage.upstreamMicro, 200_000);
});

test('voice estimates and actual credit charges survive a restart without duplicate settlement', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path), ledger = new SQLiteBudgetLedger(storage);
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const session = storage.create();
  const admission = ledger.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(admission.attemptId); claim.consume();
  const estimate = { attemptId: admission.attemptId, ...reconcileUsage({ call, details: details({}), binding, maxMicro: 50_000 }) };
  ledger.settleVoice(claim.claimId, estimate); ledger.settleVoice(claim.claimId, estimate);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 200_000);
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 0);
  ledger.reconcileVoice(admission.attemptId, estimate);
  storage.close(); storage = new SQLiteStorage(path); ledger = new SQLiteBudgetLedger(storage);
  const actual = { attemptId: admission.attemptId, ...reconcileUsage({ call, details: details({ cost: 42 }), binding, maxMicro: 50_000 }) };
  ledger.reconcileVoice(admission.attemptId, actual); ledger.reconcileVoice(admission.attemptId, actual);
  assert.equal(ledger.used(session.id), 8400);
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 8400);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 0);
  assert.throws(() => ledger.reconcileVoice(admission.attemptId, { ...actual, usage: { ...actual.usage, upstreamMicro: 8401 } }), { code: 'already-claimed' });
});

test('a refused rolling money extension closes voice before its generous technical ceiling', { timeout: 1000 }, async () => {
  const closed = Promise.withResolvers(); let extensions = 0;
  const plugin = createElevenLabsServer({ binding: { ...binding, reservationSeconds: 1 },
    resolveSecret: () => 'fixture', prepareCall: () => {}, saveCall: () => {},
    closureTimeoutMs: 50, fetchImpl: async url => url.endsWith('/token?agent_id=agent')
      ? Response.json({ token: 'fixture-token', conversation_id: 'conversation' }) : Response.json(details({ cost: 1 })) });
  const session = await plugin.start({ callId: 'call', facadeSecretRef: 'fixture-facade-ref' }, {
    deadlineAt: Date.now() + 500, spendDeadlineAt: Date.now() + 3600_000, browserLivenessDeadlineAt: Date.now() + 10_000,
    attempt: { attemptId: 'attempt', claimId: 'claim', maxMicro: 1667, consume() {},
      extend() { extensions++; throw new Error('money exhausted'); } }, report: terminal => closed.resolve(terminal) });
  const terminal = await closed.promise;
  assert.equal(extensions, 1); assert.equal(session.snapshot().reason, 'budget-limit');
  assert.equal(terminal.usage.upstreamMicro, 200); assert.equal(terminal.closureConfirmed, true);
});

test('a crash after journalling actual voice cost replays that receipt before any provider lookup', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path), ledger = new SQLiteBudgetLedger(storage);
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const session = storage.create({ ownerToken: 'owner' });
  const admission = ledger.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(admission.attemptId); claim.consume();
  const terminal = reconcileUsage({ call, details: details({ cost: 42 }), binding, maxMicro: 50_000 });
  storage.saveVoiceCall(session.id, { ...call, callId: 'receipt-call', attemptId: admission.attemptId,
    claimId: claim.claimId, facadeSecretRef: 'fixture-facade', maxMicro: 50_000, terminal });
  storage.close(); storage = new SQLiteStorage(path); ledger = new SQLiteBudgetLedger(storage); ledger.recover();
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 50_000);
  const handlers = createVoiceHandlers({ storage, runtime: { budget: ledger, reconcileVoice: (id, receipt) => ledger.reconcileVoice(id, receipt) },
    secrets: { provision() {}, resolve() {}, revoke() {} }, staticSecretRef: 'fixture-facade', publish() {},
    closeOrphan() { assert.fail('A saved actual receipt needs no provider lookup'); } });
  await handlers.resume(); await handlers.resume(); await handlers.close();
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 8400);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 0);
});
test('AIT-145: background confirmation accepts a lookup slower than one second and corrects the wallet to USD 1.52', { timeout: 10_000 }, async t => {
  const storage = new SQLiteStorage(), ledger = new SQLiteBudgetLedger(storage);
  const session = storage.create({ ownerToken: 'owner' });
  const { attemptId } = ledger.admit({ sessionId: session.id, lane: 'voice', maxMicro: 6_000_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(attemptId); claim.consume();
  const uncertain = { attemptId, providerSessionId: call.providerSessionId, outcome: 'uncertain', closureConfirmed: false,
    chargedMicro: 6_000_000, usage: null };
  ledger.settleVoice(claim.claimId, uncertain);
  storage.saveVoiceCall(session.id, { ...call, callId: 'slow-details', attemptId, claimId: claim.claimId,
    facadeSecretRef: 'fixture', maxMicro: 6_000_000, terminal: uncertain, reconciliationPending: true });
  const handlers = createVoiceHandlers({ storage, runtime: { budget: ledger, reconcileVoice: (id, receipt) => ledger.reconcileVoice(id, receipt) },
    secrets: { provision() {}, resolve() {}, revoke() {} }, staticSecretRef: 'fixture', publish() {},
    async closeOrphan(record, { signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1100);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return reconcileUsage({ call: record, binding, maxMicro: record.maxMicro,
        details: { ...details({ cost_fiat: 1.52, cost: 5750 }), metadata: { call_duration_secs: 784, cost_fiat: 1.52, cost: 5750 } } });
    } });
  t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.resume();
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 1_520_000);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 0);
  assert.equal(storage.voiceCalls()[0].reconciliationPending, false);
});

test('voice price and technical bounds are non-secret host configuration', () => {
  assert.deepEqual(voiceCostConfig({}), { maxDurationSeconds: 3600, reservationSeconds: 30, minRunwaySeconds: 120, upstreamMicroPerMinute: 100_000 });
  const configured = voiceCostConfig({ AITHEMA_ELEVENLABS_USD_PER_CREDIT: '0.0002', AITHEMA_VOICE_USD_PER_MINUTE: '0.06',
    AITHEMA_VOICE_MAX_DURATION_SECONDS: '7200', AITHEMA_VOICE_RESERVATION_SECONDS: '15' });
  assert.deepEqual(configured, { maxDurationSeconds: 7200, reservationSeconds: 15, minRunwaySeconds: 120, upstreamMicroPerMinute: 60_000, usdPerCredit: 0.0002 });
  for (const value of ['-1', 'NaN', '', '1e-4']) assert.throws(() => voiceCostConfig({ AITHEMA_ELEVENLABS_USD_PER_CREDIT: value }));
  assert.throws(() => voiceCostConfig({ AITHEMA_VOICE_MAX_DURATION_SECONDS: '20', AITHEMA_VOICE_RESERVATION_SECONDS: '30' }));
});

async function exposureFixture(t, { path, state = { final: false }, closeHook } = {}) {
  const storage = new SQLiteStorage(path); t.after(() => { if (storage.db.isOpen) storage.close(); });
  const configured = qualifyStartBinding({ plugin: 'elevenlabs', model: 'agent', effort: 'none',
    endpoint: binding.apiBaseUrl, accountRef: 'voice-fixture', secretRef: binding.secretRef,
    agentId: 'agent', maxMicro: 50_000, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 },
    maxDurationSeconds: 3600, reservationSeconds: 30, usdPerCredit: binding.usdPerCredit,
    upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000, publicFacadeBaseUrl: 'https://fixture.test' });
  const queried = Promise.withResolvers();
  const plugin = createVoiceProvider({ storage, binding: { ...binding, reservationSeconds: 30 }, staticFacade: true,
    resolveSecret: () => 'fixture', requestProviderClose: closeHook, closureTimeoutMs: 20,
    fetchImpl: async url => {
      if (url.includes('/token?')) return Response.json({ token: 'fixture', conversation_id: 'conversation' });
      queried.resolve();
      return Response.json(state.final ? details({ cost: 42 }) : { ...details({}), status: 'in-progress' });
    } });
  const presets = mockPresets(); presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = configured;
  presets.best.policy = { endpoints: [binding.apiBaseUrl] };
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, scope, ...scope, consentRevision,
    checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };
  const budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: 1_000_000 });
  const runtime = createPluginRuntime({ storage, budget, consent, presets,
    registry: new PluginRegistry().register(createMockReasoning()).register(plugin) });
  const host = createDemoHost({ storage });
  // AIT-135 replaces constructor allowances with the audited settings store.
  const creditSettings = host.visitorCredits.settings();
  if (creditSettings.allowancesMicro.anonymous !== 1_000_000) host.visitorCredits.saveSettings({
    baseRevision: creditSettings.revision, allowancesUsd: { anonymous: '1', emailGiven: '1', emailConfirmed: '1' },
  }, { actor: 'system:fixture', source: 'fixture' });
  runtime.setOwnerWallet(session => host.walletForSession(session));
  const session = storage.list().length ? storage.get(storage.list()[0]) : storage.create({ ownerToken: 'voice-owner', demo: true });
  const admit = () => runtime.admitVoice({ session: storage.get(session.id), request: { callId: 'exposure-call' },
    options: { deadlineAt: Date.now() + 1000, spendDeadlineAt: Date.now() + 3600_000, browserLivenessDeadlineAt: Date.now() + 30_000 } });
  const start = async () => {
    const admission = await admit();
    const live = await admission.plugin.start({ callId: 'exposure-call', sessionId: session.id,
      ownerToken: 'voice-owner', facadeSecretRef: 'fixture-facade' }, admission.options);
    return { admission, live };
  };
  const balance = () => budgetCreditView(budget, session.id, host.wallet('voice-owner'));
  return { storage, runtime, session, admit, start, balance, queried, state };
}

for (const hook of ['absent', 'failed']) test(`AIT-134 gate: ${hook} hangup holds ceiling exposure before closure and blocks admission`, async t => {
  const h = await exposureFixture(t, { closeHook: hook === 'failed' ? () => { throw new Error('hangup failed'); } : undefined });
  const { live, admission } = await h.start(); t.after(() => live.close());
  assert.equal(h.balance().owner.reservedMicro, 200_000, 'healthy live calls fund the default 120-second runway');
  const pending = live.close('transport-lost', 'cancelled'); await h.queried.promise;
  const during = h.balance();
  const terminal = await pending;
  assert.equal(during.owner.uncertainSpendMicro, 6_000_000, 'closing must account for billing through the provider ceiling immediately');
  assert.equal(terminal.closureConfirmed, false); assert.equal(terminal.chargedMicro, 6_000_000);
  assert.equal(h.balance().session.uncertainSpendMicro, 6_000_000);
  assert.equal(h.balance().voiceVisitor.uncertainSpendMicro, 6_000_000);
  assert.equal(h.balance().owner.availableMicro, 0);
  await assert.rejects(h.admit(), { code: 'not-admitted' });
  h.runtime.reconcileVoice(admission.options.attempt.attemptId,
    reconcileUsage({ call: live.snapshot(), details: details({ cost: 42 }), binding, maxMicro: 6_000_000 }));
  assert.equal(h.balance().owner.confirmedSpendMicro, 8400); assert.equal(h.balance().owner.uncertainSpendMicro, 0);
});

test('AIT-134 gate: a crashed live voice restores ceiling exposure before any retry or admission', async t => {
  const path = await temporaryDb(); let h = await exposureFixture(t, { path });
  const admitted = await h.admit(); await admitted.options.attempt.consume();
  h.storage.saveVoiceCall(h.session.id, { ...call, callId: 'crashed-call',
    attemptId: admitted.options.attempt.attemptId, claimId: admitted.options.attempt.claimId,
    maxMicro: 50_000, facadeSecretRef: 'fixture-facade', spendDeadlineAt: Date.now() + 3600_000 });
  h.storage.close(); h = await exposureFixture(t, { path }); h.runtime.budget.recover();
  assert.equal(h.balance().owner.uncertainSpendMicro, 6_000_000);
  assert.equal(h.balance().voiceVisitor.uncertainSpendMicro, 6_000_000);
  await assert.rejects(h.admit(), { code: 'not-admitted' });
  h.runtime.budget.recover(); assert.equal(h.balance().owner.uncertainSpendMicro, 6_000_000);
});

for (const charging of [
  { llm_charge: 0 }, { call_charge: 0 }, { platform_charge: 0, llm_charge: 0 },
  { call_charge: 12, llm_charge: 3, analysis: { total: {} } },
  { call_charge: 12, analysis: { total: { charge: 0 } } },
]) test(`AIT-134 gate: incomplete charging stays estimated and retryable ${JSON.stringify(charging)}`, async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const ledger = new SQLiteBudgetLedger(storage), session = storage.create();
  const { attemptId } = ledger.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(attemptId); let scheduled = 0;
  const plugin = createElevenLabsServer({ binding, resolveSecret: () => 'fixture', prepareCall() {}, saveCall() {},
    reconcileLater() { scheduled++; }, fetchImpl: async url => url.includes('/token?')
      ? Response.json({ token: 'fixture', conversation_id: 'conversation' }) : Response.json(details({ charging })) });
  const live = await plugin.start({ callId: 'partial-cost', facadeSecretRef: 'fixture' }, {
    deadlineAt: Date.now() + 1000, spendDeadlineAt: Date.now() + 30_000, browserLivenessDeadlineAt: Date.now() + 30_000,
    attempt: { ...claim, maxMicro: 50_000 }, report: terminal => ledger.settleVoice(claim.claimId, terminal) });
  const terminal = await live.close();
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.costEstimated, true); assert.equal(terminal.usage.costSource, 'duration-estimate');
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 0);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 200_000); assert.equal(scheduled, 1);
});
