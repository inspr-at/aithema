import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  createIdentityVerifier,
  createDemoIdentityVerifier,
  verifyJwtWithJwks,
  validateMembershipMapping,
} from '../runtime/identity.js';
import { normalizeWorkspaceConfig } from '../workspace/config.js';

function rsaFixture() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-rsa';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { ...pair, jwk };
}

function signJwt(privateKey, payload, header = { alg: 'RS256', kid: 'test-rsa', typ: 'JWT' }) {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

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

describe('JWT/JWKS identity', () => {
  it('verifies issuer, audience, algorithm, time, then applies operator membership mapping', () => {
    const { privateKey, jwk } = rsaFixture();
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, {
      iss: 'https://auth.test',
      aud: 'aithema',
      sub: 'user-alice',
      exp: now + 60,
      iat: now,
    });
    const actor = verifyJwtWithJwks(token, {
      issuer: 'https://auth.test',
      audience: 'aithema',
      algorithms: ['RS256'],
      jwks: { keys: [jwk] },
      memberships: validateMembershipMapping(memberships),
    });
    assert.equal(actor.party_ref, 'party:alice');
    assert.equal(actor.actor_kind, 'human');
    assert.deepEqual([...actor.roles], ['requirements_approver', 'delivery_party']);
  });

  it('does not infer human authority from a signed subject alone', () => {
    const { privateKey, jwk } = rsaFixture();
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, {
      iss: 'https://auth.test',
      aud: 'aithema',
      sub: 'unknown-person',
      role: 'admin',
      actor_kind: 'human',
      exp: now + 60,
      iat: now,
    });
    assert.throws(
      () => verifyJwtWithJwks(token, {
        issuer: 'https://auth.test',
        audience: 'aithema',
        jwks: { keys: [jwk] },
        memberships: validateMembershipMapping(memberships),
      }),
      /no trusted membership mapping/,
    );
  });

  it('rejects alg=none, wrong audience, expired tokens, and mapped agent approvers at config time', () => {
    const { privateKey, jwk } = rsaFixture();
    const now = Math.floor(Date.now() / 1000);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
      iss: 'https://auth.test',
      aud: 'aithema',
      sub: 'user-alice',
      exp: now + 60,
    })).toString('base64url')}.`;
    assert.throws(
      () => verifyJwtWithJwks(none, {
        issuer: 'https://auth.test',
        audience: 'aithema',
        jwks: { keys: [jwk] },
        memberships: validateMembershipMapping(memberships),
      }),
      /algorithm is not allowed/,
    );

    const wrongAud = signJwt(privateKey, {
      iss: 'https://auth.test',
      aud: 'other',
      sub: 'user-alice',
      exp: now + 60,
      iat: now,
    });
    assert.throws(
      () => verifyJwtWithJwks(wrongAud, {
        issuer: 'https://auth.test',
        audience: 'aithema',
        jwks: { keys: [jwk] },
        memberships: validateMembershipMapping(memberships),
      }),
      /audience is invalid/,
    );

    const expired = signJwt(privateKey, {
      iss: 'https://auth.test',
      aud: 'aithema',
      sub: 'user-alice',
      exp: now - 120,
      iat: now - 180,
    });
    assert.throws(
      () => verifyJwtWithJwks(expired, {
        issuer: 'https://auth.test',
        audience: 'aithema',
        now: Date.now(),
        jwks: { keys: [jwk] },
        memberships: validateMembershipMapping(memberships),
      }),
      /expired/,
    );

    assert.throws(
      () => validateMembershipMapping([{
        subject: 'evil-agent',
        party_ref: 'party:evil',
        actor_kind: 'agent',
        roles: ['requirements_approver'],
        projects: [],
      }]),
      /cannot hold requirements_approver/,
    );
  });

  it('fails closed when production identity is unconfigured', () => {
    assert.throws(
      () => normalizeWorkspaceConfig({ mode: 'production', providers: {}, defaultProvider: 'x' }),
      /production identity is unconfigured/,
    );
    assert.throws(
      () => createIdentityVerifier(undefined, 'production'),
      /unconfigured/,
    );
  });

  it('rate-limits JWKS refetch for unknown kids', async () => {
    const { privateKey, jwk } = rsaFixture();
    const now = Math.floor(Date.now() / 1000);
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    };
    const verifier = createIdentityVerifier({
      kind: 'jwt-jwks',
      issuer: 'https://auth.test',
      audience: 'aithema',
      jwks_uri: 'http://127.0.0.1:1/jwks',
      jwks: { keys: [jwk] },
      fetchImpl,
      jwksRefreshCooldownMs: 60_000,
      memberships,
    }, 'production');

    for (let index = 0; index < 20; index += 1) {
      const token = signJwt(privateKey, {
        iss: 'https://auth.test',
        aud: 'aithema',
        sub: 'user-alice',
        exp: now + 60,
        iat: now,
      }, { alg: 'RS256', kid: `unknown-${index}`, typ: 'JWT' });
      await assert.rejects(() => verifier.verify(`Bearer ${token}`), /signing key is unknown/);
    }
    assert.equal(fetches, 1);
  });
});

describe('demo identity', () => {
  it('is HMAC-bound to a server-mapped subject and ignores browser-declared roles', async () => {
    const secret = 'demo-hmac-secret-not-for-production';
    const verifier = createDemoIdentityVerifier({
      demoHmacSecret: secret,
      defaultSubject: 'user-alice',
      memberships,
    }, 'demo');
    const cookie = verifier.issueCookie('user-alice');
    const actor = await verifier.verify(null, cookie);
    assert.equal(actor.actor_kind, 'human');
    assert.equal(actor.party_ref, 'party:alice');

    const body = Buffer.from(JSON.stringify({
      sub: 'user-alice',
      roles: ['requirements_approver'],
      actor_kind: 'human',
      party_ref: 'party:attacker',
    })).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const mac = createHmac('sha256', secret).update(body).digest('base64url');
    await assert.rejects(() => verifier.verify(null, `${body}.${mac}`), /must not carry browser-declared roles/);
  });
});
