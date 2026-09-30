import { assertCanContribute } from './authority.js';
import { canonicalJson, loadContractFile, sha256Hex, validate, validateSchema } from '../contracts/validate.js';

/** @import { HostMode, ItemVersion, VerifiedAuthority, WorkingItem, WorkingItemHost, WorkingSpec } from './types.js' */

const lifecycle = loadContractFile('transitions.json');
const snapshotContract = 'aithema.spec.snapshot';
// Validation context only: no generated ids, clocks, journal or host I/O in
// this domain. The host supplies the real envelope when persisting a snapshot.
const validationId = '00000000-0000-4000-8000-000000000000';

/** @param {unknown} value */
function freezeJson(value) {
  const copy = JSON.parse(canonicalJson(value));
  function freeze(node) {
    if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
    return node;
  }
  return freeze(copy);
}

/** @param {string} code */
function conflict(code) {
  const entry = loadContractFile('error-codes.json').codes.find((row) => row.code === code);
  return Object.assign(new Error(code), { code, status: entry.http });
}

/** @param {HostMode} hostMode @param {readonly WorkingItem[]} items */
function validationSnapshot(hostMode, items) {
  return {
    contract: snapshotContract, major: 1, minor: 0, min_reader: 0,
    sid: validationId, client_event_id: validationId,
    working_rev: 1, expected_prev_rev: 0, consumed_seq: 0, worker_generation: 1,
    host_mode: hostMode,
    spec: { items, questions: [], brief: null, screens: [] },
    pending_ops: [], corrections: [],
    patch: { canonical: '{}', sha256: sha256Hex('{}') },
  };
}

/** @param {WorkingSpec} spec */
export function assertWorkingSpec(spec) {
  if (!spec || Object.keys(spec).some((key) => !['host_mode', 'items'].includes(key))) {
    throw new Error('working spec requires only host_mode and items');
  }
  // Canonicalisation rejects non-JSON input before shape/digest checks.
  canonicalJson(spec);
  const result = validate(snapshotContract, validationSnapshot(spec.host_mode, spec.items));
  if (!result.ok) throw new Error(`invalid working spec: ${[...result.schemaErrors, ...result.invariants].join('; ')}`);
  for (let index = 0; index < spec.items.length; index += 1) {
    if (spec.items[index].host) assertHostUnique(spec.items.slice(0, index), spec.items[index].host);
  }
  return spec;
}

/**
 * Validate a detached replacement version structurally. Its predecessor must
 * be checked in the complete spec when the atomic replacement is recorded.
 * @param {WorkingItem} item @param {HostMode} hostMode
 */
function assertItem(item, hostMode) {
  canonicalJson(item);
  const errors = validateSchema(snapshotContract, validationSnapshot(hostMode, [item]));
  if (errors.length) throw new Error(`invalid working item: ${errors.join('; ')}`);
  if (sha256Hex(canonicalJson(item.content)) !== item.content_sha256) throw new Error('item content_sha256 mismatch');
  const mode = lifecycle.modes[hostMode];
  if (!mode.states.includes(item.state)) throw new Error('item state is not allowed in this host mode');
  if ((!mode.submits || lifecycle.host_identity_forbidden.includes(item.state)) && item.host) {
    throw new Error('host identity is forbidden for this item');
  }
  if (lifecycle.host_identity_required.includes(item.state) && !item.host) throw new Error('host identity is required');
}

/** @param {HostMode} hostMode @param {readonly WorkingItem[]} [items] */
export function createWorkingSpec(hostMode, items = []) {
  const spec = { host_mode: hostMode, items };
  assertWorkingSpec(spec);
  return freezeJson(spec);
}

/** @param {WorkingSpec} spec @param {ItemVersion} identity */
function findItem(spec, identity) {
  if (!identity || Object.keys(identity).some((key) => !['item_ref', 'version'].includes(key))) {
    throw new Error('item identity requires item_ref and version only');
  }
  const item = spec.items.find((row) => row.item_ref === identity.item_ref && row.version === identity.version);
  if (!item) throw new Error('item version was not found');
  return item;
}

/** @param {WorkingSpec} spec @param {WorkingItem} item @param {string} state */
function transition(spec, item, state) {
  if (!lifecycle.modes[spec.host_mode].transitions.some((row) => row.from === item.state && row.to === state)) {
    if (item.state === 'accepted') throw conflict('already_accepted');
    if (item.state === 'superseded') throw conflict('draft_superseded');
    throw new Error(`illegal working item transition ${item.state} -> ${state}`);
  }
  return { ...item, state };
}

