import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../contracts/validate.js';
import { AuthzError, checkedDocument, systemClock, systemScheduler, withDeadline } from './common.js';
import { purgeRecord } from './session.js';

/**
 * Host writes the tombstone through JournalPort FIRST. An authenticated host
 * can also forward its stored acknowledgement to complete() after committing
 * outside this service. A tombstoned journal refuses reads and worker writes;
 * the acknowledgement is an out-of-band reply, never an invented record kind.
 */
export class PurgeCoordinator {
  #journal;
  #session;
  #clock;
  #scheduler;
  #purgeCache;
  #acknowledge;
  #artifacts;
  #submission;
  #stored;
  #busy;
  #tombstone;

  constructor({ journal, session, purgeCache, acknowledge, hostArtifacts, clock = systemClock, scheduler = systemScheduler }) {
    if (typeof purgeCache !== 'function' || typeof acknowledge !== 'function' || typeof hostArtifacts !== 'function') {
      throw new TypeError('Cache purge, acknowledgement and host artifact inventory required');
    }
    this.#journal = journal;
    this.#session = session;
    this.#clock = clock;
    this.#scheduler = scheduler;
    this.#purgeCache = purgeCache;
    this.#acknowledge = acknowledge;
    this.#artifacts = hostArtifacts;
  }

  #checkedTombstone(stored) {
    const { document } = purgeRecord(stored, this.#session.scope.sid);
    const bytes = Buffer.from(stored.bytes);
    if (this.#submission && !bytes.equals(this.#submission)) throw new AuthzError(502, 'Purge acknowledgement changed submission');
    if (this.#tombstone && this.#tombstone !== canonicalJson(document)) throw new AuthzError(409, 'Different purge tombstone');
    return { bytes, document };
  }

  purge({ authority, reason, clientEventId = randomUUID() }) {
    if (!authority || authority.writer_kind !== 'host') throw new AuthzError(403, 'Only the host may tombstone a session');
    if (this.#busy) return this.#busy;
    if (!this.#submission && !this.#stored) {
      const document = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: this.#session.scope.sid, client_event_id: clientEventId, writer: { kind: 'host' },
        recorded_at: new Date(this.#clock.wallNow()).toISOString(), kind: 'session.control',
        data: { action: 'purge', ...(reason === undefined ? {} : { reason }) } };
      checkedDocument(document.contract, document);
      this.#submission = Buffer.from(canonicalJson(document));
    }
    return this.#coalesce(async () => {
      if (!this.#stored) {
        try {
          await withDeadline(async (signal) => {
            const stored = await this.#journal.append(Buffer.from(this.#submission), authority, { signal });
            // Retain ONLY a validated, byte-exact receipt. This also preserves a
            // committed response delivered after the request deadline. Ordinary
            // authority/read requests retain withDeadline's strict timeout rule.
            this.#stored = this.#checkedTombstone(stored);
          }, { clock: this.#clock, scheduler: this.#scheduler });
        } catch (error) {
          // A committed tombstone's lost response is indistinguishable from
          // another host revocation here. Fail closed immediately; never invent
          // a receipt/seq or delete caches before the original host ack arrives.
          if (error.code === 'revoked') this.#session.revoke();
          if (!(error instanceof AuthzError) || error.status !== 504 || !this.#stored) throw error;
        }
      }
      return this.#session.redrivePurge(this, this.#stored);
    });
  }

  complete(stored) {
    // Validate callback bytes even while another caller drains or acknowledges.
    // Coalescing must not turn a foreign/changed receipt into a successful purge.
    let checked;
    try { checked = this.#checkedTombstone(stored); }
    catch (error) { return Promise.reject(error); }
    if (this.#busy) return this.#busy;
    return this.#coalesce(() => this.#session.redrivePurge(this, checked));
  }

  /** Install the pending result BEFORE any user-supplied step can call back. */
  #coalesce(start) {
    const operation = Promise.withResolvers();
    this.#busy = operation.promise;
    const finish = (value, error) => {
      if (this.#busy === operation.promise) this.#busy = null;
      if (error) operation.reject(error);
      else operation.resolve(value);
    };
    try { Promise.resolve(start()).then((value) => finish(value), (error) => finish(null, error)); }
    catch (error) { finish(null, error); }
    return operation.promise;
  }

  /**
   * Effect adapter only: completion is returned to the session's private queue.
   * Progress and PURGED are never written here. Each retry uses the committed
   * first-incomplete step, inventory and original monotonic drain deadline.
   */
  performStep(step, stored, progress) {
    this.#stored = this.#checkedTombstone(stored);
    this.#tombstone = canonicalJson(this.#stored.document);
    if (this.#session.state !== 'PURGING' || this.#session.scope.tombstone !== 'purge') throw new AuthzError(409, 'Purge tombstone not applied');
    switch (step) {
      case 'begin': {
        const deadline = this.#clock.monotonicNow() + 10_000;
        if (!Number.isFinite(deadline)) throw new TypeError('Finite purge clock origin required');
        return deadline;
      }
      case 'inventory': {
        const artifacts = this.#artifacts();
        if (!Array.isArray(artifacts) || new Set(artifacts).size !== artifacts.length
            || artifacts.some((ref) => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(ref))) throw new TypeError('Host artifacts must be unique opaque references');
        return [...artifacts];
      }
      case 'drain': return this.#drain(progress.drainDeadline);
      case 'cache': return Promise.resolve(this.#purgeCache()).then(() => true);
      case 'acknowledgement': return withDeadline((signal) => this.#acknowledge(progress.receipt, { signal }),
        { clock: this.#clock, scheduler: this.#scheduler, deferOperation: false }).then(() => progress.receipt);
      default: throw new TypeError(`Unknown purge step ${step}`);
    }
  }

  async #drain(deadline) {
    const remaining = deadline - this.#clock.monotonicNow();
    if (remaining <= 0) return false;
    try {
      await withDeadline(() => this.#session.drain(), { clock: this.#clock, scheduler: this.#scheduler, milliseconds: remaining, deferOperation: false });
      return true;
    } catch (error) {
      if (!(error instanceof AuthzError) || error.status !== 504) throw error;
      return false; // Late provider output stays permanently discarded.
    }
  }
}
