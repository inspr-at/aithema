import { createConceptIntent, reduceConceptIntent } from './concept-intent.js';
import { PROCESSING_PRESETS } from './presets.js';
import { START_PRESET, capBuildReadiness, createPreset } from './understanding.js';
import { normalizeSettings, defaultSettings } from './settings.js';
import { withAITextOrigin } from './text-origin.js';
import { parseReply, normalizeQuestionCard } from './reply.js';
// An erased choice falls back to the core default preset, like createSession's default.
const ERASED_PRESET = 'best';
const erasedTurn = turn => Object.fromEntries(Object.entries(turn).filter(([key]) =>
  !['content', 'question_short', 'options', 'origin', 'model', 'provider', 'engine'].includes(key)));
export const inputRevision = session => `${session.inputRevision}:${session.conversationConsentRevision ?? session.consentRevision}:${session.withdrawalRevision}:${session.locale}:${session.sessionRevision ?? 0}:${Boolean(session.tombstone)}`;
export const activeTurns = session => session.transcript.filter(t => !t.erased && !t.withdrawn);
/** IDs belong to one assessment, including replacements at the same input revision. */
export function openQuestionItems(session) {
  if (session.tombstone || session.consentWithdrawn || session.understanding.draft ||
    session.understanding.inputRevision !== inputRevision(session)) return [];
  return (session.understanding.openQuestions ?? []).map((question, index) => ({
    id: `q-${session.questionRevision ?? 0}-${index}`, question,
  }));
}

function latestReply(session) {
  if (session.tombstone || session.consentWithdrawn) return null;
  const turn = activeTurns(session).at(-1);
  if (turn?.role !== 'assistant' || turn.inputRevision !== undefined && turn.inputRevision !== inputRevision(session)) return null;
  return turn;
}
export function currentQuestionCard(session) {
  const turn = latestReply(session);
  if (!turn || turn.inputRevision !== inputRevision(session)) return null;
  const card = normalizeQuestionCard(turn);
  return card ? { turnId: turn.id, ...card } : null;
}
/** Plain and spoken questions also qualify for the fold strip, even without answer choices. */
export function hasOpenReplyQuestion(session) {
  const turn = latestReply(session);
  return Boolean(turn && (parseReply(turn).question_short || /[?？]\s*$/u.test(turn.content ?? '')));
}
/** Durable: withdrawal and expiry mark turns but never remove their transcript entries. */
export const conversationStarted = session => session.transcript.length > 0 || (session.uploads?.length ?? 0) > 0;
export const emptyUnderstanding = session => ({ ...capBuildReadiness({}, [], session.preset), version: 1,
  inputRevision: null, locale: session.locale, draft: false, questionHistory: [] });
