/**
 * Transcript bounds, recency clipping, turn deduplication, and incomplete-stream
 * non-persistence. Pattern-ported from START `src/lib/transcript-limits.ts` and
 * the dedupe branch of `src/lib/v2-transcript.ts` (UNLICENSED → AGPL rewrite).
 * Agency prompts, branding, voice, and customer fields are not included.
 */

/** A complete intake should fit comfortably; these are abuse/failure ceilings. */
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TRANSCRIPT_ENTRIES = 80;
export const MAX_TRANSCRIPT_CHARS = 96_000;
/** Turns actually sent to a language model; older history stays in the store. */
export const MAX_TURNS_SENT = 24;

/**
 * @typedef {'user' | 'assistant'} TurnRole
 * @typedef {{
 *   role: TurnRole,
 *   content: string,
 *   at: string,
 *   provenance?: Readonly<Record<string, string | boolean | null>>,
 * }} TranscriptEntry
 */

/**
 * @param {readonly TranscriptEntry[]} entries
 */
export function transcriptChars(entries) {
  return entries.reduce((total, entry) => total + entry.content.length, 0);
}

/**
 * @param {{ transcript: readonly TranscriptEntry[] }} session
 * @param {string} content
 */
export function canAppendTranscript(session, content) {
  return (
    session.transcript.length < MAX_TRANSCRIPT_ENTRIES
    && transcriptChars(session.transcript) + content.length <= MAX_TRANSCRIPT_CHARS
  );
}

/**
 * Bounds legacy or externally written sessions too, keeping the most recent
 * complete turns in chronological order rather than slicing a sentence.
 * @param {readonly TranscriptEntry[]} entries
 * @returns {TranscriptEntry[]}
 */
export function boundedTranscript(entries) {
  const kept = [];
  let chars = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (kept.length >= MAX_TRANSCRIPT_ENTRIES) break;
    if (chars + entry.content.length > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(entry);
    chars += entry.content.length;
  }
  return kept;
}

/**
 * A partial/aborted provider stream is visible feedback, never durable history.
 * @param {string} content
 * @param {boolean} streamCompleted
 * @returns {string | null}
 */
export function assistantTurnForPersistence(content, streamCompleted) {
  return streamCompleted && content.trim() !== '' ? content : null;
}

/**
 * @param {string} content
 */
export function boundMessage(content) {
  if (typeof content !== 'string') return '';
  return content.trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * One turn into a transcript, with START-compatible replay dedupe: identical
 * last role+content is not a new entry. Caller persists the returned transcript.
 * @param {readonly TranscriptEntry[]} transcript
 * @param {TurnRole} role
 * @param {string} content
 * @param {string} [at]
 * @param {TranscriptEntry['provenance']} [provenance]
 * @returns {{
 *   ok: true,
 *   at: string,
 *   transcript: TranscriptEntry[],
 *   deduped: boolean,
 * } | { ok: false, reason: 'empty' | 'transcript-full' }}
 */
export function appendTurn(transcript, role, content, at = new Date().toISOString(), provenance) {
  const text = boundMessage(content);
  if (text === '') return { ok: false, reason: 'empty' };
  const last = transcript.at(-1);
  if (last && last.role === role && last.content === text) {
    return { ok: true, at: last.at, transcript: [...transcript], deduped: true };
  }
  const session = { transcript };
  if (!canAppendTranscript(session, text)) {
    return { ok: false, reason: 'transcript-full' };
  }
  const entry = Object.freeze({
    role,
    content: text,
    at,
    ...(provenance ? { provenance: Object.freeze({ ...provenance }) } : {}),
  });
  return {
    ok: true,
    at,
    transcript: boundedTranscript([...transcript, entry]),
    deduped: false,
  };
}

/**
 * @param {readonly TranscriptEntry[]} transcript
 * @returns {readonly { role: 'user' | 'assistant', content: string }[]}
 */
export function messagesForProvider(transcript) {
  return boundedTranscript(transcript)
    .slice(-MAX_TURNS_SENT)
    .map((entry) => ({ role: entry.role, content: entry.content }));
}
