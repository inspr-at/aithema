import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validate, loadContractFile } from '../contracts/validate.js';
import { SqliteJournal } from '../runtime/journal/index.js';
import { AuthzError, TokenVerifier, CapabilityGuard, ROUTES, AuthorityMonitor, AuthorizationSession,
  PurgeCoordinator, validateProcessingAuthorization, withDeadline } from '../runtime/authz/index.js';
import { authority as journalAuthority, bytes, record, session as journalSession, sid, time, turn, snapshot } from './fixtures/journal/helpers.mjs';

const policy = loadContractFile('capabilities.json');
const issuer = 'https://host.example';
const hostAudience = 'host.example';
const seconds = time / 1000;
const fixture = (name) => JSON.parse(readFileSync(new URL(`../contracts/fixtures/valid/${name}`, import.meta.url), 'utf8')).doc;
const scope = (overrides = {}) => ({ tid: 'fixture-tenant', pid: 'fixture-project', sid,
  auth_epoch: 1, worker_generation: 1, ...overrides });
const delegated = (overrides = {}) => ({ iss: issuer, aud: hostAudience, sub: 'plugin-aithema',
  act: { sub: 'fixture-person' }, tid: 'fixture-tenant', pid: 'fixture-project', sid, gen: 1,
  auth_epoch: 1, capabilities: [...policy.delegated_allowed], iat: seconds, exp: seconds + 900, ...overrides });
const browser = (overrides = {}) => ({ iss: issuer, aud: 'aithema', sub: 'fixture-person',
  tid: 'fixture-tenant', pid: 'fixture-project', sid, scope: ['session.converse', 'session.upload', 'session.confirm', 'session.export'],
  actor_kind: 'person', host_mode: 'review', auth_epoch: 1, iat: seconds, exp: seconds + 900, ...overrides });
function authRecord(overrides = {}) {
  return { ...fixture('authz.record.json'), tid: 'fixture-tenant', pid: 'fixture-project', sid, epoch: 1, ...overrides };
}
function localSession(overrides = {}) {
  const doc = authRecord();
  return new AuthorizationSession({ authorization: doc, scope: scope(), settingsSha256: doc.settings_sha256, ...overrides });
}
const code = (expected) => (error) => error.status === 409 && error.code === expected;
const status = (expected) => (error) => error.status === expected;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

/** Deterministic scheduler: no real sleeping and no network. */
class FakeClock {
  mono = 123_456;
  origin = this.mono;
  wall = time;
  wallJump = 0;
  timers = new Map();
  nextId = 1;
  clock = { monotonicNow: () => this.mono, wallNow: () => this.wall + this.mono - this.origin + this.wallJump };
  scheduler = {
    setTimeout: (fn, ms) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.mono + ms, fn });
      return id;
    },
    clearTimeout: (id) => { this.timers.delete(id); },
  };
  issued(at = this.mono) { return new Date(this.wall + at - this.origin).toISOString(); }
  async advance(ms) {
    const target = this.mono + ms;
    await flush();
    for (let i = 0; ; i++) {
      if (i > 10_000) throw new Error('Fake scheduler did not converge');
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.mono = Math.max(this.mono, due[1].at);
      this.timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    this.mono = target;
    await flush();
  }
}

