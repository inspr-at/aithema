import { canonicalJson } from '../../contracts/validate.js';
import { JournalError, decodeDocument, submissionBytes } from './port.js';

function invalid(message) { return new JournalError(422, message, 'citation_invalid'); }

/** A transport's indexed projection must agree with its original submission. */
export function checkedRecord(record, sid) {
  if (!record || !Number.isSafeInteger(record.document?.seq) || record.document.seq < 1) {
    throw invalid('Host record has no valid seq');
  }
  const bytes = submissionBytes(record.bytes);
  const original = decodeDocument(bytes, { submission: true });
  const { seq, ...projection } = record.document;
  if (original.sid !== sid || canonicalJson(original) !== canonicalJson(projection)) {
    throw invalid('Host record bytes, projection or session disagree');
  }
  return { bytes, document: { ...original, seq } };
}

/**
 * Contracts have no summary record kind: summaries retain their flattened leaf
 * refs in item citations/provenance. Never treat summary or assistant text as a
 * source. Fetch every leaf, including ones outside the replay window.
 */
export function snapshotDependencies(snapshot) {
  const ids = new Set();
  for (const item of snapshot.spec.items) {
    for (const citation of item.citations) ids.add(citation.record_seq);
    for (const seq of item.provenance.derived_from) ids.add(seq);
  }
  for (const screen of snapshot.spec.screens) ids.add(screen.design_input_seq);
  return [...ids].sort((a, b) => a - b);
}

function evidence(record) {
  if (record?.kind === 'source') return;
  if (record?.kind === 'turn' && record.data.speaker === 'person' && record.data.trust !== 'assistant') return;
  throw invalid('Citation leaf must be a source or person turn; assistant chains are forbidden');
}

/** Validates every citation and summary leaf using ONLY the hydrated closure. */
export function validateCitations(snapshot, closure) {
  for (const item of snapshot.spec.items) {
    for (const seq of item.provenance.derived_from) evidence(closure.get(seq)?.document);
    for (const citation of item.citations) {
      const record = closure.get(citation.record_seq)?.document;
      evidence(record);
      let text;
      if (record.kind === 'turn') {
        // turn:N is a turn locator, not the host journal seq (golden fixtures
        // use record_seq:3, locator:turn:1). The record contains one whole turn.
        const match = /^turn:([0-9]+)$/.exec(citation.locator);
        if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
          throw invalid('Turn citation has an invalid locator');
        }
        text = record.data.body;
      } else {
        const segment = record.data.segments.find((s) => `seg:${s.id}` === citation.locator);
        if (!segment) throw invalid('Source citation segment does not exist');
        text = [...record.data.text].slice(segment.start, segment.end).join('');
      }
      if (citation.quote !== undefined && !text.includes(citation.quote)) throw invalid('Citation quote does not match its leaf');
    }
  }
  for (const screen of snapshot.spec.screens) {
    if (closure.get(screen.design_input_seq)?.document.kind !== 'design.input') {
      throw invalid('Screen reference does not resolve to design.input');
    }
  }
  return true;
}

/** Explicit records-by-ids hydration, with no cache or replay-window fallback. */
export async function hydrateSnapshot(port, storedSnapshot, authority) {
  const closure = new Map();
  if (!storedSnapshot) return closure;
  const snapshot = checkedRecord(storedSnapshot, authority.sid).document;
  if (snapshot.contract !== 'aithema.spec.snapshot') throw invalid('Expected latest spec.snapshot');
  const ids = snapshotDependencies(snapshot);
  if (ids.some((id) => id < 1 || id >= snapshot.seq)) throw invalid('Snapshot dependency is not an earlier host record');
  let records;
  try { records = await port.recordsByIds(ids, authority); }
  catch (error) {
    if (error.status === 404) throw invalid('Snapshot dependency is missing');
    throw error;
  }
  if (!Array.isArray(records)) throw invalid('Host returned no dependency records');
  for (const record of records) {
    const checked = checkedRecord(record, authority.sid);
    const seq = checked.document.seq;
    if (!ids.includes(seq) || closure.has(seq)) throw invalid('Host returned an unexpected or duplicate dependency');
    closure.set(seq, checked);
  }
  if (closure.size !== ids.length) throw invalid('Host returned an incomplete citation closure');
  validateCitations(snapshot, closure);
  return closure;
}

/** Renderer boundary: reopen immutable inputs, never regenerate on resume. */
export async function reopenDesign(snapshot, closure, screenRef, renderer) {
  const screen = snapshot.spec.screens.find((s) => s.screen_ref === screenRef);
  const input = screen && closure.get(screen.design_input_seq);
  if (!input || input.document.kind !== 'design.input') throw invalid('Screen design input is not hydrated');
  if (typeof renderer !== 'function') throw new TypeError('A renderer is required');
  return renderer({
    screen_ir_bytes: Buffer.from(canonicalJson(input.document.data.screen_ir), 'utf8'),
    tokens_bytes: Buffer.from(canonicalJson(input.document.data.tokens), 'utf8'),
    record_bytes: Buffer.from(input.bytes),
    design_input_seq: input.document.seq,
  });
}
