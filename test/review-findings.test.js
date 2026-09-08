import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as core from '../lib/index.js';

const {
  assertBaselineDigest,
  assertCanApproveBaseline,
  baselinePayload,
  contentDigest,
  createStream,
  currentBaseline,
  encodeRequirementsCsv,
  exportHandoverCsv,
  exportHandoverJson,
  hasRole,
  importHandoverProposal,
  neutraliseSpreadsheetFormula,
  parseHandoverJson,
  proposeImport,
  proposeConstraint,
  proposeRequirement,
  proposeRequirementUpdate,
  approveBaselineFromProposals,
  rejectProposals,
  assertRehydratedBaseline,
  assertApprovedBaselineImmutable,
} = core;

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };
const importer = { party_ref: 'party:importer', roles: ['operator'] };

function requirement(ref = 'req.auth', overrides = {}) {
  return {
    requirement_ref: ref,
    statement: 'Users authenticate with verified email',
    acceptance_criteria: ['Magic link expires after 15 minutes'],
    constraint_refs: [],
    ...overrides,
  };
}

function emptyHandover(streamRef, overrides = {}) {
  return {
    handover_version: 'aithema.handover/0.1',
    stream_ref: streamRef,
    exported_at: '2026-09-07T12:00:00.000Z',
    baseline: null,
    pending_proposals: [],
    decisions: [],
    ...overrides,
  };
}

describe('B1 locale-independent canonical digest', () => {
  it('orders refs by code units so A precedes a and z precedes ö', () => {
    const mk = (ref) => requirement(ref, { statement: 's', acceptance_criteria: ['a'] });
    const mixed = baselinePayload([mk('req.a'), mk('req.A')], []);
    assert.equal(mixed.requirements[0].requirement_ref, 'req.A');
    assert.equal(mixed.requirements[1].requirement_ref, 'req.a');

    const umlaut = baselinePayload([mk('req.öffnen'), mk('req.zulu')], []);
    assert.equal(umlaut.requirements[0].requirement_ref, 'req.zulu');
    assert.equal(umlaut.requirements[1].requirement_ref, 'req.öffnen');

    const canonical = JSON.stringify({
      requirements: [
        { requirement_ref: 'req.A', statement: 's', acceptance_criteria: ['a'], constraint_refs: [] },
        { requirement_ref: 'req.a', statement: 's', acceptance_criteria: ['a'], constraint_refs: [] },
      ],
      constraints: [],
    });
    const expected = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
    assert.equal(contentDigest([mk('req.a'), mk('req.A')], []), expected);
    assert.equal(contentDigest([mk('req.A'), mk('req.a')], []), expected);
  });
});

describe('B2 revision identity is separate from content digest', () => {
  it('binds baseline_ref and revision in revision_seal without authenticating approved_by', () => {
    let stream = createStream('stream:seal', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement());
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:1',
    );
    const baseline = currentBaseline(stream);

    assert.equal(typeof core.revisionSeal, 'function');
    assert.equal(typeof core.assertRevisionSeal, 'function');
    assert.equal(
      baseline.revision_seal,
      core.revisionSeal({
        baseline_ref: baseline.baseline_ref,
        revision: baseline.revision,
        content_digest: baseline.content_digest,
      }),
    );

    const actorSwap = { ...baseline, approved_by: 'party:attacker' };
    assert.doesNotThrow(() => assertBaselineDigest(actorSwap));
    assert.doesNotThrow(() => core.assertRevisionSeal(actorSwap));

    const revisionSwap = { ...baseline, revision: 999 };
    assert.doesNotThrow(() => assertBaselineDigest(revisionSwap));
    assert.throws(() => core.assertRevisionSeal(revisionSwap), /revision_seal/);

    const refSwap = { ...baseline, baseline_ref: 'baseline:forged' };
    assert.doesNotThrow(() => assertBaselineDigest(refSwap));
    assert.throws(() => core.assertRevisionSeal(refSwap), /revision_seal/);
  });
});

