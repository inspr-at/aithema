import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, loadContractFile } from '../contracts/validate.js';

/** @import { Baseline, Constraint, Decision, ProjectKind, Proposal, Requirement, RequirementsStream, SourceClaim, VerifiedAuthority } from './types.js' */
import { assertCanApproveBaseline, assertCanContribute, assertCanProposeImport } from './authority.js';
import { assertRevisionSeal, contentDigest, freezeBaseline, revisionSeal } from './digest.js';
import { acceptRevisionReview } from './revision-review.js';
import { createWorkingSpec } from './working-spec.js';
import {
  assertRehydratedBaseline,
  assertUniqueRefs,
  validateConstraint,
  validateProjectKinds,
  validateProposal,
  validateRequirement,
} from './validate.js';

const proposalKeys = new Set([
  'proposal_ref', 'kind', 'contributed_by', 'contributed_at', 'summary',
  'requirement', 'constraint', 'import_requirements', 'import_constraints', 'source_claim',
  'against_baseline_ref', 'against_revision', 'against_content_digest',
  'op_key', 'supersedes_proposal_ref',
  'content', 'content_sha256', 'citations', 'provenance',
]);

/**
 * Journal/rehydration inputs are plain JSON data. Inspect descriptors without
 * invoking accessors, and detach every nested value before any validation or
 * lookup. Only own enumerable data is copied; array holes and extra enumerable
 * array properties are rejected. Freeze the copy, never the caller's objects.
 * In-process manipulation of this library's internal copy (including patched
 * built-in prototypes) is outside this plain-data boundary's threat model.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function plainDataSnapshot(value) {
  const ancestors = new Set();
  const stringFields = new Set(['proposal_ref', 'supersedes_proposal_ref', 'op_key']);
  const invalid = (reason) => new TypeError(`plain-data snapshot: ${reason}`);
  /** @param {unknown} node */
  function copy(node) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw invalid('finite numbers required');
      return node;
    }
    if (typeof node !== 'object') throw invalid('JSON values required');
    if (types.isProxy(node)) throw invalid('proxies are not plain data');
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw invalid('plain objects and arrays required');
    }
    if (ancestors.has(node)) throw invalid('cycles are not JSON data');
    ancestors.add(node);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(node);
      const result = array ? [] : {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') throw invalid('symbol properties and custom iterators are not plain data');
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) throw invalid('accessors are not plain data');
        if (stringFields.has(key) && typeof descriptor.value !== 'string') {
          throw invalid(`stream ${key} is invalid; primitive string required`);
        }
        const child = copy(descriptor.value);
        if (!descriptor.enumerable) continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length.value)) {
          throw invalid('extra array properties are not JSON data');
        }
        Object.defineProperty(result, key, {
          value: child, enumerable: true, configurable: true, writable: true,
        });
      }
      if (array && (result.length !== descriptors.length.value
        || Object.keys(result).length !== descriptors.length.value)) {
        throw invalid('sparse arrays are not JSON data');
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(node);
    }
  }
  return copy(value);
}

/**
 * Proposal identities must resolve to one record during replay and ancestry
 * walks. Operation keys on proposals and decisions must remain primitive
 * contract strings; legacy records may omit them entirely.
 * @param {RequirementsStream} stream
 */
function assertStreamIntegrity(stream) {
  for (const record of [...stream.proposals, ...stream.decisions]) {
    if (typeof record.proposal_ref !== 'string') throw new Error('stream proposal_ref is invalid');
  }
  assertUniqueRefs(stream.proposals, 'proposal_ref', 'stream proposal_ref');
  const pattern = new RegExp(loadContractFile('working-item.schema.json').$defs.op_key.pattern, 'u');
  for (const record of [...stream.proposals, ...stream.decisions]) {
    if (!('op_key' in record)) continue;
    const key = record.op_key;
    // Require the whole key: a regex $ anchor also matches before a final LF.
    if (typeof key !== 'string' || pattern.exec(key)?.[0] !== key) {
      throw new Error('stream op_key is invalid');
    }
  }
}

/**
 * @param {string} streamRef
 * @param {readonly ProjectKind[]} projectKinds
 */
export function createStream(streamRef, projectKinds) {
  if (typeof streamRef !== 'string' || !streamRef.trim()) throw new Error('stream_ref is required');
  validateProjectKinds(projectKinds);
  return Object.freeze({
    stream_ref: streamRef,
    project_kinds: Object.freeze([...projectKinds]),
    baselines: Object.freeze([]),
    proposals: Object.freeze([]),
    decisions: Object.freeze([]),
  });
}

/**
 * @param {RequirementsStream} stream
 */
export function currentBaseline(stream) {
  return stream.baselines.at(-1) ?? null;
}

/**
 * @param {RequirementsStream} stream
 */
function pendingProposals(stream) {
  return stream.proposals.filter(
    (proposal) => !stream.decisions.some((decision) => decision.proposal_ref === proposal.proposal_ref),
  );
}

/**
 * @param {RequirementsStream} stream
 * @param {readonly Proposal[]} proposals
 * @param {readonly Decision[]} decisions
 */
function withStreamState(stream, proposals, decisions) {
  return Object.freeze({
    ...stream,
    proposals: Object.freeze([...proposals]),
    decisions: Object.freeze([...decisions]),
  });
}

