import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { currentBaseline } from '../lib/stream.js';
import { ConversationController, pendingProposalList } from '../runtime/controller.js';
import {
  PREVIEW_LIMITS,
  PreviewBindingRegistry,
  normalizePreviewBindings,
  normalizePreviewElement,
} from '../runtime/preview.js';
import { MockLlmProvider } from '../runtime/provider.js';
import { SqliteProjectStore } from '../runtime/store.js';
import { normalizeWorkspaceConfig } from '../workspace/config.js';
import {
  PREVIEW_PROTOCOL,
  createPreviewAdapter,
  previewElementMetadata,
} from '../workspace/preview-adapter.js';
import {
  acceptWorkspacePreviewMessage,
  bindWorkspacePreviewFeedback,
} from '../workspace/preview-feedback.js';
import { renderWorkspacePage } from '../workspace/page.js';
import {
  assertSameOriginMutation,
  contentSecurityPolicyForPreviewBindings,
} from '../workspace/server.js';
import { resolveWorkspaceStatic } from '../workspace/flow-assets.js';

const reviewer = Object.freeze({
  party_ref: 'party:reviewer',
  actor_kind: 'human',
  roles: Object.freeze(['requirements_approver', 'delivery_party']),
  subject: 'reviewer',
  projects: Object.freeze([]),
});

const baseConfig = {
  mode: 'test',
  listenHost: '127.0.0.1',
  defaultProvider: 'mock',
  identity: { kind: 'demo', memberships: [] },
  providers: { mock: { kind: 'mock' } },
};

function binding(projectRef, revision = 'artifact:abc123') {
  return {
    projectRef,
    artifactRevision: revision,
    previewUrl: 'https://preview.example.invalid/build/abc123/index.html?mode=review',
  };
}

function submission(capability, extra = {}) {
  const input = {
    actor: reviewer,
    projectRef: capability.projectRef,
    message: 'Make the primary action clearer.',
    expectedRevision: capability.projectRevision,
    nonce: capability.nonce,
    turnId: capability.turnId,
    bindingKey: capability.bindingKey,
    artifactRevision: capability.artifactRevision,
    elementRef: 'hero.primary-action',
    elementLabel: 'Primary action',
    ...extra,
  };
  return {
    ...input,
    browserBody: extra.browserBody ?? {
      expected_revision: String(input.expectedRevision),
      preview_nonce: input.nonce,
      turn_id: input.turnId,
      binding_key: input.bindingKey,
      artifact_revision: input.artifactRevision,
      element_ref: input.elementRef,
      element_label: input.elementLabel,
      message: input.message,
    },
  };
}

function setup(provider = new MockLlmProvider()) {
  const store = new SqliteProjectStore(':memory:');
  const previews = new PreviewBindingRegistry([]);
  const controller = new ConversationController({
    store,
    provider,
    mode: 'test',
    previewBindings: previews,
  });
  const project = controller.createProject(reviewer, {
    title: 'Preview feedback',
    projectKinds: ['iteration'],
  });
  previews.replace([binding(project.project_ref)]);
  return { store, previews, controller, project };
}

