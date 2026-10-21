import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createPluginRuntime, createVoiceProvider, mockPresets } from '@inspr/aithema-server';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { perMinuteCostMicro } from '@inspr/aithema-core/cost';
import { createElevenLabsVoiceHost, normalizeElevenLabsDurationBinding } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { createDurationBinding } from '../packages/server/src/voice-binding.js';
import { createComposedVoice } from '../packages/server/src/composed/server.js';
import { createElevenLabsServer, reconcileUsage } from '../plugins/elevenlabs/src/server.js';
import { qualifyStartBinding } from '../demo/processing-consent.js';
import { stubAgentApi } from './fixtures/voice-self-heal-host.js';

const ceiling = (seconds, rate) => Number((BigInt(seconds) * BigInt(rate) + 59n) / 60n);

function settle(seconds, rate, visitorRate) {
  const providerSessionId = 'amounts-conversation';
  return reconcileUsage({ call: { providerSessionId, startedAt: Date.now(), pauses: [] },
    details: { conversation_id: providerSessionId, status: 'done', metadata: { call_duration_secs: seconds } },
    binding: { upstreamMicroPerMinute: rate, visitorMicroPerMinute: visitorRate },
    maxMicro: Math.min(Number.MAX_SAFE_INTEGER, ceiling(seconds, rate)) });
}

async function settleComposed(seconds, visitorRate) {
  let at = Date.now();
  const now = () => at, reports = [];
  const plugin = createComposedVoice({ enabled: true, config: { maxDurationSeconds: seconds },
    binding: { visitorMicroPerMinute: visitorRate }, storage: { saveVoiceCall() {} },
    stt: { stream() {} }, tts: { speak() {} }, replyExecutor: { execute() {} },
    authorize: () => true, commitUtterance() {}, admitComponent() {}, now });
  const call = await plugin.start({ callId: 'amounts-call', sessionId: 'amounts-session' }, {
    now, deadlineAt: at + 1000, spendDeadlineAt: at + seconds * 1000, browserLivenessDeadlineAt: at + seconds * 1000,
    attempt: { attemptId: 'amounts-attempt', claimId: 'amounts-claim', maxMicro: 0, consume() {} },
    report: terminal => reports.push(terminal) });
  at += seconds * 1000;
  const terminal = await call.close();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].closureConfirmed, terminal.closureConfirmed);
  return terminal;
}

async function mintAtMaximum(seconds, rate, visitorRate, maxMicro = ceiling(seconds, rate)) {
  const at = Date.now(), now = () => at;
  let mints = 0, prepared = 0;
  const server = createElevenLabsServer({ binding: { agentId: 'amounts-agent', secretRef: 'fixture-secret-ref',
    upstreamMicroPerMinute: rate, visitorMicroPerMinute: visitorRate }, now,
    resolveSecret: () => 'fixture-secret', prepareCall() { prepared++; }, saveCall() {},
    fetchImpl: async url => {
      if (url.includes('/token?')) {
        mints++;
        return Response.json({ token: 'fixture-token', conversation_id: 'amounts-conversation' });
      }
      return Response.json({ conversation_id: 'amounts-conversation', status: 'done', metadata: { call_duration_secs: seconds } });
    } });
  const options = admittedMax => ({ now, deadlineAt: at + 1000,
    spendDeadlineAt: at + seconds * 1000, browserLivenessDeadlineAt: at + seconds * 1000,
    attempt: { attemptId: 'amounts-attempt', claimId: 'amounts-claim', maxMicro: admittedMax, consume() {} }, report() {} });
  const request = { callId: 'amounts-call', facadeSecretRef: 'fixture-facade-ref' };
  const call = await server.start(request, options(maxMicro));
  try {
    assert.equal(call.snapshot().exposureMicro, maxMicro, 'mint spend bound must equal the admitted maximum');
    assert.equal(mints, 1);
    assert.equal(prepared, 1);
  } finally { await call.close(); }
  if (maxMicro > 0) {
    await assert.rejects(server.start(request, options(maxMicro - 1)), { code: 'not-admitted' });
    assert.equal(mints, 1, 'one microUSD below the spend bound must refuse before minting');
    assert.equal(prepared, 1, 'an insufficient claim must refuse before preparation');
  }
}

test('AIT-451 round 2: 33-second visitor settlement equals the held 55000 microUSD', () => {
  const terminal = settle(33, 100_000, 100_000);
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.visitorMicro, ceiling(33, 100_000));
});

