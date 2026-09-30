import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../contracts/validate.js';
import { AuthzError, checkedDocument, freeze, systemClock, systemScheduler, withDeadline } from './common.js';
import { hostRecord } from './session.js';

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
  #ack;
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

  purge({ authority, reason, clientEventId = randomUUID() }) {
    if (this.#busy) return this.#busy;
    if (!authority || authority.writer_kind !== 'host') throw new AuthzError(403, 'Only the host may tombstone a session');
    if (!this.#submission) {
      const document = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: this.#session.scope.sid, client_event_id: clientEventId, writer: { kind: 'host' },
        recorded_at: new Date(this.#clock.wallNow()).toISOString(), kind: 'session.control',
        data: { action: 'purge', ...(reason === undefined ? {} : { reason }) } };
      checkedDocument(document.contract, document);
      this.#submission = Buffer.from(canonicalJson(document));
    }
    this.#busy = (async () => {
      this.#stored ??= await withDeadline((signal) => this.#journal.append(Buffer.from(this.#submission), authority, { signal }),
        { clock: this.#clock, scheduler: this.#scheduler });
      const document = hostRecord(this.#stored, this.#session.scope.sid);
      const { seq, ...original } = document;
      if (canonicalJson(original) !== this.#submission.toString('utf8')) throw new AuthzError(502, 'Purge acknowledgement changed submission');
      return this.#complete(this.#stored);
    })().finally(() => { this.#busy = null; });
    return this.#busy;
  }

  complete(stored) {
    if (this.#busy) return this.#busy;
    this.#busy = this.#complete(stored).finally(() => { this.#busy = null; });
    return this.#busy;
  }

  async #complete(stored) {
    const document = hostRecord(stored, this.#session.scope.sid);
    if (document.kind !== 'session.control' || document.data.action !== 'purge' || document.writer.kind !== 'host') {
      throw new AuthzError(403, 'Purge requires an acknowledged host tombstone');
    }
    const fingerprint = canonicalJson(document);
    if (this.#tombstone && this.#tombstone !== fingerprint) throw new AuthzError(409, 'Different purge tombstone');
    this.#tombstone = fingerprint;
    if (!this.#ack) {
      this.#session.consumeStoredRecord(stored);
      if (this.#session.state !== 'PURGING') throw new AuthzError(409, 'Purge tombstone not applied');
      const artifacts = this.#artifacts(); // Capture refs before deleting the local cache.
      if (!Array.isArray(artifacts) || new Set(artifacts).size !== artifacts.length
          || artifacts.some((ref) => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(ref))) {
        throw new TypeError('Host artifacts must be unique opaque references');
      }
      let drained = true;
      try {
        await withDeadline(() => this.#session.drain(), { clock: this.#clock, scheduler: this.#scheduler, milliseconds: 10_000 });
      } catch (error) {
        if (!(error instanceof AuthzError) || error.status !== 504) throw error;
        drained = false; // Provider work may finish later; output remains permanently discarded.
      }
      await this.#purgeCache(); // Failure leaves PURGING; never acknowledge incomplete deletion.
      this.#session.markPurged();
      this.#ack = freeze({ sid: document.sid, tombstone_seq: document.seq, drained, host_artifacts: [...artifacts] });
    }
    await withDeadline((signal) => this.#acknowledge(this.#ack, { signal }), { clock: this.#clock, scheduler: this.#scheduler });
    return this.#ack;
  }
}