describe('B3 approval revalidates untrusted proposal shapes', () => {
  it('rejects string acceptance_criteria instead of spreading characters into the baseline', () => {
    const forged = {
      stream_ref: 'stream:forge',
      project_kinds: ['new_product'],
      baselines: [],
      decisions: [],
      proposals: [{
        proposal_ref: 'proposal:forged',
        kind: 'add_requirement',
        contributed_by: 'party:contributor',
        contributed_at: '2026-09-07T00:00:00.000Z',
        summary: 'Add requirement req.i',
        requirement: {
          requirement_ref: 'req.i',
          statement: 'Original',
          acceptance_criteria: 'one criterion',
          constraint_refs: [],
        },
      }],
    };

    assert.throws(
      () => approveBaselineFromProposals(forged, approver, ['proposal:forged'], 'baseline:i'),
      /acceptance_criteria must be an array of strings/,
    );
    assert.equal(forged.baselines.length, 0);
  });

  it('rejects missing constraint_refs with an explicit error, not a TypeError', () => {
    const forged = {
      stream_ref: 'stream:forge',
      project_kinds: ['new_product'],
      baselines: [],
      decisions: [],
      proposals: [{
        proposal_ref: 'proposal:missing-refs',
        kind: 'add_requirement',
        contributed_by: 'party:contributor',
        contributed_at: '2026-09-07T00:00:00.000Z',
        summary: 'Add requirement req.i',
        requirement: {
          requirement_ref: 'req.i',
          statement: 'Original',
          acceptance_criteria: ['ok'],
        },
      }],
    };

    assert.throws(
      () => approveBaselineFromProposals(forged, approver, ['proposal:missing-refs'], 'baseline:i'),
      /constraint_refs must be an array of strings/,
    );
  });

  it('rejects empty statement at approval even if propose-time validation was skipped', () => {
    const forged = {
      stream_ref: 'stream:forge',
      project_kinds: ['new_product'],
      baselines: [],
      decisions: [],
      proposals: [{
        proposal_ref: 'proposal:empty',
        kind: 'add_requirement',
        contributed_by: 'party:contributor',
        contributed_at: '2026-09-07T00:00:00.000Z',
        summary: 'Add requirement req.i',
        requirement: {
          requirement_ref: 'req.i',
          statement: '',
          acceptance_criteria: [],
          constraint_refs: [],
        },
      }],
    };

    assert.throws(
      () => approveBaselineFromProposals(forged, approver, ['proposal:empty'], 'baseline:i'),
      /requirement statement is required|at least one acceptance criterion|acceptance_criteria/,
    );
  });
});

describe('B4 authority roles are a closed array', () => {
  it('does not treat a role string as requirements_approver via substring includes', () => {
    const spoofed = { party_ref: 'party:attacker', roles: 'delivery_party+requirements_approver' };
    assert.equal(hasRole(spoofed, 'requirements_approver'), false);
    assert.throws(() => assertCanApproveBaseline(spoofed), /roles/);

    let stream = createStream('stream:roles', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement());
    assert.throws(
      () => approveBaselineFromProposals(
        stream,
        spoofed,
        [stream.proposals[0].proposal_ref],
        'baseline:1',
      ),
      /roles/,
    );
    assert.equal(stream.baselines.length, 0);
  });
});

