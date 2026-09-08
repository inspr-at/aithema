/**
 * Opt-in production browser login via Authorization Code + S256 PKCE.
 * Protocol cryptography comes from openid-client; this module owns config
 * checks, bounded server sessions, and operator membership mapping.
 */

import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';

import { isLoopbackHost, validateVerifiedActor } from './identity.js';

export const SESSION_COOKIE_NAME = 'aithema_session';
export const LOGIN_COOKIE_NAME = 'aithema_login';
export const OIDC_LOGIN_PATH = '/login';
export const OIDC_CALLBACK_PATH = '/oidc/callback';
export const OIDC_LOGOUT_PATH = '/logout';
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MIN_SESSION_TTL_SECONDS = 1;
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const LOGIN_TTL_MS = 10 * 60 * 1000;
export const MAX_SESSIONS = 1024;
export const MAX_LOGIN_TRANSACTIONS = 256;
export const OIDC_FETCH_TIMEOUT_SECONDS = 5;
export const OIDC_MAX_RESPONSE_BYTES = 1_048_576;

const PUBLIC_SIGNIN_FAILED = 'Sign-in could not be completed.';
const PUBLIC_SIGNIN_UNAVAILABLE = 'Sign-in is unavailable. Try again later.';
const PUBLIC_UNAUTHORIZED = 'This identity is not authorized for the workspace.';
const PUBLIC_CAPACITY = 'Sign-in is temporarily unavailable.';

/**
 * @param {unknown} identityConfig
 * @param {{ publicOrigin?: string, listenHost?: string }} [context]
 */
export function normalizeBrowserLoginConfig(identityConfig, context = {}) {
  const raw = identityConfig?.browser_login;
  if (raw == null || raw === false) return undefined;
  if (raw === true || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('browser login configuration is incomplete');
  }

  const clientId = trimRequired(raw.client_id, 'browser login client_id');
  const clientSecret = optionalSecret(raw.client_secret);
  const issuer = trimRequired(identityConfig.issuer, 'identity issuer');
  if (raw.issuer != null && String(raw.issuer).trim() && String(raw.issuer).trim() !== issuer) {
    throw new Error('browser login issuer must match identity issuer');
  }
  const issuerUrl = trustedIssuerUrl(issuer);
  const audience = typeof raw.audience === 'string' && raw.audience.trim()
    ? raw.audience.trim()
    : clientId;

  const algorithms = identityConfig.algorithms?.length ? identityConfig.algorithms : ['RS256'];
  for (const alg of algorithms) {
    if (alg !== 'RS256' && alg !== 'ES256') {
      throw new Error('only RS256 and ES256 are accepted');
    }
  }

  const publicOrigin = context.publicOrigin;
  let redirectUri;
  if (raw.redirect_uri != null && raw.redirect_uri !== '') {
    redirectUri = normalizeRedirectUri(raw.redirect_uri, issuerUrl);
    if (publicOrigin) {
      const expectedOrigin = new URL(publicOrigin).origin;
      if (new URL(redirectUri).origin !== expectedOrigin) {
        throw new Error('browser login redirect_uri origin must match publicOrigin');
      }
    }
  } else if (publicOrigin) {
    redirectUri = normalizeRedirectUri(new URL(OIDC_CALLBACK_PATH, publicOrigin).href, issuerUrl);
  } else if (!isLoopbackHost(context.listenHost ?? '127.0.0.1')) {
    throw new Error('browser login requires redirect_uri or publicOrigin');
  }

  let postLogoutRedirectUri;
  if (raw.post_logout_redirect_uri != null && raw.post_logout_redirect_uri !== '') {
    postLogoutRedirectUri = normalizePostLogoutUri(raw.post_logout_redirect_uri, redirectUri, publicOrigin);
  } else if (publicOrigin) {
    postLogoutRedirectUri = new URL('/', publicOrigin).href;
  }

  const scopes = normalizeScopes(raw.scopes);
  const sessionTtlSeconds = normalizeTtl(raw.session_ttl_seconds);
  const subjectClaim = typeof identityConfig.subject_claim === 'string' && identityConfig.subject_claim.trim()
    ? identityConfig.subject_claim.trim()
    : 'sub';

  return Object.freeze({
    client_id: clientId,
    client_secret: clientSecret,
    issuer,
    audience,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: postLogoutRedirectUri,
    scopes,
    session_ttl_seconds: sessionTtlSeconds,
    subject_claim: subjectClaim,
    algorithms: Object.freeze([...algorithms]),
  });
}

