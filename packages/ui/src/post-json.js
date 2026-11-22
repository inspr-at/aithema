// Every non-GET request from the client goes through here. The server accepts
// POST bodies only as application/json and answers anything else with 415,
// except the document upload route, which takes multipart/form-data (postForm).
export function postJson(url, body = {}, { sessionToken, signal, keepalive = false, verb = 'POST', cache, redirect } = {}) {
  return fetch(url, { method: verb, signal, keepalive, ...(cache ? { cache } : {}), ...(redirect ? { redirect } : {}), headers: { 'content-type': 'application/json',
    ...(sessionToken ? { 'x-aithema-session-token': sessionToken } : {}) }, body: JSON.stringify(body) });
}
// The browser sets the multipart boundary itself, so no content-type is given here.
export function postForm(url, form, { sessionToken, signal, redirect } = {}) {
  return fetch(url, { method: 'POST', signal, ...(redirect ? { redirect } : {}), headers: sessionToken ? { 'x-aithema-session-token': sessionToken } : {}, body: form });
}
// Owner-authenticated routes are reached on the page's own origin only: a host baseUrl elsewhere
// never receives the owner header or cookie. Throws before anything is sent.
// AIT-610 r9: the URL is resolved ONCE, against the document base (what fetch itself would use,
// so a foreign <base href> is caught), the RESOLVED origin is checked, and the resolved URL is
// returned: callers fetch exactly that URL, with OWNER_REDIRECT, so a redirect never carries the
// owner header elsewhere.
export const OWNER_REDIRECT = 'error';
export function sameOrigin(view, url, message = 'Owner routes require same origin') {
  const location = view?.location;
  if (!location?.origin || location.origin === 'null') return url;
  const resolved = new URL(url, view.document?.baseURI || location.href);
  if (resolved.origin !== location.origin) throw new Error(message);
  return resolved.href;
}
