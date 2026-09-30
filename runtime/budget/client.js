import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, validate } from '../../contracts/validate.js';
import { checkedRecord } from '../journal/hydrate.js';
import { BudgetError, checkMessage, encodeMessage, findOpenHold, openHoldPages, requireSuccess } from './port.js';

/** Namespaced UUIDv8: one critical hold event per caller-assigned attempt. */
function holdEventId(attemptId) {
  const bytes = createHash('sha256').update(`aithema.budget.hold:${attemptId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Engine client. A retry of a transport admission uses the same attempt_id;
 * a potentially chargeable provider retry uses a NEW counter/hold/claim. The
 * caller owns counters (including across engine restarts); this client never
 * guesses a durable counter or silently retries a claim/provider request.
 */
export class BudgetClient {
  #port;
  #journal;
  #authority;
  #now;
  #paidState = 'ACTIVE';
  #auditErrors = [];
  #claimHolds = new Map();

  constructor({ port, journal, authority, now = () => Date.now() }) {
    for (const method of ['admit', 'claim', 'settle', 'recover', 'listOpen', 'isCurrent']) {
      if (typeof port?.[method] !== 'function') throw new TypeError(`BudgetPort requires ${method}`);
    }
    if (typeof journal?.append !== 'function') throw new TypeError('BudgetClient requires JournalPort.append');
    this.#port = port;
    this.#journal = journal;
    this.#authority = structuredClone(authority);
    this.#now = now;
  }

  get authority() { return structuredClone(this.#authority); }
  get paidState() { return this.#paidState; }
  get textCaptureAllowed() { return true; } // Budget ceilings never govern free text capture.
  get auditErrors() { return [...this.#auditErrors]; }

  setAuthority(authority) {
    if (['sid', 'tid', 'pid'].some((key) => authority?.[key] !== this.#authority[key])) {
      throw new BudgetError(403, 'Budget client cannot change session scope');
    }
    this.#authority = structuredClone(authority);
  }

  async #record(kind, data, authority, critical = false) {
    try {
      const doc = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: authority.sid, client_event_id: critical ? holdEventId(data.attempt_id) : randomUUID(),
        writer: { kind: 'worker', generation: authority.gen },
        recorded_at: new Date(this.#now()).toISOString(), kind, data };
      if (!validate(doc.contract, doc).ok) throw new BudgetError(400, 'Invalid budget journal record');
      let original = Buffer.from(canonicalJson(doc));
      let stored;
      try {
        stored = checkedRecord(await this.#journal.append(Buffer.from(original), structuredClone(authority)), authority.sid);
      } catch (error) {
        if (!critical || error.code !== 'idempotency_conflict') throw error;
        // A restart or advancing clock changes recorded_at. Read the existing
        // durable event rather than overwriting it or inventing another id.
        if (typeof this.#journal.recordsAfter !== 'function') {
          throw new BudgetError(502, 'JournalPort.recordsAfter is required to resolve a hold event retry');
        }
        const records = await this.#journal.recordsAfter(0, structuredClone(authority));
        if (!Array.isArray(records)) throw new BudgetError(502, 'Journal returned no hold retry records');
        const matches = records.filter((row) => row?.document?.client_event_id === doc.client_event_id);
        if (matches.length !== 1) throw new BudgetError(502, 'Journal did not return exactly one existing hold event');
        stored = checkedRecord(matches[0], authority.sid);
        const { recorded_at: priorTime, seq, ...prior } = stored.document;
        const { recorded_at: newTime, ...submitted } = doc;
        if (canonicalJson(prior) !== canonicalJson(submitted)) {
          throw new BudgetError(409, 'Existing hold event has different content', 'idempotency_conflict');
        }
        original = stored.bytes;
      }
      if (!stored.bytes.equals(original)) throw new BudgetError(502, 'Journal acknowledgement changed budget record bytes');
    } catch (error) {
      if (critical) throw error;
      // Claim/settle audit is best-effort (§3.5). A failed journal write MUST
      // NOT undo a committed claim or block its send. Expose every failure;
      // the ledger, not this audit tail, drives accounting and recovery.
      this.#auditErrors.push(error);
    }
  }

  async admit(body) {
    const original = encodeMessage('admit_request', body);
    const authority = this.authority;
    let result;
    try { result = requireSuccess(await this.#port.admit(original, authority), 'admit_response'); }
    catch (error) {
      if (error.code === 'budget_denied') this.#paidState = 'BUDGET_DENIED';
      throw error;
    }
    const submitted = JSON.parse(original).body;
    await this.#record('budget.hold', { hold_id: result.hold_id, attempt_id: submitted.attempt_id,
      lane: submitted.lane, max_micro: submitted.max_micro, currency: submitted.currency }, authority, true);
    // Recovery can close the reservation while its critical journal ack is
    // in flight. Only the ledger may decide whether it remains open.
    // Paid lanes resume only when that post-ack check still shows the hold.
    if (await findOpenHold((query) => this.#listOpen(query, authority), result.hold_id)) {
      this.#paidState = 'ACTIVE';
      return result;
    }
    return this.recover({ hold_id: result.hold_id, worker_generation: this.#authority.gen, auth_epoch: this.#authority.auth_epoch });
  }

  async claim(body) {
    const original = encodeMessage('claim_request', body);
    const submitted = JSON.parse(original).body;
    const authority = this.authority;
    const result = requireSuccess(await this.#port.claim(original, authority), 'claim_response');
    if (this.#claimHolds.has(result.claim_id)) throw new BudgetError(502, 'Ledger returned a previously issued claim_id');
    this.#claimHolds.set(result.claim_id, submitted.hold_id);
    await this.#record('budget.claim', { hold_id: submitted.hold_id, claim_id: result.claim_id,
      request_sha256: submitted.request_sha256 }, authority);
    return result;
  }

  async settle(body, authority = this.authority) {
    const original = encodeMessage('settle_request', body);
    const submitted = JSON.parse(original).body;
    authority = structuredClone(authority);
    const result = requireSuccess(await this.#port.settle(original, authority), 'recover_response');
    if (result.closed_reason === 'void' || (this.#claimHolds.has(submitted.claim_id) &&
        result.hold_id !== this.#claimHolds.get(submitted.claim_id))) {
      throw new BudgetError(502, 'Ledger settlement does not match the committed claim');
    }
    await this.#record('budget.settle', { hold_id: result.hold_id, claim_id: submitted.claim_id,
      outcome: result.closed_reason, charged_micro: result.charged_micro }, authority);
    return result;
  }

  async recover(body) {
    const original = encodeMessage('recover_request', body);
    const submitted = JSON.parse(original).body;
    const result = requireSuccess(await this.#port.recover(original, this.authority), 'recover_response');
    if (result.hold_id !== submitted.hold_id) throw new BudgetError(502, 'Ledger recovery does not match the requested hold');
    return result;
  }

  async #listOpen(query, authority) {
    const response = checkMessage(await this.#port.listOpen({ ...query }, structuredClone(authority)), 'holds_list');
    if (response.body.sid !== authority.sid) throw new BudgetError(502, 'Ledger enumeration belongs to another session');
    return response.body;
  }

  async listOpen(query = {}) { return this.#listOpen(query, this.authority); }

  /** Batch-and-drain from the LEDGER. Journal absence never hides a hold. */
  async recoverOpen({ limit = 1000 } = {}) {
    const settlements = [];
    for await (const page of openHoldPages((query) => this.listOpen(query), { limit })) {
      for (const hold of page.holds) {
        const authority = this.authority;
        settlements.push(await this.recover({ hold_id: hold.hold_id,
          worker_generation: authority.gen, auth_epoch: authority.auth_epoch }));
      }
    }
    return settlements;
  }

  async isCurrent(authority = this.authority) {
    const current = await this.#port.isCurrent(structuredClone(authority));
    if (typeof current !== 'boolean') throw new BudgetError(502, 'Invalid ledger authority result');
    return current;
  }
}
