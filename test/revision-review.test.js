import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptRevisionReview,
  approveBaselineFromProposals,
  buildRevisionReview,
  createStream,
  currentBaseline,
  proposeConstraint,
  proposeConstraintUpdate,
  proposeRequirement,
  proposeRequirementUpdate,
} from '../lib/index.js';
import { ConversationController } from '../runtime/controller.js';
import { MockLlmProvider } from '../runtime/provider.js';
import { SqliteProjectStore } from '../runtime/store.js';
import { renderWorkspacePage } from '../workspace/page.js';

const approver = { party_ref: 'party:reviewer', roles: ['requirements_approver'] };
const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const actor = {
  ...approver,
  actor_kind: 'human',
  subject: 'reviewer',
  projects: [],
};

function approvedStream() {
  let stream = createStream('stream:review', ['iteration']);
  stream = proposeConstraint(stream, contributor, {
    constraint_ref: 'constraint:a',
    kind: 'technical',
    statement: 'Use the old endpoint',
  });
  stream = proposeConstraint(stream, contributor, {
    constraint_ref: 'constraint:b',
    kind: 'agreement',
    statement: 'Owner signs off',
  });
  stream = proposeRequirement(stream, contributor, {
    requirement_ref: 'req:feature',
    statement: 'Provide the original behavior',
    acceptance_criteria: ['Criterion A', 'Criterion B'],
    constraint_refs: ['constraint:a', 'constraint:b'],
  });
  return approveBaselineFromProposals(
    stream,
    approver,
    stream.proposals.map((proposal) => proposal.proposal_ref),
    'baseline:one',
    '2026-09-09T08:00:00.000Z',
  );
}

