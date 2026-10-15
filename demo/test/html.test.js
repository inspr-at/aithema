import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processingScope, PluginRegistry, createMockReasoning, inputRevision, reduceUnderstanding,
  verifyHTMLArtifact, bindingReason } from '@inspr/aithema-core';
import { SQLiteStorage, createPluginRuntime, createHandlers, mockPresets } from '@inspr/aithema-server';
import { createClaudeHTML, buildMessages, callCeilingMicro } from '@inspr/aithema-plugin-claude-html';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { requestCeilingMicro } from '../../plugins/openrouter/src/pricing.js';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';
import { htmlConfig } from '../html-config.js';
import { openRouterConfig } from '../openrouter-config.js';
import { createProcessingConsent } from '../processing-consent.js';
import { demoPresets } from '../choices.js';
import { startChild, temporaryDb, post, ownedRequest, testToken, unzip } from '../../test/helpers.js';

const model = 'anthropic/claude-opus-5.5';
const values = { AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: model, OPENROUTER_PROVIDER_ONLY: ' "Anthropic, Google" ',
  AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [model]: { prompt: 1.4e-6, completion: 1.4e-5 } }) };

test('HTML defaults to a local fake; live mode validates Claude model and operator prices', () => {
  assert.deepEqual(htmlConfig({}), { mode: 'fake' }); assert.deepEqual(htmlConfig({ AITHEMA_HTML_MODE: 'off' }), { mode: 'off' });
  assert.deepEqual(htmlConfig({}, { live: true }), { mode: 'off' });
  assert.deepEqual(htmlConfig({ AITHEMA_HTML_MODE: 'fake' }, { live: true }), { mode: 'fake', demo: true });
  assert.throws(() => htmlConfig({ AITHEMA_HTML_MODE: 'unknown' }), TypeError);
  assert.throws(() => htmlConfig({ AITHEMA_HTML_MODE: 'claude' }), /PRICES/);
  assert.throws(() => htmlConfig({ ...values, AITHEMA_HTML_MODEL: 'openai/fixture' }), /anthropic/);
  assert.throws(() => htmlConfig({ ...values, AITHEMA_OPENROUTER_PRICES: '{}' }), /PRICES/);
  const config = htmlConfig(values); assert.equal(config.binding.model, model); assert.equal(config.binding.maxTokens, 8000);
  assert.deepEqual(config.binding.routing.max_price, { prompt: 1.4, completion: 14 });
  assert.deepEqual(config.binding.routing.only, ['Anthropic', 'Google']); assert.deepEqual(config.binding.routing.ignore, ['Azure']);
  assert.equal(config.binding.routing.require_parameters, true);
});

test('drafts have a separate optional item, exact binding coverage and independent withdrawal', async () => {
  const storage = new SQLiteStorage();
  try {
    const reasoning = openRouterConfig(values), configured = htmlConfig(values);
    const bindings = [reasoning.reaction, reasoning.understanding];
    const original = createProcessingConsent({ storage, bindings }), session = storage.create();
    const previousContract = original.describe().contract;
    assert.deepEqual(original.describe().items.map(item => item.id), ['models-international']);
    assert.equal(original.grant({ sessionId: session.id, consentRevision: 1,
      decision: { contract: previousContract, items: ['models-international'] } }), true);
    storage.reviseConsent(session.id, true);
    const consent = createProcessingConsent({ storage, bindings: [...bindings, configured.binding] });
    assert.notEqual(consent.describe().contract, previousContract);
    assert.deepEqual(consent.describe(session.id).selected, [], 'contract changes invalidate existing grants');
    const covered = (b, operation, revision = storage.get(session.id).consentRevision) => consent.coverage({
      sessionId: session.id, consentRevision: revision, scope: processingScope(b, operation) }).covered;
    assert.equal(covered(reasoning.reaction, 'stream'), false);
    assert.equal(consent.grant({ sessionId: session.id, consentRevision: 2,
      decision: { contract: previousContract, items: ['models-international'] } }), false);
    assert.deepEqual(consent.describe().optional, ['drafts-anthropic']);
    const grant = items => {
      const revision = storage.get(session.id).consentRevision + 1;
      assert.equal(consent.grant({ sessionId: session.id, consentRevision: revision,
        decision: { contract: consent.describe().contract, items } }), true);
      storage.reviseConsent(session.id, true);
    };
    grant(['models-international']);
    assert.equal(covered(reasoning.reaction, 'stream'), true, 'drafts never block conversation');
    assert.equal(covered(configured.binding, 'generate'), false, 'reasoning does not authorize drafts');
    grant(['models-international', 'drafts-anthropic']);
    for (const operation of ['generate', 'edit']) assert.equal(covered(configured.binding, operation), true);
    for (const change of [{ model: 'anthropic/claude-other' }, { accountRef: 'other' }, { endpoint: 'https://other.test' },
      { routing: { ...configured.binding.routing, only: ['Different'] } },
      { legal: { ...configured.binding.legal, processors: ['Other'] } }]) {
      assert.equal(covered({ ...configured.binding, ...change }, 'generate'), false);
    }
    grant(['models-international']);
    assert.equal(covered(reasoning.reaction, 'stream'), true);
    assert.equal(covered(configured.binding, 'generate'), false, 'deselecting only drafts withdraws them');
    consent.withdraw({ sessionId: session.id }); assert.equal(covered(configured.binding, 'edit'), false);
  } finally { storage.close(); }
});

