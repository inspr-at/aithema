import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createPluginRuntime } from '@inspr/aithema-server';
import { PluginRegistry, MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';
import { createLocalVoiceProvider, localVoiceBinding, isLocalVoice } from '@inspr/aithema-server/dev/local-voice';
import { createElevenLabsVoiceHost, normalizeElevenLabsDurationBinding } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { stubAgentApi } from './fixtures/voice-self-heal-host.js';

test('external voice host injects naming, costs, openers and its own qualification', async t => {
  const api = stubAgentApi(), storage = new SQLiteStorage();
  t.after(() => storage.close());
  const openers = { de: 'Hallo, hier ist die KI-Assistenz von START.', en: "Hello, this is START's AI assistant." };
  let qualified;
  const host = await createElevenLabsVoiceHost({ storage, templateAgentId: 'template-agent',
    publicOrigin: 'https://host.example.test', agentName: 'start-host', facadeSecretName: 'start-facade',
    apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', log() {},
    spokenOpeners: openers, costConfig: { maxDurationSeconds: 600, reservationSeconds: 15,
      minRunwaySeconds: 60, upstreamMicroPerMinute: 200_000 },
    qualifyBinding: binding => { qualified = binding; return { ...binding, qualification: 'host-owned' }; } });
  t.after(() => host.close());
  assert.equal(host.disabledReason, null);
  assert.equal(api.agents[0].name, 'start-host');
  assert.equal(api.secrets[0].name, 'start-facade');
  assert.equal(api.agents[0].conversation_config.conversation.max_duration_seconds, 600);
  assert.equal(host.binding.qualification, 'host-owned');
  assert.equal(qualified.accountRef, 'start-host');
  assert.equal(qualified.maxMicro, 50_000);
  assert.equal(host.presentation('de').agent.firstMessage, openers.de);
  assert.equal(host.presentation('en').agent.firstMessage, openers.en);
  assert.equal(normalizeElevenLabsDurationBinding(host.binding).adapterConfig.agentId, 'owned-agent');
  assert.ok(api.requests.filter(r => r.path.endsWith('/template-agent')).every(r => r.method === 'GET'));
});

const hostArguments = { agentName: 'external-host', facadeSecretName: 'external-facade',
  costConfig: {}, qualifyBinding: binding => binding };
for (const [name, invalid] of Object.entries({ agentName: ['', 'invalid name', 42, null],
  facadeSecretName: ['', 'invalid name', 42, null], costConfig: [null, [], 'costs', 42],
  qualifyBinding: [null, {}, 'qualify'] })) {
  test(`voice host requires and validates ${name} before touching any provider`, async () => {
    const options = { ...hostArguments, fetchImpl: () => assert.fail('must not contact provider') };
    delete options[name];
    for (const value of [undefined, ...invalid]) {
      await assert.rejects(createElevenLabsVoiceHost({ ...options, [name]: value }),
        error => error instanceof TypeError && error.message.includes(name));
    }
  });
}

test('ensureAgent rejects omitted host names without touching Aithema agents', async () => {
  const { ensureAgent } = await import('../plugins/elevenlabs/src/ensure-agent.js');
  for (const name of ['agentName', 'facadeSecretName']) {
    const options = { ...hostArguments, fetchImpl: () => assert.fail('must not contact provider') };
    delete options[name];
    await assert.rejects(ensureAgent(options), error => error.message.includes(name));
  }
});

test('start2 undefined options preserve host defaults', async t => {
  const { createVoiceHost, START2_VOICE_OPENERS } = await import('../demo/start2-voice-host.js');
  const api = stubAgentApi(), storage = new SQLiteStorage();
  t.after(() => storage.close());
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://host.example.test',
    apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', values: {}, log() {},
    agentName: undefined, facadeSecretName: undefined, costConfig: undefined, qualifyBinding: undefined,
    spokenOpeners: undefined, accountRef: undefined });
  t.after(() => host.close());
  assert.equal(host.disabledReason, null);
  assert.equal(api.agents[0].name, 'aithema-start2');
  assert.equal(api.secrets[0].name, 'aithema-start2-facade');
  assert.equal(host.binding.accountRef, 'start2-elevenlabs');
  assert.equal(host.binding.maxDurationSeconds, 3600);
  for (const locale of ['de', 'en']) assert.equal(host.presentation(locale).agent.firstMessage, START2_VOICE_OPENERS[locale]);
});

