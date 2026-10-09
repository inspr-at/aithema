import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processingScope, PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, mockPresets } from '@inspr/aithema-server';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';
import { htmlConfig, HTML_CONSENT_UNAVAILABLE } from '../html-config.js';
import { openRouterConfig } from '../openrouter-config.js';
import { createProcessingConsent } from '../processing-consent.js';
import { startChild, temporaryDb, post } from '../../test/helpers.js';

const model = 'anthropic/claude-opus-5.5';
const values = { AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: model, OPENROUTER_PROVIDER_ONLY: ' "Anthropic, Google" ',
  AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [model]: { prompt: 1.4e-6, completion: 1.4e-5 } }) };

test('HTML defaults to a local fake; live mode validates Claude model and operator prices', () => {
  assert.deepEqual(htmlConfig({}), { mode: 'fake' }); assert.deepEqual(htmlConfig({ AITHEMA_HTML_MODE: 'off' }), { mode: 'off' });
  assert.throws(() => htmlConfig({ AITHEMA_HTML_MODE: 'unknown' }), TypeError);
  assert.throws(() => htmlConfig({ AITHEMA_HTML_MODE: 'claude' }), /PRICES/);
  assert.throws(() => htmlConfig({ ...values, AITHEMA_HTML_MODEL: 'openai/fixture' }), /anthropic/);
  assert.throws(() => htmlConfig({ ...values, AITHEMA_OPENROUTER_PRICES: '{}' }), /PRICES/);
  const config = htmlConfig(values); assert.equal(config.binding.model, model); assert.equal(config.binding.maxTokens, 8000);
  assert.deepEqual(config.binding.routing.max_price, { prompt: 1.4, completion: 14 });
  assert.deepEqual(config.binding.routing.only, ['Anthropic', 'Google']); assert.deepEqual(config.binding.routing.ignore, ['Azure']);
  assert.equal(config.binding.routing.require_parameters, true);
});

test('identical Anthropic/OpenRouter routing reuses the START reasoning item for generate/edit; changed scopes require coverage', () => {
  const storage = new SQLiteStorage();
  try {
    const reasoning = openRouterConfig(values), configured = htmlConfig(values, [reasoning.reaction, reasoning.understanding]);
    assert.equal(configured.disabledReason, null); assert.equal(configured.binding.legal.purpose, 'models-international');
    const consent = createProcessingConsent({ storage, bindings: [reasoning.reaction, reasoning.understanding, configured.binding] });
    const session = storage.create();
    const check = operation => consent.coverage({ sessionId: session.id, consentRevision: 1, scope: processingScope(configured.binding, operation) });
    assert.equal(check('generate').covered, false);
    assert.equal(consent.grant({ sessionId: session.id, consentRevision: 1, decision: { contract: consent.describe().contract, items: ['models-international'] } }), true);
    storage.reviseConsent(session.id, true);
    for (const operation of ['generate', 'edit']) assert.equal(check(operation).covered, true);
    const changed = processingScope({ ...configured.binding, routing: { ...configured.binding.routing, only: ['Different'] } }, 'generate');
    assert.equal(consent.coverage({ sessionId: session.id, consentRevision: 1, scope: changed }).covered, false);
    consent.withdraw({ sessionId: session.id }); assert.equal(check('edit').covered, false);
  } finally { storage.close(); }
});

test('different processor/account/route leaves HTML unavailable; START has no matching separate HTML item', async () => {
  const reasoning = openRouterConfig(values);
  for (const changes of [{ model: 'openai/fixture' }, { accountRef: 'other' }, { secretRef: 'other' },
    { endpoint: 'https://other.test/api/v1' }, { routing: { ...reasoning.understanding.routing, only: ['Other'] } }]) {
    const configured = htmlConfig(values, [{ ...reasoning.understanding, ...changes }]);
    assert.equal(configured.disabledReason, HTML_CONSENT_UNAVAILABLE); assert.equal(configured.binding.legal, undefined);
  }
  const storage = new SQLiteStorage();
  try {
    const configured = htmlConfig(values), plugin = createClaudeHTML({ binding: configured.binding,
      spend: createSpendCap({ storage, account: 'start2-openrouter', capMicro: configured.capMicro }), capMicro: configured.capMicro,
      resolveSecret: () => 'fake', fetchImpl: () => assert.fail('no outbound request') });
    const mock = createMockReasoning(), presets = mockPresets(); presets.best.plugins.push('claude-html'); presets.best.bindings.html = configured.binding;
    const runtime = createPluginRuntime({ storage, reasoning: mock, presets, registry: new PluginRegistry().register(mock).register(plugin) });
    assert.equal((await runtime.matrix(storage.create())).best.html.reason, HTML_CONSENT_UNAVAILABLE);
  } finally { storage.close(); }
});

test('demo defaults generate valid local HTML alongside typed conversation without any provider configuration', { timeout: 15000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb()); t.after(() => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json()); assert.equal(config.htmlMode, 'fake'); assert.match(config.htmlLabel, /no provider network/);
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const path = action => `${running.url}/api/sessions/${session.id}${action ? '/' + action : ''}`;
  await post(path('consent'), { granted: true }, headers);
  await post(path('turns'), { clientEventId: 'needs', content: 'operations: hosted; data: public; systems: API; reach: international' }, headers);
  let current;
  for (let i = 0; i < 200; i++) {
    current = await fetch(path(''), { headers }).then(r => r.json()); if (current.understanding.readinessAssessed) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal((await post(path('concepts'), { clientEventId: 'wish', intent: true, sourceTurnId: 'needs' }, headers)).status, 202);
  for (let i = 0; i < 200; i++) {
    current = await fetch(path(''), { headers }).then(r => r.json()); if (current.concepts.length) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(current.conceptVisualKind, 'html'); assert.equal(current.concepts[0].mediaType, 'text/html');
  const data = await fetch(path(`concepts/${current.concepts[0].id}/html`), { headers }); assert.equal(data.headers.get('content-type'), 'application/octet-stream');
  assert.match(await data.text(), /<!doctype html>/);
});
