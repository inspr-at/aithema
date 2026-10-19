import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, createHandlers } from '../src/index.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { manifest as elevenManifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { manifest as grokManifest } from '../../../plugins/grok-voice/src/manifest.js';
import { manifest as composedManifest } from '../src/composed/manifest.js';

function fixture(t, manifest, change = () => {}, legacy = false) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let clock = Date.now();
  const qualify = raw => ({ ...raw, legal: { approved: true, countries: ['AT'], training: false,
    retention: 'fixture', purpose: 'conversation', recipient: 'fixture', processors: [],
    dataCategories: ['conversation'], consentVersion: 1, evidence: { qualified: true,
      accountRef: raw.accountRef, secretRef: raw.secretRef, model: raw.model, endpoint: raw.endpoint,
      routing: raw.routing ?? {}, verifiedAt: clock - 1000, expiresAt: clock + 600_000 } } });
  const base = { plugin: 'openrouter', model: 'openai/fast-fixture', effort: 'none', endpoint: 'https://reasoning.example.test',
    accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000, maxTokens: 4096,
    rates: { inputMicro: 1, outputMicro: 1 } };
  const reaction = qualify(base), understanding = qualify({ ...base, model: 'openai/analysis-fixture', effort: 'high' });
  reaction.legal.evidence.expiresAt = clock + 60_000;
  const model = { id: 'host-model', bindings: { reaction, understanding }, efforts: ['none', 'high'], effort: 'high' };
  const voice = qualify({ ...base, plugin: manifest.id, model: manifest.id === 'composed-voice' ? 'composed' : manifest.id === 'grok-voice' ? 'grok-voice' : 'fixture-agent',
    endpoint: 'https://voice.example.test', rates: { inputMicro: 0, outputMicro: 0 }, maxTokens: 1,
    maxDurationSeconds: 60, minRunwaySeconds: 1, upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 60_000 });
  const config = { plugins: ['openrouter', manifest.id], policy: { endpoints: [base.endpoint, voice.endpoint] },
    ...(legacy ? { bindings: { reaction, understanding, voice } } : { choices: { models: [model],
      voices: [{ id: manifest.id, binding: voice }], defaults: { model: model.id, voice: manifest.id } } }) };
  const never = () => assert.fail('route validation must not contact a provider');
  const reasoning = createOpenRouterReasoning({ binding: reaction, prices: {
    [reaction.model]: { prompt: 1e-6, completion: 1e-6 }, [understanding.model]: { prompt: 1e-6, completion: 1e-6 } },
    resolveSecret: () => 'offline-fixture', fetchImpl: never });
  const plugin = { manifest: { ...manifest, kinds: ['live-voice'], models: manifest.models.filter(m => m.operations.includes('start')) },
    bind(binding) { return { ...this, binding }; }, health: async () => ({ available: true }), start: never };
  const registry = new PluginRegistry().register(reasoning).register(plugin);
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope,
    consentRevision, checkedAt: clock, expiresAt: clock + 60_000 }) };
  const errors = []; t.mock.method(console, 'error', message => errors.push(message));
  change(model, config);
  const runtime = createPluginRuntime({ storage, registry, consent, presets: { best: config }, now: () => clock });
  const owner = 'fast-route-owner', session = storage.create({ ownerToken: owner,
    settings: { model: legacy ? 'default' : model.id, effort: 'high', voice: legacy ? 'default' : manifest.id } });
  return { storage, runtime, session, owner, errors, model, config, reaction, understanding, registry,
    advance: ms => { clock += ms; } };
}
const failures = {
  missing(model) { delete model.bindings.reaction; },
  shared(model) { model.bindings.reaction = model.bindings.understanding; },
  'cloned-analysis'(model) { model.bindings.reaction = { ...model.bindings.understanding, effort: 'none' }; },
  thinking(model) { model.bindings.reaction = { ...model.bindings.reaction, effort: 'high' }; },
  unqualified(model) { model.bindings.reaction = { ...model.bindings.reaction, legal: undefined }; },
  expired(model) { model.bindings.reaction.legal.evidence.expiresAt = 0; },
  'not-allowlisted'(_model, config) { config.plugins = config.plugins.filter(id => id !== 'openrouter'); },
};
for (const manifest of [elevenManifest, grokManifest, composedManifest]) {
  for (const [name, change] of Object.entries(failures)) {
    test(`AIT-397: ${manifest.id} custom host reports ${name} fast reaction binding at startup`, t => {
      const h = fixture(t, manifest, change);
      assert.ok(h.errors.some(message => /Voice configuration error:.*best.*reaction.*host-model.*effort none.*voice start refused/u.test(message)),
        'operator error must name the preset and missing qualified reaction binding');
    });
    test(`AIT-397: ${manifest.id} saved choice refuses ${name} fast reaction binding at admission`, async t => {
      const h = fixture(t, manifest, change);
      await assert.rejects(h.runtime.admitVoice({ session: h.session, request: { callId: 'saved-choice' } }),
        error => error.code === 'not-admitted' && /fast reaction binding/u.test(error.message));
      assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0);
    });
  }
  test(`AIT-397: ${manifest.id} correctly configured custom host retains fast reaction and analysis efforts`, async t => {
    const h = fixture(t, manifest);
    assert.deepEqual(h.errors, []);
    assert.equal((await h.runtime.checkVoice(h.session)).binding.plugin, manifest.id);
    const admitted = await h.runtime.admitVoice({ session: h.session, request: { callId: 'valid-call' } });
    admitted.finish();
    const request = { system: '', messages: [{ role: 'user', content: 'Hello' }] };
    for (const [lane, operation, effort] of [['reaction', 'stream', 'none'], ['understanding', 'structured', 'high']]) {
      const entry = await h.runtime.admit({ session: h.session, lane, operation, request, options: { voiceReply: lane === 'reaction' } });
      assert.equal(entry.engine.effort, effort); entry.finish({ failed: true });
    }
  });
  test(`AIT-397: ${manifest.id} registration changes, recovery and expiry cannot bypass the backstop`, async t => {
    const h = fixture(t, manifest);
    assert.deepEqual(h.errors, []);
    for (const change of [() => { h.model.bindings.reaction = h.understanding; },
      () => { h.model.bindings.reaction = h.reaction; h.advance(60_001); }]) {
      change();
      await assert.rejects(h.runtime.checkVoice(h.session, { existingCall: true, textReplay: true }), /fast reaction binding/u);
      await assert.rejects(h.runtime.admitVoice({ session: h.session, request: { callId: 'recovery' }, options: { voiceContinuation: true } }), /fast reaction binding/u);
    }
  });
  test(`AIT-397: ${manifest.id} invalid custom host returns only the neutral visitor failure`, async t => {
    const h = fixture(t, manifest, failures.missing);
    const handlers = createHandlers({ storage: h.storage, pluginRuntime: h.runtime, voice: {} });
    t.after(() => handlers.close());
    const response = await handlers.handle(new Request(`https://host.example.test/api/sessions/${h.session.id}/voice`, {
      method: 'POST', headers: { 'x-aithema-session-token': h.owner }, body: JSON.stringify({ callId: 'refused' }) }));
    assert.equal((await h.runtime.matrix(h.session)).best.voice.reason, 'binding evidence unverified');
    assert.equal((await h.runtime.catalog(h.session)).presets.best.voices[0].reason, 'binding evidence unverified');
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'not-admitted' });
    assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0);
  });
}
test('AIT-397: legacy host bindings require the same fast route', async t => {
  const h = fixture(t, elevenManifest, (_model, config) => { config.bindings.reaction = config.bindings.understanding; }, true);
  assert.ok(h.errors.some(message => /Voice configuration error:.*reaction/u.test(message)));
  await assert.rejects(h.runtime.checkVoice(h.session), /fast reaction binding/u);
});
