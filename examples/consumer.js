/**
 * Minimal consumer example: adapter supplies verified authority; aithema-core
 * owns requirements revision, proposals, and handover export only.
 */
import {
  createStream,
  proposeRequirement,
  proposeConstraint,
  approveBaselineFromProposals,
  exportHandoverJson,
  exportHandoverCsv,
  importHandoverProposal,
  currentBaseline,
} from '../lib/index.js';

/** Adapter boundary: upstream verified the human before calling domain APIs. */
function verifiedAuthority(partyRef, roles) {
  return { party_ref: partyRef, roles };
}

const streamRef = 'stream:example-product';
let stream = createStream(streamRef, ['new_product', 'iteration']);

const productOwner = verifiedAuthority('party:owner', ['requirements_approver', 'delivery_party']);
const engineer = verifiedAuthority('party:engineer', ['delivery_party']);

stream = proposeRequirement(stream, engineer, {
  requirement_ref: 'req.onboarding',
  statement: 'New users complete onboarding in under five minutes',
  acceptance_criteria: [
    'Welcome flow has at most three steps',
    'Progress is saved between sessions',
  ],
  constraint_refs: ['constraint:cost.free-tier'],
});

stream = proposeConstraint(stream, engineer, {
  constraint_ref: 'constraint:cost.free-tier',
  kind: 'cost',
  statement: 'Free tier must not require payment details',
});

const proposalRefs = stream.proposals.map((proposal) => proposal.proposal_ref);
stream = approveBaselineFromProposals(stream, productOwner, proposalRefs, 'baseline:example-v1');

const handover = exportHandoverJson(stream);
const csv = exportHandoverCsv(stream);
const baseline = currentBaseline(stream);

console.log('Approved baseline:', {
  baseline_ref: baseline.baseline_ref,
  revision: baseline.revision,
  content_digest: baseline.content_digest,
  requirement_count: baseline.requirements.length,
});

console.log('Handover JSON pending proposals:', handover.pending_proposals.length);
console.log('CSV bytes:', Buffer.byteLength(csv, 'utf8'));

// Incoming ideas stay proposals until a human approver confirms baseline.
const peerStream = createStream(streamRef, ['new_product', 'iteration']);
const imported = importHandoverProposal(peerStream, engineer, handover);
console.log('Import created proposals without delivery start:', imported.proposals.length);
console.log('Imported stream baselines (still none until approval):', imported.baselines.length);
