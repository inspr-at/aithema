import { aiNoticeText } from '../../core/src/ai-notice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, createSpendCap, createVoiceCap } from '../src/index.js';
import { PluginRegistry, inputRevision, reduceUnderstanding, applyEvent, createSession } from '@inspr/aithema-core';
import { listen } from '../src/http.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { createVoiceHost } from '../../../demo/start2-voice-host.js';
import { createProcessingConsent, qualifyStartBinding, CONSENT_VALIDITY_MS } from '../../../demo/processing-consent.js';
import { fakeElevenLabs } from '../../../test/start2-fakes.js';
import { openRouterConfig } from '../../../demo/openrouter-config.js';
import { htmlConfig } from '../../../demo/html-config.js';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { temporaryDb } from '../../../test/helpers.js';

async function fixture(t, { locale = 'en', capMilliseconds, closureTimeoutMs, reconcileIntervalMs, drafts = false } = {}) {
  let cleanup; t.after(() => cleanup?.());
  const storage = new SQLiteStorage(), eleven = await fakeElevenLabs(t), logs = [], upstream = [];
  let processing = false, heldUnderstanding;
  const reconciled = Promise.withResolvers();
  const providerFetch = (input, options) => new URL(input).pathname.startsWith('/v1/convai/conversations/') && processing
    ? Promise.resolve(Response.json({ conversation_id: new URL(input).pathname.split('/').at(-1), status: 'processing' })) : fetch(input, options);
  const openrouter = await listen(async req => {
    const body = await req.json(); upstream.push(body);
    if (!body.stream) {
      if (heldUnderstanding) { heldUnderstanding.started.resolve(); await heldUnderstanding.released.promise; }
      const assessment = { summary: 'Local understanding' }, schema = body.response_format.json_schema.schema;
      if (schema.properties.constraints) Object.assign(assessment, { signals: [], openQuestions: [],
        constraints: Object.fromEntries(Object.keys(schema.properties.constraints.properties).map(key => [key, null])),
        progress: { talk: { value: .2, reasoning: '' }, build: { value: 0, reasoning: '' } },
        actor: null, engagement: null, conceptIntent: null });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.00001 } });
    }
    return new Response('data: {"choices":[{"delta":{"content":"Local reasoning"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"cost":0.00001}}\n\ndata: [DONE]\n\n');
  });
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://start2.example.test', apiBaseUrl: eleven.endpoint,
    values: { AITHEMA_VOICE_MAX_DURATION_SECONDS: '600', AITHEMA_ELEVENLABS_USD_PER_CREDIT: '0.0001' },
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
  const htmlBinding = drafts ? htmlConfig({ AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: 'anthropic/claude-fixture',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'anthropic/claude-fixture': { prompt: 1e-7, completion: 1e-7 } }) }).binding : null;
  const consent = createProcessingConsent({ storage, bindings: [host.binding, reaction, understanding, ...(htmlBinding ? [htmlBinding] : [])] });
  const voice = createVoiceProvider({ storage, staticFacade: true, binding: { agentId: host.binding.agentId, secretRef: host.binding.secretRef,
    apiBaseUrl: eleven.endpoint, upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000,
    reservationSeconds: host.binding.reservationSeconds, usdPerCredit: host.binding.usdPerCredit }, resolveSecret: () => 'local-fixture-key',
    fetchImpl: providerFetch, closureTimeoutMs, reconcileLater: () => handlers.reconcileVoiceLater() });
  const secrets = createFacadeSecrets(); secrets.resolve = ref => ref === host.staticSecretRef ? 'local-callback-fixture' : null;
  const voiceCap = capMilliseconds === undefined ? undefined : createVoiceCap({ storage, capMilliseconds });
  const registry = new PluginRegistry().register(reasoning).register(voice);
  if (htmlBinding) registry.register(createClaudeHTML({ binding: htmlBinding,
    spend: createSpendCap({ storage, account: htmlBinding.accountRef, capMicro: 2_000_000 }), resolveSecret: () => 'local-fixture-key',
    fetchImpl: () => { throw new Error('No draft was requested'); } }));
  const runtime = createPluginRuntime({ storage, consent, voiceCap, registry,
    presets: { best: { plugins: ['elevenlabs', 'openrouter', ...(htmlBinding ? ['claude-html'] : [])],
      bindings: { voice: host.binding, reaction, understanding, ...(htmlBinding ? { html: htmlBinding } : {}) },
      policy: { endpoints: [eleven.endpoint, reaction.endpoint, ...(htmlBinding ? [htmlBinding.endpoint] : [])] } } } });
  const reconcile = runtime.reconcileVoice;
  runtime.reconcileVoice = (...args) => { const result = reconcile(...args); reconciled.resolve(); return result; };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent,
    voice: { secrets, staticSecretRef: host.staticSecretRef, presentation: host.presentation, closeOrphan: host.closeOrphan, reconcileIntervalMs } });
  cleanup = async () => { heldUnderstanding?.released.resolve(); await handlers.close(); storage.close(); openrouter.server.closeAllConnections(); await new Promise(resolve => openrouter.server.close(resolve)); };
  const session = storage.create({ ownerToken: 'local-owner', locale });
  const route = (suffix, body = {}, owner = 'local-owner') => handlers.handle(new Request(`https://start2.example.test/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const grant = async items => route('/consent', { granted: true, processing: { contract: consent.describe().contract, items } });
  const start = async (callId = 'call-1') => {
    assert.equal((await grant(['models-international', 'voice-elevenlabs'])).status, 200);
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  // Call the callback exactly as the platform does: its OpenAI client appends /chat/completions to the custom-LLM base URL
  // the host configured on the agent (AIT-126; the full path was doubled live and fell outside the host's exact-path bypass).
  const agentUrl = eleven.requests.find(r => r.method !== 'GET' && /\/v1\/convai\/agents\/(?:create|[^/]+)$/u.test(r.path) && r.body?.conversation_config)
    ?.body.conversation_config.agent.prompt.custom_llm.url;
  assert.equal(agentUrl, 'https://start2.example.test/api/voice/llm', 'the agent gets the base URL, not the full callback path');
  const platformUrl = `${agentUrl}/chat/completions`;
  const callback = (identity, bearer = 'local-callback-fixture', extra = {}) => handlers.handle(new Request(platformUrl, {
    method: 'POST', headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: identity }, messages: [{ role: 'user', content: 'Hello' }], ...extra }) }));
  return { storage, eleven, handlers, runtime, session, route, grant, start, callback, consent, upstream, voiceCap,
    holdUnderstanding() { heldUnderstanding = { started: Promise.withResolvers(), released: Promise.withResolvers() }; return heldUnderstanding; },
    processing: value => { processing = value; }, reconciled: reconciled.promise };
}

function savedConversation(h) {
  const id = h.session.id;
  h.storage.postTurn(id, 'requirements', Buffer.from('Repairs'), 'Repairs');
  const session = h.storage.get(id), revision = inputRevision(session);
  h.storage.append(id, 'turn.final', { id: 'saved-reply', role: 'assistant', content: 'Saved answer', at: new Date().toISOString(),
    inputRevision: revision, model: 'anthropic/speech-fixture', provider: 'openrouter' });
  h.storage.append(id, 'understanding.updated', reduceUnderstanding(session.understanding, { summary: 'Saved assessment', constraints: {},
    openQuestions: ['Who approves repairs?'], progress: { talk: { value: .65 }, build: { value: 0 } } },
  { transcript: session.transcript, inputRevision: revision, preset: session.preset, locale: session.locale }));
  return h.storage.get(id);
}

for (const selected of [false, true]) test(`draft-only consent ${selected ? 'withdrawal' : 'grant'} preserves active voice and saved conversation`, { timeout: 5000 }, async t => {
  const h = await fixture(t, { drafts: true }), items = ['models-international', 'voice-elevenlabs'];
  assert.equal((await h.grant([...items, ...(selected ? ['drafts-anthropic'] : [])])).status, 200); await h.handlers.idle();
  const response = await h.route('/voice', { callId: 'ongoing' }); assert.equal(response.status, 201); const call = await response.json();
  const before = savedConversation(h), content = h.storage.db.prepare('SELECT id,bytes FROM content WHERE session_id=? AND tombstone IS NULL').all(h.session.id);
  assert.equal((await h.grant([...items, ...(!selected ? ['drafts-anthropic'] : [])])).status, 200); await h.handlers.idle();
  const after = h.storage.get(h.session.id);
  assert.deepEqual(after.transcript, before.transcript, 'draft-only changes retain the original replies');
  assert.deepEqual(after.understanding, before.understanding, 'draft-only changes retain the original assessment');
  assert.equal(inputRevision(after), inputRevision(before), 'conversation work keeps its input identity');
  assert.deepEqual(h.storage.db.prepare('SELECT id,bytes FROM content WHERE session_id=? AND tombstone IS NULL').all(h.session.id), content);
  const replay = h.storage.read(h.session.id).reduce(applyEvent, createSession({ id: h.session.id }));
  assert.deepEqual(replay.transcript, after.transcript); assert.deepEqual(replay.understanding, after.understanding);
  assert.equal((await h.callback(call.facadeCallId)).status, 200, 'the same live voice call can still admit reasoning');
  assert.equal((await h.route(`/voice/${call.callId}/heartbeat`, { providerSessionId: call.providerSessionId })).status, 200);
});

test('draft-only consent saves keep dispatched understanding running without a second provider call', { timeout: 5000 }, async t => {
  const h = await fixture(t, { drafts: true }), call = await h.start(), held = h.holdUnderstanding();
  for (let i = 0; i < h.storage.get(h.session.id).preset.anonymousTurns; i++) {
    assert.equal((await h.route('/turns', { clientEventId: `needs-${i}`, content: 'Repairs' })).status, 200);
  }
  await held.started.promise;
  const revision = inputRevision(h.storage.get(h.session.id));
  assert.equal((await h.grant(['models-international', 'voice-elevenlabs', 'drafts-anthropic'])).status, 200);
  assert.equal(inputRevision(h.storage.get(h.session.id)), revision);
  held.released.resolve(); await h.handlers.idle();
  assert.equal(h.upstream.filter(body => !body.stream).length, 1, 'the original assessment completes instead of being aborted and rerun');
  assert.equal(h.storage.get(h.session.id).understanding.summary, 'Local understanding');
  assert.equal(h.storage.get(h.session.id).understanding.inputRevision, revision);
  assert.equal((await h.callback(call.facadeCallId)).status, 200);
});

for (const withdrawn of ['models-international', 'voice-elevenlabs']) test(`withdrawing ${withdrawn} keeps the conversation withdrawal cascade`, { timeout: 5000 }, async t => {
  const h = await fixture(t, { drafts: true }), items = ['models-international', 'voice-elevenlabs', 'drafts-anthropic'];
  assert.equal((await h.grant(items)).status, 200); await h.handlers.idle();
  const response = await h.route('/voice', { callId: 'ongoing' }); assert.equal(response.status, 201); const call = await response.json();
  const before = savedConversation(h);
  const content = h.storage.db.prepare("SELECT id FROM content WHERE session_id=? AND kind IN ('reply','understanding','actor') AND tombstone IS NULL").all(h.session.id);
  assert.ok(content.length >= 2);
  assert.equal((await h.grant(items.filter(item => item !== withdrawn))).status, 200); await h.handlers.idle();
  assert.equal(h.storage.get(h.session.id).transcript.find(turn => turn.id === 'saved-reply').erased, true);
  assert.notEqual(inputRevision(h.storage.get(h.session.id)), inputRevision(before));
  for (const { id } of content) assert.equal(h.storage.db.prepare('SELECT bytes FROM content WHERE id=?').get(id).bytes, null);
  assert.equal((await h.callback(call.facadeCallId)).status, 403, 'reasoning or voice withdrawal stops the live call');
});

test('priced voice holds fund the runway and extend atomically without reserving the technical ceiling', async t => {
  const h = await fixture(t);
  assert.equal((await h.grant(['models-international', 'voice-elevenlabs'])).status, 200);
  const admitted = await h.runtime.admitVoice({ session: h.storage.get(h.session.id), request: { callId: 'money-test' } });
  const attempt = admitted.options.attempt;
  h.runtime.budget.now = () => 1_000;
  assert.equal(attempt.maxMicro, 200_000);
  await attempt.consume();
  assert.equal(attempt.extend(60).maxMicro, 200_000, 'the initial runway already funds the requested segment');
  assert.equal(attempt.extend(150).maxMicro, 250_000, 'later extensions reserve only the requested total duration');
  assert.equal(attempt.maxMicro, 250_000);
  assert.equal(h.runtime.budget.breakdown(h.session.id).reservedMicro, 250_000);
  assert.equal(h.runtime.budget.displayBreakdown(h.session.id, { now: 61_000 }).uncertainSpendMicro, 100_000,
    'runtime captures the selected voice rate for expected spend');
  h.runtime.budget.now = () => 61_000;
  admitted.finish();
  assert.equal(h.runtime.budget.displayBreakdown(h.session.id, { now: 3_661_000 }).uncertainSpendMicro, 100_000,
    'finish freezes expected spend while retaining provider liability');
  assert.equal(h.runtime.budget.breakdown(h.session.id).uncertainSpendMicro, 1_000_000,
    'losing the live invocation retains the provider ceiling, rather than its last healthy segment');
});

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
test('AIT-145: browser background close acknowledges locally ended before provider settlement', { timeout: 5000 }, async t => {
  const h = await fixture(t, { closureTimeoutMs: 2000 }), call = await h.start();
  h.processing(true);
  const began = Date.now();
  const response = await h.route(`/voice/${call.callId}/close`, { providerSessionId: call.providerSessionId, background: true });
  const receipt = await response.json();
  h.processing(false);
  assert.equal(response.status, 202);
  assert.ok(Date.now() - began < 1000, 'browser acknowledgement never waits for provider processing');
  assert.equal(receipt.reconciliationPending, true);
  assert.equal(receipt.closureConfirmed, false);
  assert.equal((await h.callback(call.facadeCallId)).status, 403, 'LLM authority is already revoked');
  await h.handlers.idle();
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
test('AIT-127: each call carries the conversation language and its matching AI notice', async t => {
  for (const locale of ['en', 'de']) {
    const h = await fixture(t, { locale }), call = await h.start();
    assert.deepEqual(call.overrides, { agent: { language: locale, firstMessage: aiNoticeText(locale) } });
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
