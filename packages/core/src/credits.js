// Read-only projection of the existing ledger: used() includes outstanding
// maxima and actual/uncertain settlements. Visitor and provider totals differ.
export const CONVERSATION_LIMIT_MS = 60 * 60_000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
function balancePart(limitMicro, committedMicro) {
  if (!integer(limitMicro) || !integer(committedMicro)) throw new TypeError('Invalid credit balance');
  return { limitMicro, committedMicro, availableMicro: Math.max(0, limitMicro - committedMicro),
    overrunMicro: Math.max(0, committedMicro - limitMicro) };
}
export function budgetCreditView(ledger, sessionId) {
  if (!id(sessionId) || typeof ledger?.used !== 'function' || typeof ledger?.visitorUsed !== 'function') {
    throw new TypeError('Credit ledger required');
  }
  return { sessionId, session: balancePart(ledger.sessionCapMicro, ledger.used(sessionId)),
    visitor: balancePart(ledger.visitorCapMicro, ledger.visitorUsed(sessionId)) };
}
/** Preview only. The host still performs atomic ledger.admit before dispatch. */
export function creditAdmission(ledger, sessionId, maxMicro, maxVisitorMicro = 0) {
  if (!integer(maxMicro) || !integer(maxVisitorMicro) || typeof ledger?.canAdmit !== 'function') throw new TypeError('Invalid credit request');
  const balance = budgetCreditView(ledger, sessionId);
  const ok = ledger.canAdmit(sessionId, maxMicro, maxVisitorMicro) === true;
  return { ok, reason: ok ? null : maxMicro > balance.session.availableMicro || balance.session.overrunMicro ? 'session' :
    maxVisitorMicro > balance.visitor.availableMicro || balance.visitor.overrunMicro ? 'visitor' : 'host-limit', balance };
}
export function createCredits({ sessionId, durationMs = CONVERSATION_LIMIT_MS } = {}) {
  if (!id(sessionId) || !integer(durationMs) || !durationMs) throw new TypeError('Invalid credit slot configuration');
  return { sessionId, status: 'ready', startedAt: null, endsAt: null, durationMs, lastNow: 0,
    balance: null, endReason: null, paused: false };
}
export function creditsView(state, now) {
  if (!integer(now)) throw new TypeError('Credits view requires host time');
  return { sessionId: state.sessionId, status: state.status, balance: structuredClone(state.balance),
    remainingMs: state.endsAt === null ? null : Math.max(0, state.endsAt - now), endReason: state.endReason,
    canStartPaidWork: state.status === 'active' && !state.paused && now < state.endsAt,
    topUpOwnedByHost: true };
}
/** A full hold is a balance view, not a terminal denial. Only an authoritative
 * limit event or elapsed guard ends the conversation. Already admitted work
 * must be settled by the host even after pause/end, including unknown usage. */
export function reduceCredits(state, event) {
  if (!event || !integer(event.now) || event.now < state.lastNow) throw new TypeError('Credit events require monotonic host time');
  const next = structuredClone(state), events = [];
  next.lastNow = event.now;
  const end = reason => {
    if (!['ending', 'ended'].includes(next.status)) {
      next.status = 'ending'; next.endReason = reason;
      events.push({ type: 'credits.limit-reached', data: { sessionId: next.sessionId, reason } });
      events.push({ type: 'conversation.end-requested', data: { sessionId: next.sessionId, reason,
        preserveTranscript: true, settleOutstanding: true } });
    }
  };
  if (next.status === 'active' && event.now >= next.endsAt) end('one-hour');
  switch (event.type) {
    case 'start':
      if (next.status === 'ready') {
        next.startedAt = event.now; next.endsAt = event.now + next.durationMs;
        if (!integer(next.endsAt)) throw new TypeError('Conversation deadline overflow');
        next.status = 'active';
      }
      break;
    case 'balance': {
      const view = event.balance;
      if (view?.sessionId !== next.sessionId || !['session', 'visitor'].every(key => {
        const part = view?.[key];
        if (!part || !integer(part.limitMicro) || !integer(part.committedMicro)) return false;
        const expected = balancePart(part.limitMicro, part.committedMicro);
        return part.availableMicro === expected.availableMicro && part.overrunMicro === expected.overrunMicro;
      })) throw new TypeError('Invalid credit balance event');
      next.balance = { sessionId: view.sessionId, session: balancePart(view.session.limitMicro, view.session.committedMicro),
        visitor: balancePart(view.visitor.limitMicro, view.visitor.committedMicro) };
      break;
    }
    case 'limit':
      if (!['session', 'visitor', 'host-limit'].includes(event.reason)) throw new TypeError('Invalid credit limit');
      end(event.reason);
      break;
    case 'pause':
      if (typeof event.paused !== 'boolean') throw new TypeError('Invalid credit pause');
      next.paused = event.paused;
      break;
    case 'closed':
      if (next.status !== 'ending' && next.status !== 'ended') throw new TypeError('No credit closure requested');
      next.status = 'ended';
      break;
    case 'tick': break;
    default: throw new TypeError('Unknown credit event');
  }
  events.push({ type: 'credits.state', data: creditsView(next, event.now) });
  return { state: next, events };
}

/** Optional top-up is a host action; it never edits ledger totals or restarts
 * the guard. Re-read an authoritative balance after the host responds. */
export async function requestCreditTopUp(port, { sessionId } = {}, options) {
  if (!id(sessionId)) throw new TypeError('Top-up session required');
  if (typeof port?.topUp !== 'function') return { status: 'unavailable' };
  const result = await port.topUp({ sessionId }, options);
  if (!['requested', 'unavailable'].includes(result?.status)) throw new TypeError('Invalid host top-up response');
  return { status: result.status };
}
