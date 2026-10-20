import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { createSession, processingScope } from '@inspr/aithema-core';
import { SQLiteStorage } from '@inspr/aithema-server';
import { createProcessingConsent, qualifyStartBinding } from '../processing-consent.js';
import { openRouterConfig } from '../openrouter-config.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { reasonSeparator } from '../../packages/ui/src/display.js';

test('host voice setup errors render in German and English as new conversations change language', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'navigator', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let session;
  try {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys.filter(key => key !== 'fetch')) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
    localStorage.setItem('aithema-demo-locale', 'de');
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(url, window.location.href).pathname;
      if (pathname === '/demo/config') return Response.json({ demoHost: true, voiceMode: 'off', voiceDisabledReason: 'agent-api-get-403', label: '', imageLabel: '' });
      if ((pathname === '/api/sessions' || pathname === '/api/library') && init.method === 'POST') {
        session = createSession({ demo: true, locale: JSON.parse(init.body).locale });
        session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' } } };
        return Response.json(pathname === '/api/library' ? { session } : session);
      }
      if (pathname.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (pathname === `/api/sessions/${session.id}`) return Response.json(session);
      throw new Error(`Unexpected fixture request: ${pathname}`);
    };
    await import('../host.js');
    const check = copy => {
      assert.equal(document.querySelector('#error').textContent, '');
      assert.equal(document.querySelector('#provider').textContent, `${reasonSeparator}${copy.host.visualsOff}${reasonSeparator}${copy.reasons['voice-host-unavailable']}`);
    };
    check(de);
    const locale = document.querySelector('#locale'); locale.value = 'en'; locale.dispatchEvent(new window.Event('change'));
    check(de);
    document.querySelector('aithema-session').shadowRoot.querySelector('.conversations-new').click();
    for (let i = 0; document.documentElement.lang !== 'en'; i++) {
      if (i === 400) assert.fail('Host did not open the English conversation');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    check(en);
  } finally {
    window.document.querySelector('aithema-session')?.remove(); await window.happyDOM.close();
    for (const key of keys) { if (originals[key]) Object.defineProperty(globalThis, key, originals[key]); else delete globalThis[key]; }
  }
});

test('latest aliases qualify and receive consent under the normalized provider, with exact model scopes', () => {
  const analysis = '~anthropic/claude-opus-latest', speech = '~anthropic/claude-haiku-latest';
  const configured = openRouterConfig({ OPENROUTER_MODEL: analysis, OPENROUTER_SPEECH_MODEL: speech,
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [analysis]: { prompt: 5e-6, completion: 25e-6 },
      [speech]: { prompt: 1e-7, completion: 5e-7 } }) });
  const bindings = [configured.reaction, configured.understanding];
  assert.deepEqual(bindings.map(b => b.model), [speech, analysis]);
  for (const b of bindings) {
    assert.deepEqual(b.legal.processors, ['Anthropic']);
    assert.equal(b.legal.evidence.model, b.model);
  }
  for (const model of ['unknown/fixture', '~unknown/family-latest', 'constructor/fixture', '~constructor/family-latest',
    '~anthropic/fixture', '~~anthropic/claude-opus-latest', '~anthropic/path/family-latest']) {
    assert.throws(() => qualifyStartBinding({ ...configured.understanding, model }), /not covered by START consent/);
  }
  for (const [model, provider] of [['~openai/gpt-latest', 'OpenAI'], ['~x-ai/grok-latest', 'xAI']]) {
    assert.deepEqual(qualifyStartBinding({ ...configured.understanding, model }).legal.processors, [provider]);
  }
  assert.throws(() => openRouterConfig({ OPENROUTER_MODEL: analysis,
    AITHEMA_OPENROUTER_PRICES: '{"anthropic/claude-opus-5.5":{"prompt":0.000005,"completion":0.000025}}' }), /for ~anthropic\/claude-opus-latest/);
  const storage = new SQLiteStorage();
  try {
    const session = storage.create(), consent = createProcessingConsent({ storage, bindings });
    assert.equal(consent.describe().contract.split('|').at(-1), 'anthropic');
    assert.equal(consent.grant({ sessionId: session.id, consentRevision: 1,
      decision: { contract: consent.describe().contract, items: ['models-international'] } }), true);
    storage.reviseConsent(session.id, true);
    for (const [b, operation] of [[configured.reaction, 'stream'], [configured.understanding, 'structured']]) {
      assert.equal(consent.coverage({ sessionId: session.id, consentRevision: 1, scope: processingScope(b, operation) }).covered, true);
      assert.equal(consent.coverage({ sessionId: session.id, consentRevision: 1,
        scope: processingScope({ ...b, model: 'anthropic/other' }, operation) }).covered, false);
    }
  } finally { storage.close(); }
});

