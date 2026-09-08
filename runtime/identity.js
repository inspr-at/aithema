/**
 * Verified identity adapters. Production uses configured JWT/JWKS (OIDC-gateway
 * compatible) and optional Authorization Code browser login. Actor kind and
 * roles come from operator membership mapping, never from ID-token claims,
 * a self-declared browser role, or "any signed subject is human".
 */

import { createHmac, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import { validateAuthority } from '../lib/validate.js';

export const ACTOR_KINDS = Object.freeze(['human', 'agent']);
export const JWKS_UNKNOWN_KID_COOLDOWN_MS = 30_000;
export const JWKS_REFRESH_COOLDOWN_CEILING_MS = 300_000;

/**
 * @typedef {'human' | 'agent'} ActorKind
 * @typedef {{
 *   party_ref: string,
 *   actor_kind: ActorKind,
 *   roles: readonly import('../lib/types.js').PartyRole[],
 *   subject: string,
 *   projects: readonly string[],
 * }} VerifiedActor
 */

/**
 * @param {unknown} value
 * @returns {VerifiedActor}
 */
export function validateVerifiedActor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('verified actor must be an object');
  }
  validateAuthority(value);
  if (!ACTOR_KINDS.includes(value.actor_kind)) {
    throw new Error('actor_kind must be human or agent');
  }
  if (value.actor_kind === 'agent' && value.roles.includes('requirements_approver')) {
    throw new Error('agent actors cannot hold requirements_approver');
  }
  if (!Array.isArray(value.projects)) {
    throw new Error('verified actor projects must be an array');
  }
  if (typeof value.subject !== 'string' || !value.subject.trim()) {
    throw new Error('verified actor subject is required');
  }
  return value;
}

/**
 * @param {VerifiedActor} actor
 * @returns {import('../lib/types.js').VerifiedAuthority}
 */
export function authorityFromActor(actor) {
  const verified = validateVerifiedActor(actor);
  return { party_ref: verified.party_ref, roles: verified.roles };
}

/**
 * Human review authority is never inferred from a signature alone.
 * @param {VerifiedActor} actor
 */
export function assertHumanApprover(actor) {
  const verified = validateVerifiedActor(actor);
  if (verified.actor_kind !== 'human') {
    throw new Error('only a mapped human actor may approve or reject a baseline');
  }
  if (!verified.roles.includes('requirements_approver')) {
    throw new Error('requirements_approver role is required to approve a baseline');
  }
}

/**
 * @param {VerifiedActor} actor
 * @param {string} projectRef
 */
export function assertProjectMember(actor, projectRef) {
  const verified = validateVerifiedActor(actor);
  if (verified.projects.includes(projectRef)) return verified;
  throw new Error('not a member of this project');
}

/**
 * @param {unknown} mapping
 * @param {string} mode
 */
export function validateMembershipMapping(mapping, mode = 'production') {
  if (!Array.isArray(mapping) || mapping.length === 0) {
    throw new Error('identity membership mapping is required');
  }
  const bySubject = new Map();
  for (const entry of mapping) {
    const actor = validateVerifiedActor({
      party_ref: entry.party_ref,
      actor_kind: entry.actor_kind,
      roles: entry.roles,
      subject: entry.subject,
      projects: Array.isArray(entry.projects) ? entry.projects : [],
    });
    if (mode === 'production' && actor.projects.includes('*')) {
      throw new Error('production identity cannot use wildcard project membership');
    }
    if (bySubject.has(actor.subject)) {
      throw new Error(`duplicate membership subject ${actor.subject}`);
    }
    bySubject.set(actor.subject, actor);
  }
  return bySubject;
}

function b64urlToBuffer(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(b64urlToBuffer(value)).toString('utf8'));
}

/**
 * Verify a JWT against configured issuer, audience, algorithms, time, and JWKS.
 * HS256 / alg=none are rejected. Membership and actor_kind are applied from
 * trusted operator mapping after signature verification — never from token roles.
 *
 * @param {string} token
 * @param {{
 *   issuer: string,
 *   audience: string,
 *   algorithms?: readonly string[],
 *   jwks: { keys: readonly Record<string, unknown>[] },
 *   memberships: Map<string, VerifiedActor>,
 *   subjectClaim?: string,
 *   now?: number,
 *   clockSkewSeconds?: number,
 * }} options
 */