describe('M1 duplicate and stale add proposals do not silently overwrite', () => {
  it('rejects a second pending add for the same requirement_ref', () => {
    let stream = createStream('stream:dup', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement('req.dup', { statement: 'Alice text' }));
    assert.throws(
      () => proposeRequirement(stream, { party_ref: 'party:bob', roles: ['delivery_party'] }, requirement('req.dup', { statement: 'Bob text' })),
      /pending add already exists/,
    );
    assert.equal(stream.proposals.length, 1);
    assert.equal(stream.proposals[0].requirement.statement, 'Alice text');
  });

  it('rejects a stale add after the requirement is already approved', () => {
    let stream = createStream('stream:stale', ['iteration']);
    stream = proposeRequirement(stream, contributor, requirement('req.h', { statement: 'APPROVED TEXT' }));
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:1',
    );

    assert.throws(
      () => proposeRequirement(stream, contributor, requirement('req.h', { statement: 'STALE TEXT' })),
      /already exists in approved baseline/,
    );

    const stalePending = {
      ...stream,
      proposals: [
        ...stream.proposals,
        {
          proposal_ref: 'proposal:stale',
          kind: 'add_requirement',
          contributed_by: 'party:contributor',
          contributed_at: '2026-09-07T00:00:00.000Z',
          summary: 'Add requirement req.h',
          requirement: requirement('req.h', { statement: 'STALE TEXT' }),
        },
      ],
    };
    assert.throws(
      () => approveBaselineFromProposals(stalePending, approver, ['proposal:stale'], 'baseline:2'),
      /already exists; use update/,
    );
    assert.equal(currentBaseline(stream).requirements[0].statement, 'APPROVED TEXT');
  });

  it('rejects two selected add proposals for the same ref in one approval', () => {
    const reqA = requirement('req.dup', { statement: 'Alice text' });
    const reqB = requirement('req.dup', { statement: 'Bob text' });
    const forged = {
      stream_ref: 'stream:batch-dup',
      project_kinds: ['new_product'],
      baselines: [],
      decisions: [],
      proposals: [
        {
          proposal_ref: 'proposal:alice',
          kind: 'add_requirement',
          contributed_by: 'party:alice',
          contributed_at: '2026-09-07T00:00:00.000Z',
          summary: 'Add requirement req.dup',
          requirement: reqA,
        },
        {
          proposal_ref: 'proposal:bob',
          kind: 'add_requirement',
          contributed_by: 'party:bob',
          contributed_at: '2026-09-07T00:00:01.000Z',
          summary: 'Add requirement req.dup',
          requirement: reqB,
        },
      ],
    };

    assert.throws(
      () => approveBaselineFromProposals(
        forged,
        approver,
        ['proposal:alice', 'proposal:bob'],
        'baseline:1',
      ),
      /already exists; use update/,
    );
    assert.equal(forged.baselines.length, 0);
  });
});

describe('M2 import validates discriminated shapes all-or-nothing', () => {
  it('rejects a handover without pending_proposals using an explicit error', () => {
    const stream = createStream('stream:parse', ['new_product']);
    const handover = {
      handover_version: 'aithema.handover/0.1',
      stream_ref: 'stream:parse',
      exported_at: '2026-09-07T12:00:00.000Z',
      baseline: null,
      decisions: [],
    };
    assert.throws(() => parseHandoverJson(handover), /pending_proposals must be an array/);
    assert.throws(() => importHandoverProposal(stream, importer, handover), /pending_proposals must be an array/);
    assert.equal(stream.proposals.length, 0);
  });

  it('does not drop add_constraint proposals that omit constraint', () => {
    const stream = createStream('stream:drop', ['new_product']);
    const handover = emptyHandover('stream:drop', {
      pending_proposals: [
        {
          proposal_ref: 'proposal:kept',
          kind: 'add_requirement',
          contributed_by: 'party:peer',
          contributed_at: '2026-09-07T11:00:00.000Z',
          summary: 'Add requirement req.kept',
          requirement: requirement('req.kept'),
        },
        {
          proposal_ref: 'proposal:dropped',
          kind: 'add_constraint',
          contributed_by: 'party:peer',
          contributed_at: '2026-09-07T11:00:01.000Z',
          summary: 'Add constraint c:dropped',
        },
      ],
    });

    assert.throws(
      () => importHandoverProposal(stream, importer, handover),
      /add_constraint requires constraint/,
    );
    assert.equal(stream.proposals.length, 0);
  });

  it('rejects a proposal that carries both requirement and constraint instead of keeping one', () => {
    const stream = createStream('stream:both', ['new_product']);
    const handover = emptyHandover('stream:both', {
      pending_proposals: [{
        proposal_ref: 'proposal:both',
        kind: 'add_requirement',
        contributed_by: 'party:peer',
        contributed_at: '2026-09-07T11:00:00.000Z',
        summary: 'Add requirement req.both',
        requirement: requirement('req.both'),
        constraint: {
          constraint_ref: 'c:also',
          kind: 'technical',
          statement: 'Must not be dropped silently',
        },
      }],
    });

    assert.throws(
      () => importHandoverProposal(stream, importer, handover),
      /must not include constraint/,
    );
    assert.equal(stream.proposals.length, 0);
  });
});

