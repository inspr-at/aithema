import { canonicalJson } from '../../contracts/validate.js';
import { checkedRecord } from '../journal/hydrate.js';
import { AuthzError, checkedDocument, freeze, withDeadline } from './common.js';

/** Presence and binding only: the host, never Aithema, chooses the lawful basis. */
export function validateProcessingAuthorization(record, scope, settingsSha256) {
  checkedDocument('aithema.authz', record);
  if (['tid', 'pid', 'sid'].some((key) => !scope || scope[key] !== record[key])) {
    throw new AuthzError(403, 'Processing authorization scope mismatch');
  }
  if (record.settings_sha256 !== settingsSha256) throw new AuthzError(403, 'Processing authorization settings digest mismatch');
  if (record.withdrawn_at !== null || record.epoch !== scope.auth_epoch) throw new AuthzError(409, 'Processing authorization revoked', 'revoked');
  if (new Set(record.participants.map((participant) => participant.participant_ref)).size !== record.participants.length
      || new Set(record.processors.map((processor) => processor.processor_ref)).size !== record.processors.length) {
    throw new AuthzError(400, 'Duplicate processing authorization participants or processors');
  }
  return freeze(structuredClone(record));
}

/** A returned journal projection must match the host's original acknowledged bytes. */
export function hostRecord(stored, sid) {
  let checked;
  try { checked = checkedRecord(stored, sid); }
  catch (error) {
    if (error.code === 'contract_too_new') throw error;
    throw new AuthzError(502, 'Invalid acknowledged journal record');
  }
  return checked.document;
}

/**
 * Local cancellation is separate from provider completion. Never hand the
 * capture/output/pending signals to an already committed provider request.
 * A replacement epoch needs a new host-authorized session; it cannot revive
 * this session. A journal resume may undo suspend, but never purge/revocation.
 */
export class AuthorizationSession {
  #scope;
  #state = 'ACTIVE';
  #revision = 0;
  #capture = new AbortController();
  #output = new AbortController();
  #pending = new AbortController();
  #usedClaims = new Set();
  #inflight = new Map();
  #permits = new WeakSet();
  #lastSeq = 0;
  #controls = new Map();
  #onChange;

  constructor({ authorization, scope, settingsSha256, onChange = () => {} }) {
    validateProcessingAuthorization(authorization, scope, settingsSha256);
    if (!Number.isSafeInteger(scope.worker_generation) || scope.worker_generation < 1) throw new TypeError('Current worker generation required');
    this.#scope = structuredClone(scope);
    this.#onChange = onChange;
  }

