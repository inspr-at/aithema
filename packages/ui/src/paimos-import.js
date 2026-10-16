import { activeTurns } from '../../core/src/session.js';

// Field/code-point, item, turn and UTF-8 byte limits: contract v1 (AEON-1441).
export const PAIMOS_PAYLOAD_MAX_BYTES = 512 * 1024;
const TITLE_MAX = 200, SUMMARY_MAX = 4000, ITEMS_MAX = 50, ITEM_MAX = 500, TURNS_MAX = 2000;
const omittedNote = {
  de: 'Die ältesten Gesprächsbeiträge wurden wegen der Größenbegrenzung weggelassen.',
  en: 'The oldest conversation turns were omitted to meet the size limit.',
};
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const shorten = (text, limit) => {
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit - 1).join('') + '…' : text;
};
const summaryWithOmittedNote = (summary, locale) => {
  const note = omittedNote[locale] ?? omittedNote.en;
  // Reserve the complete note and separator inside the contract v1 (AEON-1441) summary limit.
  return [shorten(summary, SUMMARY_MAX - Array.from(note).length - 2), note].filter(Boolean).join('\n\n');
};

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
  const u = session.understanding, turns = activeTurns(session);
  const omittedTurns = turns.length > TURNS_MAX;
  const payload = {
    version: 1, source: { product: 'aithema', host, session_id: session.id }, language: session.locale,
    // The overview has no separate project title: use its first summary line.
    title: Array.from(u.summary.trim().split(/\r?\n/u)[0] || fallbackTitle).slice(0, TITLE_MAX).join(''),
    summary: omittedTurns ? summaryWithOmittedNote(u.summary, session.locale) : shorten(u.summary, SUMMARY_MAX),
    facts: u.signals.slice(0, ITEMS_MAX).map(text => shorten(text, ITEM_MAX)),
    open_points: u.openQuestions.slice(0, ITEMS_MAX).map(text => shorten(text, ITEM_MAX)),
    // Both contract v1 (AEON-1441) transcript caps retain newest turns, trimming oldest first.
    transcript: turns.slice(-TURNS_MAX).map(turn => ({ role: turn.role, text: turn.content, at: turn.at })),
  };
  if (jsonBytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES) return payload;

  if (!omittedTurns) payload.summary = summaryWithOmittedNote(u.summary, session.locale);
  let bytes = jsonBytes(payload), start = 0;
  // A byte overflow must omit a turn even if reserving the note itself frees enough UTF-8 bytes.
  while ((bytes > PAIMOS_PAYLOAD_MAX_BYTES || !omittedTurns && start === 0) && start < payload.transcript.length) {
    bytes -= jsonBytes(payload.transcript[start]) + (start < payload.transcript.length - 1 ? 1 : 0);
    start += 1;
  }
  payload.transcript = payload.transcript.slice(start);
  // Understanding is bounded here; fail closed if host-supplied metadata still cannot fit.
  if (bytes > PAIMOS_PAYLOAD_MAX_BYTES) throw new RangeError('Paimos overview exceeds the payload size limit');
  return payload;
}
