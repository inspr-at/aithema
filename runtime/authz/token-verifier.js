import { createPublicKey, verify } from 'node:crypto';
import { AuthzError, capabilities, checkedDocument, freeze } from './common.js';

function decode(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) throw new AuthzError(401, 'Malformed JWT encoding');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new AuthzError(401, 'Noncanonical JWT encoding');
  return bytes;
}

function json(part) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part))); }
  catch { throw new AuthzError(401, 'Malformed JWT JSON'); }
}

/** Host-supplied JWKS only. Token headers never select a URL or embedded key. */
export class TokenVerifier {
  #issuer;
  #audience;
  #now;
  #keys;

  constructor({ issuer, hostAudience, jwks, now = () => Date.now() }) {
    if (typeof issuer !== 'string' || !/^https:\/\/[^\s]+$/.test(issuer)
        || typeof hostAudience !== 'string' || !hostAudience.length || hostAudience.length > 256) {
      throw new TypeError('Exact issuer and host audience are required');
    }
    this.#issuer = issuer;
    this.#audience = hostAudience;
    this.#now = now;
    this.replaceJwks(jwks);
  }

  /** The host retains retired keys for at least 900 + 60 seconds after last issuance. */
  replaceJwks(jwks) {
    if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length) throw new TypeError('A nonempty host JWKS is required');
    const keys = new Map();
    for (const jwk of jwks.keys) {
      if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid.length || keys.has(jwk.kid)
          || Object.hasOwn(jwk, 'd') || (jwk.use !== undefined && jwk.use !== 'sig')
          || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) {
        throw new TypeError('JWKS requires unique public signing keys with kid');
      }
      const algorithm = jwk.kty === 'OKP' && ['Ed25519', 'Ed448'].includes(jwk.crv) ? 'EdDSA'
        : jwk.kty === 'EC' && jwk.crv === 'P-256' ? 'ES256' : null;
      if (!algorithm || (jwk.alg !== undefined && jwk.alg !== algorithm)) throw new TypeError('Unsupported or mismatched JWKS algorithm');
      keys.set(jwk.kid, { algorithm, key: createPublicKey({ key: structuredClone(jwk), format: 'jwk' }) });
    }
    this.#keys = keys; // Failed rotation leaves the previous complete key set intact.
  }

  /** @param {string} token @param {{type:'session'|'delegated'}} options */
  verify(token, { type } = {}) {
    if (!['session', 'delegated'].includes(type)) throw new TypeError('Token type must be explicit');
    if (typeof token !== 'string' || token.length > 32768) throw new AuthzError(401, 'Malformed JWT');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthzError(401, 'JWT requires three segments');
    const header = json(parts[0]);
    if (!header || typeof header !== 'object' || Array.isArray(header)
        || !capabilities.token_verification.algorithms.includes(header.alg)
        || typeof header.kid !== 'string' || !header.kid.length
        || (header.typ !== undefined && header.typ !== 'JWT')
        || Object.keys(header).some((key) => !['alg', 'kid', 'typ'].includes(key))) {
      throw new AuthzError(401, 'Unsupported JWT header');
    }
    const selected = this.#keys.get(header.kid);
    if (!selected || selected.algorithm !== header.alg) throw new AuthzError(401, 'Unknown or mismatched signing key');
    const signature = decode(parts[2]);
    const key = header.alg === 'ES256' ? { key: selected.key, dsaEncoding: 'ieee-p1363' } : selected.key;
    let valid = false;
    try { valid = verify(header.alg === 'ES256' ? 'sha256' : null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature); }
    catch { /* A malformed signature is an ordinary authentication refusal. */ }
    if (!valid) throw new AuthzError(401, 'Invalid JWT signature');
    const claims = json(parts[1]);
    const document = { contract: 'aithema.token.claims', major: 1, minor: 0, min_reader: 0, token: type, claims };
    checkedDocument(document.contract, document, 401);
    if (claims.iss !== this.#issuer || claims.aud !== (type === 'session' ? 'aithema' : this.#audience)) {
      throw new AuthzError(401, 'JWT issuer or audience mismatch');
    }
    const now = this.#now() / 1000;
    const skew = capabilities.token_verification.max_clock_skew_seconds;
    if (!Number.isFinite(now) || claims.iat > now + skew || claims.exp <= now - skew) {
      throw new AuthzError(401, 'JWT issued in the future or expired');
    }
    return freeze(document);
  }

  verifySession(token) { return this.verify(token, { type: 'session' }); }
  verifyDelegated(token) { return this.verify(token, { type: 'delegated' }); }
}
