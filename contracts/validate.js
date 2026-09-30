import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Foundation contracts (AIT-35). A small, dependency-free validator for the
 * JSON Schema 2020-12 subset the contract files use, plus the semantic
 * invariants a schema cannot express. Strict by design: every object schema
 * closes its keys, so an unknown key fails validation (compatibility §9.7).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, any>} */
const fileCache = new Map();

/** @param {string} name */
export function loadContractFile(name) {
  if (!fileCache.has(name)) {
    fileCache.set(name, JSON.parse(readFileSync(join(here, name), 'utf8')));
  }
  return fileCache.get(name);
}

export const index = loadContractFile('index.json');

/**
 * @param {string} contract
 * @returns {{ file: string, major: number, minor: number, root: string }}
 */
export function contractEntry(contract) {
  const entry = index.contracts.find((/** @type {any} */ c) => c.contract === contract);
  if (!entry) throw new Error(`unknown contract ${contract}`);
  return entry;
}

/**
 * @param {string} ref
 * @param {string} baseFile
 * @returns {{ schema: any, file: string }}
 */
function resolveRef(ref, baseFile) {
  const [filePart, pointer = ''] = ref.split('#');
  const file = filePart || baseFile;
  let node = loadContractFile(file);
  for (const segment of pointer.split('/').filter(Boolean)) {
    node = node?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new Error(`unresolved $ref ${ref} from ${baseFile}`);
  return { schema: node, file };
}

/** @param {unknown} value */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  // Unsafe integers round in JavaScript; they are never valid contract integers.
  if (Number.isSafeInteger(value)) return 'integer';
  return typeof value;
}

/**
 * @param {unknown} value
 * @param {string} type
 */
function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

/**
 * RFC 3339 UTC with a date that exists (the pattern alone accepts 2026-02-30).
 * @param {string} value
 */
function isRealDateTime(value) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?Z$/.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
}

/**
 * @param {any} schema
 * @param {unknown} value
 * @param {string} file
 * @param {string} path
 * @param {string[]} errors
 */
function check(schema, value, file, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: not allowed`);
    return;
  }
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, file);
    check(target.schema, value, target.file, path, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {string} */ t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((/** @type {unknown} */ e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !isRealDateTime(value)) errors.push(`${path}: not a real date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: items not unique`);
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items, item, file, `${path}[${i}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(obj, key)) errors.push(`${path}: missing ${key}`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) check(props[key], child, file, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown key ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, child, file, `${path}.${key}`, errors);
      }
    }
  }
  if (schema.allOf) for (const sub of schema.allOf) check(sub, value, file, path, errors);
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((/** @type {any} */ sub) => {
      /** @type {string[]} */
      const subErrors = [];
      check(sub, value, file, path, subErrors);
      return subErrors.length === 0;
    }).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf, expected exactly 1`);
  }
}

/**
 * Structural validation against a named contract's root schema.
 * @param {string} contract e.g. `aithema.spec.snapshot`
 * @param {unknown} doc
 * @returns {string[]} errors; empty means valid
 */
export function validateSchema(contract, doc) {
  const entry = contractEntry(contract);
  /** @type {string[]} */
  const errors = [];
  const { schema, file } = resolveRef(`${entry.file}#${entry.root}`, entry.file);
  check(schema, doc, file, '$', errors);
  return errors;
}

/**
 * Compatibility rule (§9.7): execute only a supported major with
 * `reader_minor ≥ min_reader`; otherwise refuse with `contract_too_new`.
 * @param {{ contract: string, major: number, min_reader: number }} doc
 * @param {Record<string, { major: number, minor: number }>} [reader]
 */
export function canExecute(doc, reader = readerSupport()) {
  const supported = reader[doc.contract];
  if (!supported || supported.major !== doc.major || supported.minor < doc.min_reader) {
    return { ok: false, code: 'contract_too_new' };
  }
  return { ok: true };
}

/** The contracts this checkout implements, from `index.json`. */
export function readerSupport() {
  /** @type {Record<string, { major: number, minor: number }>} */
  const out = {};
  for (const c of index.contracts) out[c.contract] = { major: c.major, minor: c.minor };
  return out;
}

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): ECMAScript JSON.stringify
 * string and number serialisation (no HTML escaping, U+2028 literal, 1e21 →
 * 1e+21, -0 → 0), object keys sorted by UTF-16 code units, no whitespace.
 * Hosts in other languages must reproduce fixtures/canonical/rfc8785-golden.json.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} text */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const transitions = loadContractFile('transitions.json');
