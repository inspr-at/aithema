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
  #artifactsSnapshot;
  #drainDeadline;
  #drained;

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
    const document = hostRecord(stored, this.#session.scope.sid);
    if (document.kind !== 'session.control' || document.data.action !== 'purge' || document.writer.kind !== 'host') {
      throw new AuthzError(403, 'Purge requires an acknowledged host tombstone');
    }
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
    this.#busy = (async () => {
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
      return this.#complete(this.#stored);
    })().finally(() => { this.#busy = null; });
    return this.#busy;
  }

  complete(stored) {
    // Validate callback bytes even while another caller drains or acknowledges.
    // Coalescing must not turn a foreign/changed receipt into a successful purge.
    let checked;
    try { checked = this.#checkedTombstone(stored); }
    catch (error) { return Promise.reject(error); }
    if (this.#busy) return this.#busy;
    this.#busy = this.#complete(checked).finally(() => { this.#busy = null; });
    return this.#busy;
  }

  async #complete(stored) {
    this.#stored = this.#checkedTombstone(stored);
    const { document } = this.#stored;
    this.#tombstone = canonicalJson(document);
    if (!this.#ack) {
      this.#session.consumeStoredRecord(stored);
      if (!['PURGING', 'ENDED'].includes(this.#session.state) || this.#session.scope.tombstone !== 'purge') throw new AuthzError(409, 'Purge tombstone not applied');
      this.#drainDeadline ??= this.#clock.monotonicNow() + 10_000;
      if (!this.#artifactsSnapshot) {
        const artifacts = this.#artifacts(); // Retain refs through partial cache deletion and retries.
        if (!Array.isArray(artifacts) || new Set(artifacts).size !== artifacts.length
            || artifacts.some((ref) => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(ref))) {
          throw new TypeError('Host artifacts must be unique opaque references');
        }
        this.#artifactsSnapshot = [...artifacts];
      }
      if (this.#drained === undefined) {
        const remaining = this.#drainDeadline - this.#clock.monotonicNow();
        if (remaining <= 0) this.#drained = false;
        else {
          try {
            await withDeadline(() => this.#session.drain(), { clock: this.#clock, scheduler: this.#scheduler, milliseconds: remaining });
            this.#drained = true;
          } catch (error) {
            if (!(error instanceof AuthzError) || error.status !== 504) throw error;
            this.#drained = false; // Late provider output stays permanently discarded.
          }
        }
      }
      await this.#purgeCache(); // Failure leaves PURGING; never acknowledge incomplete deletion.
      this.#session.markPurged();
      this.#ack = freeze({ sid: document.sid, tombstone_seq: document.seq, drained: this.#drained, host_artifacts: [...this.#artifactsSnapshot] });
    }
    if (!this.#session.purgeAcknowledged) {
      await withDeadline((signal) => this.#acknowledge(this.#ack, { signal }), { clock: this.#clock, scheduler: this.#scheduler });
      this.#session.markPurgeAcknowledged();
    }
    return this.#ack;
  }
}
