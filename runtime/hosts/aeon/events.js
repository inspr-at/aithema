import { performance } from 'node:perf_hooks';
import { AeonError, UUID } from './http.js';

export const INTAKE_POLL_MS = 30_000;

export function checkHostEvent(event) {
  if (!event || !['draft_accepted', 'draft_superseded', 'session_control'].includes(event.kind) ||
      Object.keys(event).some((key) => !['kind', 'ids'].includes(key)) || !Array.isArray(event.ids) ||
      event.ids.length < 1 || event.ids.length > 200 || new Set(event.ids).size !== event.ids.length ||
      event.ids.some((id) => event.kind === 'session_control' ? !Number.isSafeInteger(id) || id < 1 : typeof id !== 'string' || !UUID.test(id))) {
    throw new AeonError(400, 'Invalid host event');
  }
  return structuredClone(event);
}

/** Callback notifications accelerate authoritative polling; they cannot accept
 * a proposal locally. stop() cancels reads and suppresses all late snapshots. */
export class AeonSessionMonitor {
  #intake;
  #authority;
  #onSnapshot;
  #onControl;
  #onError;
  #clock;
  #timer = null;
  #active = false;
  #run = 0;
  #next = 0;
  #inflight = null;
  #abort = null;
  #rev = 0;
  #delivery = Promise.resolve();

  constructor({ intake, authority, onSnapshot, onControl, onError,
    clock = { now: () => performance.now(), setTimeout, clearTimeout } }) {
    if (typeof intake?.snapshot !== 'function' ||
        ![authority, onSnapshot, onControl, onError, clock.now, clock.setTimeout, clock.clearTimeout].every((fn) => typeof fn === 'function')) {
      throw new TypeError('Monitor requires authority, snapshot, control and error handlers');
    }
    this.#intake = intake;
    this.#authority = authority;
    this.#onSnapshot = onSnapshot;
    this.#onControl = onControl;
    this.#onError = onError;
    this.#clock = clock;
    this.lastError = null;
  }

  get active() { return this.#active; }

  start() {
    if (this.#active) return this.#inflight ?? Promise.resolve();
    this.#active = true;
    this.#run++;
    this.#next = this.#clock.now() + INTAKE_POLL_MS;
    this.#schedule();
    return this.refresh();
  }

  #schedule() {
    if (!this.#active) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#next += INTAKE_POLL_MS;
      while (this.#next <= this.#clock.now()) this.#next += INTAKE_POLL_MS;
      this.#schedule();
      void this.refresh().catch((error) => this.#report(error));
    }, Math.max(0, this.#next - this.#clock.now()));
    this.#timer?.unref?.();
  }

  #report(error) {
    this.lastError = error;
    // Errors remain inspectable even if the embedding application's handler fails.
    Promise.resolve().then(() => this.#onError(error)).catch((handlerError) => { this.lastError = handlerError; });
  }

  stop() {
    this.#active = false;
    this.#run++;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#inflight = null;
  }

  refresh() {
    if (!this.#active) return Promise.resolve(null);
    if (this.#inflight) return this.#inflight;
    const run = this.#run;
    const controller = new AbortController();
    this.#abort = controller;
    const authority = structuredClone(this.#authority());
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await this.#intake.snapshot(authority, { signal: controller.signal });
        if (!this.#active || run !== this.#run) return null;
        const rev = response.snapshot?.working_rev ?? 0;
        if (rev < this.#rev) throw new AeonError(502, 'Intake snapshot revision moved backwards');
        this.#rev = rev;
        // Only the HTTP read is single-flight. An embedding application's
        // processing time must not move the next 30-second polling deadline.
        if (this.#inflight === promise) { this.#inflight = null; this.#abort = null; }
        const delivery = this.#delivery.then(async () => {
          if (!this.#active || run !== this.#run) return null;
          await this.#onSnapshot(response);
          return response;
        });
        // A handler failure remains visible to its caller but does not poison
        // later deliveries. Reads keep their deadlines; handlers never overlap.
        this.#delivery = delivery.catch(() => {});
        return await delivery;
      } catch (error) {
        if (!this.#active || run !== this.#run) return null;
        if (['revoked', 'fenced_generation'].includes(error.code)) this.stop();
        throw error;
      } finally {
        if (this.#inflight === promise) { this.#inflight = null; this.#abort = null; }
      }
    });
    this.#inflight = promise;
    return promise;
  }

  /** Called only after host SERVICE authentication by the HTTP handler. */
  async hostEvent(event) {
    event = checkHostEvent(event);
    if (event.kind !== 'session_control') {
      // A callback arriving during a read needs a new read after it, since the
      // earlier response may predate acceptance. Coalesce within each read only.
      if (this.#inflight) await this.#inflight;
      return this.refresh();
    }
    this.stop(); // fail closed immediately, including when hydration is unavailable
    // This is a trusted host-to-service notification. The delegated journal
    // read is already revoked after a tombstone and cannot hydrate the control.
    // The authz integration receives the named record IDs and handles lifecycle.
    await this.#onControl(event);
    return null;
  }
}

/** Node HTTP handler for POST /v1/sessions/{sid}/host-event. Authentication is
 * mandatory and supplied by the service integration (mTLS or service JWT).
 * Delegated intake tokens are not service credentials. Returns false if unmatched.
 */
export function createHostEventHandler({ sid, monitor, authenticateService }) {
  if (!UUID.test(sid) || typeof monitor?.hostEvent !== 'function' || typeof authenticateService !== 'function') throw new TypeError('Host-event handler requires service authentication');
  return async (req, res) => {
    const match = /^\/v1\/sessions\/([^/]+)\/host-event$/.exec(req.url ?? '');
    if (!match) return false;
    try {
      if (req.method !== 'POST') throw new AeonError(405, 'Host-event requires POST');
      if (await authenticateService(req, sid) !== true) throw new AeonError(401, 'Host service authentication required');
      if (match[1] !== sid) throw new AeonError(404, 'Unknown callback session');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new AeonError(415, 'Host-event requires JSON');
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65_536) throw new AeonError(413, 'Host-event is too large');
        chunks.push(chunk);
      }
      let event;
      try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
      catch { throw new AeonError(400, 'Malformed host event'); }
      await monitor.hostEvent(checkHostEvent(event));
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    } catch (error) {
      const status = error instanceof AeonError ? error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(error?.code ? { code: error.code } : { message: 'Host-event refused' }));
    }
    return true;
  };
}
