import { canExecute, canonicalJson, validate } from '../../contracts/validate.js';

/**
 * JournalPort is the engine's host boundary. Methods may return promises or
 * synchronous values. A transport adapter must supply a VERIFIED authority;
 * writer_kind is derived from authentication, never from submitted JSON.
 * JWT verification and authority polling belong to AIT-P05.
 *
 * @typedef {{sid:string, tid:string, pid:string, gen:number, auth_epoch:number,
 *   writer_kind:'worker'|'browser'|'host', capabilities:string[], exp:number}} JournalAuthority
 * @typedef {{document:any, bytes:Buffer}} StoredRecord
 * @typedef {{worker_generation:number, auth_epoch:number, working_rev:number,
 *   last_seq:number, audit_seq:number, snapshot:StoredRecord|null}} JournalCursor
 * @typedef {Object} JournalPort
 * @property {(bytes:string|Uint8Array, authority:JournalAuthority) => StoredRecord|Promise<StoredRecord>} append
 * @property {(authority:JournalAuthority) => JournalCursor|Promise<JournalCursor>} cursor
 * @property {(ids:number[], authority:JournalAuthority) => StoredRecord[]|Promise<StoredRecord[]>} recordsByIds
 * @property {(after:number, authority:JournalAuthority, through?:number) => StoredRecord[]|Promise<StoredRecord[]>} recordsAfter
 * @property {(authority:JournalAuthority) => JournalCursor|Promise<JournalCursor>} takeover
 */

/** Stable catalogue codes, or ordinary HTTP errors without an invented code. */
export class JournalError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'JournalError';
    this.status = status;
    this.code = code;
  }
}

/** Copy the submission immediately: callers cannot mutate an in-flight buffer. */
export function submissionBytes(bytes) {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new JournalError(400, 'Journal submissions require original UTF-8 JSON bytes');
}

/** Validate without reserialising; storage and idempotency use original bytes. */
export function decodeDocument(bytes, { submission = false } = {}) {
  let doc;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    doc = JSON.parse(text);
  } catch {
    throw new JournalError(400, 'Malformed UTF-8 JSON');
  }
  if (!doc || !['aithema.journal.record', 'aithema.spec.snapshot', 'aithema.session.create'].includes(doc.contract)) {
    throw new JournalError(400, 'Unsupported journal document');
  }
  if (!canExecute(doc).ok) throw new JournalError(422, 'Unsupported contract reader version', 'contract_too_new');
  const result = validate(doc.contract, doc);
  if (!result.ok) {
    throw new JournalError(400, `Invalid journal document: ${[...result.schemaErrors, ...result.invariants].join('; ')}`);
  }
  if (submission && Object.hasOwn(doc, 'seq')) throw new JournalError(400, 'seq is assigned by the host');
  if (doc.contract === 'aithema.journal.record' && bytes.length > 1024 * 1024) {
    throw new JournalError(413, 'Encoded journal record exceeds 1 MiB');
  }
  if (doc.contract === 'aithema.spec.snapshot') {
    let canonical;
    try { canonical = canonicalJson(JSON.parse(doc.patch.canonical)); } catch { /* rejected below */ }
    if (canonical !== doc.patch.canonical) throw new JournalError(400, 'patch.canonical must contain RFC 8785 JSON');
  }
  return doc;
}
