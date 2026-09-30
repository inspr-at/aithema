import { types } from 'node:util';

/** Non-enumerable proof that a public function uses the common boundary. */
export const BOUNDARY_WRAPPED = Symbol('aithema.lib.boundary');

// Preserve the input's freeze state for assertions about caller immutability.
// A frozen detached copy must not make a mutable caller baseline pass.
const originalFreezeState = new WeakMap();

/**
 * Inspect descriptors without invoking caller accessors, detach nested JSON
 * values, and freeze only the copy. Inspect hidden properties too, but copy
 * only enumerable data. Proxies, exotic prototypes, symbols/custom iterators,
 * sparse arrays, extra array properties and cycles are refused.
 * Patched built-in prototypes and manipulation of internal copies are outside
 * this plain-data boundary's threat model.
 * @template T
 * @param {T} value
 * @param {boolean} [preserveFreezeState]
 * @returns {T}
 */
function snapshot(value, preserveFreezeState = false) {
  const ancestors = new Set();
  const stringFields = new Set(['proposal_ref', 'supersedes_proposal_ref', 'op_key']);
  const invalid = (reason) => new TypeError(`plain-data snapshot: ${reason}`);
  /** @param {unknown} node */
  function copy(node) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw invalid('finite numbers required');
      return node;
    }
    if (typeof node !== 'object') throw invalid('JSON values required');
    if (types.isProxy(node)) throw invalid('proxies are not plain data');
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw invalid('plain objects and arrays required');
    }
    if (ancestors.has(node)) throw invalid('cycles are not JSON data');
    ancestors.add(node);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(node);
      const result = array ? [] : {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') throw invalid('symbol properties and custom iterators are not plain data');
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) throw invalid('accessors are not plain data');
        if (stringFields.has(key) && typeof descriptor.value !== 'string') {
          throw invalid(`stream ${key} is invalid; primitive string required`);
        }
        const child = copy(descriptor.value);
        if (!descriptor.enumerable) continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length.value)) {
          throw invalid('extra array properties are not JSON data');
        }
        Object.defineProperty(result, key, {
          value: child, enumerable: true, configurable: true, writable: true,
        });
      }
      if (array && (result.length !== descriptors.length.value
        || Object.keys(result).length !== descriptors.length.value)) {
        throw invalid('sparse arrays are not JSON data');
      }
      originalFreezeState.set(result, preserveFreezeState
        ? originalFreezeState.get(node) ?? Object.isFrozen(node) : Object.isFrozen(node));
      return Object.freeze(result);
    } finally {
      ancestors.delete(node);
    }
  }
  return copy(value);
}

/**
 * Normalise every argument before entering the implementation. Primitives
 * pass through, including omitted optional arguments. Functions are refused
 * unless that API explicitly lists their zero-based argument positions.
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @param {{ functionArgs?: readonly number[], preserveFreezeState?: boolean }} [options]
 * @returns {T}
 */
function boundaryImpl(fn, { functionArgs = [], preserveFreezeState = false } = {}) {
  if (typeof fn !== 'function') throw new TypeError('boundary requires a function');
  if (!Array.isArray(functionArgs) || functionArgs.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new TypeError('boundary functionArgs must list non-negative argument indices');
  }
  if (typeof preserveFreezeState !== 'boolean') throw new TypeError('boundary preserveFreezeState must be boolean');
  const allowedFunctions = new Set(functionArgs);
  const wrapped = (...args) => {
    const normalized = args.map((value, index) => {
      if (typeof value === 'function') {
        if (!allowedFunctions.has(index)) throw new TypeError('plain-data snapshot: function argument is not allowed');
        return value;
      }
      return value !== null && typeof value === 'object' ? snapshot(value, preserveFreezeState) : value;
    });
    return fn(...normalized);
  };
  Object.defineProperty(wrapped, BOUNDARY_WRAPPED, { value: true });
  return /** @type {T} */ (wrapped);
}

// Bootstrap the factory through the same boundary. Its implementation function
// is the only function argument allowed by any current library API.
export const boundary = boundaryImpl(boundaryImpl, { functionArgs: [0] });

/** @template T @param {T} value @returns {T} */
function plainDataSnapshotImpl(value) {
  return snapshot(value);
}

export const plainDataSnapshot = boundary(plainDataSnapshotImpl);

/** @param {object} value */
function inputWasFrozenImpl(value) {
  return originalFreezeState.get(value) ?? Object.isFrozen(value);
}

// Only this metadata query carries freeze state within an implementation.
// Every ordinary API starts again from the caller's actual freeze state, so a
// returned frozen snapshot is subsequently treated as an immutable input.
export const inputWasFrozen = boundary(inputWasFrozenImpl, { preserveFreezeState: true });