test('processing consent describe omits expired, withdrawn and mismatched revision grants', () => {
  const storage = new SQLiteStorage(); let at = 1;
  try {
    const session = storage.create(), binding = qualifyStartBinding({ plugin: 'openrouter', model: 'openai/gpt-4.1-mini' }, at);
    const consent = createProcessingConsent({ storage, bindings: [binding], now: () => at });
    consent.grant({ sessionId: session.id, consentRevision: 1, decision: { contract: consent.describe().contract, items: ['models-international'] } });
    assert.deepEqual(consent.describe(session.id).selected, [], 'uncommitted revision cannot appear granted');
    storage.reviseConsent(session.id, true); assert.deepEqual(consent.describe(session.id).selected, ['models-international']);
    at += 365 * 24 * 60 * 60 * 1000; assert.deepEqual(consent.describe(session.id).selected, []);
    at = 1; storage.reviseConsent(session.id, false); assert.deepEqual(consent.describe(session.id).selected, []);
  } finally { storage.close(); }
});

test('AIT-197: real ElevenLabs plus model scopes map voice, and partial removal preserves the conversation', async t => {
  const { createVoiceHost } = await import('../start2-voice-host.js');
  const { stubAgentApi } = await import('../../test/fixtures/voice-self-heal-host.js');
  const { createVoiceProvider } = await import('../../packages/server/src/voice-provider.js');
  const { createPluginRuntime, createHandlers } = await import('../../packages/server/src/index.js');
  const { createOpenRouterReasoning } = await import('../../plugins/openrouter/src/index.js');
  const { PluginRegistry } = await import('../../packages/core/src/index.js');
  const { ownedRequest, testToken } = await import('../../test/helpers.js');
  const { demoPresets } = await import('../choices.js');
  const storage = new SQLiteStorage(), api = stubAgentApi();
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://fixture.test',
    apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', values: {}, log() {} });
  t.after(async () => { await host.close(); storage.close(); });
  const { normalizeElevenLabsDurationBinding } = await import('../../plugins/elevenlabs/src/config.js');
  const { createDurationBinding } = await import('../../packages/server/src/voice-binding.js');
  const binding = createDurationBinding(normalizeElevenLabsDurationBinding(host.binding));
  const voice = createVoiceProvider({ storage, staticFacade: true, resolveSecret: () => 'fixture-secret', fetchImpl: api.fetchImpl,
    binding: { adapterConfig: binding.adapterConfig, secretRef: binding.secretRef, apiBaseUrl: binding.endpoint,
      upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute,
      reservationSeconds: binding.reservationSeconds } });
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'openai/gpt-4.1-mini',
    AITHEMA_OPENROUTER_PRICES: '{"openai/gpt-4.1-mini":{"prompt":0.000001,"completion":0.000002}}' });
  const reasoning = createOpenRouterReasoning({ binding: configured.reaction, prices: configured.prices,
    resolveSecret: () => 'fixture-secret', fetchImpl: async () => assert.fail('mapping must not dispatch reasoning') });
  const consent = createProcessingConsent({ storage, bindings: [configured.reaction, configured.understanding, binding], voiceConfigured: true });
  const presets = demoPresets({ provider: 'openrouter', reaction: configured.reaction, understanding: configured.understanding,
    voicePlugin: voice, voiceBinding: binding, policy: { endpoints: [configured.reaction.endpoint, binding.endpoint] } });
  const runtime = createPluginRuntime({ storage, reasoning, consent, presets, registry: new PluginRegistry().register(reasoning).register(voice) });
  const handlers = createHandlers({ storage, reasoning, consent, pluginRuntime: runtime }); t.after(() => handlers.close());
  const session = storage.create({ ownerToken: testToken, settings: { voice: 'elevenlabs', model: presets.best.choices.defaults.model } });
  const read = () => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`));
  const doc = await (await read()).json();
  assert.deepEqual(doc.features.voice, ['voice-elevenlabs', 'models-international']);
  const grant = items => { consent.grant({ sessionId: session.id, consentRevision: storage.get(session.id).consentRevision + 1, decision: { contract: doc.contract, items } }); storage.reviseConsent(session.id, true); };
  grant(['models-international', 'voice-elevenlabs']);
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, { method: 'POST',
    body: JSON.stringify({ granted: true, processing: { contract: doc.contract, items: ['models-international'] } }) }));
  assert.equal(response.status, 200); assert.equal(storage.get(session.id).consentWithdrawn, false);
  assert.deepEqual((await (await read()).json()).selected, ['models-international']);
  const matrix = await runtime.matrix(storage.get(session.id));
  assert.equal(matrix.best.voice.available, false); assert.equal(matrix.best.text.available, true);
  grant(['models-international', 'voice-elevenlabs']);
  const hiddenWithdrawal = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`, { method: 'POST',
    body: JSON.stringify({ granted: true, intent: 'settings-save', processing: { contract: doc.contract, items: ['voice-elevenlabs'] } }) }));
  assert.equal(hiddenWithdrawal.status, 409, 'the same server predicate requires explicit withdrawal when model consent is removed');
  assert.equal(storage.get(session.id).consentWithdrawn, false, 'the refused save has no side effects');
});

