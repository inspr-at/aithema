import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  approveBaselineFromProposals,
  contentDigest,
  createStream,
  currentBaseline,
  exportReviewedHandover,
  proposeRequirement,
} from '../lib/index.js';
import { ConversationController } from '../runtime/controller.js';
import { MockLlmProvider, MOCK_REPLY_MARK } from '../runtime/provider.js';
import { SqliteProjectStore } from '../runtime/store.js';
import { pendingProposalList } from '../runtime/controller.js';

const reviewer = {
  party_ref: 'party:reviewer',
  actor_kind: 'human',
  roles: ['requirements_approver', 'delivery_party'],
  subject: 'reviewer',
  projects: [],
};
const agent = {
  party_ref: 'party:agent',
  actor_kind: 'agent',
  roles: ['delivery_party'],
  subject: 'agent',
  projects: [],
};
const outsider = {
  party_ref: 'party:outsider',
  actor_kind: 'human',
  roles: ['delivery_party'],
  subject: 'outsider',
  projects: [],
};

function controller(file = ':memory:', uploadLimits) {
  const store = new SqliteProjectStore(file);
  return {
    store,
    controller: new ConversationController({
      store,
      provider: new MockLlmProvider(),
      mode: 'test',
      uploadLimits,
    }),
  };
}

