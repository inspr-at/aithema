import { canExecute, canonicalJson, loadContractFile, validate } from '../../contracts/validate.js';

/**
 * Engine/host boundary. Submissions are original UTF-8 contract bytes, not an
 * indexed JSON projection. The host adapter supplies VERIFIED authority (JWT
 * verification belongs to AIT-P05). All methods may be synchronous or async.
 *
 * @typedef {import('../journal/port.js').JournalAuthority} BudgetAuthority
 * @typedef {Object} BudgetPort
 * @property {(bytes:string|Uint8Array, authority:BudgetAuthority) => any|Promise<any>} admit
 * @property {(bytes:string|Uint8Array, authority:BudgetAuthority) => any|Promise<any>} claim
 * @property {(bytes:string|Uint8Array, authority:BudgetAuthority) => any|Promise<any>} settle
 * @property {(bytes:string|Uint8Array, authority:BudgetAuthority) => any|Promise<any>} recover
 * @property {(query:{cursor?:string|null, limit?:number}, authority:BudgetAuthority) => any|Promise<any>} listOpen
 * @property {(authority:BudgetAuthority) => boolean|Promise<boolean>} isCurrent
 */

const codes = new Map(loadContractFile('error-codes.json').codes.map((entry) => [entry.code, entry.http]));

export class BudgetError extends Error {
  constructor(status, message, code = null, detail = undefined) {
    super(message);
    this.name = 'BudgetError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = structuredClone(detail);
  }
}

/** Copy before any await; never allow a caller to change in-flight bytes. */
export function budgetBytes(bytes) {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new BudgetError(400, 'Budget submissions require original UTF-8 JSON bytes');
}

export function checkMessage(doc, type) {
  if (!doc || doc.contract !== 'aithema.budget.message') throw new BudgetError(400, 'Expected a budget message');
  if (!canExecute(doc).ok) throw new BudgetError(422, 'Unsupported budget contract version', 'contract_too_new');
  const result = validate(doc.contract, doc);
  if (!result.ok || doc.type !== type) throw new BudgetError(400, `Invalid budget ${type} message`);
  return doc;
}

export function decodeMessage(bytes, type) {
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch { throw new BudgetError(400, 'Malformed UTF-8 JSON'); }
  return checkMessage(doc, type);
}

export function budgetMessage(type, body) {
  // Strict older readers reject the new lane_kind key. Legacy messages retain
  // their exact envelope; the additive local-lane documents use the next minor.
  return checkMessage({ contract: 'aithema.budget.message', major: 1,
    minor: body?.lane_kind === undefined ? 0 : 1, min_reader: 0, type, body }, type);
}

export function encodeMessage(type, body) {
  return Buffer.from(canonicalJson(budgetMessage(type, body)), 'utf8');
}

/** The wire body remains contract-valid; HTTP adapters use this mapping. */
export function resultStatus(doc) {
  checkMessage(doc, doc?.type);
  const code = doc.body.denied ? 'budget_denied' : doc.body.error ?? null;
  return { status: code ? codes.get(code) : 200, code };
}

export function requireSuccess(doc, type) {
  checkMessage(doc, type);
  const { status, code } = resultStatus(doc);
  if (code) throw new BudgetError(status, doc.body.denied ?? code, code, doc.body.detail);
  return doc.body;
}

/** Keyset traversal shared by admission checks, dispatch finishing and drain. */
export async function* openHoldPages(listOpen, { limit = 1000 } = {}) {
  const seen = new Set();
  let cursor = null;
  do {
    const page = await listOpen({ cursor, limit });
    budgetMessage('holds_list', page);
    cursor = page.next_cursor;
    if (cursor !== null && seen.has(cursor)) throw new BudgetError(502, 'Ledger enumeration cursor did not advance');
    seen.add(cursor);
    yield page;
  } while (cursor !== null);
}

export async function findOpenHold(listOpen, holdId) {
  for await (const page of openHoldPages(listOpen)) {
    const hold = page.holds.find((entry) => entry.hold_id === holdId);
    if (hold) return hold;
  }
  return null;
}