/**
 * @param {WorkingSpec} spec
 * @param {{item_ref: string, kind: 'requirement'|'constraint', content: import('./types.js').WorkingItemContent, citations: readonly import('./types.js').WorkingCitation[], provenance: import('./types.js').WorkingProvenance}} input
 */
export function addWorkingItem(spec, input) {
  assertWorkingSpec(spec);
  if (!input || Object.keys(input).some((key) => !['item_ref', 'kind', 'content', 'citations', 'provenance'].includes(key))) {
    throw new Error('new item accepts item_ref, kind, content, citations and provenance only');
  }
  if (spec.items.some((item) => item.item_ref === input.item_ref)) {
    throw new Error('item_ref already exists; revise an existing version or use a new identity');
  }
  const item = {
    ...input, version: 1, state: 'draft', host: null,
    content_sha256: sha256Hex(canonicalJson(input.content)), supersedes_item_version: null,
  };
  return createWorkingSpec(spec.host_mode, [...spec.items, item]);
}

/**
 * New content/evidence is a new draft, never an edit to a confirmed/proposed
 * version. For a proposed predecessor this returns a detached candidate: it
 * cannot join the persisted spec until host replace succeeds. Rejected and
 * invalidated history stays closed; a new version has no supersedes link to it.
 * @param {WorkingSpec} spec @param {ItemVersion} identity
 * @param {{content: import('./types.js').WorkingItemContent, citations: readonly import('./types.js').WorkingCitation[], provenance: import('./types.js').WorkingProvenance}} revision
 * @returns {WorkingItem}
 */
export function prepareWorkingItemRevision(spec, identity, revision) {
  assertWorkingSpec(spec);
  const old = findItem(spec, identity);
  if (old.state === 'accepted') throw conflict('already_accepted');
  if (old.state === 'superseded') throw conflict('draft_superseded');
  if (spec.items.some((item) => item.item_ref === old.item_ref && item.version > old.version)) {
    throw conflict('draft_superseded');
  }
  if (Object.keys(revision).some((key) => !['content', 'citations', 'provenance'].includes(key))) {
    throw new Error('revision accepts content, citations and provenance only');
  }
  if (old.state === 'rejected') {
    const priorEvidence = new Set([...old.citations.map((c) => c.record_seq), ...old.provenance.derived_from]);
    const newEvidence = [...(revision.citations ?? []).map((c) => c.record_seq), ...(revision.provenance?.derived_from ?? [])];
    if (!newEvidence.some((seq) => !priorEvidence.has(seq))) throw new Error('a rejected item needs new evidence');
  }
  const candidate = {
    item_ref: old.item_ref, kind: old.kind, version: old.version + 1,
    ...revision, content_sha256: sha256Hex(canonicalJson(revision.content)),
    state: 'draft', host: null,
    supersedes_item_version: lifecycle.closed_states.includes(old.state)
      ? null : { item_ref: old.item_ref, version: old.version },
  };
  assertItem(candidate, spec.host_mode);
  return freezeJson(candidate);
}

/** @param {WorkingSpec} spec @param {ItemVersion} identity @param {Parameters<typeof prepareWorkingItemRevision>[2]} revision */
export function reviseWorkingItem(spec, identity, revision) {
  const candidate = prepareWorkingItemRevision(spec, identity, revision);
  const old = findItem(spec, identity);
  if (old.state === 'proposed') throw new Error('proposed versions require atomic host replacement');
  const items = spec.items.map((item) => item === old && !lifecycle.closed_states.includes(item.state)
    ? transition(spec, old, 'superseded') : item);
  return createWorkingSpec(spec.host_mode, [...items, candidate]);
}

/**
 * Trusted-UI boundary, after the host has written ui.confirm ahead of the
 * snapshot. The caller authenticates the UI principal; turn text, citations
 * and intent labels must never invoke this API as authorization.
 * @param {WorkingItem} item
 * @param {{item_ref: string, version: number, content_sha256: string, principal_ref: string}} confirmation
 * @param {HostMode} hostMode
 */
export function confirmWorkingItemVersion(item, confirmation, hostMode) {
  assertItem(item, hostMode);
  const record = {
    contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
    sid: validationId, client_event_id: validationId, writer: { kind: 'worker', generation: 1 },
    recorded_at: '2000-01-01T00:00:00Z', kind: 'ui.confirm', data: confirmation,
  };
  const result = validate(record.contract, record);
  if (!result.ok) throw new Error(`invalid UI confirmation: ${result.schemaErrors.join('; ')}`);
  if (confirmation.item_ref !== item.item_ref || confirmation.version !== item.version
    || confirmation.content_sha256 !== item.content_sha256) throw new Error('UI confirmation must bind the exact item version and content_sha256');
  if (item.state === 'confirmed') return freezeJson(item);
  return freezeJson(transition({ host_mode: hostMode }, item, 'confirmed'));
}

