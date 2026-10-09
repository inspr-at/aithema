// Read-only projection of the existing ledger: used() includes outstanding
// maxima and actual/uncertain settlements. Both ledger caps are per session;
// the host's separate owner wallet spans conversations and owns its billing.
export const CONVERSATION_LIMIT_MS = 60 * 60_000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
function balancePart(limitMicro, committedMicro) {
  if (!integer(limitMicro) || !integer(committedMicro)) throw new TypeError('Invalid credit balance');
  return { limitMicro, committedMicro, availableMicro: Math.max(0, limitMicro - committedMicro),
    overrunMicro: Math.max(0, committedMicro - limitMicro) };
}
/** Host-bound to one owner. balance() returns {limitMicro,committedMicro};
 * canAdmit(request) is a synchronous preview; admit(request) confirms an atomic
 * owner reservation with {ok:boolean}, possibly asynchronously. The host owns
 * reservation recovery, settlement and release if the session ledger rejects. */
export function assertOwnerWalletPort(port) {
  if (['balance', 'canAdmit', 'admit'].some(name => typeof port?.[name] !== 'function')) {
    throw new TypeError('Owner wallet required');
  }
  return port;
}
export function budgetCreditView(ledger, sessionId, ownerWallet) {
  assertOwnerWalletPort(ownerWallet);
  if (!id(sessionId) || typeof ledger?.used !== 'function' || typeof ledger?.visitorUsed !== 'function') {
    throw new TypeError('Credit ledger required');
  }
  const owner = ownerWallet.balance();
  return { sessionId, owner: balancePart(owner?.limitMicro, owner?.committedMicro),
    session: balancePart(ledger.sessionCapMicro, ledger.used(sessionId)),
    voiceVisitor: balancePart(ledger.visitorCapMicro, ledger.visitorUsed(sessionId)) };
}
/** Preview only. Paid hosts MUST use admitCredits for authoritative owner
 * admission before the existing atomic ledger.admit, then claim as usual. */
export function creditAdmission(ledger, sessionId, maxMicro, maxVisitorMicro = 0, ownerWallet) {
  if (!integer(maxMicro) || !integer(maxVisitorMicro) || typeof ledger?.canAdmit !== 'function') throw new TypeError('Invalid credit request');
  const balance = budgetCreditView(ledger, sessionId, ownerWallet);
  if (ownerWallet.canAdmit({ sessionId, maxMicro, maxVisitorMicro }) !== true) {
    return { ok: false, reason: 'host-limit', balance };
  }
  const ok = ledger.canAdmit(sessionId, maxMicro, maxVisitorMicro) === true;
  return { ok, reason: ok ? null : maxMicro > balance.session.availableMicro || balance.session.overrunMicro ? 'session' :
    maxVisitorMicro > balance.voiceVisitor.availableMicro || balance.voiceVisitor.overrunMicro ? 'voiceVisitor' : 'host-limit', balance };
}
/** No billing policy lives here. A preview cannot authorize ledger admission;
 * the owner wallet must confirm first, including when racing another session. */
export async function admitCredits(ledger, request, ownerWallet) {
  assertOwnerWalletPort(ownerWallet);
  if (typeof ledger?.admit !== 'function') throw new TypeError('Credit ledger admission required');
  const snapshot = structuredClone(request);
  const preview = creditAdmission(ledger, snapshot?.sessionId, snapshot?.maxMicro, snapshot?.maxVisitorMicro ?? 0, ownerWallet);
  if (!preview.ok) return preview;
  const result = await ownerWallet.admit(structuredClone(snapshot));
  if (typeof result?.ok !== 'boolean') throw new TypeError('Invalid owner wallet admission');
  if (!result.ok) return { ok: false, reason: 'host-limit', balance: budgetCreditView(ledger, snapshot.sessionId, ownerWallet) };
  return { ok: true, reason: null, admission: await ledger.admit(snapshot) };
}
export function createCredits({ sessionId, durationMs = CONVERSATION_LIMIT_MS } = {}) {
  if (!id(sessionId) || !integer(durationMs) || !durationMs) throw new TypeError('Invalid credit slot configuration');
  return { sessionId, status: 'ready', startedAt: null, endsAt: null, durationMs, lastNow: 0,
    balance: null, endReason: null, paused: false };
}
/** Hosts persist one guard state per owner. New/reset attach its existing state
 * to the new conversation, retaining elapsed time, pause and terminal status. */
export function rebindCredits(state, sessionId) {
  if (!id(state?.sessionId) || !id(sessionId)) throw new TypeError('Invalid credit conversation');
  return { ...structuredClone(state), sessionId, balance: null };
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
      if (view?.sessionId !== next.sessionId || !['owner', 'session', 'voiceVisitor'].every(key => {
        const part = view?.[key];
        if (!part || !integer(part.limitMicro) || !integer(part.committedMicro)) return false;
        const expected = balancePart(part.limitMicro, part.committedMicro);
        return part.availableMicro === expected.availableMicro && part.overrunMicro === expected.overrunMicro;
      })) throw new TypeError('Invalid credit balance event');
      next.balance = { sessionId: view.sessionId, owner: balancePart(view.owner.limitMicro, view.owner.committedMicro),
        session: balancePart(view.session.limitMicro, view.session.committedMicro),
        voiceVisitor: balancePart(view.voiceVisitor.limitMicro, view.voiceVisitor.committedMicro) };
      break;
    }
    case 'limit':
      if (!['session', 'voiceVisitor', 'host-limit'].includes(event.reason)) throw new TypeError('Invalid credit limit');
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