test('HTML qualification has its own processor/model/endpoint/routing evidence and rejects the old reasoning purpose', () => {
  const configured = htmlConfig(values), b = configured.binding;
  assert.equal(configured.disabledReason, null); assert.equal(b.legal.purpose, 'drafts-anthropic');
  assert.deepEqual(b.legal.processors, ['Anthropic PBC']); assert.equal(b.legal.evidence.processor, 'Anthropic PBC');
  for (const field of ['model', 'endpoint', 'routing', 'accountRef', 'secretRef']) assert.deepEqual(b.legal.evidence[field], b[field]);
  const storage = new SQLiteStorage();
  try {
    const old = { ...b, legal: { ...b.legal, purpose: 'models-international' } };
    const consent = createProcessingConsent({ storage, bindings: [openRouterConfig(values).understanding, old] });
    assert.deepEqual(consent.describe().items.map(item => item.id), ['models-international']);
    const session = storage.create();
    consent.grant({ sessionId: session.id, consentRevision: 1,
      decision: { contract: consent.describe().contract, items: ['models-international'] } });
    storage.reviseConsent(session.id, true);
    assert.equal(consent.coverage({ sessionId: session.id, consentRevision: 1, scope: processingScope(old, 'generate') }).covered, false);
  } finally { storage.close(); }
});

test('HTML accepts the exact Claude latest alias and requires prices under that alias', async () => {
  const alias = '~anthropic/claude-opus-latest';
  const aliasValues = { ...values, OPENROUTER_MODEL: alias,
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [alias]: { prompt: 1.4e-6, completion: 1.4e-5 } }) };
  const configured = htmlConfig(aliasValues);
  const spendPath = `${await temporaryDb()}.spend.json`;
  assert.equal(configured.binding.model, alias); assert.equal(configured.binding.legal.evidence.model, alias);
  assert.doesNotThrow(() => createClaudeHTML({ binding: configured.binding,
    spendPath, resolveSecret: () => null }));
  for (const invalid of ['~openai/gpt-latest', '~anthropic/claude-opus', '~~anthropic/claude-opus-latest', '~anthropic/path/claude-latest']) {
    assert.throws(() => htmlConfig({ ...aliasValues, AITHEMA_HTML_MODEL: invalid }), /anthropic/);
    assert.throws(() => createClaudeHTML({ binding: { ...configured.binding, model: invalid } }), /anthropic/);
  }
  assert.throws(() => htmlConfig({ ...aliasValues, AITHEMA_OPENROUTER_PRICES: values.AITHEMA_OPENROUTER_PRICES }), /for ~anthropic/);
});

