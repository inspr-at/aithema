import { PROCESSING_PRESETS } from './presets.js';
import { START_PRESET, capBuildReadiness, createPreset } from './understanding.js';
export const inputRevision = session => `${session.inputRevision}:${session.consentRevision}:${session.withdrawalRevision}:${session.locale}:${session.sessionRevision ?? 0}:${Boolean(session.tombstone)}`;
export const activeTurns = session => session.transcript.filter(t => !t.erased && !t.withdrawn);
export const emptyUnderstanding = session => ({ ...capBuildReadiness({}, [], session.preset), version: 1,
  inputRevision: null, locale: session.locale, draft: false, questionHistory: [] });
export function createSession({ id = crypto.randomUUID(), locale = 'en', identified = false, demo = false,
  preset = START_PRESET, actor = null, processingPreset = 'best' } = {}) {
  if (!PROCESSING_PRESETS.includes(processingPreset)) throw new TypeError('Unknown processing preset');
  if (!['en', 'de'].includes(locale)) throw new TypeError('Unsupported locale');
  return { id, version: 1, seq: 0, locale, identified, demo, preset: createPreset(preset), actor, processingPreset,
    inputRevision: 0, consentRevision: 0, withdrawalRevision: 0, sessionRevision: 0,
    paused: false, consentWithdrawn: false, tombstone: null, transcript: [],
    understanding: { ...capBuildReadiness({}, [] , preset), version: 1, inputRevision: null,
      locale, draft: false, questionHistory: [] } };
}
export function applyEvent(session, event) {
  const next = structuredClone(session);
  if (event.type === 'turn.final') {
    next.transcript.push(event.data);
    if (event.data.role === 'user') next.inputRevision += 1;
  } else if (event.type === 'turn.corrected') {
    next.transcript = next.transcript.map(t => t.id === event.data.id ? { ...t, ...event.data, erased: Boolean(event.data.erased), withdrawn: Boolean(event.data.withdrawn) } : t);
    next.sessionRevision += 1; next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
  } else if (event.type === 'question.focused') {
    next.focusedQuestion = event.data.erased ? null : event.data.question;
    next.sessionRevision += 1;
  } else if (event.type === 'understanding.updated') {
    next.understanding = event.data.erased ? emptyUnderstanding(next) : event.data;
    next.actor = event.data.erased ? null : event.data.actor;
  } else if (event.type === 'session.paused') {
    next.paused = event.data.paused;
  } else if (['turn.withdrawn', 'session.erased', 'consent.revised'].includes(event.type)) {
    next.sessionRevision += 1;
    next.understanding = emptyUnderstanding(next); next.actor = null; next.focusedQuestion = null;
    if (event.type === 'consent.revised') {
      next.consentRevision += 1; next.consentWithdrawn = !event.data.granted;
      next.transcript = next.transcript.map(t => t.role === 'assistant'
        ? { ...Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'content')), erased: true } : t);
    } else {
      next.withdrawalRevision += 1;
      next.transcript = next.transcript.map(t => t.id === event.data.turnId || t.role === 'assistant' || event.type === 'session.erased'
        ? { ...Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'content')), erased: true, withdrawn: true } : t);
      if (event.type === 'session.erased') next.tombstone = event.data.at;
    }
  } else if (event.type !== 'session.created') throw new TypeError('Unknown durable event');
  next.seq = event.seq;
  return next;
}