export function verifyJwtWithJwks(token, options) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error('identity token is malformed');
  }
  const algorithms = options.algorithms?.length ? options.algorithms : ['RS256'];
  for (const alg of algorithms) {
    if (alg !== 'RS256' && alg !== 'ES256') {
      throw new Error('only RS256 and ES256 are accepted');
    }
  }
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  const header = decodeJwtPart(headerPart);
  if (header.alg === 'none' || header.alg === 'HS256' || header.alg === 'HS384' || header.alg === 'HS512') {
    throw new Error('identity token algorithm is not allowed');
  }
  if (!algorithms.includes(header.alg)) {
    throw new Error('identity token algorithm is not allowed');
  }
  const keys = Array.isArray(options.jwks?.keys) ? options.jwks.keys : [];
  const jwk = header.kid
    ? keys.find((key) => key.kid === header.kid)
    : keys.find((key) => key.alg === header.alg || key.use === 'sig') ?? keys[0];
  if (!jwk) throw new Error('identity token signing key is unknown');
  const keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = b64urlToBuffer(signaturePart);
  const verifier = createVerify(header.alg === 'ES256' ? 'SHA256' : 'RSA-SHA256');
  verifier.update(signed);
  verifier.end();
  const ok = header.alg === 'ES256'
    ? verifier.verify({ key: keyObject, dsaEncoding: 'ieee-p1363' }, signature)
    : verifier.verify(keyObject, signature);
  if (!ok) throw new Error('identity token signature is invalid');

  const payload = decodeJwtPart(payloadPart);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (typeof payload.iss !== 'string' || payload.iss !== options.issuer) {
    throw new Error('identity token issuer is invalid');
  }
  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(options.audience)) {
    throw new Error('identity token audience is invalid');
  }
  if (typeof payload.exp !== 'number' || now > payload.exp + skew) {
    throw new Error('identity token is expired');
  }
  if (typeof payload.nbf === 'number' && now + skew < payload.nbf) {
    throw new Error('identity token is not yet valid');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + skew) {
    throw new Error('identity token time is invalid');
  }
  const claim = options.subjectClaim ?? 'sub';
  const subject = payload[claim];
  if (typeof subject !== 'string' || !subject.trim()) {
    throw new Error('identity token subject is missing');
  }
  const mapped = options.memberships.get(subject);
  if (!mapped) {
    throw new Error('signed subject has no trusted membership mapping');
  }
  return validateVerifiedActor(mapped);
}

/**
 * @param {string} jwksUri
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchJwks(jwksUri, fetchImpl = fetch) {
  if (typeof jwksUri !== 'string' || !/^https?:\/\//i.test(jwksUri)) {
    throw new Error('jwks_uri must be an http(s) URL');
  }
  const response = await fetchImpl(jwksUri, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`jwks HTTP ${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.keys)) throw new Error('jwks document is invalid');
  return body;
}

/**
 * Production identity fails closed when issuer/audience/JWKS/memberships are absent.
 * @param {unknown} identityConfig
 * @param {string} mode
 */
export function createIdentityVerifier(identityConfig, mode = 'production') {
  if (mode === 'demo' || mode === 'test') {
    return createDemoIdentityVerifier(identityConfig, mode);
  }
  if (mode !== 'production') {
    throw new Error('unknown workspace mode');
  }
  if (!identityConfig || identityConfig.kind !== 'jwt-jwks') {
    throw new Error('production identity is unconfigured; refusing to start');
  }
  const issuer = identityConfig.issuer;
  const audience = identityConfig.audience;
  const jwksUri = identityConfig.jwks_uri;
  const algorithms = identityConfig.algorithms;
  if (typeof issuer !== 'string' || !issuer.trim()) throw new Error('identity issuer is required');
  if (typeof audience !== 'string' || !audience.trim()) throw new Error('identity audience is required');
  if (typeof jwksUri !== 'string' || !jwksUri.trim()) throw new Error('identity jwks_uri is required');
  const memberships = validateMembershipMapping(identityConfig.memberships, 'production');
  let cachedJwks = identityConfig.jwks ?? null;
  const fetchImpl = identityConfig.fetchImpl ?? fetch;
  const cooldownMs = clampJwksCooldown(identityConfig.jwksRefreshCooldownMs);
  /** @type {Map<string, number>} */
  const unknownKids = new Map();
  let lastJwksRefreshAt = 0;

  return {
    kind: 'jwt-jwks',
    mode: 'production',
    labelledDemo: false,
    memberships,
    /**
     * @param {string | null | undefined} authorization
     */
    async verify(authorization) {
      const token = bearerToken(authorization);
      if (!token) throw new Error('identity token is required');
      if (!cachedJwks) {
        cachedJwks = await refreshJwks();
      }
      try {
        return verifyJwtWithJwks(token, {
          issuer,
          audience,
          algorithms,
          jwks: cachedJwks,
          memberships,
          subjectClaim: identityConfig.subject_claim,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('signing key is unknown')) throw error;
        rejectUnverifiedIssuerAudience(token, issuer, audience);
        const kid = peekJwtKid(token);
        const now = Date.now();
        if (kid && unknownKids.has(kid) && now - unknownKids.get(kid) < cooldownMs) {
          throw error;
        }
        if (now - lastJwksRefreshAt < cooldownMs) {
          if (kid) unknownKids.set(kid, now);
          throw error;
        }
        cachedJwks = await refreshJwks();
        try {
          const actor = verifyJwtWithJwks(token, {
            issuer,
            audience,
            algorithms,
            jwks: cachedJwks,
            memberships,
            subjectClaim: identityConfig.subject_claim,
          });
          if (kid) unknownKids.delete(kid);
          return actor;
        } catch (retryError) {
          if (kid) unknownKids.set(kid, Date.now());
          throw retryError;
        }
      }
    },
  };

  async function refreshJwks() {
    lastJwksRefreshAt = Date.now();
    return fetchJwks(jwksUri, fetchImpl);
  }
}

function bearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+(\S+)/i);
  return match ? match[1] : null;
}

