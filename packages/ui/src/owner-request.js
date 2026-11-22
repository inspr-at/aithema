// AIT-625: the ONE place the client reaches the network. Every request that can carry the owner
// credential (the session-token header or the HttpOnly owner cookie) passes here:
// - fails closed without a real page origin (about:blank, about:srcdoc, opaque or missing view);
// - resolves the URL once against document.baseURI and requires the resolved origin to be the
//   page origin, so neither a host baseUrl elsewhere nor a foreign <base> receives anything;
// - fetches exactly that resolved URL with redirect:'error', so no redirect can forward the header;
// - aborts when the caller's signal aborts, or when no response headers arrive by the deadline.
// packages/ui/test/owner-request.test.js fails when any other module names the header or calls fetch.
const HEADER = 'x-aithema-session-token';
/** Default time to response headers; a streamed body (events) is not cut by it. */
export const OWNER_REQUEST_DEADLINE_MS = 30_000;

/** Throws unless `url` resolves to the page's own origin; returns the resolved URL. */
export function ownerURL(view, url, message = 'Owner routes require same origin') {
  const location = view?.location, base = view?.document?.baseURI;
  if (!location || !/^https?:$/u.test(location.protocol) || !location.origin || location.origin === 'null' || !base)
    throw new Error('Owner requests require the page origin');
  const resolved = new URL(String(url), base);
  if (resolved.origin !== location.origin) throw new Error(message);
  return resolved;
}

export async function ownerFetch(view, url, { sessionToken, headers, signal, deadline = OWNER_REQUEST_DEADLINE_MS, message, ...init } = {}) {
  const resolved = ownerURL(view, url, message);
  signal?.throwIfAborted();
  // A plain object keeps the caller's names; any caller-supplied owner header is dropped.
  const sent = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== HEADER));
  if (sessionToken) sent[HEADER] = sessionToken;
  const timer = new AbortController();
  const id = Number.isFinite(deadline) ? setTimeout(() => timer.abort(new DOMException('Owner request deadline', 'TimeoutError')), deadline) : null;
  try {
    return await fetch(resolved.href, { ...init, headers: sent, redirect: 'error', signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal });
  } finally { clearTimeout(id); }
}

// Every non-GET request from the client is JSON: the server accepts POST bodies only as
// application/json and answers anything else with 415, except the document upload route,
// which takes multipart/form-data (ownerForm; the browser sets the boundary itself).
export function ownerJson(view, url, body = {}, { verb = 'POST', headers, ...options } = {}) {
  return ownerFetch(view, url, { ...options, method: verb, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
export function ownerForm(view, url, form, { verb = 'POST', ...options } = {}) {
  return ownerFetch(view, url, { ...options, method: verb, body: form });
}
