import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '@inspr/aithema-server';
import { inputRevision } from '@inspr/aithema-core';
import { createProcessingConsent, qualifyStartBinding } from '../processing-consent.js';

test('AIT-510: separate optional image-input consent preserves existing replies on grant and withdrawal', t => {
  const now = () => 1_800_000_000_000, storage = new SQLiteStorage(':memory:', { now }); t.after(() => storage.close());
  const binding = qualifyStartBinding({ plugin: 'openrouter', model: 'anthropic/fixture', imageInput: { maxImages: 4, maxTokensPerImage: 1600 } }, now());
  const consent = createProcessingConsent({ storage, bindings: [binding], now });
  const session = storage.create(), doc = consent.describe(session.id);
  assert.ok(doc.items.some(item => item.id === 'image-input'));
  assert.ok(doc.optional.includes('image-input'));
  assert.equal(doc.items.find(item => item.id === 'models-international').version, 1);
  const grant = items => {
    const decision = { contract: doc.contract, items };
    const conversationUnchanged = consent.conversationUnchanged({ sessionId: session.id, decision });
    consent.grant({ sessionId: session.id, consentRevision: storage.get(session.id).consentRevision + 1, decision });
    storage.reviseConsent(session.id, true, {}, { conversationUnchanged });
  };
  grant(['models-international']);
  storage.append(session.id, 'turn.final', { id: 'reply', role: 'assistant', content: 'Retained answer', at: new Date(now()).toISOString() });
  const revision = inputRevision(storage.get(session.id));
  grant(['models-international', 'image-input']);
  assert.equal(inputRevision(storage.get(session.id)), revision);
  assert.equal(storage.get(session.id).transcript[0].content, 'Retained answer');
  grant(['models-international']);
  assert.equal(inputRevision(storage.get(session.id)), revision);
  assert.equal(storage.get(session.id).transcript[0].content, 'Retained answer');
});