test('AIT-451 round 2: duration-estimate upstream settlement equals the safe integer reservation', () => {
  const rate = Number.MAX_SAFE_INTEGER - 31, terminal = settle(33, rate, 0);
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.costSource, 'duration-estimate');
  assert.equal(terminal.usage.upstreamMicro, ceiling(33, rate));
  assert.equal(terminal.overrun, false);
});

test('AIT-451 round 2: composed visitor settlement equals the held 55000 microUSD', async () => {
  const terminal = await settleComposed(33, 100_000);
  assert.equal(terminal.closureConfirmed, true);
  assert.equal(terminal.usage.visitorMicro, ceiling(33, 100_000));
});

test('AIT-451 round 2: non-rolling mint accepts an exactly funded 33-second spend deadline', async () => {
  await mintAtMaximum(33, 100_000, 100_000);
});

test('AIT-451 round 2: invalid settlement amounts retain uncertainty and mint overflow refuses before provider access', async () => {
  for (const [seconds, rate, visitorRate] of [[61, Number.MAX_SAFE_INTEGER, 0], [61, 0, Number.MAX_SAFE_INTEGER], [33, 0, undefined]]) {
    const terminal = settle(seconds, rate, visitorRate);
    assert.equal(terminal.closureConfirmed, false);
    assert.equal(terminal.outcome, 'uncertain');
    assert.equal(terminal.usage, null);
  }
  for (const visitorRate of [Number.MAX_SAFE_INTEGER, -1, 1.1, Infinity]) {
    const terminal = await settleComposed(61, visitorRate);
    assert.equal(terminal.closureConfirmed, false);
    assert.equal(terminal.outcome, 'uncertain');
    assert.equal(terminal.usage, null);
  }
  await assert.rejects(mintAtMaximum(61, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER), { code: 'not-admitted' });
});

test('AIT-451: integer ceiling preserves fractional runway, safe large products and fail-closed overflow', () => {
  assert.equal(perMinuteCostMicro(33, 100_000), 55_000);
  assert.equal(perMinuteCostMicro(1.001, 60_000), 1001);
  assert.equal(perMinuteCostMicro(1e-7, 60), 1);
  assert.equal(perMinuteCostMicro(60, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(perMinuteCostMicro(59, Number.MAX_SAFE_INTEGER), ceiling(59, Number.MAX_SAFE_INTEGER));
  assert.equal(perMinuteCostMicro(61, Number.MAX_SAFE_INTEGER), null);
  for (const invalid of [-1, NaN, Infinity, '33', undefined]) assert.equal(perMinuteCostMicro(invalid, 100_000), null);
  for (const invalid of [-1, NaN, Infinity, 1.1, '100000', undefined]) assert.equal(perMinuteCostMicro(33, invalid), null);
});

async function bootAndAdmit(seconds, rate, visitorRate) {
  const now = Date.now(), api = stubAgentApi(), storage = new SQLiteStorage();
  let host, factory, validationError;
  try {
    host = await createElevenLabsVoiceHost({ storage, templateAgentId: 'template-agent',
      publicOrigin: 'https://host.example.test', agentName: 'amounts-host', facadeSecretName: 'amounts-facade',
      apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', log() {}, now: () => now,
      costConfig: { maxDurationSeconds: seconds, reservationSeconds: seconds, minRunwaySeconds: 1, upstreamMicroPerMinute: rate },
      qualifyBinding(binding) {
        factory = binding;
        try { createDurationBinding(normalizeElevenLabsDurationBinding(binding)); }
        catch (error) { validationError = error; throw error; }
        return qualifyStartBinding({ ...binding, visitorMicroPerMinute: visitorRate }, now);
      } });
    assert.ifError(validationError);
    assert.equal(host.disabledReason, null, `${seconds}s at ${rate} microUSD/min must boot`);
    assert.equal(factory.maxMicro, ceiling(seconds, rate));
    const validated = createDurationBinding(normalizeElevenLabsDurationBinding(host.binding));
    assert.equal(validated.maxMicro, factory.maxMicro);
    assert.throws(() => createDurationBinding({ ...validated, maxMicro: factory.maxMicro - 1 }), TypeError,
      'one microUSD below the exact reservation must fail validation');
    const plugin = createVoiceProvider({ storage, now: () => now, binding: { agentId: factory.agentId,
      apiBaseUrl: factory.endpoint, secretRef: factory.secretRef, reservationSeconds: seconds,
      upstreamMicroPerMinute: rate, visitorMicroPerMinute: visitorRate },
      resolveSecret: () => 'fixture-secret',
      provisionFacade() { assert.fail('admission must not provision a facade'); },
      revokeFacade() { assert.fail('admission must not revoke a facade'); },
      fetchImpl() { assert.fail('admission must not contact the provider'); } });
    const presets = mockPresets();
    presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = host.binding;
    presets.best.policy = { endpoints: [factory.endpoint] };
    const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope,
      consentRevision, checkedAt: now, expiresAt: now + 60_000 }) };
    const runtime = createPluginRuntime({ storage, presets, consent, now: () => now,
      registry: new PluginRegistry().register(createMockReasoning()).register(plugin) });
    const session = storage.create({ ownerToken: 'fixture-owner' });
    const admitted = await runtime.admitVoice({ session, request: { callId: 'amounts-call' } });
    const row = runtime.budget.get(admitted.options.attempt.attemptId);
    assert.equal(row.max_micro, factory.maxMicro);
    assert.equal(row.voice_exposure_micro, factory.maxMicro);
    assert.equal(row.max_visitor_micro, ceiling(seconds, visitorRate));
    assert.equal(row.voice_visitor_exposure_micro, ceiling(seconds, visitorRate));
    const terminal = settle(seconds, rate, visitorRate);
    assert.equal(terminal.closureConfirmed, true);
    assert.equal(terminal.usage.costSource, 'duration-estimate');
    assert.equal(terminal.usage.upstreamMicro, row.max_micro, 'maximum upstream settlement must equal its reservation');
    assert.equal(terminal.usage.visitorMicro, row.max_visitor_micro, 'maximum visitor settlement must equal its reservation');
    const composed = await settleComposed(seconds, visitorRate);
    assert.equal(composed.closureConfirmed, true);
    assert.equal(composed.usage.visitorMicro, row.max_visitor_micro, 'maximum composed visitor settlement must equal its reservation');
    await mintAtMaximum(seconds, rate, visitorRate, row.max_micro);
    await admitted.options.attempt.consume();
    if (seconds > 1) {
      const extended = admitted.options.attempt.extend(seconds - 0.001);
      assert.equal(extended.maxMicro, factory.maxMicro, 'fractional runway never changes the full credential hold');
      assert.equal(admitted.options.attempt.fundedSeconds, seconds);
    }
    admitted.finish();
  } finally { await host?.close(); storage.close(); }
}

