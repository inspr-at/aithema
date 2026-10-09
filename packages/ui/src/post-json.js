// Every non-GET request from the client goes through here. The server accepts
// POST bodies only as application/json and answers anything else with 415.
export function postJson(url, body = {}, { sessionToken, signal, keepalive = false } = {}) {
  return fetch(url, { method: 'POST', signal, keepalive, headers: { 'content-type': 'application/json',
    ...(sessionToken ? { 'x-aithema-session-token': sessionToken } : {}) }, body: JSON.stringify(body) });
}