/** @param {WorkingSpec} spec @param {Parameters<typeof confirmWorkingItemVersion>[1]} confirmation */
export function confirmWorkingItem(spec, confirmation) {
  assertWorkingSpec(spec);
  const item = findItem(spec, { item_ref: confirmation.item_ref, version: confirmation.version });
  const confirmed = confirmWorkingItemVersion(item, confirmation, spec.host_mode);
  return createWorkingSpec(spec.host_mode, spec.items.map((row) => row === item ? confirmed : row));
}

/**
 * Projection is a submission boundary, not a review operation. Bindings are
 * assigned by the host adapter and must cover exactly the confirmed versions.
 * This returns the spec to persist atomically with the host proposals; no I/O
 * occurs here. working_spec_only returns no proposals and no host identities.
 * Standalone proposals preserve the complete confirmed content and evidence
 * in addition to their existing requirement/constraint payload.
 * @param {WorkingSpec} spec @param {VerifiedAuthority} authority
 * @param {{bindings: readonly (ItemVersion & {host: WorkingItemHost})[], contributed_at: string}} submission
 */
export function projectSubmission(spec, authority, submission) {
  assertWorkingSpec(spec);
  if (!lifecycle.modes[spec.host_mode].submits) return Object.freeze({ spec: createWorkingSpec(spec.host_mode, spec.items), proposals: Object.freeze([]) });
  assertCanContribute(authority);
  const confirmed = spec.items.filter((item) => item.state === 'confirmed');
  if (!submission || !Array.isArray(submission.bindings) || submission.bindings.length !== confirmed.length
    || typeof submission.contributed_at !== 'string' || !submission.contributed_at.trim()) {
    throw new Error('submission requires one host binding per confirmed version and contributed_at');
  }
  const used = new Set();
  const proposals = [];
  const items = spec.items.map((item) => {
    if (item.state !== 'confirmed') return item;
    const index = submission.bindings.findIndex((binding) => binding.item_ref === item.item_ref && binding.version === item.version);
    if (index < 0 || used.has(index)) throw new Error('missing or duplicate submission item binding');
    used.add(index);
    const binding = submission.bindings[index];
    if (Object.keys(binding).some((key) => !['item_ref', 'version', 'host'].includes(key))) throw new Error('unknown submission binding key');
    if (!binding.host?.op_key?.includes(':submit:')) throw new Error('submission requires a submit op_key');
    const proposed = { ...transition(spec, item, 'proposed'), host: binding.host };
    assertItem(proposed, spec.host_mode);
    assertHostUnique(spec.items, proposed.host);
    assertHostUnique(proposals.map((proposal) => ({ host: proposal.host })), proposed.host);
    proposals.push(projectItem(proposed, authority, submission.contributed_at));
    return proposed;
  });
  return Object.freeze({ spec: createWorkingSpec(spec.host_mode, items), proposals: freezeJson(proposals.map((entry) => entry.proposal)) });
}

/** @param {readonly {host: WorkingItemHost|null}[]} items @param {WorkingItemHost} host */
function assertHostUnique(items, host) {
  const key = Object.hasOwn(host, 'proposal_ref') ? 'proposal_ref' : 'draft_id';
  if (items.some((item) => item.host && item.host[key] === host[key])) throw new Error('host proposal identity is already bound to an item version');
}

/** @param {WorkingItem} item @param {VerifiedAuthority} authority @param {string} contributedAt */
function projectItem(item, authority, contributedAt) {
  const common = {
    op_key: item.host.op_key, content: item.content, content_sha256: item.content_sha256,
    citations: item.citations, provenance: item.provenance,
  };
  let proposal;
  if ('proposal_ref' in item.host) {
    proposal = {
      ...common, proposal_ref: item.host.proposal_ref,
      contributed_by: authority.party_ref, contributed_at: contributedAt,
      summary: `Add ${item.kind} ${item.item_ref}`,
      kind: item.kind === 'requirement' ? 'add_requirement' : 'add_constraint',
      ...(item.kind === 'requirement'
        ? { requirement: { requirement_ref: item.item_ref, statement: item.content.statement, acceptance_criteria: item.content.acceptance_criteria, constraint_refs: item.content.constraint_refs } }
        : { constraint: { constraint_ref: item.item_ref, kind: item.content.constraint_kind, statement: item.content.statement } }),
    };
    if (item.kind === 'constraint' && !item.content.constraint_kind) throw new Error('standalone constraint projection requires constraint_kind');
  } else {
    proposal = { ...common, draft_id: item.host.draft_id, kind: item.kind === 'requirement' ? 'requirement' : 'brief' };
  }
  return { host: item.host, proposal: freezeJson(proposal) };
}

