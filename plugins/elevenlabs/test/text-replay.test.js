import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceProvider } from '../src/provider.js';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime, createVoiceHandlers, createFacadeSecrets, mockPresets } from '../../../packages/server/src/index.js';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { qualifyStartBinding } from '../../../demo/processing-consent.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { listen } from '../../../packages/server/src/http.js';
import { createLocalVoiceProvider } from '../../fake-voice/src/server.js';

function fixture(t, { allowance = 100_000, status = 200, onPost, voiceRate = 0, sessionCapMicro = 10_000_000 } = {}) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const budget = new SQLiteBudgetLedger(storage, { sessionCapMicro }), requests = [];
  const session = storage.create({ ownerToken: 'tenant-a' });
  storage.append(session.id, 'turn.final', { id: 'reply-a', role: 'assistant', content: 'Exact answer.' });
  const binding = qualifyStartBinding({ plugin: 'elevenlabs', model: 'agent', effort: 'none',
    endpoint: 'https://fixture.test', accountRef: 'fixture', secretRef: 'fixture-ref', agentId: 'owned-agent',
    maxMicro: 200_000, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 3600,
    reservationSeconds: 30, upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000,
    usdPerCredit: .0002, publicFacadeBaseUrl: 'https://fixture.test' });
  const plugin = createVoiceProvider({ storage, binding: { ...binding, apiBaseUrl: binding.endpoint }, staticFacade: true,
    resolveSecret: () => 'fixture-key', fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/agents/owned-agent')) return Response.json({ agent_id: 'owned-agent', conversation_config: { tts: { voice_id: 'owned-voice', model_id: 'eleven_flash_v2_5' } } });
      if (url.endsWith('/voices/owned-voice')) return Response.json({ voice_id: 'owned-voice', sharing: { rate: voiceRate } });
      if (url.endsWith('/models')) return Response.json([{ model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true,
        model_rates: { character_cost_multiplier: .5, cost_discount_multiplier: 1 } }]);
      assert.equal(options.method, 'POST'); onPost?.(storage, budget);
      assert.equal(budget.db.prepare("SELECT count(*) AS n FROM budget_attempts WHERE state='dispatched'").get().n, 1);
      return new Response(new Uint8Array([1, 0, 2, 0]), { status, headers: { 'content-type': 'audio/pcm', 'character-cost': '6', 'x-character-count': '13' } });
    } });
  const presets = mockPresets(); presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding; presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, scope, ...scope, consentRevision,
    checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };
  const runtime = createPluginRuntime({ storage, budget, consent, presets, registry: new PluginRegistry().register(createMockReasoning()).register(plugin) });
  const host = createDemoHost({ storage }), settings = host.visitorCredits.settings();
  host.visitorCredits.saveSettings({ baseRevision: settings.revision, allowancesUsd: Object.fromEntries(
    ['anonymous', 'emailGiven', 'emailConfirmed'].map(tier => [tier, String(allowance / 1_000_000)])) }, { actor: 'system:fixture', source: 'fixture' });
  runtime.setOwnerWallet(s => host.walletForSession(s));
  return { storage, budget, requests, runtime, plugin, session: storage.get(session.id) };
}

test('AIT-154: standalone TTS uses owned config, admits before POST and records observed cost per tenant', async t => {
  const f = fixture(t), other = f.storage.create({ ownerToken: 'tenant-b' });
  const before = f.session.transcript;
  const replay = await f.runtime.speakText({ session: f.session, turnId: 'reply-a' });
  assert.equal(replay.kind, 'audio'); assert.equal(replay.text, 'Exact answer.');
  const post = f.requests.find(r => r.options.method === 'POST');
  assert.match(post.url, /\/text-to-speech\/owned-voice\/stream\?output_format=pcm_16000$/u);
  assert.deepEqual(JSON.parse(post.options.body), { text: 'Exact answer.', model_id: 'eleven_flash_v2_5', apply_text_normalization: 'off' });
  const [row] = f.budget.db.prepare('SELECT * FROM budget_attempts').all();
  assert.equal(row.owner_hash, f.session.ownerHash); assert.equal(row.settled_micro, 1200);
  assert.equal(JSON.parse(row.usage).characters, 13); assert.equal(JSON.parse(row.usage).providerCredits, 6);
  assert.equal(f.budget.used(other.id), 0); assert.deepEqual(f.storage.get(f.session.id).transcript, before);
});

