/**
 * Pure confirmation and evidence checks (§5.3). All context values come from
 * trusted host hydration / verified UI identity, never from lane B or a browser
 * payload. This checks attribution and integrity, not the truth of quoted text.
 * No citation, intent label, person utterance, or summary grants authority.
 */
import {
  canExecute, canonicalJson, sha256Hex, validate, validateSchema,
} from '../contracts/validate.js';

const JOURNAL = 'aithema.journal.record';
const SID = '00000000-0000-4000-8000-000000000001';

/**
 * Summaries are in-memory only; they are not additional journal record kinds.
 * Their leaf_refs are real journal seqs. Expand them before persisting an item;
 * working-item citations / derived_from must never contain synthetic summary ids.
 *
 * turnOrdinals is the host's seq → ordinal index, including earlier turns. A
 * hydrated closure can be sparse: array position or seq is NOT a turn ordinal.
 *
 * @typedef {{kind: 'summary', leaf_refs: number[]}} Summary
 * @typedef {{
 *   sid: string,
 *   records: readonly object[],
 *   turnOrdinals?: Map<number, number>,
 *   principal?: {actor_kind: string, sub: string},
 * }} ProvenanceContext
 */

export class InvalidCitationError extends Error {
  constructor(reason) {
    super(`invalid citation: ${reason}`);
    this.name = 'InvalidCitationError';
    this.code = 'citation_invalid';
    this.reason = reason;
  }
}

export class InvalidConfirmationError extends Error {
  constructor(reason) {
    super(`invalid confirmation: ${reason}`);
    this.name = 'InvalidConfirmationError';
    this.reason = reason;
  }
}

// working-item is a schema definition, not a standalone envelope in index.json.
// Validate its structure through the existing snapshot root without inventing a
// second shape validator. Cross-version snapshot invariants belong to the host.
function itemDocument(item) {
  return {
    contract: 'aithema.spec.snapshot', major: 1, minor: Object.hasOwn(item, 'extensions') ? 1 : 0, min_reader: 0,
    sid: SID, client_event_id: SID, working_rev: 1, expected_prev_rev: 0,
    consumed_seq: 0, worker_generation: 1, host_mode: 'review',
    spec: { items: [item], questions: [], brief: null, screens: [] },
    pending_ops: [], corrections: [], patch: { canonical: '{}', sha256: sha256Hex('{}') },
  };
}

function itemSchemaErrors(item) {
  return validateSchema('aithema.spec.snapshot', itemDocument(item));
}

function assertItem(item) {
  const result = validate('aithema.spec.snapshot', itemDocument(item));
  if (result.schemaErrors.length) throw new TypeError('working item is not contract-valid');
  if (result.invariants.includes('item.content_sha256_matches')) {
    throw new InvalidConfirmationError('content_hash_mismatch');
  }
  // Only the existence/state of a predecessor is unavailable for a lone item.
  // The full snapshot validator checks that at commit time; all local item
  // invariants (including same-ref/older-version supersession) still apply here.
  const localInvariants = result.invariants.filter((id) => id !== 'item.supersedes_target_exists');
  if (localInvariants.length) {
    throw new TypeError(`working item violates contract invariants: ${localInvariants.join(', ')}`);
  }
}

function assertRecord(record) {
  if (!record || record.contract !== JOURNAL) throw new TypeError('journal record is not contract-valid');
  const compatibility = canExecute(record);
  if (!compatibility.ok) {
    throw Object.assign(new Error('journal contract is too new'), { code: compatibility.code });
  }
  if (!validate(JOURNAL, record).ok) throw new TypeError('journal record is not contract-valid');
}

