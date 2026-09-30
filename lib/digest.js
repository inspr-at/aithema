import { boundary } from './boundary.js';
import { createHash } from 'node:crypto';

/** @import { Baseline, Constraint, Requirement } from './types.js' */

/**
 * UTF-16 code-unit order. Independent of ICU locale / localeCompare collation.
 * @param {string} left
 * @param {string} right
 */
function compareByCodeUnitsImpl(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Canonical baseline payload used for digesting and equality checks.
 * Sorting is code-unit order so the same content hashes identically across runtimes.
 * @param {readonly Requirement[]} requirements
 * @param {readonly Constraint[]} constraints
 */
function baselinePayloadImpl(requirements, constraints) {
  const sortedRequirements = [...requirements].sort((left, right) =>
    compareByCodeUnitsImpl(left.requirement_ref, right.requirement_ref),
  );
  const sortedConstraints = [...constraints].sort((left, right) =>
    compareByCodeUnitsImpl(left.constraint_ref, right.constraint_ref),
  );
  return {
    requirements: sortedRequirements.map((requirement) => ({
      requirement_ref: requirement.requirement_ref,
      statement: requirement.statement,
      acceptance_criteria: [...requirement.acceptance_criteria].sort(compareByCodeUnitsImpl),
      constraint_refs: [...requirement.constraint_refs].sort(compareByCodeUnitsImpl),
    })),
    constraints: sortedConstraints.map((constraint) => ({
      constraint_ref: constraint.constraint_ref,
      kind: constraint.kind,
      statement: constraint.statement,
    })),
  };
}

/**
 * @param {string} canonical
 * @returns {`sha256:${string}`}
 */
function sha256Digest(canonical) {
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Content identity over requirements and constraints only.
 * Does not bind revision, baseline_ref, or actor claims.
 * @param {readonly Requirement[]} requirements
 * @param {readonly Constraint[]} constraints
 * @returns {`sha256:${string}`}
 */
function contentDigestImpl(requirements, constraints) {
  return sha256Digest(JSON.stringify(baselinePayloadImpl(requirements, constraints)));
}

/**
 * Revision identity: which snapshot this is. Binds baseline_ref, revision, and
 * content_digest. Does not bind approved_by / approved_at — those remain claims
 * from caller-supplied authority, not something a digest authenticates.
 * @param {{ baseline_ref: string, revision: number, content_digest: string }} identity
 * @returns {`sha256:${string}`}
 */
function revisionSealImpl(identity) {
  return sha256Digest(JSON.stringify({
    baseline_ref: identity.baseline_ref,
    revision: identity.revision,
    content_digest: identity.content_digest,
  }));
}

/**
 * @param {Baseline} baseline
 */
function assertBaselineDigestImpl(baseline) {
  const expected = contentDigestImpl(baseline.requirements, baseline.constraints);
  if (baseline.content_digest !== expected) {
    throw new Error('baseline content_digest does not match canonical payload');
  }
}

/**
 * @param {Baseline} baseline
 */
function assertRevisionSealImpl(baseline) {
  assertBaselineDigestImpl(baseline);
  const expected = revisionSealImpl({
    baseline_ref: baseline.baseline_ref,
    revision: baseline.revision,
    content_digest: baseline.content_digest,
  });
  if (baseline.revision_seal !== expected) {
    throw new Error('baseline revision_seal does not match revision identity');
  }
}

/**
 * @param {Baseline} baseline
 */
function freezeBaselineImpl(baseline) {
  assertRevisionSealImpl(baseline);
  return Object.freeze({
    ...baseline,
    requirements: Object.freeze(baseline.requirements.map((requirement) => Object.freeze({
      ...requirement,
      acceptance_criteria: Object.freeze([...requirement.acceptance_criteria]),
      constraint_refs: Object.freeze([...requirement.constraint_refs]),
    }))),
    constraints: Object.freeze(baseline.constraints.map((constraint) => Object.freeze({ ...constraint }))),
  });
}

export const compareByCodeUnits = boundary(compareByCodeUnitsImpl);
export const baselinePayload = boundary(baselinePayloadImpl);
export const contentDigest = boundary(contentDigestImpl);
export const revisionSeal = boundary(revisionSealImpl);
export const assertBaselineDigest = boundary(assertBaselineDigestImpl);
export const assertRevisionSeal = boundary(assertRevisionSealImpl);
export const freezeBaseline = boundary(freezeBaselineImpl);