describe('M3 source handover provenance is a claim, not imported approval', () => {
  it('records source baseline identity without copying approval authority', () => {
    let stream = createStream('stream:provenance', ['new_product']);
    const handover = emptyHandover('stream:provenance', {
      baseline: {
        baseline_ref: 'b:source-v1',
        revision: 4,
        content_digest: 'sha256:' + 'c'.repeat(64),
        revision_seal: 'sha256:' + 'd'.repeat(64),
        approved_by: 'party:foreign-approver',
        approved_at: '2026-09-01T00:00:00.000Z',
        requirements: [requirement('req.imported')],
        constraints: [],
      },
      decisions: [{
        decision_ref: 'decision:foreign',
        proposal_ref: 'proposal:foreign',
        decided_by: 'party:foreign-approver',
        decided_at: '2026-09-01T00:00:00.000Z',
        outcome: 'approved',
        note: 'Foreign approval must not transfer',
      }],
    });

    stream = importHandoverProposal(stream, importer, handover);
    assert.equal(stream.baselines.length, 0);
    assert.equal(stream.decisions.length, 0);
    assert.equal(currentBaseline(stream), null);

    const imported = stream.proposals[0];
    assert.equal(imported.kind, 'import_bundle');
    assert.ok(imported.source_claim, 'imported proposal must retain source handover claims');
    assert.equal(imported.source_claim.baseline_ref, 'b:source-v1');
    assert.equal(imported.source_claim.revision, 4);
    assert.equal(imported.source_claim.content_digest, 'sha256:' + 'c'.repeat(64));
    assert.equal(imported.source_claim.claimed_approved_by, 'party:foreign-approver');
    assert.equal(imported.source_claim.source_kind, 'approved_baseline');
    assert.equal(imported.contributed_by, 'party:importer');

    stream = approveBaselineFromProposals(
      stream,
      approver,
      [imported.proposal_ref],
      'baseline:local',
    );
    const local = currentBaseline(stream);
    assert.equal(local.approved_by, 'party:approver');
    assert.notEqual(local.approved_by, 'party:foreign-approver');
    assert.equal(local.baseline_ref, 'baseline:local');
    assert.notEqual(local.revision_seal, handover.baseline.revision_seal);
  });
});

describe('M4 CSV export is complete and formula-safe', () => {
  it('does not crash on non-string cell values', () => {
    assert.equal(typeof encodeRequirementsCsv([['field', null]]), 'string');
    assert.equal(typeof encodeRequirementsCsv([['field', 12]]), 'string');
    assert.match(encodeRequirementsCsv([['field', null]]), /"field";""/);
  });

  it('neutralises formula payloads hidden behind leading space or newline', () => {
    assert.equal(neutraliseSpreadsheetFormula(' =1+1'), "' =1+1");
    assert.equal(neutraliseSpreadsheetFormula('\n=1+1'), "'\n=1+1");
    assert.equal(neutraliseSpreadsheetFormula('\t@cmd'), "'\t@cmd");
    assert.equal(neutraliseSpreadsheetFormula('plain'), 'plain');
  });

  it('CSV pending rows retain proposed statements and criteria present in JSON', () => {
    let stream = createStream('stream:csv', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement('req.csv', {
      statement: 'Pending statement must appear in CSV',
      acceptance_criteria: ['Pending criterion'],
    }));
    const json = exportHandoverJson(stream, '2026-09-07T13:00:00.000Z');
    const csv = exportHandoverCsv(stream, undefined, '2026-09-07T13:00:00.000Z');

    assert.equal(json.pending_proposals[0].requirement.statement, 'Pending statement must appear in CSV');
    assert.ok(csv.includes('Pending statement must appear in CSV'));
    assert.ok(csv.includes('Pending criterion'));
    assert.ok(csv.includes('"revision_seal";"(none)"'));
  });
});

describe('update proposals require an approved target', () => {
  it('rejects an update when the requirement is not in the baseline', () => {
    const stream = createStream('stream:update', ['new_product']);
    assert.throws(
      () => proposeRequirementUpdate(stream, contributor, requirement()),
      /not in the approved baseline/,
    );
  });
});

function approvedStream(streamRef, reqRef = 'req.x', extras = {}) {
  let stream = createStream(streamRef, ['new_product']);
  stream = proposeRequirement(stream, contributor, requirement(reqRef, { statement: 'BASE', ...extras.requirement }));
  if (extras.constraint) {
    stream = proposeConstraint(stream, contributor, extras.constraint);
  }
  if (extras.secondRequirement) {
    stream = proposeRequirement(stream, contributor, extras.secondRequirement);
  }
  stream = approveBaselineFromProposals(
    stream,
    approver,
    stream.proposals.map((item) => item.proposal_ref),
    'b:1',
  );
  return stream;
}