function key(algorithm, kid = randomUUID()) {
  const pair = algorithm === 'EdDSA' ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, algorithm, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: algorithm, use: 'sig' } };
}
const ed = key('EdDSA');
const ec = key('ES256');
const jwks = (...keys) => ({ keys: keys.map((item) => item.jwk) });
function jwt(claims = delegated(), signingKey = ed, header = {}) {
  const head = Buffer.from(JSON.stringify({ alg: signingKey.algorithm, kid: signingKey.jwk.kid, typ: 'JWT', ...header })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = Buffer.from(`${head}.${body}`);
  const signature = sign(signingKey.algorithm === 'ES256' ? 'sha256' : null, signingInput,
    signingKey.algorithm === 'ES256' ? { key: signingKey.privateKey, dsaEncoding: 'ieee-p1363' } : signingKey.privateKey);
  return `${head}.${body}.${signature.toString('base64url')}`;
}
function verifier(now = () => time) { return new TokenVerifier({ issuer, hostAudience, jwks: jwks(ed, ec), now }); }
const authorityResponse = (fake, overrides = {}) => ({ ...scope(), tombstone: null, issued_at: fake.issued(), ...overrides });

// Independent literal oracle: operation, capability, generation, epoch, pid,
// LiveGrant. Never derive the expected matrix from the implementation's rows.
const expectedRoutes = [
  ['intake.sources', 'intake.write', true, true, true, true],
  ['intake.transcript-turns', 'intake.write', true, true, true, true],
  ['intake.drafts', 'intake.write', true, true, true, true],
  ['intake.replace', 'intake.write', true, true, true, true],
  ['intake.read', 'intake.read', false, true, true, false],
  ['intake.accept', 'intake.decide', false, false, false, false],
  ['journal.append', 'aithema.journal.write', true, true, true, false],
  ['journal.snapshot', 'aithema.journal.write', true, true, true, false],
  ['journal.op-result', 'aithema.journal.write', true, true, true, false],
  ['journal.records', 'aithema.journal.read', false, true, true, false],
  ['journal.cursor', 'aithema.journal.read', false, true, true, false],
  ['journal.authority', 'aithema.authority.read', false, false, false, false],
  ['ledger.admit', 'aithema.ledger', true, true, true, false],
  ['ledger.claim', 'aithema.ledger', true, true, true, false],
  ['ledger.settle', 'aithema.ledger', true, true, true, false],
  ['ledger.recover', 'aithema.ledger', true, true, true, false],
  ['ledger.holds', 'aithema.ledger', false, true, true, false],
  ['service.create', 'host service credential', false, false, false, false],
  ['service.host-event', 'host service credential', false, false, false, false],
  ['service.revoke', 'host service credential', false, false, false, false],
  ['service.context', 'host service credential', false, false, false, false],
];

describe('(a) host JWT verification', () => {
  for (const signingKey of [ed, ec]) for (const type of ['session', 'delegated']) {
    it(`verifies ${type} ${signingKey.algorithm} against public host JWKS and the foundation contract`, () => {
      const claims = type === 'session' ? browser() : delegated();
      const doc = verifier().verify(jwt(claims, signingKey), { type });
      assert.deepEqual(doc.claims, claims);
      assert.equal(validate(doc.contract, doc).ok, true);
      assert.ok(Object.isFrozen(doc.claims));
      assert.throws(() => { doc.claims.auth_epoch = 999; }, TypeError);
    });
  }

  for (const [name, patch] of [
    ['wrong issuer', { iss: `${issuer}/` }], ['wrong audience', { aud: 'other.example' }],
    ['audience array', { aud: [hostAudience] }], ['iat beyond skew', { iat: seconds + 61, exp: seconds + 900 }],
    ['expired at skew boundary', { iat: seconds - 900, exp: seconds - 60 }],
    ['lifetime over 900s', { exp: seconds + 901 }], ['exp equal iat', { exp: seconds }],
    ['negative epoch', { auth_epoch: 0 }], ['unsafe generation', { gen: Number.MAX_SAFE_INTEGER + 1 }],
    ['unknown claims', { roles: ['owner'] }], ['unlisted capability', { capabilities: ['intake.superuser'] }],
    ...policy.never_in_token.map((capability) => [`acceptance ${capability}`, { capabilities: [capability] }]),
  ]) it(`refuses ${name}`, () => {
    assert.throws(() => verifier().verifyDelegated(jwt(delegated(patch))), status(401));
  });

  it('allows exact 60s future skew, 900s lifetime, expiration inside the skew and optional jti', () => {
    const v = verifier();
    assert.ok(v.verifyDelegated(jwt(delegated({ iat: seconds + 60, exp: seconds + 960, jti: randomUUID() }))));
    assert.ok(v.verifyDelegated(jwt(delegated({ iat: seconds - 900, exp: seconds - 59 }))));
  });

  for (const [name, header] of [
    ['missing kid', { kid: undefined }], ['empty kid', { kid: '' }], ['unknown kid', { kid: 'not-a-host-key' }],
    ['none', { alg: 'none' }], ['HS256 confusion', { alg: 'HS256' }], ['key algorithm confusion', { alg: 'ES256' }],
    ['remote JWKS', { jku: 'https://remote.invalid/keys' }], ['embedded key', { jwk: ed.jwk }],
    ['critical header', { crit: ['b64'], b64: false }], ['non-JWT type', { typ: 'something-else' }],
  ]) it(`refuses header ${name}`, () => {
    assert.throws(() => verifier().verifyDelegated(jwt(delegated(), ed, header)), status(401));
  });

  it('refuses unsigned, malformed, noncanonical and tampered tokens without provider access', () => {
    const v = verifier();
    const token = jwt();
    const [head, body, sig] = token.split('.');
    const changed = Buffer.from(JSON.stringify(delegated({ pid: 'forged-project' }))).toString('base64url');
    for (const malformed of [null, '', '{}', 'a.b', `${head}.${body}.`, `${head}.${changed}.${sig}`,
      `${head}=.${body}.${sig}`, `${head}.${body}.${sig.slice(0, -3)}`, `${token}.extra`, 'x'.repeat(32769)]) {
      assert.throws(() => v.verifyDelegated(malformed), status(401));
    }
    assert.throws(() => v.verify(token), TypeError);
    assert.throws(() => v.verifySession(token), status(401));
    assert.throws(() => v.verifyDelegated(jwt(browser())), status(401));
  });

  it('uses raw JOSE ES256 signatures and refuses DER encoding', () => {
    const [head, body] = jwt(delegated(), ec).split('.');
    const der = sign('sha256', Buffer.from(`${head}.${body}`), ec.privateKey).toString('base64url');
    assert.throws(() => verifier().verifyDelegated(`${head}.${body}.${der}`), status(401));
  });

  it('supports host rotation overlap and never falls back to unknown keys', () => {
    const next = key('EdDSA');
    const v = verifier();
    const old = jwt();
    v.replaceJwks(jwks(ed, ec, next));
    assert.ok(v.verifyDelegated(old));
    assert.ok(v.verifyDelegated(jwt(delegated(), next)));
    v.replaceJwks(jwks(next));
    assert.throws(() => v.verifyDelegated(old), status(401));
    assert.ok(v.verifyDelegated(jwt(delegated(), next)));
  });

  it('refuses private, duplicate, inappropriate and mismatched host keys atomically', () => {
    const v = verifier();
    for (const bad of [{ keys: [] }, { keys: [ed.jwk, ed.jwk] },
      { keys: [{ ...ed.privateKey.export({ format: 'jwk' }), kid: 'private' }] },
      { keys: [{ ...ed.jwk, use: 'enc' }] }, { keys: [{ ...ed.jwk, key_ops: ['sign'] }] },
      { keys: [{ ...ec.jwk, alg: 'EdDSA' }] }, { keys: [{ ...ec.jwk, crv: 'P-384' }] }]) {
      assert.throws(() => v.replaceJwks(bad));
      assert.ok(v.verifyDelegated(jwt()));
    }
  });
});

describe('(a, e) exact capability and route matrix', () => {
  it('pins the literal capability, generation, epoch, pid and LiveGrant matrix for every route', () => {
    assert.deepEqual(Object.keys(ROUTES).sort(), expectedRoutes.map(([route]) => route).sort());
    for (const [route, capability, gen, epoch, pid, liveGrant] of expectedRoutes) {
      const row = ROUTES[route];
      assert.deepEqual([row.capability, row.checks.some((check) => check.startsWith('gen')),
        row.checks.includes('epoch'), row.checks.includes('pid'), row.checks.includes('ephemeral LiveGrant')],
      [capability, gen, epoch, pid, liveGrant], route);
    }
  });

  for (const [route, capability] of expectedRoutes.filter(([route]) => route !== 'intake.accept' && !route.startsWith('service.'))) {
    it(`${route} returns only its allowed capability from a token granting all capabilities`, () => {
      const result = new CapabilityGuard({ verifier: verifier() }).authorize(route, jwt(), scope(), { liveGrant: true });
      assert.deepEqual(result.capabilities, [capability]);
      assert.ok(Object.isFrozen(result.capabilities));
    });
  }

  it('journal read authority cannot be reused for a JournalPort append', (t) => {
    const journal = new SqliteJournal(':memory:', { now: () => time });
    t.after(() => journal.close());
    journal.createSession(bytes(journalSession()));
    const read = new CapabilityGuard({ verifier: verifier() }).authorize('journal.records', jwt(), scope());
    assert.throws(() => journal.append(bytes(turn()), read), status(403));
    assert.deepEqual(journal.recordsAfter(0, read), []);
  });

  for (const [route, row] of Object.entries(ROUTES)) {
    it(`${route} enforces its exact capability, scopes, epoch, generation and expiry`, () => {
      let now = time;
      const guard = new CapabilityGuard({ verifier: verifier(() => now) });
      if (['person-only', 'host-to-service'].includes(row.class)) {
        assert.throws(() => guard.authorize(route, jwt(), scope()), status(403));
        assert.throws(() => guard.authorize(route, jwt(browser()), scope()), status(403));
        return;
      }
      const correct = jwt(delegated({ capabilities: [row.capability] }));
      const authority = guard.authorize(route, correct, scope(), { liveGrant: true });
      assert.equal(authority.writer_kind, 'worker');
      assert.deepEqual(authority.capabilities, [row.capability]);
      for (const wrongCapability of policy.delegated_allowed.filter((cap) => cap !== row.capability)) {
        assert.throws(() => guard.authorize(route, jwt(delegated({ capabilities: [wrongCapability] })), scope(), { liveGrant: true }), status(403));
      }
      for (const field of ['tid', 'pid', 'sid'].filter((field) => row.checks.includes(field))) {
        assert.throws(() => guard.authorize(route, correct, scope({ [field]: 'different-scope' }), { liveGrant: true }), status(403));
      }
      if (row.checks.includes('epoch')) {
        assert.throws(() => guard.authorize(route, correct, scope({ auth_epoch: 2 }), { liveGrant: true }), code('revoked'));
        assert.throws(() => guard.authorize(route, correct, scope({ tombstone: 'purge' }), { liveGrant: true }), code('revoked'));
      } else {
        assert.ok(guard.authorize(route, correct, scope({ auth_epoch: 2, tombstone: 'purge' })));
      }
      if (row.checks.some((check) => check.startsWith('gen'))) {
        assert.throws(() => guard.authorize(route, correct, scope({ worker_generation: 2 }), { liveGrant: true }), code('fenced_generation'));
        assert.throws(() => guard.authorize(route, correct, scope({ suspended: true }), { liveGrant: true }), code('revoked'));
      } else {
        assert.ok(guard.authorize(route, correct, scope({ worker_generation: 2 })));
      }
      if (row.checks.includes('ephemeral LiveGrant')) assert.throws(() => guard.authorize(route, correct, scope()), status(403));
      assert.throws(() => guard.authorize(route, jwt(browser()), scope(), { liveGrant: true }), status(401));
      now += 961_000;
      assert.throws(() => guard.authorize(route, correct, scope(), { liveGrant: true }), status(401));
    });
  }

  it('covers every normative row and refuses prefix, aggregate and prototype fallbacks', () => {
    const guard = new CapabilityGuard({ verifier: verifier() });
    assert.equal(new Set(Object.values(ROUTES).map((row) => row.route)).size, policy.routes.length);
    for (const route of ['unknown', 'intake', 'aithema.journal', '__proto__', 'constructor']) {
      assert.throws(() => guard.authorize(route, jwt(), scope()), status(403));
    }
    assert.throws(() => guard.authorize('ledger.claim', jwt(), scope({ auth_epoch: undefined })), status(403));
    assert.throws(() => guard.authorize('ledger.claim', jwt(), scope({ worker_generation: undefined })), status(403));
    // Authority is deliberately available across project/epoch/generation changes.
    assert.ok(guard.authorize('journal.authority', jwt(), scope({ pid: 'changed', auth_epoch: 2, worker_generation: 2 })));
  });
});

describe('(b, e) continuous authority with one monotonic origin', () => {
  it('polls at session start + n*30s independently of 9s response time', async () => {
    const fake = new FakeClock();
    const starts = [];
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: ({ signal, cache }) => {
        starts.push(fake.mono - fake.origin);
        assert.equal(cache, 'no-store');
        assert.equal(signal.aborted, false);
        return new Promise((resolve) => fake.scheduler.setTimeout(() => resolve(authorityResponse(fake)), 9000));
      } });
    monitor.start();
    await fake.advance(99_000);
    assert.deepEqual(starts, [0, 30_000, 60_000, 90_000]);
    assert.equal(session.state, 'ACTIVE');
    assert.equal(monitor.consecutiveFailures, 0);
    monitor.stop();
    assert.equal(fake.timers.size, 0);
  });

  it('lost revoke callback still stops all local channels within 45s of the epoch change', async () => {
    const fake = new FakeClock();
    let epoch = 1;
    let stoppedAt;
    const session = localSession({ onChange: ({ state }) => { if (state === 'REVOKED') stoppedAt = fake.mono; } });
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => epoch === 1 ? authorityResponse(fake)
        : new Promise((resolve) => fake.scheduler.setTimeout(() => resolve(authorityResponse(fake, { auth_epoch: epoch })), 9999)) });
    monitor.start();
    await fake.advance(1);
    epoch = 2;
    const changedAt = fake.mono;
    await fake.advance(39_998);
    assert.equal(session.state, 'REVOKED');
    assert.ok(stoppedAt - changedAt <= policy.authority.revocation_healthy_max_seconds * 1000);
    assert.ok([session.captureSignal, session.microphoneSignal, session.outputSignal, session.pendingSignal].every((signal) => signal.aborted));
    assert.throws(() => session.assertNewClaim(), code('revoked'));
    monitor.stop();
  });

  for (const ahead of [1, 60_000]) {
    it(`host clock ${ahead}ms ahead still delivers lost-callback revocation within 45s`, async () => {
      const fake = new FakeClock();
      let epoch = 1, stoppedAt;
      const local = localSession({ onChange: ({ state }) => { if (state === 'REVOKED') stoppedAt = fake.mono; } });
      const monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
        fetchAuthority: () => new Promise((resolve) => fake.scheduler.setTimeout(() => resolve(
          authorityResponse(fake, { auth_epoch: epoch, issued_at: fake.issued(fake.mono + ahead) })), 9999)) });
      monitor.start();
      await fake.advance(10_000);
      assert.equal(monitor.lastError, null);
      assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 9999, 'A future stamp grants no future lease');
      epoch = 2;
      const changedAt = fake.mono;
      await fake.advance(29_999);
      assert.equal(local.state, 'REVOKED');
      assert.equal(local.scope.auth_epoch, 2);
      assert.ok(stoppedAt - changedAt <= 45_000);
      assert.equal(monitor.lastError, null);
      monitor.stop();
    });

    it(`host clock ${ahead}ms ahead cannot extend the 70s outage or 10min authority deadlines`, async () => {
      const fake = new FakeClock();
      let available = true;
      const local = localSession();
      const monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
        fetchAuthority: () => available
          ? authorityResponse(fake, { issued_at: fake.issued(fake.mono + ahead) }) : new Promise(() => {}) });
      monitor.start();
      await fake.advance(0);
      assert.equal(monitor.lastAuthorityMonotonic, fake.origin);
      available = false;
      await fake.advance(70_000);
      assert.equal(local.state, 'CAPTURE_ONLY');
      await fake.advance(529_999);
      assert.equal(local.state, 'CAPTURE_ONLY');
      await fake.advance(1);
      assert.equal(local.state, 'ENDED');
      assert.equal(fake.timers.size, 0);
    });
  }

  it('a revoked error from an authority poll closes every epoch-checked route without a new epoch', async () => {
    const fake = new FakeClock();
    const local = localSession();
    const errors = [];
    const monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
      onError: (error) => errors.push(error), fetchAuthority: () => { throw new AuthzError(409, 'Fixture host refusal', 'revoked'); } });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'REVOKED');
    assert.equal(local.scope.auth_epoch, 1);
    assert.equal(local.scope.revoked, true);
    assert.equal(monitor.consecutiveFailures, 0);
    assert.equal(errors.length, 1);
    const guard = new CapabilityGuard({ verifier: verifier() });
    for (const [route, , , epoch] of expectedRoutes.filter(([, , , epoch]) => epoch)) {
      assert.throws(() => guard.authorize(route, jwt(), local.scope, { liveGrant: true }), code('revoked'), route);
    }
    monitor.stop();
  });

  it('host outage stops microphone/paid work within 75s from availability loss and ends at 10min', async () => {
    const fake = new FakeClock();
    let available = true;
    let captureAt;
    const signals = [];
    const session = localSession({ onChange: ({ state }) => { if (state === 'CAPTURE_ONLY') captureAt = fake.mono; } });
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: ({ signal }) => { signals.push(signal); return available ? authorityResponse(fake) : new Promise(() => {}); } });
    monitor.start();
    await fake.advance(1);
    available = false;
    const lostAt = fake.mono;
    await fake.advance(39_999);
    assert.equal(monitor.consecutiveFailures, 1);
    assert.equal(session.state, 'ACTIVE');
    assert.equal(signals[1].aborted, true);
    await fake.advance(30_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    assert.ok(captureAt - lostAt <= 75_000);
    assert.equal(monitor.consecutiveFailures, 2);
    assert.equal(session.captureSignal.aborted, false, 'Text capture continues in CAPTURE_ONLY');
    assert.ok([session.microphoneSignal, session.outputSignal, session.pendingSignal].every((signal) => signal.aborted));
    assert.throws(() => session.assertNewClaim(), status(503));
    await fake.advance(529_999);
    assert.equal(session.state, 'CAPTURE_ONLY');
    await fake.advance(1);
    assert.equal(session.state, 'ENDED');
    assert.equal(fake.timers.size, 0);
  });

  it('an outage from startup has two 10s timeouts and recovery renews cancellation channels', async () => {
    const fake = new FakeClock();
    let available = false;
    const session = localSession();
    const originalCapture = session.captureSignal;
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => available ? authorityResponse(fake) : new Promise(() => {}) });
    monitor.start();
    await fake.advance(40_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    assert.equal(originalCapture.aborted, false);
    assert.equal(session.microphoneSignal.aborted, true);
    available = true;
    await fake.advance(20_000);
    assert.equal(session.state, 'ACTIVE');
    assert.equal(session.captureSignal.aborted, false);
    assert.notEqual(session.captureSignal, originalCapture);
    session.assertNewClaim();
    monitor.stop();
  });

  it('exactly 30s old responses cannot slide the outage/10min origins', async () => {
    const fake = new FakeClock();
    const oldIssued = fake.issued();
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { issued_at: oldIssued }) });
    monitor.start();
    await fake.advance(30_000);
    assert.equal(monitor.lastError, null, '30s boundary is fresh');
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin, 'arrival never extends issued authority');
    await fake.advance(40_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    assert.equal(monitor.lastError.status, 503);
    await fake.advance(530_000);
    assert.equal(session.state, 'ENDED');
  });

  for (const [name, patch] of [
    ['missing timestamp', () => ({ issued_at: undefined })],
    ['stale timestamp', (fake) => ({ issued_at: fake.issued(fake.mono - 30_001) })],
    ['future timestamp beyond skew', (fake) => ({ issued_at: fake.issued(fake.mono + 60_001) })],
    ['impossible date', () => ({ issued_at: '2026-02-30T07:00:00Z' })],
    ['foreign tenant', () => ({ tid: 'foreign' })], ['foreign pid', () => ({ pid: 'foreign' })],
    ['foreign session', () => ({ sid: randomUUID() })],
    ['missing epoch', () => ({ auth_epoch: undefined })], ['missing tombstone status', () => ({ tombstone: undefined })],
    ['unsafe generation', () => ({ worker_generation: Number.MAX_SAFE_INTEGER + 1 })],
  ]) it(`refuses ${name} without refreshing authority`, async () => {
    const fake = new FakeClock();
    const session = localSession();
    const errors = [];
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      onError: (error) => errors.push(error), fetchAuthority: () => authorityResponse(fake, patch(fake)) });
    monitor.start();
    await fake.advance(30_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    assert.equal(errors.length, 2);
    if (name.startsWith('foreign')) assert.ok(errors.every((error) => error.status === 502), 'Transport binding fails before applying the snapshot');
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin);
    monitor.stop();
  });

  it('maps wall timestamps onto an arbitrary monotonic origin and survives forward/backward local wall jumps', async () => {
    for (const jump of [86_400_000, -86_400_000]) {
      const fake = new FakeClock();
      fake.mono = 9_000_000_000;
      fake.origin = fake.mono;
      const starts = [];
      let available = true;
      const session = localSession();
      const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
        fetchAuthority: () => { starts.push(fake.mono - fake.origin); return available ? authorityResponse(fake) : new Promise(() => {}); } });
      monitor.start();
      await fake.advance(30_000);
      fake.wallJump = jump;
      await fake.advance(30_000);
      assert.equal(session.state, 'ACTIVE');
      assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 60_000);
      available = false;
      await fake.advance(70_000);
      assert.equal(session.state, 'CAPTURE_ONLY');
      assert.deepEqual(starts, [0, 30_000, 60_000, 90_000, 120_000]);
      monitor.stop();
    }
  });

  it('callback does not shift polls, and timed-out late responses cannot revive revoked/outage state', async () => {
    const fake = new FakeClock();
    const late = deferred();
    const starts = [];
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => { starts.push(fake.mono - fake.origin); return late.promise; } });
    monitor.start();
    await fake.advance(40_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    late.resolve(authorityResponse(fake));
    await flush();
    assert.equal(session.state, 'CAPTURE_ONLY');
    monitor.revoke(2);
    await fake.advance(20_000);
    assert.equal(session.state, 'REVOKED');
    assert.deepEqual(starts, [0, 30_000, 60_000]);
    monitor.stop();
  });

  it('rejects epoch rollback and timestamp rollback, and generation takeover cancels local work', async () => {
    const fake = new FakeClock();
    let patch = {};
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, patch) });
    monitor.start();
    await fake.advance(30_000);
    patch = { issued_at: fake.issued(fake.origin + 29_000) };
    await fake.advance(30_000);
    assert.equal(monitor.lastError.status, 503);
    patch = { worker_generation: 2 };
    await fake.advance(30_000);
    assert.equal(session.state, 'FENCED');
    assert.throws(() => session.assertNewClaim(), code('fenced_generation'));
    patch = { auth_epoch: 2, worker_generation: 2 };
    await fake.advance(30_000);
    assert.equal(session.state, 'REVOKED');
    patch = { auth_epoch: 1 };
    await fake.advance(30_000);
    assert.equal(monitor.lastError.status, 502);
    assert.equal(session.state, 'REVOKED');
    monitor.stop();
  });

  it('monitors authenticated host tombstone status and cannot start twice or renew after stop', async () => {
    const fake = new FakeClock();
    const response = deferred();
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler, fetchAuthority: () => response.promise });
    monitor.start();
    assert.throws(() => monitor.start(), status(409));
    await fake.advance(0);
    monitor.stop();
    response.resolve(authorityResponse(fake, { tombstone: 'purge' }));
    await flush();
    assert.equal(session.state, 'ACTIVE');
    assert.equal(fake.timers.size, 0);
    const next = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge' }) });
    next.start();
    await fake.advance(0);
    assert.equal(session.state, 'PURGING');
    next.stop();
  });

  it('all host requests use a 10s deadline and abort, including adapters that ignore signal', async () => {
    const fake = new FakeClock();
    let signal;
    const request = withDeadline((received) => { signal = received; return new Promise(() => {}); }, { scheduler: fake.scheduler });
    const refusal = assert.rejects(request, status(504));
    await fake.advance(9999);
    assert.equal(signal.aborted, false);
    await fake.advance(1);
    await refusal;
    assert.equal(signal.aborted, true);
    assert.equal(fake.timers.size, 0);
    const controller = new AbortController();
    controller.abort(new AuthzError(499, 'Fixture cancellation'));
    let called = false;
    await assert.rejects(withDeadline(() => { called = true; }, { scheduler: fake.scheduler, signal: controller.signal }), status(499));
    assert.equal(called, false);
  });

  it('an overdue request cannot win a timer/microtask race after an event-loop stall', async () => {
    const fake = new FakeClock();
    const response = deferred();
    let signal;
    const request = withDeadline((received) => { signal = received; return response.promise; },
      { clock: fake.clock, scheduler: fake.scheduler });
    const refusal = assert.rejects(request, status(504));
    await flush();
    fake.mono += 10_001; // Simulate a stalled loop: do not run overdue timers yet.
    response.resolve('overdue fixture acknowledgement');
    await refusal;
    assert.equal(signal.aborted, true);
    assert.equal(fake.timers.size, 0);
  });

  it('refuses an older issued_at even when it is still within the 30s freshness window', async () => {
    const fake = new FakeClock();
    let calls = 0;
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => ++calls < 3
        ? new Promise((resolve) => fake.scheduler.setTimeout(() => resolve(authorityResponse(fake)), 9000))
        : authorityResponse(fake, { issued_at: fake.issued(fake.origin + 38_000) }) });
    monitor.start();
    await fake.advance(39_000);
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 39_000);
    await fake.advance(21_000);
    assert.match(monitor.lastError.message, /moved backwards/);
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 39_000);
    monitor.stop();
  });
});

