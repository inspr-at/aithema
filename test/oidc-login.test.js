import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceServer } from '../workspace/index.js';
import { normalizeWorkspaceConfig } from '../workspace/config.js';
import { allowlistedReturnPath, LOGIN_COOKIE_NAME, MAX_LOGIN_TRANSACTIONS, SESSION_COOKIE_NAME } from '../runtime/oidc-login.js';
import { startSyntheticOidcIssuer } from './fixtures/synthetic-oidc.mjs';

const memberships = [
  {
    subject: 'user-alice',
    party_ref: 'party:alice',
    actor_kind: 'human',
    roles: ['requirements_approver', 'delivery_party'],
    projects: [],
  },
  {
    subject: 'agent-bot',
    party_ref: 'party:agent',
    actor_kind: 'agent',
    roles: ['delivery_party'],
    projects: [],
  },
];

function productionConfig(issuer, extra = {}) {
  return {
    mode: 'production',
    listenHost: '127.0.0.1',
    listenPort: 0,
    dataDir: ':memory:',
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
        session_ttl_seconds: extra.sessionTtlSeconds ?? 3600,
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

async function startWorkspace(issuer, extra = {}) {
  const workspace = createWorkspaceServer(productionConfig(issuer, extra), extra.serverOptions);
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

async function completeBrowserLogin(url, { returnPath } = {}) {
  const loginUrl = returnPath ? `${url}/login?return=${encodeURIComponent(returnPath)}` : `${url}/login`;
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
    loginCookie,
    callbackUrl,
    callback,
    cookie: cookieNamed(callback, SESSION_COOKIE_NAME),
    location: callback.headers.get('location'),
  };
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, /id_token|access_token|client_secret|code_verifier|synthetic-client-secret/i);
}

describe('OIDC browser login', () => {
  it('allowlists only local return paths', () => {
    assert.equal(allowlistedReturnPath('/projects/abc'), '/projects/abc');
    assert.equal(allowlistedReturnPath('https://evil.example'), '/');
    assert.equal(allowlistedReturnPath('//evil.example'), '/');
    assert.equal(allowlistedReturnPath('/\\evil.example'), '/');
    assert.equal(allowlistedReturnPath('/%2f%2fevil.example'), '/');
    assert.equal(allowlistedReturnPath('/login\r\nLocation: https://evil.example'), '/');
  });

  it('fails closed on incomplete or demo browser login config', () => {
    const base = {
      mode: 'production',
      dataDir: ':memory:',
      defaultProvider: 'local',
      identity: {
        kind: 'jwt-jwks',
        issuer: 'https://auth.example.invalid',
        audience: 'aithema',
        jwks_uri: 'https://auth.example.invalid/jwks',
        memberships,
        browser_login: {},
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
    assert.throws(() => normalizeWorkspaceConfig(base), /client_id is required/);
    assert.throws(
      () => normalizeWorkspaceConfig({
        ...base,
        identity: {
          ...base.identity,
          issuer: 'http://evil.example',
          browser_login: { client_id: 'workspace' },
        },
      }),
      /must be https/,
    );
    assert.throws(
      () => normalizeWorkspaceConfig({
        mode: 'demo',
        listenHost: '127.0.0.1',
        identity: {
          kind: 'demo',
          defaultSubject: 'user-alice',
          memberships,
          browser_login: { client_id: 'workspace' },
        },
        providers: { mock: { kind: 'mock' } },
        defaultProvider: 'mock',
      }),
      /production-only/,
    );
  });

  it('signs in through a synthetic authorization-code PKCE issuer and maps operator membership', async () => {
    const issuer = await startSyntheticOidcIssuer();
    const { workspace, url } = await startWorkspace(issuer);
    try {
      const home = await fetch(url);
      assert.equal(home.status, 401);
      const homeText = await home.text();
      assert.match(homeText, /<a class="button" href="\/login">Sign in<\/a>/);
      assert.doesNotMatch(homeText, /<form[^>]*action="\/login"/i);
      assert.match(home.headers.get('content-security-policy') ?? '', /form-action 'self'/);
      assert.doesNotMatch(homeText, /Continue with labelled demo identity/);
      assertNoSecrets(homeText);

      const result = await completeBrowserLogin(url, { returnPath: '/projects/unused' });
      assert.match(result.authorizeUrl, /code_challenge_method=S256/);
      assert.match(result.authorizeUrl, /[?&]state=/);
      assert.match(result.authorizeUrl, /[?&]nonce=/);
      assert.equal(result.callback.status, 303);
      assert.equal(result.location, '/projects/unused');
      const flags = setCookieLine(result.callback, SESSION_COOKIE_NAME);
      assert.match(flags, /HttpOnly/i);
      assert.match(flags, /SameSite=Lax/i);
      assert.match(flags, /Path=\//i);
      assert.doesNotMatch(flags, /Secure/i);
      assert.match(result.cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));

      const signedIn = await fetch(url, { headers: { cookie: result.cookie } });
      assert.equal(signedIn.status, 200);
      const html = await signedIn.text();
      assert.match(html, /party:alice/);
      assert.match(html, /<form method="post" action="\/logout">/);
      assert.doesNotMatch(html, /Demo \/ mock/i);
      assertNoSecrets(html);

      const created = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: result.cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ title: 'OIDC session project', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(created.status, 303);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });

  it('rejects state, nonce, PKCE, issuer, audience, algorithm, replay, and login-CSRF failures', async () => {
    const issuer = await startSyntheticOidcIssuer();
    const { workspace, url } = await startWorkspace(issuer);
    try {
      const login = await fetch(`${url}/login`, { redirect: 'manual' });
      const loginCookie = cookieNamed(login, LOGIN_COOKIE_NAME);
      const forgedCallback = `${url}/oidc/callback?code=forged&state=forged`;
      const csrf = await fetch(forgedCallback, { redirect: 'manual' });
      assert.equal(csrf.status, 401);
      assert.match(await csrf.text(), /Sign-in could not be completed/);

      const wrongState = await fetch(`${url}/oidc/callback?code=x&state=other`, {
        headers: { cookie: loginCookie },
        redirect: 'manual',
      });
      assert.equal(wrongState.status, 401);
      assertNoSecrets(await wrongState.text());

      issuer.behavior.omitNonce = true;
      const nonceFail = await completeBrowserLogin(url);
      assert.equal(nonceFail.callback.status, 401);
      issuer.behavior.omitNonce = false;

      issuer.behavior.iss = 'https://evil.example';
      const issFail = await completeBrowserLogin(url);
      assert.equal(issFail.callback.status, 401);
      issuer.behavior.iss = undefined;

      issuer.behavior.aud = 'other-audience';
      const audFail = await completeBrowserLogin(url);
      assert.equal(audFail.callback.status, 401);
      issuer.behavior.aud = undefined;

      issuer.behavior.alg = 'none';
      const algFail = await completeBrowserLogin(url);
      assert.equal(algFail.callback.status, 401);
      issuer.behavior.alg = 'RS256';

      issuer.behavior.azp = 'attacker-client';
      issuer.behavior.extraAud = 'other-aud';
      const azpFail = await completeBrowserLogin(url);
      assert.equal(azpFail.callback.status, 401);
      issuer.behavior.azp = undefined;
      issuer.behavior.extraAud = undefined;

      const first = await completeBrowserLogin(url);
      assert.equal(first.callback.status, 303);
      const replay = await fetch(first.callbackUrl, {
        headers: { cookie: first.loginCookie },
        redirect: 'manual',
      });
      assert.equal(replay.status, 401);

      issuer.behavior.skipPkce = false;
      const pkceLogin = await fetch(`${url}/login`, { redirect: 'manual' });
      const pkceAuthorize = await fetch(pkceLogin.headers.get('location'), { redirect: 'manual' });
      const pkceCallback = new URL(pkceAuthorize.headers.get('location'));
      const code = pkceCallback.searchParams.get('code');
      const token = await fetch(`${issuer.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${url}/oidc/callback`,
          client_id: issuer.clientId,
          client_secret: issuer.clientSecret,
          code_verifier: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      });
      assert.equal(token.status, 400);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });

  it('denies unbound subjects, expires sessions, logs out, and ignores ID-token roles', async () => {
    const issuer = await startSyntheticOidcIssuer({ subject: 'unknown-person' });
    issuer.behavior.claims = { role: 'admin', actor_kind: 'human', email: 'stolen@example.invalid' };
    let now = Date.now();
    const { workspace, url } = await startWorkspace(issuer, {
      sessionTtlSeconds: 1,
      serverOptions: { now: () => now },
    });
    try {
      const unbound = await completeBrowserLogin(url);
      assert.equal(unbound.callback.status, 403);
      const denied = await unbound.callback.text();
      assert.match(denied, /not authorized/);
      assert.doesNotMatch(denied, /stolen@example/);
      assertNoSecrets(denied);

      issuer.behavior.subject = 'user-alice';
      const ok = await completeBrowserLogin(url);
      assert.equal(ok.callback.status, 303);
      const html = await (await fetch(url, { headers: { cookie: ok.cookie } })).text();
      assert.match(html, /party:alice/);
      assert.doesNotMatch(html, /stolen@example/);

      now += 2000;
      const expired = await fetch(url, { headers: { cookie: ok.cookie } });
      assert.equal(expired.status, 401);

      const again = await completeBrowserLogin(url);
      const logout = await fetch(`${url}/logout`, {
        method: 'POST',
        headers: {
          cookie: again.cookie,
          origin: new URL(url).origin,
        },
        redirect: 'manual',
      });
      assert.equal(logout.status, 200);
      assert.equal(logout.headers.get('location'), null);
      assert.match(logout.headers.get('content-security-policy') ?? '', /form-action 'self'/);
      const signedOut = await logout.text();
      assert.match(signedOut, /Signed out/);
      assert.match(signedOut, /<a class="button" href="\/login">Sign in<\/a>/);
      assert.doesNotMatch(signedOut, /<form[^>]*action="\/login"/i);
      assert.match(signedOut, new RegExp(`<a class="button" href="${issuer.issuer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/end-session`));
      assert.doesNotMatch(signedOut, /<form[^>]*action="http:\/\/127\.0\.0\.1/i);
      const afterLogout = await fetch(url, { headers: { cookie: again.cookie } });
      assert.equal(afterLogout.status, 401);

      const forgedOrigin = await fetch(`${url}/logout`, {
        method: 'POST',
        headers: {
          cookie: again.cookie,
          origin: 'http://evil.example',
        },
        redirect: 'manual',
      });
      assert.equal(forgedOrigin.status, 403);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });

  it('refuses malicious return URLs and keeps bearer JWT mode independent of browser sessions', async () => {
    const issuer = await startSyntheticOidcIssuer();
    const { workspace, url } = await startWorkspace(issuer);
    try {
      const evil = await completeBrowserLogin(url, { returnPath: 'https://evil.example/phish' });
      assert.equal(evil.callback.status, 303);
      assert.equal(evil.location, '/');

      const token = issuer.signGatewayJwt('user-alice');
      const bearer = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(bearer.status, 200);
      const bearerHtml = await bearer.text();
      assert.match(bearerHtml, /party:alice/);
      assert.doesNotMatch(bearerHtml, /Sign out/);
      assertNoSecrets(bearerHtml);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });

  it('sanitizes unavailable provider errors', async () => {
    const issuer = await startSyntheticOidcIssuer();
    issuer.behavior.failDiscovery = true;
    const { workspace, url } = await startWorkspace(issuer);
    try {
      const unavailable = await fetch(`${url}/login`, { redirect: 'manual' });
      assert.equal(unavailable.status, 502);
      const unavailableText = await unavailable.text();
      assert.match(unavailableText, /unavailable|Sign-in/i);
      assertNoSecrets(unavailableText);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });

  it('evicts the oldest pending login so unauthenticated /login cannot exhaust sign-in', async () => {
    const issuer = await startSyntheticOidcIssuer();
    const { workspace, url } = await startWorkspace(issuer);
    try {
      /** @type {{ cookie: string, authorizeUrl: string }[]} */
      const started = [];
      for (let index = 0; index < MAX_LOGIN_TRANSACTIONS + 1; index += 1) {
        const login = await fetch(`${url}/login`, { redirect: 'manual' });
        assert.equal(login.status, 303, `login ${index} should not be capacity-denied`);
        started.push({
          cookie: cookieNamed(login, LOGIN_COOKIE_NAME),
          authorizeUrl: login.headers.get('location'),
        });
      }

      const oldest = started[0];
      const oldestAuthorize = await fetch(oldest.authorizeUrl, { redirect: 'manual' });
      assert.equal(oldestAuthorize.status, 302);
      const oldestCallback = await fetch(oldestAuthorize.headers.get('location'), {
        headers: { cookie: oldest.cookie },
        redirect: 'manual',
      });
      assert.equal(oldestCallback.status, 401);

      const newest = started.at(-1);
      const newestAuthorize = await fetch(newest.authorizeUrl, { redirect: 'manual' });
      assert.equal(newestAuthorize.status, 302);
      const newestCallback = await fetch(newestAuthorize.headers.get('location'), {
        headers: { cookie: newest.cookie },
        redirect: 'manual',
      });
      assert.equal(newestCallback.status, 303);
      const sessionCookie = cookieNamed(newestCallback, SESSION_COOKIE_NAME);
      const home = await fetch(url, { headers: { cookie: sessionCookie } });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /party:alice/);
    } finally {
      await workspace.close();
      await issuer.close();
    }
  });
});
