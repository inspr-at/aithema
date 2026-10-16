import { inputRevision } from './session.js';

/** IDs belong to one assessment, including replacements at the same input revision. */
export function openQuestionItems(session) {
  if (session.tombstone || session.consentWithdrawn || session.understanding.draft ||
    session.understanding.inputRevision !== inputRevision(session)) return [];
  return (session.understanding.openQuestions ?? []).map((question, index) => ({
    id: `q-${session.questionRevision ?? 0}-${index}`, question,
  }));
}

export function pendingQuestionFocus(session) {
  const focus = session.questionFocus;
  return focus?.chosenBy === 'user' && focus.inputRevision === inputRevision(session) &&
    openQuestionItems(session).some(item => item.id === focus.questionId && item.question === session.focusedQuestion) &&
    !session.transcript.some(turn => turn.role === 'assistant' && turn.focusRequestId === focus.requestId)
    ? focus : null;
}

/** Pure command decision. Ownership is checked by the server's transaction. */
export function focusQuestion(session, command, { inFlight = false } = {}) {
  const refused = reason => ({ error: 'focus-refused', reason });
  if (!command || typeof command.questionId !== 'string' || !/^q-\d+-\d+$/u.test(command.questionId) ||
    typeof command.inputRevision !== 'string') return refused('invalid-request');
  if (command.inputRevision !== inputRevision(session)) return refused('stale-revision');
  if (session.consentWithdrawn || session.tombstone) return refused('consent-required');
  if (session.paused || session.pauseReason === 'purpose') return refused('paused');
  if (inFlight) return refused('reply-in-flight');
  const item = openQuestionItems(session).find(item => item.id === command.questionId);
  if (!item) return refused('stale-question');
  return { type: 'question.focused', data: { question: item.question, questionId: item.id,
    chosenBy: 'user', inputRevision: command.inputRevision } };
}
