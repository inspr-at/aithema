// Copied into the isolated installed host. Synthetic wire only; no xAI network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PluginRegistry, publicReasoningManifest } from '@inspr/aithema-core';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime, createVoiceHandlers } from '@inspr/aithema-server';
import { createGrokVoiceProvider } from '@inspr/aithema-plugin-grok-voice/server';
import { createGrokVoiceClient } from '@inspr/aithema-plugin-grok-voice/client';

export async function testGrokConsumer() {
  const config = { secretRef: 'private:fixture-secret', accountRef: 'private:fixture-account',
    accountEvidence: { zdrEnabled: true, dpaAccepted: true, recipient: 'SpaceXAI LLC', recipientCountry: 'US',
      processing: 'international-no-guaranteed-region', reviewedAt: '2026-10-18', expiresAt: '2099-01-01',
      zdrRef: 'private:zdr', dpaRef: 'private:dpa', retentionRef: 'private:retention', transferRef: 'private:transfers',
      approvalRef: 'private:approval', contractRef: 'private:contract' } };
  const binding = (model = 'grok-voice') => ({ plugin: 'grok-voice', model, endpoint: 'https://api.x.ai', effort: 'none',
    secretRef: config.secretRef, accountRef: config.accountRef, maxMicro: 0, maxTokens: 1,
    rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60,
    upstreamMicroPerMinute: 0, visitorMicroPerMinute: 600, adapterConfig: {},
    legal: { approved: true, purpose: 'voice-xai', consentVersion: 1, recipient: 'SpaceXAI LLC', processors: [],
      countries: ['US'], training: false, retention: 'private account ZDR',
      dataCategories: ['speech-input', 'transcripts', 'answer-text', 'connection-data'],
      evidence: { qualified: true, accountRef: config.accountRef, secretRef: config.secretRef, model,
        endpoint: 'https://api.x.ai', routing: {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 } } });
  const storage = new SQLiteStorage(':memory:'), record = storage.create({ ownerToken: 'fixture-owner' });
  const budget = new SQLiteBudgetLedger(storage), dispatched = [], played = [], scopes = [];
  let captureAudio, clientSession, handlers, provider, openSockets = 0;
  const answer = 'Aithema writes this fixture answer.';
  const consent = { async coverage({ scope, consentRevision }) {
    scopes.push(scope);
    return { ...scope, scope, covered: true, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60000 };
  } };
  const reasoningBinding = { plugin: 'fixture-reasoning', model: 'fixture-model', endpoint: 'https://reasoning.test', effort: 'none',
    accountRef: 'private:fixture-reasoning', secretRef: 'private:fixture-reasoning-secret', maxMicro: 1000, maxTokens: 100,
    rates: { inputMicro: 1, outputMicro: 1 } };
  const voiceLegal = binding().legal;
  reasoningBinding.legal = { ...voiceLegal, purpose: 'models-international', recipient: 'Fixture reasoning', countries: ['AT'],
    evidence: { ...voiceLegal.evidence, accountRef: reasoningBinding.accountRef, secretRef: reasoningBinding.secretRef,
      model: reasoningBinding.model, endpoint: reasoningBinding.endpoint } };
  const reasoning = { binding: reasoningBinding,
    manifest: publicReasoningManifest(reasoningBinding.plugin, 'Fixture reasoning', reasoningBinding.endpoint),
    health: async () => ({ available: true }), structured() { assert.fail('Voice uses admitted streaming reasoning'); },
    async *stream(request, options) {
      await options.attempt.consume(); dispatched.push('reasoning');
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === 'Hello world.'));
      yield answer;
      await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', chargedMicro: 1,
        usage: { inputTokens: 2, outputTokens: 3 } });
    } };
  const connect = async ({ url }) => {
    const role = new URL(url).pathname === '/v1/stt' ? 'stt' : 'tts';
    assert.ok(['/v1/stt', '/v1/tts'].includes(new URL(url).pathname));
    dispatched.push(role); openSockets++;
    const endpoint = Promise.withResolvers(); let closed = false;
    return { close() { if (!closed) { closed = true; openSockets--; endpoint.resolve(); } },
      send(value) {
        if (typeof value !== 'string') return;
        const event = JSON.parse(value);
        if (event.type === 'audio.done') endpoint.resolve();
        if (event.type === 'text.delta') assert.equal(event.delta, answer);
      },
      events: (async function* () {
        if (role === 'stt') {
          yield JSON.stringify({ type: 'transcript.created' });
          await endpoint.promise;
          yield JSON.stringify({ type: 'transcript.done', text: 'Hello world.', duration: 0.6 });
        } else {
          yield JSON.stringify({ type: 'audio.delta', delta: 'AAAAAA==' });
          yield JSON.stringify({ type: 'audio.done', trace_id: '00000000-0000-4000-8000-000000000351' });
        }
      })() };
  };
  try {
    provider = createGrokVoiceProvider({ enabled: true, config, binding: binding(), storage, consent,
      componentBindings: { stt: binding('grok-voice-transcribe-2.0'), tts: binding('grok-voice-tts') },
      resolveSecret: () => 'synthetic-only', connect,
      authenticateRelay: request => request.headers.get('x-owner'), relayOrigin: 'https://host.test' });
    const registry = new PluginRegistry().register(provider).register(reasoning);
    const preset = { plugins: ['grok-voice', reasoningBinding.plugin],
      bindings: { voice: binding(), reaction: reasoningBinding, understanding: reasoningBinding },
      policy: { endpoints: ['https://api.x.ai', reasoningBinding.endpoint] } };
    const runtime = createPluginRuntime({ storage, budget, registry, consent, presets: { best: preset } });
    handlers = createVoiceHandlers({ storage, runtime, ownership: { token: request => request.headers.get('x-owner') },
      readBody: async request => new Uint8Array(await request.arrayBuffer()), publish() {}, onTurn() {} });
    const post = async (suffix, body) => {
      const response = await handlers.handle(new Request(`https://host.test/api/sessions/${record.id}/voice${suffix}`, {
        method: 'POST', headers: { 'x-owner': 'fixture-owner' }, body: JSON.stringify(body) }));
      const value = await response.json();
      assert.ok(response.ok, `voice control ${suffix}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const control = { start: request => post('', { ...request, tabId: 'fixture-tab' }) };
    for (const action of ['close', 'pause', 'resume', 'heartbeat', 'recover']) control[action] = identity =>
      post(`/${identity.callId}/${action}`, { ...identity, tabId: 'fixture-tab' });
    const client = createGrokVoiceClient({ control,
      network: { url: 'https://host.test/composed/relay', headers: { 'x-owner': 'fixture-owner' },
        fetch: (url, init) => handlers.handle(new Request(url, init)) },
      capture: async ({ onAudio }) => { captureAudio = onAudio; return { stop() {} }; },
      player: { play(bytes, format) { played.push({ bytes, format }); }, stop() {} } });
    clientSession = await client.start({ callId: 'installed-grok' }, { deadlineAt: Date.now() + 5000 });
    const pcm = Buffer.alloc(3200); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
    await captureAudio(pcm); await captureAudio(Buffer.alloc(16000));
    const deadline = Date.now() + 5000;
    while (!played.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(dispatched, ['stt', 'reasoning', 'tts']);
    assert.equal(played.length, 1); assert.equal(played[0].format.format, 'pcm_s16le');
    assert.deepEqual(storage.get(record.id).transcript.map(turn => [turn.role, turn.content]),
      [['user', 'Hello world.'], ['assistant', answer]]);
    assert.ok(scopes.some(scope => scope.purpose === 'voice-xai' && scope.operation === 'speak'));
    assert.ok(scopes.some(scope => scope.plugin === 'fixture-reasoning'));
    await clientSession.close();
    const rows = storage.db.prepare('SELECT * FROM budget_attempts WHERE session_id=?').all(record.id);
    const parent = rows.find(row => row.lane === 'voice'), children = rows.filter(row => ['stt', 'tts'].includes(row.lane));
    assert.equal(parent.settled_micro, 0); assert.ok(parent.settled_visitor_micro > 0);
    assert.deepEqual(children.map(row => row.lane), ['stt', 'tts']);
    assert.ok(children.every(row => row.state === 'settled' && row.settled_micro > 0 && JSON.parse(row.usage).estimated === true));
    assert.ok(children.every(row => JSON.parse(row.component_json).parentAttemptId === parent.attempt_id));
    const browserAudio = import.meta.resolve('@inspr/aithema-server/composed-voice/browser-audio');
    assert.match(readFileSync(new URL('./pcm-capture-worklet.js', browserAudio), 'utf8'), /registerProcessor/u);
    assert.equal(openSockets, 0);
    return { call: 'joined PCM/STT/admitted reasoning/TTS/relay', child_claims: 2, upstream: 'estimated',
      visitor: 'aithema-measured', worklet: 'installed adjacent to browser-audio', provider_calls: 0,
      qualification: 'not yet qualified in live use' };
  } finally {
    await clientSession?.close().catch(() => {});
    provider?.networkRelay?.close(); await handlers?.close(); storage.close();
  }
}