function forgedUpdate(kind, payload, against, proposalRef, contributedBy = 'party:bob') {
  const proposal = {
    proposal_ref: proposalRef,
    kind,
    contributed_by: contributedBy,
    contributed_at: '2026-09-07T00:00:01.000Z',
    summary: `Update ${kind}`,
    against_baseline_ref: against.baseline_ref,
    against_revision: against.revision,
    against_content_digest: against.content_digest,
  };
  if (kind === 'update_requirement') proposal.requirement = payload;
  else proposal.constraint = payload;
  return proposal;
}

describe('M1 update_requirement and update_constraint do not silently overwrite', () => {
  it('rejects a second pending update for the same requirement_ref', () => {
    let stream = approvedStream('stream:m1-dup');
    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.x', { statement: 'ALICE' }),
    );
    assert.throws(
      () => proposeRequirementUpdate(
        stream,
        { party_ref: 'party:bob', roles: ['delivery_party'] },
        requirement('req.x', { statement: 'BOB' }),
      ),
      /pending update already exists/,
    );
    assert.equal(stream.proposals.filter((item) => item.kind === 'update_requirement').length, 1);
    assert.equal(
      stream.proposals.find((item) => item.kind === 'update_requirement').requirement.statement,
      'ALICE',
    );
  });

  it('rejects two selected requirement updates in one approval and does not claim both included', () => {
    let stream = approvedStream('stream:m1-batch');
    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.x', { statement: 'ALICE' }),
    );
    const aliceRef = stream.proposals.at(-1).proposal_ref;
    const bob = forgedUpdate(
      'update_requirement',
      requirement('req.x', { statement: 'BOB' }),
      currentBaseline(stream),
      'proposal:bob-update',
    );
    const forged = { ...stream, proposals: [...stream.proposals, bob] };

    assert.throws(
      () => approveBaselineFromProposals(
        forged,
        approver,
        [aliceRef, 'proposal:bob-update'],
        'b:2',
      ),
      /conflicting pending updates for requirement_ref req.x/,
    );
    assert.equal(forged.baselines.length, 1);
    assert.equal(forged.decisions.length, 1);
    assert.equal(currentBaseline(forged).requirements[0].statement, 'BASE');
    assert.equal(
      forged.decisions.filter((decision) => decision.outcome === 'approved').length,
      1,
    );
  });

  it('rejects a stale requirement update after another update was already approved', () => {
    let stream = approvedStream('stream:m1-stale');
    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.x', { statement: 'ALICE' }),
    );
    const aliceRef = stream.proposals.at(-1).proposal_ref;
    const bob = forgedUpdate(
      'update_requirement',
      requirement('req.x', { statement: 'BOB' }),
      currentBaseline(stream),
      'proposal:bob-update',
    );
    const withBob = { ...stream, proposals: [...stream.proposals, bob] };
    const afterBob = approveBaselineFromProposals(
      withBob,
      approver,
      ['proposal:bob-update'],
      'b:2',
    );

    assert.equal(currentBaseline(afterBob).requirements[0].statement, 'BOB');
    assert.throws(
      () => approveBaselineFromProposals(afterBob, approver, [aliceRef], 'b:3'),
      /stale; requirement req.x changed since it was authored/,
    );
    assert.equal(currentBaseline(afterBob).requirements[0].statement, 'BOB');
    assert.equal(afterBob.baselines.length, 2);
    assert.equal(
      afterBob.decisions.filter((decision) => decision.proposal_ref === aliceRef).length,
      0,
    );
  });

  it('rejects unbound update_constraint and conflicting constraint updates at approval', () => {
    const constraint = {
      constraint_ref: 'c.x',
      kind: 'technical',
      statement: 'BASE',
    };
    let stream = approvedStream('stream:m1-constraint', 'req.keep', { constraint });
    const baseline = currentBaseline(stream);
    const alice = {
      proposal_ref: 'proposal:alice-constraint',
      kind: 'update_constraint',
      contributed_by: 'party:alice',
      contributed_at: '2026-09-07T00:00:00.000Z',
      summary: 'Update constraint c.x',
      constraint: { ...constraint, statement: 'ALICE' },
    };
    const bob = forgedUpdate(
      'update_constraint',
      { ...constraint, statement: 'BOB' },
      baseline,
      'proposal:bob-constraint',
    );
    const forged = { ...stream, proposals: [...stream.proposals, alice, bob] };

    assert.throws(
      () => approveBaselineFromProposals(
        forged,
        approver,
        ['proposal:alice-constraint', 'proposal:bob-constraint'],
        'b:2',
      ),
      /conflicting pending updates for constraint_ref c.x/,
    );
    assert.equal(forged.baselines.length, 1);
    assert.equal(currentBaseline(forged).constraints[0].statement, 'BASE');

    const afterBob = approveBaselineFromProposals(
      { ...stream, proposals: [...stream.proposals, bob] },
      approver,
      ['proposal:bob-constraint'],
      'b:2',
    );
    assert.equal(currentBaseline(afterBob).constraints[0].statement, 'BOB');
    assert.throws(
      () => approveBaselineFromProposals(
        { ...afterBob, proposals: [...afterBob.proposals, alice] },
        approver,
        ['proposal:alice-constraint'],
        'b:3',
      ),
      /not bound to a baseline snapshot/,
    );
    assert.equal(currentBaseline(afterBob).constraints[0].statement, 'BOB');
  });

  it('still approves non-conflicting edits after an unrelated revision or import', () => {
    let stream = approvedStream('stream:m1-keep', 'req.x', {
      secondRequirement: requirement('req.y', { statement: 'Y BASE' }),
    });
    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.x', { statement: 'ALICE' }),
    );
    const updateX = stream.proposals.at(-1).proposal_ref;
    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.y', { statement: 'Y ALICE' }),
    );
    const updateY = stream.proposals.at(-1).proposal_ref;

    stream = approveBaselineFromProposals(stream, approver, [updateX, updateY], 'b:2');
    assert.equal(
      currentBaseline(stream).requirements.find((item) => item.requirement_ref === 'req.x').statement,
      'ALICE',
    );
    assert.equal(
      currentBaseline(stream).requirements.find((item) => item.requirement_ref === 'req.y').statement,
      'Y ALICE',
    );

    stream = proposeRequirementUpdate(
      stream,
      contributor,
      requirement('req.x', { statement: 'ALICE2' }),
    );
    const laterUpdate = stream.proposals.at(-1).proposal_ref;
    stream = proposeImport(stream, importer, [requirement('req.imported')], []);
    const importRef = stream.proposals.at(-1).proposal_ref;
    stream = approveBaselineFromProposals(stream, approver, [importRef], 'b:3');
    stream = approveBaselineFromProposals(stream, approver, [laterUpdate], 'b:4');

    const latest = currentBaseline(stream);
    assert.equal(latest.requirements.find((item) => item.requirement_ref === 'req.x').statement, 'ALICE2');
    assert.equal(latest.requirements.find((item) => item.requirement_ref === 'req.imported').statement, requirement('req.imported').statement);
    assert.equal(latest.requirements.find((item) => item.requirement_ref === 'req.y').statement, 'Y ALICE');
  });
});

