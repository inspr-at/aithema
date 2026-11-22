/** Same-origin authenticated fetch bridge. Host headers carry its existing owner
 * authentication; grants and connection capabilities never appear in URLs.
 * AIT-625 r6 (gate3c M1): in a browser this module has no network check of its own. Every
 * credential-bearing request goes through THE guarded owner-request helper
 * (@inspr/aithema-ui/owner-request `ownerFetch`: the page origin, the URL resolved once
 * against the document base and checked there, redirect:'error', a deadline over headers and
 * body), injected by the caller as `ownerFetch` (this package does not depend on the UI
 * package). Without it, a browser context (a window, self, document or WorkerGlobalScope
 * global, or an explicit view) fails closed before anything is sent. Only the frame long poll
 * is left to the call lifetime (no deadline), as /events is.
 * Only a runtime with no browser global and no view (a server-side runtime with an injected
 * fetch) keeps the fixed-URL transport: the URL as given, redirect:'error', the same deadline. */
export const RELAY_REQUEST_DEADLINE_MS = 30_000;
// AIT-625 r7 (gate4c M2): the helper drops a raw owner header, so an explicit-token host's token
// rides its `sessionToken` option: the relay's own `sessionToken`, or this header in `headers`,
// mapped once at construction. In a browser it is never sent as a raw header.
const OWNER_HEADER = 'x-aithema-session-token';
// Named typeof checks (no computed global access: the AIT-625 structural scan forbids it).
const browserRuntime = () => typeof window !== 'undefined' || typeof self !== 'undefined' ||
  typeof document !== 'undefined' || typeof WorkerGlobalScope !== 'undefined';
const pageView = () => (browserRuntime() ? globalThis : null);
function combine(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}
export function createNetworkRelayClient({ url = '/composed/relay', fetch: request = globalThis.fetch, ownerFetch, headers = {}, sessionToken, view = pageView(), deadline = RELAY_REQUEST_DEADLINE_MS } = {}) {
  const browser = Boolean(view) || browserRuntime();
  const hostHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== OWNER_HEADER));
  const token = sessionToken ?? Object.entries(headers).find(([name]) => name.toLowerCase() === OWNER_HEADER)?.[1];
  return async function openRelay(grant) {
    if (browser && typeof ownerFetch !== 'function') throw new Error('Relay requests in a browser require the page origin through the owner-request helper');
    const lifetime = new AbortController(); let connectionId, closed = false, commands = 0, retirementRevision = 0;
    async function post(action, body, binary = false, signal = lifetime.signal) {
      const finite = action !== 'frame' && Number.isFinite(deadline);
      const init = { method: 'POST', credentials: 'same-origin',
        headers: { ...hostHeaders, ...(!browser && token ? { [OWNER_HEADER]: token } : {}), 'content-type': binary ? 'application/octet-stream' : 'application/json',
          'x-composed-action': action, ...(connectionId ? { 'x-composed-connection': connectionId } : {}) },
        body: binary ? body : JSON.stringify(body ?? {}) };
      // Server-side transport only: its own deadline. In a browser the helper owns the deadline.
      const timer = new AbortController();
      const id = !browser && finite ? setTimeout(() => timer.abort(new DOMException('Relay request deadline', 'TimeoutError')), deadline) : null;
      try {
        const response = browser
          ? await ownerFetch(view, url, { ...init, ...(token ? { sessionToken: token } : {}), signal, deadline: finite ? deadline : Infinity, message: 'Relay requests require same origin' })
          : await request(String(url), { ...init, redirect: 'error', signal: id ? combine([signal, timer.signal]) : signal });
        const value = await response.json();
        if (!response.ok) { const error = new Error('Composed relay request failed'); error.code = value.error; error.status = response.status; throw error; }
        return value;
      } finally { clearTimeout(id); }
    }
    ({ connectionId } = await post('open', grant));
    return {
      recoverOnResume: true,
      frames: { [Symbol.asyncIterator]() { return this; }, async next() {
        if (closed) return { done: true };
        const value = await post('frame'); if (value.done) return { done: true };
        const frame = value.frame;
        if (frame.type === 'audio') frame.bytes = Uint8Array.from(atob(frame.bytes), ch => ch.charCodeAt(0));
        return { done: false, value: frame };
      } },
      sendAudio: bytes => post('audio', bytes, true),
      async command(name, ...args) {
        // Pause revokes the relay before its durable save acknowledges. Do not
        // send a competing heartbeat to that retired connection while awaiting the save.
        if (name === 'heartbeat' && commands) return { acknowledged: true, deferred: true };
        const revision = retirementRevision;
        if (name === 'pause' || name === 'close') retirementRevision++;
        if (name !== 'heartbeat') commands++;
        try { return (await post('command', { name, args })).result; }
        catch (error) {
          // A heartbeat already on the wire may arrive after pause retires its connection.
          if (name === 'heartbeat' && revision !== retirementRevision) return { acknowledged: true, deferred: true };
          throw error;
        }
        finally { if (name !== 'heartbeat') commands--; }
      },
      async disconnect() {
        if (closed) return;
        closed = true; lifetime.abort();
        try { await post('disconnect', {}, false, AbortSignal.timeout(1000)); } catch { /* Loss cannot obstruct recovery or local teardown. */ }
      },
    };
  };
}
