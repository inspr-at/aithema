import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStream,
  proposeRequirement,
  proposeConstraint,
  approveBaselineFromProposals,
  exportHandoverJson,
  exportHandoverCsv,
  handoverRevisionIdentity,
  parseHandoverJson,
  neutraliseSpreadsheetFormula,
} from '../lib/index.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };

const requirement = {
  requirement_ref: 'req.handover',
  statement: 'Handover export is round-trippable',
  acceptance_criteria: ['JSON and CSV share revision identity', '=formula stays safe'],
  constraint_refs: ['constraint:data.eu'],
};

const constraint = {
  constraint_ref: 'constraint:data.eu',
  kind: 'data',
  statement: 'Personal data stays in the EU',
};

describe('export round trip', () => {
  it('JSON handover parses and preserves revision identity', () => {
    let stream = createStream('stream:export', ['new_product']);
    stream = proposeRequirement(stream, contributor, requirement);
    stream = proposeConstraint(stream, contributor, constraint);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      stream.proposals.map((proposal) => proposal.proposal_ref),
      'baseline:handover',
      '2026-09-07T11:00:00.000Z',
    );

    const json = exportHandoverJson(stream, '2026-09-07T11:05:00.000Z');
    const parsed = parseHandoverJson(json);
    const identity = handoverRevisionIdentity(parsed);

    assert.equal(identity.baseline_ref, 'baseline:handover');
    assert.equal(identity.revision, 1);
    assert.equal(identity.content_digest, json.baseline.content_digest);
    assert.equal(identity.revision_seal, json.baseline.revision_seal);
    assert.equal(parsed.pending_proposals.length, 0);
    assert.equal(parsed.decisions.length, 2);
  });

  it('CSV export identifies the same revision and digest as JSON', () => {
    let stream = createStream('stream:export', ['iteration']);
    stream = proposeRequirement(stream, contributor, requirement);
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:csv',
    );

    const json = exportHandoverJson(stream);
    const csv = exportHandoverCsv(stream);
    const identity = handoverRevisionIdentity(json);

    assert.ok(csv.startsWith('\uFEFF'));
    assert.ok(csv.includes(`"revision";"${identity.revision}"`));
    assert.ok(csv.includes(`"content_digest";"${identity.content_digest}"`));
    assert.ok(csv.includes(`"revision_seal";"${identity.revision_seal}"`));
    assert.ok(csv.includes(`"baseline_ref";"${identity.baseline_ref}"`));
    assert.ok(csv.includes(neutraliseSpreadsheetFormula('=formula stays safe')));
  });
});

describe('adapter independence', () => {
  it('neutralises spreadsheet formulas without branding dependencies', () => {
    assert.equal(neutraliseSpreadsheetFormula('=1+1'), "'=1+1");
    assert.equal(neutraliseSpreadsheetFormula('plain'), 'plain');
  });
});