test('AIT-451: 33 seconds at 100000 microUSD/min boots and admits exactly 55000 microUSD', async () => {
  await bootAndAdmit(33, 100_000, 200_000);
});

test('AIT-451: factory, validation and upstream/visitor admission agree across 1–599 seconds and integer rates', async () => {
  const rates = [0, 1, 59, 60, 100_000, 123_457];
  for (let seconds = 1; seconds <= 599; seconds++) {
    const rate = rates[(seconds - 1) % rates.length];
    await bootAndAdmit(seconds, rate, rates[seconds % rates.length]);
  }
  for (const rate of rates) for (const seconds of [33, 60, 600]) await bootAndAdmit(seconds, rate, rate);
});

test('AIT-451: invalid duration costs fail before any provider provisioning', async () => {
  for (const invalid of [{ maxDurationSeconds: 0 }, { maxDurationSeconds: 86_401 },
    { reservationSeconds: 601 }, { reservationSeconds: 0 }, { minRunwaySeconds: 0 },
    { upstreamMicroPerMinute: Number.MAX_SAFE_INTEGER }]) {
    const api = stubAgentApi(), storage = new SQLiteStorage(); let host;
    try {
      host = await createElevenLabsVoiceHost({ storage, templateAgentId: 'template-agent',
        publicOrigin: 'https://host.example.test', agentName: 'invalid-host', facadeSecretName: 'invalid-facade',
        apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', log() {},
        costConfig: { maxDurationSeconds: 600, reservationSeconds: 30, minRunwaySeconds: 1,
          upstreamMicroPerMinute: 100_000, ...invalid },
        qualifyBinding: binding => createDurationBinding(normalizeElevenLabsDurationBinding(binding)) });
      assert.equal(host.binding, undefined);
      assert.equal(host.disabledReason, 'voice-host-unavailable');
      assert.deepEqual(api.requests, [], 'invalid duration costs must be rejected before provider access');
    } finally { await host?.close(); storage.close(); }
  }
});