test('start2 drafts run at milestones in the background; conversation and selective withdrawal stay independent', { timeout: 10_000 }, async t => {
  const analysis = '~anthropic/claude-opus-latest', speech = '~anthropic/claude-haiku-latest';
  const configuredValues = { AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: analysis,
    OPENROUTER_SPEECH_MODEL: speech, OPENROUTER_PROVIDER_ONLY: 'Anthropic',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [analysis]: { prompt: 5e-6, completion: 25e-6 },
      [speech]: { prompt: 1e-6, completion: 5e-6 } }) };
  const configured = htmlConfig(configuredValues), reasoningConfig = openRouterConfig(configuredValues);
  const storage = new SQLiteStorage(), spend = createSpendCap({ storage, account: 'start2-openrouter', capMicro: 10_000_000 });
  const started = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  t.after(() => released.resolve());
  const fetchImpl = async (endpoint, init) => {
    assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Please continue."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n');
    if (body.response_format) {
      const current = body.messages.filter(m => m.role === 'user' && !m.content.startsWith('{')).at(-1).content;
      const raw = { summary: 'Repair requests', signals: [], openQuestions: [], actor: null, engagement: null,
        constraints: Object.fromEntries(['operations', 'data', 'systems', 'reach', 'requirements'].map(key => [key, { value: 'Repair requests', evidence: current }])),
        progress: { talk: { value: current.includes('Further') ? .75 : .65, reasoning: '' },
          build: { value: current.includes('Further') ? .3 : 0, reasoning: '' } },
        conceptIntent: current.includes('clickable draft') ? { request_quote: current } : null };
      return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] });
    }
    calls.push(body); started.resolve();
    if (calls.length === 1) await released.promise;
    return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: .001234 },
      choices: [{ finish_reason: 'stop', message: { content: `<!doctype html><html lang="en"><head><!-- Revision ${calls.length}: Repairs. --><meta charset="utf-8"><title>Repairs</title></head><body><button onclick="this.textContent='Open'">Repairs</button></body></html>` } }] });
  };
  const reasoning = createOpenRouterReasoning({ binding: reasoningConfig.reaction, prices: reasoningConfig.prices,
    spendCap: spend, resolveSecret: () => 'fixture', fetchImpl });
  const html = createClaudeHTML({ binding: configured.binding, spend, resolveSecret: () => 'fixture', fetchImpl });
  const consent = createProcessingConsent({ storage, bindings: [reasoningConfig.reaction, reasoningConfig.understanding, configured.binding] });
  const presets = demoPresets({ provider: 'openrouter', reaction: reasoningConfig.reaction, understanding: reasoningConfig.understanding,
    htmlPlugin: html, htmlBinding: configured.binding, policy: { endpoints: [reasoningConfig.reaction.endpoint, configured.binding.endpoint] } });
  const runtime = createPluginRuntime({ storage, reasoning, consent, presets, registry: new PluginRegistry().register(reasoning).register(html) });
  const handlers = createHandlers({ storage, reasoning, consent, pluginRuntime: runtime });
  t.after(async () => { released.resolve(); await handlers.close(); storage.close(); });
  const session = await (await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{}' }))).json();
  const call = (action, body) => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/${action}`,
    { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }));
  const grant = async items => assert.equal((await call('consent', { granted: true,
    processing: { contract: consent.describe().contract, items } })).status, 200);
  const turn = async (id, content) => assert.equal((await call('turns', { clientEventId: id, content })).status, 200);
  const reasoningFinished = async () => {
    for (let i = 0; i < 1000; i++) {
      const current = storage.get(session.id), revision = inputRevision(current);
      if (current.understanding.inputRevision === revision && current.transcript.some(turn => turn.role === 'assistant' && turn.inputRevision === revision)) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Conversation did not finish while the draft was pending');
  };
  await grant(['models-international']);
  await turn('ordinary', 'We need repair requests for our housing cooperative.'); await handlers.idle();
  assert.equal(calls.length, 0); assert.equal((await runtime.matrix(storage.get(session.id))).best.text.available, true);
  assert.equal((await runtime.matrix(storage.get(session.id))).best.html.available, false);
  assert.equal((await runtime.matrix(storage.get(session.id))).best.analysis.available, true, 'V1: models-international authorizes analysis without drafts consent');
  assert.equal(storage.get(session.id).understanding.readinessAssessed, true, 'V1: an in-scope turn produces an overview with only models consent');
  const document = await (await call('consent')).json();
  assert.deepEqual(document.features.analysis, ['models-international']);
  assert.deepEqual(document.features.html, ['drafts-anthropic']);
  const settings = await (await call('settings', { processingPreset: 'best', baseRevision: storage.get(session.id).settings.revision })).json();
  assert.equal(settings.consent.required, false, 'optional drafts never redirect conversation setup to consent');
  assert.deepEqual(settings.consent.features, ['html']);
  await grant(['models-international', 'drafts-anthropic']); await handlers.idle();
  await turn('wish', 'Please show a clickable draft for repair requests.'); await started.promise; await reasoningFinished();
  assert.equal(storage.get(session.id).conceptStatus.phase, 'pending');
  assert.equal(runtime.budget.used(session.id), spend.snapshot().reservedMicro, 'only the active draft holds its priced request estimate');
  assert.ok(runtime.budget.used(session.id) < 1_000_000);
  await turn('during', 'Further details: the caretaker needs a repair list.'); await reasoningFinished();
  const current = storage.get(session.id);
  assert.ok(current.transcript.some(turn => turn.role === 'assistant' && turn.inputRevision === inputRevision(current)), 'conversation answers while HTML remains stalled');
  released.resolve(); await handlers.idle();
  assert.equal(storage.get(session.id).concepts.length, 1);
  await turn('milestone', 'Further details: repairs must show their priority.'); await handlers.idle();
  const drafts = storage.get(session.id).concepts;
  assert.equal(drafts.length, 2); assert.equal(drafts[1].operation, 'edit');
  assert.deepEqual(calls.map(body => body.model), [analysis, analysis]);
  assert.match(calls[1].messages[1].content, /previous_dummy/);
  assert.equal(runtime.budget.used(session.id), 2468); assert.equal(spend.snapshot().reservedMicro, 0);
  assert.equal(spend.snapshot().spentMicro, 2468);
  await grant(['models-international']); await handlers.idle();
  assert.equal((await runtime.matrix(storage.get(session.id))).best.html.available, false);
  assert.equal((await call(`concepts/${drafts[0].id}/html`)).status, 403);
  await turn('after', 'Further details: retain the existing layout.'); await handlers.idle();
  assert.equal(calls.length, 2); assert.equal((await runtime.matrix(storage.get(session.id))).best.text.available, true);
});

test('withdrawing only drafts aborts a dispatched render before it finishes and ignores its late result', { timeout: 5000 }, async t => {
  const { binding } = htmlConfig(values), storage = new SQLiteStorage();
  const spend = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  let draftSignal, calls = 0;
  const html = createClaudeHTML({ binding, spend, resolveSecret: () => 'fixture', fetchImpl: async (_endpoint, init) => {
    calls++; draftSignal = init.signal; started.resolve(); await released.promise;
    return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: .001234 },
      choices: [{ finish_reason: 'stop', message: { content: '<!doctype html><html lang="en"><head><!-- Revision 1: Repairs. --><meta charset="utf-8"><title>Repairs</title></head><body>Repairs</body></html>' } }] });
  } });
  const reasoning = createMockReasoning(), presets = mockPresets();
  presets.best.plugins.push('claude-html'); presets.best.bindings.html = binding;
  presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = createProcessingConsent({ storage, bindings: [openRouterConfig(values).reaction, binding] });
  const runtime = createPluginRuntime({ storage, reasoning, consent, presets,
    registry: new PluginRegistry().register(reasoning).register(html) });
  const handlers = createHandlers({ storage, reasoning, consent, pluginRuntime: runtime });
  t.after(async () => { released.resolve(); await handlers.close(); storage.close(); });
  const { id } = storage.create({ ownerToken: testToken });
  const grant = async items => assert.equal((await handlers.handle(ownedRequest(`http://localhost/api/sessions/${id}/consent`, {
    method: 'POST', body: JSON.stringify({ granted: true, processing: { contract: consent.describe().contract, items } }) }))).status, 200);
  await grant(['models-international', 'drafts-anthropic']); await handlers.idle();
  storage.postTurn(id, 'needs', Buffer.from('Repairs'), 'Repairs');
  const session = storage.get(id);
  storage.append(id, 'understanding.updated', reduceUnderstanding(session.understanding, { summary: 'Repairs', constraints: {},
    openQuestions: [], progress: { talk: { value: .75 }, build: { value: 0 } } },
  { transcript: session.transcript, inputRevision: inputRevision(session), preset: session.preset, locale: session.locale }));
  handlers.conceptLane.recordIntent(id, { intentId: 'wish', sourceTurnId: 'needs' });
  const pending = handlers.conceptLane.run(id); await started.promise;
  assert.equal(draftSignal.aborted, false); assert.equal(storage.get(id).conceptStatus.phase, 'pending');
  await grant(['models-international']);
  assert.equal(storage.get(id).consentWithdrawn, false, 'conversation grant stays selected');
  assert.equal(draftSignal.aborted, true, 'the admitted draft scope was withdrawn while generation was pending');
  assert.equal(await pending, 'failed'); await handlers.idle();
  assert.equal(storage.get(id).concepts.length, 0); assert.equal(spend.snapshot().reservedMicro, 0);
  const used = runtime.budget.used(id), spent = spend.snapshot().spentMicro;
  assert.equal(used, spent + spend.snapshot().uncertainMicro, 'cancellation retains the same uncertain estimate in both ledgers');
  released.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.get(id).concepts.length, 0, 'a transport ignoring abort cannot publish its late result');
  assert.equal(runtime.budget.used(id), 1234); assert.equal(spend.snapshot().spentMicro, 1234, 'late provider cost replaces the uncertain estimate');
  assert.equal(spend.snapshot().uncertainMicro, 0);
  assert.equal(calls, 1);
});

test('START HTML lane uses real consent and routing; paid publication, owner reads and exports survive shared-cap exhaustion and breach', { timeout: 10000 }, async t => {
  const reasoningConfig = openRouterConfig(values), configured = htmlConfig(values);
  const storage = new SQLiteStorage(), capMicro = 300000;
  const spend = createSpendCap({ storage, account: 'start2-openrouter', capMicro });
  const calls = [], htmlCalls = [];
  let reasoningOverrun = false;
  const fetchImpl = async (endpoint, init) => {
    const body = JSON.parse(init.body), isHTML = !body.response_format;
    assert.equal(endpoint, reasoningConfig.understanding.endpoint);
    assert.deepEqual(body.provider, isHTML ? configured.binding.routing : reasoningConfig.understanding.routing);
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
    decision: { contract: consent.describe().contract, items: ['models-international', 'drafts-anthropic'] } }), true);
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