function hydration(context) {
  if (!context || typeof context.sid !== 'string' || !Array.isArray(context.records)) {
    throw new InvalidCitationError('missing_hydration');
  }
  const records = new Map();
  for (const record of context.records) {
    try { assertRecord(record); } catch (error) {
      if (error.code === 'contract_too_new') throw error;
      throw new InvalidCitationError('invalid_record');
    }
    if (record.sid !== context.sid) throw new InvalidCitationError('foreign_session');
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) throw new InvalidCitationError('unacknowledged_record');
    if (records.has(record.seq)) throw new InvalidCitationError('duplicate_record_seq');
    records.set(record.seq, record);
  }
  const ordinals = context.turnOrdinals ?? new Map();
  if (!(ordinals instanceof Map)) throw new InvalidCitationError('invalid_index');
  const seenOrdinals = new Set();
  for (const [seq, ordinal] of ordinals) {
    if (!Number.isSafeInteger(seq) || seq < 0 || records.has(seq) && records.get(seq).kind !== 'turn'
      || !Number.isSafeInteger(ordinal) || ordinal < 0
      || seenOrdinals.has(ordinal)) throw new InvalidCitationError('invalid_turn_index');
    seenOrdinals.add(ordinal);
  }
  return { records, ordinals };
}

function assertSummary(summary) {
  if (!summary || summary.kind !== 'summary' || Object.keys(summary).some((key) => !['kind', 'leaf_refs'].includes(key))
    || !Array.isArray(summary.leaf_refs) || !summary.leaf_refs.length
    || summary.leaf_refs.some((ref) => !Number.isSafeInteger(ref) || ref < 0)) {
    throw new InvalidCitationError('invalid_summary');
  }
}

function assertCitation(citation) {
  const content = { statement: 'Evidence', acceptance_criteria: [], constraint_refs: [] };
  if (itemSchemaErrors({
    item_ref: 'evidence', kind: 'requirement', version: 1, content,
    content_sha256: sha256Hex(canonicalJson(content)), citations: [citation],
    provenance: { intent: 'inferred', derived_from: [] }, state: 'draft',
    supersedes_item_version: null, host: null,
  }).length) {
    throw new InvalidCitationError('invalid_shape');
  }
}

function evidenceValidator(context) {
  const { records, ordinals } = hydration(context);
  const leaves = new Map();
  const expanded = new Set();
  const sourceSegments = new Map();
  const sourceCodePoints = new Map();

  function leaf(record, locator, quote) {
    let text;
    if (record.kind === 'turn' && record.data.speaker === 'person') {
      const ordinal = ordinals.get(record.seq);
      if (ordinal === undefined) throw new InvalidCitationError('missing_turn_ordinal');
      // Locator text is canonical decimal: `turn:3`, with no zero padding.
      if (locator !== `turn:${ordinal}`) throw new InvalidCitationError('dangling_locator');
      text = record.data.body;
    } else if (record.kind === 'source') {
      if (!sourceSegments.has(record.seq)) {
        sourceSegments.set(record.seq, new Map(record.data.segments.map((segment) => [segment.id, segment])));
      }
      const segment = locator.startsWith('seg:')
        ? sourceSegments.get(record.seq).get(locator.slice(4)) : undefined;
      if (!segment) throw new InvalidCitationError('dangling_locator');
      if (quote !== undefined) {
        if (!sourceCodePoints.has(record.seq)) sourceCodePoints.set(record.seq, [...record.data.text]);
        // `end` is exclusive: the code point at end is outside the quote window.
        const points = sourceCodePoints.get(record.seq);
        text = points.slice(segment.start, segment.end).join('');
      }
    } else {
      // Includes assistant turns and all reactions, even ones citing a person.
      throw new InvalidCitationError('non_person_or_document_leaf');
    }
    if (quote !== undefined && !text.includes(quote)) throw new InvalidCitationError('quote_mismatch');
    leaves.set(`${record.seq}/${locator}`, { record_seq: record.seq, locator });
  }

  function ref(seq) {
    if (expanded.has(seq)) return;
    const record = records.get(seq);
    if (!record) throw new InvalidCitationError('dangling_record');
    if (record.kind === 'turn' && record.data.speaker === 'person') {
      const ordinal = ordinals.get(seq);
      if (ordinal === undefined) throw new InvalidCitationError('missing_turn_ordinal');
      leaf(record, `turn:${ordinal}`);
    } else if (record.kind === 'source') {
      if (!record.data.segments.length) throw new InvalidCitationError('missing_document_segments');
      for (const segment of record.data.segments) leaf(record, `seg:${segment.id}`);
    } else {
      throw new InvalidCitationError('non_person_or_document_leaf');
    }
    expanded.add(seq);
  }

  function citation(entry) {
    if (entry?.kind === 'summary') {
      assertSummary(entry);
      for (const seq of entry.leaf_refs) ref(seq);
      return;
    }
    assertCitation(entry);
    const record = records.get(entry.record_seq);
    if (!record) throw new InvalidCitationError('dangling_record');
    leaf(record, entry.locator, entry.quote);
  }

  return {
    citation, ref,
    result: () => ({ leaf_refs: [...leaves.values()], authorizes: false }),
  };
}

