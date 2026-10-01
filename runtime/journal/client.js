import { randomUUID } from 'node:crypto';
import { canonicalJson, pendingContentReference } from '../../contracts/validate.js';
import { JournalError, decodeDocument, submissionBytes } from './port.js';
import { checkedRecord, hydrateSnapshot } from './hydrate.js';

/**
 * Engine client. An unavailable host retains exact unacknowledged submissions;
 * the engine must stop paid scheduling while state is CAPTURE_ONLY/ENDED.
 * This cache is volatile; the host journal is the only durable authority.
 * Browser buffers/audio and authority polling are separate AIT-P05/P07 lanes.
 */
export class JournalClient {
  #port;
  #authority;
  #now;
  #uuid;
  #pending = new Map();
  #exportOnly = new Map();
  #captured = [];
  #unavailableSince = null;
  #captureOnly = false;
  #busy = false;

  constructor({ port, authority, now = () => Date.now(), uuid = randomUUID }) {
    this.#port = port;
    this.#authority = structuredClone(authority);
    this.#now = now;
    this.#uuid = uuid;
  }

  get authority() { return structuredClone(this.#authority); }
  get state() {
    if (this.#unavailableSince !== null && this.#now() - this.#unavailableSince >= 600_000) return 'ENDED';
    return this.#captureOnly ? 'CAPTURE_ONLY' : 'ACTIVE';
  }

  #event(kind, data) {
    return Buffer.from(JSON.stringify({
      contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
      sid: this.#authority.sid, client_event_id: this.#uuid(),
      writer: { kind: 'worker', generation: this.#authority.gen },
      recorded_at: new Date(this.#now()).toISOString(), kind, data,
    }), 'utf8');
  }

  #remember(bytes, doc) {
    const refused = this.#exportOnly.get(doc.client_event_id);
    if (refused) {
      if (!refused.bytes.equals(bytes)) throw new JournalError(409, 'Export event id has different bytes', 'idempotency_conflict');
      throw new JournalError(refused.refusal.status, refused.refusal.message, refused.refusal.code);
    }
    const existing = this.#pending.get(doc.client_event_id);
    if (existing) {
      if (!existing.bytes.equals(bytes)) throw new JournalError(409, 'Pending event id has different bytes', 'idempotency_conflict');
      return;
    }
    const kind = doc.contract === 'aithema.spec.snapshot' ? 'spec.snapshot' : doc.kind;
    const captured = this.#captured.find((p) => decodeDocument(p.bytes).client_event_id === doc.client_event_id);
    if (captured && !captured.bytes.equals(bytes)) {
      throw new JournalError(409, 'Captured event id has different bytes', 'idempotency_conflict');
    }
    const limits = { turn: 5, source: 1, 'spec.snapshot': 1 };
    const retained = [...this.#pending.values(), ...this.#exportOnly.values()];
    const count = (captured ? [...this.#pending.values()] : retained).filter((p) => p.kind === kind).length;
    // Other records have a bounded combined queue as well; no unbounded audit tail.
    // Captured text already passed the separate 20-turn/byte bound; moving it
    // into the send/export queue does not add another retained submission.
    if ((limits[kind] !== undefined && count >= limits[kind]) || retained.length >= 32) {
      this.#captureOnly = true;
      throw new JournalError(503, 'Unacknowledged journal bound reached; retain new text with captureTurn()');
    }
    this.#pending.set(doc.client_event_id, { bytes: Buffer.from(bytes), kind });
  }

  #clearOutageWhenDrained() {
    if (this.#pending.size === 0 && this.#captured.length === 0) {
      this.#unavailableSince = null;
      this.#captureOnly = false;
    }
  }

  async #send(bytes, doc) {
    let response;
    try {
      response = await this.#port.append(Buffer.from(bytes), this.authority);
    } catch (error) {
      if (error instanceof JournalError && error.status < 500) {
        this.#pending.delete(doc.client_event_id);
        // Refused person/source bytes were never acknowledged. Keep them for
        // export, separately from the queue that flush() may send again.
        if (doc.kind === 'source' || (doc.kind === 'turn' && doc.data.speaker === 'person')) {
          this.#exportOnly.set(doc.client_event_id, {
            bytes: Buffer.from(bytes), kind: doc.kind,
            refusal: { status: error.status, message: error.message, code: error.code },
          });
        }
        this.#captured = this.#captured.filter((p) => decodeDocument(p.bytes).client_event_id !== doc.client_event_id);
        this.#clearOutageWhenDrained();
        throw error; // terminal contract/fencing refusals are surfaced, never retried
      }
      this.#unavailableSince ??= this.#now();
      throw error;
    }
    let result;
    try {
      result = checkedRecord(response, this.#authority.sid);
      if (!result.bytes.equals(bytes)) throw new Error('Acknowledgement changed submission bytes');
    } catch {
      // A malformed response is NOT a definitive host refusal. The append may
      // have committed: keep original bytes/id so retry can recover its seq.
      this.#unavailableSince ??= this.#now();
      throw new JournalError(502, 'Invalid journal acknowledgement; original submission retained');
    }
    this.#pending.delete(doc.client_event_id);
    this.#clearOutageWhenDrained();
    return result;
  }

  async append(bytes) {
    if (this.state === 'ENDED') throw new JournalError(409, 'Journal outage ended the session; export available');
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original, { submission: true });
    if (doc.sid !== this.#authority.sid || doc.contract === 'aithema.session.create') throw new JournalError(400, 'Wrong journal submission');
    this.#remember(original, doc);
    return this.#send(original, doc);
  }

  /** Retry only identical pending bytes; no provider or intake calls here. */
  async flush() {
    if (this.state === 'ENDED') throw new JournalError(409, 'Journal outage ended the session; export available');
    const results = [];
    for (const { bytes } of [...this.#pending.values()]) results.push(await this.#send(bytes, decodeDocument(bytes)));
    while (this.#captured.length) {
      const { bytes } = this.#captured[0];
      results.push(await this.append(bytes));
      this.#captured.shift();
    }
    this.#clearOutageWhenDrained();
    return results;
  }

  /** Worker text buffer: max 20 turns INCLUDING unacked turns, max 256 KiB. */
  captureTurn(bytes) {
    if (this.state !== 'CAPTURE_ONLY') throw new JournalError(409, 'Text capture requires CAPTURE_ONLY');
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original, { submission: true });
    if (doc.sid !== this.#authority.sid || doc.kind !== 'turn' || doc.data.channel !== 'text' || doc.data.speaker !== 'person') {
      throw new JournalError(400, 'Capture buffer accepts only person text turns in this session');
    }
    const all = [...this.#pending.values(), ...this.#exportOnly.values(), ...this.#captured];
    const existing = all.find((p) => decodeDocument(p.bytes).client_event_id === doc.client_event_id);
    if (existing) {
      if (!existing.bytes.equals(original)) throw new JournalError(409, 'Captured event id has different bytes', 'idempotency_conflict');
      return;
    }
    const turns = all.filter((p) => decodeDocument(p.bytes).kind === 'turn');
    if (turns.length >= 20 || turns.reduce((n, p) => n + p.bytes.length, 0) + original.length > 256 * 1024) {
      throw new JournalError(413, 'Worker text capture buffer is full');
    }
    this.#captured.push({ bytes: original });
  }

  /** Includes export-only refusals, pending bodies and captured text; no lossy projection. */
  exportUnacknowledged() {
    return {
      state: this.state,
      unacknowledged: [...this.#pending.values(), ...this.#exportOnly.values()].map((p) => Buffer.from(p.bytes)),
      captured_turns: this.#captured.map((p) => Buffer.from(p.bytes)),
    };
  }

  /**
   * Take over → audit marker → hydrate/validate → replay → retry intake ops.
   * retryOp receives the ORIGINAL payload bytes and the exact per-op key.
   * The engine removes completed ops in its next full snapshot.
   */
  async resume({ retryOp, lastAckedAuditSeq = 0 } = {}) {
    if (this.state === 'ENDED') throw new JournalError(409, 'Journal outage ended the session; export available');
    if (this.#busy) throw new JournalError(409, 'Resume is already running');
    if (this.#pending.size || this.#captured.length) throw new JournalError(409, 'Export or flush the volatile cache before takeover');
    this.#busy = true;
    try {
      const cursor = await this.#port.takeover(this.authority);
      this.#authority.gen = cursor.worker_generation;
      await this.append(this.#event('audit.restart', {
        generation: cursor.worker_generation, last_acked_audit_seq: lastAckedAuditSeq,
      }));
      const closure = await hydrateSnapshot(this.#port, cursor.snapshot, this.authority);
      const snapshot = cursor.snapshot ? checkedRecord(cursor.snapshot, this.#authority.sid).document : null;
      const replay = (await this.#port.recordsAfter(snapshot?.consumed_seq ?? 0, this.authority, cursor.last_seq))
        .map((record) => checkedRecord(record, this.#authority.sid))
        .filter((record) => record.document.contract === 'aithema.journal.record');
      const completedOps = new Map();
      for (const { document } of replay) {
        if (document.kind !== 'op.result') continue;
        const { op_key, host_ids } = document.data;
        if (completedOps.has(op_key) && canonicalJson(completedOps.get(op_key)) !== canonicalJson(host_ids)) {
          throw new JournalError(409, 'Same op_key has different host_ids', 'idempotency_conflict');
        }
        completedOps.set(op_key, host_ids);
      }
      for (const op of snapshot?.pending_ops ?? []) {
        if (completedOps.has(op.op_key)) continue;
        if (typeof retryOp !== 'function') throw new JournalError(409, 'Pending intake operations require retryOp');
        const content = op.payload_kind === 'pending_op.content'
          ? { content_record: closure.get(pendingContentReference(op.payload).record_seq) } : {};
        const host_ids = await retryOp({ ...op, payload_bytes: Buffer.from(op.payload, 'utf8'), ...content }, this.authority);
        // A malformed result fails validation; never pretend an intake op finished.
        await this.append(this.#event('op.result', { op_key: op.op_key, host_ids }));
        completedOps.set(op.op_key, host_ids);
      }
      return { cursor, snapshot, closure, replay, completedOps };
    } finally { this.#busy = false; }
  }
}
