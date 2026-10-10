import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { createSession, applyEvent, processingScope } from '@inspr/aithema-core';
import { SQLiteStorage } from '@inspr/aithema-server';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL, createProcessingConsent, qualifyStartBinding } from '../processing-consent.js';
import { openRouterConfig } from '../openrouter-config.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { START_GERMAN_CONSENT } from '../../test/fixtures/german-server-texts.js';

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

test('processing consent follows the conversation language, keeps unknown legal copy and sends stable ids', async () => {
  const window = new Window({ url: 'http://localhost/' });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'navigator', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const unknown = { id: 'future-host-item', title: '<b>Host legal title</b>', recipients: 'Host recipient', text: 'Host legal text' };
  const processingConsent = { contract: 'fixture-contract', intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL,
    items: [...CONSENT_ITEMS, unknown] };
  const posts = [];
  let session;
  try {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys.filter(key => key !== 'fetch')) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
    localStorage.setItem('aithema-demo-locale', 'de');
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(url, window.location.href).pathname;
      if (pathname === '/demo/config') return Response.json({ processingConsent, voiceMode: 'off',
        voiceDisabledReason: 'agent-api-get-403', label: '', imageLabel: '' });
      if (pathname === '/api/sessions' && init.method === 'POST') {
        session = createSession({ demo: true, locale: JSON.parse(init.body).locale });
        session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' } } };
        return Response.json(session);
      }
      if (pathname.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (pathname.endsWith('/consent')) {
        if (init.method !== 'POST') return Response.json({ selected: ['voice-elevenlabs'] });
        const body = JSON.parse(init.body); posts.push(body);
        const event = { seq: session.seq + 1, type: 'consent.revised', data: { granted: body.granted } };
        session = applyEvent(session, event);
        return Response.json({ event });
      }
      if (pathname === `/api/sessions/${session.id}`) return Response.json(session);
      throw new Error(`Unexpected fixture request: ${pathname}`);
    };
    await import('../host.js');
    const wait = async predicate => {
      for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('Host did not finish repainting consent');
    };
    const checkCopy = bundle => {
      assert.equal(document.querySelector('#error').textContent, '');
      assert.equal(document.querySelector('#consent-text').textContent, `${bundle.intro} ${bundle.withdrawal}`);
      const inputs = [...document.querySelectorAll('#processing-items input')];
      assert.deepEqual(inputs.map(input => input.value), processingConsent.items.map(item => item.id));
      for (const input of inputs) {
        const item = bundle.items[input.value] ?? unknown;
        assert.equal(input.parentElement.querySelector('span').textContent, item.title);
        assert.equal(input.parentElement.nextElementSibling.textContent, `${item.recipients} ${item.text}`);
      }
      assert.equal(document.querySelector('#processing-items b'), null, 'unknown legal copy remains text');
      assert.equal(inputs[1].checked, true, 'repainting preserves the current selection');
    };
    checkCopy(START_GERMAN_CONSENT);
    assert.match(document.querySelector('#provider').textContent, /Anfrage an den Sprachanbieter fehlgeschlagen \(HTTP 403\)/u);
    document.querySelector('#grant').click();
    await wait(() => !document.querySelector('#grant').disabled);
    assert.deepEqual(posts, [{ granted: true, processing: { contract: 'fixture-contract', items: ['voice-elevenlabs'] } }]);
    const locale = document.querySelector('#locale');
    locale.value = 'en'; locale.dispatchEvent(new window.Event('change'));
    checkCopy(START_GERMAN_CONSENT);
    const previousId = document.querySelector('aithema-session').session.id;
    document.querySelector('#new').click();
    await wait(() => document.documentElement.lang === 'en' && document.querySelector('aithema-session').session.id !== previousId);
    checkCopy(en.processingConsent);
    assert.match(document.querySelector('#provider').textContent, /Voice provider request failed \(HTTP 403\)/u);
    assert.equal(de.processingConsent.items['future-host-item'], undefined);
  } finally {
    document.querySelector('aithema-session')?.remove();
    await window.happyDOM.close();
    for (const key of keys) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]); else delete globalThis[key];
    }
  }
});
