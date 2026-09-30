import { canonicalJson } from '../../contracts/validate.js';
import { AuthzError, freeze } from './common.js';

const channels = Object.freeze(['capture', 'microphone', 'output', 'pending']);
const terminal = ['REVOKED', 'FENCED', 'PURGING', 'PURGED', 'ENDED'];
const revoked = () => new AuthzError(409, 'Session revoked', 'revoked');

/** Progress is committed by the same transition authority as session state. */
function purgeStep(progress) {
  if (progress.drainDeadline === null) return 'begin';
  if (progress.artifacts === null) return 'inventory';
  if (progress.drained === null) return 'drain';
  if (!progress.cacheDeleted) return 'cache';
  return 'acknowledgement';
}

/** Apply the same acknowledged bytes/cursor rules on every receipt entry. */
function applyRecord(next, status, { document, bytes }) {
  const control = ['authz.epoch', 'session.control'].includes(document.kind);
  if (control && document.writer.kind !== 'host') throw new AuthzError(403, 'Only the host writes authority controls');
  const canonical = canonicalJson(document);
  const prior = next.controls[document.seq];
  if (prior && prior !== canonical) throw new AuthzError(409, 'Journal control changed bytes', 'idempotency_conflict');
  const purge = document.kind === 'session.control' && document.data.action === 'purge';
  let reason;
  if (purge) {
    if (next.purgeRecord && canonicalJson(next.purgeRecord.document) !== canonical) throw new AuthzError(409, 'Different purge tombstone');
    next.purgeRecord = { bytes, document: structuredClone(document) };
    status = 'PURGING'; reason = revoked();
  }
  if (document.seq > next.lastSeq) {
    if (control) next.controls[document.seq] = canonical;
    next.lastSeq = document.seq;
    if (document.kind === 'authz.epoch' && document.data.epoch > next.scope.auth_epoch) {
      next.scope.auth_epoch = document.data.epoch;
      if (!['PURGING', 'PURGED', 'ENDED'].includes(status)) status = 'REVOKED';
      reason = revoked();
    } else if (document.kind === 'session.control') {
      if (document.data.action === 'suspend') {
        next.scope.suspended = true;
        if (['ACTIVE', 'CAPTURE_ONLY'].includes(status)) { status = 'SUSPENDED'; reason = revoked(); }
      } else if (document.data.action === 'resume' && status === 'SUSPENDED') status = 'ACTIVE';
    }
  }
  return { status, reason };
}

/**
 * The single lifecycle authority. Inputs are verified host events, never request
 * JSON. State contains only immutable data; controllers belong to the effect
 * runner. Every stop effect covers ALL controllers ever issued on its channels.
 *
 * @param {object|null} state
 * @param {{type:string, scope?:object, authority?:object, record?:object,
 *   epoch?:number, reason?:Error}} event
 * @returns {{state:object, effects:object[]}}
 */
