/** @import { RequirementsHandover, RequirementsStream, SourceClaim, VerifiedAuthority } from './types.js' */
import { proposeImport } from './stream.js';
import { parseHandoverJson } from './export.js';
import { validateProposal } from './validate.js';

/**
 * @param {RequirementsHandover} handover
 * @param {object | null} proposal
 * @param {string | null} sourceKind
 * @returns {SourceClaim}
 */
function sourceClaimFromHandover(handover, proposal, sourceKind) {
  const baseline = handover.baseline;
  return Object.freeze({
    stream_ref: handover.stream_ref,
    baseline_ref: baseline?.baseline_ref ?? null,
    revision: baseline?.revision ?? 0,
    content_digest: baseline?.content_digest ?? null,
    revision_seal: baseline?.revision_seal ?? null,
    claimed_approved_by: baseline?.approved_by ?? null,
    claimed_approved_at: baseline?.approved_at ?? null,
    source_proposal_ref: proposal?.proposal_ref ?? null,
    source_kind: sourceKind,
  });
}

/**
 * @param {RequirementsHandover} handover
 */
function collectImportBundles(handover) {
  const bundles = [];
  const baseline = handover.baseline;
  if (baseline && (baseline.requirements.length || baseline.constraints.length)) {
    bundles.push({
      requirements: baseline.requirements,
      constraints: baseline.constraints,
      source_claim: sourceClaimFromHandover(handover, null, 'approved_baseline'),
    });
  }

  for (const [index, proposal] of handover.pending_proposals.entries()) {
    validateProposal(proposal, `pending_proposals[${index}]`);
    const claim = sourceClaimFromHandover(handover, proposal, proposal.kind);
    if (proposal.kind === 'import_bundle') {
      bundles.push({
        requirements: proposal.import_requirements,
        constraints: proposal.import_constraints,
        source_claim: claim,
      });
    } else if (proposal.kind === 'add_requirement' || proposal.kind === 'update_requirement') {
      bundles.push({
        requirements: [proposal.requirement],
        constraints: [],
        source_claim: claim,
      });
    } else {
      bundles.push({
        requirements: [],
        constraints: [proposal.constraint],
        source_claim: claim,
      });
    }
  }

  return bundles;
}

/**
 * Import never overwrites an approved baseline; it always becomes a proposal.
 * Invalid handovers throw before any proposal is returned. Source approval is
 * retained only as a claim — never as local approval authority.
 * @param {RequirementsStream} stream
 * @param {VerifiedAuthority} authority
 * @param {RequirementsHandover | string} handoverInput
 */
export function importHandoverProposal(stream, authority, handoverInput) {
  const handover = typeof handoverInput === 'string'
    ? parseHandoverJson(JSON.parse(handoverInput))
    : parseHandoverJson(handoverInput);

  if (handover.stream_ref !== stream.stream_ref) {
    throw new Error('handover stream_ref does not match target stream');
  }

  const bundles = collectImportBundles(handover);
  if (!bundles.length) {
    throw new Error('handover contains nothing to import');
  }

  let next = stream;
  for (const bundle of bundles) {
    next = proposeImport(
      next,
      authority,
      bundle.requirements,
      bundle.constraints,
      handover.exported_at,
      bundle.source_claim,
    );
  }
  return next;
}
