import { createOutboundGate } from '../budget/gate.js';
import { BudgetError } from '../budget/port.js';
import { abortError, callSignal, checkAbort, limitsFor, speechError } from './common.js';

/** A single-slot rendezvous provides streaming backpressure without a queue.
 * Cancellation releases a paused producer even if the consumer never resumes.
 */
function channel(signal) {
  let slot, wake, ack, failure, ended = false;
  const notify = () => { wake?.(); wake = null; };
  const abort = () => { failure = abortError(signal); slot = undefined; ack?.(); notify(); };
  signal.addEventListener('abort', abort, { once: true });
  return {
    async push(value) {
      checkAbort(signal);
      const accepted = new Promise((resolve) => { ack = resolve; });
      slot = value; notify(); await accepted; checkAbort(signal);
    },
    finish(error) { failure ??= error; ended = true; notify(); },
    async next() {
      while (slot === undefined && !ended && !failure) await new Promise((resolve) => { wake = resolve; });
      if (failure) throw failure;
      if (slot !== undefined) { const value = slot; slot = undefined; ack?.(); ack = null; return { value, done: false }; }
      return { done: true };
    },
    close() { signal.removeEventListener('abort', abort); },
  };
}

/** All adapters (including zero-cost local ones) use the existing durable gate.
 * Config is operator-owned. Attempt ids come from the host's durable counter;
 * retrying a chargeable request requires a fresh id. No provider retries here.
 */
export class SpeechAttempt {
  constructor(config, lane, local = false) {
    if (!config || ['admit', 'claim', 'settle', 'recover', 'isCurrent', 'listOpen'].some((method) => typeof config.budget?.[method] !== 'function')) {
      throw new TypeError('Speech adapter requires a BudgetClient');
    }
    if (!Number.isSafeInteger(config.maxMicro) || config.maxMicro < 0 || (!local && config.maxMicro === 0)
        || !/^[A-Z]{3}$/.test(config.currency)) throw new TypeError('Invalid speech budget ceiling or currency');
    this.budget = config.budget;
    this.maxMicro = config.maxMicro;
    this.currency = config.currency;
    this.lane = lane;
    this.local = local;
    this.limits = limitsFor(config.limits);
    if (!local && typeof config.priceUsage !== 'function') throw new TypeError('Paid speech requires operator priceUsage returning a known final micro-cost');
    this.priceUsage = config.priceUsage;
  }

  async *run(request, prepare, open) {
    const cancel = new AbortController();
    const signal = callSignal(request.signal, cancel, this.limits);
    checkAbort(signal);
    const prepared = await prepare(signal); // snapshot and validate before admission
    checkAbort(signal);
    const authority = this.budget.authority;
    const attempt_id = request.executionContext?.attempt_id;
    if (typeof attempt_id !== 'string' || !attempt_id.startsWith(`${authority.sid}:${authority.gen}:${this.lane}:`)
        || !/^[1-9][0-9]{0,15}$/.test(attempt_id.split(':').at(-1))) throw new TypeError('Speech requires a host-assigned attempt_id');
    let hold;
    try {
      hold = await this.budget.admit({ attempt_id, sid: authority.sid, worker_generation: authority.gen,
        auth_epoch: authority.auth_epoch, lane: this.lane, max_micro: this.maxMicro, currency: this.currency,
        ...(this.local ? { lane_kind: 'operator_local' } : {}) });
      if (!hold?.hold_id || hold.closed_reason) throw new BudgetError(409, 'Speech hold is closed', 'hold_closed');
      checkAbort(signal);
    } catch (error) {
      // Abort after the acknowledged hold but before a claim voids it. Never
      // race admission against cancellation: a late reservation would leak.
      if (hold?.hold_id && !hold.closed_reason) {
        const current = this.budget.authority;
        await this.budget.recover({ hold_id: hold.hold_id, worker_generation: current.gen, auth_epoch: current.auth_epoch });
      }
      throw error;
    }
    const output = channel(signal);
    const dispatch = createOutboundGate({ budget: this.budget, open: async ({ bytes }) => {
      checkAbort(signal);
      const usage = await open(prepared, bytes, signal, async (chunk) => {
        checkAbort(signal);
        if (!await this.budget.isCurrent(authority)) throw speechError('authority_changed', 'Speech authority changed');
        checkAbort(signal);
        await output.push(chunk);
      });
      checkAbort(signal);
      // Match text lanes: operator pricing MUST know the final micro-cost.
      // If these units/provider usage cannot prove it, priceUsage throws and
      // the existing gate settles unknown at max. Never invent an actual cost.
      const actual_micro = this.local ? 0 : this.priceUsage(usage, this.lane);
      if (!Number.isSafeInteger(actual_micro) || actual_micro < 0 || actual_micro > this.maxMicro) {
        throw speechError('invalid_usage', 'Speech final cost is unknown or exceeds its hold');
      }
      checkAbort(signal);
      return { output: true, actual_micro };
    } });
    const task = dispatch({ hold_id: hold.hold_id, request_bytes: prepared.bytes }).then((result) => {
      if (result.discarded) throw speechError('authority_changed', 'Speech result discarded by the ledger');
    }).catch(async (error) => {
      // A duplicate caller does not own the committed attempt. Recovering its
      // hold here would close another caller's live stream and charge it early.
      if (error.code === 'already_claimed') throw error;
      // A refused claim leaves an unclaimed reservation. Recovery is safe and
      // idempotent after a committed claim too. Expose recovery failures.
      try {
        const current = this.budget.authority;
        await this.budget.recover({ hold_id: hold.hold_id, worker_generation: current.gen, auth_epoch: current.auth_epoch });
      } catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Speech attempt recovery failed'); }
      throw error;
    });
    task.then(() => output.finish(), (error) => output.finish(error));
    try {
      while (true) {
        const chunk = await output.next();
        if (chunk.done) break;
        checkAbort(signal);
        yield chunk.value;
      }
      await task;
      checkAbort(signal);
    } finally {
      cancel.abort(); // early iterator return is cancellation, not success
      try {
        await task; // cleanup/settlement completes before return
      } catch (error) {
        // Cancellation is expected on iterator.return(), but a failed ledger
        // settlement/recovery must remain visible to the caller for repair.
        if (error instanceof AggregateError) throw error;
      } finally { output.close(); }
    }
  }
}