describe('operator-owned preview binding', () => {
  it('is disabled by default and accepts only unique exact HTTP(S) artifact mappings', () => {
    assert.deepEqual(normalizeWorkspaceConfig(baseConfig).previewBindings, []);
    const normalized = normalizePreviewBindings([{
      projectRef: 'project:one',
      artifactRevision: 'git:abc',
      previewUrl: 'https://preview.example.invalid/build/abc?x=1',
    }]);
    assert.equal(normalized[0].previewOrigin, 'https://preview.example.invalid');
    assert.equal(normalized[0].previewUrl, 'https://preview.example.invalid/build/abc?x=1');
    assert.match(normalized[0].bindingKey, /^[a-f0-9]{64}$/);

    assert.throws(() => normalizePreviewBindings([
      binding('project:one'),
      binding('project:one', 'other'),
    ]), /unique/);
    for (const previewUrl of [
      'javascript:alert(1)',
      'https://user:pass@preview.example.invalid/build',
      'https://preview.example.invalid/build#fragment',
    ]) {
      assert.throws(() => normalizePreviewBindings([{
        projectRef: 'project:one',
        artifactRevision: 'artifact:one',
        previewUrl,
      }]), /previewUrl/);
    }
    assert.throws(() => normalizeWorkspaceConfig({
      ...baseConfig,
      publicOrigin: 'https://preview.example.invalid',
      previewBindings: [binding('project:one')],
    }), /must differ/);
    assert.throws(() => normalizeWorkspaceConfig({
      ...baseConfig,
      previewBindings: [binding('project:one')],
    }), /publicOrigin is required/);
    assert.match(resolveWorkspaceStatic('/preview-adapter.js').path, /preview-adapter\.js$/);
    assert.match(resolveWorkspaceStatic('/workspace-preview-feedback.js').path, /preview-feedback\.js$/);
    const csp = contentSecurityPolicyForPreviewBindings(normalized);
    assert.match(csp, /frame-src https:\/\/preview\.example\.invalid(?:;|$)/);
    assert.doesNotMatch(csp, /frame-src \*/);
  });

  it('expires capabilities and rejects wrong actor, project, revision, nonce, and rebind', () => {
    let clock = 1_000;
    const registry = new PreviewBindingRegistry([binding('project:one')], {
      now: () => clock,
      nonceTtlMs: 100,
    });
    const cap = registry.issue({ actor: reviewer, projectRef: 'project:one', projectRevision: 7 });
    const valid = {
      actor: reviewer,
      projectRef: 'project:one',
      projectRevision: 7,
      nonce: cap.nonce,
      turnId: cap.turnId,
      artifactRevision: cap.artifactRevision,
      bindingKey: cap.bindingKey,
      element: { elementRef: 'nav.account', elementLabel: 'Account' },
    };
    assert.throws(() => registry.consume({ ...valid, projectRevision: 8 }), /changed/);
    assert.throws(() => registry.consume({ ...valid, actor: { ...reviewer, subject: 'other' } }), /changed/);
    assert.throws(() => registry.consume({ ...valid, nonce: 'wrong' }), /expired/);
    registry.replace([binding('project:one', 'artifact:new')]);
    assert.throws(() => registry.consume(valid), /expired|changed/);

    const fresh = registry.issue({ actor: reviewer, projectRef: 'project:one', projectRevision: 7 });
    clock += 101;
    assert.throws(() => registry.consume({
      ...valid,
      nonce: fresh.nonce,
      turnId: fresh.turnId,
      artifactRevision: fresh.artifactRevision,
      bindingKey: fresh.bindingKey,
    }), /expired/);
  });
});

