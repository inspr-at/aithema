/** Host JSON requests, on the page origin. */
export function postJson(url, body = {}, { signal } = {}) {
  return fetch(url, { signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
