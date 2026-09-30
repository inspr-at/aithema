import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import {
  approveBaselineFromProposals, createStream, currentBaseline,
  proposeConstraint, proposeImport, proposeRequirement,
  proposeRequirementUpdate, rejectProposals, replaceProposal,
} from '../lib/stream.js';
import { exportHandoverJson } from '../lib/export.js';
import { buildRevisionReview } from '../lib/revision-review.js';
import {
  addWorkingItem, confirmWorkingItem, confirmWorkingItemVersion, createWorkingSpec,
  prepareWorkingItemRevision, projectSubmission, projectWorkingItemReplacement, recordHostDecision,
} from '../lib/working-spec.js';
import { SqliteProjectStore } from '../runtime/store.js';

const sid = '00000000-0000-4000-8000-000000000000';
const at = '2026-09-30T00:00:00Z';
const contributor = { party_ref: 'party:synthetic-builder', roles: ['delivery_party'] };
const approver = { party_ref: 'party:synthetic-reviewer', roles: ['requirements_approver'] };
const actor = { ...approver, actor_kind: 'human', subject: 'synthetic-reviewer', projects: [], can_create_projects: true };
const requirement = {
  requirement_ref: 'REQ-1', statement: 'Expose a status endpoint.',
  acceptance_criteria: ['Returns status.'], constraint_refs: [],
};

function initial() {
  return proposeRequirement(createStream('stream:synthetic', ['new_product']), contributor, requirement, at);
}

function replacement(stream, counter = 1) {
  const old = stream.proposals[0];
  return enveloped({
    proposal_ref: `proposal:replacement-${counter}`, kind: 'add_requirement',
    contributed_by: contributor.party_ref, contributed_at: at, summary: 'Replace status requirement',
    op_key: `${sid}:replace:${counter}`,
    requirement: { ...structuredClone(old.requirement), statement: 'Expose status and readiness endpoints.' },
  });
}

function enveloped(proposal) {
  const content = proposal.kind === 'add_constraint'
    ? { statement: proposal.constraint.statement, acceptance_criteria: [], constraint_refs: [], constraint_kind: proposal.constraint.kind }
    : { statement: proposal.requirement.statement, acceptance_criteria: proposal.requirement.acceptance_criteria, constraint_refs: proposal.requirement.constraint_refs };
  return {
    ...proposal, content, content_sha256: sha256Hex(canonicalJson(content)),
    citations: [{ record_seq: 1, locator: 'turn:0' }], provenance: { intent: 'requested', derived_from: [1] },
  };
}

function apply(store, project, mutate) {
  return store.apply({
    projectRef: project.project_ref, actor, expectedRevision: project.revision,
    mutate: (current) => ({ ...current, stream: mutate(current.stream) }),
  }).project;
}

// Host fixture using the existing store gate: membership/authority before
// replay, replay before lifecycle/CAS, then domain arbitration in mutate().
// Exact replay must not cause another project revision or undo a later accept.
function gatedReplace(store, project, oldRef, proposal) {
  const live = store.getProject(project.project_ref, actor);
  if (live.stream.decisions.some((decision) => decision.op_key === proposal.op_key)) {
    assert.strictEqual(replaceProposal(live.stream, contributor, oldRef, proposal), live.stream);
    return live;
  }
  return apply(store, project, (stream) => replaceProposal(stream, contributor, oldRef, proposal));
}

function fixture() {
  const store = new SqliteProjectStore(':memory:');
  const created = store.createProject({ projectRef: 'project:synthetic', title: 'Synthetic status', projectKinds: ['new_product'], actor });
  return { store, project: apply(store, created, () => initial()) };
}

