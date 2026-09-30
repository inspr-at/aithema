import { transition } from './transition.js';
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

/** The original host purge receipt is required on every deletion entry point. */
export function purgeRecord(stored, sid) {
  const document = hostRecord(stored, sid);
  if (document.kind !== 'session.control' || document.data.action !== 'purge' || document.writer.kind !== 'host') {
    throw new AuthzError(403, 'Purge requires an acknowledged host tombstone');
  }
  return { document, bytes: Buffer.from(stored.bytes).toString('base64') };
}

/**
 * Local cancellation is separate from provider completion. Never hand the
 * capture/output/pending signals to an already committed provider request.
 * A replacement epoch needs a new host-authorized session; it cannot revive
 * this session. A journal resume may undo suspend, but never purge/revocation.
 */
export class AuthorizationSession {
  #lifecycle;
  #channels = new Map();
  #usedClaims = new Set();
  #inflight = new Map();
  #permits = new WeakSet();
  #onChange;
  #events = [];
  #draining = false;
  #purgeCoordinator;
  #purgeOperation;

  constructor({ authorization, scope, settingsSha256, onChange = () => {} }) {
    validateProcessingAuthorization(authorization, scope, settingsSha256);
    if (!Number.isSafeInteger(scope.worker_generation) || scope.worker_generation < 1) throw new TypeError('Current worker generation required');
    this.#onChange = onChange;
    this.#dispatch({ type: 'start', scope });
  }