describe('(a, c, e) processing authorization, revocation and journal tombstones', () => {
  const storedControl = (action, seq = 1) => {
    const doc = record('session.control', { action }, { writer: { kind: 'host' } });
    return { bytes: bytes(doc), document: { ...doc, seq } };
  };

  for (const [name, apply, refusal] of [
    ['callback without epoch', (local) => local.revoke(), 'revoked'],
    ['callback with epoch', (local) => local.revoke(2), 'revoked'],
    ['authority epoch', (local) => local.applyAuthority({ ...scope({ auth_epoch: 2 }), tombstone: null }), 'revoked'],
    ['authority generation', (local) => local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null }), 'fenced_generation'],
    ['authority suspend', (local) => local.applyAuthority({ ...scope(), tombstone: 'suspend' }), 'revoked'],
    ['authority purge', (local) => local.applyAuthority({ ...scope(), tombstone: 'purge' }), 'revoked'],
    ['journal suspend', (local) => local.consumeStoredRecord(storedControl('suspend')), 'revoked'],
    ['journal purge', (local) => local.consumeStoredRecord(storedControl('purge')), 'revoked'],
    ['journal epoch', (local) => {
      const doc = record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } });
      local.consumeStoredRecord({ bytes: bytes(doc), document: { ...doc, seq: 1 } });
    }, 'revoked'],
  ]) {
    it(`${name} publishes scope that refuses old tokens on every affected route`, () => {
      const local = localSession();
      const guard = new CapabilityGuard({ verifier: verifier() });
      const token = jwt();
      apply(local);
      assert.throws(() => local.assertNewClaim(), code(refusal));
      if (refusal === 'fenced_generation') assert.equal(local.scope.worker_generation, 2);
      if (name.includes('suspend')) assert.equal(local.scope.suspended, true);
      if (name.includes('purge')) assert.equal(local.scope.tombstone, 'purge');
      for (const [route, , generation, epoch] of expectedRoutes.filter(([route]) => route !== 'intake.accept' && !route.startsWith('service.'))) {
        const affected = name.includes('suspend') || refusal === 'fenced_generation' ? generation : epoch;
        if (affected) assert.throws(() => guard.authorize(route, token, local.scope, { liveGrant: true }), code(refusal), route);
        else assert.ok(guard.authorize(route, token, local.scope, { liveGrant: true }), route);
      }
    });
  }

  it('a revoked JournalPort read publishes permanent revocation even without its epoch record', async () => {
    const local = localSession();
    await assert.rejects(local.consumeJournal({ recordsAfter: () => { throw new AuthzError(409, 'Fixture revoked read', 'revoked'); } }, journalAuthority()), code('revoked'));
    assert.equal(local.scope.auth_epoch, 1);
    assert.equal(local.scope.revoked, true);
    const guard = new CapabilityGuard({ verifier: verifier() });
    for (const [route] of expectedRoutes.filter(([, , , epoch]) => epoch)) {
      assert.throws(() => guard.authorize(route, jwt(), local.scope, { liveGrant: true }), code('revoked'), route);
    }
    local.applyAuthority({ ...scope(), tombstone: null });
    assert.equal(local.state, 'REVOKED');
  });

  it('journal resume clears the same suspension scope used by route guards', () => {
    const local = localSession();
    const guard = new CapabilityGuard({ verifier: verifier() });
    local.consumeStoredRecord(storedControl('suspend'));
    assert.throws(() => guard.authorize('ledger.claim', jwt(), local.scope), code('revoked'));
    local.consumeStoredRecord(storedControl('resume', 2));
    assert.equal(local.scope.suspended, false);
    assert.ok(guard.authorize('ledger.claim', jwt(), local.scope));
  });

  it('host suspension remains on scope when a simultaneous or earlier takeover has fenced the worker', () => {
    for (const together of [false, true]) {
      const local = localSession();
      if (!together) local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null });
      local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: 'suspend' });
      assert.equal(local.state, 'FENCED');
      assert.equal(local.scope.worker_generation, 2);
      assert.equal(local.scope.suspended, true);
      const guard = new CapabilityGuard({ verifier: verifier() });
      for (const [route] of expectedRoutes.filter(([, , gen]) => gen)) {
        assert.throws(() => guard.authorize(route, jwt(), local.scope, { liveGrant: true }), code('fenced_generation'), route);
        assert.throws(() => guard.authorize(route, jwt(delegated({ gen: 2 })), local.scope, { liveGrant: true }), code('revoked'), route);
      }
      local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null });
      assert.equal(local.scope.suspended, true, 'A null authority flag cannot undo a journal suspension');
    }
  });

  it('refuses duplicate processor_ref even when the evidence references differ', () => {
    const doc = authRecord();
    doc.processors.push({ ...doc.processors[0], evidence_ref: 'fixture-other-evidence' });
    assert.equal(validate(doc.contract, doc).ok, true, 'This requires the runtime uniqueness check');
    assert.throws(() => validateProcessingAuthorization(doc, scope(), doc.settings_sha256), status(400));
  });

  it('requires a contract-valid processing record even for local sessions, with exact settings/scope binding', () => {
    const doc = authRecord();
    assert.equal(validate(doc.contract, doc).ok, true);
    assert.deepEqual(validateProcessingAuthorization(doc, scope(), doc.settings_sha256), doc);
    for (const invalid of [undefined, null, { ...doc, participants: [] }, { ...doc, purposes: [] },
      { ...doc, basis_label: '' }, { ...doc, processors: [{ processor_ref: 'missing-fields' }] },
      { ...doc, participants: [...doc.participants, doc.participants[0]] },
      { ...doc, processors: [...doc.processors, doc.processors[0]] }]) {
      assert.throws(() => validateProcessingAuthorization(invalid, scope(), doc.settings_sha256), status(400));
    }
    assert.throws(() => validateProcessingAuthorization(doc, scope({ pid: 'foreign' }), doc.settings_sha256), status(403));
    assert.throws(() => validateProcessingAuthorization(doc, scope(), 'f'.repeat(64)), status(403));
    assert.throws(() => validateProcessingAuthorization(doc, scope({ auth_epoch: 2 }), doc.settings_sha256), code('revoked'));
    assert.throws(() => validateProcessingAuthorization({ ...doc, withdrawn_at: doc.created_at }, scope(), doc.settings_sha256), code('revoked'));
    assert.throws(() => validateProcessingAuthorization({ ...doc, major: 2 }, scope(), doc.settings_sha256), { status: 422, code: 'contract_too_new' });
  });

  it('consumes ordered JournalPort controls among turns and snapshots, and host resume only undoes suspend', async (t) => {
    const journal = new SqliteJournal(':memory:', { now: () => time });
    t.after(() => journal.close());
    journal.createSession(bytes(journalSession()));
    const local = localSession();
    journal.append(bytes(turn()), journalAuthority());
    journal.append(bytes(snapshot({ consumed_seq: 1 })), journalAuthority());
    journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), journalAuthority({ writer_kind: 'host' }));
    assert.equal(await local.consumeJournal(journal, journalAuthority()), 3);
    assert.equal(local.state, 'SUSPENDED');
    assert.throws(() => local.assertNewClaim(), code('revoked'));
    const stopped = local.outputSignal;
    journal.append(bytes(record('session.control', { action: 'resume' }, { writer: { kind: 'host' } })), journalAuthority({ writer_kind: 'host' }));
    assert.equal(await local.consumeJournal(journal, journalAuthority()), 4);
    assert.equal(local.state, 'ACTIVE');
    assert.equal(local.outputSignal.aborted, false);
    assert.equal(stopped.aborted, true);
    assert.equal(await local.consumeJournal(journal, journalAuthority()), 4);
  });

  it('journal epoch withdrawal drives local revocation even when the callback is lost', async (t) => {
    const journal = new SqliteJournal(':memory:', { now: () => time });
    t.after(() => journal.close());
    journal.createSession(bytes(journalSession()));
    const local = localSession();
    const stored = journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })), journalAuthority({ writer_kind: 'host' }));
    await assert.rejects(local.consumeJournal(journal, journalAuthority()), code('revoked'));
    assert.equal(local.state, 'REVOKED');
    // The authenticated host can forward the original ack, or use current-epoch reads.
    local.consumeStoredRecord(stored);
    assert.equal(local.scope.auth_epoch, 2);
    local.applyAuthority({ ...scope({ auth_epoch: 2 }), tombstone: null });
    assert.equal(local.state, 'REVOKED');
    await local.consumeJournal(journal, journalAuthority({ auth_epoch: 2 }));
    assert.equal(local.state, 'REVOKED');
  });

  it('tombstones are durable in the actual journal and cannot be undone by resume or a refreshed token', async (t) => {
    const journal = new SqliteJournal(':memory:', { now: () => time });
    t.after(() => journal.close());
    journal.createSession(bytes(journalSession()));
    const local = localSession();
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), journalAuthority({ writer_kind: 'host' }));
    local.consumeStoredRecord(stored);
    assert.equal(local.state, 'PURGING');
    for (const call of [() => journal.cursor(journalAuthority()), () => journal.takeover(journalAuthority()),
      () => journal.recordsAfter(0, journalAuthority()), () => journal.append(bytes(turn()), journalAuthority())]) {
      assert.throws(call, code('revoked'));
    }
    const resume = record('session.control', { action: 'resume' }, { writer: { kind: 'host' } });
    local.consumeStoredRecord({ bytes: bytes(resume), document: { ...resume, seq: 2 } });
    local.applyAuthority({ ...scope(), tombstone: null });
    assert.equal(local.state, 'PURGING');
    local.markPurged();
    assert.equal(local.state, 'PURGED');
    assert.throws(() => local.assertNewClaim(), code('revoked'));
    assert.throws(() => journal.append(bytes(resume), journalAuthority({ writer_kind: 'host' })), code('revoked'));
  });

  it('refuses forged, foreign, incompatible, unacknowledged and unordered journal projections', async () => {
    const local = localSession();
    const doc = record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
    const stored = { bytes: bytes(doc), document: { ...doc, seq: 1 } };
    for (const bad of [
      { bytes: bytes(doc), document: doc },
      { bytes: bytes(doc), document: { ...stored.document, data: { action: 'resume' } } },
      { bytes: bytes({ ...doc, sid: randomUUID() }), document: stored.document },
      { bytes: bytes({ ...doc, writer: { kind: 'browser' } }), document: { ...stored.document, writer: { kind: 'browser' } } },
      { bytes: bytes(stored.document), document: stored.document },
    ]) {
      assert.throws(() => local.consumeStoredRecord(bad));
      assert.equal(local.state, 'ACTIVE');
    }
    await assert.rejects(local.consumeJournal({ recordsAfter: () => [stored, stored] }, journalAuthority()), status(502));
    assert.equal(local.state, 'ACTIVE');
    local.consumeStoredRecord(stored);
    local.consumeStoredRecord(stored); // Identical callback replay is harmless.
    assert.equal(local.state, 'PURGING');
    const different = { ...doc, data: { action: 'resume' } };
    assert.throws(() => local.consumeStoredRecord({ bytes: bytes(different), document: { ...different, seq: 1 } }), code('idempotency_conflict'));
  });

  it('a healthy committed request finishes, settles once and delivers only with a genuine current output permit', async () => {
    const local = localSession();
    const receipt = { claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 };
    const outcomes = [];
    const result = await local.dispatchCommitted(receipt, async () => 'fixture output', {
      permit: local.outputPermit(), settle: async (claim, outcome) => { assert.deepEqual(claim, receipt); outcomes.push(outcome.outcome); },
    });
    assert.deepEqual(result, { delivered: true, value: 'fixture output' });
    assert.deepEqual(outcomes, ['settled']);
    assert.equal(local.inflightCount, 0);
    assert.throws(() => local.dispatchCommitted(receipt, () => {}, { settle: () => {} }), code('already_claimed'));
    const forgedPermit = { epoch: 1, generation: 1, revision: 0, active: true };
    const rejectedOutput = await local.dispatchCommitted({ ...receipt, claim_id: randomUUID() }, async () => 'untrusted permit', {
      permit: forgedPermit, settle: async (_, outcome) => { assert.equal(outcome.outcome, 'unknown'); },
    });
    assert.deepEqual(rejectedOutput, { delivered: false });
  });

  for (const scenario of ['response in flight', 'claim response in flight', 'generation takeover']) {
    it(`${scenario}: committed work may finish, is charged at maximum and discards late output`, async () => {
      const local = localSession();
      const receipt = { claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 };
      const permit = local.outputPermit();
      const provider = deferred();
      let charged = 0, sent = 0;
      const dispatch = () => local.dispatchCommitted(receipt, async () => { sent++; return provider.promise; }, {
        permit, settle: async (_, outcome) => { assert.equal(outcome.outcome, 'unknown'); charged = 500; },
      });
      let result;
      if (scenario !== 'claim response in flight') { result = dispatch(); await flush(); }
      if (scenario === 'generation takeover') local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null });
      else local.revoke(2);
      assert.equal(local.captureSignal.aborted, true);
      assert.equal(local.outputSignal.aborted, true);
      assert.equal(local.pendingSignal.aborted, true);
      assert.throws(() => local.assertNewClaim(), code(scenario === 'generation takeover' ? 'fenced_generation' : 'revoked'));
      if (scenario === 'claim response in flight') result = dispatch(); // No extra pre-send gate after commitment.
      provider.resolve('fixture late provider output');
      assert.deepEqual(await result, { delivered: false });
      assert.equal(sent, 1);
      assert.equal(charged, 500);
      assert.equal(local.inflightCount, 0);
    });
  }

  it('suspend/resume cannot resurrect output from an earlier output permit', async () => {
    const local = localSession();
    const permit = local.outputPermit();
    const suspended = record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } });
    local.consumeStoredRecord({ bytes: bytes(suspended), document: { ...suspended, seq: 1 } });
    const resumed = record('session.control', { action: 'resume' }, { writer: { kind: 'host' } });
    local.consumeStoredRecord({ bytes: bytes(resumed), document: { ...resumed, seq: 2 } });
    const result = await local.dispatchCommitted({ claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 }, () => 'late claim response', {
      permit, settle: async (_, outcome) => { assert.equal(outcome.outcome, 'unknown'); },
    });
    assert.deepEqual(result, { delivered: false });
    assert.equal(local.state, 'ACTIVE');
  });

  it('provider failure settles unknown; settlement failure is surfaced for host recovery', async () => {
    const local = localSession();
    const outcomes = [];
    const receipt = { claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 };
    await assert.rejects(local.dispatchCommitted(receipt, async () => { throw new Error('fixture provider failure'); }, {
      permit: local.outputPermit(), settle: async (_, result) => { outcomes.push(result.outcome); },
    }), /fixture provider failure/);
    assert.deepEqual(outcomes, ['unknown']);
    await assert.rejects(local.dispatchCommitted({ ...receipt, claim_id: randomUUID() }, async () => 'fixture result', {
      permit: local.outputPermit(), settle: async () => { throw new Error('fixture ledger failure'); },
    }), /fixture ledger failure/);
    assert.equal(local.inflightCount, 0);
    await local.drain();
  });

  it('journal reads also have a hard 10s deadline, without advancing the replay cursor', async () => {
    const fake = new FakeClock();
    const local = localSession();
    const refusal = assert.rejects(local.consumeJournal({ recordsAfter: () => new Promise(() => {}) }, journalAuthority(),
      { scheduler: fake.scheduler }), status(504));
    await fake.advance(10_000);
    await refusal;
    assert.equal(local.lastRecordSeq, 0);
  });
});

