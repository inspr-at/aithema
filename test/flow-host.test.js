import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLOW_SHELL_TARBALL_SHA256,
  FLOW_SHELL_TARBALL_URL,
  FLOW_SHELL_VERSION,
  createWorkspaceServer,
  resolveFlowStaticAsset,
} from '../workspace/index.js';

const demoConfig = {
  mode: 'test',
  listenHost: '127.0.0.1',
  listenPort: 0,
  defaultProvider: 'mock',
  identity: {
    kind: 'demo',
    demoHmacSecret: 'demo-hmac-secret-not-for-production',
    defaultSubject: 'demo-reviewer',
    memberships: [
      {
        subject: 'demo-reviewer',
        party_ref: 'party:demo-reviewer',
        actor_kind: 'human',
        roles: ['requirements_approver', 'delivery_party'],
        projects: [],
      },
      {
        subject: 'demo-agent',
        party_ref: 'party:demo-agent',
        actor_kind: 'agent',
        roles: ['delivery_party'],
        projects: [],
      },
      {
        subject: 'demo-outsider',
        party_ref: 'party:demo-outsider',
        actor_kind: 'human',
        roles: ['delivery_party'],
        projects: [],
      },
    ],
  },
  providers: { mock: { kind: 'mock' } },
};

async function start(config = demoConfig) {
  const workspace = createWorkspaceServer(config);
  const { url } = await workspace.listen();
  return { workspace, url };
}

function cookieFrom(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  const line = header.find((item) => item.startsWith('aithema_demo='));
  return line ? line.split(';')[0] : '';
}

async function demoSession(url, subject) {
  const response = await fetch(`${url}/session/demo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({ subject }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function createProject(url, cookie, title = 'Flow host project') {
  const response = await fetch(`${url}/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({
      title,
      project_kinds: 'new_product',
    }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return response.headers.get('location');
}

function originHeaders(url, cookie, extra = {}) {
  return {
    cookie,
    origin: new URL(url).origin,
    accept: 'application/json',
    'content-type': 'application/json',
    ...extra,
  };
}

function flowBinding(context, overrides = {}) {
  return {
    status: 'present',
    principalRef: context.principal_ref,
    projectRef: context.project_ref,
    actorKind: context.actor_kind,
    bindingRef: context.binding_ref,
    contextRevision: context.context_revision,
    issuedAt: context.issued_at,
    expiresAt: context.expires_at,
    freshUntil: context.fresh_until,
    ...overrides,
  };
}

function walkForbidden(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkForbidden(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /demo-reviewer|demo-agent|jwt-reviewer|party:jwt-reviewer/i, path);
      assert.doesNotMatch(value, /@/, path);
      assert.doesNotMatch(value, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, path);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /token|secret|cookie|email|session|^subject$|^sub$|^role$|^roles$/i, path);
    walkForbidden(child, `${path}.${key}`);
  }
}

function signedJwt() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'flow';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'flow' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.test',
    aud: 'aithema',
    sub: 'jwt-reviewer',
    exp: now + 120,
    iat: now,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), pair.privateKey).toString('base64url');
  return {
    token: `${head}.${payload}.${signature}`,
    jwk,
  };
}

