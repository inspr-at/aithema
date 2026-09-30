import { loadContractFile } from '../../contracts/validate.js';

export const LATENCY_SCOPES = Object.freeze([
  'turn_to_reaction_token', 'reaction_first_audio', 'spec_pass', 'design_render', 'host_ack',
]);

const uuidPattern = new RegExp(loadContractFile('common.schema.json').$defs.uuid.pattern, 'u');

function sessionId(sid) {
  if (typeof sid !== 'string' || !uuidPattern.test(sid)) throw new TypeError('Latency session must be a contract UUID');
}

function scopeName(scope) {
  if (!LATENCY_SCOPES.includes(scope)) throw new TypeError('Unknown latency scope');
}

function capacity(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}

/** Nearest-rank percentiles of the retained window, never a lifetime estimate. */
function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
}

/**
 * Content-free, process-local measurements in milliseconds. Both completed
 * samples (globally, across all sessions) and open spans are bounded. Fixed
 * scope names and UUID session IDs prevent arbitrary text becoming labels.
 * No messages, metadata, error text, or wall-clock timestamps are retained.
 */
export class LatencyLedger {
  #now;
  #maxSamples;
  #maxSpans;
  #samples = [];
  #next = 0;
  #spans = new Map();
  #lastNow = null;

  constructor({ now = () => performance.now(), maxSamples = 1024, maxSpans = 128 } = {}) {
    if (typeof now !== 'function') throw new TypeError('A monotonic clock is required');
    capacity(maxSamples, 'maxSamples');
    capacity(maxSpans, 'maxSpans');
    this.#now = now;
    this.#maxSamples = maxSamples;
    this.#maxSpans = maxSpans;
  }

  get size() { return this.#samples.length; }
  get activeCount() { return this.#spans.size; }

  #time() {
    const value = this.#now();
    if (!Number.isFinite(value) || (this.#lastNow !== null && value < this.#lastNow)) {
      throw new RangeError('Latency clock must be finite and monotonic');
    }
    this.#lastNow = value;
    return value;
  }

  /** @param {string} sid @param {string} scope @returns {object} Opaque span handle. */
  start(sid, scope) {
    sessionId(sid);
    scopeName(scope);
    if (this.#spans.size >= this.#maxSpans) throw new RangeError('Open latency span bound reached');
    const handle = Object.freeze({});
    this.#spans.set(handle, { sid, scope, started: this.#time() });
    return handle;
  }

  /** Finish exactly once; a foreign, cancelled or already finished handle fails. */
  finish(handle) {
    const span = this.#spans.get(handle);
    if (!span) throw new TypeError('Unknown latency span');
    const duration = this.#time() - span.started;
    this.record(span.sid, span.scope, duration);
    this.#spans.delete(handle);
    return duration;
  }

  cancel(handle) {
    if (!this.#spans.delete(handle)) throw new TypeError('Unknown latency span');
  }

  /** Record a duration already measured by a caller's monotonic clock. */
  record(sid, scope, durationMs) {
    sessionId(sid);
    scopeName(scope);
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('Latency duration must be finite and nonnegative');
    }
    const sample = { sid, scope, duration_ms: durationMs };
    if (this.#samples.length < this.#maxSamples) this.#samples.push(sample);
    else this.#samples[this.#next] = sample;
    this.#next = (this.#next + 1) % this.#maxSamples;
  }

  /** Copies in measurement order; optional filters never create session state. */
  samples({ sid, scope } = {}) {
    if (sid !== undefined) sessionId(sid);
    if (scope !== undefined) scopeName(scope);
    const ordered = this.#samples.length < this.#maxSamples ? this.#samples
      : [...this.#samples.slice(this.#next), ...this.#samples.slice(0, this.#next)];
    return ordered.filter((s) => (sid === undefined || s.sid === sid) && (scope === undefined || s.scope === scope))
      .map((sample) => ({ ...sample }));
  }

  /** @returns {{count:number, p50_ms:number|null, p95_ms:number|null}} */
  stats(sid, scope) {
    sessionId(sid);
    scopeName(scope);
    const sorted = this.samples({ sid, scope }).map((s) => s.duration_ms).sort((a, b) => a - b);
    return { count: sorted.length, p50_ms: percentile(sorted, 0.5), p95_ms: percentile(sorted, 0.95) };
  }

  /** Session purge also invalidates its unfinished span handles. */
  clearSession(sid) {
    sessionId(sid);
    this.#samples = this.samples().filter((s) => s.sid !== sid);
    this.#next = this.#samples.length % this.#maxSamples;
    for (const [handle, span] of this.#spans) if (span.sid === sid) this.#spans.delete(handle);
  }
}