  get state() { return this.#lifecycle.status; }
  get scope() { return this.#lifecycle.scope; }
  get captureSignal() { return this.#channels.get('capture').current.signal; }
  get microphoneSignal() { return this.#channels.get('microphone').current.signal; }
  get outputSignal() { return this.#channels.get('output').current.signal; }
  get pendingSignal() { return this.#channels.get('pending').current.signal; }
  get lastRecordSeq() { return this.#lifecycle.lastSeq; }
  get inflightCount() { return this.#inflight.size; }
  get purgeAcknowledged() { return this.#lifecycle.purgeAcknowledged; }

  /** Capture before awaiting a claim response; a late response cannot refresh it. */
  outputPermit() {
    const permit = freeze({ epoch: this.scope.auth_epoch, generation: this.scope.worker_generation,
      revision: this.#lifecycle.revision, active: this.state === 'ACTIVE' });
    this.#permits.add(permit);
    return permit;
  }

  /** Re-entrant callbacks only enqueue; the current event runs to completion. */
  #dispatch(event) {
    const entry = { event: { ...event, ...(event.authority && { authority: structuredClone(event.authority) }) } };
    this.#events.push(entry);
    if (this.#draining) return;
    this.#draining = true;
    let failure;
    try {
      while (this.#events.length) {
        const queued = this.#events.shift();
        try { this.#runEvent(queued); }
        catch (error) { failure ??= error; }
      }
    } finally { this.#draining = false; }
    if (failure) throw failure;
    return entry.result;
  }

  /** Commit, stop/create signals, start required deletion, then notify last. */
  #runEvent(entry) {
    const event = entry.event;
    const stored = event.stored ?? (event.authority?.tombstone === 'purge' && event.authority.tombstone_record);
    if (stored) {
      try { event.record = purgeRecord(stored, this.scope.sid); }
      catch (error) { event.purgeError = error; }
    }
    const { state, effects } = transition(this.#lifecycle ?? null, event);
    this.#lifecycle = state;
    if (event.purgeCoordinator) this.#purgeCoordinator = event.purgeCoordinator;
    for (const effect of effects) {
      if (effect.type === 'create-signals') {
        for (const channel of effect.channels) {
          const controllers = this.#channels.get(channel)?.controllers ?? new Set();
          const current = new AbortController();
          controllers.add(current);
          this.#channels.set(channel, { current, controllers });
        }
      } else if (effect.type === 'stop-signals') {
        for (const channel of effect.channels) {
          for (const controller of this.#channels.get(channel).controllers) controller.abort(effect.reason);
        }
      } else if (effect.type === 'redrive-purge') entry.result = this.#startPurge(effect.error);
      else if (effect.type === 'notify') this.#onChange({ previous: effect.previous, state: effect.state, reason: effect.reason });
    }
  }

  #startPurge(error) {
    if (!error && this.#purgeOperation) return this.#purgeOperation;
    // Schedule before notifying. A callback can stop the monitor, but cannot
    // cancel this effect or recurse through coordinator.complete's journal input.
    const operation = Promise.resolve().then(() => {
      if (error) throw error;
      if (!this.#purgeCoordinator) throw new AuthzError(502, 'Purge requires a coordinator');
      const retained = this.#lifecycle.purgeRecord;
      if (!retained) throw new AuthzError(502, 'Purge requires its original stored host tombstone');
      return this.#purgeCoordinator.complete({ document: retained.document, bytes: Buffer.from(retained.bytes, 'base64') });
    });
    if (!error) this.#purgeOperation = operation;
    // Synchronous lifecycle callers may ignore the optional deletion promise.
    // Awaiting callers still receive the failure and can re-drive a later event.
    const finished = () => { if (this.#purgeOperation === operation) this.#purgeOperation = null; };
    operation.then(finished, finished);
    return operation;
  }

  revoke(epoch = this.scope.auth_epoch) { this.#dispatch({ type: 'revoke', epoch }); }
  captureOnly(reason) { this.#dispatch({ type: 'capture-only', reason }); }
  end(reason) { this.#dispatch({ type: 'end', reason }); }
  applyAuthority(authority, { purgeCoordinator } = {}) { return this.#dispatch({ type: 'authority', authority, purgeCoordinator }); }

  assertNewClaim() {
    if (this.state === 'ACTIVE') return;
    if (this.state === 'CAPTURE_ONLY' || this.state === 'ENDED') throw new AuthzError(503, 'Paid work stopped; authority unavailable');
    throw new AuthzError(409, 'New budget claim refused', this.state === 'FENCED' ? 'fenced_generation' : 'revoked');
  }

  #canDeliver(permit, claim) {
    return this.#permits.has(permit) && permit.active && this.state === 'ACTIVE'
      && permit.revision === this.#lifecycle.revision && permit.epoch === claim.auth_epoch
      && permit.generation === claim.worker_generation && claim.auth_epoch === this.scope.auth_epoch
      && claim.worker_generation === this.scope.worker_generation;
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

  consumeStoredRecord(stored, { purgeCoordinator } = {}) {
    const document = hostRecord(stored, this.scope.sid);
    return this.#dispatch({ type: 'journal-record', record: { document, bytes: Buffer.from(stored.bytes).toString('base64') }, purgeCoordinator });
  }

  /** All journal/authority entry points re-drive retained deletion until ack. */
  async redrivePurge(coordinator, stored) {
    return this.#dispatch({ type: 'redrive-purge', purgeCoordinator: coordinator, stored });
  }

  /** Pull acknowledged controls using JournalPort; a denied read fails closed. */
  async consumeJournal(port, authority, options = {}) {
    // The tombstone may already have advanced the cursor, and real JournalPort
    // reads are denied after purge. Local retained state is the retry source.
    if (this.scope.tombstone === 'purge') {
      await this.redrivePurge(options.purgeCoordinator);
      return this.lastRecordSeq;
    }
    let records;
    try { records = await withDeadline(() => port.recordsAfter(this.lastRecordSeq, authority), options); }
    catch (error) {
      if (error.code === 'revoked') this.revoke();
      throw error;
    }
    if (!Array.isArray(records)) throw new AuthzError(502, 'Invalid journal control batch');
    let seq = this.lastRecordSeq;
    for (const stored of records) {
      const doc = hostRecord(stored, this.scope.sid);
      if (doc.seq <= seq) throw new AuthzError(502, 'Journal records are not ordered');
      seq = doc.seq;
    }
    let purging;
    for (const stored of records) {
      const completion = this.consumeStoredRecord(stored, { purgeCoordinator: options.purgeCoordinator });
      if (completion) purging = completion;
    }
    if (purging) await purging;
    return this.lastRecordSeq;
  }

  markPurged() { this.#dispatch({ type: 'cache-purged' }); }
  markPurgeAcknowledged() { this.#dispatch({ type: 'purge-acknowledged' }); }
}
