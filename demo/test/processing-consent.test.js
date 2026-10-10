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
      if (pathname === '/api/sessions' && init.method === 'POST') {
        session = createSession({ demo: true, locale: JSON.parse(init.body).locale });
        session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' } } };
        return Response.json(session);
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
      assert.ok(document.querySelector('#provider').textContent.includes(copy.host.voiceUnavailable.replace('{reason}', copy.reasons['agent-api'].replace('{status}', '403'))));
    };
    check(de);
    const locale = document.querySelector('#locale'); locale.value = 'en'; locale.dispatchEvent(new window.Event('change'));
    check(de);
    document.querySelector('#new').click();
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
