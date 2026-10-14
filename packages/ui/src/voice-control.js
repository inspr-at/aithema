import { postJson } from './post-json.js';

/** Only public call identity and transport credentials cross this port. */
export function createVoiceControl({ baseUrl = '', sessionId, sessionToken, receive = () => {} }) {
  // Per-document identity: sessionStorage is copied into auxiliary windows and
  // cannot prove ownership. Only the server's epoch grants command authority.
  const tabId = crypto.randomUUID(), epochs = new Map();
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
    if (value?.callId && Number.isSafeInteger(value.epoch)) epochs.set(value.callId, value.epoch);
    return value;
  };
  const authority = identity => ({ ...identity, tabId, epoch: identity.epoch ?? epochs.get(identity.callId) });
  const control = { tabId, start: (request, options) => post(base, { callId: request.callId, tabId }, options) };
  for (const name of ['pause', 'resume', 'heartbeat', 'recover', 'takeover']) {
    control[name] = (identity, options) => post(`${base}/${identity.callId}/${name}`, authority(identity), options);
  }
  control.close = (identity, options) => post(`${base}/${identity.callId}/close`, { ...authority(identity), background: true }, options);
  control.stopReplyReplay = identity => post(identity.callId ? `${base}/${identity.callId}/replay` : `${base}/replay`, authority({ ...identity, stop: true }));
  control.speakText = (identity, options) => post(identity.callId ? `${base}/${identity.callId}/replay` : `${base}/replay`, authority(identity), options);
  return { control, async persistEvent(event, identity, options) {
    const value = await post(`${base}/${event.callId}/events`, { ...authority({ ...identity, callId: event.callId }), event }, options);
    receive(value); return value;
  } };
}
