import { boundary } from './boundary.js';
/** @import { Baseline, Constraint, Proposal, Requirement, VerifiedAuthority } from './types.js' */
import { assertRevisionSeal } from './digest.js';

export const PARTY_ROLES = Object.freeze([
  'requirements_approver',
  'batch_authorizer',
  'delivery_party',
  'operator',
  'acceptance_party',
]);

export const PROJECT_KINDS = Object.freeze(['new_product', 'iteration', 'integration']);

export const CONSTRAINT_KINDS = Object.freeze([
  'technical',
  'data',
  'authority',
  'cost',
  'agreement',
]);

const PARTY_ROLE_SET = new Set(PARTY_ROLES);
const PROJECT_KIND_SET = new Set(PROJECT_KINDS);
const CONSTRAINT_KIND_SET = new Set(CONSTRAINT_KINDS);

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function assertNonEmptyStringImpl(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is object}
 */
function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function assertNonEmptyStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings`);
  }
  const strings = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${name} must contain non-empty strings`);
    }
    strings.push(item);
  }
  return strings;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function assertStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings`);
  }
  const strings = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${name} must contain non-empty strings`);
    }
    if (seen.has(item)) {
      throw new Error(`${name} must not contain duplicates`);
    }
    seen.add(item);
    strings.push(item);
  }
  return strings;
}

/**
 * @param {unknown} authority
 * @returns {VerifiedAuthority}
 */
function validateAuthorityImpl(authority) {
  assertPlainObject(authority, 'verified authority');
  assertNonEmptyStringImpl(authority.party_ref, 'party_ref');
  if (!Array.isArray(authority.roles) || authority.roles.length === 0) {
    throw new Error('verified authority with party_ref and roles is required to contribute');
  }
  for (const role of authority.roles) {
    if (!PARTY_ROLE_SET.has(role)) {
      throw new Error(`unknown party role: ${role}`);
    }
  }
  return authority;
}

/**
 * @param {unknown} projectKinds
 * @returns {readonly string[]}
 */
function validateProjectKindsImpl(projectKinds) {
  if (!Array.isArray(projectKinds) || projectKinds.length === 0) {
    throw new Error('at least one project_kind is required');
  }
  for (const kind of projectKinds) {
    if (!PROJECT_KIND_SET.has(kind)) {
      throw new Error(`unknown project_kind: ${kind}`);
    }
  }
  return projectKinds;
}

/**
 * @param {unknown} requirement
 * @returns {Requirement}
 */
function validateRequirementImpl(requirement) {
  assertPlainObject(requirement, 'requirement');
  assertNonEmptyStringImpl(requirement.requirement_ref, 'requirement_ref');
  assertNonEmptyStringImpl(requirement.statement, 'requirement statement');
  assertNonEmptyStringArray(
    requirement.acceptance_criteria,
    'acceptance_criteria',
  );
  assertStringArray(requirement.constraint_refs, 'constraint_refs');
  return requirement;
}

/**
 * @param {unknown} constraint
 * @returns {Constraint}
 */
function validateConstraintImpl(constraint) {
  assertPlainObject(constraint, 'constraint');
  assertNonEmptyStringImpl(constraint.constraint_ref, 'constraint_ref');
  assertNonEmptyStringImpl(constraint.statement, 'constraint statement');
  if (!CONSTRAINT_KIND_SET.has(constraint.kind)) {
    throw new Error('constraint kind is invalid');
  }
  return constraint;
}

/**
 * Discriminated proposal payload: wrong or missing fields fail closed.
 * @param {unknown} proposal
 * @param {string} [label]
 * @returns {Proposal}
 */
function validateProposalImpl(proposal, label = 'proposal') {
  assertPlainObject(proposal, label);
  const kind = proposal.kind;
  if (kind === 'add_requirement' || kind === 'update_requirement') {
    if (proposal.constraint !== undefined) {
      throw new Error(`${label} ${kind} must not include constraint`);
    }
    if (proposal.import_requirements !== undefined || proposal.import_constraints !== undefined) {
      throw new Error(`${label} ${kind} must not include import bundle fields`);
    }
    if (!proposal.requirement) {
      throw new Error(`${label} ${kind} requires requirement`);
    }
    validateRequirementImpl(proposal.requirement);
  } else if (kind === 'add_constraint' || kind === 'update_constraint') {
    if (proposal.requirement !== undefined) {
      throw new Error(`${label} ${kind} must not include requirement`);
    }
    if (proposal.import_requirements !== undefined || proposal.import_constraints !== undefined) {
      throw new Error(`${label} ${kind} must not include import bundle fields`);
    }
    if (!proposal.constraint) {
      throw new Error(`${label} ${kind} requires constraint`);
    }
    validateConstraintImpl(proposal.constraint);
  } else if (kind === 'import_bundle') {
    if (proposal.requirement !== undefined || proposal.constraint !== undefined) {
      throw new Error(`${label} import_bundle must not include requirement or constraint fields`);
    }
    if (!Array.isArray(proposal.import_requirements) || !Array.isArray(proposal.import_constraints)) {
      throw new Error(`${label} import_bundle requires import_requirements and import_constraints arrays`);
    }
    for (const requirement of proposal.import_requirements) validateRequirementImpl(requirement);
    for (const constraint of proposal.import_constraints) validateConstraintImpl(constraint);
    assertUniqueRefsImpl(proposal.import_requirements, 'requirement_ref', `${label} import_requirements`);
    assertUniqueRefsImpl(proposal.import_constraints, 'constraint_ref', `${label} import_constraints`);
  } else {
    throw new Error(`${label} has unknown kind`);
  }
  return proposal;
}