for (const allowance of [0, 1199]) test(`AIT-154: credit ${allowance} refuses before synthesis`, async t => {
  const f = fixture(t, { allowance });
  await assert.rejects(f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { code: 'not-admitted', message: 'host-limit' });
  assert.equal(f.requests.some(r => r.options.method === 'POST'), false);
});

test('AIT-154: session credit exhaustion uses the same calm used-up refusal', async t => {
  const f = fixture(t, { sessionCapMicro: 1199 });
  await assert.rejects(f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { code: 'not-admitted', message: 'host-limit' });
  assert.equal(f.requests.some(r => r.options.method === 'POST'), false);
});

test('AIT-154: unavailable synthesis falls back to exact text; voice off creates no admission', async t => {
  const f = fixture(t, { status: 403 });
  assert.deepEqual(await f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { kind: 'text', text: 'Exact answer.' });
});

test('AIT-154: stale reply and paused session are refused before provider work', async t => {
  const f = fixture(t);
  await assert.rejects(f.runtime.speakText({ session: f.session, turnId: 'old' }), { code: 'unavailable' });
  f.storage.pause(f.session.id, true, { ownerToken: 'tenant-a' });
  await assert.rejects(f.runtime.speakText({ session: f.storage.get(f.session.id), turnId: 'reply-a' }), { code: 'unavailable' });
  assert.equal(f.requests.length, 0);
});

test('AIT-154: fake pipeline implements optional standalone speakText without a provider', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const adapter = createLocalVoiceProvider({ storage }).ports.serverAdapter;
  const quote = await adapter.quoteSpeakText({ text: 'Fixture reply.' });
  assert.equal(quote.maxMicro, 0);
  const result = await adapter.speakText({ text: 'Fixture reply.', quote }, { attempt: { consume() {} } });
  assert.equal(result.audio.format, 'pcm_16000'); assert.equal(result.usage.upstreamMicro, 0);
});

test('AIT-154: page replay is owner-bound and rejects stale call authority', async t => {
  const f = fixture(t), handlers = createVoiceHandlers({ storage: f.storage, runtime: f.runtime, secrets: createFacadeSecrets(),
    ownership: { token: request => request.headers.get('x-aithema-session-token') },
    readBody: async request => new Uint8Array(await request.arrayBuffer()), publish() {}, onTurn() {} });
  t.after(() => handlers.close());
  const request = (suffix, owner = 'tenant-a') => new Request(`https://host.test/api/sessions/${f.session.id}/voice/${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify({ turnId: 'reply-a', providerSessionId: 'stale', tabId: 'fixture-tab', epoch: 0 }),
  });
  assert.equal((await handlers.handle(request('replay', 'tenant-b'))).status, 404);
  assert.equal((await handlers.handle(request('stale-call/replay'))).status, 502);
  assert.equal(f.requests.length, 0);
  const response = await handlers.handle(request('replay'));
  assert.equal(response.status, 200); assert.equal((await response.json()).kind, 'audio');
});

test('AIT-154: changing the reply during synthesis accounts usage but refuses its audio', async t => {
  const f = fixture(t, { onPost: storage => storage.append(storage.list()[0], 'turn.final', { id: 'reply-b', role: 'assistant', content: 'New answer.' }) });
  await assert.rejects(f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { code: 'unavailable' });
  assert.equal(f.budget.used(f.session.id), 1200);
});

test('AIT-154: an unquotable shared-voice surcharge falls back before admission', async t => {
  const f = fixture(t, { voiceRate: .05 });
  assert.deepEqual(await f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { kind: 'text', text: 'Exact answer.' });
  assert.equal(f.requests.some(r => r.options.method === 'POST'), false); assert.equal(f.budget.used(f.session.id), 0);
});

for (const tabs of [['tab-a', 'tab-a'], ['tab-a', 'tab-b']]) test(`AIT-154 round 2: parallel replay from ${tabs.join('/')} admits and calls the provider once`, async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const original = f.plugin.ports.serverAdapter.quoteSpeakText;
  f.plugin.ports.serverAdapter.quoteSpeakText = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const handlers = createVoiceHandlers({ storage: f.storage, runtime: f.runtime, secrets: createFacadeSecrets(),
    ownership: { token: () => 'tenant-a' }, readBody: async r => new Uint8Array(await r.arrayBuffer()), publish() {}, onTurn() {} });
  t.after(() => handlers.close());
  const request = tabId => new Request(`https://host.test/api/sessions/${f.session.id}/voice/replay`, {
    method: 'POST', body: JSON.stringify({ turnId: 'reply-a', tabId, replayId: crypto.randomUUID() }) });
  const first = handlers.handle(request(tabs[0])); await entered.promise;
  const second = handlers.handle(request(tabs[1]));
  // The refusal must complete while the first quote is still pending.
  const refused = await Promise.race([second.then(async r => ({ status: r.status, body: await r.json() })),
    new Promise(resolve => { const timer = setTimeout(() => resolve(null), 100); timer.unref(); })]);
  release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(refused?.body, { kind: 'busy' }); assert.equal(refused?.status, 200);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.equal(f.budget.db.prepare('SELECT count(*) n FROM budget_attempts').get().n, 1);
});

