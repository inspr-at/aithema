import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processingScope, PluginRegistry, createMockReasoning, inputRevision, reduceUnderstanding,
  verifyHTMLArtifact, bindingReason } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, createHandlers, mockPresets } from '@inspr/aithema-server';
import { createClaudeHTML, buildMessages, callCeilingMicro } from '@inspr/aithema-plugin-claude-html';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { requestCeilingMicro } from '../../plugins/openrouter/src/pricing.js';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';
import { htmlConfig, HTML_CONSENT_UNAVAILABLE } from '../html-config.js';
import { openRouterConfig } from '../openrouter-config.js';
import { createProcessingConsent } from '../processing-consent.js';
import { startChild, temporaryDb, post, ownedRequest, testToken, unzip } from '../../test/helpers.js';

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

test('START HTML lane uses real consent and routing; paid publication, owner reads and exports survive shared-cap exhaustion and breach', { timeout: 10000 }, async t => {
  const reasoningConfig = openRouterConfig(values), configured = htmlConfig(values, [reasoningConfig.understanding]);
  const storage = new SQLiteStorage(), capMicro = 300000;
  const spend = createSpendCap({ storage, account: 'start2-openrouter', capMicro });
  const calls = [], htmlCalls = [];
  let reasoningOverrun = false;
  const fetchImpl = async (endpoint, init) => {
    const body = JSON.parse(init.body), isHTML = !body.response_format;
    assert.equal(endpoint, reasoningConfig.understanding.endpoint);
    assert.deepEqual(body.provider, configured.binding.routing);
    assert.deepEqual(body.provider.max_price, { prompt: 1.4, completion: 14 });
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.stream, false); assert.equal(init.redirect, 'error');
    calls.push(body);
    if (isHTML) htmlCalls.push(body);
    const ceiling = isHTML ? callCeilingMicro(body.messages, configured.binding)
      : requestCeilingMicro(body, configured.prices[model]);
    // Save one free fixture result, then charge the next render its full ceiling.
    const cost = isHTML && htmlCalls.length === 1 ? 0 : (ceiling + (reasoningOverrun ? 1 : 0) - .5) / 1000000;
    const html = `<!doctype html><html lang="de"><head><!-- Revision ${htmlCalls.length}: Reparaturen. -->
      <meta charset="utf-8"><title>Reparaturen</title></head><body><h1>Übersicht</h1><button onclick="this.textContent='Offen'">Reparaturen</button></body></html>`;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: isHTML ? html : '{"summary":"Repairs"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost } });
  };
  const reasoning = createOpenRouterReasoning({ binding: reasoningConfig.understanding, spendCap: spend,
    prices: configured.prices, resolveSecret: () => 'fake', fetchImpl });
  const html = createClaudeHTML({ binding: configured.binding, spend, capMicro, resolveSecret: () => 'fake', fetchImpl });
  const consent = createProcessingConsent({ storage, bindings: [reasoningConfig.understanding, configured.binding] });
  const presets = { best: { plugins: ['openrouter', 'claude-html'], bindings: {
    reaction: reasoningConfig.understanding, understanding: reasoningConfig.understanding, html: configured.binding },
    policy: { endpoints: [reasoningConfig.understanding.endpoint, configured.binding.endpoint] } } };
  const runtime = createPluginRuntime({ storage, reasoning, consent, presets,
    registry: new PluginRegistry().register(reasoning).register(html) });
  const handlers = createHandlers({ storage, reasoning, consent, pluginRuntime: runtime });
  t.after(async () => { await handlers.close(); storage.close(); });
  const { id } = storage.create({ locale: 'de', ownerToken: testToken });
  const read = (route, token = testToken) => handlers.handle(ownedRequest(`http://localhost/api/sessions/${id}/${route}`,
    { headers: { 'x-aithema-session-token': token } }));
  assert.equal(consent.grant({ sessionId: id, consentRevision: 1,
    decision: { contract: consent.describe().contract, items: ['models-international'] } }), true);
  storage.reviseConsent(id, true);
  storage.postTurn(id, 'needs', Buffer.from('requirements'), 'Eine Übersicht für offene Reparaturen.');
  const session = storage.get(id);
  storage.append(id, 'understanding.updated', reduceUnderstanding(session.understanding, { summary: 'Reparaturen', constraints: {},
    openQuestions: ['Wer gibt Reparaturen frei?'], progress: { talk: { value: .75 }, build: { value: 0 } } },
  { transcript: session.transcript, inputRevision: inputRevision(session), preset: session.preset, locale: session.locale }));
  assert.equal(bindingReason({ binding: configured.binding, plugin: html, preset: 'best', policy: presets.best.policy }), null);
  // Exercise the real endpoint policy before a lane dispatch; no claim or wire call escapes.
  presets.best.policy.endpoints = [reasoningConfig.understanding.endpoint];
  assert.equal((await runtime.matrix(storage.get(id))).best.html.reason, 'endpoint not allowed');
  assert.equal(calls.length, 0);
  presets.best.policy.endpoints.push(configured.binding.endpoint);
  assert.equal((await runtime.matrix(storage.get(id))).best.html.available, true);
  handlers.conceptLane.recordIntent(id, { intentId: 'wish', sourceTurnId: 'needs' });
  assert.equal(await handlers.conceptLane.run(id), 'completed');
  const first = storage.get(id).concepts[0];
  assert.equal(htmlCalls[0].max_tokens, configured.binding.maxTokens);
  assert.match(htmlCalls[0].messages[1].content, /Eine Übersicht für offene Reparaturen/);

  async function spendReasoning() {
    const request = { system: '', messages: [{ role: 'user', content: 'Assess the repairs' }],
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } };
    const admitted = await runtime.admit({ session: storage.get(id), lane: 'understanding', operation: 'structured', request,
      options: { deadlineAt: Date.now() + 5000 } });
    try { await admitted.plugin.structured(request, admitted.options); } finally { admitted.finish({ failed: false }); }
  }
  await spendReasoning();
  assert.ok(spend.snapshot().spentMicro > 0); assert.equal(spend.snapshot().breached, false);
  handlers.conceptLane.recordIntent(id, { intentId: 'refine', sourceTurnId: 'needs' });
  assert.equal(await handlers.conceptLane.run(id, { trigger: 'manual' }), 'completed');
  const items = storage.get(id).concepts;
  assert.equal(items.length, 2); assert.equal(items[1].operation, 'edit');
  assert.equal(spend.snapshot().reservedMicro, 0); assert.equal(spend.snapshot().breached, false);
  const minimum = callCeilingMicro(buildMessages({ prompt: 'x' }, '').messages, configured.binding);
  assert.ok(capMicro - spend.snapshot().spentMicro < minimum);
  assert.equal((await html.health({ deadlineAt: Date.now() + 5000 })).reason, 'spend cap reached');

  async function assertReadable() {
    const list = await read('concepts'); assert.equal(list.status, 200); assert.equal((await list.json()).items.length, 2);
    for (const item of items) {
      const response = await read(`concepts/${item.id}/html`); assert.equal(response.status, 200);
      assert.equal(await verifyHTMLArtifact({ bytes: new Uint8Array(await response.arrayBuffer()), mediaType: item.mediaType,
        promptDigest: item.promptDigest, provenance: item.provenance }), true);
      assert.equal((await read(`concepts/${item.id}/html`, 'other-owner')).status, 404);
    }
    const exported = await read('export'); assert.equal(exported.status, 200);
    const files = unzip(new Uint8Array(await exported.arrayBuffer())), manifest = JSON.parse(files['concepts-manifest.json']);
    assert.deepEqual(manifest.included.map(a => a.id), items.map(a => a.id)); assert.deepEqual(manifest.withheld, []);
    for (const item of items) assert.match(files[`concepts/${item.id}.html`], /Übersicht/);
  }
  await assertReadable();
  assert.equal((await runtime.matrix(storage.get(id))).best.html.available, false);
  const beforeRetry = calls.length;
  handlers.conceptLane.recordIntent(id, { intentId: 'denied', sourceTurnId: 'needs' });
  assert.equal(await handlers.conceptLane.run(id, { trigger: 'manual' }), 'failed'); assert.equal(calls.length, beforeRetry);

  // A reasoning overrun latches a breach, even while saved HTML remains private and readable.
  const overrunReasoning = createOpenRouterReasoning({ binding: { ...reasoningConfig.understanding, maxTokens: 1 }, spendCap: spend,
    prices: configured.prices, resolveSecret: () => 'fake', fetchImpl });
  reasoningOverrun = true;
  await overrunReasoning.structured({ messages: [{ role: 'user', content: 'Assess repairs again' }],
    schema: { type: 'object', properties: { summary: { type: 'string' } } } },
  { deadlineAt: Date.now() + 5000, attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {} });
  assert.equal(spend.snapshot().breached, true);
  assert.ok(spend.snapshot().spentMicro < capMicro);
  assert.equal((await html.health({ deadlineAt: Date.now() + 5000 })).reason, 'cost ceiling breached');
  await assertReadable();
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE lane='concept' AND state='settled'").get().n, 2);
  consent.withdraw({ sessionId: id });
  assert.equal((await read(`concepts/${first.id}/html`)).status, 403);
  const files = unzip(new Uint8Array(await (await read('export')).arrayBuffer()));
  assert.deepEqual(JSON.parse(files['concepts-manifest.json']).withheld,
    items.map(item => ({ id: item.id, reason: 'publication-not-allowed' })));
  assert.equal(files[`concepts/${first.id}.html`], undefined);
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
