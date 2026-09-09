import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { currentBaseline } from '../lib/stream.js';
import { createWorkspaceServer } from '../workspace/server.js';

const MOUNT = '/aithema';
const PUBLIC_ORIGIN = 'https://workspace.example.invalid';
const reviewer = Object.freeze({
  subject: 'demo-reviewer',
  party_ref: 'party:demo-reviewer',
  actor_kind: 'human',
  roles: Object.freeze(['requirements_approver', 'delivery_party']),
  projects: Object.freeze([]),
});

const config = {
  mode: 'test',
  listenHost: '127.0.0.1',
  listenPort: 0,
  publicOrigin: PUBLIC_ORIGIN,
  publicBasePath: MOUNT,
  defaultProvider: 'mock',
  identity: {
    kind: 'demo',
    demoHmacSecret: 'preview-http-fixture-not-for-production',
    defaultSubject: reviewer.subject,
    memberships: [reviewer],
  },
  providers: { mock: { kind: 'mock' } },
};

function cookieNamed(response, name) {
  const lines = response.headers.getSetCookie?.() ?? [];
  return lines.find((line) => line.startsWith(`${name}=`))?.split(';')[0] ?? '';
}

function inputValue(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function feedbackBody(html, overrides = {}) {
  return new URLSearchParams({
    expected_revision: inputValue(html, 'expected_revision'),
    preview_nonce: inputValue(html, 'preview_nonce'),
    turn_id: inputValue(html, 'turn_id'),
    binding_key: inputValue(html, 'binding_key'),
    artifact_revision: inputValue(html, 'artifact_revision'),
    element_ref: 'checkout.primary',
    element_label: '<Primary checkout>',
    message: 'Clarify the checkout action.',
    ...overrides,
  });
}

describe('preview feedback HTTP boundary', () => {
  it('preserves the native mount and rejects CSRF, forged artifacts, and stale rebinds before explicit Submit', async () => {
    const workspace = createWorkspaceServer(config);
    const { url } = await workspace.listen();
    try {
      const login = await fetch(`${url}${MOUNT}/session/demo`, {
        method: 'POST',
        headers: {
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ subject: reviewer.subject }),
        redirect: 'manual',
      });
      assert.equal(login.status, 303);
      const cookie = cookieNamed(login, 'aithema_demo');
      const created = await fetch(`${url}${MOUNT}/projects`, {
        method: 'POST',
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ title: 'Bound preview', project_kinds: 'iteration' }),
        redirect: 'manual',
      });
      const location = created.headers.get('location');
      assert.match(location, /^\/aithema\/projects\//);
      const projectRef = decodeURIComponent(location.split('/').at(-1));
      workspace.replacePreviewBindings([{
        projectRef,
        artifactRevision: 'artifact:one',
        previewUrl: 'https://preview.example.invalid/build/one/index.html?review=1',
      }]);

      const page = await fetch(`${url}${location}`, { headers: { cookie } });
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/preview\.example\.invalid/);
      assert.match(html, /action="\/aithema\/projects\/[^\"]+\/preview-feedback"/);
      assert.match(html, /src="\/aithema\/workspace-preview-feedback\.js"/);
      assert.match(html, /src="https:\/\/preview\.example\.invalid\/build\/one\/index\.html\?review=1"/);
      assert.equal(workspace.controller.loadProject(reviewer, projectRef).revision, 1);
      assert.deepEqual(workspace.controller.loadProject(reviewer, projectRef).preview_feedback, []);

      const wrongOrigin = await fetch(`${url}${MOUNT}/projects/${encodeURIComponent(projectRef)}/preview-feedback`, {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://preview.example.invalid',
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: feedbackBody(html),
      });
      assert.equal(wrongOrigin.status, 403);
      assert.equal(workspace.controller.loadProject(reviewer, projectRef).revision, 1);

      workspace.replacePreviewBindings([{
        projectRef,
        artifactRevision: 'artifact:two',
        previewUrl: 'https://preview.example.invalid/build/two/index.html',
      }]);
      const stale = await fetch(`${url}${MOUNT}/projects/${encodeURIComponent(projectRef)}/preview-feedback`, {
        method: 'POST',
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: feedbackBody(html),
      });
      assert.equal(stale.status, 409);
      assert.equal(workspace.controller.loadProject(reviewer, projectRef).revision, 1);

      const refreshedHtml = await (await fetch(`${url}${location}`, { headers: { cookie } })).text();
      const forged = await fetch(`${url}${MOUNT}/projects/${encodeURIComponent(projectRef)}/preview-feedback`, {
        method: 'POST',
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: feedbackBody(refreshedHtml, { artifact_revision: 'artifact:browser-choice' }),
      });
      assert.equal(forged.status, 409);
      assert.equal(workspace.controller.loadProject(reviewer, projectRef).revision, 1);

      const submitted = await fetch(`${url}${MOUNT}/projects/${encodeURIComponent(projectRef)}/preview-feedback`, {
        method: 'POST',
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: feedbackBody(refreshedHtml),
      });
      assert.equal(submitted.status, 200);
      const result = await submitted.json();
      assert.equal(result.status, 'complete');
      assert.ok(result.proposals_created.length > 0);
      const stored = workspace.controller.loadProject(reviewer, projectRef);
      assert.equal(stored.preview_feedback.length, 1);
      assert.equal(stored.preview_feedback[0].artifact_revision, 'artifact:two');
      assert.equal(stored.preview_feedback[0].element_ref, 'checkout.primary');
      assert.equal(stored.preview_feedback[0].human_text, 'Clarify the checkout action.');
      assert.deepEqual(stored.preview_feedback[0].proposal_refs, result.proposals_created);
      assert.equal(currentBaseline(stored.stream), null);
    } finally {
      await workspace.close();
    }
  });
});
