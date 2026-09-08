import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { currentBaseline } from '../lib/index.js';
import {
  BILLING_USAGE_UNAVAILABLE,
  ConversationController,
  MockLlmProvider,
  OpenAICompatibleProvider,
  SqliteProjectStore,
  assertCallAllowed,
  effectiveProjectPolicy,
  normalizeOrgPolicy,
  pendingProposalList,
  spendCallId,
} from '../runtime/index.js';
import { normalizeWorkspaceConfig } from '../workspace/config.js';

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

class CountingMock extends MockLlmProvider {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    super({
      executionLocation: 'local',
      allowedDataClasses: ['unclassified', 'public', 'confidential'],
      ...options,
    });
    this.calls = 0;
  }

  async *streamChat(request) {
    this.calls += 1;
    yield* super.streamChat(request);
  }

  async understand(request) {
    this.calls += 1;
    return super.understand(request);
  }
}

function orgPolicy(overrides = {}) {
  return normalizeOrgPolicy({
    epoch: 1,
    execution: 'mixed',
    allowedProviders: ['local', 'cloud'],
    allowedDataClasses: ['unclassified', 'public', 'confidential'],
    dataClass: 'unclassified',
    maxOutboundCallsPerProject: 8,
    ...overrides,
  }, {
    defaultProvider: 'local',
    providers: {
      local: {
        kind: 'mock',
        executionLocation: 'local',
        allowedDataClasses: ['unclassified', 'public', 'confidential'],
      },
      cloud: {
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        modelId: 'cloud-model',
        allowedModels: ['cloud-model'],
        executionLocation: 'cloud',
        allowedDataClasses: ['public'],
      },
    },
  });
}

function controllerFor(file, options = {}) {
  const store = new SqliteProjectStore(file);
  const local = options.local ?? new CountingMock({ id: 'local' });
  const cloud = options.cloud ?? new CountingMock({
    id: 'cloud',
    executionLocation: 'cloud',
    allowedDataClasses: ['public'],
  });
  const policy = options.policy ?? orgPolicy();
  return {
    store,
    local,
    cloud,
    controller: new ConversationController({
      store,
      provider: local,
      providers: { local, cloud, ...(options.extraProviders ?? {}) },
      defaultProviderId: options.defaultProviderId ?? 'local',
      policy,
      mode: 'test',
    }),
  };
}

describe('operator policy normalization', () => {
  it('inherits organization defaults and refuses project broadening', () => {
    const org = orgPolicy({
      execution: 'local',
      allowedProviders: ['local'],
      maxOutboundCallsPerProject: 4,
      projects: {
        'project:narrow': {
          execution: 'local',
          allowedProviders: ['local'],
          dataClass: 'confidential',
          maxOutboundCallsPerProject: 2,
        },
      },
    });
    const effective = effectiveProjectPolicy(org, 'project:narrow');
    assert.equal(effective.execution, 'local');
    assert.equal(effective.dataClass, 'confidential');
    assert.equal(effective.maxOutboundCallsPerProject, 2);
    assert.deepEqual([...effective.allowedProviders], ['local']);
    assert.equal(effectiveProjectPolicy(org, 'project:other').maxOutboundCallsPerProject, 4);

    assert.throws(
      () => orgPolicy({
        execution: 'local',
        allowedProviders: ['local'],
        projects: { 'project:x': { execution: 'cloud' } },
      }),
      /cannot broaden organization execution/,
    );
    assert.throws(
      () => orgPolicy({
        execution: 'local',
        allowedProviders: ['local'],
        projects: { 'project:x': { allowedProviders: ['local', 'cloud'] } },
      }),
      /cannot add providers/,
    );
    assert.equal(normalizeOrgPolicy(null, { providers: {} }), null);
  });

  it('fails closed on unknown location or class when policy constrains them', () => {
    const confidential = effectiveProjectPolicy(orgPolicy({ dataClass: 'confidential' }), 'project:any');
    assert.throws(
      () => assertCallAllowed(confidential, {
        providerId: 'cloud',
        executionLocation: 'cloud',
        allowedModels: ['cloud-model'],
        providerDataClasses: ['public'],
      }),
      /not allowed for this provider/,
    );
    const localOnly = effectiveProjectPolicy(orgPolicy({
      execution: 'local',
      allowedProviders: ['local'],
      dataClass: 'confidential',
    }), 'project:any');
    assert.throws(
      () => assertCallAllowed(localOnly, {
        providerId: 'local',
        executionLocation: 'cloud',
        allowedModels: ['mock'],
        providerDataClasses: ['confidential'],
      }),
      /execution location is not allowed/,
    );
    assert.throws(
      () => assertCallAllowed(localOnly, {
        providerId: 'local',
        executionLocation: 'somewhere',
        allowedModels: ['mock'],
        providerDataClasses: ['confidential'],
      }),
      /location is unknown/,
    );
    assert.throws(
      () => normalizeWorkspaceConfig({
        mode: 'test',
        defaultProvider: 'mock',
        providers: { mock: { kind: 'mock' } },
        policy: {
          execution: 'local',
          allowedProviders: ['mock'],
          allowedDataClasses: ['unclassified'],
        },
      }),
      /executionLocation must be local or cloud/,
    );
  });
});

