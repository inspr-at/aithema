// Read-only projection of the existing ledger: used() includes outstanding
// maxima and actual/uncertain settlements. Both ledger caps are per session;
// the host's separate owner wallet spans conversations and owns its billing.
import { hostPortKit } from './host-port-kit.js';
import { PluginError } from './invocation.js';

export const CONVERSATION_LIMIT_MS = 60 * 60_000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const inFlightAttempts = new Set();
function attemptError(error, attemptId) {
  try { error.attemptId = attemptId; return error; } catch {
    const wrapped = new Error('Credit admission failed', { cause: error });
    if (typeof error?.code === 'string') wrapped.code = error.code;
    wrapped.attemptId = attemptId; return wrapped;
  }
}
function balancePart(limitMicro, committedMicro) {
  if (!integer(limitMicro) || !integer(committedMicro)) throw new TypeError('Invalid credit balance');
  return { limitMicro, committedMicro, availableMicro: Math.max(0, limitMicro - committedMicro),
    overrunMicro: Math.max(0, committedMicro - limitMicro) };
}
const admissionReason = (balance, maxMicro, maxVisitorMicro) =>
  maxMicro > balance.session.availableMicro || balance.session.overrunMicro ? 'session' :
    maxVisitorMicro > balance.voiceVisitor.availableMicro || balance.voiceVisitor.overrunMicro ? 'voiceVisitor' : 'host-limit';
/** Host-bound to one owner. balance() returns {limitMicro,committedMicro};
 * canAdmit(request) is a synchronous preview; admit(request) confirms an atomic
 * owner reservation with {ok:boolean}, possibly asynchronously. Admission MUST
 * be idempotent per attemptId, including concurrent calls, and store its request
 * fingerprint: sessionId, lane, maxMicro, maxVisitorMicro (default 0),
 * requestSha256 and bindingSha256. Different fingerprints MUST return
 * {ok:false,reason:'attempt-conflict'} without returning or changing the old
 * hold, even after release. release({attemptId})
 * MUST await removal of only that reservation and be idempotent; unknown IDs
 * are harmless. Rejections leave reservations unchanged. The host owns billing,
 * settlement and crash recovery under the same attemptId. */
