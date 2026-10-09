import { postJson } from './post-json.js';

/** Only public call identity and transport credentials cross this port. */
export function createVoiceControl({ baseUrl = '', sessionId, sessionToken, receive = () => {} }) {
  const base = `${baseUrl.replace(/\/$/u, '')}/api/sessions/${sessionId}/voice`;
  const post = async (url, body, options = {}) => {
    const response = await postJson(url, body, { sessionToken, signal: options.signal });
    const value = await response.json();
    if (!response.ok) { const error = new Error('Voice control failed'); error.code = value.error; throw error; }
    return value;
  };
  const control = { start: (request, options) => post(base, { callId: request.callId }, options) };
  for (const name of ['pause', 'resume', 'heartbeat', 'close', 'recover']) {
    control[name] = (identity, options) => post(`${base}/${identity.callId}/${name}`, identity, options);
  }
  return { control, async persistEvent(event, identity) {
    const value = await post(`${base}/${event.callId}/events`, { providerSessionId: identity.providerSessionId, event });
    receive(value); return value;
  } };
}
