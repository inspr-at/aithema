import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStream,
  currentBaseline,
  proposeRequirement,
  approveBaselineFromProposals,
  proposeImport,
  importHandoverProposal,
  exportHandoverJson,
} from '../lib/index.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };
const importer = { party_ref: 'party:importer', roles: ['operator'] };

const requirement = {
  requirement_ref: 'req.export',
  statement: 'Export JSON and CSV identify the same revision',
  acceptance_criteria: ['CSV rows include revision and content_digest'],
  constraint_refs: [],
};

describe('import proposal vs approval', () => {
  it('creates import proposals without overwriting an approved baseline', () => {
    let stream = createStream('stream:handover', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:approved',
    );
    const approved = currentBaseline(stream);

    const foreign = exportHandoverJson(
      createStream('stream:handover', ['new_product']),
    );
    const importedHandover = {
      ...foreign,
      baseline: {
        baseline_ref: 'baseline:foreign',
        revision: 99,
        content_digest: 'sha256:' + 'a'.repeat(64),
        approved_by: 'party:foreign',
        approved_at: '2026-09-07T10:00:00.000Z',
        requirements: [{
          requirement_ref: 'req.overwrite-attempt',
          statement: 'This must not replace the approved baseline',
          acceptance_criteria: ['Still a proposal only'],
          constraint_refs: [],
        }],
        constraints: [],
      },
    };

    const beforeDigest = approved.content_digest;
    stream = importHandoverProposal(stream, importer, importedHandover);

    assert.equal(currentBaseline(stream).content_digest, beforeDigest);
    assert.equal(currentBaseline(stream).revision, approved.revision);
    assert.ok(stream.proposals.some((proposal) => proposal.kind === 'import_bundle'));
    assert.equal(stream.baselines.length, 1);
  });

  it('rejects import when stream_ref does not match', () => {
    const stream = createStream('stream:a', ['iteration']);
    const handover = exportHandoverJson(createStream('stream:b', ['iteration']));
    assert.throws(
      () => importHandoverProposal(stream, importer, handover),
      /stream_ref/,
    );
  });

  it('never starts delivery implicitly from utterance import', () => {
    let stream = createStream('stream:utterance', ['integration']);
    stream = proposeImport(stream, contributor, [requirement], []);
    assert.equal(stream.baselines.length, 0);
    assert.equal(stream.proposals.length, 1);
    assert.equal(stream.decisions.length, 0);
  });
});
