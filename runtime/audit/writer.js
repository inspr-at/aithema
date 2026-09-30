import { randomUUID } from 'node:crypto';
import { validate } from '../../contracts/validate.js';
import { JournalError, decodeDocument } from '../journal/port.js';
import { checkedRecord } from '../journal/hydrate.js';

export const CRITICAL_RECORD_KINDS = Object.freeze([
  'authz.epoch', 'budget.hold', 'session.control', 'session.end', 'ui.confirm',
]);

const systemClock = Object.freeze({
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
});

function count(value, name, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new RangeError(`${name} must be a safe ${positive ? 'positive' : 'nonnegative'} integer`);
  }
}

/**
 * Pure reader descriptor. There is deliberately no inferred last sequence or
 * missing-record list: the previous generation's unacknowledged volatile tail
 * has no known upper bound and NO gap-detection guarantee.
 */
export function restartLoss(record) {
  if (!record || record.kind !== 'audit.restart' || !validate('aithema.journal.record', record).ok) {
    throw new JournalError(400, 'Expected a contract-valid audit.restart record');
  }
  if (record.data.generation === 1) return null;
  return {
    previous_generation: record.data.generation - 1,
    after_audit_seq: record.data.last_acked_audit_seq,
    possibly_lost: true, upper_bound: null, gap_detection: false,
  };
}

/**
 * One session and one immutable, VERIFIED authority per writer. A coordinator
 * supplies the current generation after takeover, then starts this writer
 * before dispatching any other worker writes. Host-only controls use a separate
 * host-authenticated writer; record JSON can never select or elevate its role.
 *
 * Every host call has a monotonic 10 s deadline by default. JournalPort cannot
 * cancel an append, so timeout/cancellation blocks this instance: the host may
 * still commit, but a late response must never run an effect. Recovery/takeover
 * belongs to the coordinator. Critical effects are NOT replayed automatically;
 * recovery and idempotency of effects remain the caller's responsibility.
 */
export class AuditWriter {
  #port;
  #authority;
  #wallNow;
  #uuid;
  #clock;
  #ackTimeoutMs;
  #maxPending;
  #pending = 0;
  #tail = Promise.resolve();
  #stop = new AbortController();
  #blocked = false;
  #started = false;
  #restartBytes = null;
  #lastAcked;
  #issued = 0;
  #loss = null;

