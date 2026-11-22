// AIT-625: the ONE place the client reaches the network. Every request that can carry the owner
// credential (the session-token header or the HttpOnly owner cookie) passes here:
// - fails closed without a real page origin: the document's actual origin (window.origin, "null"
//   for a sandboxed or opaque document, whatever its URL says), on an http(s) page;
// - resolves the URL once against document.baseURI and requires the resolved origin to be that
//   origin, so neither a host baseUrl elsewhere nor a foreign <base> receives anything;
// - fetches exactly that resolved URL with redirect:'error', so no redirect can forward the header;
// - aborts when the caller's signal aborts, or when the deadline passes. The deadline covers the
//   headers AND the body of a finite request: r8 (gate5c M3) buffers that body natively
//   (arrayBuffer() raced against the abort, no wrapper stream) before returning, so a stall, a body
//   error or the deadline rejects ownerFetch itself. Only a SUCCESSFUL (2xx) request marked
//   `stream: true` (the event stream) is returned unbuffered with a headers-only deadline, its body
//   bounded by its caller's signal. An error answer to a stream request is a finite body;
// - a finite body is held in memory, so it is bounded: `maxBytes` (default OWNER_RESPONSE_MAX_BYTES)
//   is refused from Content-Length before anything is read, and checked again on the buffered size
//   (no Content-Length, or a decoded body larger than its encoded length); see the constants;
// - `onSettled` (optional) runs once when the request is over: transport failure, the finite body
//   buffered or failed, a null body, a successful stream's headers, or the deadline/abort.
// packages/ui/test/owner-request.test.js fails when any other module names the header or calls fetch.
const HEADER = 'x-aithema-session-token';
/** Default deadline for a finite request (headers and body); a `stream: true` body is not cut by it. */
export const OWNER_REQUEST_DEADLINE_MS = 30_000;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
// Memory bound of one buffered finite owner response (r8, LEAD). The largest legitimate one is the
// conversation export ZIP (packages/server/src/export.js, store-only, no compression):
// images <= maxImagesPerSession 8 x MAX_IMAGE_BYTES 12 MiB = 96 MiB (packages/server/src/upload-limits.js:6,
// packages/core/src/image-info.js:2; hosts may only lower these) + concept artifacts <=
// MAX_CONCEPT_STORAGE_BYTES 64 MiB per conversation (packages/server/src/storage.js:14) = 160 MiB of
// binary payload; the transcript/understanding/manifest JSON and ZIP headers have no single byte cap
// (each turn <= REQUEST_LIMIT 32 KiB, packages/server/src/handlers.js:21), so 96 MiB is headroom for them.
/** Bound for the export ZIP (the one call that raises maxBytes). */
export const OWNER_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Bound for every other finite owner response: at most one concept artifact or a JSON snapshot. */
export const OWNER_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

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

export async function ownerFetch(view, url, { sessionToken, headers, signal, deadline = OWNER_REQUEST_DEADLINE_MS, stream = false, maxBytes = OWNER_RESPONSE_MAX_BYTES, message, onSettled, ...init } = {}) {
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
  let stop, settled = false;
  const settle = () => { if (settled) return; settled = true; onSettled?.(); };
  // Settles with the abort even when a body source does not observe the signal.
  const aborted = new Promise((resolve, reject) => { stop = () => { reject(combined.reason); settle(); }; combined.addEventListener('abort', stop, { once: true }); });
  aborted.catch(() => {});
  const finish = () => { clearTimeout(id); combined.removeEventListener('abort', stop); settle(); };
  let response;
  try {
    response = await Promise.race([fetch(resolved.href, { ...init, headers: sent, redirect: 'error', signal: combined }), aborted]);
  } catch (error) {
    finish();
    // Report the deadline or the caller's reason, not the transport's generic failure.
    throw combined.aborted ? combined.reason ?? error : error;
  }
  if ((stream && response?.ok) || !response?.body) { finish(); return response; }
  // A finite body is buffered by the browser itself and stays under the same deadline: the read
  // races the abort, so a stall after the headers still ends (and the caller's error path runs).
  const tooLarge = () => new RangeError(`Owner response exceeds ${maxBytes} bytes`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (declared > maxBytes) { finish(); response.body.cancel().catch(() => {}); throw tooLarge(); }
  // The native read rejects on its own once the fetch signal aborts; that late rejection is expected.
  const buffered = response.arrayBuffer(); buffered.catch(() => {});
  let bytes;
  try { bytes = await Promise.race([buffered, aborted]); }
  catch (error) { finish(); throw combined.aborted ? combined.reason ?? error : error; }
  finish();
  if (bytes.byteLength > maxBytes) throw tooLarge();
  return new Response(NULL_BODY.has(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}
