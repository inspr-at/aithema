import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, createVoiceProvider } from '@inspr/aithema-server';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { openRouterConfig } from '../openrouter-config.js';
import { qualifyStartBinding } from '../processing-consent.js';
import { prepareVoiceRuntime } from '../voice-availability.js';
import { demoPresets } from '../choices.js';

const analysis = 'openai/analysis-fixture', speech = 'anthropic/reaction-fixture';
const values = { OPENROUTER_MODEL: analysis, OPENROUTER_SPEECH_MODEL: speech, OPENROUTER_ANALYSIS_EFFORT: 'high',
  AITHEMA_OPENROUTER_PRICES: JSON.stringify(Object.fromEntries([analysis, speech].map(model => [model, { prompt: 1e-7, completion: 1e-7 }]))) };
const voiceBinding = qualifyStartBinding({ plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
  endpoint: 'https://voice.example.test', accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000,
  maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60, minRunwaySeconds: 1,
  upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 60_000, publicFacadeBaseUrl: 'https://facade.example.test' });
function presetsFor(reaction, understanding) {
  return demoPresets({ provider: 'openrouter', reaction, understanding,
    voicePlugin: { manifest: { id: 'elevenlabs' } }, voiceBinding,
    policy: { endpoints: [reaction.endpoint, voiceBinding.endpoint] } });
}

for (const setting of [undefined, '', ' ', '""']) test(`AIT-380: speech setting ${JSON.stringify(setting)} cannot authorize voice`, t => {
  const errors = []; t.mock.method(console, 'error', message => errors.push(message));
  const configured = openRouterConfig({ ...values, OPENROUTER_SPEECH_MODEL: setting });
  const presets = presetsFor(configured.reaction, configured.understanding);
  assert.equal(presets.best.choices.defaults.voice, 'off');
  assert.equal(presets.best.policy.endpoints.includes(voiceBinding.endpoint), false, 'even an explicit visitor selection must refuse voice');
  assert.ok(errors.some(message => /OPENROUTER_SPEECH_MODEL.*required.*voice/iu.test(message)), 'operator receives an actionable configuration error');
  assert.equal(JSON.stringify(presets).includes('OPENROUTER_SPEECH_MODEL'), false, 'technical error stays out of visitor configuration');
  assert.equal(configured.understanding.model, analysis);
});

test('AIT-380: unqualified or thinking reaction bindings refuse voice; explicit qualified route enables it', t => {
  t.mock.method(console, 'error', () => {});
  const configured = openRouterConfig(values);
  for (const reaction of [{ ...configured.reaction, legal: undefined }, { ...configured.reaction, effort: 'high' },
    { ...configured.reaction, model: analysis },
    { ...configured.reaction, legal: { ...configured.reaction.legal, evidence: { ...configured.reaction.legal.evidence, expiresAt: 0 } } }]) {
    const presets = presetsFor(reaction, configured.understanding);
    assert.equal(presets.best.choices.defaults.voice, 'off');
    assert.equal(presets.best.policy.endpoints.includes(voiceBinding.endpoint), false);
  }
  const presets = presetsFor(configured.reaction, configured.understanding);
  assert.equal(presets.best.choices.defaults.voice, 'elevenlabs');
  assert.equal(presets.best.policy.endpoints.includes(voiceBinding.endpoint), true);
  assert.equal(configured.reaction.model, speech);
  assert.equal(configured.reaction.effort, 'none');
  assert.equal(configured.understanding.effort, 'high');
});

