// Behaviour port from START generated-ui.ts, generated-ui-idle.ts and
// generated-ui/index.ts:285. Pure metadata policy; the host owns time, durable
// input/intent recording, authoritative consent, admission and artifact bytes.
export const DEFAULT_CONCEPT_POLICY = Object.freeze({ thresholds: Object.freeze([25, 40, 72]), idleMs: 120_000,
  refreshTurns: 2, historyMax: 1000 });
function policyFor(policy) {
  const p = { ...DEFAULT_CONCEPT_POLICY, ...policy };
  if (!Array.isArray(p.thresholds) || p.thresholds.length !== 3 ||
    p.thresholds.some((n, i) => !Number.isFinite(n) || n < 0 || n > 100 || i > 0 && n <= p.thresholds[i - 1]) ||
    !['idleMs', 'refreshTurns', 'historyMax'].every(k => Number.isSafeInteger(p[k]) && p[k] >= (k === 'idleMs' ? 0 : 1))) {
    throw new TypeError('Invalid concept policy');
  }
  return p;
}
export function progressTrigger(progress, policy) {
  const { thresholds } = policyFor(policy);
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return progress >= thresholds[2] ? 'late' : progress >= thresholds[1] ? 'midpoint' : progress >= thresholds[0] ? 'early' : null;
}
export function createConceptIntent({ now = 0, consentRevision = 0, consented = false } = {}) {
  return { inputRevision: null, turnIds: [], referenceIds: [], visualIntent: null, armed: null,
    lastActivityAt: now, paused: false, eligible: true, consented, consentRevision,
    invalidation: 0, attemptedRevisions: [], lastAttempt: null, pending: null, history: [] };
}
const containsSources = (state, job) => job.turnIds.every(id => state.turnIds.includes(id)) &&
  job.referenceIds.every(id => state.referenceIds.includes(id));
