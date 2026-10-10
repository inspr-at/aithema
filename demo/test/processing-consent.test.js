import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processingScope } from '@inspr/aithema-core';
import { SQLiteStorage } from '@inspr/aithema-server';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL, createProcessingConsent, qualifyStartBinding } from '../processing-consent.js';
import { openRouterConfig } from '../openrouter-config.js';

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
