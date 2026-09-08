import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCanApproveBaseline,
  assertCanContribute,
  createStream,
  currentBaseline,
  proposeRequirement,
  proposeRequirementUpdate,
  proposeConstraint,
  approveBaselineFromProposals,
  assertApprovedBaselineImmutable,
  contentDigest,
} from '../lib/index.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };

const sampleRequirement = {
  requirement_ref: 'req.auth',
  statement: 'Users authenticate with verified email',
  acceptance_criteria: ['Magic link expires after 15 minutes'],
  constraint_refs: ['constraint:authority.email'],
};

const sampleConstraint = {
  constraint_ref: 'constraint:authority.email',
  kind: 'authority',
  statement: 'Email verification is mandatory before handover',
};

describe('approved baseline immutability', () => {
  it('freezes approved baseline and binds content_digest', () => {
    let stream = createStream('stream:demo', ['new_product']);
    stream = proposeRequirement(stream, contributor, sampleRequirement);
    stream = proposeConstraint(stream, contributor, sampleConstraint);
    const proposalRefs = stream.proposals.map((proposal) => proposal.proposal_ref);
    stream = approveBaselineFromProposals(stream, approver, proposalRefs, 'baseline:1');

    const baseline = currentBaseline(stream);
    assert.ok(baseline);
    assert.equal(baseline.revision, 1);
    assert.match(baseline.content_digest, /^sha256:[a-f0-9]{64}$/);
    assertApprovedBaselineImmutable(baseline);

    const recomputed = contentDigest(baseline.requirements, baseline.constraints);
    assert.equal(recomputed, baseline.content_digest);
  });

  it('increments revision on subsequent approval without mutating prior baseline', () => {
    let stream = createStream('stream:demo', ['iteration']);
    stream = proposeRequirement(stream, contributor, sampleRequirement);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:1',
    );
    const first = currentBaseline(stream);

    stream = proposeRequirementUpdate(stream, contributor, {
      ...sampleRequirement,
      acceptance_criteria: [
        ...sampleRequirement.acceptance_criteria,
        'Failed attempts are rate limited',
      ],
    });
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals.at(-1).proposal_ref],
      'baseline:2',
    );
    const second = currentBaseline(stream);

    assert.equal(stream.baselines.length, 2);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.notEqual(first.content_digest, second.content_digest);
    assertApprovedBaselineImmutable(first);
    assertApprovedBaselineImmutable(second);
  });
});

describe('authority boundaries', () => {
  it('allows any verified party to contribute proposals', () => {
    assertCanContribute(contributor);
    const stream = proposeRequirement(createStream('stream:demo', ['integration']), contributor, sampleRequirement);
    assert.equal(stream.proposals.length, 1);
  });

  it('rejects contribution without verified roles', () => {
    assert.throws(() => assertCanContribute({ party_ref: 'party:x', roles: [] }));
  });

  it('requires requirements_approver to approve baseline', () => {
    let stream = createStream('stream:demo', ['new_product']);
    stream = proposeRequirement(stream, contributor, sampleRequirement);
    const proposalRef = stream.proposals[0].proposal_ref;

    assert.throws(
      () => approveBaselineFromProposals(stream, contributor, [proposalRef], 'baseline:1'),
      /requirements_approver/,
    );
    assertCanApproveBaseline(approver);
    stream = approveBaselineFromProposals(stream, approver, [proposalRef], 'baseline:1');
    assert.ok(currentBaseline(stream));
  });
});
