// Every non-GET request from the client goes through here. The server accepts
// POST bodies only as application/json and answers anything else with 415,
// except the document upload route, which takes multipart/form-data (postForm).
export function postJson(url, body = {}, { sessionToken, signal, keepalive = false } = {}) {
  return fetch(url, { method: 'POST', signal, keepalive, headers: { 'content-type': 'application/json',
    ...(sessionToken ? { 'x-aithema-session-token': sessionToken } : {}) }, body: JSON.stringify(body) });
}
// The browser sets the multipart boundary itself, so no content-type is given here.
export function postForm(url, form, { sessionToken, signal } = {}) {
  return fetch(url, { method: 'POST', signal, headers: sessionToken ? { 'x-aithema-session-token': sessionToken } : {}, body: form });
}
// Owner-authenticated routes are reached on the page's own origin only: a host baseUrl elsewhere
// never receives the owner header or cookie. Throws before anything is sent.
export function sameOrigin(view, url, message = 'Owner routes require same origin') {
  const location = view?.location;
  if (location?.origin && location.origin !== 'null' && new URL(url, location.href).origin !== location.origin) throw new Error(message);
  return url;
}