test('local voice production requires an explicit boolean simulator opt-in', async t => {
  const { createLocalVoiceProvider, isLocalVoice } = await import('@inspr/aithema-server/dev/local-voice');
  const previous = process.env.NODE_ENV;
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  process.env.NODE_ENV = 'production';
  for (const allowProductionSimulator of [undefined, false, 'true', 1]) {
    assert.throws(() => createLocalVoiceProvider({ storage, allowProductionSimulator }), /production requires allowProductionSimulator: true/u);
  }
  assert.ok(isLocalVoice(createLocalVoiceProvider({ storage, allowProductionSimulator: true })));
  process.env.NODE_ENV = 'development';
  assert.ok(isLocalVoice(createLocalVoiceProvider({ storage })));
});

for (const variant of ['copied-start', 'copied-adapter', 'cloned-adapter', 'other-simulator-adapter', 'genuine']) {
  test(`AIT-218: ${variant} simulator identity survives registry copying only for the genuine pair`, async t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    let session = storage.create({ ownerToken: 'fixture-owner' });
    storage.append(session.id, 'turn.final', { id: 'reply', role: 'assistant', content: 'Private reply' });
    session = storage.get(session.id);
    const sim = createLocalVoiceProvider({ storage, allowProductionSimulator: true });
    let dispatched = 0;
    const real = Object.freeze({ ...sim.ports.serverAdapter,
      async speakText() { dispatched++; throw new Error('Real processing must require real consent'); } });
    const plugin = variant === 'genuine' ? sim : { ...sim,
      start: variant === 'copied-adapter' ? async () => {} : sim.start,
      ports: { serverAdapter: variant === 'copied-start' ? real
        : variant === 'cloned-adapter' ? Object.freeze({ ...sim.ports.serverAdapter })
        : variant === 'other-simulator-adapter' ? createLocalVoiceProvider({ storage }).ports.serverAdapter
        : sim.ports.serverAdapter } };
    const registry = new PluginRegistry().register(plugin), entry = registry.get(sim.manifest.id);
    assert.notEqual(entry, plugin, 'registry copies the plugin');
    const now = Date.now(), binding = { ...localVoiceBinding, legal: { approved: true, countries: ['AT'],
      training: false, retention: 'fixture', purpose: 'conversation', recipient: 'real-provider', processors: [],
      dataCategories: ['conversation'], consentVersion: 1, evidence: { qualified: true,
        accountRef: localVoiceBinding.accountRef, secretRef: localVoiceBinding.secretRef,
        model: localVoiceBinding.model, endpoint: localVoiceBinding.endpoint, routing: {},
        verifiedAt: now - 1000, expiresAt: now + 100_000 } } };
    const scopes = [], consent = { coverage({ scope, consentRevision }) {
      scopes.push(scope);
      return { covered: scope === MOCK_PROCESSING_SCOPE, ...scope, scope, consentRevision,
        checkedAt: Date.now(), expiresAt: Date.now() + 100_000 };
    } };
    const runtime = createPluginRuntime({ storage, registry, consent,
      presets: { best: { plugins: [sim.manifest.id], bindings: { voice: binding },
        policy: { endpoints: [binding.endpoint] } } } });
    const offered = runtime.scopes(session, { feature: 'voice' });
    if (variant === 'genuine') {
      assert.equal(isLocalVoice(entry), true);
      assert.deepEqual(offered, [MOCK_PROCESSING_SCOPE]);
      assert.equal((await runtime.matrix(session)).best.voice.available, true);
      assert.equal((await runtime.speakText({ session, turnId: 'reply' })).kind, 'audio');
    } else {
      // Check consent discovery first: the original attack offered mock consent.
      assert.ok(offered.length > 0);
      assert.ok(offered.every(scope => scope.purpose !== MOCK_PROCESSING_SCOPE.purpose), 'impostor gets no mock scope');
      assert.equal(isLocalVoice(entry), false);
      assert.equal((await runtime.matrix(session)).best.voice.reason, 'current processing consent required');
      await assert.rejects(runtime.speakText({ session, turnId: 'reply' }), /current processing consent required/u);
      assert.ok(scopes.length > 0);
      assert.ok(scopes.every(scope => scope.purpose !== MOCK_PROCESSING_SCOPE.purpose));
    }
    assert.equal(dispatched, 0);
  });
}
