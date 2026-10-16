import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceTranscriptTransition as transition } from '../src/voice-transcript.js';

const identity = { callId: 'call', providerSessionId: 'provider' };
const partial = (text, n = 1) => ({ ...identity, type: 'partial', turnId: `provider:user:pending:${n}`, role: 'user', text, userTurnOrdinal: n });
const saved = { type: 'turn.final', data: { ...identity, id: 'provider:user:12', role: 'user', content: 'I need a webshop.', userTurnOrdinal: 1 } };
const final = { ...identity, type: 'final', role: 'user', turnId: saved.data.id, text: saved.data.content, userTurnOrdinal: 1 };
const begin = () => transition(undefined, partial('My words')).state;

test('AIT-235: hypotheses replace rather than append; a saved final promotes the same row key once', () => {
  const first = begin();
  const corrected = transition(first, partial('I need a webshop')).state;
  assert.equal(first.pending.content, 'My words', 'previous state is immutable');
  assert.equal(corrected.pending.content, 'I need a webshop');
  assert.equal(corrected.pending.id, first.pending.id);
  assert.equal(corrected.pending.partial, true);
  const result = transition(corrected, saved);
  assert.equal(result.state.pending, null);
  assert.deepEqual(result.replacement, { from: first.pending.id, to: saved.data.id });
  assert.equal(transition(result.state, saved).replacement, undefined, 'redelivery cannot promote another row');
  assert.equal(transition(result.state, partial('And a domain', 2)).state.pending.content, 'And a domain');
});

test('AIT-235: only a user final from the same call, provider and turn consumes its provisional text', () => {
  const state = begin();
  for (const changes of [{ callId: 'old-call' }, { providerSessionId: 'old-provider' },
    { callId: undefined, providerSessionId: undefined }, { userTurnOrdinal: 2 }]) {
    const result = transition(state, { ...saved, data: { ...saved.data, ...changes } });
    assert.equal(result.state.pending, state.pending);
    assert.equal(result.replacement, undefined);
  }
});

for (const first of [saved, final]) test(`AIT-235: late partials after ${first.type} cannot resurrect a row, even without an earlier partial`, () => {
  for (const state of [begin(), undefined]) {
    const completed = transition(state, first).state;
    const late = transition(completed, partial('Too late')).state;
    assert.equal(late.pending, completed.pending);
    assert.notEqual(late.pending?.partial, true);
  }
});

test('AIT-235: provider completion keeps final text in the provisional row until the saved turn arrives', () => {
  const state = begin(), completed = transition(state, final);
  assert.equal(completed.replacement, undefined);
  assert.equal(completed.state.pending.id, state.pending.id);
  assert.equal(completed.state.pending.content, final.text);
  assert.equal(completed.state.pending.partial, false);
  assert.equal(transition(completed.state, { type: 'speaking' }).state.pending, completed.state.pending);
  const attached = transition(completed.state, saved);
  assert.equal(attached.state.pending, null);
  assert.deepEqual(attached.replacement, { from: state.pending.id, to: saved.data.id });
});

for (const event of [{ type: 'speaking' }, { ...identity, type: 'final', role: 'assistant', turnId: 'reply', text: 'Reply' },
  { type: 'turn.final', data: { ...identity, id: 'reply', role: 'assistant', content: 'Reply' } }, { type: 'reset' }]) {
  test(`AIT-235: ${event.type}/${event.role ?? event.data?.role ?? ''} clears unfinished text and fences late delivery`, () => {
    const cleared = transition(begin(), event).state;
    assert.equal(cleared.pending, null);
    assert.equal(transition(cleared, partial('Late')).state.pending, null);
  });
}

test('AIT-235: empty hypotheses clear text; malformed and assistant partials are ignored', () => {
  const state = begin();
  assert.equal(transition(state, partial('  ')).state.pending, null);
  for (const changes of [{ role: 'assistant' }, { text: null }]) {
    assert.equal(transition(state, { ...partial('Malformed'), ...changes }).state.pending, state.pending);
  }
});

test('AIT-235: an older hypothesis or saved turn cannot replace the next utterance', () => {
  const state = transition(transition(begin(), saved).state, partial('Next utterance', 2)).state;
  assert.equal(transition(state, partial('Old', 1)).state.pending, state.pending);
  assert.equal(transition(state, saved).state.pending, state.pending);
  const restarted = transition(transition(state, { type: 'reset' }).state, { ...partial('Recovered', 1), providerSessionId: 'new-provider' }).state;
  assert.equal(restarted.pending.content, 'Recovered');
});

test('AIT-235: providers with stable turn ids also fence late partials without ordinals', () => {
  const event = { ...partial('My words'), turnId: 'stable', userTurnOrdinal: undefined };
  const state = transition(undefined, event).state;
  const result = transition(state, { ...final, turnId: 'stable', userTurnOrdinal: undefined }).state;
  assert.equal(transition(result, event).state.pending.partial, false);
});

test('AIT-235: a final for an older stable turn id cannot consume a newer hypothesis', () => {
  const state = transition(undefined, { ...partial('Next utterance'), turnId: 'next', userTurnOrdinal: undefined }).state;
  for (const event of [{ ...final, turnId: 'previous', userTurnOrdinal: undefined },
    { ...saved, data: { ...saved.data, id: 'previous', userTurnOrdinal: undefined } }]) {
    const result = transition(state, event);
    assert.equal(result.state.pending, state.pending);
    assert.equal(result.replacement, undefined);
  }
});
