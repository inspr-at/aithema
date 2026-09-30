import { performance } from 'node:perf_hooks';
import { canExecute, loadContractFile, validate } from '../../contracts/validate.js';

export const capabilities = loadContractFile('capabilities.json');
export const systemClock = Object.freeze({ monotonicNow: () => performance.now(), wallNow: () => Date.now() });
export const systemScheduler = Object.freeze({ setTimeout, clearTimeout });

/** Catalogue codes only; ordinary authentication/transport failures have no code. */
export class AuthzError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'AuthzError';
    this.status = status;
    this.code = code;
  }
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function checkedDocument(contract, document, status = 400) {
  if (!document || document.contract !== contract) throw new AuthzError(status, `Expected ${contract}`);
  if (!canExecute(document).ok) throw new AuthzError(422, 'Unsupported contract reader version', 'contract_too_new');
  const result = validate(contract, document);
  if (!result.ok) throw new AuthzError(status, `Invalid ${contract}`);
  return document;
}

/** Every host request races its own timeout, even if the adapter ignores abort. */
export async function withDeadline(operation, {
  clock = systemClock, scheduler = systemScheduler,
  milliseconds = capabilities.authority.request_deadline_seconds * 1000, signal,
  deferOperation = true,
} = {}) {
  if (typeof operation !== 'function' || !Number.isFinite(milliseconds) || milliseconds <= 0) throw new TypeError('Operation and positive deadline required');
  const deadline = clock.monotonicNow() + milliseconds;
  if (!Number.isFinite(deadline)) throw new TypeError('Finite monotonic clock required');
  const controller = new AbortController();
  let timer;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new AuthzError(499, 'Host request cancelled');
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = scheduler.setTimeout(() => {
      const error = new AuthzError(504, 'Host request deadline exceeded');
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  try {
    if (controller.signal.aborted) return await cancelled;
    const run = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    };
    // Lifecycle effects invoke their adapters inside the draining event, after
    // installing the deadline. Their callbacks can only enqueue follow-ups.
    const result = await Promise.race([deferOperation ? Promise.resolve().then(run) : run(), cancelled]);
    if (controller.signal.aborted) throw controller.signal.reason;
    // Timers can be delayed by the event loop. A late promise must not win
    // simply because its microtask ran before the overdue timeout callback.
    if (clock.monotonicNow() >= deadline) {
      const error = new AuthzError(504, 'Host request deadline exceeded');
      controller.abort(error);
      throw error;
    }
    return result;
  } finally {
    if (timer !== undefined) scheduler.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