/**
 * Validate citations and in-memory summaries against the hydrated closure.
 * @param {readonly (object | Summary)[]} citations
 * @param {ProvenanceContext} context
 * @returns {{leaf_refs: {record_seq: number, locator: string}[], authorizes: false}}
 */
export function validateCitations(citations, context) {
  if (!Array.isArray(citations)) throw new InvalidCitationError('invalid_shape');
  const evidence = evidenceValidator(context);
  for (const citation of citations) evidence.citation(citation);
  return evidence.result();
}

/**
 * Validate both displayed citations and every lane B derivation, never intent.
 * @param {object} item
 * @param {ProvenanceContext} context
 */
export function validateItemProvenance(item, context) {
  assertItem(item);
  const evidence = evidenceValidator(context);
  for (const citation of item.citations) evidence.citation(citation);
  for (const seq of item.provenance.derived_from) evidence.ref(seq);
  return evidence.result();
}

/**
 * Check an acknowledged write-ahead UI record for the exact complete version.
 * Journal writer is a worker per record-writers.json; the confirming principal
 * must independently be a verified person. Never infer identity from turn text.
 * @param {object} item
 * @param {object} confirmation
 * @param {ProvenanceContext} context
 */
export function validateConfirmation(item, confirmation, context) {
  assertItem(item);
  try { assertRecord(confirmation); } catch (error) {
    if (error.code === 'contract_too_new') throw error;
    throw new InvalidConfirmationError('invalid_record');
  }
  if (confirmation.kind !== 'ui.confirm') throw new InvalidConfirmationError('not_ui_confirm');
  if (confirmation.sid !== context?.sid) throw new InvalidConfirmationError('foreign_session');
  if (!Number.isSafeInteger(confirmation.seq) || confirmation.seq < 0) {
    throw new InvalidConfirmationError('unacknowledged_record');
  }
  const { records } = hydration(context);
  const acknowledged = records.get(confirmation.seq);
  if (!acknowledged || canonicalJson(acknowledged) !== canonicalJson(confirmation)) {
    throw new InvalidConfirmationError('not_in_hydrated_journal');
  }
  // Both session actor kinds in token-claims.schema.json represent a person;
  // anonymous sessions still have a host-verified, session-bound principal ref.
  if (!['person', 'anonymous'].includes(context.principal?.actor_kind)
    || context.principal.sub !== confirmation.data.principal_ref) {
    throw new InvalidConfirmationError('not_confirming_person');
  }
  if (confirmation.data.item_ref !== item.item_ref || confirmation.data.version !== item.version) {
    throw new InvalidConfirmationError('different_item_version');
  }
  if (confirmation.data.content_sha256 !== item.content_sha256) {
    throw new InvalidConfirmationError('content_hash_mismatch');
  }
  return { record_seq: confirmation.seq, principal_ref: confirmation.data.principal_ref };
}

/**
 * Only the draft → confirmed transition; retries on the same version are pure.
 * @param {object} item
 * @param {object} confirmation
 * @param {ProvenanceContext} context
 */
export function confirmItem(item, confirmation, context) {
  validateItemProvenance(item, context);
  validateConfirmation(item, confirmation, context);
  if (item.state !== 'draft' && item.state !== 'confirmed') {
    throw new InvalidConfirmationError('invalid_state_transition');
  }
  return { ...structuredClone(item), state: 'confirmed' };
}