describe('denied selections make zero outbound calls', () => {
  it('refuses disallowed provider, model, location, and data class before any adapter call', async () => {
    const local = new CountingMock({ id: 'local' });
    const cloud = new CountingMock({
      id: 'cloud',
      executionLocation: 'cloud',
      allowedDataClasses: ['public'],
    });
    const { store, controller: ctl } = controllerFor(':memory:', {
      local,
      cloud,
      policy: orgPolicy({
        dataClass: 'confidential',
        projects: {
          'project:fixed': {
            execution: 'local',
            allowedProviders: ['local'],
            dataClass: 'confidential',
          },
        },
      }),
    });
    const project = store.createProject({
      projectRef: 'project:fixed',
      title: 'Bound',
      projectKinds: ['iteration'],
      actor: reviewer,
    });
    const inherited = ctl.createProject(reviewer, { title: 'Inherited confidential', projectKinds: ['iteration'] });

    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a local-only outcome',
        turnId: 'turn:cloud',
        providerId: 'cloud',
      }),
      /not allowed by project policy|not allowed for this provider/,
    );
    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a local-only outcome',
        turnId: 'turn:model',
        model: 'secret-model',
      }),
      /not in the operator-approved registry/,
    );
    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'Need a local-only outcome',
        turnId: 'turn:missing',
        providerId: 'other',
      }),
      /not in the operator registry|not allowed by project policy/,
    );
    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: inherited.project_ref,
        message: 'Need a local-only outcome',
        turnId: 'turn:class',
        providerId: 'cloud',
      }),
      /not allowed for this provider/,
    );
    assert.equal(local.calls, 0);
    assert.equal(cloud.calls, 0);
    store.close();
  });

  it('does not fall back to a cloud adapter when the selected local call fails', async () => {
    let cloudHits = 0;
    let localHits = 0;
    const localServer = createServer((_req, res) => {
      localHits += 1;
      res.statusCode = 500;
      res.end('no');
    });
    const cloudServer = createServer((_req, res) => {
      cloudHits += 1;
      res.statusCode = 200;
      res.end('{}');
    });
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => cloudServer.listen(0, '127.0.0.1', resolve));
    const localPort = localServer.address().port;
    const cloudPort = cloudServer.address().port;
    const store = new SqliteProjectStore(':memory:');
    const local = new OpenAICompatibleProvider({
      id: 'local',
      baseUrl: `http://127.0.0.1:${localPort}/v1`,
      modelId: 'local-model',
      allowedModels: ['local-model'],
      executionLocation: 'local',
      allowedDataClasses: ['unclassified'],
    });
    const cloud = new OpenAICompatibleProvider({
      id: 'cloud',
      baseUrl: `http://127.0.0.1:${cloudPort}/v1`,
      modelId: 'cloud-model',
      allowedModels: ['cloud-model'],
      executionLocation: 'cloud',
      allowedDataClasses: ['unclassified', 'public'],
    });
    const ctl = new ConversationController({
      store,
      provider: local,
      providers: { local, cloud },
      defaultProviderId: 'local',
      policy: orgPolicy({
        allowedDataClasses: ['unclassified', 'public'],
        dataClass: 'unclassified',
        maxOutboundCallsPerProject: 20,
      }),
      mode: 'test',
    });
    try {
      const project = ctl.createProject(reviewer, { title: 'No fallback', projectKinds: ['iteration'] });
      await assert.rejects(
        () => ctl.submitTurn({
          actor: reviewer,
          projectRef: project.project_ref,
          message: 'Stay on the selected local provider',
          turnId: 'turn:local-fail',
        }),
        /provider HTTP 500/,
      );
      assert.equal(localHits, 1);
      assert.equal(cloudHits, 0);
    } finally {
      store.close();
      await new Promise((resolve) => localServer.close(resolve));
      await new Promise((resolve) => cloudServer.close(resolve));
    }
  });
});