describe('deterministic consequential revision review', () => {
  it('shows exact changed, added, removed and unchanged requirement and constraint values', () => {
    let stream = approvedStream();
    const baseline = currentBaseline(stream);
    stream = proposeRequirementUpdate(stream, contributor, {
      requirement_ref: 'req:feature',
      statement: 'Provide the revised behavior',
      acceptance_criteria: ['Criterion B', 'Criterion C'],
      constraint_refs: ['constraint:b', 'constraint:c'],
    });
    stream = proposeConstraintUpdate(stream, contributor, {
      constraint_ref: 'constraint:b',
      kind: 'agreement',
      statement: 'Two owners sign off',
    });

    const review = buildRevisionReview(stream);
    assert.equal(buildRevisionReview(stream).review_digest, review.review_digest);
    assert.equal(review.current_baseline.content_digest, baseline.content_digest);
    const requirementReview = review.proposals.find((item) => item.kind === 'update_requirement');
    assert.deepEqual(requirementReview.compared_baseline, {
      baseline_ref: 'baseline:one',
      revision: 1,
      content_digest: baseline.content_digest,
    });
    const change = requirementReview.requirement_changes[0];
    assert.deepEqual(change.statement, {
      status: 'changed',
      before: 'Provide the original behavior',
      after: 'Provide the revised behavior',
    });
    assert.deepEqual([...change.acceptance_criteria.added], ['Criterion C']);
    assert.deepEqual([...change.acceptance_criteria.removed], ['Criterion A']);
    assert.deepEqual([...change.acceptance_criteria.unchanged], ['Criterion B']);
    assert.deepEqual([...change.constraint_refs.added], ['constraint:c']);
    assert.deepEqual([...change.constraint_refs.removed], ['constraint:a']);
    assert.deepEqual([...change.constraint_refs.unchanged], ['constraint:b']);
    assert.equal(requirementReview.deterministic_estimated_impact.changed_value_count, 5);
    assert.deepEqual(
      [...requirementReview.deterministic_estimated_impact.affected_requirement_refs],
      ['req:feature'],
    );
    assert.equal(requirementReview.deterministic_estimated_impact.downstream_impact, 'unknown');

    const constraintReview = review.proposals.find((item) => item.kind === 'update_constraint');
    assert.equal(constraintReview.constraint_changes[0].kind.status, 'unchanged');
    assert.equal(constraintReview.constraint_changes[0].statement.status, 'changed');
    assert.deepEqual(
      [...constraintReview.deterministic_estimated_impact.affected_requirement_refs],
      ['req:feature'],
    );
  });

  it('reports semantically unchanged content without inventing impact', () => {
    let stream = approvedStream();
    const original = currentBaseline(stream).requirements[0];
    stream = proposeRequirementUpdate(stream, contributor, {
      ...original,
      acceptance_criteria: [...original.acceptance_criteria].reverse(),
      constraint_refs: [...original.constraint_refs].reverse(),
    });

    const proposal = buildRevisionReview(stream).proposals[0];
    const change = proposal.requirement_changes[0];
    assert.equal(change.statement.status, 'unchanged');
    assert.equal(change.acceptance_criteria.status, 'unchanged');
    assert.equal(change.constraint_refs.status, 'unchanged');
    assert.equal(proposal.deterministic_estimated_impact.changed_value_count, 0);
    assert.deepEqual([...proposal.deterministic_estimated_impact.affected_requirement_refs], []);
  });

  it('binds accepted decisions to exact reviews and selected proposal payloads', () => {
    let stream = approvedStream();
    stream = proposeRequirementUpdate(stream, contributor, {
      requirement_ref: 'req:feature',
      statement: 'Provide the reviewed behavior',
      acceptance_criteria: ['Criterion B'],
      constraint_refs: ['constraint:b'],
    });
    const proposalRef = stream.proposals.at(-1).proposal_ref;
    const review = buildRevisionReview(stream);
    const identity = acceptRevisionReview(stream, [proposalRef], review.review_digest);

    stream = approveBaselineFromProposals(
      stream,
      approver,
      [proposalRef],
      'baseline:two',
      '2026-09-09T08:05:00.000Z',
      review.review_digest,
    );
    const decision = stream.decisions.at(-1);
    assert.deepEqual(decision.review_identity, identity);
    assert.equal(decision.review_identity.selected_proposals[0].proposal_ref, proposalRef);
    assert.equal(decision.review_identity.compared_baselines[0].baseline_ref, 'baseline:one');
    assert.match(decision.review_identity.accepted_review_digest, /^sha256:[a-f0-9]{64}$/);
  });

  it('rejects stale consent after a concurrent baseline or proposal-set change', () => {
    let stream = approvedStream();
    stream = proposeRequirementUpdate(stream, contributor, {
      requirement_ref: 'req:feature',
      statement: 'Provide the reviewed behavior',
      acceptance_criteria: ['Criterion A', 'Criterion B'],
      constraint_refs: ['constraint:a', 'constraint:b'],
    });
    const updateRef = stream.proposals.at(-1).proposal_ref;
    stream = proposeRequirement(stream, contributor, {
      requirement_ref: 'req:unrelated',
      statement: 'Add an unrelated requirement',
      acceptance_criteria: ['It is visible'],
      constraint_refs: [],
    });
    const addRef = stream.proposals.at(-1).proposal_ref;
    const staleReview = buildRevisionReview(stream);

    stream = approveBaselineFromProposals(
      stream,
      approver,
      [addRef],
      'baseline:two',
      '2026-09-09T08:10:00.000Z',
      staleReview.review_digest,
    );
    assert.throws(
      () => approveBaselineFromProposals(
        stream,
        approver,
        [updateRef],
        'baseline:three',
        '2026-09-09T08:11:00.000Z',
        staleReview.review_digest,
      ),
      /changed; refresh and review again/,
    );

    const renewed = buildRevisionReview(stream);
    assert.notEqual(renewed.review_digest, staleReview.review_digest);
    assert.doesNotThrow(() => acceptRevisionReview(stream, [updateRef], renewed.review_digest));
  });

  it('keeps review access project-isolated', () => {
    const store = new SqliteProjectStore(':memory:');
    const controller = new ConversationController({ store, provider: new MockLlmProvider(), mode: 'test' });
    const project = controller.createProject(actor, { title: 'Private review', projectKinds: ['iteration'] });
    const outsider = {
      ...actor,
      party_ref: 'party:outsider',
      subject: 'outsider',
      roles: ['delivery_party'],
    };
    assert.throws(() => controller.reviewPending(outsider, project.project_ref), /not a member/);
    store.close();
  });

  it('rejects controller approval when the reviewed project revision is concurrent-stale', async () => {
    const store = new SqliteProjectStore(':memory:');
    const controller = new ConversationController({ store, provider: new MockLlmProvider(), mode: 'test' });
    const project = controller.createProject(actor, { title: 'Concurrent review', projectKinds: ['iteration'] });
    await controller.submitTurn({
      actor,
      projectRef: project.project_ref,
      message: 'Provide a deterministic acceptance review',
      turnId: 'turn:first',
    });
    const review = controller.reviewPending(actor, project.project_ref);
    await controller.submitTurn({
      actor,
      projectRef: project.project_ref,
      message: 'A concurrent conversation change',
      turnId: 'turn:concurrent',
      expectedRevision: review.project_revision,
    });
    assert.throws(
      () => controller.approveSelected({
        actor,
        projectRef: project.project_ref,
        proposalRefs: review.proposals.map((proposal) => proposal.proposal_ref),
        expectedRevision: review.project_revision,
        reviewDigest: review.review_digest,
      }),
      /revision conflict|changed; refresh and review again/,
    );
    store.close();
  });

  it('renders an accessible escaped before/after review with honest impact labels', () => {
    let stream = createStream('stream:escaped', ['iteration']);
    stream = proposeRequirement(stream, contributor, {
      requirement_ref: 'req:<old>',
      statement: '<img src=x onerror=old>',
      acceptance_criteria: ['Old <criterion>'],
      constraint_refs: [],
    });
    stream = approveBaselineFromProposals(
      stream,
      approver,
      [stream.proposals[0].proposal_ref],
      'baseline:<one>',
    );
    stream = proposeRequirementUpdate(stream, contributor, {
      requirement_ref: 'req:<old>',
      statement: '<script>new()</script>',
      acceptance_criteria: ['New & criterion'],
      constraint_refs: [],
    });
    const review = { project_revision: 3, ...buildRevisionReview(stream) };
    const html = renderWorkspacePage({
      mode: 'test',
      labelledDemo: true,
      providerLive: false,
      providerId: 'mock',
      publicBasePath: '',
      actor,
      projects: [],
      project: {
        project_ref: 'project:escaped',
        title: 'Escaped review',
        project_kinds: ['iteration'],
        conversation_ref: 'conversation:escaped',
        revision: 3,
        stream,
        transcript: [],
        understanding: null,
        documents: [],
      },
      revisionReview: review,
      allowedSelections: { providers: [] },
      flowState: null,
      speechCapability: { enabled: false },
    });

    assert.doesNotMatch(html, /<img src=x onerror=old>|<script>new\(\)<\/script>/);
    assert.match(html, /&lt;img src=x onerror=old&gt;/);
    assert.match(html, /&lt;script&gt;new\(\)&lt;\/script&gt;/);
    assert.match(html, /<caption>Statement — changed<\/caption>/);
    assert.match(html, /<th scope="row">Before<\/th>/);
    assert.match(html, /<th scope="row">After<\/th>/);
    assert.match(html, /<th scope="row">Added<\/th>/);
    assert.match(html, /<th scope="row">Removed<\/th>/);
    assert.match(html, /Deterministic estimated impact/);
    assert.match(html, /Unknown downstream impact/);
    assert.match(html, /It is not selection size, effort, schedule, or money/);
    assert.match(html, new RegExp(`name="review_digest" value="${review.review_digest}"`));
  });
});
