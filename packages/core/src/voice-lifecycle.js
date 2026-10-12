/** Call authority is independent of append-only transcript and assessment revisions. */
export const voiceAuthorizationRevision = session => JSON.stringify([
  session.ownerHash ?? null, session.conversationConsentRevision ?? session.consentRevision,
  session.withdrawalRevision, session.settings?.revision ?? 0, session.processingPreset ?? 'best',
  session.settings?.model ?? null, session.settings?.effort ?? null, session.settings?.voice ?? null,
  session.locale, Boolean(session.consentWithdrawn), Boolean(session.tombstone),
]);

export const VOICE_LIFECYCLE_STATES = Object.freeze(['idle', 'connecting', 'active', 'paused', 'recovering', 'waiting', 'ended']);
// SDK close codes/reasons are diagnostics. Only explicit intent is terminal.
export const recoverableVoiceEnd = reason => ['transport-lost', 'recovery-failed', 'browser-liveness-deadline',
  'server-restart', 'server-stopping'].includes(reason);

export function createVoiceLifecycle(callId) {
  if (typeof callId !== 'string' || !callId) throw new TypeError('Logical voice call identity required');
  return { callId, state: 'idle', holds: [], epoch: 0, providerGeneration: 0, providerSessionId: null,
    authorizationRevision: null, spendDeadlineAt: null, browserLivenessDeadlineAt: null,
    needsRecovery: false, attempts: 0, segments: {}, checkpoint: {
      acceptedTurnIds: [], operationId: null, tentative: false, tentativeSequence: 0, userUnconfirmed: false,
      replyId: null, heardPrefix: null, deliveryUncertain: false,
    } };
}

/** Pure browser/server policy. Checkpoints never bind, alias or mutate paid operations (Rule C). */
export function reduceVoiceLifecycle(state, event) {
  if (!VOICE_LIFECYCLE_STATES.includes(state?.state) || typeof event?.type !== 'string') throw new TypeError('Invalid voice lifecycle event');
  if (event.type === 'segment-closed') {
    if (event.closureConfirmed !== true || !state.segments[event.providerSessionId]) return state;
    return { ...state, segments: { ...state.segments, [event.providerSessionId]: { closureConfirmed: true } } };
  }
  if (state.state === 'ended') return state;
  if (event.epoch !== undefined && event.type !== 'takeover' && event.epoch !== state.epoch) return state;
  if (event.providerGeneration !== undefined && event.type !== 'connected' && event.providerGeneration !== state.providerGeneration) return state;
  const hold = reason => [...new Set([...state.holds, reason])];
  const cutover = () => ({ ...state.checkpoint, tentative: false,
    userUnconfirmed: state.checkpoint.userUnconfirmed || state.checkpoint.tentative,
    deliveryUncertain: state.checkpoint.deliveryUncertain || Boolean(state.checkpoint.replyId) });
  switch (event.type) {
    case 'start': return state.state === 'idle' ? { ...state, state: 'connecting' } : state;
    case 'connected': {
      if (!event.providerSessionId || state.segments[event.providerSessionId] && event.providerSessionId !== state.providerSessionId) return state;
      const changed = state.providerSessionId !== event.providerSessionId;
      return { ...state, state: state.holds.length ? 'paused' : 'active', needsRecovery: false, attempts: 0,
        providerSessionId: event.providerSessionId, providerGeneration: state.providerGeneration + Number(changed),
        authorizationRevision: event.authorizationRevision ?? state.authorizationRevision,
        spendDeadlineAt: state.spendDeadlineAt ?? event.spendDeadlineAt ?? null,
        browserLivenessDeadlineAt: event.browserLivenessDeadlineAt ?? state.browserLivenessDeadlineAt,
        segments: { ...state.segments, [event.providerSessionId]: state.segments[event.providerSessionId] ?? { closureConfirmed: false } } };
    }
    case 'pause': return state.state === 'idle' ? state : { ...state, state: 'paused', holds: hold(event.reason ?? 'pause'), checkpoint: cutover() };
    case 'resume-requested': return state;
    case 'retry-requested': return { ...state, attempts: 0 };
    case 'resume-acknowledged': return { ...state, holds: [], state: state.needsRecovery ? 'recovering' : 'active',
      attempts: state.state === 'waiting' ? 0 : state.attempts };
    case 'transport-lost': return { ...state, needsRecovery: true,
      state: state.holds.length ? 'paused' : 'recovering', checkpoint: cutover() };
    case 'recovery-attempt': return { ...state, attempts: state.attempts + 1 };
    case 'recovery-failed': return state.attempts < 3 ? state : { ...state, state: 'waiting', needsRecovery: true, holds: hold('waiting') };
    case 'lease-expired': return { ...state, state: 'waiting', needsRecovery: true, holds: hold('waiting'), checkpoint: cutover() };
    case 'sleep': return { ...state, state: 'paused', holds: hold('sleep'), needsRecovery: true, checkpoint: cutover() };
    case 'wake': case 'ownership-lost': case 'server-restart':
      return { ...state, state: 'waiting', holds: hold(event.type), needsRecovery: true, checkpoint: cutover() };
    case 'takeover': return Number.isSafeInteger(event.epoch) && event.epoch > state.epoch
      ? { ...state, epoch: event.epoch, state: 'waiting', holds: hold('takeover'), needsRecovery: true, checkpoint: cutover() } : state;
    case 'heartbeat': return { ...state, browserLivenessDeadlineAt: event.browserLivenessDeadlineAt ?? state.browserLivenessDeadlineAt,
      authorizationRevision: event.authorizationRevision ?? state.authorizationRevision };
    case 'partial': return { ...state, checkpoint: { ...state.checkpoint, tentative: true, tentativeSequence: event.sequence ?? 0 } };
    case 'accepted': return { ...state, checkpoint: { ...state.checkpoint,
      ...(state.checkpoint.tentativeSequence <= (event.sequence ?? Infinity) ? { tentative: false, userUnconfirmed: false } : {}),
      acceptedTurnIds: [...new Set([...state.checkpoint.acceptedTurnIds, event.turnId])].slice(-4096),
      operationId: event.operationId ?? state.checkpoint.operationId } };
    case 'reply': return { ...state, checkpoint: { ...state.checkpoint, replyId: event.replyId,
      heardPrefix: null, deliveryUncertain: state.needsRecovery || state.holds.length > 0 } };
    case 'heard': return { ...state, checkpoint: { ...state.checkpoint, heardPrefix: event.prefix } };
    case 'end': case 'withdraw': case 'budget-end': case 'provider-end':
      return { ...state, state: 'ended', holds: hold('ended'), needsRecovery: false, checkpoint: cutover(), terminalReason: event.reason ?? event.type };
    default: throw new TypeError('Unknown voice lifecycle event');
  }
}
