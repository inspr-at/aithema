// AIT-625: the ONE place the client reaches the network. Every request that can carry the owner
// credential (the session-token header or the HttpOnly owner cookie) passes here:
// - fails closed without a real page origin: the document's actual origin (window.origin, "null"
//   for a sandboxed or opaque document, whatever its URL says), on an http(s) page;
// - resolves the URL once against document.baseURI and requires the resolved origin to be that
//   origin, so neither a host baseUrl elsewhere nor a foreign <base> receives anything;
// - fetches exactly that resolved URL with redirect:'error', so no redirect can forward the header;
// - aborts when the caller's signal aborts, or when the deadline passes. The deadline covers the
//   headers AND every body read of a finite request; only a request marked `stream: true` (the
//   event stream) keeps a headers-only deadline, its body bounded by its caller's signal.
// packages/ui/test/owner-request.test.js fails when any other module names the header or calls fetch.
const HEADER = 'x-aithema-session-token';
/** Default deadline for a finite request (headers and body); a `stream: true` body is not cut by it. */
export const OWNER_REQUEST_DEADLINE_MS = 30_000;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Throws unless `url` resolves to the page's own origin; returns the resolved URL. */
export function ownerURL(view, url, message = 'Owner routes require same origin') {
  const origin = view?.origin, base = view?.document?.baseURI;
  if (typeof origin !== 'string' || origin === 'null' || !/^https?:$/u.test(view?.location?.protocol ?? '') || !base)
    throw new Error('Owner requests require the page origin');
  const resolved = new URL(String(url), base);
  if (resolved.origin !== origin) throw new Error(message);
  return resolved;
}

/** AbortSignal.any where available; otherwise the same combination by hand. */
export function anySignal(signals, native = AbortSignal.any) {
  if (typeof native === 'function') return native.call(AbortSignal, signals);
  const controller = new AbortController();
  const stop = signal => { controller.abort(signal.reason); for (const other of signals) other.removeEventListener('abort', listeners.get(other)); };
  const listeners = new Map(signals.map(signal => [signal, () => stop(signal)]));
  for (const signal of signals) {
    if (signal.aborted) { stop(signal); break; }
    signal.addEventListener('abort', listeners.get(signal), { once: true });
  }
  return controller.signal;
}

export async function ownerFetch(view, url, { sessionToken, headers, signal, deadline = OWNER_REQUEST_DEADLINE_MS, stream = false, message, ...init } = {}) {
  const resolved = ownerURL(view, url, message);
  signal?.throwIfAborted();
  // A plain object keeps the caller's names; any caller-supplied owner header is dropped.
  const sent = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== HEADER));
  if (sessionToken) sent[HEADER] = sessionToken;
  const timer = new AbortController();
  const id = Number.isFinite(deadline) ? setTimeout(() => timer.abort(new DOMException('Owner request deadline', 'TimeoutError')), deadline) : null;
  // A body nobody reads must not keep a server-side runtime alive until the deadline.
  id?.unref?.();
  const combined = signal ? anySignal([signal, timer.signal]) : timer.signal;
  let stop;
  // Settles with the abort even when a body source does not observe the signal.
  const aborted = new Promise((resolve, reject) => { stop = () => reject(combined.reason); combined.addEventListener('abort', stop, { once: true }); });
  aborted.catch(() => {});
  const finish = () => { clearTimeout(id); combined.removeEventListener('abort', stop); };
  let response;
  try {
    response = await Promise.race([fetch(resolved.href, { ...init, headers: sent, redirect: 'error', signal: combined }), aborted]);
  } catch (error) {
    finish();
    // Report the deadline or the caller's reason, not the transport's generic failure.
    throw combined.aborted ? combined.reason ?? error : error;
  }
  if (stream || !response?.body) { finish(); return response; }
  // A finite body stays under the same deadline: every read races it, so a stall after the
  // headers still ends (and the caller's error path runs). The timer stops when the body ends.
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) { finish(); controller.close(); } else controller.enqueue(value);
      } catch (error) {
        finish(); controller.error(combined.aborted ? combined.reason ?? error : error); reader.cancel().catch(() => {});
      }
    },
    cancel(reason) { finish(); return reader.cancel(reason); },
  });
  return new Response(NULL_BODY.has(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
