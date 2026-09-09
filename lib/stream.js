import { randomUUID } from 'node:crypto';

/** @import { Baseline, Constraint, Decision, ProjectKind, Proposal, Requirement, RequirementsStream, SourceClaim, VerifiedAuthority } from './types.js' */
import { assertCanApproveBaseline, assertCanContribute, assertCanProposeImport } from './authority.js';
import { assertRevisionSeal, contentDigest, freezeBaseline, revisionSeal } from './digest.js';
import { acceptRevisionReview } from './revision-review.js';
import {
  assertRehydratedBaseline,
  assertUniqueRefs,
  validateConstraint,
  validateProjectKinds,
  validateProposal,
  validateRequirement,
} from './validate.js';

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
  return withStreamState(stream, [...stream.proposals, proposal], stream.decisions);
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
  return withStreamState(stream, [...stream.proposals, proposal], stream.decisions);
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
  return withStreamState(stream, [...stream.proposals, proposal], stream.decisions);
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
  return withStreamState(stream, [...stream.proposals, proposal], stream.decisions);
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
  return withStreamState(stream, [...stream.proposals, proposal], stream.decisions);
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
  assertCanApproveBaseline(authority);
  if (!baselineRef) throw new Error('baseline_ref is required');
  if (!Array.isArray(proposalRefs) || !proposalRefs.length) {
    throw new Error('at least one pending proposal_ref is required');
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
