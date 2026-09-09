import { createHash } from 'node:crypto';

/** @import { Baseline, Proposal, RequirementsStream } from './types.js' */
import { compareByCodeUnits } from './digest.js';
import { assertRehydratedBaseline, validateProposal } from './validate.js';

const REVIEW_SCHEMA = 'aithema.requirement-revision-review/0.1';

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function baselineIdentity(baseline) {
  if (!baseline) return null;
  assertRehydratedBaseline(baseline);
  return Object.freeze({
    baseline_ref: baseline.baseline_ref,
    revision: baseline.revision,
    content_digest: baseline.content_digest,
  });
}

function currentBaseline(stream) {
  return stream.baselines.at(-1) ?? null;
}

function pendingProposals(stream) {
  return stream.proposals.filter(
    (proposal) => !stream.decisions.some((decision) => decision.proposal_ref === proposal.proposal_ref),
  );
}

function staleReview(message) {
  return Object.assign(new Error(message), { code: 'stale_review' });
}

function boundBaseline(stream, proposal) {
  const baseline = stream.baselines.find(
    (item) => item.baseline_ref === proposal.against_baseline_ref,
  );
  if (!baseline) {
    throw staleReview(`proposal ${proposal.proposal_ref} is bound to an unknown baseline`);
  }
  assertRehydratedBaseline(baseline);
  if (
    baseline.revision !== proposal.against_revision
    || baseline.content_digest !== proposal.against_content_digest
  ) {
    throw staleReview(`proposal ${proposal.proposal_ref} no longer matches its bound baseline`);
  }
  return baseline;
}

function scalarDifference(before, after) {
  let status = 'unchanged';
  if (before === null && after !== null) status = 'added';
  else if (before !== null && after === null) status = 'removed';
  else if (before !== after) status = 'changed';
  return Object.freeze({ status, before, after });
}

