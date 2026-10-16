import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, createMockReasoning, processingScope, verifyHTMLArtifact } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, createSpendCap, localHTMLBinding, localImageBinding, imagePluginBinding } from '@inspr/aithema-server';
import { manifest as htmlManifest, buildMessages, callCeilingMicro, htmlArtifact } from '@inspr/aithema-plugin-claude-html';
import { manifest as imageManifest } from '@inspr/aithema-plugin-openai-images';
import { previousDocument } from '@inspr/aithema-plugin-claude-html/html-artifact';
import { imageArtifact } from '@inspr/aithema-plugin-openai-images/image-artifact';
import { htmlPlugin, imagePlugin } from '../visual-plugins.js';
import { htmlConfig } from '../html-config.js';
import { demoPresets, providerMode } from '../choices.js';
import { createProcessingConsent } from '../processing-consent.js';

const options = () => ({ deadlineAt: Date.now() + 5000,
  attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
const spec = { prompt: 'A repair dashboard', language: 'en', understanding: { summary: 'Repairs' } };

test('AIT-211: host keeps local defaults, manifests, zero cost and artifact provenance for generate/edit', async () => {
  const html = htmlPlugin(htmlConfig({})), images = imagePlugin(providerMode(undefined, false));
  assert.equal(html.binding, localHTMLBinding); assert.equal(images.binding, localImageBinding);
  for (const [configured, original, model] of [[html, htmlManifest, 'deterministic-html'], [images, imageManifest, 'deterministic-ui']]) {
    assert.deepEqual(configured.plugin.manifest, { ...original, id: configured.binding.plugin,
      vendor: { name: 'Local deterministic fake', url: 'https://example.test' }, models: [{ ...original.models[0], id: model }] });
  }
  const reasoning = createMockReasoning();
  const presets = demoPresets({ htmlPlugin: html.plugin, htmlBinding: html.binding, imagePlugin: images.plugin, imageBinding: images.binding });
  assert.equal(presets.best.choices.defaults.visuals, 'fake-html');
  const storage = new SQLiteStorage();
  const runtime = createPluginRuntime({ storage, reasoning, presets,
    registry: new PluginRegistry().register(reasoning).register(html.plugin).register(images.plugin),
    consent: { coverage: ({ scope, consentRevision }) => ({ ...scope, consentRevision, covered: true, expiresAt: Date.now() + 5000 }) } });
  try {
    const session = storage.create();
    const matrix = await runtime.matrix(session);
    assert.equal(matrix.best.html.available, true);
    assert.equal(html.plugin.estimateCost(spec), 0);
    for (const [configured, request, makeArtifact] of [[html, spec, htmlArtifact], [images, { prompt: 'Repairs' }, imageArtifact]]) {
      const first = await configured.plugin.generate(request, '', options());
      const second = await configured.plugin.edit(first, request, 'Make it clearer', options());
      for (const [artifact, operation] of [[first, 'generate'], [second, 'edit']]) {
        const rebuilt = makeArtifact(artifact.mediaType === 'text/html'
          ? previousDocument(artifact) : artifact.bytes, { prompt: 'comparison', model: configured.binding.model,
          provider: 'local-demo-fake', operation, now: Date.parse(artifact.provenance.generatedAt) });
        assert.deepEqual(rebuilt.bytes, artifact.bytes);
        assert.deepEqual(rebuilt.provenance, { ...artifact.provenance,
          ...(configured === images ? { promptDigest: rebuilt.promptDigest } : {}) });
        assert.equal(artifact.provenance.generator.provider, 'local-demo-fake');
      }
      if (configured === html) assert.equal(await verifyHTMLArtifact(second), true);
    }
  } finally { storage.close(); }
});

test('AIT-211: host preserves live/off modes, Claude exact prices and separate generate/edit consent', async () => {
  assert.deepEqual(htmlPlugin(htmlConfig({}, { live: true })), { plugin: null, binding: undefined });
  assert.deepEqual(imagePlugin(providerMode(undefined, true)), { plugin: null, binding: undefined });
  assert.deepEqual(imagePlugin(providerMode('fake', true)), { plugin: null, binding: undefined });
  const config = htmlConfig({ AITHEMA_HTML_MODE: 'claude',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'anthropic/claude-opus-5.5': { prompt: 1.4e-6, completion: 1.4e-5 } }) });
  const storage = new SQLiteStorage();
  try {
    const spend = createSpendCap({ storage, account: config.binding.accountRef, capMicro: config.capMicro });
    const html = htmlPlugin(config, { spend, resolveSecret: () => 'fixture', fetchImpl: () => assert.fail('wiring must not dispatch') });
    assert.equal(html.plugin.spend, spend); assert.equal(html.plugin.capMicro, config.capMicro);
    assert.equal(html.binding, config.binding); assert.deepEqual(html.plugin.binding, config.binding);
    const previous = htmlArtifact('<!doctype html><html><head><title>Repairs</title></head><body>Repairs</body></html>',
      { prompt: 'first', model: config.binding.model, operation: 'generate', now: 0 });
    for (const previousArtifact of [undefined, previous]) {
      const request = { ...spec, feedback: 'Larger controls', ...(previousArtifact ? { previousArtifact } : {}) };
      const messages = buildMessages(spec, request.feedback, previousArtifact ? previousDocument(previousArtifact) : undefined).messages;
      assert.equal(html.plugin.estimateCost(request), callCeilingMicro(messages, config.binding));
    }
    const consent = createProcessingConsent({ storage, bindings: [html.binding] });
    assert.deepEqual(consent.describe().items.map(item => item.id), ['drafts-anthropic']);
    const session = storage.create();
    assert.equal(consent.grant({ sessionId: session.id, consentRevision: 1,
      decision: { contract: consent.describe().contract, items: ['drafts-anthropic'] } }), true);
    storage.reviseConsent(session.id, true);
    for (const operation of ['generate', 'edit']) assert.equal(consent.coverage({ sessionId: session.id,
      consentRevision: 1, scope: processingScope(html.binding, operation) }).covered, true);
    const binding = { ...localImageBinding, plugin: 'openai-images', model: 'gpt-image-2', endpoint: 'https://api.openai.com/v1',
      maxMicro: 100000, imageCost: { inputMicro: 2, outputMicro: 30, maxInputTokens: 1000, maxOutputTokens: 2000 } };
    const images = imagePlugin('openai', { binding }, { resolveSecret: () => 'fixture' });
    assert.equal(images.binding, binding); assert.deepEqual(images.plugin.binding, imagePluginBinding(binding));
    const presets = demoPresets({ provider: 'openrouter', reaction: config.binding, htmlPlugin: html.plugin,
      htmlBinding: html.binding, imagePlugin: images.plugin, imageBinding: images.binding });
    assert.equal(presets.best.choices.defaults.visuals, 'claude-html');
    assert.deepEqual(presets.best.choices.visuals.map(option => option.id), ['claude-html', 'openai-images']);
    assert.deepEqual(presets.best.choices.visuals[1].binding.imageCost, binding.imageCost);
  } finally { storage.close(); }
});
