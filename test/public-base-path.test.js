import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceServer, normalizeWorkspaceConfig } from '../workspace/index.js';
import {
  homePath,
  joinMountPath,
  normalizePublicBasePath,
  stripMountPath,
} from '../runtime/public-path.js';
import { allowlistedReturnPath, LOGIN_COOKIE_NAME, SESSION_COOKIE_NAME } from '../runtime/oidc-login.js';
import { startSyntheticOidcIssuer } from './fixtures/synthetic-oidc.mjs';

const MOUNT = '/aithema';

const memberships = [
  {
    subject: 'user-alice',
    party_ref: 'party:alice',
    actor_kind: 'human',
    roles: ['requirements_approver', 'delivery_party'],
    projects: [],
  },
  {
    subject: 'user-outsider',
    party_ref: 'party:outsider',
    actor_kind: 'human',
    roles: ['delivery_party'],
    projects: [],
  },
];

const demoConfig = {
  mode: 'test',
  listenHost: '127.0.0.1',
  listenPort: 0,
  publicBasePath: MOUNT,
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

function productionConfig(issuer, extra = {}) {
  return {
    mode: 'production',
    listenHost: '127.0.0.1',
    listenPort: 0,
    dataDir: ':memory:',
    publicBasePath: extra.publicBasePath ?? MOUNT,
    publicOrigin: extra.publicOrigin,
    defaultProvider: 'local',
    defaultModel: 'fixture-model',
    identity: {
      kind: 'jwt-jwks',
      issuer: issuer.issuer,
      audience: 'aithema',
      jwks_uri: `${issuer.issuer}/jwks`,
      jwks: issuer.jwks,
      memberships,
      browser_login: {
        client_id: issuer.clientId,
        client_secret: issuer.clientSecret,
        session_ttl_seconds: 3600,
        ...extra.browserLogin,
      },
    },
    providers: {
      local: {
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      },
    },
  };
}

async function start(config = demoConfig) {
  const workspace = createWorkspaceServer(config);
  const { url } = await workspace.listen();
  return { workspace, url };
}

function cookieNamed(response, name) {
  const header = response.headers.getSetCookie?.() ?? [];
  const line = header.find((item) => item.startsWith(`${name}=`));
  return line ? line.split(';')[0] : '';
}

function setCookieLine(response, name) {
  const header = response.headers.getSetCookie?.() ?? [];
  return header.find((item) => item.startsWith(`${name}=`)) ?? '';
}

async function demoSession(url, subject) {
  const response = await fetch(`${url}${MOUNT}/session/demo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({ subject }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), MOUNT);
  return cookieNamed(response, 'aithema_demo');
}

async function completeBrowserLogin(url, { returnPath, mount = MOUNT } = {}) {
  const loginUrl = returnPath
    ? `${url}${mount}/login?return=${encodeURIComponent(returnPath)}`
    : `${url}${mount}/login`;
  const login = await fetch(loginUrl, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const authorizeUrl = login.headers.get('location');
  const loginCookie = cookieNamed(login, LOGIN_COOKIE_NAME);
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const callbackUrl = authorize.headers.get('location');
  const callback = await fetch(callbackUrl, {
    headers: { cookie: loginCookie },
    redirect: 'manual',
  });
  return {
    login,
    authorizeUrl,
    callbackUrl,
    callback,
    cookie: cookieNamed(callback, SESSION_COOKIE_NAME),
    location: callback.headers.get('location'),
  };
}

describe('publicBasePath', () => {
  it('defaults to empty and rejects ambiguous or non-canonical mounts', () => {
    const base = {
      mode: 'test',
      listenHost: '127.0.0.1',
      defaultProvider: 'mock',
      identity: { kind: 'demo', memberships: demoConfig.identity.memberships },
      providers: { mock: { kind: 'mock' } },
    };
    assert.equal(normalizeWorkspaceConfig(base).publicBasePath, '');
    assert.equal(normalizePublicBasePath(undefined), '');
    assert.equal(normalizePublicBasePath(''), '');
    assert.equal(normalizePublicBasePath('/aithema'), '/aithema');
    assert.equal(normalizePublicBasePath('/aithema/workspace'), '/aithema/workspace');
    assert.equal(joinMountPath('', '/projects/x'), '/projects/x');
    assert.equal(joinMountPath('/aithema', '/projects/x'), '/aithema/projects/x');
    assert.equal(joinMountPath('/aithema', '/aithema/projects/x'), '/aithema/projects/x');
    assert.equal(joinMountPath('/aithema', '/'), '/aithema');
    assert.equal(stripMountPath('/aithema/projects/x', '/aithema'), '/projects/x');
    assert.equal(stripMountPath('/aithema', '/aithema'), '/');
    assert.equal(stripMountPath('/aithema-other', '/aithema'), null);
    assert.equal(stripMountPath('/', '/aithema'), null);
    assert.equal(homePath(''), '/');
    assert.equal(homePath('/aithema'), '/aithema');

    for (const value of [
      '/',
      '/aithema/',
      '//aithema',
      '/./aithema',
      '/../aithema',
      '/aithema/../x',
      '/aithema//x',
      '/aithema%2Ffoo',
      '/aithema\\foo',
      '/aithema?x',
      '/aithema#x',
      'aithema',
      '/aithema/foo bar',
      '/aithema/föo',
      '/.env',
      '/aithema/.age',
    ]) {
      assert.throws(() => normalizePublicBasePath(value), /publicBasePath/, value);
    }

    assert.equal(allowlistedReturnPath('/projects/abc?notice=keep', '/aithema'), '/aithema/projects/abc?notice=keep');
    assert.equal(allowlistedReturnPath('/aithema/projects/abc?notice=keep', '/aithema'), '/aithema/projects/abc?notice=keep');
    assert.equal(allowlistedReturnPath('https://evil.example', '/aithema'), '/aithema');
    assert.equal(allowlistedReturnPath('//evil.example', '/aithema'), '/aithema');
    assert.equal(allowlistedReturnPath('/aithema/../paimos', '/aithema'), '/aithema');
    assert.equal(allowlistedReturnPath('/projects/../login', ''), '/');
  });

  it('keeps publicOrigin origin-only and derives the exact prefixed callback', () => {
    const issuer = 'https://auth.example.invalid';
    const base = {
      mode: 'production',
      dataDir: ':memory:',
      publicOrigin: 'https://workspace.example.invalid',
      publicBasePath: '/aithema',
      defaultProvider: 'local',
      identity: {
        kind: 'jwt-jwks',
        issuer,
        audience: 'aithema',
        jwks_uri: `${issuer}/jwks`,
        memberships,
        browser_login: { client_id: 'workspace' },
      },
      providers: {
        local: {
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          modelId: 'm',
          allowedModels: ['m'],
        },
      },
    };
    const normalized = normalizeWorkspaceConfig(base);
    assert.equal(normalized.publicOrigin, 'https://workspace.example.invalid');
    assert.equal(normalized.publicBasePath, '/aithema');
    assert.equal(
      normalized.identity.browser_login.redirect_uri,
      'https://workspace.example.invalid/aithema/oidc/callback',
    );
    assert.equal(
      normalized.identity.browser_login.post_logout_redirect_uri,
      'https://workspace.example.invalid/aithema',
    );

    assert.throws(
      () => normalizeWorkspaceConfig({ ...base, publicOrigin: 'https://workspace.example.invalid/aithema' }),
      /origin only/,
    );
    assert.throws(
      () => normalizeWorkspaceConfig({
        ...base,
        identity: {
          ...base.identity,
          browser_login: {
            client_id: 'workspace',
            redirect_uri: 'https://workspace.example.invalid/oidc/callback',
          },
        },
      }),
      /\/aithema\/oidc\/callback/,
    );
  });

  it('serves prefixed demo routes and assets and rejects paths outside the mount', async () => {
    const { workspace, url } = await start();
    try {
      const root = await fetch(url);
      assert.equal(root.status, 404);
      const sibling = await fetch(`${url}/aithema-other`);
      assert.equal(sibling.status, 404);
      const glued = await fetch(`${url}/aithemax`);
      assert.equal(glued.status, 404);
      const unprefixedHealth = await fetch(`${url}/health`);
      assert.equal(unprefixedHealth.status, 404);
      const unprefixedAsset = await fetch(`${url}/flow-shell/inspr-flow-shell.js`);
      assert.equal(unprefixedAsset.status, 404);

      const spoofed = await fetch(`${url}/health`, {
        headers: { 'x-forwarded-prefix': MOUNT },
      });
      assert.equal(spoofed.status, 404);

      const health = await fetch(`${url}${MOUNT}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, ready: true });

      const js = await fetch(`${url}${MOUNT}/flow-shell/inspr-flow-shell.js`);
      assert.equal(js.status, 200);
      const host = await fetch(`${url}${MOUNT}/workspace-flow-host.js`);
      assert.equal(host.status, 200);
      assert.match(await host.text(), /from '\.\/flow-shell\/identity\.js'/);

      const cookie = await demoSession(url, 'demo-reviewer');
      const home = await fetch(`${url}${MOUNT}`, { headers: { cookie } });
      assert.equal(home.status, 200);
      const homeHtml = await home.text();
      assert.match(homeHtml, /name="aithema-public-base-path" content="\/aithema"/);
      assert.match(homeHtml, /logo-src="\/aithema\/flow-shell\/assets\/inspr-logo.svg"/);
      assert.match(homeHtml, /src="\/aithema\/workspace-flow-host\.js"/);
      assert.match(homeHtml, /action="\/aithema\/projects"/);
      assert.doesNotMatch(homeHtml, /action="\/projects"/);

      const created = await fetch(`${url}${MOUNT}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ title: 'Prefixed project', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(created.status, 303);
      const location = created.headers.get('location');
      assert.match(location, /^\/aithema\/projects\//);
      assert.doesNotMatch(location, /\/aithema\/aithema\//);

      const project = await fetch(new URL(location, url), { headers: { cookie } });
      assert.equal(project.status, 200);
      const projectHtml = await project.text();
      assert.match(projectHtml, /action="\/aithema\/projects\/[^"]+\/turns"/);

      const forged = await fetch(`${url}${MOUNT}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: 'http://evil.example',
        },
        body: new URLSearchParams({ title: 'Forged', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(forged.status, 403);

      const outsiderCookie = await demoSession(url, 'demo-outsider');
      const denied = await fetch(new URL(location, url), { headers: { cookie: outsiderCookie } });
      assert.equal(denied.status, 403);
    } finally {
      await workspace.close();
    }
  });

  it('runs prefixed production synthetic OIDC with exact callback, safe return query, and CSRF', async () => {
    const issuer = await startSyntheticOidcIssuer();
    const workspaceServer = createWorkspaceServer(productionConfig(issuer));
    const { url } = await workspaceServer.listen();
    try {
      const home = await fetch(`${url}${MOUNT}`);
      assert.equal(home.status, 401);
      const homeText = await home.text();
      assert.match(homeText, /href="\/aithema\/login"/);
      assert.doesNotMatch(homeText, /href="\/login"/);

      const result = await completeBrowserLogin(url, {
        returnPath: '/projects/unused?notice=keep',
      });
      const authorize = new URL(result.authorizeUrl);
      assert.equal(authorize.searchParams.get('redirect_uri'), `${url}${MOUNT}/oidc/callback`);
      assert.equal(new URL(result.callbackUrl).pathname, `${MOUNT}/oidc/callback`);
      assert.equal(result.callback.status, 303);
      assert.equal(result.location, '/aithema/projects/unused?notice=keep');
      const flags = setCookieLine(result.callback, SESSION_COOKIE_NAME);
      assert.match(flags, /Path=\//i);
      assert.doesNotMatch(flags, /Path=\/aithema/i);

      const signedIn = await fetch(`${url}${MOUNT}`, { headers: { cookie: result.cookie } });
      assert.equal(signedIn.status, 200);
      assert.match(await signedIn.text(), /action="\/aithema\/logout"/);

      const duplicate = await completeBrowserLogin(url, {
        returnPath: '/aithema/projects/already',
      });
      assert.equal(duplicate.location, '/aithema/projects/already');

      const evil = await completeBrowserLogin(url, { returnPath: 'https://evil.example/phish' });
      assert.equal(evil.location, '/aithema');

      const logout = await fetch(`${url}${MOUNT}/logout`, {
        method: 'POST',
        headers: {
          cookie: result.cookie,
          origin: new URL(url).origin,
        },
      });
      assert.equal(logout.status, 200);
      assert.match(await logout.text(), /Signed out/);
      const afterLogout = await fetch(`${url}${MOUNT}`, { headers: { cookie: result.cookie } });
      assert.equal(afterLogout.status, 401);

      const forgedLogout = await fetch(`${url}${MOUNT}/logout`, {
        method: 'POST',
        headers: {
          cookie: result.cookie,
          origin: 'http://evil.example',
        },
      });
      assert.equal(forgedLogout.status, 403);

      const rootLogin = await fetch(`${url}/login`, { redirect: 'manual' });
      assert.equal(rootLogin.status, 404);
      const rootCallback = await fetch(`${url}/oidc/callback`, { redirect: 'manual' });
      assert.equal(rootCallback.status, 404);
    } finally {
      await workspaceServer.close();
      await issuer.close();
    }
  });

  it('still maps operator membership after a prefixed callback and ignores unbound subjects', async () => {
    const issuer = await startSyntheticOidcIssuer({ subject: 'unknown-person' });
    const workspaceServer = createWorkspaceServer(productionConfig(issuer));
    const { url } = await workspaceServer.listen();
    try {
      const unbound = await completeBrowserLogin(url);
      assert.equal(unbound.callback.status, 403);
      issuer.behavior.subject = 'user-alice';
      const ok = await completeBrowserLogin(url);
      assert.equal(ok.callback.status, 303);
      const html = await (await fetch(`${url}${MOUNT}`, { headers: { cookie: ok.cookie } })).text();
      assert.match(html, /party:alice/);
    } finally {
      await workspaceServer.close();
      await issuer.close();
    }
  });
});