export function assertOwnerWalletPort(port) {
  if (['balance', 'canAdmit', 'admit', 'release'].some(name => typeof port?.[name] !== 'function')) {
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
  return { ok, reason: ok ? null : admissionReason(balance, maxMicro, maxVisitorMicro), balance };
}
/** No billing policy lives here. A preview cannot authorize ledger admission;
 * the owner wallet must confirm first, including when racing another session.
 * Both ports receive the same frozen snapshot with a caller or generated
 * attemptId. Concurrent duplicates throw already-claimed before either port.
 * ledger.admit(request) MUST preserve the ID in its admission result. Only a
 * definitive not-admitted rejection guarantees no reservation and permits
 * owner release, then {ok:false,reason,attemptId}. already-claimed and unknown
 * outcomes (e.g. remote timeouts) propagate without releasing the owner hold.
 * Thrown errors include attemptId for recovery, including wallet/release errors.
 * Part B wiring: bind the required release hook to the owner's reservation
 * store; use this attemptId for ledger admission, settlement and recovery.
 * Multi-process hosts MUST implement the same in-flight exclusion at the wallet
 * or ledger; this module's set only guards calls in the current process.
 * SQLiteBudgetLedger already accepts caller IDs, so no ledger change is needed. */
export async function admitCredits(ledger, request, ownerWallet) {
  assertOwnerWalletPort(ownerWallet);
  if (typeof ledger?.admit !== 'function') throw new TypeError('Credit ledger admission required');
  const snapshot = structuredClone(request);
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('Invalid credit request');
  snapshot.attemptId ??= crypto.randomUUID();
  if (!id(snapshot.attemptId)) throw new TypeError('Invalid credit attempt');
  Object.freeze(snapshot);
  if (inFlightAttempts.has(snapshot.attemptId)) throw attemptError(new PluginError('already-claimed'), snapshot.attemptId);
  inFlightAttempts.add(snapshot.attemptId);
  try {
    const preview = creditAdmission(ledger, snapshot.sessionId, snapshot.maxMicro, snapshot.maxVisitorMicro ?? 0, ownerWallet);
    if (!preview.ok) return preview;
    const result = await ownerWallet.admit(snapshot);
    if (typeof result?.ok !== 'boolean') throw new TypeError('Invalid owner wallet admission');
    if (!result.ok) {
      if (result.reason === 'attempt-conflict') return { ok: false, reason: 'attempt-conflict', attemptId: snapshot.attemptId };
      return { ok: false, reason: 'host-limit', balance: budgetCreditView(ledger, snapshot.sessionId, ownerWallet) };
    }
    try {
      return { ok: true, reason: null, admission: await ledger.admit(snapshot) };
    } catch (error) {
      if (error?.code !== 'not-admitted') throw error;
      await ownerWallet.release({ attemptId: snapshot.attemptId });
      const balance = budgetCreditView(ledger, snapshot.sessionId, ownerWallet);
      return { ok: false, reason: admissionReason(balance, snapshot.maxMicro, snapshot.maxVisitorMicro ?? 0), attemptId: snapshot.attemptId };
    }
  } catch (error) {
    throw attemptError(error, snapshot.attemptId);
  } finally { inFlightAttempts.delete(snapshot.attemptId); }
}

/** Destructive kit for an owner-bound local fixture with an affordable request
 * (sessionId, lane, maxima and request/binding sha256); maxMicro must be positive.
 * The kit uses
 * a fresh attemptId, checks concurrent/serial retries against balance(), then
 * checks each fingerprint field for conflicts and unchanged holds. It checks
 * release and unknown/repeated release without disturbing other holds. */
export async function ownerWalletConformance(port, request, { timeoutMs = 1000 } = {}) {
  const kit = hostPortKit(timeoutMs), { check, run } = kit;
  try { assertOwnerWalletPort(port); } catch { check(false, 'owner wallet operations missing'); return kit.result(); }
  if (!id(request?.sessionId) || !integer(request?.maxMicro) || !request.maxMicro) {
    check(false, 'owner wallet fixture request invalid'); return kit.result();
  }
  const snapshot = Object.freeze({ ...structuredClone(request), attemptId: crypto.randomUUID() });
  const readBalance = () => {
    const balance = port.balance();
    return balancePart(balance?.limitMicro, balance?.committedMicro);
  };
  const before = await run('owner wallet balance failed', readBalance);
  if (!before) return kit.result();
  const allowed = await run('owner wallet preview failed', () => port.canAdmit(snapshot));
  if (allowed !== true || snapshot.maxMicro > before.availableMicro) {
    check(false, 'owner wallet fixture request unaffordable'); return kit.result();
  }
  const admissions = await run('owner wallet admission failed', () => Promise.all([port.admit(snapshot), port.admit(snapshot)]));
  check(admissions?.every(result => result?.ok === true) === true, 'owner wallet admission response');
  const retried = await run('owner wallet retry failed', () => port.admit(snapshot));
  check(retried?.ok === true, 'owner wallet retry response');
  const admitted = await run('owner wallet admitted balance failed', readBalance);
  check(admitted?.committedMicro === before.committedMicro + snapshot.maxMicro, 'owner admission idempotency');
  const mismatches = { sessionId: crypto.randomUUID(), lane: snapshot.lane === 'voice' ? 'reaction' : 'voice',
    maxMicro: snapshot.maxMicro === 1 ? 2 : snapshot.maxMicro - 1,
    maxVisitorMicro: (snapshot.maxVisitorMicro ?? 0) === 0 ? 1 : 0,
    requestSha256: (snapshot.requestSha256 === 'a'.repeat(64) ? 'b' : 'a').repeat(64),
    bindingSha256: (snapshot.bindingSha256 === 'a'.repeat(64) ? 'b' : 'a').repeat(64) };
  for (const [field, value] of Object.entries(mismatches)) {
    const conflict = await run(`owner conflicting admission ${field} failed`, () => port.admit(Object.freeze({ ...snapshot, [field]: value })));
    check(conflict?.ok === false && conflict.reason === 'attempt-conflict', `owner attempt conflict ${field}`);
    const unchanged = await run(`owner conflict balance ${field} failed`, readBalance);
    check(unchanged?.committedMicro === admitted?.committedMicro, `owner conflict changed hold ${field}`);
  }
  await run('owner reservation release failed', () => port.release({ attemptId: snapshot.attemptId }));
  const released = await run('owner wallet released balance failed', readBalance);
  check(released?.committedMicro === before.committedMicro, 'owner reservation release');
  await run('owner repeated release failed', () => port.release({ attemptId: snapshot.attemptId }));
  await run('owner unknown release failed', () => port.release({ attemptId: crypto.randomUUID() }));
  const repeated = await run('owner wallet repeated release balance failed', readBalance);
  check(repeated?.committedMicro === before.committedMicro, 'owner release idempotency');
  const conflict = await run('owner released attempt conflict failed', () => port.admit(Object.freeze({ ...snapshot, maxMicro: mismatches.maxMicro })));
  check(conflict?.ok === false && conflict.reason === 'attempt-conflict', 'owner released attempt conflict');
  const afterConflict = await run('owner released conflict balance failed', readBalance);
  check(afterConflict?.committedMicro === before.committedMicro, 'owner released conflict changed hold');
  return kit.result();
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