describe('AIT-36 (b): immutable atomic replaceProposal', () => {
  it('withdraws old and adds the successor in one state without modifying history or baselines', () => {
    const before = initial();
    const request = replacement(before);
    const next = replaceProposal(before, contributor, before.proposals[0].proposal_ref, request);
    assert.equal(before.decisions.length, 0);
    assert.equal(before.proposals.length, 1);
    assert.equal(next.decisions.length, 1);
    assert.equal(next.decisions[0].outcome, 'withdrawn');
    assert.equal(next.decisions[0].proposal_ref, before.proposals[0].proposal_ref);
    assert.equal(next.proposals.length, 2);
    assert.strictEqual(next.proposals[0], before.proposals[0]);
    assert.equal(next.proposals[1].supersedes_proposal_ref, before.proposals[0].proposal_ref);
    assert.equal(next.proposals[1].op_key, request.op_key);
    assert.deepEqual(next.baselines, []);
    request.requirement.statement = 'Caller mutation';
    request.requirement.acceptance_criteria.push('Caller criterion');
    assert.equal(next.proposals[1].requirement.statement, 'Expose status and readiness endpoints.');
    assert.deepEqual(next.proposals[1].requirement.acceptance_criteria, ['Returns status.']);
    assert.ok(Object.isFrozen(next.proposals[1].requirement.acceptance_criteria));
    assert.throws(() => { next.proposals[1].requirement.statement = 'Mutation'; }, TypeError);
    assert.equal(Object.isFrozen(request.requirement), false);
  });

  it('approval refuses withdrawn proposals and accepts the replacement payload', () => {
    const before = initial();
    const oldRef = before.proposals[0].proposal_ref;
    const next = replaceProposal(before, contributor, oldRef, replacement(before));
    for (const selected of [[oldRef], [oldRef, next.proposals[1].proposal_ref]]) {
      assert.throws(() => approveBaselineFromProposals(next, approver, selected, 'baseline:1'), { code: 'draft_superseded', status: 409 });
    }
    const approved = approveBaselineFromProposals(next, approver, [next.proposals[1].proposal_ref], 'baseline:1', at);
    assert.equal(currentBaseline(approved).requirements[0].statement, 'Expose status and readiness endpoints.');
    assert.equal(next.baselines.length, 0);
    assert.equal(approved.decisions[0].outcome, 'withdrawn');
    assert.equal(approved.decisions[1].outcome, 'approved');
  });

  it('export and review omit the withdrawn predecessor but retain its history', () => {
    const before = initial();
    const next = replaceProposal(before, contributor, before.proposals[0].proposal_ref, replacement(before));
    assert.deepEqual(buildRevisionReview(next).proposals.map((p) => p.proposal_ref), [next.proposals[1].proposal_ref]);
    const exported = exportHandoverJson(next, at);
    assert.deepEqual(exported.pending_proposals.map((p) => p.proposal_ref), [next.proposals[1].proposal_ref]);
    assert.equal(exported.decisions[0].outcome, 'withdrawn');
  });

  it('refuses replacement of accepted and rejected proposals', () => {
    const before = initial();
    const oldRef = before.proposals[0].proposal_ref;
    const accepted = approveBaselineFromProposals(before, approver, [oldRef], 'baseline:1', at);
    assert.throws(() => replaceProposal(accepted, contributor, oldRef, replacement(before)), { code: 'already_accepted', status: 409 });
    const rejected = rejectProposals(before, approver, [oldRef], 'Synthetic rejection', at);
    assert.throws(() => replaceProposal(rejected, contributor, oldRef, replacement(before)), /only pending/);
  });

  it('uses contribution authority for replacement, and approval authority for acceptance', () => {
    const before = initial();
    const request = replacement(before);
    const next = replaceProposal(before, contributor, before.proposals[0].proposal_ref, request);
    assert.throws(() => approveBaselineFromProposals(next, contributor, [request.proposal_ref], 'baseline:1'), /requirements_approver/);
    assert.throws(() => replaceProposal(next, { party_ref: 'party:invalid', roles: [] }, before.proposals[0].proposal_ref, request), /verified authority/);
  });

  it('refuses invalid replacement metadata and cross-namespace relations without a withdrawal', () => {
    const before = initial();
    const oldRef = before.proposals[0].proposal_ref;
    for (const change of [
      { proposal_ref: oldRef }, { op_key: `${sid}:submit:1` },
      { contributed_by: 'party:forged' }, { contributed_at: '' },
      { supersedes_proposal_ref: 'proposal:unrelated' }, { supersedes_draft_id: sid },
      { node_id: 'node:accepted' }, { supersedes_item_version: { item_ref: 'REQ-1', version: 1 } },
      { requirement: { ...requirement, requirement_ref: 'REQ-2' } },
      { requirement: { ...requirement, acceptance_criteria: [''] } },
      { kind: 'add_constraint', requirement: undefined, constraint: { constraint_ref: 'CON-1', kind: 'technical', statement: 'Synthetic constraint' } },
    ]) {
      assert.throws(() => replaceProposal(before, contributor, oldRef, { ...replacement(before), ...change }));
      assert.equal(before.proposals.length, 1);
      assert.equal(before.decisions.length, 0);
    }
    assert.throws(() => replaceProposal(before, contributor, 'proposal:missing', replacement(before)), /not found/);
  });

  it('refuses collisions with another pending add instead of partially replacing', () => {
    const before = proposeRequirement(initial(), contributor, { ...requirement, requirement_ref: 'REQ-2' }, at);
    const request = replacement(before);
    request.requirement.requirement_ref = 'REQ-2';
    assert.throws(() => replaceProposal(before, contributor, before.proposals[0].proposal_ref, request), /preserve .* identity/);
    assert.equal(before.decisions.length, 0);
  });

  it('replaces a constraint without requiring an approved baseline', () => {
    const before = proposeConstraint(initial(), contributor, { constraint_ref: 'CON-1', kind: 'technical', statement: 'Use a status endpoint.' }, at);
    const old = before.proposals[1];
    const request = {
      ...replacement(before), kind: 'add_constraint', requirement: undefined,
      constraint: { ...old.constraint, statement: 'Use status and readiness endpoints.' },
    };
    delete request.requirement;
    const next = replaceProposal(before, contributor, old.proposal_ref, enveloped(request));
    const approved = approveBaselineFromProposals(next, approver, [before.proposals[0].proposal_ref, request.proposal_ref], 'baseline:1', at);
    assert.equal(currentBaseline(approved).constraints[0].statement, request.constraint.statement);
  });

  it('keeps legacy update approval and staleness checks, but refuses projected update replacements', () => {
    const seed = initial();
    let stream = approveBaselineFromProposals(seed, approver, [seed.proposals[0].proposal_ref], 'baseline:1', at);
    stream = proposeRequirementUpdate(stream, contributor, { ...requirement, statement: 'Status version two.' }, at);
    const old = stream.proposals.at(-1);
    const request = {
      ...old, proposal_ref: 'proposal:update-replacement', op_key: `${sid}:replace:4`,
      requirement: { ...old.requirement, statement: 'Status version three.' },
    };
    for (const proposal of [request, enveloped(request)]) {
      assert.throws(() => replaceProposal(stream, contributor, old.proposal_ref, proposal), /projection requires content|projections are new requirement or constraint proposals/);
    }
    const stale = { ...stream, proposals: [stream.proposals[0], { ...old, against_content_digest: `sha256:${'0'.repeat(64)}` }] };
    assert.throws(() => approveBaselineFromProposals(stale, approver, [old.proposal_ref], 'baseline:2', at), /stale|match/);
    const approved = approveBaselineFromProposals(stream, approver, [old.proposal_ref], 'baseline:2', at);
    assert.equal(currentBaseline(approved).requirements[0].statement, 'Status version two.');
    assert.equal(currentBaseline(stream).requirements[0].statement, requirement.statement);
    assert.equal(stream.decisions.length, 1, 'refused replacements never withdraw the pending update');
  });

  it('keeps legacy import copies and approval, but refuses projected import replacements', () => {
    const before = proposeImport(createStream('stream:synthetic', ['new_product']), contributor, [requirement], [], at);
    const old = before.proposals[0];
    const request = {
      ...old, proposal_ref: 'proposal:import-replacement', op_key: `${sid}:replace:8`,
      import_requirements: [{ ...requirement, statement: 'Replace synthetic imported status.' }],
      import_constraints: [],
    };
    assert.throws(() => replaceProposal(before, contributor, old.proposal_ref, request), /projection requires content/);
    const envelope = enveloped(replacement(initial()));
    const projectedImport = { ...request, content: envelope.content, content_sha256: envelope.content_sha256, citations: envelope.citations, provenance: envelope.provenance };
    assert.throws(() => replaceProposal(before, contributor, old.proposal_ref, projectedImport), /projections are new requirement or constraint proposals/);
    request.import_requirements[0].statement = 'Caller mutation';
    assert.equal(before.proposals[0].import_requirements[0].statement, requirement.statement);
    const approved = approveBaselineFromProposals(before, approver, [old.proposal_ref], 'baseline:1', at);
    assert.equal(currentBaseline(approved).requirements[0].statement, requirement.statement);
    assert.throws(() => replaceProposal(before, contributor, old.proposal_ref, {
      ...request, import_requirements: [],
    }), /projection requires content/);
    assert.equal(before.decisions.length, 0, 'an empty import must not become a bare withdrawal');
  });

  it('revalidates retained confirmation hashes, evidence shapes and native payload equality', () => {
    const source = {
      item_ref: 'REQ-1', kind: 'requirement',
      content: { statement: requirement.statement, acceptance_criteria: requirement.acceptance_criteria, constraint_refs: [] },
      citations: [{ record_seq: 1, locator: 'turn:0' }], provenance: { intent: 'requested', derived_from: [1] },
    };
    const confirm = (item) => ({ item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' });
    let spec = addWorkingItem(createWorkingSpec('review'), source);
    spec = confirmWorkingItem(spec, confirm(spec.items[0]));
    const submitted = projectSubmission(spec, contributor, { contributed_at: at, bindings: [{ item_ref: 'REQ-1', version: 1, host: { op_key: `${sid}:submit:1`, proposal_ref: 'proposal:original' } }] });
    const stream = { ...createStream('stream:synthetic', ['new_product']), proposals: submitted.proposals };
    const next = prepareWorkingItemRevision(submitted.spec, { item_ref: 'REQ-1', version: 1 }, {
      citations: source.citations, provenance: source.provenance,
      content: { ...source.content, statement: 'Expose status and readiness endpoints.' },
    });
    const candidate = confirmWorkingItemVersion(next, confirm(next), 'review');
    const request = projectWorkingItemReplacement(submitted.spec, contributor, { item_ref: 'REQ-1', version: 1 }, candidate, {
      host: { op_key: `${sid}:replace:2`, proposal_ref: 'proposal:replacement' }, contributed_at: at,
    }).proposal;
    for (const change of [
      { content_sha256: '0'.repeat(64) },
      { citations: [{ record_seq: 1, locator: 'node:1' }] },
      { provenance: { intent: 'approved', derived_from: [1] } },
      { requirement: { ...request.requirement, statement: 'Payload that was not confirmed.' } },
      { content: { ...request.content, node_id: 'node:1' } },
    ]) {
      assert.throws(() => replaceProposal(stream, contributor, 'proposal:original', { ...request, ...change }), /invalid working spec|differs from the confirmed/);
      assert.equal(stream.decisions.length, 0);
    }
    const forged = { ...submitted.proposals[0], requirement: { ...submitted.proposals[0].requirement, statement: 'Unconfirmed native payload.' } };
    assert.throws(() => approveBaselineFromProposals({ ...stream, proposals: [forged] }, approver, [forged.proposal_ref], 'baseline:1'), /differs from the confirmed/);
  });

  it('refuses stripped successor envelopes during replacement and rehydrated approval', () => {
    const source = {
      item_ref: 'REQ-1', kind: 'requirement',
      content: { statement: requirement.statement, acceptance_criteria: requirement.acceptance_criteria, constraint_refs: [] },
      citations: [{ record_seq: 1, locator: 'turn:0' }], provenance: { intent: 'requested', derived_from: [1] },
    };
    const confirm = (item) => ({ item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' });
    let spec = addWorkingItem(createWorkingSpec('review'), source);
    spec = confirmWorkingItem(spec, confirm(spec.items[0]));
    const submitted = projectSubmission(spec, contributor, {
      contributed_at: at, bindings: [{ item_ref: 'REQ-1', version: 1, host: { op_key: `${sid}:submit:1`, proposal_ref: 'proposal:original' } }],
    });
    const before = { ...createStream('stream:synthetic', ['new_product']), proposals: submitted.proposals };
    const draft = prepareWorkingItemRevision(submitted.spec, { item_ref: 'REQ-1', version: 1 }, {
      content: { ...source.content, statement: 'Expose status and readiness endpoints.' },
      citations: source.citations, provenance: source.provenance,
    });
    const candidate = confirmWorkingItemVersion(draft, confirm(draft), 'review');
    const request = projectWorkingItemReplacement(submitted.spec, contributor, { item_ref: 'REQ-1', version: 1 }, candidate, {
      contributed_at: at, host: { op_key: `${sid}:replace:2`, proposal_ref: 'proposal:replacement' },
    }).proposal;
    const valid = replaceProposal(before, contributor, 'proposal:original', request);
    const fields = ['content', 'content_sha256', 'citations', 'provenance'];
    for (const omitted of [fields, ...fields.map((field) => [field])]) {
      const stripped = structuredClone(request);
      for (const field of omitted) delete stripped[field];
      stripped.requirement.statement = 'Changed without full-content confirmation.';
      assert.throws(() => replaceProposal(before, contributor, 'proposal:original', stripped), /projection requires content/);
      const hydrated = { ...valid, proposals: [valid.proposals[0], stripped] };
      assert.throws(() => approveBaselineFromProposals(hydrated, approver, [stripped.proposal_ref], 'baseline:1'), /projection requires content/);
    }
    assert.equal(before.decisions.length, 0);
    assert.equal(valid.baselines.length, 0);
    const approved = approveBaselineFromProposals(valid, approver, [request.proposal_ref], 'baseline:1', at);
    assert.equal(currentBaseline(approved).requirements[0].statement, candidate.content.statement);
  });

  it('projects, approves and replaces the contract REQ-2 with empty acceptance criteria', () => {
    const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/snapshot.review.json', import.meta.url), 'utf8'));
    const item = fixture.doc.spec.items.find((entry) => entry.item_ref === 'REQ-2');
    assert.deepEqual(item.content.acceptance_criteria, []);
    const submitted = projectSubmission(createWorkingSpec('review', [item]), contributor, {
      contributed_at: at, bindings: [{ item_ref: item.item_ref, version: item.version, host: { op_key: `${sid}:submit:1`, proposal_ref: 'proposal:empty-criteria' } }],
    });
    const stream = { ...createStream('stream:synthetic', ['new_product']), proposals: submitted.proposals };
    const approved = approveBaselineFromProposals(stream, approver, ['proposal:empty-criteria'], 'baseline:original', at);
    assert.deepEqual(currentBaseline(approved).requirements[0], submitted.proposals[0].requirement);
    const draft = prepareWorkingItemRevision(submitted.spec, { item_ref: item.item_ref, version: item.version }, {
      content: { ...item.content, statement: 'Expose a synthetic due-date filter.' },
      citations: item.citations, provenance: item.provenance,
    });
    const candidate = confirmWorkingItemVersion(draft, {
      item_ref: draft.item_ref, version: draft.version, content_sha256: draft.content_sha256, principal_ref: 'person:synthetic',
    }, 'review');
    const request = projectWorkingItemReplacement(submitted.spec, contributor, { item_ref: item.item_ref, version: item.version }, candidate, {
      contributed_at: at, host: { op_key: `${sid}:replace:2`, proposal_ref: 'proposal:empty-criteria-replacement' },
    }).proposal;
    const replaced = replaceProposal(stream, contributor, 'proposal:empty-criteria', request);
    const accepted = approveBaselineFromProposals(replaced, approver, [request.proposal_ref], 'baseline:replacement', at);
    assert.deepEqual(currentBaseline(accepted).requirements[0].acceptance_criteria, []);
    assert.equal(currentBaseline(accepted).requirements[0].statement, candidate.content.statement);
    assert.throws(() => replaceProposal(approved, contributor, 'proposal:empty-criteria', request), { code: 'already_accepted' });
  });

  it('still rejects empty criteria strings and empty statements at proposal and approval boundaries', () => {
    for (const change of [
      { acceptance_criteria: [''] }, { acceptance_criteria: [' '] },
      { statement: '', acceptance_criteria: [] }, { statement: ' ', acceptance_criteria: [] },
    ]) {
      const invalid = { ...requirement, ...change };
      assert.throws(() => proposeRequirement(createStream('stream:synthetic', ['new_product']), contributor, invalid, at), /non-empty strings|statement is required/);
      const stream = initial();
      const forged = { ...stream.proposals[0], requirement: invalid };
      assert.throws(() => approveBaselineFromProposals({ ...stream, proposals: [forged] }, approver, [forged.proposal_ref], 'baseline:1'), /non-empty strings|statement is required/);
    }
  });
});

describe('AIT-36 (c, z): SQLite project-revision arbitration and retry fixtures', () => {
  it('accept first: stale replace conflicts, fresh replace is refused already_accepted', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const request = replacement(project.stream);
      const accepted = apply(store, project, (stream) => approveBaselineFromProposals(stream, approver, [oldRef], 'baseline:1', at));
      assert.equal(accepted.revision, project.revision + 1);
      assert.throws(() => gatedReplace(store, project, oldRef, request), { code: 'revision_conflict' });
      assert.throws(() => gatedReplace(store, accepted, oldRef, request), { code: 'already_accepted', status: 409 });
      const live = store.getProject(project.project_ref, actor);
      assert.equal(live.revision, accepted.revision);
      assert.equal(live.stream.proposals.length, 1);
      assert.deepEqual(live.stream.decisions.map((decision) => decision.outcome), ['approved']);
    } finally { store.close(); }
  });

  it('replace first: stale accept conflicts, fresh accept of old is refused draft_superseded', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const request = replacement(project.stream);
      const next = gatedReplace(store, project, oldRef, request);
      assert.equal(next.revision, project.revision + 1, 'one project revision for withdrawal and insertion');
      const accept = (stream) => approveBaselineFromProposals(stream, approver, [oldRef], 'baseline:1', at);
      assert.throws(() => apply(store, project, accept), { code: 'revision_conflict' });
      assert.throws(() => apply(store, next, accept), { code: 'draft_superseded', status: 409 });
      const live = store.getProject(project.project_ref, actor);
      assert.equal(live.revision, next.revision);
      assert.equal(live.stream.proposals.length, 2);
      assert.equal(live.stream.decisions.length, 1);
      assert.equal(live.stream.baselines.length, 0);
      const accepted = apply(store, live, (stream) => approveBaselineFromProposals(stream, approver, [request.proposal_ref], 'baseline:1', at));
      assert.equal(accepted.stream.decisions.at(-1).outcome, 'approved');
    } finally { store.close(); }
  });

  it('replace-vs-replace refuses an already superseded predecessor', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const next = gatedReplace(store, project, oldRef, replacement(project.stream));
      assert.throws(() => gatedReplace(store, project, oldRef, replacement(project.stream, 2)), { code: 'revision_conflict' });
      assert.throws(() => gatedReplace(store, next, oldRef, replacement(project.stream, 2)), { code: 'draft_superseded', status: 409 });
      assert.equal(store.getProject(project.project_ref, actor).revision, next.revision);
    } finally { store.close(); }
  });

  it('exact retry returns the original proposal and decision, including after later acceptance', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const request = replacement(project.stream);
      const next = gatedReplace(store, project, oldRef, request);
      const retry = gatedReplace(store, project, oldRef, structuredClone(request));
      assert.equal(retry.revision, next.revision);
      assert.deepEqual(retry.stream, next.stream, 'stored request bytes and original generated identities survive hydration');
      const accepted = apply(store, next, (stream) => approveBaselineFromProposals(stream, approver, [request.proposal_ref], 'baseline:1', at));
      const afterAcceptRetry = gatedReplace(store, project, oldRef, request);
      assert.equal(afterAcceptRetry.revision, accepted.revision);
      assert.deepEqual(afterAcceptRetry.stream.proposals[1], next.stream.proposals[1]);
      assert.deepEqual(afterAcceptRetry.stream.decisions[0], next.stream.decisions[0]);
      assert.deepEqual(afterAcceptRetry.stream.baselines, accepted.stream.baselines);
    } finally { store.close(); }
  });

  it('replays the stored successor with its injected supersedes link before and after acceptance', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const request = replacement(project.stream);
      assert.equal(Object.hasOwn(request, 'supersedes_proposal_ref'), false);
      const next = gatedReplace(store, project, oldRef, request);
      const stored = next.stream.proposals[1];
      assert.equal(stored.supersedes_proposal_ref, oldRef);
      assert.equal(Object.hasOwn(request, 'supersedes_proposal_ref'), false, 'caller request stays unchanged');
      const replay = gatedReplace(store, project, oldRef, structuredClone(stored));
      assert.equal(replay.revision, next.revision);
      assert.deepEqual(replay.stream, next.stream);
      const accepted = apply(store, next, (stream) => approveBaselineFromProposals(stream, approver, [stored.proposal_ref], 'baseline:1', at));
      const afterAccept = gatedReplace(store, project, oldRef, stored);
      assert.equal(afterAccept.revision, accepted.revision);
      assert.deepEqual(afterAccept.stream, accepted.stream);
      for (const change of [
        { supersedes_proposal_ref: 'proposal:another' },
        { requirement: { ...stored.requirement, statement: 'Different stored bytes.' } },
      ]) {
        assert.throws(() => gatedReplace(store, project, oldRef, { ...stored, ...change }), { code: 'idempotency_conflict', status: 409 });
      }
      assert.equal(store.getProject(project.project_ref, actor).revision, accepted.revision);
    } finally { store.close(); }
  });

  it('same key with different bytes conflicts before lifecycle arbitration and causes no revision', () => {
    const { store, project } = fixture();
    try {
      const oldRef = project.stream.proposals[0].proposal_ref;
      const request = replacement(project.stream);
      const next = gatedReplace(store, project, oldRef, request);
      for (const change of [
        { summary: 'Different bytes' }, { proposal_ref: 'proposal:another' },
        { contributed_at: '2026-09-30T00:00:01Z' },
        { requirement: { ...request.requirement, statement: 'Different statement.' } },
        { requirement: { ...request.requirement, acceptance_criteria: [] } },
      ]) assert.throws(() => gatedReplace(store, project, oldRef, { ...request, ...change }), { code: 'idempotency_conflict', status: 409 });
      assert.throws(() => gatedReplace(store, project, 'proposal:other-old', request), { code: 'idempotency_conflict' });
      assert.equal(store.getProject(project.project_ref, actor).revision, next.revision);
    } finally { store.close(); }
  });

  it('direct exact replay returns the current immutable stream without duplicating generated ids', () => {
    const before = initial();
    const request = replacement(before);
    const next = replaceProposal(before, contributor, before.proposals[0].proposal_ref, request);
    assert.strictEqual(replaceProposal(next, contributor, before.proposals[0].proposal_ref, structuredClone(request)), next);
  });

  it('an original retry preserves a later replacement of its successor', () => {
    const before = initial();
    const oldRef = before.proposals[0].proposal_ref;
    const first = replacement(before);
    const next = replaceProposal(before, contributor, oldRef, first);
    const second = replacement(next, 2);
    const twice = replaceProposal(next, contributor, first.proposal_ref, second);
    assert.strictEqual(replaceProposal(twice, contributor, oldRef, first), twice);
    assert.equal(twice.proposals.length, 3);
    assert.equal(twice.decisions.length, 2);
    assert.equal(twice.proposals[2].supersedes_proposal_ref, first.proposal_ref);
    assert.throws(() => approveBaselineFromProposals(twice, approver, [first.proposal_ref], 'baseline:1'), { code: 'draft_superseded' });
  });

  it('commits working item supersession and host withdrawal together inside the existing gate', () => {
    const store = new SqliteProjectStore(':memory:');
    try {
      const source = {
        item_ref: 'REQ-1', kind: 'requirement',
        content: { statement: requirement.statement, acceptance_criteria: requirement.acceptance_criteria, constraint_refs: [] },
        citations: [{ record_seq: 1, locator: 'turn:0' }], provenance: { intent: 'requested', derived_from: [1] },
      };
      const confirm = (item) => ({ item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' });
      const draft = addWorkingItem(createWorkingSpec('review'), source);
      const ready = confirmWorkingItem(draft, confirm(draft.items[0]));
      const projection = projectSubmission(ready, contributor, { contributed_at: at, bindings: [{ item_ref: 'REQ-1', version: 1, host: { op_key: `${sid}:submit:1`, proposal_ref: 'proposal:original' } }] });
      const created = store.createProject({ projectRef: 'project:synthetic', title: 'Synthetic status', projectKinds: ['new_product'], actor });
      const project = apply(store, created, (stream) => ({ ...stream, proposals: projection.proposals, working_spec: projection.spec }));
      const oldIdentity = { item_ref: 'REQ-1', version: 1 };
      const draftReplacement = prepareWorkingItemRevision(projection.spec, oldIdentity, {
        content: { ...source.content, statement: 'Expose status and readiness endpoints.' },
        citations: source.citations, provenance: source.provenance,
      });
      const candidate = confirmWorkingItemVersion(draftReplacement, confirm(draftReplacement), 'review');
      const binding = { op_key: `${sid}:replace:2`, proposal_ref: 'proposal:replacement' };
      let originalRequest;
      const next = apply(store, project, (stream) => {
        const operation = projectWorkingItemReplacement(stream.working_spec, contributor, oldIdentity, candidate, { host: binding, contributed_at: at });
        originalRequest = operation.proposal;
        return { ...replaceProposal(stream, contributor, 'proposal:original', operation.proposal), working_spec: operation.spec };
      });
      assert.equal(next.revision, project.revision + 1);
      assert.deepEqual(next.stream.working_spec.items.map((item) => item.state), ['superseded', 'proposed']);
      assert.deepEqual(project.stream.working_spec.items.map((item) => item.state), ['proposed']);
      assert.equal(next.stream.decisions[0].outcome, 'withdrawn');
      assert.equal(next.stream.proposals[1].content_sha256, candidate.content_sha256);
      assert.deepEqual(next.stream.proposals[1].content, candidate.content);
      assert.throws(() => apply(store, next, (stream) => approveBaselineFromProposals(stream, approver, ['proposal:original'], 'baseline:1', at)), { code: 'draft_superseded' });
      const accepted = apply(store, next, (stream) => ({
        ...approveBaselineFromProposals(stream, approver, ['proposal:replacement'], 'baseline:1', at),
        working_spec: recordHostDecision(stream.working_spec, { item_ref: 'REQ-1', version: 2 }, binding, 'accepted'),
      }));
      assert.equal(accepted.stream.working_spec.items[1].state, 'accepted');
      assert.equal(currentBaseline(accepted.stream).requirements[0].statement, candidate.content.statement);
      assert.strictEqual(replaceProposal(accepted.stream, contributor, 'proposal:original', originalRequest), accepted.stream);
    } finally { store.close(); }
  });
});
