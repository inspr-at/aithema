import { canExecute, canonicalJson, validate } from '../../contracts/validate.js';
import { loadContractFile } from '../../contracts/validate.js';

export const capabilities = loadContractFile('capabilities.json');
export const transitions = loadContractFile('transitions.json');
export const errorCodes = new Map(loadContractFile('error-codes.json').codes.map((entry) => [entry.code, entry.http]));

/** Standard transport failures are deliberately outside the contract catalogue. */
export class HostError extends Error {
  constructor(status, message, code = null, document = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.document = document;
  }
}

export function fail(code, document = null) {
  if (!errorCodes.has(code)) throw new Error(`Uncatalogued host error: ${code}`);
  throw new HostError(errorCodes.get(code), code, code, document);
}

export function envelope(contract, fields) {
  return { contract, major: 1, minor: 0, min_reader: 0, ...fields };
}

/** All domain documents cross the same strict foundation validator. */
export function document(value, contract) {
  if (!value || value.contract !== contract) throw new HostError(400, `Expected ${contract}`);
  if (!canExecute(value).ok) fail('contract_too_new');
  const result = validate(contract, value);
  if (!result.ok) throw new HostError(400, `Invalid ${contract}: ${[...result.schemaErrors, ...result.invariants].join('; ')}`);
  return value;
}

/** Reject lossy in-process JSON values rather than quietly serializing them away. */
function jsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) jsonValue(value[i]);
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new HostError(400, 'Unsafe JSON key');
      jsonValue(child);
    }
    return;
  }
  throw new HostError(400, 'Expected lossless JSON data');
}

/** Strings retain the exact submitted bytes for retry/conflict comparison. */
export function input(value) {
  try {
    const bytes = typeof value === 'string' ? value : (jsonValue(value), JSON.stringify(value));
    if (Buffer.byteLength(bytes, 'utf8') > 1024 * 1024) throw new HostError(413, 'Request exceeds 1 MiB');
    const doc = JSON.parse(bytes);
    jsonValue(doc);
    return { bytes, doc };
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError(400, 'Malformed JSON');
  }
}

/** Optional on legacy contract-only fixtures; Aeon sends canonical metadata. */
export function intakeMetadata(header) {
  if (header === undefined) return null;
  try {
    if (typeof header !== 'string' || !/^[A-Za-z0-9_-]+$/.test(header)) throw new Error();
    const bytes = Buffer.from(header, 'base64url');
    if (bytes.toString('base64url') !== header) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const metadata = JSON.parse(text);
    jsonValue(metadata);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || canonicalJson(metadata) !== text) throw new Error();
    return metadata;
  } catch { throw new HostError(400, 'Invalid X-Aithema-Intake metadata'); }
}

export function budget(type, body) {
  return document(envelope('aithema.budget.message', { type, body }), 'aithema.budget.message');
}

export function errorResponse(error) {
  if (!(error instanceof HostError)) throw error;
  // Transport envelopes have no foundation schema. Every embedded domain
  // document does: catalogue errors use the existing error-event contract.
  const body = error.code
    ? { code: error.code, document: error.document ?? document(envelope('aithema.element.event', {
      type: 'aithema-error', detail: { code: error.code },
    }), 'aithema.element.event') }
    : { message: error.message };
  return { status: error.status, headers: { 'cache-control': 'no-store' }, body };
}
