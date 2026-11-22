import { ownerFetch } from '../packages/ui/src/owner-request.js';
/** Host JSON requests, on the page origin. AIT-625 r7: they carry the owner cookie, so they go
 * through the guarded owner-request helper (page origin, resolved URL, redirect:'error', deadline). */
export function postJson(url, body = {}, { signal, view = globalThis.document?.defaultView ?? globalThis } = {}) {
  return ownerFetch(view, url, { signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