/**
 * Local path only. External or protocol-relative values become `/`.
 * @param {unknown} value
 */
export function allowlistedReturnPath(value) {
  if (typeof value !== 'string' || !value) return '/';
  if (value.length > 1024) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || value.includes('://')) return '/';
  if (/[\u0000-\u001F\u007F]/.test(value)) return '/';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '/';
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('://')) {
    return '/';
  }
  if (/[\u0000-\u001F\u007F]/.test(decoded)) return '/';
  return value;
}

/**
 * @param {unknown} error
 */
export function publicOidcError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'unauthorized_membership') return PUBLIC_UNAUTHORIZED;
  if (code === 'unavailable' || code === 'capacity') {
    return code === 'capacity' ? PUBLIC_CAPACITY : PUBLIC_SIGNIN_UNAVAILABLE;
  }
  return PUBLIC_SIGNIN_FAILED;
}

/**
 * @param {{
 *   browserLogin: object,
 *   memberships: Map<string, import('./identity.js').VerifiedActor>,
 *   publicOrigin?: string,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createOidcBrowserLogin(options) {
  const browserLogin = options.browserLogin;
  if (!browserLogin) return null;
  const memberships = options.memberships;
  const nowFn = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logins = new BoundedTtlMap(MAX_LOGIN_TRANSACTIONS, { evictOldest: true });
  const sessions = new BoundedTtlMap(MAX_SESSIONS);
  const secure = cookieSecure(options.publicOrigin, browserLogin.redirect_uri);
  /** @type {Promise<client.Configuration> | null} */
  let discovered = null;

  return {
    enabled: true,
    secure,
    /**
     * @param {{ returnPath?: unknown, requestUrl: URL }} input
     */
    async startLogin(input) {
      const now = nowFn();
      const redirectUri = resolveRedirectUri(browserLogin, input.requestUrl);
      const configuration = await loadConfiguration();
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const loginId = randomOpaqueId();
      logins.set(loginId, {
        expiresAt: now + LOGIN_TTL_MS,
        state,
        nonce,
        codeVerifier,
        redirectUri,
        returnPath: allowlistedReturnPath(input.returnPath),
      }, now);
      const authorizationUrl = client.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: browserLogin.scopes.join(' '),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        response_type: 'code',
        client_id: browserLogin.client_id,
      });
      return {
        location: authorizationUrl.href,
        cookies: [
          cookieHeader(LOGIN_COOKIE_NAME, loginId, { maxAge: Math.floor(LOGIN_TTL_MS / 1000), secure }),
        ],
      };
    },
    /**
     * @param {{ requestUrl: URL, loginId: string | null }} input
     */
    async finishLogin(input) {
      const now = nowFn();
      if (!input.loginId) {
        throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'login_csrf' });
      }
      const transaction = logins.take(input.loginId, now);
      if (!transaction) {
        throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'login_csrf' });
      }
      const configuration = await loadConfiguration();
      const callbackUrl = new URL(transaction.redirectUri);
      callbackUrl.search = input.requestUrl.search;
      let tokens;
      try {
        tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
          pkceCodeVerifier: transaction.codeVerifier,
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          idTokenExpected: true,
        });
      } catch (error) {
        throw wrapProtocolError(error);
      }
      const claims = tokens.claims();
      if (!claims) {
        throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
      }
      assertTrustedClaims(claims, browserLogin);
      const subject = claims[browserLogin.subject_claim];
      if (typeof subject !== 'string' || !subject.trim()) {
        throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
      }
      const mapped = memberships.get(subject);
      if (!mapped) {
        throw Object.assign(new Error(PUBLIC_UNAUTHORIZED), { code: 'unauthorized_membership' });
      }
      const actor = validateVerifiedActor(mapped);
      const sessionId = randomOpaqueId();
      sessions.set(sessionId, {
        expiresAt: now + (browserLogin.session_ttl_seconds * 1000),
        subject: actor.subject,
      }, now);
      return {
        actor,
        returnPath: transaction.returnPath,
        cookies: [
          cookieHeader(SESSION_COOKIE_NAME, sessionId, {
            maxAge: browserLogin.session_ttl_seconds,
            secure,
          }),
          cookieHeader(LOGIN_COOKIE_NAME, '', { maxAge: 0, secure, clear: true }),
        ],
      };
    },
    expiredLoginCookies() {
      return [cookieHeader(LOGIN_COOKIE_NAME, '', { maxAge: 0, secure, clear: true })];
    },
    /**
     * @param {string | null | undefined} sessionId
     */
    actorFromSession(sessionId) {
      if (!sessionId) return null;
      const now = nowFn();
      const session = sessions.get(sessionId, now);
      if (!session) return null;
      const mapped = memberships.get(session.subject);
      if (!mapped) {
        sessions.delete(sessionId);
        return null;
      }
      return validateVerifiedActor(mapped);
    },
    async logout(sessionId) {
      const now = nowFn();
      if (sessionId) sessions.delete(sessionId);
      logins.prune(now);
      const cookies = [
        cookieHeader(SESSION_COOKIE_NAME, '', { maxAge: 0, secure, clear: true }),
        cookieHeader(LOGIN_COOKIE_NAME, '', { maxAge: 0, secure, clear: true }),
      ];
      let endSessionUrl;
      try {
        const configuration = await loadConfiguration();
        const metadata = configuration.serverMetadata();
        if (metadata.end_session_endpoint) {
          const parameters = { client_id: browserLogin.client_id };
          if (browserLogin.post_logout_redirect_uri) {
            parameters.post_logout_redirect_uri = browserLogin.post_logout_redirect_uri;
          }
          endSessionUrl = client.buildEndSessionUrl(configuration, parameters).href;
        }
      } catch {
        endSessionUrl = undefined;
      }
      return { location: '/', cookies, endSessionUrl };
    },
  };

  async function loadConfiguration() {
    if (!discovered) {
      discovered = discover().catch((error) => {
        discovered = null;
        throw error;
      });
    }
    return discovered;
  }

  async function discover() {
    const issuerUrl = trustedIssuerUrl(browserLogin.issuer);
    const metadata = {};
    if (browserLogin.algorithms.length === 1) {
      metadata.id_token_signed_response_alg = browserLogin.algorithms[0];
    }
    if (browserLogin.client_secret) metadata.client_secret = browserLogin.client_secret;
    const execute = [];
    if (issuerUrl.protocol === 'http:') {
      if (!isLoopbackHost(issuerUrl.hostname)) {
        throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
      }
      execute.push(client.allowInsecureRequests);
    }
    let configuration;
    try {
      configuration = await client.discovery(
        issuerUrl,
        browserLogin.client_id,
        metadata,
        browserLogin.client_secret ? undefined : client.None(),
        {
          timeout: OIDC_FETCH_TIMEOUT_SECONDS,
          execute,
          [client.customFetch]: createIssuerFetch(issuerUrl, fetchImpl),
        },
      );
    } catch (error) {
      throw wrapUnavailable(error);
    }
    configuration.timeout = OIDC_FETCH_TIMEOUT_SECONDS;
    assertDiscoveredEndpoints(configuration, issuerUrl);
    return configuration;
  }
}

