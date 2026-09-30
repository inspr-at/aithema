import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { validate } from '../contracts/validate.js';
import { signToken, testKey, TokenVerifier, tokenDescriptor } from './host-kit/index.js';
import { audience, claims, initialTime, issuer, sessionClaims } from './host-kit/fixtures.js';

describe('host kit JWT verification profile (AIT-44a)', () => {
  for (const alg of ['EdDSA', 'ES256']) {
    it(`${alg}: verifies session and delegated contracts using runtime-only keys`, () => {
      const key = testKey(alg);
      const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
      const sid = randomUUID();
      for (const [kind, payload] of [['session', sessionClaims(sid)], ['delegated', claims(sid)]]) {
        const result = verifier.verify(signToken(key, payload), kind);
        assert.deepEqual(result, tokenDescriptor(kind, payload));
        assert.equal(validate(result.contract, result).ok, true);
      }
      assert.throws(() => verifier.verify(signToken(key, sessionClaims(sid))), { status: 401 });
      assert.throws(() => verifier.verify(signToken(key, claims(sid)), 'session'), { status: 401 });
    });
  }

  const badClaims = [
    ['issuer prefix', { iss: `${issuer}/other` }],
    ['issuer case', { iss: 'https://HOST.example' }],
    ['audience prefix', { aud: `${audience}/other` }],
    ['audience array', { aud: [audience] }],
    ['acceptance capability', { capabilities: ['intake.accept'] }],
    ['decision capability', { capabilities: ['intake.decide'] }],
    ['node write capability', { capabilities: ['nodes.write'] }],
    ['unknown stronger scope', { capabilities: ['intake.admin'] }],
    ['duplicate scopes', { capabilities: ['intake.read', 'intake.read'] }],
    ['empty scopes', { capabilities: [] }],
    ['no actor', { act: undefined }],
    ['unknown claim', { role: 'administrator' }],
    ['fractional generation', { gen: 1.5 }],
    ['unsafe generation', { gen: Number.MAX_SAFE_INTEGER + 1 }],
    ['iat beyond skew', { iat: initialTime + 61, exp: initialTime + 100 }],
    ['exp exactly at skew boundary', { iat: initialTime - 900, exp: initialTime - 60 }],
    ['exp past skew', { iat: initialTime - 900, exp: initialTime - 61 }],
    ['lifetime 901 seconds', { exp: initialTime + 901 }],
    ['zero lifetime', { exp: initialTime }],
    ['negative lifetime', { exp: initialTime - 1 }],
    ['negative iat', { iat: -1 }],
  ];
  for (const [label, changes] of badClaims) {
    it(`refuses ${label}`, () => {
      const key = testKey();
      const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
      assert.throws(() => verifier.verify(signToken(key, claims(randomUUID(), changes))), { status: 401 });
    });
  }

  it('accepts skew boundaries, 900-second lifetime and optional jti without JWT replay tracking', () => {
    const key = testKey();
    const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
    for (const changes of [{ iat: initialTime + 60, exp: initialTime + 960 },
      { iat: initialTime - 900, exp: initialTime - 59 }, { jti: randomUUID() }]) {
      const token = signToken(key, claims(randomUUID(), changes));
      assert.deepEqual(verifier.verify(token), verifier.verify(token));
    }
  });

  for (const header of [
    { alg: 'EdDSA' }, { alg: 'EdDSA', kid: '' }, { alg: 'EdDSA', kid: 'unknown' },
    { alg: 'none', kid: 'EdDSA' }, { alg: 'HS256', kid: 'EdDSA' }, { alg: 'ES256', kid: 'EdDSA' },
    { alg: 'EdDSA', kid: 'EdDSA', crit: ['extension'] }, { alg: 'EdDSA', kid: 'EdDSA', b64: false },
  ]) {
    it(`refuses JWT header ${JSON.stringify(header)}`, () => {
      const key = testKey();
      const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
      assert.throws(() => verifier.verify(signToken(key, claims(randomUUID()), header)), { status: 401 });
    });
  }

  it('rejects corrupt, substituted, unsigned and malformed JWTs without echoing their contents', () => {
    const key = testKey();
    const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
    const good = signToken(key, claims(randomUUID()));
    const [header, payload, signature] = good.split('.');
    const substitute = Buffer.from(JSON.stringify(claims(randomUUID()))).toString('base64url');
    for (const token of [undefined, '', `${header}.${payload}`, `${header}.${payload}.`,
      `${header}.${substitute}.${signature}`, `${header}.${payload}.${'A'.repeat(86)}`,
      `${header}=.${payload}.${signature}`, `${good}.extra`, 'x'.repeat(16385),
      signToken(testKey('EdDSA', key.kid), claims(randomUUID()))]) {
      assert.throws(() => verifier.verify(token), (error) => error.status === 401 && error.message === 'Invalid or expired token');
    }
  });

  it('validates session scope, audience, actor kind and schema independently', () => {
    const key = testKey();
    const verifier = new TokenVerifier({ issuer, audience, keys: [key], now: () => initialTime });
    for (const changes of [{ aud: audience }, { scope: ['intake.accept'] }, { actor_kind: 'agent' },
      { scope: [] }, { gen: 1 }, { auth_epoch: 0 }, { exp: initialTime + 901 }]) {
      assert.throws(() => verifier.verify(signToken(key, sessionClaims(randomUUID(), changes)), 'session'), { status: 401 });
    }
    assert.equal(verifier.verify(signToken(key, sessionClaims(randomUUID(), { actor_kind: 'anonymous', host_mode: 'working_spec_only' })), 'session').claims.actor_kind, 'anonymous');
  });

  it('keeps retired verification keys for the full 900 + 60 second overlap', () => {
    let now = initialTime;
    const old = testKey('EdDSA', 'old');
    const fresh = testKey('ES256', 'fresh');
    const verifier = new TokenVerifier({ issuer, audience, keys: [old, fresh], now: () => now });
    const token = signToken(old, claims(randomUUID()));
    verifier.retireKey('old');
    now += 959;
    verifier.pruneKeys();
    assert.equal(verifier.verify(token).token, 'delegated');
    now++;
    verifier.pruneKeys();
    assert.throws(() => verifier.verify(token), { status: 401 });
    assert.equal(verifier.verify(signToken(fresh, claims(randomUUID(), { iat: now, exp: now + 900 }))).token, 'delegated');
  });

  it('rejects key/algorithm confusion and duplicate key IDs at configuration time', () => {
    const key = testKey();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    for (const bad of [{ ...key, alg: 'ES256' }, { ...key, alg: 'RS256' },
      { kid: 'rsa', alg: 'EdDSA', publicKey: rsa.publicKey }, { kid: 'p384', alg: 'ES256', publicKey: wrongCurve.publicKey }]) {
      assert.throws(() => new TokenVerifier({ issuer, audience, keys: [bad] }), TypeError);
    }
    assert.throws(() => new TokenVerifier({ issuer, audience, keys: [key, key] }), TypeError);
  });
});