describe('durable outbound request ceiling', () => {
  it('counts each outbound call, isolates projects, and does not treat the cap as currency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-spend-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const first = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 2 }) });
      const projectA = first.controller.createProject(reviewer, { title: 'A', projectKinds: ['new_product'] });
      const projectB = first.controller.createProject(reviewer, { title: 'B', projectKinds: ['iteration'] });
      const turn = await first.controller.submitTurn({
        actor: reviewer,
        projectRef: projectA.project_ref,
        message: 'Users sign in with a magic link',
        turnId: 'turn:a1',
      });
      assert.equal(turn.status, 'complete');
      assert.equal(turn.billing.usage, BILLING_USAGE_UNAVAILABLE);
      assert.equal(first.local.calls, 2);
      assert.equal(first.store.countOutboundCalls(projectA.project_ref, 1), 2);
      assert.equal(currentBaseline(turn.project.stream), null);
      assert.ok(pendingProposalList(turn.project.stream).length >= 1);

      await assert.rejects(
        () => first.controller.submitTurn({
          actor: reviewer,
          projectRef: projectA.project_ref,
          message: 'Another change',
          turnId: 'turn:a2',
          expectedRevision: turn.project.revision,
        }),
        /outbound request ceiling reached/,
      );
      assert.equal(first.local.calls, 2);

      const other = await first.controller.submitTurn({
        actor: reviewer,
        projectRef: projectB.project_ref,
        message: 'Independent project still has quota',
        turnId: 'turn:b1',
      });
      assert.equal(other.status, 'complete');
      assert.equal(first.local.calls, 4);
      first.store.close();

      const restarted = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 2 }) });
      assert.equal(restarted.store.countOutboundCalls(projectA.project_ref, 1), 2);
      const replay = await restarted.controller.submitTurn({
        actor: reviewer,
        projectRef: projectA.project_ref,
        message: 'Users sign in with a magic link',
        turnId: 'turn:a1',
      });
      assert.equal(replay.idempotent, true);
      assert.equal(restarted.local.calls, 0);
      assert.equal(restarted.store.countOutboundCalls(projectA.project_ref, 1), 2);
      restarted.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes reservations across SQLite connections and never refunds a reserved id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-spend-race-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const setup = new SqliteProjectStore(file);
      const created = setup.createProject({
        projectRef: 'project:race',
        title: 'Race',
        projectKinds: ['iteration'],
        actor: reviewer,
      });
      setup.close();

      const left = new SqliteProjectStore(file);
      const right = new SqliteProjectStore(file);
      const call = {
        projectRef: created.project_ref,
        epoch: 1,
        ceiling: 1,
      };
      const results = [
        left.reserveOutboundCall({ ...call, callId: spendCallId('turn:one', 'chat') }),
        right.reserveOutboundCall({ ...call, callId: spendCallId('turn:two', 'chat') }),
      ];
      const reserved = results.filter((item) => item.reserved);
      const denied = results.filter((item) => item.denied);
      assert.equal(reserved.length, 1);
      assert.equal(denied.length, 1);
      assert.equal(left.countOutboundCalls(created.project_ref, 1), 1);

      const retry = right.reserveOutboundCall({
        ...call,
        callId: spendCallId('turn:one', 'chat'),
      });
      assert.equal(retry.uncertain, true);
      left.close();
      right.close();

      const reopened = new SqliteProjectStore(file);
      assert.equal(reopened.countOutboundCalls(created.project_ref, 1), 1);
      const afterRestart = reopened.reserveOutboundCall({
        ...call,
        callId: spendCallId('turn:one', 'chat'),
      });
      assert.equal(afterRestart.uncertain, true);
      const third = reopened.reserveOutboundCall({
        ...call,
        callId: spendCallId('turn:three', 'chat'),
      });
      assert.equal(third.denied, true);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the same call id after an uncertain reservation and does not send again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-spend-uncertain-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const seeded = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 4 }) });
      const project = seeded.controller.createProject(reviewer, { title: 'Uncertain', projectKinds: ['iteration'] });
      const reserved = seeded.store.reserveOutboundCall({
        projectRef: project.project_ref,
        epoch: 1,
        callId: spendCallId('turn:crash', 'chat'),
        ceiling: 4,
      });
      assert.equal(reserved.reserved, true);
      seeded.store.close();

      const later = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 4 }) });
      await assert.rejects(
        () => later.controller.submitTurn({
          actor: reviewer,
          projectRef: project.project_ref,
          message: 'Do not resend after a crash',
          turnId: 'turn:crash',
        }),
        /did not finish cleanly/,
      );
      assert.equal(later.local.calls, 0);
      later.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks stale revision before spending and starts a new window only when epoch changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-spend-epoch-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const first = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 2, epoch: 1 }) });
      const project = first.controller.createProject(reviewer, { title: 'Epoch', projectKinds: ['iteration'] });
      await assert.rejects(
        () => first.controller.submitTurn({
          actor: reviewer,
          projectRef: project.project_ref,
          message: 'Stale',
          turnId: 'turn:stale',
          expectedRevision: project.revision - 1,
        }),
        /revision conflict/,
      );
      assert.equal(first.local.calls, 0);
      assert.equal(first.store.countOutboundCalls(project.project_ref, 1), 0);

      await first.controller.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'First window',
        turnId: 'turn:e1',
      });
      assert.equal(first.local.calls, 2);
      assert.equal(first.store.countOutboundCalls(project.project_ref, 1), 2);
      await assert.rejects(
        () => first.controller.submitTurn({
          actor: reviewer,
          projectRef: project.project_ref,
          message: 'Cap in epoch 1',
          turnId: 'turn:e1b',
          expectedRevision: first.controller.loadProject(reviewer, project.project_ref).revision,
        }),
        /outbound request ceiling reached/,
      );
      first.store.close();

      const next = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 2, epoch: 2 }) });
      const turned = await next.controller.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'New epoch has its own count',
        turnId: 'turn:e2',
      });
      assert.equal(turned.status, 'complete');
      assert.equal(next.store.countOutboundCalls(project.project_ref, 2), 2);
      assert.equal(next.store.countOutboundCalls(project.project_ref, 1), 2);
      next.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps incomplete streams and human approval rules when policy is enabled', async () => {
    const slow = new CountingMock({ id: 'local', chunkDelayMs: 5 });
    const { store, controller: ctl } = controllerFor(':memory:', {
      local: slow,
      policy: orgPolicy({ maxOutboundCallsPerProject: 10 }),
    });
    const project = ctl.createProject(reviewer, { title: 'Review', projectKinds: ['integration'] });
    const abort = new AbortController();
    const result = await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need an export job',
      turnId: 'turn:cancel',
      signal: abort.signal,
      onChunk() { abort.abort(); },
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.proposals_created, []);
    const loaded = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(loaded.transcript.some((entry) => entry.role === 'assistant'), false);
    assert.equal(pendingProposalList(loaded.stream).length, 0);

    const complete = await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need an export job with an acceptance check',
      turnId: 'turn:ok',
      expectedRevision: loaded.revision,
    });
    assert.throws(
      () => ctl.approveSelected({
        actor: agent,
        projectRef: project.project_ref,
        proposalRefs: pendingProposalList(complete.project.stream).map((item) => item.proposal_ref),
      }),
      /not a member|human actor may approve/,
    );
    const approved = ctl.approveSelected({
      actor: reviewer,
      projectRef: project.project_ref,
      proposalRefs: pendingProposalList(complete.project.stream).map((item) => item.proposal_ref),
      expectedRevision: complete.project.revision,
    });
    assert.ok(currentBaseline(approved.stream));
    store.close();
  });
});