function sorted(values) {
  return [...values].sort(compareByCodeUnits);
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function repeated(value, amount) {
  return Array.from({ length: amount }, () => value);
}

function listDifference(before, after) {
  const beforeValues = sorted(before);
  const afterValues = sorted(after);
  const beforeCounts = counts(beforeValues);
  const afterCounts = counts(afterValues);
  const values = sorted(new Set([...beforeCounts.keys(), ...afterCounts.keys()]));
  const added = [];
  const removed = [];
  const unchanged = [];
  for (const value of values) {
    const oldCount = beforeCounts.get(value) ?? 0;
    const newCount = afterCounts.get(value) ?? 0;
    unchanged.push(...repeated(value, Math.min(oldCount, newCount)));
    added.push(...repeated(value, Math.max(0, newCount - oldCount)));
    removed.push(...repeated(value, Math.max(0, oldCount - newCount)));
  }
  return Object.freeze({
    status: added.length || removed.length ? 'changed' : 'unchanged',
    before: Object.freeze(beforeValues),
    after: Object.freeze(afterValues),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
  });
}

function requirementDifference(before, after) {
  const statement = scalarDifference(before?.statement ?? null, after?.statement ?? null);
  const acceptanceCriteria = listDifference(
    before?.acceptance_criteria ?? [],
    after?.acceptance_criteria ?? [],
  );
  const constraintRefs = listDifference(before?.constraint_refs ?? [], after?.constraint_refs ?? []);
  const changedValueCount = (statement.status === 'unchanged' ? 0 : 1)
    + acceptanceCriteria.added.length
    + acceptanceCriteria.removed.length
    + constraintRefs.added.length
    + constraintRefs.removed.length;
  return Object.freeze({
    requirement_ref: after?.requirement_ref ?? before?.requirement_ref,
    statement,
    acceptance_criteria: acceptanceCriteria,
    constraint_refs: constraintRefs,
    changed_value_count: changedValueCount,
  });
}

function constraintDifference(before, after) {
  const kind = scalarDifference(before?.kind ?? null, after?.kind ?? null);
  const statement = scalarDifference(before?.statement ?? null, after?.statement ?? null);
  const changedValueCount = (kind.status === 'unchanged' ? 0 : 1)
    + (statement.status === 'unchanged' ? 0 : 1);
  return Object.freeze({
    constraint_ref: after?.constraint_ref ?? before?.constraint_ref,
    kind,
    statement,
    changed_value_count: changedValueCount,
  });
}

function proposalContentIdentity(proposal) {
  return digest({
    proposal_ref: proposal.proposal_ref,
    kind: proposal.kind,
    requirement: proposal.requirement ? canonicalRequirement(proposal.requirement) : null,
    constraint: proposal.constraint ? canonicalConstraint(proposal.constraint) : null,
    import_requirements: proposal.import_requirements
      ? [...proposal.import_requirements]
        .sort((left, right) => compareByCodeUnits(left.requirement_ref, right.requirement_ref))
        .map(canonicalRequirement)
      : null,
    import_constraints: proposal.import_constraints
      ? [...proposal.import_constraints]
        .sort((left, right) => compareByCodeUnits(left.constraint_ref, right.constraint_ref))
        .map(canonicalConstraint)
      : null,
    against_baseline_ref: proposal.against_baseline_ref ?? null,
    against_revision: proposal.against_revision ?? null,
    against_content_digest: proposal.against_content_digest ?? null,
  });
}

function canonicalRequirement(requirement) {
  return {
    requirement_ref: requirement.requirement_ref,
    statement: requirement.statement,
    acceptance_criteria: sorted(requirement.acceptance_criteria),
    constraint_refs: sorted(requirement.constraint_refs),
  };
}

function canonicalConstraint(constraint) {
  return {
    constraint_ref: constraint.constraint_ref,
    kind: constraint.kind,
    statement: constraint.statement,
  };
}

function directlyAffectedRequirements(baseline, requirementChanges, constraintChanges) {
  const refs = new Set(
    requirementChanges
      .filter((change) => change.changed_value_count > 0)
      .map((change) => change.requirement_ref),
  );
  const changedConstraints = new Set(
    constraintChanges
      .filter((change) => change.changed_value_count > 0)
      .map((change) => change.constraint_ref),
  );
  if (baseline && changedConstraints.size) {
    for (const requirement of baseline.requirements) {
      if (requirement.constraint_refs.some((ref) => changedConstraints.has(ref))) {
        refs.add(requirement.requirement_ref);
      }
    }
  }
  return Object.freeze(sorted(refs));
}

function proposalReview(stream, proposal) {
  validateProposal(proposal, `proposal ${proposal.proposal_ref}`);
  let compared = currentBaseline(stream);
  const requirementChanges = [];
  const constraintChanges = [];

  if (proposal.kind === 'update_requirement') {
    compared = boundBaseline(stream, proposal);
    const before = compared.requirements.find(
      (item) => item.requirement_ref === proposal.requirement.requirement_ref,
    );
    if (!before) throw staleReview(`proposal ${proposal.proposal_ref} target is absent from its bound baseline`);
    requirementChanges.push(requirementDifference(before, proposal.requirement));
  } else if (proposal.kind === 'add_requirement') {
    requirementChanges.push(requirementDifference(null, proposal.requirement));
  } else if (proposal.kind === 'update_constraint') {
    compared = boundBaseline(stream, proposal);
    const before = compared.constraints.find(
      (item) => item.constraint_ref === proposal.constraint.constraint_ref,
    );
    if (!before) throw staleReview(`proposal ${proposal.proposal_ref} target is absent from its bound baseline`);
    constraintChanges.push(constraintDifference(before, proposal.constraint));
  } else if (proposal.kind === 'add_constraint') {
    constraintChanges.push(constraintDifference(null, proposal.constraint));
  } else {
    for (const requirement of proposal.import_requirements) {
      requirementChanges.push(requirementDifference(null, requirement));
    }
    for (const constraint of proposal.import_constraints) {
      constraintChanges.push(constraintDifference(null, constraint));
    }
  }

  const affectedRequirementRefs = directlyAffectedRequirements(
    compared,
    requirementChanges,
    constraintChanges,
  );
  const changedValueCount = [...requirementChanges, ...constraintChanges]
    .reduce((total, change) => total + change.changed_value_count, 0);
  return Object.freeze({
    proposal_ref: proposal.proposal_ref,
    kind: proposal.kind,
    proposal_digest: proposalContentIdentity(proposal),
    compared_baseline: baselineIdentity(compared),
    requirement_changes: Object.freeze(requirementChanges),
    constraint_changes: Object.freeze(constraintChanges),
    deterministic_estimated_impact: Object.freeze({
      changed_value_count: changedValueCount,
      affected_requirement_refs: affectedRequirementRefs,
      downstream_impact: 'unknown',
    }),
  });
}

/**
 * Deterministic comparison of pending proposal content against the exact
 * baseline snapshot each proposal references. No model or inferred impact is used.
 * @param {RequirementsStream} stream
 */
export function buildRevisionReview(stream) {
  const current = currentBaseline(stream);
  const proposals = pendingProposals(stream)
    .map((proposal) => proposalReview(stream, proposal))
    .sort((left, right) => compareByCodeUnits(left.proposal_ref, right.proposal_ref));
  const payload = {
    review_schema: REVIEW_SCHEMA,
    stream_ref: stream.stream_ref,
    current_baseline: baselineIdentity(current),
    proposals,
  };
  return Object.freeze({ ...payload, review_digest: digest(payload) });
}

/**
 * Verify submitted human consent against the current review and bind the
 * selected proposal identities to the exact compared baseline identities.
 * @param {RequirementsStream} stream
 * @param {readonly string[]} proposalRefs
 * @param {string} expectedReviewDigest
 */
export function acceptRevisionReview(stream, proposalRefs, expectedReviewDigest) {
  if (typeof expectedReviewDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedReviewDigest)) {
    throw staleReview('a valid review_digest is required; refresh and review again');
  }
  const review = buildRevisionReview(stream);
  if (review.review_digest !== expectedReviewDigest) {
    throw staleReview('proposal or baseline changed; refresh and review again');
  }
  const uniqueRefs = new Set(proposalRefs);
  if (uniqueRefs.size !== proposalRefs.length) {
    throw staleReview('selected proposal references must be unique');
  }
  const selected = review.proposals.filter((proposal) => uniqueRefs.has(proposal.proposal_ref));
  if (selected.length !== proposalRefs.length) {
    throw staleReview('selected proposal is not present in the reviewed comparison');
  }
  const selectedProposals = selected.map((proposal) => Object.freeze({
    proposal_ref: proposal.proposal_ref,
    proposal_digest: proposal.proposal_digest,
  }));
  const comparedByIdentity = new Map();
  for (const proposal of selected) {
    const baseline = proposal.compared_baseline;
    if (!baseline) continue;
    comparedByIdentity.set(
      `${baseline.baseline_ref}\0${baseline.revision}\0${baseline.content_digest}`,
      baseline,
    );
  }
  const comparedBaselines = [...comparedByIdentity.values()].sort((left, right) => (
    compareByCodeUnits(left.baseline_ref, right.baseline_ref)
    || left.revision - right.revision
    || compareByCodeUnits(left.content_digest, right.content_digest)
  ));
  const acceptedReviewDigest = digest({
    review_digest: review.review_digest,
    selected_proposals: selectedProposals,
    compared_baselines: comparedBaselines,
  });
  return Object.freeze({
    review_digest: review.review_digest,
    accepted_review_digest: acceptedReviewDigest,
    selected_proposals: Object.freeze(selectedProposals),
    compared_baselines: Object.freeze(comparedBaselines),
  });
}