export function transition(state, event) {
  if (!state) {
    if (event.type !== 'start') throw new TypeError('Authorization must start first');
    const scope = { tombstone: null, suspended: false, revoked: false, ...structuredClone(event.scope) };
    const status = scope.tombstone === 'purge' ? 'PURGING' : scope.revoked ? 'REVOKED'
      : scope.suspended || scope.tombstone === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    if (status === 'SUSPENDED') { scope.suspended = true; scope.tombstone = null; }
    return { state: freeze({ status, scope, revision: 0, lastSeq: 0, controls: {}, purgeRecord: null, purgeAcknowledged: false,
      purge: { drainDeadline: null, artifacts: null, drained: null, cacheDeleted: false, receipt: null, retry: null } }),
      effects: [{ type: 'create-signals', channels },
        ...(status === 'ACTIVE' ? [] : [{ type: 'stop-signals', channels, reason: revoked() }]),
        ...(status === 'PURGING' ? [{ type: 'redrive-purge' }] : [])] };
  }
  const next = structuredClone(state);
  // Keep one immutable acknowledgement object across transport retries.
  next.purge.receipt = state.purge.receipt;
  let status = state.status;
  let reason = event.reason;
  let purgeError = event.purgeError;
  switch (event.type) {
    case 'revoke':
      if (Number.isSafeInteger(event.epoch) && event.epoch > next.scope.auth_epoch) next.scope.auth_epoch = event.epoch;
      if (!['PURGING', 'PURGED', 'ENDED'].includes(status)) status = 'REVOKED';
      reason ??= revoked();
      break;
    case 'capture-only':
      if (status === 'ACTIVE') status = 'CAPTURE_ONLY';
      reason ??= new AuthzError(503, 'Authority unavailable');
      break;
    case 'end':
      // Ending paid work cannot interrupt an acknowledged deletion process.
      if (status !== 'PURGED' && !(status === 'PURGING' && next.purgeRecord)) status = 'ENDED';
      reason ??= new AuthzError(503, 'Ten minutes without authority; export available');
      break;
    case 'authority': {
      const authority = event.authority;
      if (!authority || ['tid', 'pid', 'sid'].some((key) => authority[key] !== next.scope[key])) throw new AuthzError(403, 'Authority scope mismatch');
      if (!Number.isSafeInteger(authority.auth_epoch) || authority.auth_epoch < 1
          || !Number.isSafeInteger(authority.worker_generation) || authority.worker_generation < 1
          || ![null, 'suspend', 'purge'].includes(authority.tombstone)) throw new AuthzError(502, 'Invalid host authority response');
      if (authority.auth_epoch < next.scope.auth_epoch) throw new AuthzError(502, 'Authority epoch moved backwards');
      if (authority.worker_generation < next.scope.worker_generation) throw new AuthzError(502, 'Authority generation moved backwards');
      const epochChanged = authority.auth_epoch !== next.scope.auth_epoch;
      const generationChanged = authority.worker_generation !== next.scope.worker_generation;
      next.scope.auth_epoch = authority.auth_epoch;
      next.scope.worker_generation = authority.worker_generation;
      if (authority.tombstone === 'suspend') next.scope.suspended = true;
      if (authority.tombstone === 'purge') { status = 'PURGING'; reason = revoked(); }
      else if (epochChanged && !['PURGING', 'PURGED', 'ENDED'].includes(status)) { status = 'REVOKED'; reason = revoked(); }
      else if (!terminal.includes(status)) {
        if (generationChanged) { status = 'FENCED'; reason = new AuthzError(409, 'Worker generation fenced', 'fenced_generation'); }
        else if (authority.tombstone === 'suspend') { status = 'SUSPENDED'; reason = revoked(); }
        else if (status === 'CAPTURE_ONLY') status = 'ACTIVE';
      }
      if (authority.tombstone === 'purge' && event.record) {
        // Retain the receipt in this commit, before any stop/observer callback.
        // Invalid receipts still close claims, but cannot drive cache deletion.
        try { ({ status, reason } = applyRecord(next, status, event.record)); }
        catch (error) { purgeError = error; }
      }
      break;
    }
    case 'journal-record': {
      ({ status, reason } = applyRecord(next, status, event.record));
      break;
    }
    case 'redrive-purge': {
      if (event.record) ({ status, reason } = applyRecord(next, status, event.record));
      break;
    }
    case 'purge-step-completed': {
      if (status !== 'PURGING' || !next.purgeRecord || event.step !== purgeStep(next.purge)) throw new AuthzError(409, 'Purge step out of order');
      next.purge.retry = null;
      if (event.step === 'begin') {
        if (!Number.isFinite(event.value)) throw new TypeError('Finite purge drain deadline required');
        next.purge.drainDeadline = event.value;
      } else if (event.step === 'inventory') next.purge.artifacts = [...event.value];
      else if (event.step === 'drain') {
        if (typeof event.value !== 'boolean') throw new TypeError('Purge drain result required');
        next.purge.drained = event.value;
      } else if (event.step === 'cache') {
        if (event.value !== true) throw new TypeError('Completed cache deletion required');
        next.purge.cacheDeleted = true;
        next.purge.receipt = freeze({ sid: next.scope.sid, tombstone_seq: next.purgeRecord.document.seq,
          drained: next.purge.drained, host_artifacts: [...next.purge.artifacts] });
      } else throw new TypeError('Acknowledgement requires its internal receipt event');
      break;
    }
    case 'purge_acknowledged':
      // Only the private effect runner produces this event after the host ack.
      if (status !== 'PURGING' || next.scope.tombstone !== 'purge' || !next.purgeRecord
          || next.purge.drainDeadline === null || next.purge.artifacts === null || next.purge.drained === null
          || !next.purge.cacheDeleted || !next.purge.receipt
          || canonicalJson(event.receipt) !== canonicalJson(next.purge.receipt)) throw new AuthzError(409, 'Purge acknowledgement requires completed deletion');
      status = 'PURGED'; reason = revoked();
      next.purgeAcknowledged = true;
      next.purge.retry = null;
      break;
    case 'purge-step-failed':
      next.purge.retry = { step: event.step, message: event.error.message };
      break;
    default: throw new TypeError(`Unknown authorization event ${event.type}`);
  }
  // Local cache deletion is permanent, even when a late host event arrives.
  if (state.status === 'PURGED') status = 'PURGED';
  next.status = status;
  if (status === 'SUSPENDED') next.scope.suspended = true;
  if (status === 'ACTIVE') next.scope.suspended = false;
  if (['REVOKED', 'ENDED'].includes(status)) next.scope.revoked = true;
  if (['PURGING', 'PURGED'].includes(status)) next.scope.tombstone = 'purge';
  const effects = [];
  if (status !== state.status) {
    next.revision++;
    effects.push(status === 'ACTIVE' ? { type: 'create-signals', channels }
      : { type: 'stop-signals', channels: status === 'CAPTURE_ONLY' ? channels.slice(1) : channels, reason });
  }
  if (event.type === 'purge-step-failed') effects.push({ type: 'purge-failed', error: event.error });
  else if (next.scope.tombstone === 'purge' && !next.purgeAcknowledged) effects.push({ type: 'redrive-purge', step: purgeStep(next.purge), error: purgeError });
  if (event.type === 'purge_acknowledged') effects.push({ type: 'purge-finished', receipt: next.purge.receipt });
  if (status !== state.status) effects.push({ type: 'notify', previous: state.status, state: status, reason });
  return { state: freeze(next), effects };
}
