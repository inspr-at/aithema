import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUsage, createElevenLabsServer } from '../src/server.js';
import { voiceCostConfig } from '../../../demo/voice-cost-config.js';
import { SQLiteStorage, SQLiteBudgetLedger, createVoiceHandlers } from '../../../packages/server/src/index.js';
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
  [{ charging: { platform_charge: 10, call_charge: 12, llm_charge: 3 } }, 2600, 'elevenlabs.charging', false],
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

test('voice price and technical bounds are non-secret host configuration', () => {
  assert.deepEqual(voiceCostConfig({}), { maxDurationSeconds: 3600, reservationSeconds: 30, upstreamMicroPerMinute: 100_000 });
  const configured = voiceCostConfig({ AITHEMA_ELEVENLABS_USD_PER_CREDIT: '0.0002', AITHEMA_VOICE_USD_PER_MINUTE: '0.06',
    AITHEMA_VOICE_MAX_DURATION_SECONDS: '7200', AITHEMA_VOICE_RESERVATION_SECONDS: '15' });
  assert.deepEqual(configured, { maxDurationSeconds: 7200, reservationSeconds: 15, upstreamMicroPerMinute: 60_000, usdPerCredit: 0.0002 });
  for (const value of ['-1', 'NaN', '', '1e-4']) assert.throws(() => voiceCostConfig({ AITHEMA_ELEVENLABS_USD_PER_CREDIT: value }));
  assert.throws(() => voiceCostConfig({ AITHEMA_VOICE_MAX_DURATION_SECONDS: '20', AITHEMA_VOICE_RESERVATION_SECONDS: '30' }));
});
