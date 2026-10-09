import { PROCESSING_PRESETS } from './presets.js';
import { START_PRESET, capBuildReadiness, createPreset } from './understanding.js';
export const inputRevision = session => `${session.inputRevision}:${session.consentRevision}:${session.withdrawalRevision}:${session.locale}`;
export function createSession({ id = crypto.randomUUID(), locale = 'en', identified = false, demo = false,
  preset = START_PRESET, actor = null, processingPreset = 'best' } = {}) {
  if (!PROCESSING_PRESETS.includes(processingPreset)) throw new TypeError('Unknown processing preset');
  if (!['en', 'de'].includes(locale)) throw new TypeError('Unsupported locale');
  return { id, version: 1, seq: 0, locale, identified, demo, preset: createPreset(preset), actor, processingPreset,
    inputRevision: 0, consentRevision: 0, withdrawalRevision: 0, transcript: [],
    understanding: { ...capBuildReadiness({}, [] , preset), version: 1, inputRevision: null,
      locale, draft: false, questionHistory: [] } };
}
export function applyEvent(session, event) {
  const next = structuredClone(session);
  if (event.type === 'turn.final') {
    next.transcript.push(event.data);
    if (event.data.role === 'user') next.inputRevision += 1;
  } else if (event.type === 'understanding.updated') {
    next.understanding = event.data;
    next.actor = event.data.actor;
  } else if (event.type !== 'session.created') throw new TypeError('Unknown durable event');
  next.seq = event.seq;
  return next;
}
