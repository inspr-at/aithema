import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createPluginRuntime, createVoiceProvider, mockPresets } from '@inspr/aithema-server';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { createElevenLabsVoiceHost, normalizeElevenLabsDurationBinding } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { createDurationBinding } from '../packages/server/src/voice-binding.js';
import { qualifyStartBinding } from '../demo/processing-consent.js';
import { stubAgentApi } from './fixtures/voice-self-heal-host.js';

const ceiling = (seconds, rate) => Number((BigInt(seconds) * BigInt(rate) + 59n) / 60n);

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
