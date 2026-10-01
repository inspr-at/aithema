import { pendingContentReference, sha256Hex } from '../../contracts/validate.js';
import { JournalError } from './port.js';

// Base64 of 256 KiB is 349,528 ASCII bytes; the transport envelope stays below
// the host's unchanged 1 MiB request cap, including its safe-integer counters.
export const journalChunkBytes = 256 * 1024;

/** A reference is a dependency, not authority to regenerate missing bytes. */
export function verifyPendingContent(op, record, sid, beforeSeq = Infinity) {
  let ref;
  try { ref = pendingContentReference(op.payload); }
  catch { throw new JournalError(422, 'Invalid pending content reference', 'citation_invalid'); }
  const doc = record?.document;
  if (!doc || doc.sid !== sid || doc.kind !== ref.kind || doc.seq !== ref.record_seq || doc.seq >= beforeSeq ||
      doc.data.sha256 !== ref.sha256 || doc.data.size !== ref.size ||
      sha256Hex(doc.data.canonical) !== ref.sha256 || Buffer.byteLength(doc.data.canonical, 'utf8') !== ref.size) {
    throw new JournalError(422, 'Pending content is missing or does not match its reference', 'citation_invalid');
  }
  return doc.data.canonical;
}
