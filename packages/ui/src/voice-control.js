import { postJson } from './post-json.js';

/** Only public call identity and transport credentials cross this port. */
export function createVoiceControl({ baseUrl = '', sessionId, sessionToken, receive = () => {} }) {
  const base = `${baseUrl.replace(/\/$/u, '')}/api/sessions/${sessionId}/voice`;
  const post = async (url, body, options = {}) => {
    const response = await postJson(url, body, { sessionToken, signal: options.signal });
    const value = await response.json().catch(() => null);
    options.signal?.throwIfAborted();
    if (!response.ok) {
      const error = new Error('Voice control failed'), seconds = Number(response.headers.get('retry-after'));
      error.status = response.status; error.code = value?.error; if (typeof value?.reason === 'string') error.reason = value.reason;
      if (seconds > 0) error.retryAfterMs = seconds * 1000; throw error;
    }
    return value;
  };
  const control = { start: (request, options) => post(base, { callId: request.callId }, options) };
  for (const name of ['pause', 'resume', 'heartbeat', 'recover']) {
    control[name] = (identity, options) => post(`${base}/${identity.callId}/${name}`, identity, options);
  }
  control.close = (identity, options) => post(`${base}/${identity.callId}/close`, { ...identity, background: true }, options);
  return { control, async persistEvent(event, identity, options) {
    const value = await post(`${base}/${event.callId}/events`, { providerSessionId: identity.providerSessionId, event }, options);
    receive(value); return value;
  } };
}
