import { plainDataSnapshot } from '../../lib/boundary.js';
import { loadContractFile } from '../../contracts/validate.js';

const hostCodes = new Set(loadContractFile('error-codes.json').codes.map((row) => row.code));

/** Runtime failures keep foundation codes; engine-local reasons are not host codes. */
export class EngineError extends Error {
  constructor(reason, message, { cause, code = null, status = 400 } = {}) {
    super(message, { cause });
    this.name = 'EngineError';
    this.reason = reason;
    this.code = code;
    this.status = status;
  }
}

export function normalizeError(error) {
  return error instanceof EngineError ? error : new EngineError('operation_failed', 'Engine operation failed', {
    cause: error, code: hostCodes.has(error?.code) ? error.code : null,
    status: Number.isInteger(error?.status) ? error.status : 500,
  });
}

/** Normalize synchronous and asynchronous public runtime entry points. */
export function runtimeCall(fn) {
  try {
    const value = fn();
    return value && typeof value.then === 'function' ? value.catch((error) => { throw normalizeError(error); }) : value;
  } catch (error) { throw normalizeError(error); }
}

export const systemClock = Object.freeze({
  now: () => performance.now(), wallNow: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
});

export function checkClock(clock) {
  if (['now', 'wallNow', 'setTimeout', 'clearTimeout'].some((key) => typeof clock?.[key] !== 'function')) {
    throw new EngineError('invalid_clock', 'Injectable monotonic clock, wall clock and timers required');
  }
}

export function json(value) { return plainDataSnapshot(value); }

export function exactKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(value, key))) {
    throw new EngineError('invalid_output', 'Structured engine output has missing or unknown fields', { status: 422 });
  }
}

export function ref(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
