import { ownerJson, ownerURL } from './owner-request.js';
// Adapters over the guarded owner-request helper (AIT-625), which alone reaches the network.
// postJson serves callers without an element view (the host page is the view).
export function postJson(url, body = {}, { view = globalThis, ...options } = {}) {
  return ownerJson(view, url, body, options);
}
// Owner-authenticated routes are reached on the page's own origin only: a host baseUrl elsewhere
// never receives the owner header or cookie. Throws before anything is sent; fails closed
// without a page origin. Callers may check early; the helper checks again before it sends.
export function sameOrigin(view, url, message = 'Owner routes require same origin') {
  ownerURL(view, url, message);
  return url;
}
