// Every non-GET request from the client goes through here. The server accepts
// POST bodies only as application/json and answers anything else with 415.
export function postJson(url, body = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