test('AIT-380: generic efforts preserve the split reaction ceiling and analysis selection; held analysis never blocks reaction', { timeout: 5000 }, async t => {
  const configured = openRouterConfig(values), storage = new SQLiteStorage(), bodies = [];
  const held = Promise.withResolvers(), started = Promise.withResolvers();
  let pending;
  t.after(async () => { held.resolve(); await pending; storage.close(); });
  const plugin = createOpenRouterReasoning({ binding: configured.reaction, prices: configured.prices, resolveSecret: () => 'offline-fixture',
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body); bodies.push(body);
      if (!body.stream) { started.resolve(); await held.promise;
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Analysis"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }); }
      return new Response('data: {"choices":[{"delta":{"content":"Fast reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n');
    } });
  const presets = presetsFor(configured.reaction, configured.understanding);
  const route = presets.best.choices.models[0]; route.efforts = ['none', 'low', 'high']; route.effort = 'high';
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };
  const runtime = createPluginRuntime({ storage, consent, presets, registry: new PluginRegistry().register(plugin) });
  const session = storage.create({ ownerToken: 'fixture-owner', settings: { model: route.id, effort: 'high' } });
  const request = { system: 'Fixture', messages: [{ role: 'user', content: 'Hello' }], schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } };
  const understanding = await runtime.admit({ session, lane: 'understanding', operation: 'structured', request });
  pending = understanding.plugin.structured(request, understanding.options).finally(() => understanding.finish());
  await started.promise;
  const reaction = await runtime.admit({ session, lane: 'reaction', operation: 'stream', request, options: { voiceReply: true } });
  let reply = '';
  try { for await (const chunk of reaction.plugin.stream(request, reaction.options)) reply += chunk; }
  finally { reaction.finish(); }
  assert.equal(reply, 'Fast reply', 'reaction completes while analysis remains held');
  assert.deepEqual(bodies.map(body => [body.model, body.reasoning]), [[analysis, { effort: 'high' }], [speech, { enabled: false }]]);
  held.resolve(); await pending;
  for (const effort of ['none', 'low']) {
    const current = storage.get(session.id);
    storage.changeSettings(session.id, { processingPreset: 'best', settings: { ...current.settings, effort } },
      { ownerToken: 'fixture-owner', baseRevision: current.settings.revision });
    const selected = storage.get(session.id);
    const admitted = await runtime.admit({ session: selected, lane: 'reaction', operation: 'stream', request });
    assert.equal(admitted.engine.effort, 'none');
    try { for await (const _chunk of admitted.plugin.stream(request, admitted.options)) {} }
    finally { admitted.finish(); }
  }
  // A generic shared model option is also capped when voice is selected.
  route.bindings.understanding = route.bindings.reaction;
  const current = storage.get(session.id);
  storage.changeSettings(session.id, { processingPreset: 'best', settings: { ...current.settings, effort: 'high', voice: 'elevenlabs' } },
    { ownerToken: 'fixture-owner', baseRevision: current.settings.revision });
  const shared = await runtime.admit({ session: storage.get(session.id), lane: 'reaction', operation: 'stream', request });
  assert.equal(shared.engine.effort, 'none');
  try { for await (const _chunk of shared.plugin.stream(request, shared.options)) {} }
  finally { shared.finish(); }

});

test('AIT-380: a saved voice selection cannot start through a missing speech route', async t => {
  t.mock.method(console, 'error', () => {});
  const configured = openRouterConfig({ ...values, OPENROUTER_SPEECH_MODEL: undefined });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const plugin = createVoiceProvider({ storage, staticFacade: true, binding: { agentId: voiceBinding.agentId, secretRef: voiceBinding.secretRef,
    apiBaseUrl: voiceBinding.endpoint, upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 60_000 },
    resolveSecret: () => assert.fail('refusal must precede secret resolution'),
    fetchImpl: () => assert.fail('refusal must precede provider traffic') });
  const reasoning = createOpenRouterReasoning({ binding: configured.reaction, prices: configured.prices,
    resolveSecret: () => assert.fail('refusal must precede reasoning'), fetchImpl: () => assert.fail('no provider traffic') });
  const presets = presetsFor(configured.reaction, configured.understanding);
  const runtime = createPluginRuntime({ storage, presets, registry: new PluginRegistry().register(reasoning).register(plugin) });
  const session = storage.create({ ownerToken: 'fixture-owner', settings: { model: presets.best.choices.defaults.model, voice: 'elevenlabs' } });
  await assert.rejects(runtime.admitVoice({ session, request: { callId: 'refused-call' } }),
    error => error.code === 'not-admitted' && error.message === 'binding evidence unverified');
  // Recovery re-publishes its own endpoint policy. Refusal must travel with the
  // voice choice too, so a saved selection cannot bypass it after self-healing.
  const initialPolicy = { endpoints: [configured.reaction.endpoint] };
  const recovered = prepareVoiceRuntime({ current: { registry: new PluginRegistry().register(reasoning), policy: initialPolicy,
    presets: demoPresets({ provider: 'openrouter', reaction: configured.reaction, understanding: configured.understanding, policy: initialPolicy }) },
    binding: voiceBinding, createPlugin: () => plugin,
    extendPolicy: (before, binding) => ({ ...before, endpoints: [...before.endpoints, binding.endpoint] }),
    createPresets: ({ binding, plugin, policy }) => demoPresets({ provider: 'openrouter', reaction: configured.reaction,
      understanding: configured.understanding, voiceBinding: binding, voicePlugin: plugin, policy }) });
  const recoveredRuntime = createPluginRuntime({ storage, presets: recovered.runtime.presets, registry: recovered.runtime.registry });
  await assert.rejects(recoveredRuntime.admitVoice({ session, request: { callId: 'refused-after-recovery' } }),
    error => error.code === 'not-admitted' && error.message === 'binding evidence unverified');
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0);
});
