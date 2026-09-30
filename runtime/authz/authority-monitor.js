import { AuthzError, capabilities, systemClock, systemScheduler, withDeadline } from './common.js';

const timing = capabilities.authority;

/**
 * @typedef {{tid:string, pid:string, sid:string, worker_generation:number,
 *   auth_epoch:number, issued_at:string, tombstone:null|'suspend'|'purge'}} AuthoritySnapshot
 * Authority response is transport metadata, not a new foundation document.
 */
function checkedAuthority(value, scope, wallNow) {
  if (!value || ['tid', 'pid', 'sid'].some((key) => value[key] !== scope[key])
      || !Number.isSafeInteger(value.worker_generation) || value.worker_generation < 1
      || !Number.isSafeInteger(value.auth_epoch) || value.auth_epoch < 1
      || ![null, 'suspend', 'purge'].includes(value.tombstone)) throw new AuthzError(502, 'Invalid host authority response');
  const match = typeof value.issued_at === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value.issued_at);
  const issued = match ? Date.parse(value.issued_at) : NaN;
  if (!Number.isFinite(issued) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
      || new Date(issued).getUTCFullYear() !== Number(match[1])
      || new Date(issued).getUTCMonth() + 1 !== Number(match[2]) || new Date(issued).getUTCDate() !== Number(match[3])
      || issued > wallNow || wallNow - issued > timing.stale_after_seconds * 1000) {
    throw new AuthzError(503, 'Authority issued_at is invalid, future or stale');
  }
  return { authority: structuredClone(value), issued };
}

/**
 * Poll at start + n*30s, never completion + 30s. Duration accounting uses one
 * monotonic origin; issued_at is mapped onto it using the wall clock captured
 * at start. Subsequent local wall-clock adjustments cannot reset the bounds.
 * fetchAuthority is a HOST adapter: send cache: no-store and honour signal.
 * JournalPort itself has no authority endpoint; do not infer it from cursor.
 */
export class AuthorityMonitor {
  #session;
  #fetch;
  #clock;
  #scheduler;
  #onError;
  #origin;
  #wallOrigin;
  #lastAuthority;
  #lastIssued = -Infinity;
  #failures = 0;
  #running = false;
  #pollTimer;
  #endTimer;
  #freshnessTimer;
  #request = new AbortController();
  #lastError = null;

  constructor({ session, fetchAuthority, clock = systemClock, scheduler = systemScheduler, onError = () => {} }) {
    if (typeof fetchAuthority !== 'function') throw new TypeError('Host authority adapter required');
    this.#session = session;
    this.#fetch = fetchAuthority;
    this.#clock = clock;
    this.#scheduler = scheduler;
    this.#onError = onError;
  }

  get lastError() { return this.#lastError; }
  get consecutiveFailures() { return this.#failures; }
  get lastAuthorityMonotonic() { return this.#lastAuthority; }

  start() {
    if (this.#origin !== undefined) throw new AuthzError(409, 'Authority monitor already started');
    this.#origin = this.#clock.monotonicNow();
    this.#wallOrigin = this.#clock.wallNow();
    if (!Number.isFinite(this.#origin) || !Number.isFinite(this.#wallOrigin)) throw new TypeError('Finite clock origins required');
    this.#lastAuthority = this.#origin;
    this.#running = true;
    this.#scheduleEnd();
    this.#scheduleFreshness();
    this.#schedulePoll(0);
  }

  stop() {
    this.#running = false;
    this.#scheduler.clearTimeout(this.#pollTimer);
    this.#scheduler.clearTimeout(this.#endTimer);
    this.#scheduler.clearTimeout(this.#freshnessTimer);
    this.#request.abort(new AuthzError(499, 'Authority monitor stopped'));
  }

  /** Authenticated host revoke callback accelerates polling; never resets its origin. */
  revoke(epoch) { this.#session.revoke(epoch); }

  #scheduleFreshness() {
    this.#scheduler.clearTimeout(this.#freshnessTimer);
    // A replay still within the 30s freshness window must not postpone the
    // outage bound. Only issued_at, never response arrival, renews this lease.
    const deadline = this.#lastAuthority + (timing.revocation_outage_max_seconds - timing.stop_allowance_seconds) * 1000;
    this.#freshnessTimer = this.#scheduler.setTimeout(() => {
      if (this.#running) this.#session.captureOnly(new AuthzError(503, 'Authority freshness lease expired'));
    }, Math.max(0, deadline - this.#clock.monotonicNow()));
  }

  #scheduleEnd() {
    this.#scheduler.clearTimeout(this.#endTimer);
    const deadline = this.#lastAuthority + timing.end_after_no_authority_seconds * 1000;
    this.#endTimer = this.#scheduler.setTimeout(() => {
      if (!this.#running) return;
      this.#session.end();
      this.stop();
    }, Math.max(0, deadline - this.#clock.monotonicNow()));
  }

  #schedulePoll(index) {
    const interval = timing.poll_interval_seconds * 1000;
    const deadline = this.#origin + index * interval;
    this.#pollTimer = this.#scheduler.setTimeout(() => {
      if (!this.#running) return;
      // Skip missed deadlines after an event-loop stall instead of burst polling.
      const next = Math.max(index + 1, Math.floor((this.#clock.monotonicNow() - this.#origin) / interval) + 1);
      this.#schedulePoll(next);
      void this.#poll();
    }, Math.max(0, deadline - this.#clock.monotonicNow()));
  }

  async #poll() {
    try {
      const value = await withDeadline((signal) => this.#fetch({
        ...this.#session.scope, signal, cache: 'no-store',
      }), { clock: this.#clock, scheduler: this.#scheduler, signal: this.#request.signal });
      if (!this.#running) return;
      const now = this.#clock.monotonicNow();
      const { authority, issued } = checkedAuthority(value, this.#session.scope, this.#wallOrigin + now - this.#origin);
      if (issued < this.#lastIssued) throw new AuthzError(503, 'Authority issued_at moved backwards');
      this.#session.applyAuthority(authority);
      this.#lastIssued = issued;
      this.#lastAuthority = this.#origin + issued - this.#wallOrigin;
      this.#failures = 0;
      this.#lastError = null;
      this.#scheduleEnd();
      this.#scheduleFreshness();
    } catch (error) {
      if (!this.#running) return;
      this.#lastError = error;
      if (error.code === 'revoked') this.#session.revoke();
      else if (++this.#failures >= 2) this.#session.captureOnly(error);
      this.#onError(error);
    }
  }
}
