import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { capabilities, document, envelope, HostError } from './protocol.js';

/** Runtime-only signing keys; neither private keys nor JWTs are written to disk. */
export function testKey(alg = 'EdDSA', kid = alg) {
  if (!capabilities.token_verification.algorithms.includes(alg)) throw new TypeError('Unsupported test algorithm');
  const pair = alg === 'EdDSA'
    ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { alg, kid, ...pair };
}

export function tokenDescriptor(token, claims) {
  return envelope('aithema.token.claims', { token, claims });
}

/** Low-level signer also permits malformed claims for adversarial tests. */
export function signToken(key, claims, header = { alg: key.alg, kid: key.kid, typ: 'JWT' }) {
  const protectedPart = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const content = `${protectedPart}.${payloadPart}`;
  const signature = sign(key.alg === 'EdDSA' ? null : 'sha256', Buffer.from(content), {
    key: key.privateKey, dsaEncoding: 'ieee-p1363',
  });
  return `${content}.${signature.toString('base64url')}`;
}

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid base64url');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Noncanonical base64url');
  return bytes;
}

/** The exact issuer/audience, algorithms, key IDs and skew come from §6.2. */
export class TokenVerifier {
  #keys = new Map();

  constructor({ issuer, audience, keys, now = () => Math.floor(Date.now() / 1000) }) {
    this.issuer = issuer;
    this.audience = audience;
    this.now = now;
    for (const key of keys) this.addKey(key);
  }

  addKey({ kid, alg, publicKey }) {
    if (!kid || this.#keys.has(kid)) throw new TypeError('A unique kid is required');
    if (!capabilities.token_verification.algorithms.includes(alg)) throw new TypeError('Unsupported verification algorithm');
    if ((alg === 'EdDSA' && publicKey.asymmetricKeyType !== 'ed25519') ||
        (alg === 'ES256' && (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails.namedCurve !== 'prime256v1'))) {
      throw new TypeError('Verification key does not match algorithm');
    }
    this.#keys.set(kid, { alg, publicKey, retiredAt: null });
  }

  /** Retention begins at the last issuance, not at the first token's issuance. */
  retireKey(kid, lastIssuedAt = this.now()) {
    const key = this.#keys.get(kid);
    if (!key || !Number.isSafeInteger(lastIssuedAt) || lastIssuedAt > this.now()) throw new TypeError('Invalid key retirement');
    key.retiredAt = Math.max(key.retiredAt ?? lastIssuedAt, lastIssuedAt);
  }

  pruneKeys() {
    const overlap = capabilities.token_max_lifetime_seconds + capabilities.token_verification.max_clock_skew_seconds;
    for (const [kid, key] of this.#keys) {
      if (key.retiredAt !== null && this.now() >= key.retiredAt + overlap) this.#keys.delete(kid);
    }
  }

  verify(jwt, token = 'delegated') {
    try {
      if (!['session', 'delegated'].includes(token) || typeof jwt !== 'string' || jwt.length > 16384) throw new Error('Invalid token');
      const parts = jwt.split('.');
      if (parts.length !== 3) throw new Error('Malformed JWT');
      const header = JSON.parse(decode(parts[0]).toString('utf8'));
      const claims = JSON.parse(decode(parts[1]).toString('utf8'));
      if (!header || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined || header.b64 !== undefined) throw new Error('Invalid JWT header');
      const key = this.#keys.get(header.kid);
      if (!key || header.alg !== key.alg || !capabilities.token_verification.algorithms.includes(header.alg)) throw new Error('Unknown key or algorithm');
      const valid = verify(key.alg === 'EdDSA' ? null : 'sha256', Buffer.from(`${parts[0]}.${parts[1]}`), {
        key: key.publicKey, dsaEncoding: 'ieee-p1363',
      }, decode(parts[2]));
      if (!valid) throw new Error('Invalid signature');
      const descriptor = document(tokenDescriptor(token, claims), 'aithema.token.claims');
      const skew = capabilities.token_verification.max_clock_skew_seconds;
      if (claims.iss !== this.issuer || claims.aud !== (token === 'session' ? 'aithema' : this.audience) ||
          claims.iat > this.now() + skew || claims.exp <= this.now() - skew) throw new Error('Token verification profile mismatch');
      return descriptor;
    } catch {
      // Avoid including untrusted claims, signatures or credentials in errors.
      throw new HostError(401, 'Invalid or expired token');
    }
  }
}