  get state() { return this.#state; }
  get scope() { return freeze(structuredClone(this.#scope)); }
  get captureSignal() { return this.#capture.signal; }
  get outputSignal() { return this.#output.signal; }
  get pendingSignal() { return this.#pending.signal; }
  get lastRecordSeq() { return this.#lastSeq; }
  get inflightCount() { return this.#inflight.size; }

  /** Capture before awaiting a claim response; a late response cannot refresh it. */
  outputPermit() {
    const permit = freeze({ epoch: this.#scope.auth_epoch, generation: this.#scope.worker_generation,
      revision: this.#revision, active: this.#state === 'ACTIVE' });
    this.#permits.add(permit);
    return permit;
  }

  #transition(state, reason) {
    if (this.#state === state || this.#state === 'PURGED') return;
    const previous = this.#state;
    this.#state = state;
    this.#revision++;
    if (state === 'ACTIVE') {
      this.#capture = new AbortController();
      this.#output = new AbortController();
      this.#pending = new AbortController();
    } else {
      for (const controller of [this.#capture, this.#output, this.#pending]) controller.abort(reason);
    }
    this.#onChange({ previous, state, reason });
  }

  revoke(epoch = this.#scope.auth_epoch) {
    if (Number.isSafeInteger(epoch) && epoch > this.#scope.auth_epoch) this.#scope.auth_epoch = epoch;
    if (!['PURGING', 'PURGED', 'ENDED'].includes(this.#state)) {
      this.#transition('REVOKED', new AuthzError(409, 'Session revoked', 'revoked'));
    }
  }

  captureOnly(reason = new AuthzError(503, 'Authority unavailable')) {
    if (this.#state === 'ACTIVE') this.#transition('CAPTURE_ONLY', reason);
  }

  end(reason = new AuthzError(503, 'Ten minutes without authority; export available')) {
    if (!['PURGING', 'PURGED'].includes(this.#state)) this.#transition('ENDED', reason);
  }

  applyAuthority(authority) {
    if (['tid', 'pid', 'sid'].some((key) => authority[key] !== this.#scope[key])) throw new AuthzError(403, 'Authority scope mismatch');
    if (authority.auth_epoch < this.#scope.auth_epoch) throw new AuthzError(502, 'Authority epoch moved backwards');
    if (authority.auth_epoch !== this.#scope.auth_epoch) this.revoke(authority.auth_epoch);
    if (authority.tombstone === 'purge') {
      this.#transition('PURGING', new AuthzError(409, 'Session purge tombstone', 'revoked'));
      return;
    }
    if (['REVOKED', 'FENCED', 'PURGING', 'PURGED', 'ENDED'].includes(this.#state)) return;
    if (authority.worker_generation !== this.#scope.worker_generation) {
      this.#transition('FENCED', new AuthzError(409, 'Worker generation fenced', 'fenced_generation'));
    } else if (authority.tombstone === 'suspend') {
      this.#transition('SUSPENDED', new AuthzError(409, 'Session suspended', 'revoked'));
    } else if (this.#state === 'CAPTURE_ONLY') {
      this.#transition('ACTIVE');
    }
    // SUSPENDED resumes only with an acknowledged host session.control resume.
  }

  assertNewClaim() {
    if (this.#state === 'ACTIVE') return;
    if (this.#state === 'CAPTURE_ONLY' || this.#state === 'ENDED') throw new AuthzError(503, 'Paid work stopped; authority unavailable');
    throw new AuthzError(409, 'New budget claim refused', this.#state === 'FENCED' ? 'fenced_generation' : 'revoked');
  }

  #canDeliver(permit, claim) {
    return this.#permits.has(permit) && permit.active && this.#state === 'ACTIVE'
      && permit.revision === this.#revision && permit.epoch === claim.auth_epoch
      && permit.generation === claim.worker_generation && claim.auth_epoch === this.#scope.auth_epoch
      && claim.worker_generation === this.#scope.worker_generation;
  }

  /**
   * receipt is supplied ONLY after host claim commitment, including a response
   * arriving after revocation. No second authorization check before dispatch.
   * settle must persist charging via BudgetPort; failure is surfaced to recovery.
   */
  dispatchCommitted(receipt, execute, { permit, settle } = {}) {
    if (!receipt || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.claim_id)
        || !Number.isSafeInteger(receipt.auth_epoch) || receipt.auth_epoch < 1
        || !Number.isSafeInteger(receipt.worker_generation) || receipt.worker_generation < 1
        || typeof execute !== 'function' || typeof settle !== 'function') throw new TypeError('Committed claim receipt, execute and settle required');
    if (this.#usedClaims.has(receipt.claim_id)) throw new AuthzError(409, 'Claim cannot be dispatched twice', 'already_claimed');
    const claim = freeze(structuredClone(receipt));
    this.#usedClaims.add(claim.claim_id);
    const operation = Promise.resolve().then(async () => {
      let value;
      try { value = await execute(claim); }
      catch (error) { await settle(claim, { outcome: 'unknown' }); throw error; }
      // Revoked/fenced completion is charged at the committed maximum through
      // the ledger's unknown outcome; exact settlement is for current output.
      await settle(claim, { outcome: this.#canDeliver(permit, claim) ? 'settled' : 'unknown' });
      const delivered = this.#canDeliver(permit, claim);
      return delivered ? { delivered: true, value } : { delivered: false };
    }).finally(() => this.#inflight.delete(claim.claim_id));
    this.#inflight.set(claim.claim_id, operation);
    return operation;
  }

  async drain() {
    // A claim committed before the tombstone may arrive while another request
    // drains. Include it too; PurgeCoordinator supplies the outer 10s bound.
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight.values()]);
  }

  consumeStoredRecord(stored) {
    const doc = hostRecord(stored, this.#scope.sid);
    const control = ['authz.epoch', 'session.control'].includes(doc.kind);
    if (control && doc.writer.kind !== 'host') throw new AuthzError(403, 'Only the host writes authority controls');
    const prior = this.#controls.get(doc.seq);
    if (prior && prior !== canonicalJson(doc)) throw new AuthzError(409, 'Journal control changed bytes', 'idempotency_conflict');
    if (doc.seq <= this.#lastSeq) return;
    if (control) this.#controls.set(doc.seq, canonicalJson(doc));
    this.#lastSeq = doc.seq;
    if (doc.kind === 'authz.epoch') {
      if (doc.data.epoch > this.#scope.auth_epoch) this.revoke(doc.data.epoch);
    } else if (doc.kind === 'session.control') {
      const reason = new AuthzError(409, 'Host session control', 'revoked');
      if (doc.data.action === 'purge') this.#transition('PURGING', reason);
      else if (doc.data.action === 'suspend' && ['ACTIVE', 'CAPTURE_ONLY'].includes(this.#state)) this.#transition('SUSPENDED', reason);
      else if (doc.data.action === 'resume' && this.#state === 'SUSPENDED') this.#transition('ACTIVE');
    }
  }

  /** Pull acknowledged controls using JournalPort; a denied read fails closed. */
  async consumeJournal(port, authority, options = {}) {
    let records;
    try { records = await withDeadline(() => port.recordsAfter(this.#lastSeq, authority), options); }
    catch (error) {
      if (error.code === 'revoked') this.revoke();
      throw error;
    }
    if (!Array.isArray(records)) throw new AuthzError(502, 'Invalid journal control batch');
    let seq = this.#lastSeq;
    for (const stored of records) {
      const doc = hostRecord(stored, this.#scope.sid);
      if (doc.seq <= seq) throw new AuthzError(502, 'Journal records are not ordered');
      seq = doc.seq;
    }
    for (const stored of records) this.consumeStoredRecord(stored);
    return this.#lastSeq;
  }

  markPurged() {
    if (this.#state !== 'PURGING') throw new AuthzError(409, 'Purge requires a host tombstone');
    this.#transition('PURGED', new AuthzError(409, 'Session purged', 'revoked'));
  }
}
