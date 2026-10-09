import { postJson } from './post-json.js';

// A call belongs to the tab that started it. sessionStorage survives a reload of
// that tab only, so a reloaded page ends exactly its own orphaned call and never
// another tab's (AIT-116 D4). The record holds public call identity only.
const key = sessionId => `aithema-voice-call:${sessionId}`;

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