describe('document interpret spend ids', () => {
  const encoder = new TextEncoder();

  function noteFile() {
    const bytes = encoder.encode('The product must export a reviewed CSV.');
    return {
      filename: 'need.txt',
      mimeType: 'text/plain',
      bytes,
      byteSize: bytes.byteLength,
    };
  }

  it('lets a deliberate second interpret use a new id, replays a completed id, and never resends reserved or committed ids', async () => {
    const { store, local, controller: ctl } = controllerFor(':memory:', {
      policy: orgPolicy({ maxOutboundCallsPerProject: 2 }),
    });
    const project = ctl.createProject(reviewer, { title: 'Interpret', projectKinds: ['iteration'] });
    const intake = await ctl.intakeDocuments({
      actor: reviewer,
      projectRef: project.project_ref,
      files: [noteFile()],
    });
    const documentRef = intake.accepted[0];
    const first = await ctl.interpretDocument({
      actor: reviewer,
      projectRef: project.project_ref,
      documentRef,
      turnId: 'interpret:one',
      expectedRevision: project.revision,
    });
    assert.equal(first.status, 'complete');
    assert.equal(local.calls, 1);
    assert.ok(first.proposals_created.length >= 1);

    const replay = await ctl.interpretDocument({
      actor: reviewer,
      projectRef: project.project_ref,
      documentRef,
      turnId: 'interpret:one',
      expectedRevision: first.project.revision,
    });
    assert.equal(replay.idempotent, true);
    assert.equal(local.calls, 1);
    assert.equal(store.countOutboundCalls(project.project_ref, 1), 1);

    const second = await ctl.interpretDocument({
      actor: reviewer,
      projectRef: project.project_ref,
      documentRef,
      turnId: 'interpret:two',
      expectedRevision: replay.project.revision,
    });
    assert.equal(second.status, 'complete');
    assert.equal(local.calls, 2);
    assert.equal(store.countOutboundCalls(project.project_ref, 1), 2);

    await assert.rejects(
      () => ctl.interpretDocument({
        actor: reviewer,
        projectRef: project.project_ref,
        documentRef,
        turnId: 'interpret:three',
        expectedRevision: second.project.revision,
      }),
      (error) => error.code === 'spend_denied',
    );
    assert.equal(local.calls, 2);
    store.close();
  });

  it('reports reserved ids as uncertain and committed-without-cache as already completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aithema-interpret-id-'));
    const file = join(dir, 'workspace.sqlite');
    try {
      const seeded = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 4 }) });
      const project = seeded.controller.createProject(reviewer, { title: 'Ids', projectKinds: ['iteration'] });
      const intake = await seeded.controller.intakeDocuments({
        actor: reviewer,
        projectRef: project.project_ref,
        files: [noteFile()],
      });
      const documentRef = intake.accepted[0];
      const reserved = seeded.store.reserveOutboundCall({
        projectRef: project.project_ref,
        epoch: 1,
        callId: spendCallId('interpret:crash', 'interpret'),
        ceiling: 4,
      });
      assert.equal(reserved.reserved, true);
      seeded.store.close();

      const later = controllerFor(file, { policy: orgPolicy({ maxOutboundCallsPerProject: 4 }) });
      await assert.rejects(
        () => later.controller.interpretDocument({
          actor: reviewer,
          projectRef: project.project_ref,
          documentRef,
          turnId: 'interpret:crash',
        }),
        (error) => error.code === 'spend_uncertain',
      );
      assert.equal(later.local.calls, 0);

      const committed = later.store.reserveOutboundCall({
        projectRef: project.project_ref,
        epoch: 1,
        callId: spendCallId('interpret:done', 'interpret'),
        ceiling: 4,
      });
      assert.equal(committed.reserved, true);
      later.store.commitOutboundCall({
        projectRef: project.project_ref,
        epoch: 1,
        callId: spendCallId('interpret:done', 'interpret'),
      });
      await assert.rejects(
        () => later.controller.interpretDocument({
          actor: reviewer,
          projectRef: project.project_ref,
          documentRef,
          turnId: 'interpret:done',
        }),
        (error) => error.code === 'spend_committed',
      );
      assert.equal(later.local.calls, 0);
      later.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not persist a denied turn after the ceiling is already spent', async () => {
    const { store, local, controller: ctl } = controllerFor(':memory:', {
      policy: orgPolicy({ maxOutboundCallsPerProject: 2 }),
    });
    const project = ctl.createProject(reviewer, { title: 'Cap write', projectKinds: ['iteration'] });
    const afterCreate = project.revision;
    const complete = await ctl.submitTurn({
      actor: reviewer,
      projectRef: project.project_ref,
      message: 'Need a first complete turn',
      turnId: 'turn:paid',
    });
    assert.equal(complete.status, 'complete');
    const afterComplete = complete.project.revision;
    assert.ok(afterComplete > afterCreate);
    await assert.rejects(
      () => ctl.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'This must not be stored when the ceiling is spent',
        turnId: 'turn:denied',
        expectedRevision: afterComplete,
      }),
      (error) => error.code === 'spend_denied',
    );
    assert.equal(local.calls, 2);
    const loaded = ctl.loadProject(reviewer, project.project_ref);
    assert.equal(loaded.revision, afterComplete);
    assert.equal(
      loaded.transcript.some((entry) => entry.content.includes('must not be stored')),
      false,
    );
    store.close();
  });
});