function createIssuerFetch(issuerUrl, fetchImpl) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    assertTrustedEndpoint(url.href, issuerUrl);
    const parentSignal = init.signal;
    const timeout = AbortSignal.timeout(OIDC_FETCH_TIMEOUT_SECONDS * 1000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    const response = await fetchImpl(url, {
      ...init,
      signal,
      redirect: 'error',
    });
    const body = await readBoundedResponse(response);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function readBoundedResponse(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > OIDC_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertDiscoveredEndpoints(configuration, issuerUrl) {
  const metadata = configuration.serverMetadata();
  if (new URL(metadata.issuer).href !== issuerUrl.href) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof metadata[key] !== 'string') {
      throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
    }
    assertTrustedEndpoint(metadata[key], issuerUrl);
  }
  if (metadata.end_session_endpoint) {
    assertTrustedEndpoint(metadata.end_session_endpoint, issuerUrl);
  }
}

function assertTrustedEndpoint(value, issuerUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
  if (url.origin !== issuerUrl.origin) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
  if (issuerUrl.protocol === 'https:') {
    if (url.protocol !== 'https:') {
      throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
    }
  } else if (!isLoopbackHost(url.hostname) || url.protocol !== 'http:') {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
}

function assertTrustedClaims(claims, browserLogin) {
  const issuerHref = trustedIssuerUrl(browserLogin.issuer).href;
  let claimIssuerHref = '';
  try {
    claimIssuerHref = new URL(claims.iss).href;
  } catch {
    throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
  }
  if (claims.iss !== browserLogin.issuer && claimIssuerHref !== issuerHref) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(browserLogin.audience) && !audiences.includes(browserLogin.client_id)) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
  }
  if (typeof claims.azp === 'string' && claims.azp !== browserLogin.client_id) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
  }
}