const writers = loadContractFile('record-writers.json');
const capabilities = loadContractFile('capabilities.json');

/**
 * Semantic invariants beyond the schema. Returns violated invariant ids.
 * @param {string} contract
 * @param {any} doc
 * @returns {string[]}
 */
export function checkInvariants(contract, doc) {
  /** @type {string[]} */
  const out = [];
  if (doc.min_reader > doc.minor) out.push('envelope.min_reader_le_minor');
  if (contract === 'aithema.spec.snapshot') snapshotInvariants(doc, out);
  if (contract === 'aithema.token.claims') tokenInvariants(doc, out);
  if (contract === 'aithema.budget.message') budgetInvariants(doc, out);
  if (contract === 'aithema.journal.record') recordInvariants(doc, out);
  if (contract === 'aithema.session.create' && doc.host_mode === 'working_spec_only' && doc.submission.auto) {
    out.push('session.working_spec_only_no_auto');
  }
  return out;
}

/**
 * @param {any} doc
 * @param {string[]} out
 */
function snapshotInvariants(doc, out) {
  if (doc.working_rev !== doc.expected_prev_rev + 1) out.push('snapshot.rev_is_prev_plus_one');
  if (sha256Hex(doc.patch.canonical) !== doc.patch.sha256) out.push('snapshot.patch_sha256_matches');
  const mode = transitions.modes[doc.host_mode];
  /** @type {Map<string, any>} */
  const byRef = new Map();
  for (const item of doc.spec.items) {
    const key = `${item.item_ref}@${item.version}`;
    if (byRef.has(key)) out.push('item.version_unique');
    byRef.set(key, item);
    if (sha256Hex(canonicalJson(item.content)) !== item.content_sha256) out.push('item.content_sha256_matches');
    if (!mode.states.includes(item.state)) out.push('item.state_allowed_in_mode');
    if (!mode.submits && item.host) out.push('mode.working_spec_only_no_host_identity');
    if (transitions.host_identity_required.includes(item.state) && !item.host) out.push('item.host_identity_required');
    if (transitions.host_identity_forbidden.includes(item.state) && item.host) out.push('item.host_identity_forbidden');
  }
  for (const item of doc.spec.items) {
    const sup = item.supersedes_item_version;
    if (!sup) continue;
    if (sup.item_ref !== item.item_ref || sup.version >= item.version) out.push('item.supersedes_same_ref_older_version');
    const prior = byRef.get(`${sup.item_ref}@${sup.version}`);
    if (!prior) out.push('item.supersedes_target_exists');
    else if (prior.state !== 'superseded') out.push('item.supersedes_target_is_superseded');
  }
  /** @type {Map<string, any[]>} */
  const versions = new Map();
  for (const item of doc.spec.items) versions.set(item.item_ref, [...(versions.get(item.item_ref) ?? []), item]);
  for (const list of versions.values()) {
    const accepted = list.filter((i) => i.state === 'accepted');
    if (accepted.length > 1) out.push('item.one_accepted_version');
    if (accepted.length && list.some((i) => i.version > accepted[0].version || !transitions.closed_states.includes(i.state))) {
      out.push('item.accepted_is_terminal');
    }
    if (list.filter((i) => !transitions.closed_states.includes(i.state)).length > 1) out.push('item.one_live_version');
  }
  if (!mode.submits && doc.pending_ops.some((/** @type {any} */ op) => transitions.submission_ops.includes(op.op))) {
    out.push('mode.working_spec_only_never_submits');
  }
  const keys = doc.pending_ops.map((/** @type {any} */ op) => op.op_key);
  if (new Set(keys).size !== keys.length) out.push('ops.op_key_unique');
  for (const op of doc.pending_ops) {
    if (sha256Hex(op.payload) !== op.payload_sha256) out.push('op.payload_sha256_matches');
  }
}

/**
 * @param {any} doc
 * @param {string[]} out
 */
function tokenInvariants(doc, out) {
  const claims = doc.claims;
  if (claims.exp - claims.iat > capabilities.token_max_lifetime_seconds) out.push('token.lifetime_max_15_min');
  if (claims.exp <= claims.iat) out.push('token.exp_after_iat');
  if (doc.token === 'delegated') {
    for (const cap of claims.capabilities) {
      if (capabilities.never_in_token.includes(cap)) out.push('token.acceptance_never_delegated');
      else if (!capabilities.delegated_allowed.includes(cap)) out.push('token.capability_allowed');
    }
  }
}