describe('(d) tombstone, bounded drain, cache deletion, host purge acknowledgement', () => {
  function setup(t, overrides = {}) {
    const fake = new FakeClock();
    const journal = new SqliteJournal(':memory:', { now: () => fake.clock.wallNow() });
    t.after(() => journal.close());
    journal.createSession(bytes(journalSession()));
    const local = localSession();
    const events = [];
    const artifacts = [`journal:${sid}`, 'intake:fixture-draft', 'budget:fixture-hold'];
    const cache = new Map([['fixture', 'synthetic cache content']]);
    const coordinator = new PurgeCoordinator({ journal: {
      append: (submitted, host) => {
        const document = JSON.parse(submitted);
        assert.equal(validate(document.contract, document).ok, true);
        assert.equal(document.writer.kind, 'host');
        events.push('tombstone');
        return journal.append(submitted, host);
      },
    }, session: local, clock: fake.clock, scheduler: fake.scheduler,
    hostArtifacts: () => { events.push('inventory'); return artifacts; },
    purgeCache: async () => { events.push('cache'); cache.clear(); },
    acknowledge: async (ack) => {
      assert.equal(cache.size, 0);
      assert.equal(local.state, 'PURGED');
      events.push('ack');
      assert.deepEqual(ack.host_artifacts, artifacts);
    }, ...overrides });
    return { fake, journal, local, events, artifacts, cache, coordinator };
  }
  const host = () => journalAuthority({ writer_kind: 'host' });

  it('tombstone is committed before cancellation/drain, then purges local cache and lists only host deletion refs', async (t) => {
    const { coordinator, events, cache, local, journal, artifacts } = setup(t);
    const ack = await coordinator.purge({ authority: host(), reason: 'fixture withdrawal' });
    assert.deepEqual(events, ['tombstone', 'inventory', 'cache', 'ack']);
    assert.deepEqual(ack, { sid, tombstone_seq: 1, drained: true, host_artifacts: artifacts });
    assert.ok(Object.isFrozen(ack.host_artifacts));
    assert.equal(cache.size, 0);
    assert.equal(local.state, 'PURGED');
    assert.throws(() => journal.cursor(journalAuthority()), code('revoked'));
    assert.throws(() => journal.createSession(bytes(journalSession())), { status: 409, message: 'Session already exists' },
      'The host session still exists; only the host can delete its artifacts');
  });

  it('authority polling completes a host purge even when the callback was lost and journal reads are denied', async (t) => {
    const { coordinator, fake, local, journal, cache, events, artifacts } = setup(t);
    let stored;
    let polls = 0;
    const monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator,
      clock: fake.clock, scheduler: fake.scheduler, fetchAuthority: () => {
        polls++;
        return authorityResponse(fake, stored ? { tombstone: 'purge', tombstone_record: stored } : {});
      } });
    monitor.start();
    await fake.advance(1);
    stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    assert.throws(() => journal.recordsAfter(0, journalAuthority()), code('revoked'));
    await fake.advance(29_999);
    assert.equal(local.state, 'PURGED');
    assert.equal(cache.size, 0);
    assert.deepEqual(events, ['inventory', 'cache', 'ack']);
    assert.deepEqual((await coordinator.complete(stored)).host_artifacts, artifacts);
    assert.equal(fake.timers.size, 0);
    await fake.advance(700_000);
    assert.equal(local.state, 'PURGED');
    assert.equal(polls, 2);
  });

  it('a purge learned through JournalPort runs the same bounded coordinator protocol', async (t) => {
    const { coordinator, fake, local, journal, events, cache } = setup(t);
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    // An authenticated host adapter forwards its receipt; ordinary post-purge
    // delegated reads remain forbidden by the journal.
    const port = { recordsAfter: () => [stored] };
    assert.equal(await local.consumeJournal(port, host(), { clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator }), 1);
    assert.equal(local.state, 'PURGED');
    assert.equal(cache.size, 0);
    assert.deepEqual(events, ['inventory', 'cache', 'ack']);
  });

  it('a purge flag without its original stored record fails closed and still ends after 10min', async (t) => {
    const { coordinator, fake, local, cache, events } = setup(t);
    const monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator,
      clock: fake.clock, scheduler: fake.scheduler, fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge' }) });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.scope.tombstone, 'purge');
    assert.equal(monitor.lastError.status, 502);
    assert.equal(cache.size, 1);
    assert.deepEqual(events, []);
    await fake.advance(600_000);
    assert.equal(local.state, 'ENDED');
    assert.equal(fake.timers.size, 0);
    assert.equal(cache.size, 1);
    const doc = record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
    await coordinator.complete({ bytes: bytes(doc), document: { ...doc, seq: 1 } });
    assert.equal(local.state, 'PURGED', 'Late original host receipt can still finish deletion after end');
    assert.equal(cache.size, 0);
  });

  it('invalid or stale authority tombstone records cannot cause cache deletion or acknowledgement', async (t) => {
    for (const mode of ['foreign', 'projection', 'suspend', 'stale', 'missing coordinator']) {
      const { coordinator, fake, local, cache, events } = setup(t);
      const doc = record('session.control', { action: mode === 'suspend' ? 'suspend' : 'purge' },
        { writer: { kind: 'host' }, ...(mode === 'foreign' ? { sid: randomUUID() } : {}) });
      const stored = { bytes: bytes(doc), document: { ...doc, seq: 1 } };
      if (mode === 'projection') stored.document.client_event_id = randomUUID();
      const monitor = new AuthorityMonitor({ session: local,
        ...(mode === 'missing coordinator' ? {} : { purgeCoordinator: coordinator }), clock: fake.clock, scheduler: fake.scheduler,
        fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored,
          ...(mode === 'stale' ? { issued_at: fake.issued(fake.mono - 30_001) } : {}) }) });
      monitor.start();
      await fake.advance(0);
      assert.ok(monitor.lastError, mode);
      assert.equal(cache.size, 1, mode);
      assert.deepEqual(events, [], mode);
      assert.equal(local.state, mode === 'stale' ? 'ACTIVE' : 'PURGING', mode);
      monitor.stop();
    }
  });

  it('waits for committed work to settle within the drain deadline and then discards its output', async (t) => {
    const { coordinator, fake, local, events } = setup(t);
    const provider = deferred();
    const finish = local.dispatchCommitted({ claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 }, () => provider.promise, {
      permit: local.outputPermit(), settle: async (_, result) => { assert.equal(result.outcome, 'unknown'); events.push('settle'); },
    });
    const purging = coordinator.purge({ authority: host() });
    await fake.advance(5000);
    assert.equal(local.state, 'PURGING');
    assert.deepEqual(events, ['tombstone', 'inventory']);
    provider.resolve('late fixture output');
    assert.deepEqual(await finish, { delivered: false });
    const ack = await purging;
    assert.equal(ack.drained, true);
    assert.deepEqual(events, ['tombstone', 'inventory', 'settle', 'cache', 'ack']);
  });

  it('drain stops waiting at exactly 10s even if the committed provider ignores cancellation', async (t) => {
    const { coordinator, fake, local, events, cache } = setup(t);
    const provider = deferred();
    let charged = 0;
    const finish = local.dispatchCommitted({ claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 }, () => provider.promise, {
      permit: local.outputPermit(), settle: async (_, result) => { assert.equal(result.outcome, 'unknown'); charged = 500; },
    });
    const purging = coordinator.purge({ authority: host() });
    await fake.advance(9999);
    assert.equal(local.state, 'PURGING');
    assert.equal(cache.size, 1);
    await fake.advance(1);
    const ack = await purging;
    assert.equal(ack.drained, false);
    assert.equal(fake.mono - fake.origin, 10_000);
    assert.equal(local.state, 'PURGED');
    assert.deepEqual(events, ['tombstone', 'inventory', 'cache', 'ack']);
    assert.equal(local.inflightCount, 1);
    provider.resolve('post-purge fixture response');
    assert.deepEqual(await finish, { delivered: false });
    assert.equal(charged, 500);
    assert.equal(local.inflightCount, 0);
  });

  it('a committed claim response arriving during purge joins the remaining bounded drain', async (t) => {
    const { coordinator, fake, local, cache } = setup(t);
    const first = deferred();
    const second = deferred();
    const permit = local.outputPermit();
    const dispatch = (provider) => local.dispatchCommitted({ claim_id: randomUUID(), auth_epoch: 1, worker_generation: 1 }, () => provider.promise, {
      permit, settle: async (_, result) => { assert.equal(result.outcome, 'unknown'); },
    });
    const firstCompletion = dispatch(first);
    const purging = coordinator.purge({ authority: host() });
    await fake.advance(5000);
    const lateClaimResponse = dispatch(second);
    first.resolve('first fixture response');
    await firstCompletion;
    await flush();
    assert.equal(local.state, 'PURGING');
    assert.equal(cache.size, 1);
    await fake.advance(4999);
    assert.equal(local.state, 'PURGING');
    await fake.advance(1);
    assert.equal((await purging).drained, false);
    assert.equal(local.state, 'PURGED');
    second.resolve('second fixture response');
    assert.deepEqual(await lateClaimResponse, { delivered: false });
  });

  it('never drains or purges before a failed/unacknowledged tombstone append', async (t) => {
    const { coordinator, events, cache, local } = setup(t, { journal: { append: () => { throw new Error('fixture host unavailable'); } } });
    await assert.rejects(coordinator.purge({ authority: host() }), /fixture host unavailable/);
    assert.deepEqual(events, []);
    assert.equal(cache.size, 1);
    assert.equal(local.state, 'ACTIVE');
    assert.throws(() => coordinator.purge({ authority: journalAuthority() }), status(403));
    assert.deepEqual(events, []);
  });

  it('bounds tombstone requests to 10s and preserves exact bytes/id across transport retries', async (t) => {
    let attempts = 0;
    const submitted = [];
    const { coordinator, fake, cache, local } = setup(t, { journal: { append: (original) => {
      submitted.push(Buffer.from(original));
      attempts++;
      if (attempts === 1) return new Promise(() => {});
      return { bytes: original, document: { ...JSON.parse(original), seq: 1 } };
    } } });
    const refusal = assert.rejects(coordinator.purge({ authority: host() }), status(504));
    await fake.advance(10_000);
    await refusal;
    assert.equal(local.state, 'ACTIVE');
    assert.equal(cache.size, 1);
    const ack = await coordinator.purge({ authority: host() });
    assert.equal(ack.drained, true);
    assert.equal(attempts, 2);
    assert.deepEqual(submitted[0], submitted[1]);
  });

  for (const elapsed of [10_000, 10_001]) {
    it(`adopts a byte-exact committed purge receipt resolved at ${elapsed}ms despite an overdue timer`, async (t) => {
      let attempts = 0;
      const { coordinator, fake, local, journal, cache } = setup(t, { journal: { append: (original, authority) => {
        attempts++;
        const stored = journal.append(original, authority);
        fake.mono += elapsed; // Delayed event loop: resolution wins the microtask before the timer.
        return stored;
      } } });
      const result = await coordinator.purge({ authority: host() });
      assert.equal(result.tombstone_seq, 1);
      assert.equal(local.state, 'PURGED');
      assert.equal(cache.size, 0);
      await coordinator.purge({ authority: host() });
      assert.equal(attempts, 1, 'Never replay a tombstone whose original receipt was received');
      assert.equal(fake.timers.size, 0);
    });
  }

  it('retains a valid purge receipt arriving after timeout so retry needs no second append', async (t) => {
    const response = deferred();
    let attempts = 0, stored;
    const { coordinator, fake, local, journal } = setup(t, { journal: { append: (original, authority) => {
      attempts++;
      stored = journal.append(original, authority);
      return response.promise;
    } } });
    const refusal = assert.rejects(coordinator.purge({ authority: host() }), status(504));
    await fake.advance(10_000);
    await refusal;
    assert.equal(local.state, 'ACTIVE');
    response.resolve(stored);
    await flush();
    const result = await coordinator.purge({ authority: host() });
    assert.equal(result.tombstone_seq, 1);
    assert.equal(local.state, 'PURGED');
    assert.equal(attempts, 1);
  });

  it('documents the JournalPort lost-response replay blocker and can recover from the host original receipt', async (t) => {
    let stored;
    const { coordinator, fake, local, journal } = setup(t, { journal: { append: (original, authority) => {
      const result = journal.append(original, authority);
      stored = result;
      return new Promise(() => {}); // The response is lost permanently after commitment.
    } } });
    const refusal = assert.rejects(coordinator.purge({ authority: host() }), status(504));
    await fake.advance(10_000);
    await refusal;
    await assert.rejects(coordinator.purge({ authority: host() }), code('revoked'),
      'JournalPort currently authorizes before its idempotent lookup; coordinator must fix this outside AIT-39 ownership');
    assert.equal(local.state, 'ACTIVE');
    assert.equal((await coordinator.complete(stored)).tombstone_seq, 1);
    assert.equal(local.state, 'PURGED');
  });

  it('can finish from the host-forwarded original journal ack when post-tombstone reads are denied', async (t) => {
    const { coordinator, journal, events, local } = setup(t);
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    assert.throws(() => journal.recordsAfter(0, journalAuthority()), code('revoked'));
    const first = coordinator.complete(stored);
    const second = coordinator.complete(stored);
    assert.equal(first, second, 'Concurrent delivery is coalesced');
    assert.equal((await first).tombstone_seq, 1);
    assert.deepEqual(events, ['inventory', 'cache', 'ack']);
    assert.equal(local.state, 'PURGED');
    await coordinator.complete(stored);
    assert.deepEqual(events, ['inventory', 'cache', 'ack', 'ack'], 'Retry acknowledges the same result, without repeating deletion');
    await coordinator.purge({ authority: host() });
    assert.deepEqual(events, ['inventory', 'cache', 'ack', 'ack', 'ack'], 'Host-originated completion also retains its receipt for purge retries');
  });

  it('concurrent purge callers still verify host authentication and original tombstone identity', async (t) => {
    const response = deferred();
    const { coordinator, local, journal, cache } = setup(t, { acknowledge: () => response.promise });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    const completion = coordinator.complete(stored);
    await flush();
    assert.equal(local.state, 'PURGED');
    assert.equal(cache.size, 0);
    assert.throws(() => coordinator.purge({ authority: journalAuthority() }), status(403));
    const suspend = record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } });
    await assert.rejects(coordinator.complete({ bytes: bytes(suspend), document: { ...suspend, seq: 2 } }), status(403));
    const { seq, ...original } = stored.document;
    const changed = { ...original, client_event_id: randomUUID() };
    await assert.rejects(coordinator.complete({ bytes: bytes(changed), document: { ...changed, seq } }), status(409));
    assert.equal(coordinator.complete(stored), completion);
    response.resolve();
    await completion;
  });

  it('cache deletion failures keep PURGING and suppress acknowledgement until a successful retry', async (t) => {
    let available = false, purgeCalls = 0, ackCalls = 0;
    const { coordinator, local } = setup(t, {
      purgeCache: async () => { purgeCalls++; if (!available) throw new Error('fixture cache locked'); },
      acknowledge: async () => { ackCalls++; },
    });
    await assert.rejects(coordinator.purge({ authority: host() }), /fixture cache locked/);
    assert.equal(local.state, 'PURGING');
    assert.equal(ackCalls, 0);
    assert.throws(() => local.assertNewClaim(), code('revoked'));
    available = true;
    await coordinator.purge({ authority: host() });
    assert.equal(local.state, 'PURGED');
    assert.equal(purgeCalls, 2);
    assert.equal(ackCalls, 1);
  });

  it('acknowledgement timeout retries a stable result without rewriting a tombstone or repurging cache', async (t) => {
    let ackCalls = 0;
    const { coordinator, fake, events, local } = setup(t, { acknowledge: () => {
      ackCalls++;
      return ackCalls === 1 ? new Promise(() => {}) : Promise.resolve();
    } });
    const refusal = assert.rejects(coordinator.purge({ authority: host() }), status(504));
    await fake.advance(10_000);
    await refusal;
    assert.equal(local.state, 'PURGED');
    assert.deepEqual(events, ['tombstone', 'inventory', 'cache']);
    const result = await coordinator.purge({ authority: host() });
    assert.equal(result.tombstone_seq, 1);
    assert.equal(ackCalls, 2);
    assert.deepEqual(events, ['tombstone', 'inventory', 'cache']);
  });

  it('refuses changed host acknowledgement bytes, non-purge controls and foreign tombstones', async (t) => {
    const { coordinator, journal, local, events } = setup(t);
    for (const data of [{ action: 'suspend' }, { action: 'resume' }]) {
      const doc = record('session.control', data, { writer: { kind: 'host' } });
      await assert.rejects(coordinator.complete({ bytes: bytes(doc), document: { ...doc, seq: 1 } }), status(403));
    }
    const foreign = record('session.control', { action: 'purge' }, { sid: randomUUID(), writer: { kind: 'host' } });
    await assert.rejects(coordinator.complete({ bytes: bytes(foreign), document: { ...foreign, seq: 1 } }), status(502));
    assert.equal(local.state, 'ACTIVE');
    assert.deepEqual(events, []);
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    await coordinator.complete(stored);
    const changed = { ...stored.document, data: { action: 'purge', reason: 'different' } };
    const { seq, ...original } = changed;
    await assert.rejects(coordinator.complete({ bytes: bytes(original), document: changed }), status(409));
    assert.equal(local.state, 'PURGED');
  });

  it('rejects a byte-consistent tombstone acknowledgement for a different submission', async (t) => {
    const { coordinator, local, events } = setup(t, { journal: { append: (original) => {
      const changed = { ...JSON.parse(original), client_event_id: randomUUID() };
      return { bytes: bytes(changed), document: { ...changed, seq: 1 } };
    } } });
    await assert.rejects(coordinator.purge({ authority: host() }), status(502));
    assert.equal(local.state, 'ACTIVE');
    assert.deepEqual(events, []);
  });

  for (const mode of ['different id', 'invalid projection', 'noncanonical original bytes']) {
    it(`retries append after ${mode} rather than caching a bad purge acknowledgement`, async (t) => {
      let attempts = 0;
      const submitted = [];
      const { coordinator, local, events, cache } = setup(t, { journal: { append: (original) => {
        submitted.push(Buffer.from(original));
        attempts++;
        const doc = JSON.parse(original);
        if (attempts > 1) return { bytes: original, document: { ...doc, seq: 1 } };
        if (mode === 'different id') {
          const changed = { ...doc, client_event_id: randomUUID() };
          return { bytes: bytes(changed), document: { ...changed, seq: 1 } };
        }
        if (mode === 'invalid projection') return { bytes: original, document: { ...doc, seq: 0 } };
        return { bytes: Buffer.from(JSON.stringify(doc, null, 2)), document: { ...doc, seq: 1 } };
      } } });
      await assert.rejects(coordinator.purge({ authority: host() }), status(502));
      assert.equal(local.state, 'ACTIVE');
      assert.equal(cache.size, 1);
      assert.deepEqual(events, []);
      assert.equal((await coordinator.purge({ authority: host() })).tombstone_seq, 1);
      assert.equal(attempts, 2);
      assert.deepEqual(submitted[1], submitted[0]);
      assert.equal(local.state, 'PURGED');
    });
  }

  it('invalid host artifact inventory cannot claim cache deletion was completed', async (t) => {
    const { coordinator, events, local } = setup(t, { hostArtifacts: () => ['fixture-ref', 'fixture-ref'] });
    await assert.rejects(coordinator.purge({ authority: host() }), TypeError);
    assert.equal(local.state, 'PURGING');
    assert.deepEqual(events, ['tombstone']);
  });
});
