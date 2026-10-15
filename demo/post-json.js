/** Host JSON requests, on the page origin. */
export function postJson(url, body = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
