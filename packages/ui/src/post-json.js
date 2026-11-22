import { ownerFetch, ownerURL } from './owner-request.js';
// Every non-GET request from the client goes through here and then through the guarded
// owner-request helper (AIT-625), which alone reaches the network. The server accepts POST
// bodies only as application/json and answers anything else with 415, except the document
// upload route, which takes multipart/form-data (postForm). `view` is the page whose origin
// the request must share: the element's window, or the host page by default.
export function postJson(url, body = {}, { view = globalThis, verb = 'POST', headers, ...options } = {}) {
  return ownerFetch(view, url, { ...options, method: verb, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
// The browser sets the multipart boundary itself, so no content-type is given here.
export function postForm(url, form, { view = globalThis, ...options } = {}) {
  return ownerFetch(view, url, { ...options, method: 'POST', body: form });
}
// Owner-authenticated routes are reached on the page's own origin only: a host baseUrl elsewhere
// never receives the owner header or cookie. Throws before anything is sent; fails closed
// without a page origin. Callers may check early; the helper checks again before it sends.
export function sameOrigin(view, url, message = 'Owner routes require same origin') {
  ownerURL(view, url, message);
  return url;
}
