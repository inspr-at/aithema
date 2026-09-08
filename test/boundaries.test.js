import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStream,
  currentBaseline,
  proposeRequirement,
  proposeRequirementUpdate,
  proposeConstraint,
  proposeImport,
  approveBaselineFromProposals,
  importHandoverProposal,
  assertApprovedBaselineImmutable,
} from '../lib/index.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };
const importer = { party_ref: 'party:importer', roles: ['operator'] };

function mutableRequirement(overrides = {}) {
  return {
    requirement_ref: 'req.boundary',
    statement: 'Original statement',
    acceptance_criteria: ['Criterion A', 'Criterion B'],
    constraint_refs: ['constraint:alpha', 'constraint:beta'],
    ...overrides,
  };
}

describe('proposal boundary isolation', () => {
  it('does not reflect caller mutation of requirement statement after proposeRequirement', () => {
    const requirement = mutableRequirement();
    let stream = createStream('stream:boundary', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement);
    requirement.statement = 'Mutated after submit';

    const stored = stream.proposals[0].requirement;
    assert.equal(stored.statement, 'Original statement');
    assert.notStrictEqual(stored, requirement);
  });

  it('does not reflect caller mutation of nested acceptance_criteria or constraint_refs', () => {
    const requirement = mutableRequirement();
    let stream = createStream('stream:boundary', ['iteration']);
    stream = proposeRequirement(stream, contributor, requirement);
    requirement.acceptance_criteria.push('Criterion C');
    requirement.constraint_refs[0] = 'constraint:gamma';

    const stored = stream.proposals[0].requirement;
    assert.deepEqual([...stored.acceptance_criteria], ['Criterion A', 'Criterion B']);
    assert.deepEqual([...stored.constraint_refs], ['constraint:alpha', 'constraint:beta']);
    assert.notStrictEqual(stored.acceptance_criteria, requirement.acceptance_criteria);
    assert.notStrictEqual(stored.constraint_refs, requirement.constraint_refs);
  });

  it('does not freeze caller-owned requirement objects', () => {
    const requirement = mutableRequirement();
    let stream = createStream('stream:boundary', ['integration']);
    stream = proposeRequirement(stream, contributor, requirement);

    assert.equal(Object.isFrozen(requirement), false);
    assert.equal(Object.isFrozen(requirement.acceptance_criteria), false);
    requirement.statement = 'Still mutable';
    assert.equal(requirement.statement, 'Still mutable');
  });

  it('isolates proposeRequirementUpdate, proposeConstraint, and import bundle payloads', () => {
    const requirement = mutableRequirement();
    const constraint = {
      constraint_ref: 'constraint:alpha',
      kind: 'technical',
      statement: 'Original constraint',
    };
    const importedRequirement = mutableRequirement({ requirement_ref: 'req.imported' });
    const importedConstraint = {
      constraint_ref: 'constraint:imported',
      kind: 'technical',
      statement: 'Original imported constraint',
    };
    let stream = createStream('stream:boundary', ['new_product']);

    stream = proposeRequirement(stream, contributor, requirement);
    stream = proposeConstraint(stream, contributor, constraint);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      stream.proposals.map((item) => item.proposal_ref),
      'baseline:boundary',
    );
    stream = proposeRequirementUpdate(stream, contributor, requirement);
    stream = proposeImport(stream, contributor, [importedRequirement], [importedConstraint]);

    requirement.statement = 'Updated after submit';
    requirement.acceptance_criteria[1] = 'Changed criterion';
    constraint.statement = 'Changed constraint';
    importedRequirement.statement = 'Changed imported requirement';
    importedConstraint.statement = 'Changed imported constraint';

    const updateProposal = stream.proposals.find((item) => item.kind === 'update_requirement');
    const constraintProposal = stream.proposals.find((item) => item.kind === 'add_constraint');
    const importProposal = stream.proposals.find((item) => item.kind === 'import_bundle');

    assert.equal(updateProposal.requirement.statement, 'Original statement');
    assert.equal(updateProposal.requirement.acceptance_criteria[1], 'Criterion B');
    assert.equal(constraintProposal.constraint.statement, 'Original constraint');
    assert.equal(importProposal.import_requirements[0].statement, 'Original statement');
    assert.equal(importProposal.import_constraints[0].statement, 'Original imported constraint');
  });

  it('isolates imported handover bundle content from caller mutation', () => {
    const requirement = mutableRequirement({ requirement_ref: 'req.import' });
    const handover = {
      handover_version: 'aithema.handover/0.1',
      stream_ref: 'stream:handover-boundary',
      exported_at: '2026-09-07T12:00:00.000Z',
      baseline: null,
      pending_proposals: [],
      decisions: [],
    };

    let stream = createStream('stream:handover-boundary', ['integration']);
    stream = importHandoverProposal(stream, importer, {
      ...handover,
      baseline: {
        baseline_ref: 'baseline:foreign',
        revision: 1,
        content_digest: 'sha256:' + 'b'.repeat(64),
        approved_by: 'party:foreign',
        approved_at: '2026-09-07T11:00:00.000Z',
        requirements: [requirement],
        constraints: [],
      },
    });

    requirement.statement = 'Mutated after import proposal';
    requirement.acceptance_criteria.push('Criterion C');

    const importProposal = stream.proposals.find((item) => item.kind === 'import_bundle');
    assert.equal(importProposal.import_requirements[0].statement, 'Original statement');
    assert.deepEqual([...importProposal.import_requirements[0].acceptance_criteria], [
      'Criterion A',
      'Criterion B',
    ]);
  });
});