test('AIT-154 round 2: server replay lease covers playing, token-bound Stop releases it', async t => {
  const f = fixture(t);
  const replay = await f.runtime.speakText({ session: f.session, turnId: 'reply-a', options: { replayId: 'first' } });
  assert.equal(replay.kind, 'audio');
  assert.deepEqual(await f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { kind: 'busy' });
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
  f.runtime.stopReplyReplay(f.session.id, 'stale');
  assert.deepEqual(await f.runtime.speakText({ session: f.session, turnId: 'reply-a' }), { kind: 'busy' });
  f.runtime.stopReplyReplay(f.session.id, 'first');
  assert.equal((await f.runtime.speakText({ session: f.session, turnId: 'reply-a' })).kind, 'audio');
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 2);
});

for (const stop of ['error', 'abort', 'Stop']) test(`AIT-154 round 2: synthesis lease releases on ${stop}`, async t => {
  const f = fixture(t, { status: stop === 'error' ? 403 : 200 });
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const original = f.plugin.ports.serverAdapter.quoteSpeakText;
  f.plugin.ports.serverAdapter.quoteSpeakText = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const pending = f.runtime.speakText({ session: f.session, turnId: 'reply-a', options: { replayId: 'first', signal: controller.signal } });
  const checked = stop === 'error' ? pending : assert.rejects(pending);
  await entered.promise;
  if (stop === 'abort') controller.abort();
  if (stop === 'Stop') f.runtime.stopReplyReplay(f.session.id, 'first');
  release.resolve(); await checked;
  const next = await f.runtime.speakText({ session: f.session, turnId: 'reply-a' });
  assert.equal(next.kind, stop === 'error' ? 'text' : 'audio');
});

test('AIT-154 round 2: finishing the HTTP response keeps the server lease throughout playback', async t => {
  const f = fixture(t), handlers = createVoiceHandlers({ storage: f.storage, runtime: f.runtime, secrets: createFacadeSecrets(),
    ownership: { token: () => 'tenant-a' }, readBody: async r => new Uint8Array(await r.arrayBuffer()), publish() {}, onTurn() {} });
  const { server, url } = await listen(request => handlers.handle(request));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await handlers.close(); });
  const post = body => fetch(`${url}/api/sessions/${f.session.id}/voice/replay`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  assert.equal((await post({ turnId: 'reply-a', replayId: 'playing' })).kind, 'audio');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await post({ turnId: 'reply-a', replayId: 'second-tab' }), { kind: 'busy' });
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.deepEqual(await post({ stop: true, replayId: 'playing' }), { stopped: true });
  assert.equal((await post({ turnId: 'reply-a', replayId: 'after-stop' })).kind, 'audio');
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 2);
});