function resolveRedirectUri(browserLogin, requestUrl) {
  if (browserLogin.redirect_uri) return browserLogin.redirect_uri;
  if (!isLoopbackHost(requestUrl.hostname)) {
    throw Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
  }
  return new URL(OIDC_CALLBACK_PATH, requestUrl.origin).href;
}

function trustedIssuerUrl(issuer) {
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('OIDC issuer must be a valid URL');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('OIDC issuer must not include credentials, query, or fragment');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw new Error('OIDC issuer must be https (or loopback http for local synthetic issuers)');
}

function normalizeRedirectUri(value, issuerUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('browser login redirect_uri must be a valid URL');
  }
  if (url.pathname !== OIDC_CALLBACK_PATH) {
    throw new Error('browser login redirect_uri path must be /oidc/callback');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('browser login redirect_uri must not include query, fragment, or credentials');
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.href;
  void issuerUrl;
  throw new Error('browser login redirect_uri must be https (or loopback http)');
}

function normalizePostLogoutUri(value, redirectUri, publicOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('browser login post_logout_redirect_uri must be a valid URL');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('browser login post_logout_redirect_uri must not include query, fragment, or credentials');
  }
  const allowedOrigins = [];
  if (publicOrigin) allowedOrigins.push(new URL(publicOrigin).origin);
  if (redirectUri) allowedOrigins.push(new URL(redirectUri).origin);
  if (allowedOrigins.length && !allowedOrigins.includes(url.origin)) {
    throw new Error('browser login post_logout_redirect_uri origin is not allowed');
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.href;
  throw new Error('browser login post_logout_redirect_uri must be https (or loopback http)');
}

function normalizeScopes(value) {
  const scopes = Array.isArray(value) ? value : ['openid'];
  if (!scopes.includes('openid')) {
    throw new Error('browser login scopes must include openid');
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !scope.trim() || /\s/.test(scope)) {
      throw new Error('browser login scopes are invalid');
    }
  }
  return Object.freeze([...scopes]);
}

function normalizeTtl(value) {
  if (value == null || value === '') return DEFAULT_SESSION_TTL_SECONDS;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < MIN_SESSION_TTL_SECONDS) {
    throw new Error('browser login session_ttl_seconds is invalid');
  }
  return Math.min(numeric, MAX_SESSION_TTL_SECONDS);
}

function trimRequired(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalSecret(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('browser login client_secret is invalid');
  return value;
}

function cookieSecure(publicOrigin, redirectUri) {
  const candidate = publicOrigin || redirectUri || '';
  return candidate.startsWith('https:');
}

function cookieHeader(name, value, { maxAge, secure, clear = false }) {
  const parts = [`${name}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${clear ? 0 : maxAge}`);
  return parts.join('; ');
}

function randomOpaqueId() {
  return randomBytes(32).toString('base64url');
}

function wrapProtocolError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'unauthorized_membership' || code === 'unavailable' || code === 'capacity' || code === 'login_csrf') {
    return error;
  }
  return Object.assign(new Error(PUBLIC_SIGNIN_FAILED), { code: 'protocol' });
}

function wrapUnavailable(error) {
  if (error && error.code === 'unavailable') return error;
  return Object.assign(new Error(PUBLIC_SIGNIN_UNAVAILABLE), { code: 'unavailable' });
}

class BoundedTtlMap {
  /**
   * @param {number} max
   * @param {{ evictOldest?: boolean }} [options]
   */
  constructor(max, options = {}) {
    this.max = max;
    this.evictOldest = Boolean(options.evictOldest);
    /** @type {Map<string, { expiresAt: number }>} */
    this.map = new Map();
  }

  prune(now) {
    for (const [key, value] of this.map) {
      if (value.expiresAt <= now) this.map.delete(key);
    }
  }

  set(key, value, now) {
    this.prune(now);
    if (this.map.size >= this.max && !this.map.has(key)) {
      if (this.evictOldest) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      } else {
        throw Object.assign(new Error(PUBLIC_CAPACITY), { code: 'capacity' });
      }
    }
    this.map.set(key, value);
  }

  get(key, now) {
    this.prune(now);
    const value = this.map.get(key);
    if (!value) return null;
    if (value.expiresAt <= now) {
      this.map.delete(key);
      return null;
    }
    return value;
  }

  take(key, now) {
    const value = this.get(key, now);
    if (!value) return null;
    this.map.delete(key);
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }
}