describe('preview-side and workspace message boundary', () => {
  it('requires exact origin/source/live fields and sends only explicit bounded element metadata', () => {
    const listeners = new Map();
    const posts = [];
    const parentWindow = { postMessage: (data, targetOrigin) => posts.push({ data, targetOrigin }) };
    const selfWindow = {
      parent: parentWindow,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    };
    const root = {
      addEventListener: (type, fn) => listeners.set(`root:${type}`, fn),
      removeEventListener: (type) => listeners.delete(`root:${type}`),
      contains: () => true,
    };
    const attributes = new Map([
      ['data-aithema-ref', 'hero.primary-action'],
      ['data-aithema-label', '<Primary & action>'],
      ['class', 'ambient-secret-class'],
    ]);
    const element = {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      closest: () => element,
      textContent: 'ambient page text must not be collected',
      outerHTML: '<button>ambient serialization</button>',
    };
    const adapter = createPreviewAdapter({
      workspaceOrigin: 'https://workspace.example.invalid',
      selfWindow,
      parentWindow,
      root,
    });
    const bind = {
      type: 'aithema:preview-bind',
      protocol: PREVIEW_PROTOCOL,
      projectRef: 'project:one',
      artifactRevision: 'artifact:abc',
      bindingKey: 'a'.repeat(64),
      nonce: 'nonce:one',
    };
    listeners.get('message')({ origin: 'https://evil.example', source: parentWindow, data: bind });
    assert.equal(adapter.select(element), false);
    listeners.get('message')({ origin: 'https://workspace.example.invalid', source: {}, data: bind });
    assert.equal(adapter.select(element), false);
    listeners.get('message')({ origin: 'https://workspace.example.invalid', source: parentWindow, data: bind });
    assert.equal(posts.length, 0);
    assert.equal(adapter.select(element), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].targetOrigin, 'https://workspace.example.invalid');
    assert.deepEqual(posts[0].data.element, {
      elementRef: 'hero.primary-action',
      elementLabel: '<Primary & action>',
    });
    assert.equal(JSON.stringify(posts[0]).includes('ambient'), false);
    listeners.get('root:keydown')({ key: 'Enter', target: element });
    assert.equal(posts.length, 2);
    assert.throws(() => createPreviewAdapter({
      workspaceOrigin: '*', selfWindow, parentWindow, root,
    }), /exact origin/);
    adapter.destroy();
  });

  it('populates an editable inspectable draft without invoking Submit', () => {
    const frameListeners = new Map();
    const windowListeners = new Map();
    const posted = [];
    const sourceWindow = { postMessage: (data, origin) => posted.push({ data, origin }) };
    const frame = {
      contentWindow: sourceWindow,
      addEventListener: (type, fn) => frameListeners.set(type, fn),
      removeEventListener: (type) => frameListeners.delete(type),
    };
    let focused = 0;
    let submitted = 0;
    const summary = { textContent: '' };
    const form = {
      hidden: true,
      elements: {
        element_ref: { value: '' },
        element_label: { value: '' },
        message: { disabled: true, focus: () => { focused += 1; } },
      },
      querySelector: () => summary,
      submit: () => { submitted += 1; },
    };
    const bindingData = {
      projectRef: 'project:one',
      artifactRevision: 'artifact:abc',
      bindingKey: 'b'.repeat(64),
      nonce: 'nonce:one',
      previewOrigin: 'https://preview.example.invalid',
    };
    const doc = {
      getElementById: () => ({ textContent: JSON.stringify(bindingData) }),
      querySelector: (selector) => selector === '[data-preview-frame]' ? frame : form,
    };
    const win = {
      addEventListener: (type, fn) => windowListeners.set(type, fn),
      removeEventListener: (type) => windowListeners.delete(type),
    };
    const bridge = bindWorkspacePreviewFeedback(doc, win);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].origin, bindingData.previewOrigin);
    assert.equal(form.hidden, true);
    assert.equal(submitted, 0);

    windowListeners.get('message')({
      origin: bindingData.previewOrigin,
      source: sourceWindow,
      data: {
        type: 'aithema:preview-selection',
        protocol: PREVIEW_PROTOCOL,
        projectRef: bindingData.projectRef,
        artifactRevision: bindingData.artifactRevision,
        bindingKey: bindingData.bindingKey,
        nonce: bindingData.nonce,
        element: { elementRef: 'hero.action', elementLabel: 'Hero action' },
      },
    });
    assert.equal(form.hidden, false);
    assert.equal(form.elements.element_ref.value, 'hero.action');
    assert.equal(form.elements.message.disabled, false);
    assert.equal(summary.textContent, 'Hero action (hero.action)');
    assert.equal(focused, 1);
    assert.equal(submitted, 0);
    bridge.destroy();
  });

  it('validates the workspace event origin, frame window, nonce, project, artifact, and bounds', () => {
    const sourceWindow = {};
    const bindingData = {
      projectRef: 'project:one',
      artifactRevision: 'artifact:abc',
      bindingKey: 'b'.repeat(64),
      nonce: 'nonce:one',
      previewOrigin: 'https://preview.example.invalid',
    };
    const event = {
      origin: bindingData.previewOrigin,
      source: sourceWindow,
      data: {
        type: 'aithema:preview-selection',
        protocol: PREVIEW_PROTOCOL,
        projectRef: bindingData.projectRef,
        artifactRevision: bindingData.artifactRevision,
        bindingKey: bindingData.bindingKey,
        nonce: bindingData.nonce,
        element: { elementRef: 'card.save', elementLabel: '<Save>' },
      },
    };
    assert.deepEqual(acceptWorkspacePreviewMessage(event, bindingData, sourceWindow), {
      elementRef: 'card.save',
      elementLabel: '<Save>',
    });
    for (const changed of [
      { origin: 'https://evil.example' },
      { source: {} },
      { data: { ...event.data, nonce: 'wrong' } },
      { data: { ...event.data, projectRef: 'project:other' } },
      { data: { ...event.data, artifactRevision: 'artifact:other' } },
      { data: { ...event.data, element: { elementRef: 'x'.repeat(PREVIEW_LIMITS.maxElementRefChars + 1) } } },
    ]) {
      assert.equal(acceptWorkspacePreviewMessage({ ...event, ...changed }, bindingData, sourceWindow), null);
    }
    assert.equal(previewElementMetadata({
      getAttribute: (name) => name === 'data-aithema-ref' ? 'x'.repeat(257) : '',
    }), null);
    assert.throws(() => normalizePreviewElement({ elementRef: 'bad\nref' }), /limits/);
  });
});

