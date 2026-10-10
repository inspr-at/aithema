import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, createSpendCap, createVoiceCap } from '../src/index.js';
import { PluginRegistry } from '@inspr/aithema-core';
import { listen } from '../src/http.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { createVoiceHost } from '../../../demo/start2-voice-host.js';
import { createProcessingConsent, qualifyStartBinding, CONSENT_VALIDITY_MS } from '../../../demo/processing-consent.js';
import { fakeElevenLabs } from '../../../test/start2-fakes.js';
import { openRouterConfig } from '../../../demo/openrouter-config.js';
import { temporaryDb } from '../../../test/helpers.js';

async function fixture(t, { locale = 'en', capMilliseconds, closureTimeoutMs, reconcileIntervalMs } = {}) {
  let cleanup; t.after(() => cleanup?.());
  const storage = new SQLiteStorage(), eleven = await fakeElevenLabs(t), logs = [], upstream = [];
  let processing = false;
  const reconciled = Promise.withResolvers();
  const providerFetch = (input, options) => new URL(input).pathname.startsWith('/v1/convai/conversations/') && processing
    ? Promise.resolve(Response.json({ conversation_id: new URL(input).pathname.split('/').at(-1), status: 'processing' })) : fetch(input, options);
  const openrouter = await listen(async req => {
    const body = await req.json(); upstream.push(body);
    if (!body.stream) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Local understanding"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.00001 } });
    return new Response('data: {"choices":[{"delta":{"content":"Local reasoning"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"cost":0.00001}}\n\ndata: [DONE]\n\n');
  });
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://start2.example.test', apiBaseUrl: eleven.endpoint,
    resolveSecret: () => 'local-fixture-key', log: value => logs.push(value), fetchImpl: providerFetch });
  assert.ok(host.binding);
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/understanding-fixture', OPENROUTER_SPEECH_MODEL: 'anthropic/speech-fixture',
    OPENROUTER_PROVIDER_ONLY: 'Anthropic,OpenAI',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'openai/understanding-fixture': { prompt: 1e-7, completion: 1e-7 },
      'anthropic/speech-fixture': { prompt: 1e-7, completion: 1e-7 } }) });
  const rebind = binding => qualifyStartBinding({ ...binding, endpoint: openrouter.url + '/' });
  const reaction = rebind(configured.reaction), understanding = rebind(configured.understanding);
  const reasoning = createOpenRouterReasoning({ binding: reaction, prices: configured.prices, resolveSecret: () => 'local-fixture-key',
    spendCap: createSpendCap({ storage, account: reaction.accountRef, capMicro: 2_000_000 }) });
  const consent = createProcessingConsent({ storage, bindings: [host.binding, reaction, understanding] });
  const voice = createVoiceProvider({ storage, staticFacade: true, binding: { agentId: host.binding.agentId, secretRef: host.binding.secretRef,
    apiBaseUrl: eleven.endpoint, upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000 }, resolveSecret: () => 'local-fixture-key',
    fetchImpl: providerFetch, closureTimeoutMs, reconcileLater: () => handlers.reconcileVoiceLater() });
  const secrets = createFacadeSecrets(); secrets.resolve = ref => ref === host.staticSecretRef ? 'local-callback-fixture' : null;
  const voiceCap = capMilliseconds === undefined ? undefined : createVoiceCap({ storage, capMilliseconds });
  const runtime = createPluginRuntime({ storage, consent, voiceCap, registry: new PluginRegistry().register(reasoning).register(voice),
    presets: { best: { plugins: ['elevenlabs', 'openrouter'], bindings: { voice: host.binding, reaction, understanding }, policy: { endpoints: [eleven.endpoint, reaction.endpoint] } } } });
  const reconcile = runtime.reconcileVoice;
  runtime.reconcileVoice = (...args) => { const result = reconcile(...args); reconciled.resolve(); return result; };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent,
    voice: { secrets, staticSecretRef: host.staticSecretRef, presentation: host.presentation, closeOrphan: host.closeOrphan, reconcileIntervalMs } });
  cleanup = async () => { await handlers.close(); storage.close(); openrouter.server.closeAllConnections(); await new Promise(resolve => openrouter.server.close(resolve)); };
  const session = storage.create({ ownerToken: 'local-owner', locale });
  const route = (suffix, body = {}, owner = 'local-owner') => handlers.handle(new Request(`https://start2.example.test/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const grant = async items => route('/consent', { granted: true, processing: { contract: consent.describe().contract, items } });
  const start = async (callId = 'call-1') => {
    assert.equal((await grant(['models-international', 'voice-elevenlabs'])).status, 200);
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  const callback = (identity, bearer = 'local-callback-fixture', extra = {}) => handlers.handle(new Request('https://start2.example.test/api/voice/llm/chat/completions', {
    method: 'POST', headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: identity }, messages: [{ role: 'user', content: 'Hello' }], ...extra }) }));
  return { storage, eleven, handlers, runtime, session, route, grant, start, callback, consent, upstream, voiceCap,
    processing: value => { processing = value; }, reconciled: reconciled.promise };
}

test('start2 retries uncertain holds in process and admits a later call without a restart', { timeout: 5000 }, async t => {
  const h = await fixture(t, { capMilliseconds: 601_000, closureTimeoutMs: 10, reconcileIntervalMs: 10 }), call = await h.start();
  h.processing(true);
  const terminal = await h.route(`/voice/${call.callId}/close`, { providerSessionId: call.providerSessionId }).then(r => r.json());
  assert.equal(terminal.outcome, 'uncertain'); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 600_000);
  assert.equal((await h.route('/voice', { callId: 'held' })).status, 403);
  assert.equal(h.storage.voiceCalls()[0].reconciliationPending, true);
  h.processing(false); await h.reconciled;
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0); assert.equal(h.voiceCap.snapshot().spentMilliseconds, 1000);
  assert.equal(h.storage.voiceCalls()[0].reconciliationPending, false);
  await h.start('later-call');
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 600_000);
});

test('static callback authenticates before body, rejects missing/unknown identity and disables per-call route/provisioning', async t => {
  const h = await fixture(t), call = await h.start(), writes = h.eleven.requests.filter(r => r.method !== 'GET').length;
  for (const bearer of [null, 'wrong']) assert.equal((await h.callback(call.facadeCallId, bearer)).status, 401);
  const malformed = new Request('https://start2.example.test/api/voice/llm/chat/completions', { method: 'POST', body: 'invalid-json' });
  assert.equal((await h.handlers.handle(malformed)).status, 401); assert.equal(malformed.bodyUsed, false);
  for (const identity of [undefined, '', 'unknown', call.callId]) assert.equal((await h.callback(identity)).status, 403);
  assert.equal((await h.handlers.handle(new Request(`https://host/api/voice/${call.callId}/llm/chat/completions`, { method: 'POST', body: '{}' }))).status, 404);
  const result = await h.callback(call.facadeCallId); assert.equal(result.status, 200); assert.equal((await result.json()).choices[0].message.content, 'Local reasoning');
  assert.equal(h.upstream.length, 1); assert.ok(h.upstream[0].usage.include);
  assert.equal(h.upstream[0].model, 'anthropic/speech-fixture'); assert.equal(h.upstream[0].max_tokens, 1200);
  assert.equal(h.upstream[0].provider.require_parameters, true);
  assert.deepEqual(h.upstream[0].provider.only, ['Anthropic', 'OpenAI']);
  assert.equal(Object.hasOwn(h.upstream[0].provider, 'ignore'), false);
  assert.deepEqual(h.upstream[0].reasoning, { enabled: false });
  assert.equal(h.eleven.requests.filter(r => r.method !== 'GET').length, writes, 'no per-call agent/secret mutation');
  assert.ok(!JSON.stringify(call).includes('local-callback-fixture'));
  await h.route(`/voice/${call.callId}/close`, { providerSessionId: call.providerSessionId });
  assert.equal((await h.callback(call.facadeCallId)).status, 403);
});
test('each call carries only the conversation language; the greeting stays the agent\'s AI notice (AIT-119)', async t => {
  for (const locale of ['en', 'de']) {
    const h = await fixture(t, { locale }), call = await h.start();
    assert.deepEqual(call.overrides, { agent: { language: locale } });
    await h.route(`/voice/${call.callId}/close`, { providerSessionId: call.providerSessionId });
  }
});
test('typed reaction and understanding bind different configured models with current consent and share the spend cap', async t => {
  const h = await fixture(t); assert.equal((await h.grant(['models-international'])).status, 200);
  const request = { system: 'Local policy', messages: [{ role: 'user', content: 'Hello' }],
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } };
  for (const [lane, operation] of [['reaction', 'stream'], ['understanding', 'structured']]) {
    const admitted = await h.runtime.admit({ session: h.storage.get(h.session.id), lane, operation, request });
    try {
      if (operation === 'stream') { for await (const chunk of admitted.plugin.stream(request, admitted.options)) assert.equal(chunk, 'Local reasoning'); }
      else assert.deepEqual(await admitted.plugin.structured(request, admitted.options), { summary: 'Local understanding' });
    } finally { admitted.finish(); }
  }
  assert.deepEqual(h.upstream.map(b => [b.model, b.max_tokens]), [['anthropic/speech-fixture', 1200], ['openai/understanding-fixture', 8000]]);
  assert.ok(h.upstream.every(body => body.provider.require_parameters === true));
  assert.deepEqual(h.upstream.map(body => body.provider.only), [['Anthropic', 'OpenAI'], ['Anthropic', 'OpenAI']]);
  assert.equal(Object.hasOwn(h.upstream[0].provider, 'ignore'), false);
  assert.deepEqual(h.upstream[1].provider.ignore, ['Azure']);
  assert.equal(h.storage.db.prepare('SELECT SUM(actual_micro) n FROM spend_reservations').get().n, 20);
});
test('foreign ownership, paused calls and stale recovery callbacks cannot admit reasoning', async t => {
  const h = await fixture(t), call = await h.start();
  const body = { providerSessionId: call.providerSessionId };
  await h.route(`/voice/${call.callId}/pause`, body); assert.equal((await h.callback(call.facadeCallId)).status, 403);
  await h.route(`/voice/${call.callId}/resume`, body);
  const replacement = await h.route(`/voice/${call.callId}/recover`, body).then(r => r.json());
  assert.ok(replacement.facadeCallId); assert.notEqual(replacement.facadeCallId, call.facadeCallId);
  assert.equal((await h.callback(call.facadeCallId)).status, 403);
  const streamed = await h.callback(replacement.facadeCallId, 'local-callback-fixture', { stream: true });
  assert.equal(streamed.status, 200); assert.match(await streamed.text(), /Local reasoning/);
  const snapshot = h.storage.get(h.session.id); snapshot.ownerHash = 'changed-owner';
  h.storage.db.prepare('UPDATE sessions SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), h.session.id);
  assert.equal((await h.callback(replacement.facadeCallId)).status, 403);
});
test('mock consent cannot grant live scope; current separate item decisions and withdrawal are authoritative', async t => {
  const h = await fixture(t);
  assert.equal((await h.route('/consent', { granted: true })).status, 409);
  assert.equal((await h.route('/voice', { callId: 'no-grant' })).status, 403);
  assert.equal((await h.grant(['models-international'])).status, 200);
  assert.equal((await h.route('/voice', { callId: 'no-voice-grant' })).status, 403);
  const call = await h.start();
  assert.equal((await h.route('/consent', { granted: false })).status, 200);
  assert.equal((await h.callback(call.facadeCallId)).status, 403);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM processing_consents').get().n, 0);
  assert.ok(h.storage.db.prepare('SELECT COUNT(*) n FROM processing_consent_events').get().n >= 3);
});
test('SQLite consent persists across restart; expires, versions, model/endpoint and revisions fail closed', async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path), clock = Date.now(); t.after(() => storage.close());
  const binding = qualifyStartBinding({ plugin: 'openrouter', model: 'openai/fixture', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    accountRef: 'account', secretRef: 'local-ref', routing: {} });
  const bindings = [binding]; let port = createProcessingConsent({ storage, bindings, now: () => clock });
  const session = storage.create({ ownerToken: 'owner' }), scope = { plugin: 'openrouter', model: binding.model, endpoint: binding.endpoint, routing: {}, accountRef: 'account',
    operation: 'stream', purpose: 'models-international', recipients: ['OpenRouter, Inc.'], upstreamProcessors: ['OpenAI'], itemVersion: 1,
    dataCategories: ['messages', 'file-text', 'conversation-history', 'assessment'] };
  const revision = session.consentRevision + 1;
  assert.equal(port.grant({ sessionId: session.id, consentRevision: revision, decision: { contract: port.describe().contract, items: ['models-international'] } }), true);
  storage.reviseConsent(session.id, true); storage.close(); storage = new SQLiteStorage(path); port = createProcessingConsent({ storage, bindings, now: () => clock });
  const coverage = change => port.coverage({ sessionId: session.id, consentRevision: revision, scope: { ...scope, ...change } });
  assert.equal(coverage().covered, true);
  for (const change of [{ model: 'anthropic/foreign' }, { endpoint: 'https://foreign.test' }, { itemVersion: 2 },
    { routing: { only: ['Anthropic'] } }]) assert.equal(coverage(change).covered, false);
  clock += CONSENT_VALIDITY_MS; assert.equal(coverage().covered, false);
  assert.equal(port.grant({ sessionId: session.id, consentRevision: revision + 1, decision: { contract: 'stale', items: ['models-international'] } }), false);
  assert.equal(port.coverage({ sessionId: session.id, consentRevision: revision - 1, scope }).covered, false);
});