export function conceptResultDisposition(state, job, policy) {
  if (!state.consented || state.consentRevision !== job.consentRevision || state.invalidation !== job.invalidation ||
    !containsSources(state, job)) return { kind: 'reject', reason: 'state-changed' };
  if (state.history.some(item => item.inputRevision === job.inputRevision)) return { kind: 'reject', reason: 'duplicate' };
  if (state.history.length >= policyFor(policy).historyMax) return { kind: 'reject', reason: 'limit' };
  return { kind: state.inputRevision === job.inputRevision ? 'current' : 'history' };
}
export function planConceptIntent(state, { trigger = 'progress', now } = {}, policy) {
  const p = policyFor(policy), skip = reason => ({ kind: 'skip', reason });
  if (!Number.isFinite(now)) throw new TypeError('Concept planning requires host time');
  if (!['progress', 'idle', 'manual'].includes(trigger)) return skip('not-requested');
  if (!state.visualIntent) return skip('not-requested');
  if (!state.consented) return skip('consent');
  if (state.paused) return skip('paused');
  if (!state.eligible) return skip('ineligible');
  if (state.pending) return skip('busy');
  if (!state.turnIds.length || state.inputRevision === null) return skip('empty');
  if (state.attemptedRevisions.includes(state.inputRevision)) return skip('duplicate');
  if (state.history.length >= p.historyMax) return skip('limit');
  const latest = state.lastAttempt ?? state.history.at(-1);
  if (trigger === 'idle' && now - Math.max(state.lastActivityAt, state.history.at(-1)?.createdAt ?? 0) < p.idleMs) return skip('not-idle');
  const milestone = trigger === 'manual' ? 'manual' : state.armed ?? (trigger === 'idle' ? 'early' : null);
  if (!milestone) return skip('before-threshold');
  // Time, assistant replies, assessment changes and source removal never earn a refresh.
  const newTurns = latest ? state.turnIds.filter(id => !latest.turnIds.includes(id)).length : state.turnIds.length;
  const newReference = latest && state.referenceIds.some(id => !latest.referenceIds.includes(id));
  if (trigger === 'idle' && latest && newTurns < 1) return skip('milestone-complete');
  const newVisualIntent = latest && state.visualIntent.id !== latest.intentId;
  if (trigger === 'progress' && latest && (newTurns < 1 && !newReference ||
    latest.trigger === milestone && !newReference && !newVisualIntent && newTurns < p.refreshTurns)) return skip('milestone-complete');
  return { kind: 'generate', plan: { inputRevision: state.inputRevision, trigger: milestone,
    intentId: state.visualIntent.id, turnIds: [...state.turnIds], referenceIds: [...state.referenceIds],
    consentRevision: state.consentRevision, invalidation: state.invalidation } };
}
/** Every event is a durable host fact. UI visibility and call termination are inert. */
export function reduceConceptIntent(state, event, policy) {
  const p = policyFor(policy);
  if (!Number.isFinite(event.now)) throw new TypeError('Concept events require host time');
  switch (event.type) {
    case 'input-recorded': {
      if (typeof event.revision !== 'string' || !event.revision ||
        ![event.turnIds, event.referenceIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length)) {
        throw new TypeError('Invalid recorded concept input');
      }
      const next = { ...state, inputRevision: event.revision, turnIds: [...event.turnIds], referenceIds: [...event.referenceIds],
        lastActivityAt: event.now };
      const removed = !containsSources(next, state);
      return removed ? { ...next, visualIntent: null, invalidation: state.invalidation + 1,
        history: state.history.filter(item => containsSources(next, item)) } : next;
    }
    case 'intent-recorded':
      if (!state.consented || typeof event.id !== 'string' || !event.id || !state.turnIds.includes(event.sourceTurnId)) return state;
      return { ...state, visualIntent: { id: event.id, sourceTurnId: event.sourceTurnId }, lastActivityAt: event.now };
    case 'readiness': return { ...state, armed: progressTrigger(event.percent, p) };
    case 'activity': return { ...state, lastActivityAt: event.now };
    case 'eligibility': return { ...state, eligible: event.eligible === true, lastActivityAt: event.now };
    case 'pause': return { ...state, paused: event.paused === true, lastActivityAt: event.now };
    case 'consent': {
      if (!Number.isSafeInteger(event.revision) || event.revision < state.consentRevision) throw new TypeError('Invalid consent revision');
      const changed = event.revision !== state.consentRevision || event.covered !== state.consented;
      return { ...state, consented: event.covered === true, consentRevision: event.revision,
        visualIntent: changed ? null : state.visualIntent, invalidation: state.invalidation + (changed ? 1 : 0),
        history: changed ? [] : state.history, lastActivityAt: event.now };
    }
    case 'source-removed': {
      const next = { ...state, turnIds: state.turnIds.filter(id => id !== event.id), referenceIds: state.referenceIds.filter(id => id !== event.id),
        visualIntent: null, invalidation: state.invalidation + 1, lastActivityAt: event.now };
      return { ...next, history: state.history.filter(item => containsSources(next, item)) };
    }
    case 'request': {
      if (typeof event.id !== 'string' || !event.id) throw new TypeError('Concept request requires id');
      const decision = planConceptIntent(state, { trigger: event.trigger, now: event.now }, p);
      if (decision.kind !== 'generate') return state;
      const job = { id: event.id, ...decision.plan };
      return { ...state, pending: job, lastAttempt: job, attemptedRevisions: [...state.attemptedRevisions, state.inputRevision] };
    }
    case 'render-failed': return state.pending?.id === event.id ? { ...state, pending: null, lastActivityAt: event.now } : state;
    case 'render-completed': {
      if (state.pending?.id !== event.id) return state;
      if (typeof event.artifactId !== 'string' || !event.artifactId) throw new TypeError('Concept completion requires persisted artifact id');
      const disposition = conceptResultDisposition(state, state.pending, p);
      return { ...state, pending: null, lastActivityAt: event.now, history: disposition.kind === 'reject' ? state.history :
        [...state.history, { ...state.pending, artifactId: event.artifactId, createdAt: event.now }] };
    }
    case 'viewer-open': case 'conversation-ended': return state;
    default: throw new TypeError('Unknown concept event');
  }
}
