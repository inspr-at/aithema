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
