import { postJson } from './post-json.js';

// A call belongs to the tab that started it. sessionStorage survives a reload of
// that tab, so a reloaded page ends exactly its own orphaned call (AIT-116 D4). The
// record holds public call identity only. Browsers also copy sessionStorage into
// auxiliary windows, so a record alone never proves the call is orphaned: the tab
// still driving it answers a liveness ping first. Without that proof the server lease
// ends the call instead.
const key = sessionId => `aithema-voice-call:${sessionId}`;
const channelName = 'aithema-voice-calls';

export function voiceJournal(storage, sessionId) {
  const read = () => {
    try { const record = JSON.parse(storage?.getItem(key(sessionId)) ?? 'null'); return typeof record?.callId === 'string' ? record : null; }
    catch { return null; }
  };
  const save = record => { try { storage?.setItem(key(sessionId), JSON.stringify(record)); } catch { /* Storage may be unavailable. */ } };
  return { read, save,
    update(patch) { const record = read(); if (record) save({ ...record, ...patch }); },
    clear() { try { storage?.removeItem(key(sessionId)); } catch { /* Storage may be unavailable. */ } } };
}

/** The existing owner-authenticated close route; keepalive lets it outlive an unloading page. */
export function closeVoiceCall({ baseUrl = '', sessionId, sessionToken, record, reason }) {
  return postJson(`${baseUrl}/api/sessions/${sessionId}/voice/${encodeURIComponent(record.callId)}/close`,
    { providerSessionId: record.providerSessionId, reason }, { sessionToken, keepalive: true });
}

/** Answers pings for the call this tab drives right now. Returns the channel to close. */
export function answerVoicePings(current) {
  if (typeof BroadcastChannel !== 'function') return { close() {} };
  const channel = new BroadcastChannel(channelName);
  channel.unref?.(); // Server-side renderers and tests: never keep a process alive.
  channel.onmessage = ({ data }) => {
    if (data?.type === 'ping' && typeof data.callId === 'string' && data.callId === current()) {
      channel.postMessage({ type: 'pong', callId: data.callId, nonce: data.nonce });
    }
  };
  return channel;
}

/**
 * True only when abandonment is provable: the channel works and no live same-origin tab
 * answers for the call within the timeout. An answer, a missing channel or any failure
 * is no proof.
 */
export async function voiceCallAbandoned(callId, { timeoutMs = 400 } = {}) {
  if (typeof BroadcastChannel !== 'function') return false;
  let channel;
  try {
    channel = new BroadcastChannel(channelName); const nonce = crypto.randomUUID();
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      channel.onmessage = ({ data }) => {
        if (data?.type === 'pong' && data.nonce === nonce && data.callId === callId) { clearTimeout(timer); resolve(false); }
      };
      channel.postMessage({ type: 'ping', callId, nonce });
    });
  } catch { return false; }
  finally { channel?.close(); }
}