export function createSession({ id = crypto.randomUUID(), locale = 'en', identified = false, demo = false,
  preset = START_PRESET, actor = null, processingPreset = 'best', settings } = {}) {
  if (!PROCESSING_PRESETS.includes(processingPreset)) throw new TypeError('Unknown processing preset');
  if (!['en', 'de'].includes(locale)) throw new TypeError('Unsupported locale');
  return { id, version: 1, seq: 0, locale, identified, demo, preset: createPreset(preset), actor, processingPreset,
    settings: normalizeSettings(settings),
    inputRevision: 0, consentRevision: 0, withdrawalRevision: 0, sessionRevision: 0,
    paused: false, consentWithdrawn: false, tombstone: null, transcript: [], uploads: [], concepts: [],
    conceptIntent: createConceptIntent(), conceptStatus: { phase: 'idle' },
    understanding: { ...capBuildReadiness({}, [] , preset), origin: 'ai-generated', version: 1, inputRevision: null,
      locale, draft: false, questionHistory: [] } };
}
export function applyEvent(session, event) {
  const next = structuredClone(session);
  if (event.type === 'turn.final') {
    const data = event.data.role === 'assistant' && ('question_short' in event.data || 'options' in event.data)
      ? { ...event.data, ...parseReply(event.data) } : event.data;
    next.transcript.push(withAITextOrigin(data));
    if (event.data.role === 'user') next.inputRevision += 1;
  } else if (event.type === 'turn.annotated') {
    // Reply identity/ordering annotates transcript only, never operation state.
    next.transcript = next.transcript.map(turn => turn.id === event.data.id ? { ...turn, ...event.data } : turn);
  } else if (event.type === 'upload.state') {
    const upload = event.data;
    next.uploads = [...(next.uploads ?? []).filter(u => u.id !== upload.id),
      upload.erased || upload.withdrawn ? { id: upload.id, state: 'withdrawn', erased: true, withdrawn: true } : upload];
    next.inputRevision += 1;
    next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
    if (upload.state === 'withdrawn') {
      next.withdrawalRevision += 1; next.sessionRevision += 1;
      next.transcript = next.transcript.map(t => t.role === 'assistant'
        ? { ...erasedTurn(t), erased: true, withdrawn: true } : t);
      // Document-derived summaries can feed any concept. Revocation clears every
      // dependent projection atomically; a later lane rebuilds remaining inputs.
      next.concepts = [];
      next.conceptIntent = { ...next.conceptIntent, pending: null, referenceIds: [] };
      next.conceptStatus = { phase: 'idle' };
    }
  } else if (event.type === 'turn.corrected') {
    next.transcript = next.transcript.map(t => {
      if (t.id !== event.data.id) return t;
      // A heard prefix cannot inherit choices from an unheard question.
      const { question_short, options, ...prior } = t;
      return { ...prior, ...event.data, erased: Boolean(event.data.erased), withdrawn: Boolean(event.data.withdrawn) };
    });
    next.sessionRevision += 1; next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
  } else if (event.type === 'question.focused') {
    // Focus is derived from understanding, so it does not invalidate that input.
    next.focusedQuestion = event.data.erased ? null : event.data.question;
    next.questionFocus = !event.data.erased && event.data.chosenBy === 'user'
      ? { questionId: event.data.questionId, requestId: event.data.requestId,
        inputRevision: event.data.inputRevision, chosenBy: 'user' } : null;
  } else if (event.type === 'understanding.updated') {
    next.questionRevision = event.seq;
    next.understanding = event.data.erased ? emptyUnderstanding(next) : withAITextOrigin(event.data);
    next.actor = event.data.erased ? null : event.data.actor;
  } else if (event.type === 'session.locale-changed') {
    if (!['en', 'de'].includes(event.data.locale)) throw new TypeError('Unsupported locale');
    next.locale = event.data.locale;
    next.sessionRevision += 1;
    next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
  } else if (event.type === 'session.paused') {
    next.paused = event.data.paused;
    if (event.data.reason === 'purpose') next.pauseReason = 'purpose';
  } else if (event.type === 'identity.state') {
    next.identity = event.data.erased ? { erased: true } : event.data;
    // Retained transition metadata keeps revisions stable after address erasure.
    const identified = event.data.identified ?? (next.identity?.status === 'verified');
    if (identified !== next.identified) next.sessionRevision += 1;
    next.identified = identified;
  } else if (event.type === 'handover.state') {
    next.handover = event.data;
  } else if (event.type === 'credits.state') {
    next.credits = event.data;
  } else if (event.type === 'library.state') {
    next.library = event.data.erased ? null : event.data;
  } else if (['verification.requested', 'identity.unlocked', 'identity.policy-changed', 'identity.resend-blocked', 'handover.limit-reached',
    'credits.limit-reached', 'conversation.end-requested'].includes(event.type)) {
    // Notifications accompany their durable state projection.
  } else if (event.type === 'settings.changed') {
    // A processing choice is metadata: completed replies and understanding stay
    // cached for their input revision; in-flight work is superseded by the host.
    // An erased choice replays as the host default, like other erased content.
    if (event.data.erased) { next.settings = defaultSettings(); next.processingPreset = ERASED_PRESET; }
    else {
      if (!PROCESSING_PRESETS.includes(event.data.processingPreset)) throw new TypeError('Unknown processing preset');
      next.processingPreset = event.data.processingPreset;
      next.settings = normalizeSettings(event.data.settings);
    }
  } else if (['turn.withdrawn', 'session.erased', 'consent.revised'].includes(event.type)) {
    const conversationUnchanged = event.type === 'consent.revised' && event.data.granted &&
      event.data.conversationUnchanged === true && !session.consentWithdrawn;
    if (!conversationUnchanged) {
      next.sessionRevision += 1;
      next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
    }
    if (event.type === 'consent.revised') {
      next.consentRevision += 1; next.consentWithdrawn = !event.data.granted;
      // The ledger revision always advances; draft-only edits keep the input
      // identity of unaffected replies, assessments and live voice processing.
      if (conversationUnchanged) next.conversationConsentRevision = session.conversationConsentRevision ?? session.consentRevision;
      else {
        if (next.conversationConsentRevision !== undefined) next.conversationConsentRevision = next.consentRevision;
        next.transcript = next.transcript.map(t => t.role === 'assistant'
          ? { ...erasedTurn(t), erased: true } : t);
      }
    } else {
      next.withdrawalRevision += 1;
      next.transcript = next.transcript.map(t => t.id === event.data.turnId || t.role === 'assistant' || event.type === 'session.erased'
        ? { ...erasedTurn(t), erased: true, withdrawn: true } : t);
      // Erasure also forgets the visitor's processing choice, so it never seeds another conversation.
      if (event.type === 'session.erased') { next.tombstone = event.data.at; next.settings = defaultSettings(); next.processingPreset = ERASED_PRESET;
        next.identity = null; next.handover = null; next.credits = null; next.library = null; next.identified = false;
        next.uploads = (next.uploads ?? []).map(u => ({ id: u.id, state: 'withdrawn', erased: true, withdrawn: true })); }
    }
  } else if (event.type === 'concept.state') {
    next.conceptIntent = event.data.intent;
    next.conceptStatus = event.data.status;
    if (event.data.artifact && !event.data.artifact.erased) next.concepts = [...(next.concepts ?? []), event.data.artifact];
  } else if (event.type === 'concept.feedback') {
    next.concepts = (next.concepts ?? []).map(c => c.id === event.data.artifactId ? { ...c, archived: event.data.archived ?? c.archived, feedback: event.data.erased ? null : event.data } : c);
  } else if (event.type === 'concept.archived') {
    next.concepts = (next.concepts ?? []).map(c => c.id === event.data.artifactId ? { ...c, archived: true } : c);
  } else if (event.type !== 'session.created') throw new TypeError('Unknown durable event');
  if (next.focusedQuestion === null) next.questionFocus = null;
  if (['turn.withdrawn', 'session.erased', 'consent.revised'].includes(event.type)) {
    const all = event.type === 'session.erased' || event.type === 'consent.revised' && !event.data.granted;
    next.concepts = (next.concepts ?? []).filter(c => !all && !c.turnIds.includes(event.data.turnId));
    let intent = next.conceptIntent ?? createConceptIntent();
    if (all) {
      intent = reduceConceptIntent(intent, { type: 'consent', covered: false, revision: next.consentRevision, now: Date.parse(event.at ?? event.data.at) || 0 });
      intent = { ...intent, pending: null, referenceIds: [], turnIds: event.type === 'session.erased' ? [] : intent.turnIds };
      next.conceptStatus = { phase: 'idle' };
    } else if (event.type === 'turn.withdrawn') {
      intent = reduceConceptIntent(intent, { type: 'source-removed', source: 'turn', id: event.data.turnId, now: Date.parse(event.at ?? event.data.at) || 0 });
      if (intent.pending?.turnIds.includes(event.data.turnId)) { intent = { ...intent, pending: null }; next.conceptStatus = { phase: 'failed', error: 'source-removed', retryable: false }; }
    }
    if (all || event.type === 'turn.withdrawn' && event.data.reason === 'expiry') {
      intent = reduceConceptIntent(intent, { type: 'conversation-ended', now: Date.parse(event.at ?? event.data.at) || 0 });
    }
    next.conceptIntent = intent;
  }
  next.seq = event.seq;
  // Snapshot-only convenience data must never retain stale or withdrawn text.
  if ('openQuestionItems' in next) next.openQuestionItems = openQuestionItems(next);
  return next;
}