/**
 * @param {RequirementsStream} stream
 * @param {Baseline} baseline
 */
function withBaseline(stream, baseline) {
  return Object.freeze({
    ...stream,
    baselines: Object.freeze([...stream.baselines, baseline]),
  });
}

/**
 * Defensive copy: clone nested proposal content and freeze the snapshot only.
 * Caller-owned objects are never mutated or frozen.
 * @param {Requirement} requirement
 */
function cloneRequirement(requirement) {
  return Object.freeze({
    requirement_ref: requirement.requirement_ref,
    statement: requirement.statement,
    acceptance_criteria: Object.freeze([...requirement.acceptance_criteria]),
    constraint_refs: Object.freeze([...requirement.constraint_refs]),
  });
}

/**
 * @param {Constraint} constraint
 */
function cloneConstraint(constraint) {
  return Object.freeze({
    constraint_ref: constraint.constraint_ref,
    kind: constraint.kind,
    statement: constraint.statement,
  });
}

/**
 * @param {SourceClaim} [sourceClaim]
 */
function cloneSourceClaim(sourceClaim) {
  if (!sourceClaim) return undefined;
  return Object.freeze({ ...sourceClaim });
}

/** @param {unknown} value */
function cloneJson(value) {
  const copy = JSON.parse(canonicalJson(value));
  function freeze(node) {
    if (node && typeof node === 'object') {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
    return node;
  }
  return freeze(copy);
}

/**
 * @param {RequirementsStream} stream
 * @param {string} requirementRef
 */
function approvedRequirementExists(stream, requirementRef) {
  return currentBaseline(stream)?.requirements.some((item) => item.requirement_ref === requirementRef) === true;
}

/**
 * @param {RequirementsStream} stream
 * @param {string} constraintRef
 */
function approvedConstraintExists(stream, constraintRef) {
  return currentBaseline(stream)?.constraints.some((item) => item.constraint_ref === constraintRef) === true;
}

/**
 * @param {Proposal} proposal
 * @returns {string[]}
 */
function proposalRequirementAddRefs(proposal) {
  if (proposal.kind === 'add_requirement' && proposal.requirement) {
    return [proposal.requirement.requirement_ref];
  }
  if (proposal.kind === 'import_bundle') {
    return (proposal.import_requirements ?? []).map((item) => item.requirement_ref);
  }
  return [];
}

/**
 * @param {Proposal} proposal
 * @returns {string[]}
 */
function proposalConstraintAddRefs(proposal) {
  if (proposal.kind === 'add_constraint' && proposal.constraint) {
    return [proposal.constraint.constraint_ref];
  }
  if (proposal.kind === 'import_bundle') {
    return (proposal.import_constraints ?? []).map((item) => item.constraint_ref);
  }
  return [];
}

/**
 * @param {Proposal} proposal
 * @returns {string[]}
 */
function proposalRequirementUpdateRefs(proposal) {
  if (proposal.kind === 'update_requirement' && proposal.requirement) {
    return [proposal.requirement.requirement_ref];
  }
  return [];
}

/**
 * @param {Proposal} proposal
 * @returns {string[]}
 */
function proposalConstraintUpdateRefs(proposal) {
  if (proposal.kind === 'update_constraint' && proposal.constraint) {
    return [proposal.constraint.constraint_ref];
  }
  return [];
}

/**
 * @param {RequirementsStream} stream
 * @param {string} requirementRef
 */
function pendingRequirementAddExists(stream, requirementRef) {
  return pendingProposals(stream).some((proposal) => proposalRequirementAddRefs(proposal).includes(requirementRef));
}

/**
 * @param {RequirementsStream} stream
 * @param {string} constraintRef
 */
function pendingConstraintAddExists(stream, constraintRef) {
  return pendingProposals(stream).some((proposal) => proposalConstraintAddRefs(proposal).includes(constraintRef));
}

/**
 * @param {RequirementsStream} stream
 * @param {string} requirementRef
 */
function pendingRequirementUpdateExists(stream, requirementRef) {
  return pendingProposals(stream).some((proposal) =>
    proposalRequirementUpdateRefs(proposal).includes(requirementRef),
  );
}

/**
 * @param {RequirementsStream} stream
 * @param {string} constraintRef
 */
function pendingConstraintUpdateExists(stream, constraintRef) {
  return pendingProposals(stream).some((proposal) =>
    proposalConstraintUpdateRefs(proposal).includes(constraintRef),
  );
}

/**
 * @param {Requirement} left
 * @param {Requirement} right
 */
function sameRequirementContent(left, right) {
  return contentDigest([left], []) === contentDigest([right], []);
}

/**
 * @param {Constraint} left
 * @param {Constraint} right
 */
function sameConstraintContent(left, right) {
  return contentDigest([], [left]) === contentDigest([], [right]);
}

/**
 * @param {RequirementsStream} stream
 * @param {Proposal} proposal
 */
function boundBaselineForUpdate(stream, proposal) {
  const againstRef = proposal.against_baseline_ref;
  const againstRevision = proposal.against_revision;
  const againstDigest = proposal.against_content_digest;
  if (
    typeof againstRef !== 'string'
    || !againstRef.trim()
    || !Number.isInteger(againstRevision)
    || typeof againstDigest !== 'string'
    || !againstDigest.trim()
  ) {
    throw new Error(`update proposal ${proposal.proposal_ref} is not bound to a baseline snapshot`);
  }
  const bound = stream.baselines.find((item) => item.baseline_ref === againstRef);
  if (!bound) {
    throw new Error(`update proposal ${proposal.proposal_ref} is bound to unknown baseline_ref ${againstRef}`);
  }
  assertRehydratedBaseline(bound);
  if (bound.revision !== againstRevision || bound.content_digest !== againstDigest) {
    throw new Error(`update proposal ${proposal.proposal_ref} is stale or does not match its bound baseline`);
  }
  return bound;
}

/**
 * Reject last-write-wins: an update may apply only while its target is still
 * the bound snapshot's content, including after unrelated revisions/imports.
 * @param {RequirementsStream} stream
 * @param {Proposal} proposal
 * @param {readonly Requirement[]} requirements
 * @param {readonly Constraint[]} constraints
 */
function assertUpdateNotStale(stream, proposal, requirements, constraints) {
  const bound = boundBaselineForUpdate(stream, proposal);
  if (proposal.kind === 'update_requirement') {
    const ref = proposal.requirement.requirement_ref;
    const boundItem = bound.requirements.find((item) => item.requirement_ref === ref);
    const currentItem = requirements.find((item) => item.requirement_ref === ref);
    if (!boundItem || !currentItem) {
      throw new Error(`cannot update requirement ${ref}: not in approved baseline`);
    }
    if (!sameRequirementContent(boundItem, currentItem)) {
      throw new Error(
        `update proposal ${proposal.proposal_ref} is stale; requirement ${ref} changed since it was authored`,
      );
    }
    return;
  }
  const ref = proposal.constraint.constraint_ref;
  const boundItem = bound.constraints.find((item) => item.constraint_ref === ref);
  const currentItem = constraints.find((item) => item.constraint_ref === ref);
  if (!boundItem || !currentItem) {
    throw new Error(`cannot update constraint ${ref}: not in approved baseline`);
  }
  if (!sameConstraintContent(boundItem, currentItem)) {
    throw new Error(
      `update proposal ${proposal.proposal_ref} is stale; constraint ${ref} changed since it was authored`,
    );
  }
}

/**
 * @param {readonly Proposal[]} selected
 */
function assertNoConflictingUpdates(selected) {
  const requirementRefs = new Set();
  const constraintRefs = new Set();
  for (const proposal of selected) {
    if (proposal.kind === 'update_requirement') {
      const ref = proposal.requirement.requirement_ref;
      if (requirementRefs.has(ref)) {
        throw new Error(`conflicting pending updates for requirement_ref ${ref}`);
      }
      requirementRefs.add(ref);
    }
    if (proposal.kind === 'update_constraint') {
      const ref = proposal.constraint.constraint_ref;
      if (constraintRefs.has(ref)) {
        throw new Error(`conflicting pending updates for constraint_ref ${ref}`);
      }
      constraintRefs.add(ref);
    }
  }
}

/**
 * @param {Baseline} baseline
 */
function againstBaselineIdentity(baseline) {
  return {
    against_baseline_ref: baseline.baseline_ref,
    against_revision: baseline.revision,
    against_content_digest: baseline.content_digest,
  };
}

/**
 * @param {RequirementsStream} stream
 * @param {string} requirementRef
 */
function assertCanAddRequirement(stream, requirementRef) {
  if (approvedRequirementExists(stream, requirementRef)) {
    throw new Error(`requirement_ref already exists in approved baseline; use update proposal`);
  }
  if (pendingRequirementAddExists(stream, requirementRef)) {
    throw new Error(`pending add already exists for requirement_ref ${requirementRef}`);
  }
}

/**
 * @param {RequirementsStream} stream
 * @param {string} constraintRef
 */
function assertCanAddConstraint(stream, constraintRef) {
  if (approvedConstraintExists(stream, constraintRef)) {
    throw new Error(`constraint_ref already exists in approved baseline; use update proposal`);
  }
  if (pendingConstraintAddExists(stream, constraintRef)) {
    throw new Error(`pending add already exists for constraint_ref ${constraintRef}`);
  }
}

/**
 * Append a host proposal with the same validation as replacement and approval.
 * Projection callers retain the complete confirmation envelope; legacy
 * constructors below use this boundary too. Supersession is an atomic replace.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {Proposal} proposal
 */
export function appendProposal(stream, authority, proposal) {
  stream = plainDataSnapshot(stream);
  proposal = plainDataSnapshot(proposal);
  assertCanContribute(authority);
  assertStreamIntegrity(stream);
  let replay;
  if (proposal?.op_key !== undefined) {
    const pattern = loadContractFile('working-item.schema.json').$defs.op_key.pattern;
    if (typeof proposal.op_key !== 'string' || !new RegExp(pattern).test(proposal.op_key)) throw new Error('proposal op_key is invalid');
    replay = stream.proposals.find((item) => item.op_key === proposal.op_key);
    if ((replay && canonicalJson(replay) !== canonicalJson(proposal))
      || (!replay && stream.decisions.some((item) => item.op_key === proposal.op_key))) throw hostConflict('idempotency_conflict');
  }
  validateProposal(proposal);
  assertProjectedEnvelope(stream, proposal);
  if (Object.keys(proposal).some((key) => !proposalKeys.has(key))) throw new Error('unknown proposal key');
  if (typeof proposal.proposal_ref !== 'string' || !proposal.proposal_ref.trim()) throw new Error('proposal_ref is required');
  if (proposal.contributed_by !== authority.party_ref) throw new Error('proposal contributor must match verified authority');
  if (typeof proposal.contributed_at !== 'string' || !proposal.contributed_at.trim()
    || typeof proposal.summary !== 'string') throw new Error('proposal metadata is required');
  if (replay) return stream;
  if (stream.proposals.some((item) => item.proposal_ref === proposal.proposal_ref)) throw new Error('proposal_ref must be unique');
  if (proposal.supersedes_proposal_ref !== undefined || proposal.op_key?.includes(':replace:')) {
    throw new Error('superseding proposals require atomic replaceProposal');
  }
  for (const ref of proposalRequirementAddRefs(proposal)) assertCanAddRequirement(stream, ref);
  for (const ref of proposalConstraintAddRefs(proposal)) assertCanAddConstraint(stream, ref);
  if (proposal.kind === 'update_requirement' || proposal.kind === 'update_constraint') {
    const baseline = currentBaseline(stream);
    if (!baseline) throw new Error('update proposal requires an approved baseline');
    assertUpdateNotStale(stream, proposal, baseline.requirements, baseline.constraints);
    for (const ref of proposalRequirementUpdateRefs(proposal)) {
      if (pendingRequirementUpdateExists(stream, ref)) throw new Error('conflicting pending requirement update');
    }
    for (const ref of proposalConstraintUpdateRefs(proposal)) {
      if (pendingConstraintUpdateExists(stream, ref)) throw new Error('conflicting pending constraint update');
    }
  }
  return withStreamState(stream, [...stream.proposals, cloneJson(proposal)], stream.decisions);
}

/**
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {Requirement} requirement
 * @param {string} [contributedAt]
 */
export function proposeRequirement(stream, authority, requirement, contributedAt = new Date().toISOString(), sourceClaim) {
  assertCanContribute(authority);
  validateRequirement(requirement);
  assertCanAddRequirement(stream, requirement.requirement_ref);
  const proposal = Object.freeze({
    proposal_ref: `proposal:${randomUUID()}`,
    kind: 'add_requirement',
    contributed_by: authority.party_ref,
    contributed_at: contributedAt,
    summary: `Add requirement ${requirement.requirement_ref}`,
    requirement: cloneRequirement(requirement),
    ...(sourceClaim ? { source_claim: cloneSourceClaim(sourceClaim) } : {}),
  });
  return appendProposal(stream, authority, proposal);
}

/**
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {Requirement} requirement
 * @param {string} [contributedAt]
 */
export function proposeRequirementUpdate(stream, authority, requirement, contributedAt = new Date().toISOString(), sourceClaim) {
  assertCanContribute(authority);
  validateRequirement(requirement);
  if (!approvedRequirementExists(stream, requirement.requirement_ref)) {
    throw new Error(`requirement_ref ${requirement.requirement_ref} is not in the approved baseline`);
  }
  if (pendingRequirementUpdateExists(stream, requirement.requirement_ref)) {
    throw new Error(`pending update already exists for requirement_ref ${requirement.requirement_ref}`);
  }
  const baseline = currentBaseline(stream);
  const proposal = Object.freeze({
    proposal_ref: `proposal:${randomUUID()}`,
    kind: 'update_requirement',
    contributed_by: authority.party_ref,
    contributed_at: contributedAt,
    summary: `Update requirement ${requirement.requirement_ref}`,
    requirement: cloneRequirement(requirement),
    ...againstBaselineIdentity(baseline),
    ...(sourceClaim ? { source_claim: cloneSourceClaim(sourceClaim) } : {}),
  });
  return appendProposal(stream, authority, proposal);
}

/**
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {Constraint} constraint
 * @param {string} [contributedAt]
 */
export function proposeConstraint(stream, authority, constraint, contributedAt = new Date().toISOString(), sourceClaim) {
  assertCanContribute(authority);
  validateConstraint(constraint);
  assertCanAddConstraint(stream, constraint.constraint_ref);
  const proposal = Object.freeze({
    proposal_ref: `proposal:${randomUUID()}`,
    kind: 'add_constraint',
    contributed_by: authority.party_ref,
    contributed_at: contributedAt,
    summary: `Add constraint ${constraint.constraint_ref}`,
    constraint: cloneConstraint(constraint),
    ...(sourceClaim ? { source_claim: cloneSourceClaim(sourceClaim) } : {}),
  });
  return appendProposal(stream, authority, proposal);
}

/**
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {Constraint} constraint
 * @param {string} [contributedAt]
 * @param {SourceClaim} [sourceClaim]
 */
export function proposeConstraintUpdate(stream, authority, constraint, contributedAt = new Date().toISOString(), sourceClaim) {
  assertCanContribute(authority);
  validateConstraint(constraint);
  if (!approvedConstraintExists(stream, constraint.constraint_ref)) {
    throw new Error(`constraint_ref ${constraint.constraint_ref} is not in the approved baseline`);
  }
  if (pendingConstraintUpdateExists(stream, constraint.constraint_ref)) {
    throw new Error(`pending update already exists for constraint_ref ${constraint.constraint_ref}`);
  }
  const baseline = currentBaseline(stream);
  const proposal = Object.freeze({
    proposal_ref: `proposal:${randomUUID()}`,
    kind: 'update_constraint',
    contributed_by: authority.party_ref,
    contributed_at: contributedAt,
    summary: `Update constraint ${constraint.constraint_ref}`,
    constraint: cloneConstraint(constraint),
    ...againstBaselineIdentity(baseline),
    ...(sourceClaim ? { source_claim: cloneSourceClaim(sourceClaim) } : {}),
  });
  return appendProposal(stream, authority, proposal);
}

/**
 * Incoming import stays a proposal until explicitly approved; never overwrites baseline.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {readonly Requirement[]} requirements
 * @param {readonly Constraint[]} constraints
 * @param {string} [contributedAt]
 * @param {SourceClaim} [sourceClaim]
 */
export function proposeImport(
  stream,
  authority,
  requirements,
  constraints,
  contributedAt = new Date().toISOString(),
  sourceClaim,
) {
  assertCanProposeImport(authority);
  if (!Array.isArray(requirements) || !Array.isArray(constraints)) {
    throw new Error('import requires requirements and constraints arrays');
  }
  if (!requirements.length && !constraints.length) {
    throw new Error('import requires at least one requirement or constraint');
  }
  for (const requirement of requirements) validateRequirement(requirement);
  for (const constraint of constraints) validateConstraint(constraint);
  assertUniqueRefs(requirements, 'requirement_ref', 'import requirements');
  assertUniqueRefs(constraints, 'constraint_ref', 'import constraints');
  for (const requirement of requirements) assertCanAddRequirement(stream, requirement.requirement_ref);
  for (const constraint of constraints) assertCanAddConstraint(stream, constraint.constraint_ref);
  const proposal = Object.freeze({
    proposal_ref: `proposal:${randomUUID()}`,
    kind: 'import_bundle',
    contributed_by: authority.party_ref,
    contributed_at: contributedAt,
    summary: `Import ${requirements.length} requirement(s) and ${constraints.length} constraint(s)`,
    import_requirements: Object.freeze(requirements.map(cloneRequirement)),
    import_constraints: Object.freeze(constraints.map(cloneConstraint)),
    ...(sourceClaim ? { source_claim: cloneSourceClaim(sourceClaim) } : {}),
  });
  return appendProposal(stream, authority, proposal);
}

/**
 * @param {readonly Proposal[]} proposals
 * @param {readonly string[]} proposalRefs
 */
function selectedProposals(proposals, proposalRefs) {
  const selected = proposals.filter((proposal) => proposalRefs.includes(proposal.proposal_ref));
  if (selected.length !== proposalRefs.length) {
    throw new Error('one or more proposal_refs were not found');
  }
  return selected;
}

/** @param {string} code */
function hostConflict(code) {
  const entry = loadContractFile('error-codes.json').codes.find((item) => item.code === code);
  return Object.assign(new Error(code), { code, status: entry.http });
}

/**
 * Working-spec projections retain the exact confirmed content and evidence.
 * Recognize projections independently of their removable envelope fields:
 * operation keys, supersession/withdrawal ancestry and recorded working-spec
 * host bindings all require a complete envelope. Ancestry traversal is bounded
 * by the stream's proposal identities, including malformed cycles. Legacy
 * proposals without any projection evidence retain their original behavior.
 * @param {RequirementsStream} stream
 * @param {Proposal} proposal
 */
function assertProjectedEnvelope(stream, proposal) {
  stream = plainDataSnapshot(stream);
  proposal = plainDataSnapshot(proposal);
  assertStreamIntegrity(stream);
  const fields = ['content', 'content_sha256', 'citations', 'provenance'];
  const ancestors = [proposal];
  const visited = new Set();
  let projected = false;
  while (ancestors.length) {
    const candidate = ancestors.pop();
    if (visited.has(candidate.proposal_ref)) continue;
    visited.add(candidate.proposal_ref);
    if (fields.some((key) => Object.hasOwn(candidate, key))
      || (typeof candidate.op_key === 'string' && /:(submit|replace):/.test(candidate.op_key))
      || stream.working_spec?.items.some((item) => item.host?.proposal_ref === candidate.proposal_ref)) {
      projected = true;
      break;
    }
    const predecessorRefs = new Set();
    if (candidate.supersedes_proposal_ref !== undefined) predecessorRefs.add(candidate.supersedes_proposal_ref);
    for (const decision of stream.decisions) {
      if (decision.outcome === 'withdrawn' && candidate.op_key !== undefined && decision.op_key === candidate.op_key) {
        predecessorRefs.add(decision.proposal_ref);
      }
    }
    for (const ref of predecessorRefs) {
      const predecessor = stream.proposals.find((item) => item.proposal_ref === ref);
      if (predecessor) ancestors.push(predecessor);
    }
  }
  if (!projected) return;
  if (!fields.every((key) => Object.hasOwn(proposal, key))) {
    throw new Error('working-spec projection requires content, content_sha256, citations and provenance');
  }
  if (proposal.kind !== 'add_requirement' && proposal.kind !== 'add_constraint') {
    throw new Error('working-spec projections are new requirement or constraint proposals');
  }
  const requirement = proposal.kind === 'add_requirement';
  const itemRef = requirement ? proposal.requirement.requirement_ref : proposal.constraint.constraint_ref;
  createWorkingSpec('review', [{
    item_ref: itemRef, version: 1, kind: requirement ? 'requirement' : 'constraint',
    content: proposal.content, content_sha256: proposal.content_sha256,
    citations: proposal.citations, provenance: proposal.provenance,
    state: 'proposed', supersedes_item_version: null,
    host: { proposal_ref: proposal.proposal_ref, op_key: proposal.op_key },
  }]);
  const content = proposal.content;
  const expected = requirement
    ? { requirement_ref: itemRef, statement: content.statement, acceptance_criteria: content.acceptance_criteria, constraint_refs: content.constraint_refs }
    : { constraint_ref: itemRef, kind: content.constraint_kind, statement: content.statement };
  if (canonicalJson(expected) !== canonicalJson(requirement ? proposal.requirement : proposal.constraint)) {
    throw new Error('proposal payload differs from the confirmed working content');
  }
}

/**
 * Replace one pending immutable proposal, returning one atomic stream state.
 * The host must invoke this inside its project-revision transaction. The
 * required new_proposal.op_key identifies the canonical request bytes; retries
 * return the existing proposal and decision without rewriting either. Returning
 * the current stream on replay preserves any later approvals/replacements.
 * Authorization/fencing are the host's responsibility before this domain call.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {string} oldProposalRef
 * @param {Proposal} newProposal
 */
export function replaceProposal(stream, authority, oldProposalRef, newProposal) {
  stream = plainDataSnapshot(stream);
  newProposal = plainDataSnapshot(newProposal);
  assertCanContribute(authority);
  assertStreamIntegrity(stream);
  if (typeof oldProposalRef !== 'string') throw new TypeError('old proposal_ref must be a primitive string');
  const keyPattern = loadContractFile('working-item.schema.json').$defs.op_key.pattern;
  if (!newProposal || typeof newProposal.op_key !== 'string'
    || !new RegExp(keyPattern).test(newProposal.op_key) || !newProposal.op_key.includes(':replace:')) {
    throw new Error('replacement requires a replace op_key');
  }
  const replacementInput = {
    ...newProposal,
    supersedes_proposal_ref: newProposal.supersedes_proposal_ref === undefined
      ? oldProposalRef : newProposal.supersedes_proposal_ref,
  };
  const payload = canonicalJson({ old_proposal_ref: oldProposalRef, new_proposal: replacementInput });
  const replay = stream.decisions.find((decision) => decision.op_key === newProposal.op_key);
  if (replay) {
    if (replay.replacement_payload !== payload) throw hostConflict('idempotency_conflict');
    return stream;
  }
  if (stream.proposals.some((proposal) => proposal.op_key === newProposal.op_key)) {
    throw hostConflict('idempotency_conflict');
  }
  const old = stream.proposals.find((proposal) => proposal.proposal_ref === oldProposalRef);
  if (!old) throw new Error('old proposal_ref was not found');
  const decision = stream.decisions.find((item) => item.proposal_ref === oldProposalRef);
  if (decision?.outcome === 'approved') throw hostConflict('already_accepted');
  if (decision?.outcome === 'withdrawn') throw hostConflict('draft_superseded');
  if (decision) throw new Error('only pending proposals can be replaced');

  if (Object.keys(newProposal).some((key) => !proposalKeys.has(key))) throw new Error('unknown replacement proposal key');
  if (typeof newProposal.proposal_ref !== 'string' || !newProposal.proposal_ref.trim()) {
    throw new Error('new proposal_ref is required');
  }
  if (stream.proposals.some((item) => item.proposal_ref === newProposal.proposal_ref)) {
    throw new Error('new proposal_ref must be unique');
  }
  if (newProposal.contributed_by !== authority.party_ref) throw new Error('replacement contributor must match verified authority');
  if (typeof newProposal.contributed_at !== 'string' || !newProposal.contributed_at.trim()
    || typeof newProposal.summary !== 'string') throw new Error('replacement metadata is required');
  if (newProposal.supersedes_proposal_ref !== undefined && newProposal.supersedes_proposal_ref !== oldProposalRef) {
    throw new Error('supersedes_proposal_ref must identify the replaced proposal');
  }
  validateProposal(old);
  validateProposal(newProposal);
  assertProjectedEnvelope(stream, old);
  assertProjectedEnvelope(stream, replacementInput);
  if (newProposal.kind !== old.kind) throw new Error('replacement must preserve proposal kind');
  if ((old.requirement && old.requirement.requirement_ref !== newProposal.requirement.requirement_ref)
    || (old.constraint && old.constraint.constraint_ref !== newProposal.constraint.constraint_ref)) {
    throw new Error('replacement must preserve the requirement or constraint identity');
  }
  if (newProposal.kind === 'import_bundle') {
    const refs = (proposal) => ({
      requirements: proposal.import_requirements.map((item) => item.requirement_ref).sort(),
      constraints: proposal.import_constraints.map((item) => item.constraint_ref).sort(),
    });
    if (canonicalJson(refs(old)) !== canonicalJson(refs(newProposal))) {
      throw new Error('replacement must preserve imported requirement and constraint identities');
    }
  }
  const withdrawn = Object.freeze({
    decision_ref: `decision:${randomUUID()}`,
    proposal_ref: oldProposalRef,
    decided_by: authority.party_ref,
    decided_at: newProposal.contributed_at,
    outcome: 'withdrawn',
    note: `Replaced by ${newProposal.proposal_ref}`,
    op_key: newProposal.op_key,
    replacement_payload: payload,
  });
  // This intermediate value is never returned or persisted. Removing old from
  // pending makes the existing collision checks apply to all other proposals.
  const pending = withStreamState(stream, stream.proposals, [...stream.decisions, withdrawn]);
  for (const ref of proposalRequirementAddRefs(newProposal)) assertCanAddRequirement(pending, ref);
  for (const ref of proposalConstraintAddRefs(newProposal)) assertCanAddConstraint(pending, ref);
  if (newProposal.kind === 'update_requirement' || newProposal.kind === 'update_constraint') {
    const baseline = currentBaseline(stream);
    if (!baseline) throw new Error('update replacement requires an approved baseline');
    assertUpdateNotStale(stream, newProposal, baseline.requirements, baseline.constraints);
    for (const ref of proposalRequirementUpdateRefs(newProposal)) {
      if (pendingRequirementUpdateExists(pending, ref)) throw new Error('conflicting pending requirement update');
    }
    for (const ref of proposalConstraintUpdateRefs(newProposal)) {
      if (pendingConstraintUpdateExists(pending, ref)) throw new Error('conflicting pending constraint update');
    }
  }
  const replacement = cloneJson(replacementInput);
  return withStreamState(stream, [...stream.proposals, replacement], [...stream.decisions, withdrawn]);
}

/**
 * @param {readonly Requirement[]} requirements
 * @param {Requirement} requirement
 */
function addRequirement(requirements, requirement) {
  if (requirements.some((item) => item.requirement_ref === requirement.requirement_ref)) {
    throw new Error(`cannot add requirement ${requirement.requirement_ref}: already exists; use update`);
  }
  return [...requirements, requirement];
}

/**
 * @param {readonly Requirement[]} requirements
 * @param {Requirement} requirement
 */
function updateRequirement(requirements, requirement) {
  const index = requirements.findIndex((item) => item.requirement_ref === requirement.requirement_ref);
  if (index === -1) {
    throw new Error(`cannot update requirement ${requirement.requirement_ref}: not in approved baseline`);
  }
  const next = [...requirements];
  next[index] = requirement;
  return next;
}

/**
 * @param {readonly Constraint[]} constraints
 * @param {Constraint} constraint
 */
function addConstraint(constraints, constraint) {
  if (constraints.some((item) => item.constraint_ref === constraint.constraint_ref)) {
    throw new Error(`cannot add constraint ${constraint.constraint_ref}: already exists; use update`);
  }
  return [...constraints, constraint];
}

/**
 * @param {readonly Constraint[]} constraints
 * @param {Constraint} constraint
 */
function updateConstraint(constraints, constraint) {
  const index = constraints.findIndex((item) => item.constraint_ref === constraint.constraint_ref);
  if (index === -1) {
    throw new Error(`cannot update constraint ${constraint.constraint_ref}: not in approved baseline`);
  }
  const next = [...constraints];
  next[index] = constraint;
  return next;
}

/**
 * Re-validate and apply at the approval boundary so propose-time checks are not TOCTOU.
 * Update kinds also re-check snapshot binding so a later revision cannot silently revert.
 * @param {RequirementsStream} stream
 * @param {readonly Requirement[]} requirements
 * @param {readonly Constraint[]} constraints
 * @param {Proposal} proposal
 */
function applyProposal(stream, requirements, constraints, proposal) {
  validateProposal(proposal, `proposal ${proposal.proposal_ref}`);
  if (proposal.kind === 'add_requirement') {
    return { requirements: addRequirement(requirements, cloneRequirement(proposal.requirement)), constraints };
  }
  if (proposal.kind === 'update_requirement') {
    assertUpdateNotStale(stream, proposal, requirements, constraints);
    return { requirements: updateRequirement(requirements, cloneRequirement(proposal.requirement)), constraints };
  }
  if (proposal.kind === 'add_constraint') {
    return { requirements, constraints: addConstraint(constraints, cloneConstraint(proposal.constraint)) };
  }
  if (proposal.kind === 'update_constraint') {
    assertUpdateNotStale(stream, proposal, requirements, constraints);
    return { requirements, constraints: updateConstraint(constraints, cloneConstraint(proposal.constraint)) };
  }
  let nextRequirements = requirements;
  let nextConstraints = constraints;
  for (const requirement of proposal.import_requirements) {
    nextRequirements = addRequirement(nextRequirements, cloneRequirement(requirement));
  }
  for (const constraint of proposal.import_constraints) {
    nextConstraints = addConstraint(nextConstraints, cloneConstraint(constraint));
  }
  return { requirements: nextRequirements, constraints: nextConstraints };
}

/**
 * Approval is the rehydration trust boundary: inherited baseline content is
 * revalidated (shape, digest, seal) before any new snapshot or decision is
 * returned. Update proposals are bound to the snapshot they were authored
 * against; conflicting or stale updates fail closed instead of last-write-wins.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {readonly string[]} proposalRefs
 * @param {string} baselineRef
 * @param {string} [approvedAt]
 * @param {string} [expectedReviewDigest]
 */
export function approveBaselineFromProposals(
  stream,
  authority,
  proposalRefs,
  baselineRef,
  approvedAt = new Date().toISOString(),
  expectedReviewDigest,
) {
  stream = plainDataSnapshot(stream);
  proposalRefs = plainDataSnapshot(proposalRefs);
  assertCanApproveBaseline(authority);
  assertStreamIntegrity(stream);
  if (!baselineRef) throw new Error('baseline_ref is required');
  if (!Array.isArray(proposalRefs) || !proposalRefs.length) {
    throw new Error('at least one pending proposal_ref is required');
  }
  if (proposalRefs.some((ref) => typeof ref !== 'string')) throw new TypeError('proposal_refs must be primitive strings');
  if (stream.decisions.some((decision) => decision.outcome === 'withdrawn' && proposalRefs.includes(decision.proposal_ref))) {
    throw hostConflict('draft_superseded');
  }
  if (stream.baselines.some((item) => item.baseline_ref === baselineRef)) {
    throw new Error('baseline_ref already exists; each approved baseline must have a unique identity');
  }
  const selected = selectedProposals(pendingProposals(stream), proposalRefs);
  const reviewIdentity = expectedReviewDigest === undefined
    ? undefined
    : acceptRevisionReview(stream, proposalRefs, expectedReviewDigest);
  for (const proposal of selected) {
    validateProposal(proposal, `proposal ${proposal.proposal_ref}`);
    assertProjectedEnvelope(stream, proposal);
  }
  assertNoConflictingUpdates(selected);

  const baseline = currentBaseline(stream);
  if (baseline) assertRehydratedBaseline(baseline);

  let requirements = baseline ? baseline.requirements.map(cloneRequirement) : [];
  let constraints = baseline ? baseline.constraints.map(cloneConstraint) : [];

  for (const proposal of selected) {
    const applied = applyProposal(stream, requirements, constraints, proposal);
    requirements = applied.requirements;
    constraints = applied.constraints;
  }

  if (!requirements.length) throw new Error('approved baseline must contain at least one requirement');

  const revision = (baseline?.revision ?? 0) + 1;
  const digest = contentDigest(requirements, constraints);
  const approved = freezeBaseline({
    baseline_ref: baselineRef,
    revision,
    content_digest: digest,
    revision_seal: revisionSeal({
      baseline_ref: baselineRef,
      revision,
      content_digest: digest,
    }),
    approved_by: authority.party_ref,
    approved_at: approvedAt,
    requirements,
    constraints,
  });

  const decisions = [
    ...stream.decisions,
    ...selected.map((proposal) => Object.freeze({
      decision_ref: `decision:${randomUUID()}`,
      proposal_ref: proposal.proposal_ref,
      decided_by: authority.party_ref,
      decided_at: approvedAt,
      outcome: 'approved',
      note: `Included in baseline ${baselineRef} revision ${revision}`,
      ...(reviewIdentity ? { review_identity: reviewIdentity } : {}),
    })),
  ];

  return withBaseline(withStreamState(stream, stream.proposals, decisions), approved);
}

/**
 * Explicit human rejection: records a rejected decision without changing
 * approved baseline history. Same authorization gate as approval.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {readonly string[]} proposalRefs
 * @param {string} [note]
 * @param {string} [decidedAt]
 */
export function rejectProposals(
  stream,
  authority,
  proposalRefs,
  note = '',
  decidedAt = new Date().toISOString(),
) {
  assertCanApproveBaseline(authority);
  if (!Array.isArray(proposalRefs) || !proposalRefs.length) {
    throw new Error('at least one pending proposal_ref is required');
  }
  const selected = selectedProposals(pendingProposals(stream), proposalRefs);
  const noteText = typeof note === 'string' ? note : '';
  const decisions = [
    ...stream.decisions,
    ...selected.map((proposal) => Object.freeze({
      decision_ref: `decision:${randomUUID()}`,
      proposal_ref: proposal.proposal_ref,
      decided_by: authority.party_ref,
      decided_at: decidedAt,
      outcome: 'rejected',
      note: noteText,
    })),
  ];
  return withStreamState(stream, stream.proposals, decisions);
}

/**
 * Approved baselines are immutable snapshots bound by content_digest and revision_seal.
 * @param {Baseline} baseline
 */
export function assertApprovedBaselineImmutable(baseline) {
  assertRevisionSeal(baseline);
  if (!Object.isFrozen(baseline)) {
    throw new Error('approved baseline must be frozen');
  }
  if (!Object.isFrozen(baseline.requirements) || !Object.isFrozen(baseline.constraints)) {
    throw new Error('approved baseline collections must be frozen');
  }
  for (const requirement of baseline.requirements) {
    if (
      !Object.isFrozen(requirement)
      || !Object.isFrozen(requirement.acceptance_criteria)
      || !Object.isFrozen(requirement.constraint_refs)
    ) {
      throw new Error('approved requirement must be frozen');
    }
  }
  for (const constraint of baseline.constraints) {
    if (!Object.isFrozen(constraint)) {
      throw new Error('approved constraint must be frozen');
    }
  }
}