/**
 * @param {unknown} value
 */
function clampJwksCooldown(value) {
  if (value == null || value === '') return JWKS_UNKNOWN_KID_COOLDOWN_MS;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return JWKS_UNKNOWN_KID_COOLDOWN_MS;
  return Math.min(Math.floor(numeric), JWKS_REFRESH_COOLDOWN_CEILING_MS);
}

/**
 * @param {string} token
 */
function peekJwtKid(token) {
  try {
    const header = decodeJwtPart(token.split('.')[0]);
    return typeof header.kid === 'string' ? header.kid : '';
  } catch {
    return '';
  }
}

/**
 * Unverified claims are used only to avoid JWKS fetch amplification.
 * Signature verification still decides identity.
 * @param {string} token
 * @param {string} issuer
 * @param {string} audience
 */
function rejectUnverifiedIssuerAudience(token, issuer, audience) {
  const payload = decodeJwtPart(token.split('.')[1]);
  if (typeof payload.iss !== 'string' || payload.iss !== issuer) {
    throw new Error('identity token issuer is invalid');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) {
    throw new Error('identity token audience is invalid');
  }
}

/**
 * Demo/test identity is explicit, server-mapped, and never a browser-supplied role.
 * Cookie carries only a subject + HMAC; roles come from operator mapping.
 * @param {unknown} identityConfig
 * @param {string} mode
 */
export function createDemoIdentityVerifier(identityConfig, mode) {
  if (mode !== 'demo' && mode !== 'test') {
    throw new Error('demo identity requires explicit demo or test mode');
  }
  const secret = identityConfig?.demoHmacSecret;
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('demo identity requires a server-owned hmac secret');
  }
  const memberships = validateMembershipMapping(identityConfig.memberships, mode);
  const defaultSubject = identityConfig.defaultSubject;
  if (typeof defaultSubject !== 'string' || !memberships.has(defaultSubject)) {
    throw new Error('demo identity defaultSubject must exist in memberships');
  }

  return {
    kind: 'demo',
    mode,
    labelledDemo: true,
    memberships,
    defaultSubject,
    /**
     * @param {string} subject
     */
    issueCookie(subject) {
      if (!memberships.has(subject)) throw new Error('unknown demo subject');
      const body = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url');
      const mac = createHmac('sha256', secret).update(body).digest('base64url');
      return `${body}.${mac}`;
    },
    /**
     * @param {string | null | undefined} authorization
     * @param {string | null | undefined} cookieValue
     */
    async verify(authorization, cookieValue) {
      const token = bearerToken(authorization);
      const raw = token || cookieValue;
      if (!raw) throw new Error('demo identity is required');
      const [body, mac] = raw.split('.');
      if (!body || !mac) throw new Error('demo identity cookie is malformed');
      const expected = createHmac('sha256', secret).update(body).digest('base64url');
      const left = Buffer.from(mac);
      const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new Error('demo identity cookie is invalid');
      }
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (parsed.roles || parsed.actor_kind || parsed.party_ref) {
        throw new Error('demo identity must not carry browser-declared roles');
      }
      const mapped = memberships.get(parsed.sub);
      if (!mapped) throw new Error('signed subject has no trusted membership mapping');
      return validateVerifiedActor(mapped);
    },
  };
}

/**
 * @param {string} host
 */
export function isLoopbackHost(host) {
  if (!host) return false;
  let hostname = String(host).trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end === -1 ? hostname : hostname.slice(1, end);
  } else if (hostname.includes(':') && hostname.split(':').length === 2) {
    hostname = hostname.split(':')[0];
  }
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '::ffff:127.0.0.1';
}