  /**
   * @param {{port:import('../journal/port.js').JournalPort,
   *   authority:import('../journal/port.js').JournalAuthority,
   *   lastAckedAuditSeq?:number, now?:()=>number, uuid?:()=>string,
   *   clock?:{now:()=>number,setTimeout:Function,clearTimeout:Function},
   *   ackTimeoutMs?:number,maxPending?:number}} options
   */
  constructor({ port, authority, lastAckedAuditSeq = 0, now = () => Date.now(), uuid = randomUUID,
    clock = systemClock, ackTimeoutMs = 10_000, maxPending = 32 }) {
    if (!port || typeof port.append !== 'function' || typeof port.cursor !== 'function') {
      throw new TypeError('A JournalPort is required');
    }
    if (!authority || !['host', 'worker'].includes(authority.writer_kind)) {
      throw new TypeError('Audit requires verified host or worker authority');
    }
    count(authority.gen, 'generation', true);
    count(lastAckedAuditSeq, 'lastAckedAuditSeq');
    count(maxPending, 'maxPending', true);
    if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0 || ackTimeoutMs > 10_000) {
      throw new RangeError('ackTimeoutMs must be positive and at most 10000');
    }
    if (typeof now !== 'function' || typeof uuid !== 'function'
        || !clock || ['now', 'setTimeout', 'clearTimeout'].some((key) => typeof clock[key] !== 'function')) {
      throw new TypeError('Injectable wall clock, UUID generator and monotonic timer clock are required');
    }
    this.#port = port;
    this.#authority = structuredClone(authority);
    this.#wallNow = now;
    this.#uuid = uuid;
    this.#clock = clock;
    this.#ackTimeoutMs = ackTimeoutMs;
    this.#maxPending = maxPending;
    this.#lastAcked = lastAckedAuditSeq;
  }

  get authority() { return structuredClone(this.#authority); }
  get state() {
    return {
      generation: this.#authority.gen, started: this.#started,
      closed: this.#stop.signal.aborted, blocked: this.#blocked, pending: this.#pending,
      last_acked_audit_seq: this.#lastAcked, last_issued_audit_seq: this.#issued,
      possibly_lost_tail: this.#loss ? { ...this.#loss } : null,
    };
  }

  close() { this.#stop.abort(new JournalError(409, 'Audit writer is closed')); }

  #guard(signal) {
    if (this.#stop.signal.aborted) throw this.#stop.signal.reason;
    if (signal?.aborted) throw signal.reason;
    if (this.#blocked) throw new JournalError(503, 'Host acknowledgement is uncertain; a new worker generation is required');
  }

  #enqueue(operation, signal) {
    try {
      this.#guard(signal);
      if (this.#pending >= this.#maxPending) throw new JournalError(503, 'Audit pending bound reached');
    } catch (error) { return Promise.reject(error); }
    this.#pending++;
    const result = this.#tail.then(async () => {
      try {
        this.#guard(signal);
        return await operation();
      } finally { this.#pending--; }
    });
    // The caller owns the rejection; recovering the queue does not conceal it.
    this.#tail = result.catch(() => {});
    return result;
  }

  async #request(operation, signal) {
    this.#guard(signal);
    const combined = signal ? AbortSignal.any([signal, this.#stop.signal]) : this.#stop.signal;
    const started = this.#clock.now();
    if (!Number.isFinite(started)) throw new RangeError('Audit clock must be finite and monotonic');
    let timer;
    let abort;
    const failed = new Promise((_, reject) => {
      abort = () => {
        this.#blocked = true;
        reject(combined.reason);
      };
      combined.addEventListener('abort', abort, { once: true });
      timer = this.#clock.setTimeout(() => {
        this.#blocked = true;
        reject(new JournalError(504, 'Host acknowledgement deadline exceeded'));
      }, this.#ackTimeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => { this.#guard(signal); return operation(); }), failed,
      ]);
      this.#guard(signal);
      const elapsed = this.#clock.now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError('Audit clock must be finite and monotonic');
      // A synchronously blocked event loop can delay the timer callback.
      if (elapsed >= this.#ackTimeoutMs) {
        this.#blocked = true;
        throw new JournalError(504, 'Host acknowledgement deadline exceeded');
      }
      return result;
    } finally {
      this.#clock.clearTimeout(timer);
      combined.removeEventListener('abort', abort);
    }
  }

  #event(kind, data) {
    const doc = {
      contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
      sid: this.#authority.sid, client_event_id: this.#uuid(),
      writer: this.#authority.writer_kind === 'worker'
        ? { kind: 'worker', generation: this.#authority.gen } : { kind: 'host' },
      recorded_at: new Date(this.#wallNow()).toISOString(), kind, data: structuredClone(data),
    };
    if (!validate(doc.contract, doc).ok) throw new JournalError(400, 'Invalid audit journal record');
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    decodeDocument(bytes, { submission: true });
    return bytes;
  }

  async #send(bytes, signal) {
    const response = await this.#request(() => this.#port.append(Buffer.from(bytes), this.authority), signal);
    try {
      const checked = checkedRecord(response, this.#authority.sid);
      if (!checked.bytes.equals(bytes)) throw new Error('Changed acknowledgement bytes');
      return checked;
    } catch {
      throw new JournalError(502, 'Invalid audit acknowledgement');
    }
  }

  async #initialize(signal) {
    if (this.#started) return;
    const cursor = await this.#request(() => this.#port.cursor(this.authority), signal);
    if (!cursor || !Number.isSafeInteger(cursor.audit_seq) || cursor.audit_seq < 0
        || !Number.isSafeInteger(cursor.last_seq) || cursor.last_seq < 0) {
      throw new JournalError(502, 'Invalid audit cursor');
    }
    if (cursor.worker_generation !== this.#authority.gen) {
      throw new JournalError(409, 'Audit generation is fenced', 'fenced_generation');
    }
    if (cursor.auth_epoch !== this.#authority.auth_epoch) {
      throw new JournalError(409, 'Audit authority is revoked', 'revoked');
    }
    if (this.#lastAcked > cursor.audit_seq) throw new JournalError(400, 'Acknowledged audit cursor exceeds the host cursor');
    this.#issued = cursor.audit_seq;
    if (this.#authority.writer_kind === 'worker' && this.#authority.gen > 1) {
      // Retain exact bytes/id across a lost marker response; no event/effect
      // may pass initialization until the restart marker is acknowledged.
      this.#restartBytes ??= this.#event('audit.restart', {
        generation: this.#authority.gen, last_acked_audit_seq: this.#lastAcked,
      });
      const marker = await this.#send(this.#restartBytes, signal);
      this.#loss = restartLoss(marker.document);
      this.#restartBytes = null;
    }
    this.#started = true;
  }

  /** Fresh generation 1 needs no marker. Generations after takeover do. */
  start({ signal } = {}) {
    return this.#enqueue(async () => { await this.#initialize(signal); return this.state; }, signal);
  }

  /**
   * Record → await validated host ack → effect. No effect is scheduled on a
   * failed, timed-out, malformed, cancelled or crash-interrupted ack. The effect
   * receives the acknowledged immutable record's copied bytes and host seq.
   * Effects run outside the append queue so they may themselves await audit.
   */
  critical(kind, data, effect, { signal } = {}) {
    if (!CRITICAL_RECORD_KINDS.includes(kind)) throw new JournalError(400, 'Not a critical audit record kind');
    if (typeof effect !== 'function') throw new TypeError('A critical effect callback is required');
    const bytes = this.#event(kind, data);
    return this.#enqueue(async () => {
      await this.#initialize(signal);
      return this.#send(bytes, signal);
    }, signal).then(async (record) => {
      this.#guard(signal);
      const value = await effect(record);
      return { record, value };
    });
  }

  /**
   * Bounded, serialized best-effort audit. Valid events return an explicit
   * acknowledgement or failure; invalid input throws. A failed append leaves
   * its assigned number consumed locally. Dropped/unsent events and volatile
   * tail loss are possible; these numbers never promise gap detection.
   */
  bestEffort(data, { signal } = {}) {
    // Validate and copy at invocation, before a caller can mutate the event.
    const validated = decodeDocument(this.#event('audit.event', { ...data, audit_seq: 0 }), { submission: true });
    if (Object.hasOwn(data, 'audit_seq')) throw new JournalError(400, 'audit_seq is assigned by AuditWriter');
    let auditSeq = null;
    return this.#enqueue(async () => {
      await this.#initialize(signal);
      if (this.#issued === Number.MAX_SAFE_INTEGER) throw new JournalError(409, 'audit_seq exhausted');
      auditSeq = ++this.#issued;
      validated.data.audit_seq = auditSeq;
      const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
      const record = await this.#send(bytes, signal);
      this.#lastAcked = auditSeq;
      return { acked: true, audit_seq: auditSeq, record };
    }, signal).catch((error) => ({ acked: false, audit_seq: auditSeq, error }));
  }
}
