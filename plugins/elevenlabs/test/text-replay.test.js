import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceProvider } from '../src/provider.js';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime, mockPresets } from '../../../packages/server/src/index.js';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { qualifyStartBinding } from '../../../demo/processing-consent.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { createLocalVoiceProvider } from '../../fake-voice/src/server.js';

function fixture(t, { allowance = 100_000, status = 200, onPost } = {}) {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const budget = new SQLiteBudgetLedger(storage), requests = [];
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
  const host = createDemoHost(storage, { budget, creditLimitMicro: allowance }); runtime.setOwnerWallet(s => host.walletForSession(s));
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
