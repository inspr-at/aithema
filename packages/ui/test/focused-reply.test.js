import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverFocusedReply } from '../src/focused-reply.js';

test('text focus stays in transcript; active voice uses the existing call speech port', async () => {
  const reply = { id: 'reply', role: 'assistant', content: 'Launch date?', focusRequestId: 'focus' }, calls = [];
  await deliverFocusedReply({ session: null }, reply);
  const rail = { output: true, paused: false, session: { speakReply: value => calls.push(value) } };
  await deliverFocusedReply(rail, reply);
  assert.deepEqual(calls, [{ turnId: 'reply', text: 'Launch date?' }]);
  await deliverFocusedReply({ ...rail, paused: true }, reply);
  await deliverFocusedReply({ ...rail, output: false }, reply);
  await deliverFocusedReply(rail, { ...reply, focusRequestId: undefined });
  assert.equal(calls.length, 1);
});
