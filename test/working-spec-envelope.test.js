import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendProposal, approveBaselineFromProposals, createStream, currentBaseline,
  proposeRequirement, replaceProposal,
} from '../lib/stream.js';
import {
  addWorkingItem, confirmWorkingItem, confirmWorkingItemVersion, createWorkingSpec,
  prepareWorkingItemRevision, projectSubmission, projectWorkingItemReplacement,
} from '../lib/working-spec.js';

const sid = '00000000-0000-4000-8000-000000000000';
const at = '2026-09-30T00:00:00Z';
const contributor = { party_ref: 'party:synthetic-builder', roles: ['delivery_party'] };
const approver = { party_ref: 'party:synthetic-reviewer', roles: ['requirements_approver'] };
const envelopeFields = ['content', 'content_sha256', 'citations', 'provenance'];
const envelopeRequired = /working-spec projection requires content, content_sha256, citations and provenance/;

function confirmation(item) {
  return { item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' };
}

function fixture(kind = 'requirement') {
  const source = {
    item_ref: kind === 'requirement' ? 'REQ-1' : 'CON-1', kind,
    content: {
      statement: 'Expose a synthetic status endpoint.', acceptance_criteria: [], constraint_refs: [],
      ...(kind === 'constraint' ? { constraint_kind: 'technical' } : {}),
    },
    citations: [{ record_seq: 1, locator: 'turn:0' }],
    provenance: { intent: 'requested', derived_from: [1] },
  };
  const draft = addWorkingItem(createWorkingSpec('review'), source);
  const ready = confirmWorkingItem(draft, confirmation(draft.items[0]));
  const identity = { item_ref: source.item_ref, version: 1 };
  const submitted = projectSubmission(ready, contributor, {
    contributed_at: at,
    bindings: [{ ...identity, host: { proposal_ref: 'proposal:original', op_key: `${sid}:submit:1` } }],
  });
  const empty = createStream('stream:synthetic', ['new_product']);
  const proposal = submitted.proposals[0];
  const stream = appendProposal(empty, contributor, proposal);
  const revision = prepareWorkingItemRevision(submitted.spec, identity, {
    content: { ...source.content, statement: 'Expose synthetic status and readiness endpoints.' },
    citations: source.citations, provenance: source.provenance,
  });
  const replacement = projectWorkingItemReplacement(submitted.spec, contributor, identity,
    confirmWorkingItemVersion(revision, confirmation(revision), 'review'), {
      contributed_at: at,
      host: { proposal_ref: 'proposal:successor', op_key: `${sid}:replace:2` },
    });
  return { empty, stream, proposal, submitted, replacement };
}

function strip(proposal, fields = envelopeFields) {
  const stripped = structuredClone(proposal);
  for (const field of fields) delete stripped[field];
  const native = stripped.kind === 'add_requirement' ? stripped.requirement : stripped.constraint;
  native.statement = 'Approved without confirmation.';
  return stripped;
}

function approve(stream, refs = ['proposal:original']) {
  return approveBaselineFromProposals(stream, approver, refs, 'baseline:synthetic', at);
}

describe('AIT-36 round 2: one projected-envelope authority at every boundary', () => {
  it('append entry point refuses stripped original submissions before recording anything', () => {
    const { empty, proposal } = fixture();
    for (const fields of [envelopeFields, ...envelopeFields.map((field) => [field])]) {
      assert.throws(() => appendProposal(empty, contributor, strip(proposal, fields)), envelopeRequired);
    }
    assert.deepEqual(empty.proposals, []);
    assert.deepEqual(empty.decisions, []);
  });

  it('replacement predecessor entry point refuses a stripped original projection', () => {
    const { stream, proposal, replacement } = fixture();
    const hydrated = { ...stream, proposals: [strip(proposal)] };
    assert.throws(() => replaceProposal(hydrated, contributor, proposal.proposal_ref, replacement.proposal), envelopeRequired);
    assert.equal(hydrated.proposals.length, 1);
    assert.deepEqual(hydrated.decisions, []);
  });

  it('replacement successor entry point refuses a stripped unlinked successor', () => {
    const { stream, proposal, replacement } = fixture();
    const successor = strip(replacement.proposal);
    delete successor.supersedes_proposal_ref;
    assert.throws(() => replaceProposal(stream, contributor, proposal.proposal_ref, successor), envelopeRequired);
    assert.equal(stream.proposals.length, 1);
    assert.deepEqual(stream.decisions, []);
  });

  it('approval entry point refuses a stripped original projected submission', () => {
    const { stream, proposal } = fixture();
    const hydrated = { ...stream, proposals: [strip(proposal)] };
    assert.throws(() => approve(hydrated), envelopeRequired);
    assert.deepEqual(hydrated.baselines, []);
    assert.deepEqual(hydrated.decisions, []);
  });

  it('approval refuses a stripped successor even after its supersedes link is deleted', () => {
    const { stream, proposal, replacement } = fixture();
    const replaced = replaceProposal(stream, contributor, proposal.proposal_ref, replacement.proposal);
    const successor = strip(replaced.proposals[1]);
    delete successor.supersedes_proposal_ref;
    assert.throws(() => approve({ ...replaced, proposals: [replaced.proposals[0], successor] }, [successor.proposal_ref]), envelopeRequired);
    assert.deepEqual(replaced.baselines, []);
  });

  it('approval refuses a stripped successor even when the predecessor envelope is also deleted', () => {
    const { stream, proposal, replacement } = fixture();
    const replaced = replaceProposal(stream, contributor, proposal.proposal_ref, replacement.proposal);
    const predecessor = strip(replaced.proposals[0]);
    const successor = strip(replaced.proposals[1]);
    for (const linked of [true, false]) {
      const request = structuredClone(successor);
      if (!linked) delete request.supersedes_proposal_ref;
      assert.throws(() => approve({ ...replaced, proposals: [predecessor, request] }, [request.proposal_ref]), envelopeRequired);
    }
  });

  it('supersedes ancestry requires an envelope independently of working-spec operation markers', () => {
    const { stream, proposal, replacement } = fixture();
    const successor = strip(replacement.proposal);
    successor.op_key = `${sid}:source:2`;
    const hydrated = {
      ...stream, proposals: [proposal, successor],
      decisions: [{ proposal_ref: proposal.proposal_ref, outcome: 'withdrawn', op_key: `${sid}:turn:9` }],
    };
    assert.throws(() => approve(hydrated, [successor.proposal_ref]), envelopeRequired);
  });

  it('withdrawn-decision ancestry requires an envelope after the successor link is deleted', () => {
    const { stream, proposal, replacement } = fixture();
    const successor = strip(replacement.proposal);
    delete successor.supersedes_proposal_ref;
    successor.op_key = `${sid}:source:2`;
    const hydrated = {
      ...stream, proposals: [proposal, successor],
      decisions: [{ proposal_ref: proposal.proposal_ref, outcome: 'withdrawn', op_key: successor.op_key }],
    };
    assert.throws(() => approve(hydrated, [successor.proposal_ref]), envelopeRequired);
    const unrelated = { ...hydrated, decisions: [{ ...hydrated.decisions[0], op_key: `${sid}:source:3` }] };
    assert.equal(currentBaseline(approve(unrelated, [successor.proposal_ref])).requirements[0].statement, successor.requirement.statement);
  });

  it('each individual predecessor envelope field identifies both supersedes and withdrawn ancestry', () => {
    const { stream, proposal, replacement } = fixture();
    for (const field of envelopeFields) {
      const predecessor = structuredClone(proposal);
      delete predecessor.op_key;
      for (const other of envelopeFields) if (other !== field) delete predecessor[other];
      for (const linked of [true, false]) {
        const successor = strip(replacement.proposal);
        successor.op_key = `${sid}:source:2`;
        if (!linked) delete successor.supersedes_proposal_ref;
        const hydrated = {
          ...stream, proposals: [predecessor, successor],
          decisions: [{ proposal_ref: predecessor.proposal_ref, outcome: 'withdrawn', op_key: linked ? `${sid}:turn:9` : successor.op_key }],
        };
        assert.throws(() => approve(hydrated, [successor.proposal_ref]), envelopeRequired);
        assert.throws(() => appendProposal(hydrated, contributor, successor), envelopeRequired);
      }
    }
  });

  it('a recorded working-spec host binding requires an envelope even without keys or ancestry', () => {
    const { empty, stream, proposal, submitted, replacement } = fixture();
    const stripped = strip(proposal);
    delete stripped.op_key;
    const hydrated = { ...stream, proposals: [stripped], working_spec: submitted.spec };
    assert.throws(() => approve(hydrated), envelopeRequired);
    assert.throws(() => appendProposal({ ...empty, working_spec: submitted.spec }, contributor, stripped), envelopeRequired);
    assert.throws(() => replaceProposal(hydrated, contributor, stripped.proposal_ref, replacement.proposal), envelopeRequired);
    assert.equal(currentBaseline(approve({ ...stream, proposals: [stripped] })).requirements[0].statement, stripped.requirement.statement);
  });

  it('ancestry is transitive and terminates on cycles', () => {
    const { stream, proposal, replacement } = fixture();
    const successor = strip(replacement.proposal);
    delete successor.op_key;
    successor.supersedes_proposal_ref = 'proposal:intermediate';
    const intermediate = { ...successor, proposal_ref: 'proposal:intermediate', supersedes_proposal_ref: proposal.proposal_ref };
    const hydrated = { ...stream, proposals: [proposal, intermediate, successor] };
    assert.throws(() => approve(hydrated, [successor.proposal_ref]), envelopeRequired);
    const cyclic = {
      ...stream, proposals: [
        { ...intermediate, supersedes_proposal_ref: successor.proposal_ref }, successor,
      ],
    };
    assert.equal(currentBaseline(approve(cyclic, [successor.proposal_ref])).requirements[0].statement, successor.requirement.statement);
  });

  it('approval validates every selected proposal, including after a valid legacy proposal', () => {
    const { stream, proposal } = fixture();
    const legacy = proposeRequirement(stream, contributor, {
      requirement_ref: 'REQ-2', statement: 'Expose a synthetic health endpoint.', acceptance_criteria: [], constraint_refs: [],
    }, at).proposals[1];
    const hydrated = { ...stream, proposals: [legacy, strip(proposal)] };
    assert.throws(() => approve(hydrated, [legacy.proposal_ref, proposal.proposal_ref]), envelopeRequired);
    assert.deepEqual(hydrated.baselines, []);
  });

  it('append verifies hashes, evidence and native payload consistency and takes immutable copies', () => {
    const { empty, proposal } = fixture();
    for (const change of [
      { content_sha256: '0'.repeat(64) },
      { citations: [{ record_seq: 1, locator: 'node:1' }] },
      { provenance: { intent: 'approved', derived_from: [1] } },
      { requirement: { ...proposal.requirement, statement: 'Unconfirmed payload.' } },
    ]) {
      assert.throws(() => appendProposal(empty, contributor, { ...proposal, ...change }), /invalid working spec|differs from the confirmed/);
    }
    const request = structuredClone(proposal);
    const appended = appendProposal(empty, contributor, request);
    request.content.statement = 'Caller mutation';
    request.citations[0].locator = 'turn:99';
    assert.deepEqual(appended.proposals[0], proposal);
    assert.ok(Object.isFrozen(appended.proposals[0].content));
    assert.ok(Object.isFrozen(appended.proposals[0].citations[0]));
    assert.equal(Object.isFrozen(request.content), false);
  });

  it('append rejects invalid metadata, collisions and foreign identity relations without recording anything', () => {
    const { empty, stream, proposal } = fixture();
    for (const change of [
      { proposal_ref: '' }, { contributed_by: 'party:forged' }, { contributed_at: '' },
      { summary: null }, { op_key: 42 }, { node_id: 'node:1' },
      { supersedes_draft_id: sid }, { supersedes_item_version: { item_ref: 'REQ-1', version: 1 } },
      { supersedes_proposal_ref: 'proposal:another' },
    ]) assert.throws(() => appendProposal(empty, contributor, { ...proposal, ...change }));
    assert.throws(() => appendProposal(stream, contributor, { ...proposal, op_key: `${sid}:submit:99` }), /proposal_ref must be unique/);
    const accepted = approve(stream);
    assert.throws(() => appendProposal(accepted, contributor, {
      ...proposal, proposal_ref: 'proposal:duplicate-item', op_key: `${sid}:submit:99`,
    }), /already exists in approved baseline/);
    assert.deepEqual(empty.proposals, []);
    assert.deepEqual(empty.decisions, []);
  });

  it('constraint projections use the same append, replacement and approval boundary', () => {
    const { empty, stream, proposal, replacement } = fixture('constraint');
    assert.throws(() => appendProposal(empty, contributor, strip(proposal)), envelopeRequired);
    assert.throws(() => replaceProposal(stream, contributor, proposal.proposal_ref, strip(replacement.proposal)), envelopeRequired);
    const seed = proposeRequirement(stream, contributor, {
      requirement_ref: 'REQ-1', statement: 'Expose a synthetic endpoint.', acceptance_criteria: [], constraint_refs: [],
    }, at);
    const legacyRef = seed.proposals[1].proposal_ref;
    assert.throws(() => approve({ ...seed, proposals: [strip(proposal), seed.proposals[1]] }, [legacyRef, proposal.proposal_ref]), envelopeRequired);
    assert.equal(currentBaseline(approve(seed, [legacyRef, proposal.proposal_ref])).constraints[0].statement, proposal.constraint.statement);
  });

  it('legacy proposeRequirement still appends and approves without a projection envelope', () => {
    const stream = proposeRequirement(createStream('stream:legacy', ['new_product']), contributor, {
      requirement_ref: 'REQ-legacy', statement: 'Expose a synthetic legacy endpoint.', acceptance_criteria: [], constraint_refs: [],
    }, at);
    const proposal = stream.proposals[0];
    for (const key of [...envelopeFields, 'op_key', 'supersedes_proposal_ref']) assert.equal(Object.hasOwn(proposal, key), false);
    assert.equal(currentBaseline(approve(stream, [proposal.proposal_ref])).requirements[0].statement, proposal.requirement.statement);
  });

  it('append retries preserve the original result and conflict on different bytes after acceptance', () => {
    const { empty, stream, proposal } = fixture();
    assert.strictEqual(appendProposal(stream, contributor, structuredClone(proposal)), stream);
    const accepted = approve(stream);
    assert.strictEqual(appendProposal(accepted, contributor, structuredClone(proposal)), accepted);
    for (const change of [
      { summary: 'Different request bytes' }, { content_sha256: '0'.repeat(64) },
      { requirement: { ...proposal.requirement, statement: 'Different native payload.' } },
      { content: { ...proposal.content, statement: 'Different confirmed payload.' } },
    ]) assert.throws(() => appendProposal(accepted, contributor, { ...proposal, ...change }), { code: 'idempotency_conflict', status: 409 });
    assert.throws(() => appendProposal(empty, { party_ref: 'party:invalid', roles: [] }, proposal), /verified authority/);
    assert.throws(() => appendProposal(empty, approver, proposal), /contributor must match/);
    assert.deepEqual(empty.proposals, []);
  });
});