describe('B3 inherited baseline is revalidated at the approval boundary', () => {
  it('rejects a malformed inherited requirement instead of spreading criteria and recertifying', () => {
    const pending = {
      proposal_ref: 'proposal:valid-add',
      kind: 'add_requirement',
      contributed_by: 'party:contributor',
      contributed_at: '2026-09-07T00:00:00.000Z',
      summary: 'Add requirement req.ok',
      requirement: requirement('req.ok'),
    };
    const forged = {
      stream_ref: 'stream:rehydrate-bad',
      project_kinds: ['new_product'],
      decisions: [],
      proposals: [pending],
      baselines: [{
        baseline_ref: 'b:bad',
        revision: 1,
        content_digest: 'sha256:' + 'a'.repeat(64),
        revision_seal: 'sha256:' + 'b'.repeat(64),
        approved_by: 'party:forger',
        approved_at: '2026-09-07T00:00:00.000Z',
        requirements: [{
          requirement_ref: 'req.bad',
          statement: '',
          acceptance_criteria: 'one criterion',
          constraint_refs: [],
        }],
        constraints: [],
      }],
    };

    assert.throws(
      () => approveBaselineFromProposals(forged, approver, ['proposal:valid-add'], 'b:2'),
      /requirement statement is required|acceptance_criteria must be an array of strings/,
    );
    assert.equal(forged.baselines.length, 1);
    assert.equal(forged.decisions.length, 0);
    assert.equal(typeof forged.baselines[0].acceptance_criteria, 'undefined');
  });

  it('rejects an inherited baseline whose digest does not match its content', () => {
    let stream = approvedStream('stream:rehydrate-digest');
    stream = proposeRequirement(stream, contributor, requirement('req.ok2', { statement: 'Next' }));
    const pendingRef = stream.proposals.at(-1).proposal_ref;
    const current = currentBaseline(stream);
    const forged = {
      ...stream,
      baselines: [{
        ...current,
        content_digest: 'sha256:' + 'c'.repeat(64),
        revision_seal: core.revisionSeal({
          baseline_ref: current.baseline_ref,
          revision: current.revision,
          content_digest: 'sha256:' + 'c'.repeat(64),
        }),
      }],
    };

    assert.throws(
      () => approveBaselineFromProposals(forged, approver, [pendingRef], 'b:2'),
      /content_digest does not match canonical payload/,
    );
    assert.equal(forged.baselines.length, 1);
    assert.throws(() => assertRehydratedBaseline(forged.baselines[0]), /content_digest/);
  });

  it('accepts a valid JSON-rehydrated baseline and records a new frozen revision', () => {
    let stream = approvedStream('stream:rehydrate-ok');
    stream = proposeRequirement(stream, contributor, requirement('req.next', { statement: 'Added after reload' }));
    const pendingRef = stream.proposals.at(-1).proposal_ref;
    const rehydrated = JSON.parse(JSON.stringify(stream));

    assert.equal(Object.isFrozen(rehydrated.baselines[0]), false);
    assertRehydratedBaseline(rehydrated.baselines[0]);
    const approved = approveBaselineFromProposals(
      rehydrated,
      approver,
      [pendingRef],
      'b:2',
    );
    assert.equal(currentBaseline(approved).revision, 2);
    assert.ok(currentBaseline(approved).requirements.some((item) => item.requirement_ref === 'req.next'));
    assertApprovedBaselineImmutable(currentBaseline(approved));
  });

  it('does not treat freeze-and-seal as sufficient certification of malformed baseline content', () => {
    const forgedRequirement = {
      requirement_ref: 'req.bad',
      statement: '',
      acceptance_criteria: ['placeholder'],
      constraint_refs: [],
    };
    const digest = contentDigest([forgedRequirement], []);
    const forged = Object.freeze({
      baseline_ref: 'b:forged-freeze',
      revision: 1,
      content_digest: digest,
      revision_seal: core.revisionSeal({
        baseline_ref: 'b:forged-freeze',
        revision: 1,
        content_digest: digest,
      }),
      approved_by: 'party:forger',
      approved_at: '2026-09-07T00:00:00.000Z',
      requirements: Object.freeze([Object.freeze({
        ...forgedRequirement,
        acceptance_criteria: Object.freeze([...forgedRequirement.acceptance_criteria]),
        constraint_refs: Object.freeze([]),
      })]),
      constraints: Object.freeze([]),
    });

    assert.doesNotThrow(() => assertApprovedBaselineImmutable(forged));
    assert.throws(() => assertRehydratedBaseline(forged), /requirement statement is required/);
  });
});

describe('explicit proposal rejection preserves baseline history', () => {
  it('records rejected decisions without changing the approved baseline', () => {
    let stream = approvedStream('stream:reject');
    const before = currentBaseline(stream);
    stream = proposeRequirementUpdate(stream, contributor, requirement('req.x', { statement: 'NO' }));
    const pendingRef = stream.proposals.at(-1).proposal_ref;

    assert.throws(
      () => rejectProposals(stream, contributor, [pendingRef]),
      /requirements_approver/,
    );
    stream = rejectProposals(stream, approver, [pendingRef], 'Not this revision');
    assert.equal(currentBaseline(stream).content_digest, before.content_digest);
    assert.equal(currentBaseline(stream).revision, before.revision);
    const decision = stream.decisions.find((item) => item.proposal_ref === pendingRef);
    assert.equal(decision.outcome, 'rejected');
    assert.equal(decision.decided_by, 'party:approver');
    assert.throws(
      () => approveBaselineFromProposals(stream, approver, [pendingRef], 'b:2'),
      /not found/,
    );
  });
});