describe('approval boundary guards', () => {
  it('rejects empty pending proposal selection without creating a revision', () => {
    let stream = createStream('stream:approval', ['new_product']);
    stream = proposeRequirement(stream, contributor, mutableRequirement());
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:1',
    );

    assert.throws(
      () => approveBaselineFromProposals(stream, approver, [], 'baseline:2'),
      /at least one pending proposal_ref is required/,
    );
    assert.equal(stream.baselines.length, 1);
    assert.equal(currentBaseline(stream).revision, 1);
  });

  it('rejects reused baseline_ref across approved snapshots', () => {
    let stream = createStream('stream:approval', ['iteration']);
    stream = proposeRequirement(stream, contributor, mutableRequirement());
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:shared',
    );

    stream = proposeRequirementUpdate(stream, contributor, {
      ...mutableRequirement(),
      acceptance_criteria: ['Criterion A', 'Criterion B', 'Criterion C'],
    });

    assert.throws(
      () => approveBaselineFromProposals(
        stream,
        approver,
        [stream.proposals.at(-1).proposal_ref],
        'baseline:shared',
      ),
      /baseline_ref already exists/,
    );
    assert.equal(stream.baselines.length, 1);
  });

  it('keeps prior approved snapshots immutable after later approval and caller mutation', () => {
    let stream = createStream('stream:approval', ['integration']);
    const firstRequirement = mutableRequirement();
    stream = proposeRequirement(stream, contributor, firstRequirement);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:1',
    );
    const firstBaseline = currentBaseline(stream);
    const firstDigest = firstBaseline.content_digest;

    const updateRequirement = mutableRequirement({
      acceptance_criteria: ['Criterion A', 'Criterion B', 'Criterion C'],
    });
    stream = proposeRequirementUpdate(stream, contributor, updateRequirement);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals.at(-1).proposal_ref],
      'baseline:2',
    );

    updateRequirement.statement = 'Mutated after second approval';
    updateRequirement.acceptance_criteria[0] = 'Changed after approval';

    assertApprovedBaselineImmutable(firstBaseline);
    assert.equal(firstBaseline.content_digest, firstDigest);
    assert.equal(firstBaseline.requirements[0].statement, 'Original statement');
    assert.equal(firstBaseline.requirements[0].acceptance_criteria.length, 2);

    const secondBaseline = currentBaseline(stream);
    assertApprovedBaselineImmutable(secondBaseline);
    assert.equal(secondBaseline.revision, 2);
    assert.equal(secondBaseline.requirements[0].acceptance_criteria.length, 3);
  });
});
