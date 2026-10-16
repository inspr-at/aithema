import { activeTurns } from '../../core/src/session.js';

export const PAIMOS_PAYLOAD_MAX_BYTES = 512 * 1024;
const omittedNote = {
  de: 'Die ältesten Gesprächsbeiträge wurden wegen der Größenbegrenzung weggelassen.',
  en: 'The oldest conversation turns were omitted to meet the size limit.',
};
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Only an explicit v1 destination supplied by the host enables the handoff. */
export function paimosImportUrl({ paimosImportUrl: value, paimosImportVersion } = {}) {
  if (paimosImportVersion !== 1 || typeof value !== 'string' || !/^https?:\/\//iu.test(value) || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Same active turns and understanding as the ZIP export; no credentials or artifacts. */
export function buildPaimosPayload(session, { host, fallbackTitle = '' } = {}) {
  const u = session.understanding;
  const payload = {
    version: 1, source: { product: 'aithema', host, session_id: session.id }, language: session.locale,
    // The overview has no separate project title: use its first summary line.
    title: Array.from(u.summary.trim().split(/\r?\n/u)[0] || fallbackTitle).slice(0, 200).join(''),
    summary: u.summary, facts: [...u.signals], open_points: [...u.openQuestions],
    transcript: activeTurns(session).map(turn => ({ role: turn.role, text: turn.content, at: turn.at })),
  };
  if (jsonBytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES) return payload;

  payload.summary = [payload.summary, omittedNote[session.locale] ?? omittedNote.en].filter(Boolean).join('\n\n');
  let bytes = jsonBytes(payload), start = 0;
  while (bytes > PAIMOS_PAYLOAD_MAX_BYTES && start < payload.transcript.length) {
    bytes -= jsonBytes(payload.transcript[start]) + (start < payload.transcript.length - 1 ? 1 : 0);
    start += 1;
  }
  payload.transcript = payload.transcript.slice(start);
  // Normal understanding fields are bounded by core. Fail closed for malformed host data.
  if (bytes > PAIMOS_PAYLOAD_MAX_BYTES) throw new RangeError('Paimos overview exceeds the payload size limit');
  return payload;
}