test('AIT-350: Grok adds its own consent item only when configured and covers parent/STT/TTS separately', async t => {
  const { binding } = await import('../../plugins/grok-voice/test/admission-fixtures.js');
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const parent = binding(), stt = binding('grok-voice-transcribe-2.0'), tts = binding('grok-voice-tts');
  const session = storage.create({ ownerToken: 'fixture' });
  const absent = createProcessingConsent({ storage, bindings: [] });
  assert.equal(absent.describe(session.id).items.some(item => item.id === 'voice-xai'), false);
  const consent = createProcessingConsent({ storage, bindings: [parent, stt, tts], grokConfigured: true });
  const doc = consent.describe(session.id);
  assert.deepEqual(doc.items.map(item => [item.id, item.version]), [['voice-xai', 1]]);
  assert.equal(consent.grant({ sessionId: session.id, consentRevision: session.consentRevision + 1,
    decision: { contract: doc.contract, items: ['voice-xai'] } }), true);
  storage.db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.consentRevision',?) WHERE id=?").run(session.consentRevision + 1, session.id);
  for (const [b, operation] of [[parent, 'start'], [stt, 'stream'], [tts, 'speak']]) {
    assert.equal(consent.coverage({ sessionId: session.id, consentRevision: session.consentRevision + 1, scope: processingScope(b, operation) }).covered, true);
  }
  assert.equal(consent.coverage({ sessionId: session.id, consentRevision: session.consentRevision + 1, scope: processingScope(stt, 'speak') }).covered, false);
});

test('AIT-365: staged consent describe reads next revision without publishing it to ordinary readers', () => {
  const storage = new SQLiteStorage();
  try {
    const binding = qualifyStartBinding({ plugin: 'openrouter', model: 'anthropic/claude-sonnet-4.6', accountRef: 'fixture', secretRef: 'fixture', endpoint: 'https://openrouter.ai/api/v1' });
    const session = storage.create(), consent = createProcessingConsent({ storage, bindings: [binding] });
    consent.grant({ sessionId: session.id, consentRevision: 1,
      decision: { contract: consent.describe().contract, items: ['models-international'] } });
    assert.deepEqual(consent.describe(session.id).selected, []);
    assert.deepEqual(consent.describe(session.id, { consentRevision: 1, granted: true }).selected, ['models-international']);
    assert.equal(storage.get(session.id).consentRevision, 0, 'document read cannot advance the journal');
    storage.reviseConsent(session.id, true);
    assert.deepEqual(consent.describe(session.id).selected, ['models-international']);
  } finally { storage.close(); }
});