describe('Flow workspace host', () => {
  it('pins the independently verified Flow 0.1.4 GitHub runtime tarball', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, '0.5.0');
    assert.equal(pkg.dependencies['@inspr/flow-shell'], FLOW_SHELL_TARBALL_URL);
    const entry = lock.packages['node_modules/@inspr/flow-shell'];
    assert.equal(entry.version, FLOW_SHELL_VERSION);
    assert.equal(entry.resolved, FLOW_SHELL_TARBALL_URL);
    assert.match(entry.integrity, /^sha512-/);
    const hex = Buffer.from(entry.integrity.slice('sha512-'.length), 'base64').toString('hex');
    const cache = execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).trim();
    const cached = join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    const sha256 = createHash('sha256').update(readFileSync(cached)).digest('hex');
    assert.equal(sha256, FLOW_SHELL_TARBALL_SHA256);
  });

  it('serves closed Flow package assets and refuses traversal or secret paths', async () => {
    const { workspace, url } = await start();
    try {
      const js = await fetch(`${url}/flow-shell/inspr-flow-shell.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/);
      assert.match(await js.text(), /inspr-flow-shell/);

      const layout = await fetch(`${url}/flow-shell/host-layout.js`);
      assert.equal(layout.status, 200);
      assert.match(layout.headers.get('content-type'), /javascript/);
      assert.match(await layout.text(), /LAYOUT_MODES/);

      const css = await fetch(`${url}/flow-shell/flow-shell.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);

      const svg = await fetch(`${url}/flow-shell/assets/inspr-logo.svg`);
      assert.equal(svg.status, 200);
      assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
      assert.match(await svg.text(), /INSPR/);

      const host = await fetch(`${url}/workspace-flow-host.js`);
      assert.equal(host.status, 200);
      const hostText = await host.text();
      assert.match(hostText, /flow-intent/);
      assert.match(hostText, /from '\.\/flow-shell\/identity\.js'/);
      assert.doesNotMatch(hostText, /from '\/flow-shell\//);

      for (const path of [
        '/flow-shell/node_modules/foo',
        '/flow-shell/.env',
        '/flow-shell/assets/.age',
        '/flow-shell/package.json',
        '/flow-shell/../package.json',
        '/workspace-flow-host.js/../server.js',
      ]) {
        const denied = await fetch(`${url}${path}`);
        assert.notEqual(denied.status, 200, path);
        assert.equal(resolveFlowStaticAsset(path), null, path);
      }
    } finally {
      await workspace.close();
    }
  });

  it('issues opaque labelled demo context and keeps the existing workspace usable', async () => {
    const { workspace, url } = await start();
    try {
      const unauthorized = await fetch(`${url}/flow-state`);
      assert.equal(unauthorized.status, 401);

      const cookie = await demoSession(url, 'demo-reviewer');
      const home = await fetch(url, { headers: { cookie } });
      const homeHtml = await home.text();
      assert.match(homeHtml, /Demo \/ mock/i);
      assert.match(homeHtml, /<inspr-flow-shell /);
      assert.match(homeHtml, /layout-mode="bounded"/);
      assert.match(homeHtml, /logo-src="\/flow-shell\/assets\/inspr-logo.svg"/);
      assert.match(homeHtml, /workspace-flow-host\.js/);
      assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
      assert.match(home.headers.get('content-security-policy'), /img-src 'self'/);
      assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);

      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const page = await fetch(projectUrl, { headers: { cookie } });
      const html = await page.text();
      assert.match(html, /Focused next question|No focused next question/);
      assert.match(html, /Pending proposals/);
      assert.match(html, /id="workspace-compose"/);
      assert.doesNotMatch(html, /Start delivery/);

      const state = await (await fetch(`${projectUrl}/flow-state`, { headers: { cookie } })).json();
      walkForbidden(state);
      assert.equal(state.identityContext.principal_kind, 'local_host');
      assert.equal(state.identityContext.actor_kind, 'human');
      assert.equal(state.identityContext.organization_ref, null);
      assert.equal(state.identityContext.issuer_descriptor, undefined);
      assert.match(state.identityContext.display.fixture_label, /No live identity/i);
      assert.match(state.header.instanceLabel, /labelled demo/i);
      assert.equal(state.prerequisites.pharosTarget.status, 'unknown');
      assert.equal(state.prerequisites.janusGate.status, 'unknown');
      assert.equal(state.prerequisites.deployArtifact.status, 'unknown');
      assert.equal(state.prerequisites.requirementsBaseline.status, 'unknown');
      assert.equal(state.delivery.stageEvidence[0], 'unknown');
      assert.equal(typeof state.progress.overall.forecast.percent_complete, 'number');
      assert.ok(state.progress.overall.forecast.estimated_finish);
      assert.equal(state.progress.overall.forecast.kind, 'educated_guess');
    } finally {
      await workspace.close();
    }
  });

  it('maps an approved baseline honestly and never fabricates Pharos or Janus evidence', async () => {
    const { workspace, url } = await start();
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie, 'Baseline mapping');
      const projectUrl = new URL(location, url);
      await fetch(`${projectUrl}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: 'Need a recorded baseline' }),
        redirect: 'manual',
      });
      const before = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const refs = [...before.matchAll(/name="proposal_refs" value="([^"]+)"/g)].map((match) => match[1]);
      const expected = before.match(/name="expected_revision" value="(\d+)"/)[1];
      await fetch(`${projectUrl}/review`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams([
          ['action', 'approve'],
          ['expected_revision', expected],
          ...refs.map((ref) => ['proposal_refs', ref]),
        ]),
        redirect: 'manual',
      });
      const state = await (await fetch(`${projectUrl}/flow-state`, { headers: { cookie } })).json();
      walkForbidden(state);
      assert.equal(state.prerequisites.requirementsBaseline.status, 'pass');
      assert.equal(state.delivery.stageEvidence[0], 'performed');
      assert.equal(state.delivery.stageEvidence[1], 'unknown');
      assert.equal(state.delivery.stageEvidence[2], 'unknown');
      assert.equal(state.delivery.stageEvidence[3], 'unknown');
      assert.equal(state.prerequisites.pharosTarget.status, 'unknown');
      assert.equal(state.prerequisites.pharosTarget.targetRef, null);
      assert.equal(state.prerequisites.janusGate.status, 'unknown');
      assert.match(state.prerequisites.pharosTarget.message, /not reported here|not available/i);
      assert.equal(state.delivery.status, 'draft');
      assert.ok(state.delivery.baselineRef);
      assert.match(state.delivery.baselineDigest, /^sha256:[a-f0-9]{64}$/);
    } finally {
      await workspace.close();
    }
  });

  it('revalidates changed, wrong-project, and agent start intents without executing delivery', async () => {
    const { workspace, url } = await start();
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const first = await createProject(url, cookie, 'Project one');
      const second = await createProject(url, cookie, 'Project two');
      const projectA = new URL(first, url);
      const projectB = new URL(second, url);
      const stateA = await (await fetch(`${projectA}/flow-state`, { headers: { cookie } })).json();
      const stateB = await (await fetch(`${projectB}/flow-state`, { headers: { cookie } })).json();

      const wrongProject = await fetch(`${projectB}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:start-intent',
          identity: flowBinding(stateA.identityContext),
        }),
      });
      assert.equal(wrongProject.status, 409);
      const wrongBody = await wrongProject.json();
      assert.equal(wrongBody.executed, false);
      assert.match(wrongBody.error, /different project|does not match/i);

      await fetch(`${projectA}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: 'Change the context revision' }),
        redirect: 'manual',
      });
      const stale = await fetch(`${projectA}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:review-batch',
          identity: flowBinding(stateA.identityContext),
        }),
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).executed, false);

      const current = await (await fetch(`${projectA}/flow-state`, { headers: { cookie } })).json();
      const expired = await fetch(`${projectA}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:start-intent',
          identity: flowBinding(current.identityContext, {
            issuedAt: '2020-01-01T00:00:00.000Z',
            expiresAt: '2020-01-01T01:00:00.000Z',
            freshUntil: '2020-01-01T00:10:00.000Z',
          }),
        }),
      });
      assert.equal(expired.status, 409);
      assert.match((await expired.json()).error, /expired|stale/i);

      const start = await fetch(`${projectA}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:start-intent',
          identity: flowBinding(current.identityContext),
        }),
      });
      assert.equal(start.status, 200);
      const started = await start.json();
      assert.equal(started.executed, false);
      assert.equal(started.unsupported, true);
      assert.match(started.reason, /not integrated/i);
      assert.doesNotMatch(started.notice, /delivery succeeded|started delivery/i);

      const review = await fetch(`${projectA}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:review-batch',
          identity: flowBinding(current.identityContext),
        }),
      });
      assert.equal(review.status, 200);
      const reviewed = await review.json();
      assert.equal(reviewed.executed, false);
      assert.equal(reviewed.routed, 'workspace-review');
      assert.match(reviewed.location, /#workspace-review/);

      const agentCookie = await demoSession(url, 'demo-agent');
      const agentLocation = await createProject(url, agentCookie, 'Agent project');
      const agentUrl = new URL(agentLocation, url);
      const agentState = await (await fetch(`${agentUrl}/flow-state`, { headers: { cookie: agentCookie } })).json();
      assert.equal(agentState.identityContext.actor_kind, 'agent');
      const agentStart = await fetch(`${agentUrl}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, agentCookie),
        body: JSON.stringify({
          type: 'flow:start-intent',
          identity: flowBinding(agentState.identityContext),
        }),
      });
      assert.equal(agentStart.status, 403);
      assert.equal((await agentStart.json()).executed, false);

      const outsiderCookie = await demoSession(url, 'demo-outsider');
      const outsider = await fetch(`${projectA}/flow-state`, { headers: { cookie: outsiderCookie } });
      assert.equal(outsider.status, 403);

      assert.equal(stateB.identityContext.project_ref !== stateA.identityContext.project_ref, true);
    } finally {
      await workspace.close();
    }
  });

  it('allows same-origin Flow intent fetch under connect-src self without opening default-src', async () => {
    const { workspace, url } = await start();
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie, 'CSP review batch');
      const projectUrl = new URL(location, url);
      const page = await fetch(projectUrl, { headers: { cookie } });
      assert.equal(page.status, 200);
      const csp = page.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /form-action 'self'/);
      assert.doesNotMatch(csp, /connect-src [^;]*(?:\*|https:|http:)/);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

      const state = await (await fetch(`${projectUrl}/flow-state`, { headers: { cookie } })).json();
      const review = await fetch(`${projectUrl}/flow-intents`, {
        method: 'POST',
        headers: originHeaders(url, cookie),
        body: JSON.stringify({
          type: 'flow:review-batch',
          identity: flowBinding(state.identityContext),
        }),
      });
      assert.equal(review.status, 200);
      const reviewed = await review.json();
      assert.equal(reviewed.executed, false);
      assert.equal(reviewed.routed, 'workspace-review');
      const reviewCsp = review.headers.get('content-security-policy') ?? '';
      assert.match(reviewCsp, /connect-src 'self'/);
      assert.match(reviewCsp, /default-src 'none'/);
    } finally {
      await workspace.close();
    }
  });

  it('labels OIDC-backed host context without a permissive production login', async () => {
    const { token, jwk } = signedJwt();
    const { workspace, url } = await start({
      mode: 'production',
      listenHost: '127.0.0.1',
      listenPort: 0,
      dataDir: ':memory:',
      defaultProvider: 'local',
      defaultModel: 'fixture-model',
      identity: {
        kind: 'jwt-jwks',
        issuer: 'https://auth.test',
        audience: 'aithema',
        jwks_uri: 'http://127.0.0.1:1/jwks',
        jwks: { keys: [jwk] },
        memberships: [{
          subject: 'jwt-reviewer',
          party_ref: 'party:jwt-reviewer',
          actor_kind: 'human',
          roles: ['requirements_approver', 'delivery_party'],
          projects: [],
        }],
      },
      providers: {
        local: {
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          modelId: 'fixture-model',
          allowedModels: ['fixture-model'],
        },
      },
    });
    try {
      const page = await fetch(url);
      assert.equal(page.status, 401);
      assert.match(await page.text(), /OIDC/);
      assert.doesNotMatch(await (await fetch(url)).text(), /Continue with labelled demo identity/);

      const authorized = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(authorized.status, 200);
      const html = await authorized.text();
      assert.doesNotMatch(html, /Demo \/ mock/i);
      assert.match(html, /<inspr-flow-shell /);
      assert.match(html, /party:jwt-reviewer/);

      const created = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ title: 'OIDC project', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(created.status, 303);
      const projectUrl = new URL(created.headers.get('location'), url);
      const state = await (await fetch(`${projectUrl}/flow-state`, {
        headers: { authorization: `Bearer ${token}` },
      })).json();
      walkForbidden(state);
      assert.equal(state.identityContext.principal_kind, 'oidc_backed');
      assert.equal(state.identityContext.issuer_descriptor.kind, 'verified_issuer_descriptor');
      assert.match(state.identityContext.issuer_descriptor.issuer_ref, /^aithema:iss-/);
      assert.doesNotMatch(JSON.stringify(state), /auth\.test/);
      assert.match(state.identityContext.display.fixture_label, /Not live identity/i);
      assert.doesNotMatch(state.header.instanceLabel, /demo/i);
    } finally {
      await workspace.close();
    }
  });
});