/**
 * @param {any} doc
 * @param {string[]} out
 */
function budgetInvariants(doc, out) {
  if (doc.type === 'recover_response' && doc.body.closed_reason === 'void' && doc.body.charged_micro !== 0) {
    out.push('budget.recover_void_zero');
  }
  if (doc.type === 'settle_request') {
    const hasActual = doc.body.actual_micro !== undefined;
    if ((doc.body.outcome === 'settled') !== hasActual) out.push('budget.settled_has_actual_unknown_has_none');
  }
  if (doc.type !== 'admit_request') return;
  const [sid, gen, lane, n] = doc.body.attempt_id.split(':');
  if (sid !== doc.body.sid || Number(gen) !== doc.body.worker_generation || lane !== doc.body.lane) {
    out.push('budget.attempt_id_binds_sid_generation_lane');
  }
  if (!Number.isSafeInteger(Number(gen)) || !Number.isSafeInteger(Number(n))) out.push('budget.attempt_id_safe_integers');
}

/**
 * @param {any} doc
 * @param {string[]} out
 */
function recordInvariants(doc, out) {
  if (doc.kind === 'reaction' && !doc.data.text.startsWith(doc.data.delivered_prefix)) out.push('reaction.prefix_of_text');
  if (doc.kind === 'reaction' && doc.data.complete && doc.data.delivered_prefix !== doc.data.text) out.push('reaction.complete_means_fully_delivered');
  if (doc.kind === 'design.input') {
    if (Buffer.byteLength(JSON.stringify(doc.data.screen_ir), 'utf8') > 512 * 1024) out.push('design_input.ir_max_512_kib');
    if (Buffer.byteLength(JSON.stringify(doc.data.tokens), 'utf8') > 64 * 1024) out.push('design_input.tokens_max_64_kib');
  }
  if (doc.writer.kind === 'worker' && doc.writer.generation === undefined) out.push('record.worker_has_generation');
  if (!writers.writers[doc.kind].includes(doc.writer.kind)) out.push('record.writer_allowed');
  if (doc.kind === 'turn') {
    const assistant = doc.data.speaker === 'assistant';
    if (assistant !== (doc.data.trust === 'assistant')) out.push('turn.speaker_trust_consistent');
    if (doc.writer.kind === 'browser' && doc.data.speaker !== writers.browser_turn_speaker) out.push('turn.browser_writes_person_turns');
  }
  if (doc.kind === 'session.end' && doc.data.host_mode === 'working_spec_only' && doc.data.export !== 'exported') {
    out.push('session_end.working_spec_only_exports');
  }
  if (doc.kind === 'budget.settle') {
    const claimed = doc.data.claim_id !== undefined;
    if (doc.data.outcome === 'void' && (claimed || doc.data.charged_micro !== 0)) out.push('budget.settle_void_unclaimed_zero');
    if (doc.data.outcome !== 'void' && !claimed) out.push('budget.settle_claim_required');
  }
  if (doc.kind === 'budget.hold') {
    const [sid, gen, lane] = doc.data.attempt_id.split(':');
    if (sid !== doc.sid || Number(gen) !== doc.writer.generation || lane !== doc.data.lane) out.push('budget.hold_attempt_binds_record');
  }
  if (doc.kind === 'source') {
    const length = [...doc.data.text].length;
    const ids = doc.data.segments.map((/** @type {any} */ g) => g.id);
    if (new Set(ids).size !== ids.length) out.push('source.segment_ids_unique');
    if (doc.data.segments.some((/** @type {any} */ g) => g.start > g.end || g.end > length)) out.push('source.segments_in_bounds');
  }
  if (doc.kind === 'design.input') {
    if (sha256Hex(canonicalJson(doc.data.screen_ir)) !== doc.data.screen_ir_sha256) out.push('design_input.screen_ir_sha256_matches');
    if (sha256Hex(canonicalJson(doc.data.tokens)) !== doc.data.tokens_sha256) out.push('design_input.tokens_sha256_matches');
  }
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > 1024 * 1024) out.push('record.encoded_max_1_mib');
}

/**
 * Full check: structure first, then invariants.
 * @param {string} contract
 * @param {unknown} doc
 */
export function validate(contract, doc) {
  const schemaErrors = validateSchema(contract, doc);
  if (schemaErrors.length) return { ok: false, schemaErrors, invariants: [] };
  const invariants = checkInvariants(contract, doc);
  return { ok: invariants.length === 0, schemaErrors, invariants };
}