/**
 * Record a successful atomic host replacement. Call inside the same host
 * transaction as replaceProposal (or after an Aeon replace receipt); never
 * record supersession before host success. The detached version must have its
 * own full-content UI confirmation. Accepted items remain terminal.
 * @param {WorkingSpec} spec @param {ItemVersion} identity
 * @param {WorkingItem} confirmedReplacement @param {WorkingItemHost} host
 */
export function recordWorkingItemReplacement(spec, identity, confirmedReplacement, host) {
  assertWorkingSpec(spec);
  const old = findItem(spec, identity);
  const superseded = transition(spec, old, 'superseded');
  if (old.state !== 'proposed') throw new Error('host replacement requires a proposed predecessor');
  assertItem(confirmedReplacement, spec.host_mode);
  if (confirmedReplacement.state !== 'confirmed' || confirmedReplacement.item_ref !== old.item_ref
    || confirmedReplacement.kind !== old.kind || confirmedReplacement.version !== old.version + 1
    || canonicalJson(confirmedReplacement.supersedes_item_version) !== canonicalJson(identity)) {
    throw new Error('replacement must be the confirmed next version of the proposed predecessor');
  }
  if (!host?.op_key?.includes(':replace:') || ('proposal_ref' in old.host) !== Object.hasOwn(host, 'proposal_ref')) {
    throw new Error('replacement requires the same host identity type and a replace op_key');
  }
  assertHostUnique(spec.items, host);
  const replacement = { ...transition(spec, confirmedReplacement, 'proposed'), host };
  return createWorkingSpec(spec.host_mode, [...spec.items.map((item) => item === old ? superseded : item), replacement]);
}

/**
 * Build the host replacement and its corresponding working-spec state as one
 * pure result. The adapter commits both only after host arbitration succeeds.
 * Supersedes relations stay in their respective identity namespaces.
 * @param {WorkingSpec} spec @param {VerifiedAuthority} authority @param {ItemVersion} identity
 * @param {WorkingItem} confirmedReplacement
 * @param {{host: WorkingItemHost, contributed_at: string}} submission
 */
export function projectWorkingItemReplacement(spec, authority, identity, confirmedReplacement, submission) {
  assertCanContribute(authority);
  if (!submission || typeof submission.contributed_at !== 'string' || !submission.contributed_at.trim()) {
    throw new Error('replacement requires contributed_at and a host binding');
  }
  const next = recordWorkingItemReplacement(spec, identity, confirmedReplacement, submission.host);
  const old = findItem(spec, identity);
  const item = findItem(next, { item_ref: identity.item_ref, version: confirmedReplacement.version });
  const projected = projectItem(item, authority, submission.contributed_at).proposal;
  const link = 'proposal_ref' in old.host
    ? { supersedes_proposal_ref: old.host.proposal_ref }
    : { supersedes_draft_id: old.host.draft_id };
  return Object.freeze({ spec: next, proposal: freezeJson({ ...projected, ...link }) });
}

/**
 * Apply a verified host decision; the adapter supplies person authorization
 * for acceptance/rejection and host-computed staleness for invalidation.
 * Accepted node ids never enter working-spec or proposal relations.
 * @param {WorkingSpec} spec @param {ItemVersion} identity @param {WorkingItemHost} host
 * @param {'accepted'|'rejected'|'invalidated'} state
 */
export function recordHostDecision(spec, identity, host, state) {
  assertWorkingSpec(spec);
  const item = findItem(spec, identity);
  if (!['accepted', 'rejected', 'invalidated'].includes(state)) throw new Error('unsupported host decision');
  if (!item.host || canonicalJson(item.host) !== canonicalJson(host)) throw new Error('host decision must bind the exact proposal identity');
  if (item.state === state) return createWorkingSpec(spec.host_mode, spec.items);
  const decided = transition(spec, item, state);
  return createWorkingSpec(spec.host_mode, spec.items.map((row) => row === item ? decided : row));
}