describe('durable store, turns, and human review', () => {
  it('keeps projects isolated, resumes after restart, and never auto-approves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-store-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const first = controller(file);
      const created = first.controller.createProject(reviewer, {
        title: 'Sign-in',
        projectKinds: ['new_product', 'iteration'],
      });
      assert.deepEqual([...created.project_kinds], ['new_product', 'iteration']);
      const turn = await first.controller.submitTurn({
        actor: reviewer,
        projectRef: created.project_ref,
        message: 'Users must sign in with a verified email magic link',
        turnId: 'turn:one',
      });
      assert.equal(turn.status, 'complete');
      assert.match(turn.assistant, new RegExp(MOCK_REPLY_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(turn.proposals_created.length >= 1);
      assert.equal(currentBaseline(turn.project.stream), null);
      assert.ok(pendingProposalList(turn.project.stream).length >= 1);
      first.store.close();

      const second = controller(file);
      const resumed = second.controller.loadProject(reviewer, created.project_ref);
      assert.equal(resumed.transcript.length, 2);
      assert.equal(resumed.understanding.next_question.length > 0, true);
      assert.throws(() => second.controller.loadProject(outsider, created.project_ref), /not a member/);

      const replay = await second.controller.submitTurn({
        actor: reviewer,
        projectRef: created.project_ref,
        message: 'Users must sign in with a verified email magic link',
        turnId: 'turn:one',
      });
      assert.equal(replay.idempotent, true);
      assert.equal(replay.project.transcript.length, resumed.transcript.length);

      assert.throws(
        () => second.controller.approveSelected({
          actor: agent,
          projectRef: created.project_ref,
          proposalRefs: [pendingProposalList(resumed.stream)[0].proposal_ref],
        }),
        /not a member|human actor may approve/,
      );

      const agentHome = second.controller.createProject(agent, {
        title: 'Agent draft',
        projectKinds: ['iteration'],
      });
      const agentTurn = await second.controller.submitTurn({
        actor: agent,
        projectRef: agentHome.project_ref,
        message: 'Agents may propose but not approve',
        turnId: 'turn:agent',
      });
      const agentPending = pendingProposalList(agentTurn.project.stream);
      assert.ok(agentPending.length >= 1);
      assert.throws(
        () => second.controller.approveSelected({
          actor: agent,
          projectRef: agentHome.project_ref,
          proposalRefs: [agentPending[0].proposal_ref],
        }),
        /human actor may approve/,
      );

      const approved = second.controller.approveSelected({
        actor: reviewer,
        projectRef: created.project_ref,
        proposalRefs: pendingProposalList(resumed.stream).map((item) => item.proposal_ref),
        expectedRevision: replay.project.revision,
      });
      const baseline = currentBaseline(approved.stream);
      assert.ok(baseline);
      assert.equal(baseline.approved_by, 'party:reviewer');
      const handover = second.controller.handover(reviewer, created.project_ref);
      assert.equal(handover.identity.revision, baseline.revision);
      assert.equal(handover.identity.content_digest, baseline.content_digest);
      assert.match(handover.csv, new RegExp(baseline.revision_seal));
      second.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not persist assistant content or proposals from a cancelled stream', async () => {
    const slow = new MockLlmProvider({ chunkDelayMs: 30 });
    const store = new SqliteProjectStore(':memory:');
    const ctl = new ConversationController({ store, provider: slow, mode: 'test' });
    const project = ctl.createProject(reviewer, { title: 'Cancel', projectKinds: ['integration'] });
    const abort = new AbortController();
    const pending = ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need an export job',
      turnId: 'turn:cancel',
      signal: abort.signal,
      onChunk() { abort.abort(); },
    });
    const result = await pending;
    assert.equal(result.status, 'incomplete');
    assert.equal(result.stream_completed, false);
    assert.deepEqual(result.proposals_created, []);
    const loaded = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(loaded.transcript.some((entry) => entry.role === 'assistant'), false);
    assert.equal(currentBaseline(loaded.stream), null);
    assert.equal(pendingProposalList(loaded.stream).length, 0);
    store.close();
  });

  it('rejects concurrent stale revisions instead of last-write-wins', async () => {
    const { store, controller: ctl } = controller();
    const project = ctl.createProject(reviewer, { title: 'Conflict', projectKinds: ['new_product'] });
    await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need a dashboard',
      turnId: 'turn:a',
    });
    const stale = project.revision;
    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a second dashboard',
        turnId: 'turn:b',
        expectedRevision: stale,
      }),
      /revision conflict/,
    );
    store.close();
  });

  it('does not persist proposals from a truncated provider stream', async () => {
    const { createServer } = await import('node:http');
    const { OpenAICompatibleProvider } = await import('../runtime/provider.js');
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Focused next: what is the acc"}}]}\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: 'should not mint',
          facts: [],
          open_questions: [],
          next_question: 'x',
          candidate_requirements: [{
            requirement_ref: 'req.truncated',
            statement: 'truncated should not become a proposal',
            acceptance_criteria: ['no'],
            constraint_refs: [],
          }],
          project_kinds: ['new_product'],
        }) } }],
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const store = new SqliteProjectStore(':memory:');
    const ctl = new ConversationController({
      store,
      provider: new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      }),
      mode: 'test',
    });
    try {
      const project = ctl.createProject(reviewer, { title: 'Truncated', projectKinds: ['new_product'] });
      const result = await ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a complete answer',
        turnId: 'turn:trunc',
      });
      assert.equal(result.status, 'incomplete');
      assert.equal(result.stream_completed, false);
      assert.equal(result.incomplete_reason, 'truncated');
      assert.deepEqual(result.proposals_created, []);
      const loaded = ctl.loadProject(reviewer, project.project_ref);
      assert.equal(loaded.transcript.some((entry) => entry.role === 'assistant'), false);
      assert.equal(pendingProposalList(loaded.stream).length, 0);
    } finally {
      store.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('revokes mapped project access without sharing party_ref, and keeps creator grants', async () => {
    const { store, controller: ctl } = controller();
    const owner = reviewer;
    const created = ctl.createProject(owner, { title: 'Owned', projectKinds: ['iteration'] });
    const contractor = {
      party_ref: 'party:contractor',
      actor_kind: 'human',
      roles: ['delivery_party'],
      subject: 'contractor',
      projects: [created.project_ref],
    };
    assert.equal(ctl.loadProject(contractor, created.project_ref).project_ref, created.project_ref);
    const revoked = { ...contractor, projects: [] };
    assert.throws(() => ctl.loadProject(revoked, created.project_ref), /not a member/);
    assert.throws(() => ctl.handover(revoked, created.project_ref), /not a member/);
    assert.equal(ctl.loadProject(owner, created.project_ref).project_ref, created.project_ref);

    const twin = {
      party_ref: owner.party_ref,
      actor_kind: 'human',
      roles: ['requirements_approver', 'delivery_party'],
      subject: 'other-subject',
      projects: [],
    };
    assert.throws(() => ctl.loadProject(twin, created.project_ref), /not a member/);
    store.close();
  });

  it('classifies a mid-stream transport error as incomplete without persisting assistant content', async () => {
    const { createServer } = await import('node:http');
    const { OpenAICompatibleProvider } = await import('../runtime/provider.js');
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"partial reply"}}]}\n\n');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const store = new SqliteProjectStore(':memory:');
    const ctl = new ConversationController({
      store,
      provider: new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      }),
      mode: 'test',
    });
    try {
      const project = ctl.createProject(reviewer, { title: 'Transport', projectKinds: ['new_product'] });
      const result = await ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a complete answer',
        turnId: 'turn:transport',
      });
      assert.equal(result.status, 'incomplete');
      assert.equal(result.incomplete_reason, 'truncated');
      const loaded = ctl.loadProject(reviewer, project.project_ref);
      assert.equal(loaded.transcript.some((entry) => entry.role === 'assistant'), false);
    } finally {
      store.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('honours explicit cancel through the understanding phase', async () => {
    const { createServer } = await import('node:http');
    const { OpenAICompatibleProvider } = await import('../runtime/provider.js');
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"complete reply"},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: 'late understanding',
          facts: [],
          open_questions: [],
          next_question: 'late',
          candidate_requirements: [{
            requirement_ref: 'req.late',
            statement: 'should not mint',
            acceptance_criteria: ['no'],
            constraint_refs: [],
          }],
          project_kinds: ['new_product'],
        }) } }],
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const store = new SqliteProjectStore(':memory:');
    const ctl = new ConversationController({
      store,
      provider: new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      }),
      mode: 'test',
    });
    try {
      const project = ctl.createProject(reviewer, { title: 'Cancel understand', projectKinds: ['new_product'] });
      const turnId = 'turn:cancel-understand';
      const pending = ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Cancel during understanding',
        turnId,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(ctl.cancel(project.project_ref, turnId), true);
      const result = await pending;
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.proposals_created, []);
      const loaded = ctl.loadProject(reviewer, project.project_ref);
      assert.equal(loaded.transcript.some((entry) => entry.role === 'assistant'), true);
      assert.equal(pendingProposalList(loaded.stream).length, 0);
    } finally {
      store.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('dedupes in-flight same turn ids before a second provider call', async () => {
    let calls = 0;
    class CountingMock extends MockLlmProvider {
      async *streamChat(request) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield* super.streamChat(request);
      }
    }
    const store = new SqliteProjectStore(':memory:');
    const ctl = new ConversationController({ store, provider: new CountingMock(), mode: 'test' });
    const project = ctl.createProject(reviewer, { title: 'Dedup', projectKinds: ['new_product'] });
    const [first, second] = await Promise.all([
      ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Same turn once',
        turnId: 'turn:shared',
      }),
      ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Same turn once',
        turnId: 'turn:shared',
      }),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.status, 'complete');
    assert.equal(second.status, 'complete');
    assert.deepEqual(first.proposals_created, second.proposals_created);
    const replay = await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Same turn once',
      turnId: 'turn:shared',
    });
    assert.equal(replay.idempotent, true);
    assert.equal(calls, 1);
    store.close();
  });
});