/**
 * @param {readonly { [key: string]: string }[]} items
 * @param {string} key
 * @param {string} label
 */
function assertUniqueRefsImpl(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const ref = item[key];
    if (seen.has(ref)) {
      throw new Error(`duplicate ${label} ${ref}`);
    }
    seen.add(ref);
  }
}

/**
 * Shape-only check for a claimed foreign baseline. Does not treat it as local approval.
 * @param {unknown} baseline
 */
function validateBaselineClaimImpl(baseline) {
  assertPlainObject(baseline, 'handover baseline');
  assertNonEmptyStringImpl(baseline.baseline_ref, 'baseline_ref');
  if (baseline.revision !== undefined && (!Number.isInteger(baseline.revision) || baseline.revision < 1)) {
    throw new Error('handover baseline revision must be a positive integer');
  }
  if (
    baseline.content_digest !== undefined
    && baseline.content_digest !== null
    && !/^sha256:[a-f0-9]{64}$/.test(baseline.content_digest)
  ) {
    throw new Error('handover baseline content_digest is malformed');
  }
  if (
    baseline.revision_seal !== undefined
    && baseline.revision_seal !== null
    && !/^sha256:[a-f0-9]{64}$/.test(baseline.revision_seal)
  ) {
    throw new Error('handover baseline revision_seal is malformed');
  }
  if (!Array.isArray(baseline.requirements)) {
    throw new Error('handover baseline requirements must be an array');
  }
  if (!Array.isArray(baseline.constraints)) {
    throw new Error('handover baseline constraints must be an array');
  }
  for (const requirement of baseline.requirements) validateRequirementImpl(requirement);
  for (const constraint of baseline.constraints) validateConstraintImpl(constraint);
  assertUniqueRefsImpl(baseline.requirements, 'requirement_ref', 'handover baseline requirements');
  assertUniqueRefsImpl(baseline.constraints, 'constraint_ref', 'handover baseline constraints');
  return baseline;
}

/**
 * Rehydration trust boundary: a stored or caller-supplied baseline is untrusted
 * until shape, requirement/constraint payloads, unique refs, content_digest,
 * and revision_seal all validate. Call this before inheriting content into a
 * new snapshot so malformed persisted bytes cannot be recertified by hashing.
 * @param {unknown} baseline
 * @returns {Baseline}
 */
function assertRehydratedBaselineImpl(baseline) {
  assertPlainObject(baseline, 'approved baseline');
  assertNonEmptyStringImpl(baseline.baseline_ref, 'baseline_ref');
  if (!Number.isInteger(baseline.revision) || baseline.revision < 1) {
    throw new Error('approved baseline revision must be a positive integer');
  }
  assertNonEmptyStringImpl(baseline.content_digest, 'content_digest');
  assertNonEmptyStringImpl(baseline.revision_seal, 'revision_seal');
  assertNonEmptyStringImpl(baseline.approved_by, 'approved_by');
  assertNonEmptyStringImpl(baseline.approved_at, 'approved_at');
  if (!Array.isArray(baseline.requirements) || baseline.requirements.length === 0) {
    throw new Error('approved baseline must contain at least one requirement');
  }
  if (!Array.isArray(baseline.constraints)) {
    throw new Error('approved baseline constraints must be an array');
  }
  for (const requirement of baseline.requirements) validateRequirementImpl(requirement);
  for (const constraint of baseline.constraints) validateConstraintImpl(constraint);
  assertUniqueRefsImpl(baseline.requirements, 'requirement_ref', 'approved baseline requirements');
  assertUniqueRefsImpl(baseline.constraints, 'constraint_ref', 'approved baseline constraints');
  assertRevisionSeal(baseline);
  return baseline;
}

export const assertNonEmptyString = boundary(assertNonEmptyStringImpl);
export const validateAuthority = boundary(validateAuthorityImpl);
export const validateProjectKinds = boundary(validateProjectKindsImpl);
export const validateRequirement = boundary(validateRequirementImpl);
export const validateConstraint = boundary(validateConstraintImpl);
export const validateProposal = boundary(validateProposalImpl);
export const assertUniqueRefs = boundary(assertUniqueRefsImpl);
export const validateBaselineClaim = boundary(validateBaselineClaimImpl);
export const assertRehydratedBaseline = boundary(assertRehydratedBaselineImpl);