describe('authenticated unapproved preview feedback', () => {
  it('makes no durable change before Submit, persists bounded provenance, and never approves', async () => {
    class CapturingProvider extends MockLlmProvider {
      async *streamChat(request) {
        this.chatRequest = request;
        yield* super.streamChat(request);
      }

      async understand(request) {
        this.understandingRequest = request;
        return super.understand(request);
      }
    }
    const provider = new CapturingProvider();
    const { store, controller, project } = setup(provider);
    try {
      const capability = controller.previewCapability(reviewer, project.project_ref);
      const before = controller.loadProject(reviewer, project.project_ref);
      assert.equal(before.revision, project.revision);
      assert.deepEqual(before.preview_feedback, []);
      assert.deepEqual(before.transcript, []);

      const result = await controller.submitPreviewFeedback(submission(capability, {
        message: 'Make <Save> clearer; do not execute anything.',
        elementLabel: '</textarea><script>alert(1)</script>',
      }));
      assert.equal(result.status, 'complete');
      assert.equal(currentBaseline(result.project.stream), null);
      assert.ok(pendingProposalList(result.project.stream).length > 0);
      const user = result.project.transcript.find((entry) => entry.role === 'user');
      assert.equal(user.content, 'Make <Save> clearer; do not execute anything.');
      assert.equal(user.provenance.source, 'preview_feedback');
      assert.equal(user.provenance.artifact_revision, capability.artifactRevision);
      assert.equal(result.project.preview_feedback.length, 1);
      assert.deepEqual(
        result.project.preview_feedback[0].proposal_refs,
        result.proposals_created,
      );
      assert.equal(result.project.preview_feedback[0].status, 'complete');
      const providerInput = provider.chatRequest.messages.filter((entry) => entry.role === 'user').at(-1).content;
      assert.match(providerInput, /Untrusted preview element reference/);
      assert.match(providerInput, /artifact:abc123/);
      assert.match(providerInput, /hero\.primary-action/);
      assert.match(providerInput, /Make <Save> clearer/);
      assert.doesNotMatch(providerInput, /preview\.example\.invalid/);
      assert.match(
        provider.understandingRequest.messages.filter((entry) => entry.role === 'user').at(-1).content,
        /hero\.primary-action/,
      );

      const html = renderWorkspacePage({
        labelledDemo: true,
        providerLive: false,
        providerId: 'mock',
        publicBasePath: '/aithema',
        actor: reviewer,
        projects: [result.project],
        project: result.project,
        previewCapability: controller.previewCapability(reviewer, project.project_ref),
        revisionReview: controller.reviewPending(reviewer, project.project_ref),
        flowState: null,
      });
      assert.match(html, /action="\/aithema\/projects\/[^\"]+\/preview-feedback"/);
      assert.match(html, /src="\/aithema\/workspace-preview-feedback\.js"/);
      assert.match(html, /src="https:\/\/preview\.example\.invalid\/build\/abc123\/index\.html\?mode=review"/);
      assert.match(html, /Make &lt;Save&gt; clearer/);
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
      assert.match(html, /Selection only prepares a draft/);
    } finally {
      store.close();
    }
  });

  it('rejects revoked access, stale project revisions, rebinds, browser overrides, and oversized refs', async () => {
    const { store, previews, controller, project } = setup();
    try {
      const mapped = { ...reviewer, subject: 'mapped', projects: [project.project_ref] };
      const mappedCap = controller.previewCapability(mapped, project.project_ref);
      await assert.rejects(
        () => controller.submitPreviewFeedback(submission(mappedCap, {
          actor: { ...mapped, projects: [] },
          projectRef: project.project_ref,
        })),
        /not a member/,
      );
      assert.equal(controller.loadProject(reviewer, project.project_ref).revision, project.revision);

      const overrideCap = controller.previewCapability(reviewer, project.project_ref);
      await assert.rejects(
        () => controller.submitPreviewFeedback(submission(overrideCap, {
          browserBody: { baseUrl: 'https://evil.example/v1' },
        })),
        /must not supply provider endpoints/,
      );
      assert.equal(controller.loadProject(reviewer, project.project_ref).preview_feedback.length, 0);

      const reboundCap = controller.previewCapability(reviewer, project.project_ref);
      previews.replace([binding(project.project_ref, 'artifact:new')]);
      await assert.rejects(
        () => controller.submitPreviewFeedback(submission(reboundCap)),
        /expired|changed/,
      );

      const staleCap = controller.previewCapability(reviewer, project.project_ref);
      await controller.submitTurn({
        actor: reviewer,
        projectRef: project.project_ref,
        message: 'A concurrent human edit.',
        turnId: 'turn:concurrent',
      });
      await assert.rejects(
        () => controller.submitPreviewFeedback(submission(staleCap)),
        /revision conflict/,
      );

      const largeCap = controller.previewCapability(reviewer, project.project_ref);
      await assert.rejects(
        () => controller.submitPreviewFeedback(submission(largeCap, {
          expectedRevision: controller.loadProject(reviewer, project.project_ref).revision,
          elementRef: 'x'.repeat(PREVIEW_LIMITS.maxElementRefChars + 1),
        })),
        /limits/,
      );
    } finally {
      store.close();
    }
  });

  it('keeps incomplete provider output out of proposals and requires a fresh explicit retry', async () => {
    class RetryProvider extends MockLlmProvider {
      constructor() {
        super();
        this.attempts = 0;
      }

      async *streamChat(request) {
        this.attempts += 1;
        if (this.attempts === 1) {
          yield 'partial';
          const error = new Error('provider stream cancelled');
          error.name = 'AbortError';
          throw error;
        }
        yield* super.streamChat(request);
      }
    }

    const provider = new RetryProvider();
    const { store, controller, project } = setup(provider);
    try {
      const firstCap = controller.previewCapability(reviewer, project.project_ref);
      const first = await controller.submitPreviewFeedback(submission(firstCap));
      assert.equal(first.status, 'incomplete');
      assert.deepEqual(first.proposals_created, []);
      let loaded = controller.loadProject(reviewer, project.project_ref);
      assert.equal(loaded.preview_feedback[0].status, 'incomplete');
      assert.deepEqual(loaded.preview_feedback[0].proposal_refs, []);
      assert.equal(pendingProposalList(loaded.stream).length, 0);

      const retryCap = controller.previewCapability(reviewer, project.project_ref);
      const retry = await controller.submitPreviewFeedback(submission(retryCap, {
        expectedRevision: loaded.revision,
      }));
      assert.equal(retry.status, 'complete');
      assert.equal(provider.attempts, 2);
      loaded = controller.loadProject(reviewer, project.project_ref);
      assert.equal(loaded.preview_feedback.length, 2);
      assert.deepEqual(loaded.preview_feedback.map((item) => item.status), ['incomplete', 'complete']);
      assert.ok(loaded.preview_feedback[1].proposal_refs.length > 0);
      assert.equal(currentBaseline(loaded.stream), null);
    } finally {
      store.close();
    }
  });
});

describe('preview feedback CSRF boundary', () => {
  it('requires the configured exact origin for cookie mutations', () => {
    const requestUrl = new URL('http://127.0.0.1:8787/aithema/projects/p/preview-feedback');
    assert.doesNotThrow(() => assertSameOriginMutation(
      { headers: { origin: 'https://workspace.example.invalid', cookie: 'sid=x' } },
      requestUrl,
      'https://workspace.example.invalid',
    ));
    assert.throws(() => assertSameOriginMutation(
      { headers: { origin: 'https://preview.example.invalid', cookie: 'sid=x' } },
      requestUrl,
      'https://workspace.example.invalid',
    ), /origin is not allowed/);
    assert.throws(() => assertSameOriginMutation(
      { headers: { cookie: 'aithema_demo=x' } },
      requestUrl,
      undefined,
    ), /origin is not allowed/);
  });
});
