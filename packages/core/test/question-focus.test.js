import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, applyEvent, inputRevision, openQuestionItems, focusQuestion, pendingQuestionFocus } from '../src/index.js';

function assessed() {
  let session = createSession();
  session = applyEvent(session, { seq: 1, type: 'turn.final', data: { id: 'person', role: 'user', content: 'A website' } });
  return applyEvent(session, { seq: 2, type: 'understanding.updated', data: { ...session.understanding,
    inputRevision: inputRevision(session), openQuestions: ['Audience?', 'Launch date?'], draft: false } });
}
test('focus is a reducer command with assessment-bound IDs and no synthetic person turn', () => {
  const session = assessed(), second = openQuestionItems(session)[1];
  const event = focusQuestion(session, { questionId: second.id, inputRevision: inputRevision(session) });
  const next = applyEvent(session, { ...event, seq: 3, data: { ...event.data, requestId: 'selected' } });
  assert.equal(next.focusedQuestion, second.question); assert.equal(next.questionFocus.chosenBy, 'user');
  assert.deepEqual(next.transcript, session.transcript); assert.equal(inputRevision(next), inputRevision(session));
  assert.equal(pendingQuestionFocus(next).requestId, 'selected');
  const answered = applyEvent(next, { seq: 4, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: second.question, focusRequestId: 'selected' } });
  assert.equal(pendingQuestionFocus(answered), null);
});
test('replacement at the same input revision invalidates old question IDs', () => {
  const before = assessed(), id = openQuestionItems(before)[1].id;
  const after = applyEvent(before, { seq: 3, type: 'understanding.updated', data: { ...before.understanding, openQuestions: ['Audience?', 'Budget?'] } });
  assert.equal(inputRevision(after), inputRevision(before));
  assert.equal(focusQuestion(after, { questionId: id, inputRevision: inputRevision(after) }).reason, 'stale-question');
});
for (const type of ['turn.withdrawn', 'consent.revised', 'session.erased', 'session.locale-changed']) test(`${type} clears selected focus`, () => {
  const session = assessed(), command = focusQuestion(session, { questionId: openQuestionItems(session)[1].id, inputRevision: inputRevision(session) });
  const chosen = applyEvent(session, { ...command, seq: 3, data: { ...command.data, requestId: 'selected' } });
  const next = applyEvent(chosen, { seq: 4, type, data: { turnId: 'person', granted: false, locale: 'de', at: '2026-10-16T00:00:00Z' } });
  assert.equal(next.questionFocus, null); assert.equal(next.focusedQuestion, null); assert.deepEqual(openQuestionItems(next), []);
});

test('a selected public question is not classified as leaked private host guidance', async () => {
  const { reasoningRequest, unsafeReplyOutput } = await import('../src/index.js');
  const { purposePolicy } = await import('../../../test/safeguards-corpus.js');
  const question = 'Which of the regional teams should own the first launch and which date works best for that team?';
  const request = reasoningRequest(assessed(), 'reaction', false, '', { focusQuestion: question, purposePolicy });
  assert.ok(request.system.includes(question));
  assert.equal(unsafeReplyOutput(JSON.stringify({ content: question, question_short: question, options: [], scope: 'in' }),
    request.purposePolicy, request.hiddenGuidance), false);
});

test('focus command instructions are private while the selected question remains public', async () => {
  const { reasoningRequest, unsafeReplyOutput } = await import('../src/index.js');
  const { purposePolicy } = await import('../../../test/safeguards-corpus.js');
  const request = reasoningRequest(assessed(), 'reaction', false, '', { focusQuestion: 'Launch date?', purposePolicy });
  const instruction = 'Address that point in this reply and ask its one unresolved question naturally.';
  assert.ok(request.system.includes(instruction));
  for (const field of ['content', 'question_short', 'options']) {
    const reply = { content: 'Launch date?', question_short: null, options: [], scope: 'in',
      [field]: field === 'options' ? [{ text: instruction }] : instruction };
    assert.equal(unsafeReplyOutput(reply, request.purposePolicy, request.hiddenGuidance), true, field);
  }
});

test('snapshot question items follow SSE assessment replacement and erase on withdrawal', () => {
  const initial = assessed(); initial.openQuestionItems = openQuestionItems(initial);
  const replaced = applyEvent(initial, { seq: 3, type: 'understanding.updated', data: { ...initial.understanding, openQuestions: ['Budget?'] } });
  assert.deepEqual(replaced.openQuestionItems, openQuestionItems(replaced));
  assert.equal(replaced.openQuestionItems[0].question, 'Budget?');
  const withdrawn = applyEvent(replaced, { seq: 4, type: 'turn.withdrawn', data: { turnId: 'person' } });
  assert.deepEqual(withdrawn.openQuestionItems, []);
});

for (const [reason, expected] of [
  ['admission deadline', 'retryable'], ['budget reconciling', 'wait'], ['plugin unhealthy', 'retryable'],
  ['consent port unavailable', 'retryable'], ['reply-in-flight', 'wait'],
  ['budget denied', 'terminal'], ['session', 'terminal'], ['one-hour', 'terminal'], ['host-limit', 'terminal'],
  ['consent-required', 'actionable'], ['current processing consent required', 'actionable'], ['paused', 'actionable'],
  ['invalid-request', 'terminal'],
]) test(`AIT-503 focus refusal classification: ${reason}`, async () => {
  const core = await import('../src/question-focus.js');
  assert.equal(typeof core.classifyFocusRefusal, 'function');
  const error = ['reply-in-flight', 'consent-required'].includes(reason) ? { reason } : { reason: 'not-admitted', admissionReason: reason };
  assert.equal(core.classifyFocusRefusal(error), expected);
});

test('AIT-503 unknown focus refusals are terminal and cannot inherit object properties', async () => {
  const core = await import('../src/question-focus.js');
  assert.equal(typeof core.classifyFocusRefusal, 'function');
  for (const reason of [null, undefined, 'unknown', 'constructor', '__proto__']) {
    assert.equal(core.classifyFocusRefusal({ reason }), 'terminal');
  }
  assert.equal(core.classifyFocusRefusal({ reason: 'consent-required', admissionReason: 'unknown' }), 'actionable');
});

test('AIT-503 malformed-command error without a reason is terminal', async () => {
  const core = await import('../src/question-focus.js');
  assert.equal(core.classifyFocusRefusal({ status: 400, error: 'invalid-request' }), 'terminal');
  assert.equal(core.classifyFocusRefusal({ error: 'reasoning-unavailable' }), 'terminal', 'opaque failure codes never imply a safe retry');
});

test('AIT-503 refusal classifier remains internal in RC24', async () => {
  const core = await import('../src/index.js');
  assert.equal(core.classifyFocusRefusal, undefined);
  assert.equal(core.FOCUS_REFUSAL_CLASSES, undefined);
});
for (const error of [{ reason: 'network' }, { status: 503 }, { status: 500 }, { name: 'TypeError' }]) test(`AIT-503 retryable transport ${JSON.stringify(error)}`, async () => {
  const { classifyFocusRefusal } = await import('../src/question-focus.js');
  assert.equal(classifyFocusRefusal(error), 'retryable');
});