describe('document intake caps', () => {
  const encoder = new TextEncoder();

  function textFile(name, body) {
    const bytes = encoder.encode(body);
    return {
      filename: name,
      mimeType: 'text/plain',
      bytes,
      byteSize: bytes.byteLength,
    };
  }

  async function fillDocuments(ctl, projectRef, count) {
    for (let index = 0; index < count; index += 1) {
      const result = await ctl.intakeDocuments({
        actor: reviewer,
        projectRef,
        files: [textFile(`note-${index + 1}.txt`, `Document ${index + 1}`)],
      });
      assert.equal(result.accepted.length, 1);
      assert.equal(result.rejected.length, 0);
    }
  }

  function ownFormatHandoverBytes(mutate) {
    let source = createStream('stream:foreign', ['iteration']);
    source = proposeRequirement(source, reviewer, {
      requirement_ref: 'req.foreign',
      statement: 'Foreign baseline statement',
      acceptance_criteria: ['Foreign check'],
      constraint_refs: [],
    });
    source = approveBaselineFromProposals(
      source,
      reviewer,
      source.proposals.map((proposal) => proposal.proposal_ref),
      'baseline:foreign-v1',
      '2026-09-01T00:00:00.000Z',
    );
    const handover = exportReviewedHandover(source, {
      baseline_ref: 'baseline:foreign-v1',
      revision: 1,
    }, '2026-09-07T16:00:00.000Z');
    const next = mutate(handover);
    next.baseline.content_digest = contentDigest(
      next.baseline.requirements,
      next.baseline.constraints,
    );
    return encoder.encode(JSON.stringify(next));
  }

  it('reports only persisted document refs when own-format intake crosses the project cap', async () => {
    const { store, controller: ctl } = controller(':memory:', { maxDocumentsPerProject: 2 });
    const project = ctl.createProject(reviewer, { title: 'Cap', projectKinds: ['iteration'] });
    await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need a reviewed baseline before own-format intake',
      turnId: 'turn:cap-base',
    });
    const approved = ctl.approveSelected({
      actor: reviewer,
      projectRef: project.project_ref,
      proposalRefs: pendingProposalList(
        ctl.loadProject(reviewer, project.project_ref).stream,
      ).map((item) => item.proposal_ref),
    });
    assert.ok(currentBaseline(approved.stream));
    await fillDocuments(ctl, project.project_ref, 2);
    const live = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(live.documents.length, 2);

    const bytes = ownFormatHandoverBytes((handover) => ({
      ...handover,
      baseline: {
        ...handover.baseline,
        requirements: [
          ...handover.baseline.requirements,
          {
            requirement_ref: 'req.imported',
            statement: 'Imported through own-format at cap',
            acceptance_criteria: ['Still a proposal'],
            constraint_refs: [],
          },
        ],
      },
    }));
    const result = await ctl.intakeDocuments({
      actor: reviewer,
      projectRef: project.project_ref,
      expectedRevision: live.revision,
      files: [{
        filename: 'handover.json',
        mimeType: 'application/json',
        bytes,
        byteSize: bytes.byteLength,
      }],
    });

    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.rejected, [{ filename: 'handover.json', reason: 'too_many' }]);
    assert.ok(result.notices.some((notice) => /unapproved proposals/i.test(notice)));
    const reloaded = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(reloaded.documents.length, 2);
    assert.ok(pendingProposalList(reloaded.stream).some((item) => item.requirement?.requirement_ref === 'req.imported'));
    store.close();
  });

  it('accepts only the remaining slots for mixed own-format and generic intake at cap', async () => {
    const { store, controller: ctl } = controller(':memory:', { maxDocumentsPerProject: 3 });
    const project = ctl.createProject(reviewer, { title: 'Mixed cap', projectKinds: ['iteration'] });
    await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need a reviewed baseline before mixed intake',
      turnId: 'turn:mixed-base',
    });
    const approved = ctl.approveSelected({
      actor: reviewer,
      projectRef: project.project_ref,
      proposalRefs: pendingProposalList(
        ctl.loadProject(reviewer, project.project_ref).stream,
      ).map((item) => item.proposal_ref),
    });
    assert.ok(currentBaseline(approved.stream));
    await fillDocuments(ctl, project.project_ref, 2);
    const live = ctl.loadProject(reviewer, project.project_ref);

    const bytes = ownFormatHandoverBytes((handover) => ({
      ...handover,
      baseline: {
        ...handover.baseline,
        requirements: [
          ...handover.baseline.requirements,
          {
            requirement_ref: 'req.mixed',
            statement: 'Mixed intake import',
            acceptance_criteria: ['Still a proposal'],
            constraint_refs: [],
          },
        ],
      },
    }));
    const overflow = textFile('overflow.txt', 'Should not fit');
    const result = await ctl.intakeDocuments({
      actor: reviewer,
      projectRef: project.project_ref,
      expectedRevision: live.revision,
      files: [
        {
          filename: 'handover.json',
          mimeType: 'application/json',
          bytes,
          byteSize: bytes.byteLength,
        },
        overflow,
      ],
    });

    assert.equal(result.accepted.length, 1);
    assert.deepEqual(result.rejected, [{ filename: 'overflow.txt', reason: 'too_many' }]);
    const reloaded = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(reloaded.documents.length, 3);
    assert.ok(reloaded.documents.some((doc) => doc.filename === 'handover.json'));
    assert.equal(reloaded.documents.some((doc) => doc.filename === 'overflow.txt'), false);
    assert.deepEqual(
      result.accepted,
      reloaded.documents.map((doc) => doc.document_ref).filter((ref) => result.accepted.includes(ref)),
    );
    store.close();
  });

  it('does not claim extra accepted refs on a retried generic intake at cap', async () => {
    const { store, controller: ctl } = controller(':memory:', { maxDocumentsPerProject: 1 });
    const project = ctl.createProject(reviewer, { title: 'Retry cap', projectKinds: ['iteration'] });
    await fillDocuments(ctl, project.project_ref, 1);
    const first = await ctl.intakeDocuments({
      actor: reviewer,
      projectRef: project.project_ref,
      files: [textFile('late.txt', 'Too late')],
    });
    assert.deepEqual(first.accepted, []);
    assert.deepEqual(first.rejected, [{ filename: 'late.txt', reason: 'too_many' }]);
    const second = await ctl.intakeDocuments({
      actor: reviewer,
      projectRef: project.project_ref,
      files: [textFile('late.txt', 'Too late')],
    });
    assert.deepEqual(second.accepted, []);
    assert.deepEqual(second.rejected, [{ filename: 'late.txt', reason: 'too_many' }]);
    assert.equal(ctl.loadProject(reviewer, project.project_ref).documents.length, 1);
    store.close();
  });
});
