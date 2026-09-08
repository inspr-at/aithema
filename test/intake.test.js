import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStream,
  currentBaseline,
  proposeRequirement,
  proposeConstraint,
  approveBaselineFromProposals,
  exportReviewedHandover,
  importReviewedOwnFormat,
  importHandoverProposal,
  contentDigest,
} from '../lib/index.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };
const importer = { party_ref: 'party:importer', roles: ['operator'] };

function requirement(ref, extra = {}) {
  return {
    requirement_ref: ref,
    statement: extra.statement ?? `Statement for ${ref}`,
    acceptance_criteria: extra.acceptance_criteria ?? ['A check'],
    constraint_refs: extra.constraint_refs ?? [],
  };
}

describe('own-format reviewed intake', () => {
  it('validates canonical digest, retains relationships, and proposes updates without importing authority', () => {
    let target = createStream('stream:target', ['new_product']);
    target = proposeRequirement(target, contributor, requirement('req.keep', {
      statement: 'OLD',
      constraint_refs: ['constraint:data.eu'],
    }));
    target = proposeConstraint(target, contributor, {
      constraint_ref: 'constraint:data.eu',
      kind: 'data',
      statement: 'EU only',
    });
    target = approveBaselineFromProposals(
      target,
      approver,
      target.proposals.map((proposal) => proposal.proposal_ref),
      'baseline:local-v1',
    );
    const before = currentBaseline(target);

    let source = createStream('stream:foreign', ['new_product']);
    source = proposeRequirement(source, contributor, requirement('req.keep', {
      statement: 'NEW',
      constraint_refs: ['constraint:data.eu', 'constraint:cost.cap'],
    }));
    source = proposeRequirement(source, contributor, requirement('req.added', {
      statement: 'A new requirement',
    }));
    source = proposeConstraint(source, contributor, {
      constraint_ref: 'constraint:data.eu',
      kind: 'data',
      statement: 'EU only',
    });
    source = proposeConstraint(source, contributor, {
      constraint_ref: 'constraint:cost.cap',
      kind: 'cost',
      statement: 'Stay under the cap',
    });
    source = approveBaselineFromProposals(
      source,
      approver,
      source.proposals.map((proposal) => proposal.proposal_ref),
      'baseline:foreign-v1',
      '2026-09-01T00:00:00.000Z',
    );
    const handover = exportReviewedHandover(source, {
      baseline_ref: 'baseline:foreign-v1',
      revision: 1,
    });

    const result = importReviewedOwnFormat(target, importer, handover);
    target = result.stream;
    assert.equal(currentBaseline(target).content_digest, before.content_digest);
    assert.equal(currentBaseline(target).approved_by, 'party:approver');
    assert.equal(result.added, 2);
    assert.equal(result.updated, 1);
    const update = target.proposals.find((proposal) => proposal.kind === 'update_requirement');
    assert.equal(update.requirement.statement, 'NEW');
    assert.deepEqual(update.requirement.constraint_refs, ['constraint:data.eu', 'constraint:cost.cap']);
    assert.equal(update.source_claim.claimed_approved_by, 'party:approver');
    assert.equal(update.source_claim.baseline_ref, 'baseline:foreign-v1');
    assert.notEqual(update.contributed_by, update.source_claim.claimed_approved_by);
    assert.equal(target.baselines.length, 1);
  });

  it('rejects a tampered content_digest and still never copies foreign approval via the legacy import path', () => {
    const target = createStream('stream:tamper', ['iteration']);
    const handover = {
      handover_version: 'aithema.handover/0.1',
      stream_ref: 'stream:tamper',
      exported_at: '2026-09-07T16:00:00.000Z',
      pending_proposals: [],
      decisions: [],
      baseline: {
        baseline_ref: 'baseline:forged',
        revision: 3,
        content_digest: `sha256:${'a'.repeat(64)}`,
        revision_seal: `sha256:${'b'.repeat(64)}`,
        approved_by: 'party:forged-approver',
        approved_at: '2026-09-01T00:00:00.000Z',
        requirements: [requirement('req.forged')],
        constraints: [],
      },
    };
    assert.notEqual(
      handover.baseline.content_digest,
      contentDigest(handover.baseline.requirements, handover.baseline.constraints),
    );
    assert.throws(() => importReviewedOwnFormat(target, importer, handover), /content_digest/);
    const legacy = importHandoverProposal(target, importer, handover);
    assert.equal(legacy.baselines.length, 0);
    assert.equal(legacy.proposals[0].kind, 'import_bundle');
    assert.equal(legacy.proposals[0].source_claim.claimed_approved_by, 'party:forged-approver');
  });
});
