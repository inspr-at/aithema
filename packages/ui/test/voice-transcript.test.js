import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceTranscriptTransition as transition } from '../src/voice-transcript.js';

const identity = { callId: 'call', providerSessionId: 'provider' };
const partial = text => ({ ...identity, type: 'partial', turnId: 'provider:user:pending', role: 'user', text });
const saved = { type: 'turn.final', data: { ...identity, id: 'provider:user:12', role: 'user', content: 'I need a webshop.' } };

test('AIT-235: hypotheses replace rather than append; a saved final promotes the same row key once', () => {
  const first = transition(null, partial('I need a website')).pending;
  const corrected = transition(first, partial('I need a webshop')).pending;
  assert.equal(first.content, 'I need a website', 'previous state is immutable');
  assert.equal(corrected.content, 'I need a webshop');
  assert.equal(corrected.id, first.id);
  assert.equal(corrected.partial, true);
  const result = transition(corrected, saved);
  assert.deepEqual(result, { pending: null, replacement: { from: first.id, to: saved.data.id } });
  assert.deepEqual(transition(result.pending, saved), { pending: null }, 'redelivery cannot promote another row');
  const next = transition(result.pending, partial('And a domain')).pending;
  assert.equal(next.content, 'And a domain');
});

test('AIT-235: only a user final from the same call and provider consumes its provisional text', () => {
  const pending = transition(null, partial('My words')).pending;
  for (const changes of [{ role: 'assistant' }, { callId: 'old-call' }, { providerSessionId: 'old-provider' },
    { callId: undefined, providerSessionId: undefined }]) {
    assert.deepEqual(transition(pending, { ...saved, data: { ...saved.data, ...changes } }), { pending });
  }
  assert.deepEqual(transition(pending, { ...identity, type: 'final', role: 'user', turnId: saved.data.id, text: saved.data.content }),
    { pending: null, replacement: { from: pending.id, to: saved.data.id } }, 'a persisted typed echo also clears the hypothesis');
});

test('AIT-235: empty hypotheses and lifecycle reset discard text without manufacturing a final', () => {
  const pending = transition(null, partial('Unfinished')).pending;
  assert.deepEqual(transition(pending, partial('  ')), { pending: null });
  assert.deepEqual(transition(pending, { type: 'reset' }), { pending: null });
  assert.deepEqual(transition(pending, { ...partial('Agent text'), role: 'assistant' }), { pending });
  assert.deepEqual(transition(pending, { ...partial('Malformed'), text: null }), { pending });
});
