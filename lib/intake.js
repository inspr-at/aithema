/** @import { RequirementsHandover, RequirementsStream, SourceClaim, VerifiedAuthority } from './types.js' */
import { contentDigest } from './digest.js';
import { parseHandoverJson } from './export.js';
import {
  currentBaseline,
  proposeConstraint,
  proposeConstraintUpdate,
  proposeRequirement,
  proposeRequirementUpdate,
} from './stream.js';
import { validateBaselineClaim } from './validate.js';

/**
 * Own-format reviewed JSON: validate canonical content_digest and stable IDs,
 * retain requirement/constraint relationships, and emit unapproved add/update
 * proposals against current state. approved_by / revision_seal stay claims.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {RequirementsHandover | string | unknown} handoverInput
 * @param {string} [contributedAt]
 */
export function importReviewedOwnFormat(stream, authority, handoverInput, contributedAt = new Date().toISOString()) {
  const handover = typeof handoverInput === 'string'
    ? parseHandoverJson(JSON.parse(handoverInput))
    : parseHandoverJson(handoverInput);
  const baseline = handover.baseline;
  if (!baseline) {
    throw Object.assign(new Error('own-format document has no reviewed baseline to import'), {
      code: 'intake_no_baseline',
    });
  }
  validateBaselineClaim(baseline);
  const expectedDigest = contentDigest(baseline.requirements, baseline.constraints);
  if (baseline.content_digest !== expectedDigest) {
    throw Object.assign(
      new Error('own-format baseline content_digest does not match canonical payload'),
      { code: 'intake_digest_mismatch' },
    );
  }

  const claim = sourceClaimFromHandover(handover);
  const current = currentBaseline(stream);
  const currentReqs = new Map((current?.requirements ?? []).map((item) => [item.requirement_ref, item]));
  const currentConstraints = new Map((current?.constraints ?? []).map((item) => [item.constraint_ref, item]));

  const actions = [];
  for (const requirement of baseline.requirements) {
    const existing = currentReqs.get(requirement.requirement_ref);
    if (!existing) {
      actions.push({ type: 'add_requirement', requirement });
    } else if (contentDigest([existing], []) !== contentDigest([requirement], [])) {
      actions.push({ type: 'update_requirement', requirement });
    }
  }
  for (const constraint of baseline.constraints) {
    const existing = currentConstraints.get(constraint.constraint_ref);
    if (!existing) {
      actions.push({ type: 'add_constraint', constraint });
    } else if (contentDigest([], [existing]) !== contentDigest([], [constraint])) {
      actions.push({ type: 'update_constraint', constraint });
    }
  }

  if (!actions.length) {
    throw Object.assign(new Error('own-format baseline matches current reviewed content; nothing consequential to propose'), {
      code: 'intake_no_changes',
    });
  }

  let next = stream;
  for (const action of actions) {
    if (action.type === 'add_requirement') {
      next = proposeRequirement(next, authority, action.requirement, contributedAt, claim);
    } else if (action.type === 'update_requirement') {
      next = proposeRequirementUpdate(next, authority, action.requirement, contributedAt, claim);
    } else if (action.type === 'add_constraint') {
      next = proposeConstraint(next, authority, action.constraint, contributedAt, claim);
    } else {
      next = proposeConstraintUpdate(next, authority, action.constraint, contributedAt, claim);
    }
  }
  return {
    stream: next,
    claim,
    added: actions.filter((item) => item.type.startsWith('add_')).length,
    updated: actions.filter((item) => item.type.startsWith('update_')).length,
  };
}

/**
 * @param {unknown} value
 */
export function isOwnFormatHandover(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.handover_version === 'aithema.handover/0.1';
}

/**
 * @param {RequirementsHandover} handover
 * @returns {SourceClaim}
 */
function sourceClaimFromHandover(handover) {
  const baseline = handover.baseline;
  return Object.freeze({
    stream_ref: handover.stream_ref,
    baseline_ref: baseline?.baseline_ref ?? null,
    revision: baseline?.revision ?? 0,
    content_digest: baseline?.content_digest ?? null,
    revision_seal: baseline?.revision_seal ?? null,
    claimed_approved_by: baseline?.approved_by ?? null,
    claimed_approved_at: baseline?.approved_at ?? null,
    source_proposal_ref: null,
    source_kind: 'approved_baseline',
  });
}
