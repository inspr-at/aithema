import { describe, it } from 'node:test';
import { transition } from '../runtime/authz/transition.js';
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

  for (const delay of [0, 9000, 9999]) for (const control of ['epoch', 'suspend', 'purge']) {
    it(`a +60s clock spike followed by honest ${control} stops old signals within 45s with ${delay}ms responses`, async () => {
      const fake = new FakeClock();
      const local = localSession();
      const originals = [local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal];
      let calls = 0;
      const monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
        fetchAuthority: () => new Promise((resolve) => fake.scheduler.setTimeout(() => {
          const patch = ++calls === 1 ? { issued_at: fake.issued(fake.mono + 60_000) }
            : control === 'epoch' ? { auth_epoch: 2 } : { tombstone: control };
          resolve(authorityResponse(fake, patch));
        }, delay)) });
      monitor.start();
      await fake.advance(delay);
      assert.equal(local.state, 'ACTIVE');
      assert.equal(monitor.lastAuthorityMonotonic, fake.mono);
      const changedAt = fake.mono + 1;
      await fake.advance(30_000);
      assert.equal(local.state, control === 'epoch' ? 'REVOKED' : control === 'suspend' ? 'SUSPENDED' : 'PURGING');
      assert.ok(fake.mono - changedAt <= 45_000);
      assert.ok(originals.every((signal) => signal.aborted));
      assert.throws(() => local.assertNewClaim(), code('revoked'));
      // Purge lacks the original host receipt, but still stops immediately.
      if (control !== 'purge') assert.equal(monitor.lastError, null);
      monitor.stop();
    });
  }

  it('local receipt renews freshness even when a plausible host clock is 30s behind', async () => {
    const fake = new FakeClock();
    let available = true;
    const local = localSession();
    const monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => available
        ? authorityResponse(fake, { issued_at: fake.issued(fake.mono - 30_000) }) : new Promise(() => {}) });
    monitor.start();
    await fake.advance(30_000);
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 30_000);
    available = false;
    await fake.advance(69_999);
    assert.equal(local.state, 'ACTIVE');
    await fake.advance(1);
    assert.equal(local.state, 'CAPTURE_ONLY');
    assert.equal(fake.mono - fake.origin - 30_000, 70_000);
    await fake.advance(529_999);
    assert.equal(local.state, 'CAPTURE_ONLY');
    await fake.advance(1);
    assert.equal(local.state, 'ENDED');
  });

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
    session.revoke(2);
    assert.equal(originalCapture.aborted, true, 'Recovery cannot orphan an earlier text capture signal');
    assert.equal(session.captureSignal.aborted, true);
    monitor.stop();
  });

  it('valid 30s old responses use local receipt time for outage/10min origins', async () => {
    const fake = new FakeClock();
    const oldIssued = fake.issued();
    const session = localSession();
    const monitor = new AuthorityMonitor({ session, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { issued_at: oldIssued }) });
    monitor.start();
    await fake.advance(30_000);
    assert.equal(monitor.lastError, null, '30s boundary is fresh');
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 30_000, 'Only local receipt renews authority');
    await fake.advance(40_000);
    assert.equal(session.state, 'ACTIVE');
    await fake.advance(20_000);
    assert.equal(session.state, 'CAPTURE_ONLY');
    assert.equal(monitor.lastError.status, 503);
    await fake.advance(539_999);
    assert.equal(session.state, 'CAPTURE_ONLY');
    await fake.advance(1);
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

  it('a lifecycle observer stopping the monitor cannot create new authority timers after stop', async () => {
    const fake = new FakeClock();
    let monitor, epoch = 1, polls = 0;
    const local = localSession({ onChange: ({ state }) => { if (state === 'REVOKED') monitor.stop(); } });
    monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => { polls++; return authorityResponse(fake, { auth_epoch: epoch }); } });
    monitor.start();
    await fake.advance(0);
    epoch = 2;
    await fake.advance(30_000);
    assert.equal(local.state, 'REVOKED');
    assert.equal(fake.timers.size, 0);
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin);
    await fake.advance(700_000);
    assert.equal(polls, 2);
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

  it('accepts a later response with an older plausible issued_at and renews only at local receipt', async () => {
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
    assert.equal(monitor.lastError, null);
    assert.equal(monitor.lastAuthorityMonotonic, fake.origin + 60_000);
    monitor.stop();
  });
});

describe('(a, c, e) processing authorization, revocation and journal tombstones', () => {
  const storedControl = (action, seq = 1) => {
    const doc = record('session.control', { action }, { writer: { kind: 'host' } });
    return { bytes: bytes(doc), document: { ...doc, seq } };
  };

  it('an abort listener queues nested applyAuthority until captureOnly stops and notifies completely', () => {
    const observations = [];
    let afterNested;
    const local = localSession({ onChange: ({ state }) => observations.push({ state, actual: local.state,
      aborted: [local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal].map((signal) => signal.aborted) }) });
    const originals = [local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal];
    originals[1].addEventListener('abort', () => {
      local.applyAuthority({ ...scope(), tombstone: null });
      afterNested = local.state;
    }, { once: true });
    local.captureOnly();
    assert.equal(afterNested, 'CAPTURE_ONLY', 'A re-entrant call enqueues and returns without transitioning');
    assert.deepEqual(observations, [
      { state: 'CAPTURE_ONLY', actual: 'CAPTURE_ONLY', aborted: [false, true, true, true] },
      { state: 'ACTIVE', actual: 'ACTIVE', aborted: [false, false, false, false] },
    ]);
    assert.equal(local.state, 'ACTIVE');
    local.assertNewClaim();
    assert.ok([local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => !signal.aborted));
    local.revoke();
    assert.ok(originals.every((signal) => signal.aborted), 'The queue retains historical capture signals too');
  });

  for (const [name, enqueue, final] of [
    ['revoke', (local) => local.revoke(2), 'REVOKED'],
    ['captureOnly', (local) => local.captureOnly(), 'CAPTURE_ONLY'],
    ['end', (local) => local.end(), 'ENDED'],
    ['applyAuthority', (local) => local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null }), 'FENCED'],
    ['consumeStoredRecord suspend', (local) => local.consumeStoredRecord(storedControl('suspend')), 'SUSPENDED'],
    ['consumeStoredRecord resume', (local) => local.consumeStoredRecord(storedControl('resume', 2)), 'ACTIVE'],
  ]) it(`an onChange observer queues ${name} until the current notification completes`, () => {
    const notifications = [];
    let inside;
    let queued = false;
    const local = localSession({ onChange: ({ state }) => {
      notifications.push([state, local.state]);
      if (!queued && (name !== 'captureOnly' || state === 'ACTIVE')) {
        queued = true;
        enqueue(local);
        inside = local.state;
      }
    } });
    const initial = name === 'captureOnly' ? 'ACTIVE' : name.endsWith('resume') ? 'SUSPENDED' : 'CAPTURE_ONLY';
    if (initial === 'SUSPENDED') local.consumeStoredRecord(storedControl('suspend'));
    else if (initial === 'ACTIVE') {
      local.consumeStoredRecord(storedControl('suspend'));
      local.consumeStoredRecord(storedControl('resume', 2));
    }
    else local.captureOnly();
    assert.equal(inside, initial);
    assert.equal(local.state, final);
    const expected = initial === final ? [[initial, initial]] : [[initial, initial], [final, final]];
    if (initial === 'ACTIVE') expected.unshift(['SUSPENDED', 'SUSPENDED']);
    assert.deepEqual(notifications, expected);
    assert.ok([local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted === (final !== 'ACTIVE')));
  });

  it('callers have no public purge completion or acknowledgement setter', () => {
    const local = localSession();
    assert.equal(local.markPurged, undefined);
    assert.equal(local.markPurgeAcknowledged, undefined);
    assert.equal(local.dispatch, undefined);
  });

  it('only the internal receipt event with every completed step can enter PURGED', () => {
    const doc = record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
    const stored = { document: { ...doc, seq: 1 }, bytes: bytes(doc).toString('base64') };
    let state = transition(null, { type: 'start', scope: scope() }).state;
    state = transition(state, { type: 'journal-record', record: stored }).state;
    const phases = [state];
    for (const [step, value] of [['begin', 10_000], ['inventory', ['journal:fixture']], ['drain', true], ['cache', true]]) {
      state = transition(state, { type: 'purge-step-completed', step, value }).state;
      phases.push(state);
    }
    const receipt = state.purge.receipt;
    for (const partial of phases.slice(0, -1)) {
      assert.throws(() => transition(partial, { type: 'purge_acknowledged', receipt }), status(409));
    }
    assert.throws(() => transition(phases[0], { type: 'purge-step-completed', step: 'begin', value: NaN }), TypeError);
    assert.throws(() => transition(phases[2], { type: 'purge-step-completed', step: 'drain', value: null }), TypeError);
    assert.throws(() => transition(phases[3], { type: 'purge-step-completed', step: 'cache', value: false }), TypeError);
    for (const [index, partial] of phases.entries()) for (const step of ['begin', 'inventory', 'drain', 'cache']) {
      if (step !== ['begin', 'inventory', 'drain', 'cache', 'acknowledgement'][index]) {
        assert.throws(() => transition(partial, { type: 'purge-step-completed', step, value: true }), status(409));
      }
    }
    for (const [name, value] of [['drainDeadline', null], ['artifacts', null], ['drained', null], ['cacheDeleted', false], ['receipt', null]]) {
      const partial = structuredClone(state);
      partial.purge[name] = value;
      assert.throws(() => transition(partial, { type: 'purge_acknowledged', receipt }), status(409), name);
      if (name === 'receipt') assert.throws(() => transition(partial, { type: 'purge_acknowledged', receipt: null }), status(409));
    }
    for (const [name, value] of [['status', 'ENDED'], ['purgeRecord', null]]) {
      assert.throws(() => transition({ ...state, [name]: value }, { type: 'purge_acknowledged', receipt }), status(409), name);
    }
    assert.throws(() => transition({ ...state, scope: { ...state.scope, tombstone: null } },
      { type: 'purge_acknowledged', receipt }), status(409));
    for (const changed of [{ ...receipt, sid: randomUUID() }, { ...receipt, tombstone_seq: 2 },
      { ...receipt, drained: false }, { ...receipt, host_artifacts: [] }]) {
      assert.throws(() => transition(state, { type: 'purge_acknowledged', receipt: changed }), status(409));
    }
    for (const type of ['cache-purged', 'purge-acknowledged', 'markPurged', 'markPurgeAcknowledged']) {
      assert.throws(() => transition(state, { type, receipt }), TypeError, type);
    }
    for (const event of [{ type: 'revoke', epoch: 2 }, { type: 'capture-only' }, { type: 'end' },
      { type: 'authority', authority: { ...scope(), tombstone: 'purge' } },
      { type: 'journal-record', record: stored }, { type: 'redrive-purge', record: stored }]) {
      assert.equal(transition(state, event).state.status, 'PURGING', event.type);
    }
    const completed = transition(state, { type: 'purge_acknowledged', receipt });
    assert.equal(completed.state.status, 'PURGED');
    assert.equal(completed.state.purgeAcknowledged, true);
    assert.deepEqual(completed.state.purge.receipt, receipt);
    assert.equal(completed.effects.at(-1).type, 'notify');
    for (const event of [{ type: 'revoke', epoch: 2 }, { type: 'end' }, { type: 'capture-only' },
      { type: 'authority', authority: { ...scope(), tombstone: null } },
      { type: 'authority', authority: { ...scope(), tombstone: 'purge' } },
      { type: 'journal-record', record: stored }, { type: 'redrive-purge', record: stored }]) {
      const terminal = transition(completed.state, event);
      assert.equal(terminal.state.status, 'PURGED', event.type);
      assert.equal(terminal.state.purgeAcknowledged, true);
      assert.deepEqual(terminal.effects, [], 'Terminal inputs cannot re-drive or notify purge');
    }
  });

  it('queued authority inputs retain their call-time bytes when an observer mutates its object', () => {
    const authority = { ...scope({ auth_epoch: 2 }), tombstone: null };
    let once = false;
    const local = localSession({ onChange: () => {
      if (once) return;
      once = true;
      local.applyAuthority(authority);
      authority.auth_epoch = 1;
      authority.pid = 'fixture-mutated';
    } });
    local.captureOnly();
    assert.equal(local.state, 'REVOKED');
    assert.equal(local.scope.auth_epoch, 2);
  });

  it('an observer failure cannot strand queued revocation or leave the drain loop locked', () => {
    const local = localSession({ onChange: ({ state }) => {
      if (state === 'CAPTURE_ONLY') { local.revoke(2); throw new Error('fixture observer failed'); }
    } });
    assert.throws(() => local.captureOnly(), /fixture observer failed/);
    assert.equal(local.state, 'REVOKED');
    assert.ok([local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted));
    local.end();
    assert.equal(local.state, 'ENDED');
  });

  for (const [name, apply, expected] of [
    ['callback revoke', (local) => local.revoke(2), 'REVOKED'],
    ['authority epoch', (local) => local.applyAuthority({ ...scope({ auth_epoch: 2 }), tombstone: null }), 'REVOKED'],
    ['authority generation', (local) => local.applyAuthority({ ...scope({ worker_generation: 2 }), tombstone: null }), 'FENCED'],
    ['authority suspend', (local) => local.applyAuthority({ ...scope(), tombstone: 'suspend' }), 'SUSPENDED'],
    ['authority purge', (local) => local.applyAuthority({ ...scope(), tombstone: 'purge' }), 'PURGING'],
    ['journal suspend', (local) => local.consumeStoredRecord(storedControl('suspend')), 'SUSPENDED'],
    ['journal purge', (local) => local.consumeStoredRecord(storedControl('purge')), 'PURGING'],
    ['journal epoch', (local) => {
      const doc = record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } });
      local.consumeStoredRecord({ bytes: bytes(doc), document: { ...doc, seq: 1 } });
    }, 'REVOKED'],
    ['session end', (local) => local.end(), 'ENDED'],
  ]) it(`${name} stops every signal issued across repeated outage/resume cycles`, () => {
    const local = localSession();
    const captures = [], stopped = [];
    for (let i = 0; i < 3; i++) {
      captures.push(local.captureSignal);
      stopped.push(local.microphoneSignal, local.outputSignal, local.pendingSignal);
      local.captureOnly();
      assert.equal(local.state, 'CAPTURE_ONLY');
      assert.ok(captures.every((signal) => !signal.aborted));
      assert.ok(stopped.every((signal) => signal.aborted));
      local.applyAuthority({ ...scope(), tombstone: null });
      assert.equal(local.state, 'ACTIVE');
    }
    captures.push(local.captureSignal);
    stopped.push(local.microphoneSignal, local.outputSignal, local.pendingSignal);
    apply(local);
    assert.equal(local.state, expected);
    assert.ok([...captures, ...stopped].every((signal) => signal.aborted));
  });

  it('end directly from CAPTURE_ONLY stops earlier text capture and keeps every other channel stopped', () => {
    const local = localSession();
    const capture = local.captureSignal;
    local.captureOnly();
    local.end();
    assert.equal(local.state, 'ENDED');
    assert.ok([capture, local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted));
  });

  for (const [status, input] of [
    ['CAPTURE_ONLY', { type: 'capture-only' }],
    ['SUSPENDED', { type: 'authority', authority: { ...scope(), tombstone: 'suspend' } }],
    ['REVOKED', { type: 'revoke', epoch: 2 }],
    ['FENCED', { type: 'authority', authority: { ...scope({ worker_generation: 2 }), tombstone: null } }],
    ['PURGING', { type: 'authority', authority: { ...scope(), tombstone: 'purge' } }],
    ['PURGED', { type: 'purge_acknowledged' }],
    ['ENDED', { type: 'end' }],
  ]) it(`the pure ${status} transition owns its complete signal stop effect`, () => {
    let event = input;
    let initial = transition(null, { type: 'start', scope: scope() }).state;
    if (status === 'PURGED') {
      const doc = record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
      initial = transition(initial, { type: 'journal-record', record: { document: { ...doc, seq: 1 }, bytes: bytes(doc).toString('base64') } }).state;
      for (const [step, value] of [['begin', 10_000], ['inventory', []], ['drain', true], ['cache', true]]) {
        initial = transition(initial, { type: 'purge-step-completed', step, value }).state;
      }
      event = { ...event, receipt: initial.purge.receipt };
    }
    const original = JSON.stringify(initial);
    const result = transition(initial, event);
    assert.equal(JSON.stringify(initial), original, 'No input mutation');
    assert.deepEqual(result, transition(initial, event), 'Deterministic pure transition');
    assert.equal(result.state.status, status);
    assert.deepEqual(result.effects.filter((effect) => effect.type === 'stop-signals').map((effect) => effect.channels),
      [status === 'CAPTURE_ONLY' ? ['microphone', 'output', 'pending'] : ['capture', 'microphone', 'output', 'pending']]);
    assert.equal(result.state.revision, initial.revision + 1);
    assert.ok(Object.isFrozen(result.state.scope));
  });

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
    assert.equal(local.markPurged, undefined, 'A tombstone alone cannot complete purge');
    assert.equal(local.state, 'PURGING');
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
    const local = overrides.session ?? localSession();
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
      assert.equal(local.state, 'PURGING');
      assert.equal(local.purgeAcknowledged, false);
      assert.equal(local.purgeProgress.cacheDeleted, true);
      events.push('ack');
      assert.deepEqual(ack.host_artifacts, artifacts);
    }, ...overrides });
    return { fake, journal, local, events, artifacts, cache, coordinator };
  }
  const host = () => journalAuthority({ writer_kind: 'host' });

  it('purge step adapters run inside the draining event before its observer notification', async (t) => {
    const ordering = [];
    const local = localSession({ onChange: ({ state }) => ordering.push(`observe:${state}`) });
    const { coordinator } = setup(t, { session: local });
    const performStep = coordinator.performStep.bind(coordinator);
    coordinator.performStep = (step, stored, progress) => {
      ordering.push(`step:${step}`);
      return performStep(step, stored, progress);
    };
    await coordinator.purge({ authority: host() });
    assert.deepEqual(ordering, ['step:begin', 'observe:PURGING', 'step:inventory', 'step:drain', 'step:cache', 'step:acknowledgement', 'observe:PURGED']);
  });

  it('a failed purge clock origin leaves a retryable begin step without deletion or acknowledgement', async (t) => {
    let invalid = true;
    const { fake, local, journal, coordinator, cache, events } = setup(t, {
      clock: { monotonicNow: () => invalid ? NaN : fake.clock.monotonicNow(), wallNow: () => time },
    });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    await assert.rejects(coordinator.complete(stored), /Finite purge clock origin required/);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.purgeProgress.retry.step, 'begin');
    assert.equal(local.purgeProgress.drainDeadline, null);
    assert.equal(local.purgeAcknowledged, false);
    assert.equal(cache.size, 1);
    assert.deepEqual(events, []);
    invalid = false;
    await coordinator.complete(stored);
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
    assert.deepEqual(events, ['inventory', 'cache', 'ack']);
  });

  it('coordinator completion is coalesced before a purge callback can re-enter it', async (t) => {
    let stored, nested;
    const { coordinator, journal, local } = setup(t, { hostArtifacts: () => {
      nested = coordinator.complete(stored);
      return [];
    }, acknowledge: () => {} });
    stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    const completion = coordinator.complete(stored);
    assert.equal(nested, completion);
    const receipt = await completion;
    assert.equal(await nested, receipt);
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
  });

  for (const entry of ['complete', 'journal', 'authority']) for (const callback of ['observer', 'abort listener']) {
    it(`${entry}: a ${callback} cannot queue public markPurged before the purge body`, async (t) => {
      const attempts = [];
      const notifications = [];
      const attempt = () => {
        const before = local.state;
        local.markPurged?.();
        local.markPurgeAcknowledged?.();
        attempts.push({ before, after: local.state, setter: typeof local.markPurged,
          ackSetter: typeof local.markPurgeAcknowledged, acknowledged: local.purgeAcknowledged });
      };
      const local = localSession({ onChange: ({ state }) => {
        notifications.push([state, local.purgeAcknowledged]);
        if (callback === 'observer' && state === 'PURGING') attempt();
      } });
      if (callback === 'abort listener') local.captureSignal.addEventListener('abort', attempt, { once: true });
      const { fake, journal, coordinator, cache, events, artifacts } = setup(t, { session: local });
      const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
      if (entry === 'complete') await coordinator.complete(stored);
      else if (entry === 'journal') await local.consumeJournal({ recordsAfter: () => [stored] }, host(),
        { clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator });
      else await local.applyAuthority(authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }), { purgeCoordinator: coordinator });
      assert.deepEqual(attempts, [{ before: 'PURGING', after: 'PURGING', setter: 'undefined', ackSetter: 'undefined', acknowledged: false }]);
      assert.deepEqual(events, ['inventory', 'cache', 'ack']);
      assert.deepEqual(notifications, [['PURGING', false], ['PURGED', true]]);
      assert.equal(local.state, 'PURGED');
      assert.equal(local.purgeAcknowledged, true);
      assert.equal(cache.size, 0);
      assert.deepEqual(local.purgeReceipt.host_artifacts, artifacts);
      for (const repeat of [() => coordinator.complete(stored), () => local.redrivePurge(coordinator, stored),
        () => local.consumeJournal(journal, host()), () => local.applyAuthority(authorityResponse(fake, { tombstone: 'purge' }))]) await repeat();
      assert.deepEqual(events, ['inventory', 'cache', 'ack'], 'The retained acknowledgement makes every entry idempotent');
    });
  }

  it('PURGED notification follows the recorded host acknowledgement and cannot run while it is pending', async (t) => {
    const acknowledgement = deferred();
    const ordering = [];
    const local = localSession({ onChange: ({ state }) => {
      ordering.push(`observe:${state}:${local.purgeAcknowledged}`);
      if (state === 'PURGED') {
        assert.equal(local.markPurgeAcknowledged, undefined);
        assert.ok(Object.isFrozen(local.purgeReceipt.host_artifacts));
      }
    } });
    const { journal, coordinator, cache, artifacts } = setup(t, { session: local, acknowledge: (receipt) => {
      ordering.push('ack-sent');
      assert.equal(local.state, 'PURGING');
      assert.equal(local.purgeAcknowledged, false);
      assert.deepEqual(receipt.host_artifacts, artifacts);
      return acknowledgement.promise.then(() => { ordering.push('ack-recorded'); });
    } });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    const completion = coordinator.complete(stored);
    await flush();
    assert.equal(cache.size, 0);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.purgeAcknowledged, false);
    assert.equal(local.purgeProgress.cacheDeleted, true);
    assert.deepEqual(ordering, ['observe:PURGING:false', 'ack-sent']);
    acknowledgement.resolve();
    const receipt = await completion;
    assert.deepEqual(ordering, ['observe:PURGING:false', 'ack-sent', 'ack-recorded', 'observe:PURGED:true']);
    assert.equal(local.purgeReceipt, receipt);
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(await coordinator.complete(stored), receipt);
  });

  for (const mode of ['throw', 'start monitor', 'ack setter']) {
    it(`a PURGED observer attempting ${mode} cannot skip the host acknowledgement or strand retry`, async (t) => {
      let monitor;
      const ordering = [];
      const local = localSession({ onChange: ({ state }) => {
        if (state !== 'PURGED') return;
        ordering.push(`observe:${local.purgeAcknowledged}`);
        if (mode === 'throw') throw new Error('fixture PURGED observer failed');
        if (mode === 'start monitor') monitor.start();
        if (mode === 'ack setter') local.markPurgeAcknowledged?.();
      } });
      const { fake, journal, coordinator, cache, artifacts } = setup(t, { session: local, acknowledge: (receipt) => {
        ordering.push('ack');
        assert.deepEqual(receipt.host_artifacts, artifacts);
      } });
      const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
      const errors = [];
      monitor = new AuthorityMonitor({ session: local, clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator,
        onError: (error) => errors.push(error), fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }) });
      monitor.start();
      await fake.advance(0);
      assert.deepEqual(ordering, ['ack', 'observe:true']);
      assert.equal(local.state, 'PURGED');
      assert.equal(local.purgeAcknowledged, true);
      assert.equal(local.purgeProgress.retry, null);
      assert.equal(local.markPurgeAcknowledged, undefined);
      assert.equal(cache.size, 0);
      assert.equal(fake.timers.size, 0, 'Even a failing terminal observer cannot leave authority timers alive');
      assert.equal(errors.length, mode === 'ack setter' ? 0 : 1);
      if (mode === 'throw') assert.match(errors[0].message, /fixture PURGED observer failed/);
      if (mode === 'start monitor') assert.equal(errors[0].status, 409);
      const receipt = await coordinator.complete(stored);
      assert.equal(local.purgeReceipt, receipt);
      await local.consumeJournal(journal, host(), { purgeCoordinator: coordinator });
      assert.deepEqual(ordering, ['ack', 'observe:true']);
    });
  }

  for (const step of ['inventory', 'drain', 'cache', 'acknowledgement']) {
    it(`a ${step} callback enqueues lifecycle inputs without interrupting purge or nesting transitions`, async (t) => {
      const inside = [];
      const notifications = [];
      const local = localSession({ onChange: ({ state }) => { notifications.push(state); } });
      const callback = () => {
        const before = [local.state, local.scope.auth_epoch];
        local.end();
        local.captureOnly();
        local.revoke(2);
        inside.push([before, [local.state, local.scope.auth_epoch]]);
      };
      const { coordinator, cache } = setup(t, { session: local,
        ...(step === 'inventory' && { hostArtifacts: () => { callback(); return ['journal:fixture']; } }),
        ...(step === 'cache' && { purgeCache: () => { callback(); cache.clear(); } }),
        acknowledge: () => { if (step === 'acknowledgement') callback(); },
      });
      if (step === 'drain') {
        const drain = local.drain.bind(local);
        local.drain = () => { callback(); return drain(); };
      }
      await coordinator.purge({ authority: host() });
      assert.deepEqual(inside, [[['PURGING', 1], ['PURGING', 1]]]);
      assert.deepEqual(notifications, ['PURGING', 'PURGED']);
      assert.equal(local.scope.auth_epoch, 2);
      assert.equal(local.state, 'PURGED');
      assert.equal(local.purgeAcknowledged, true);
    });
  }

  it('an observer stopping the monitor on PURGING cannot skip receipt retention, cache deletion or acknowledgement', async (t) => {
    let monitor;
    const notifications = [];
    const local = localSession({ onChange: ({ state }) => {
      notifications.push({ state, actual: local.state, seq: local.lastRecordSeq,
        aborted: [local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted) });
      if (state === 'PURGING') monitor.stop();
    } });
    const { coordinator, fake, journal, cache, events } = setup(t, { session: local });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }) });
    monitor.start();
    await fake.advance(0);
    assert.deepEqual(notifications, [
      { state: 'PURGING', actual: 'PURGING', seq: 1, aborted: true },
      { state: 'PURGED', actual: 'PURGED', seq: 1, aborted: true },
    ]);
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
    assert.deepEqual(events, ['inventory', 'cache', 'ack']);
    assert.equal(fake.timers.size, 0);
    await local.consumeJournal(journal, host(), { clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator });
    await local.applyAuthority(authorityResponse(fake, { tombstone: 'purge' }), { purgeCoordinator: coordinator });
    assert.deepEqual(events, ['inventory', 'cache', 'ack'], 'Completed deletion remains idempotent after monitor stop');
  });

  for (const retry of ['journal', 'authority']) it(`a stopped PURGING observer retains a failed cache purge for ${retry} retry`, async (t) => {
    let monitor, attempts = 0;
    const local = localSession({ onChange: ({ state }) => { if (state === 'PURGING') monitor.stop(); } });
    const { coordinator, fake, journal, cache, events } = setup(t, { session: local, purgeCache: () => {
      if (++attempts === 1) throw new Error('fixture cache retry required');
      cache.clear();
    } });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }) });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.lastRecordSeq, 1);
    assert.equal(local.purgeAcknowledged, false);
    assert.equal(attempts, 1);
    assert.equal(cache.size, 1);
    assert.equal(fake.timers.size, 0);
    if (retry === 'journal') await local.consumeJournal(journal, host(), { clock: fake.clock, scheduler: fake.scheduler });
    else await local.applyAuthority(authorityResponse(fake, { tombstone: 'purge' }));
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(attempts, 2);
    assert.equal(cache.size, 0);
    assert.deepEqual(events, ['inventory', 'ack']);
  });

  it('the purge effect survives a queued observer end and stops signals before deletion', async (t) => {
    let local, ended = false;
    const ordering = [];
    local = localSession({ onChange: ({ state }) => {
      ordering.push(`observe:${state}`);
      if (state === 'PURGING' && !ended) {
        ended = true;
        local.end();
        ordering.push(`after-enqueue:${local.state}`);
      }
    } });
    const { coordinator, fake, journal, cache } = setup(t, { session: local,
      hostArtifacts: () => {
        ordering.push('inventory');
        assert.ok([local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted));
        return [];
      }, acknowledge: () => { ordering.push('ack'); } });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    await local.applyAuthority(authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }), { purgeCoordinator: coordinator });
    assert.deepEqual(ordering, ['observe:PURGING', 'after-enqueue:PURGING', 'inventory', 'ack', 'observe:PURGED']);
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
  });

  it('purge re-drive is scheduled before a failing PURGING observer notification', async (t) => {
    const local = localSession({ onChange: ({ state }) => {
      if (state === 'PURGING') throw new Error('fixture purge observer failed');
    } });
    const { coordinator, fake, journal, cache } = setup(t, { session: local });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    assert.throws(() => local.applyAuthority(authorityResponse(fake, { tombstone: 'purge', tombstone_record: stored }),
      { purgeCoordinator: coordinator }), /fixture purge observer failed/);
    await flush();
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
  });

  it('an observer queues redrivePurge and retains its receipt only after the current event completes', async (t) => {
    let coordinator, stored, retry, inside;
    const local = localSession({ onChange: ({ state }) => {
      if (state !== 'PURGING') return;
      retry = local.redrivePurge(coordinator, stored);
      inside = local.lastRecordSeq;
    } });
    const { fake, journal, cache, coordinator: purge } = setup(t, { session: local });
    coordinator = purge;
    stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    await assert.rejects(local.applyAuthority(authorityResponse(fake, { tombstone: 'purge' })), status(502));
    await retry;
    await local.redrivePurge(coordinator);
    assert.equal(inside, 0, 'Only the outer tombstone flag is committed during its observer');
    assert.equal(local.lastRecordSeq, 1);
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
  });

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

  for (const entry of ['journal', 'authority']) for (const step of ['inventory', 'drain', 'cache', 'acknowledgement']) {
    it(`${entry} re-drives a failed purge ${step} from retained tombstone state until acknowledgement`, async (t) => {
      const calls = { inventory: 0, drain: 0, cache: 0, acknowledgement: 0 };
      const acknowledgements = [];
      let artifacts = ['journal:fixture-original', 'intake:fixture-original'];
      const { coordinator, fake, local, journal, cache } = setup(t, {
        hostArtifacts: () => {
          calls.inventory++;
          if (step === 'inventory' && calls.inventory === 1) throw new Error('fixture inventory unavailable');
          return artifacts;
        },
        purgeCache: async () => {
          calls.cache++;
          if (step === 'cache' && calls.cache === 1) {
            artifacts = []; // A partial deletion must not lose host-owned refs on retry.
            throw new Error('fixture cache unavailable');
          }
          cache.clear();
        },
        acknowledge: (ack) => {
          calls.acknowledgement++;
          acknowledgements.push(ack);
          if (step === 'acknowledgement' && calls.acknowledgement === 1) return new Promise(() => {});
        },
      });
      const drain = local.drain.bind(local);
      local.drain = () => {
        calls.drain++;
        if (step === 'drain' && calls.drain === 1) throw new Error('fixture drain unavailable');
        return drain();
      };
      const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
      let reads = 0;
      const port = { recordsAfter: (...args) => ++reads === 1 ? [stored] : journal.recordsAfter(...args) };
      const options = { clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator };
      let monitor;
      if (entry === 'journal') {
        const failure = assert.rejects(local.consumeJournal(port, host(), options),
          step === 'acknowledgement' ? status(504) : new RegExp(`fixture ${step} unavailable`));
        if (step === 'acknowledgement') await fake.advance(10_000);
        await failure;
      } else {
        let polls = 0;
        monitor = new AuthorityMonitor({ session: local, ...options, fetchAuthority: () => authorityResponse(fake,
          { tombstone: 'purge', ...(++polls === 1 ? { tombstone_record: stored } : {}) }) });
        monitor.start();
        await fake.advance(step === 'acknowledgement' ? 10_000 : 0);
        assert.ok(monitor.lastError);
      }
      assert.equal(local.state, 'PURGING');
      assert.equal(local.lastRecordSeq, 1);
      assert.equal(local.purgeAcknowledged, false);
      assert.equal(local.purgeProgress.retry.step, step);
      assert.ok(Number.isFinite(local.purgeProgress.drainDeadline));
      assert.equal(local.purgeProgress.artifacts === null, step === 'inventory');
      assert.equal(local.purgeProgress.drained === null, ['inventory', 'drain'].includes(step));
      assert.equal(local.purgeProgress.cacheDeleted, step === 'acknowledgement');
      assert.equal(local.purgeProgress.receipt === null, step !== 'acknowledgement');
      assert.throws(() => local.assertNewClaim(), code('revoked'));
      if (entry === 'journal') {
        assert.equal(await local.consumeJournal(port, host(), options), 1);
        assert.equal(reads, 1, 'Retry cannot depend on a denied post-tombstone journal read');
      } else await fake.advance(30_000 - (fake.mono - fake.origin));
      assert.equal(local.state, 'PURGED');
      assert.equal(local.purgeAcknowledged, true);
      assert.equal(cache.size, 0);
      assert.equal(local.purgeProgress.retry, null);
      if (step === 'drain' && entry === 'authority') {
        assert.equal(calls.drain, 1, 'The next fixed poll is past the original drain deadline');
        assert.equal(acknowledgements.at(-1).drained, false, 'Re-drive advances an expired drain to cache deletion');
      } else assert.equal(calls[step], 2, 'The failed step must run again');
      assert.deepEqual(acknowledgements.at(-1).host_artifacts, ['journal:fixture-original', 'intake:fixture-original']);
      if (step === 'acknowledgement') {
        assert.equal(acknowledgements[0], acknowledgements[1], 'Stable acknowledgement across transport retry');
        assert.equal(calls.cache, 1);
        assert.equal(calls.drain, 1);
      }
      const completed = { ...calls };
      await local.consumeJournal(port, host(), options);
      assert.deepEqual(calls, completed, 'Recorded acknowledgement ends every purge step');
      if (monitor) assert.equal(fake.timers.size, 0);
    });
  }

  it('a journal tombstone learned without a coordinator retains its receipt for the next consumeJournal', async (t) => {
    const { coordinator, fake, local, journal, cache } = setup(t);
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    await assert.rejects(local.consumeJournal({ recordsAfter: () => [stored] }, host(), { clock: fake.clock, scheduler: fake.scheduler }), status(502));
    assert.equal(local.state, 'PURGING');
    assert.equal(local.lastRecordSeq, 1);
    assert.equal(await local.consumeJournal(journal, host(), { clock: fake.clock, scheduler: fake.scheduler, purgeCoordinator: coordinator }), 1);
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
  });

  it('a retried drain shares the original 10s allowance rather than starting a new one', async (t) => {
    const { coordinator, fake, local, journal, cache } = setup(t);
    let attempts = 0;
    local.drain = () => ++attempts === 1
      ? new Promise((_, reject) => fake.scheduler.setTimeout(() => reject(new Error('fixture drain interrupted')), 6000))
      : new Promise(() => {});
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    const first = assert.rejects(coordinator.complete(stored), /fixture drain interrupted/);
    await fake.advance(6000);
    await first;
    await fake.advance(3000);
    const retry = coordinator.complete(stored);
    await fake.advance(999);
    assert.equal(local.state, 'PURGING');
    await fake.advance(1);
    assert.equal(local.state, 'PURGED', 'The retry must finish at the original deadline');
    assert.equal((await retry).drained, false);
    assert.equal(fake.mono - fake.origin, 10_000);
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
  });

  it('a purge flag without its original stored record fails closed and ends after 10min without authority', async (t) => {
    const { coordinator, fake, local, cache, events } = setup(t);
    let available = true;
    const monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator,
      clock: fake.clock, scheduler: fake.scheduler, fetchAuthority: () => available
        ? authorityResponse(fake, { tombstone: 'purge' }) : new Promise(() => {}) });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.scope.tombstone, 'purge');
    assert.equal(monitor.lastError.status, 502);
    assert.equal(cache.size, 1);
    assert.deepEqual(events, []);
    available = false;
    await fake.advance(600_000);
    assert.equal(local.state, 'ENDED');
    assert.equal(fake.timers.size, 0);
    assert.equal(cache.size, 1);
    const doc = record('session.control', { action: 'purge' }, { writer: { kind: 'host' } });
    await coordinator.complete({ bytes: bytes(doc), document: { ...doc, seq: 1 } });
    assert.equal(local.state, 'PURGED', 'Late original host receipt can still finish deletion after end');
    assert.equal(cache.size, 0);
  });

  it('the ten-minute end keeps re-driving a retained purge without authority until it is acknowledged', async (t) => {
    let cacheAvailable = false;
    const { coordinator, fake, local, journal, cache } = setup(t, {
      purgeCache: async () => {
        if (!cacheAvailable) throw new Error('fixture cache unavailable');
        cache.clear();
      },
    });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    let polls = 0;
    let available = true;
    const monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator,
      clock: fake.clock, scheduler: fake.scheduler, fetchAuthority: () => available
        ? authorityResponse(fake, { tombstone: 'purge', ...(++polls === 1 ? { tombstone_record: stored } : {}) })
        : new Promise(() => {}) });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'PURGING');
    assert.equal(local.purgeAcknowledged, false);
    available = false; // Authority disappears while deletion is still retained.
    await fake.advance(600_000);
    assert.equal(local.state, 'PURGING', 'The end cannot strand a retained deletion');
    assert.ok(fake.timers.size > 0, 'The monitor keeps a purge re-drive scheduled after polling ends');
    cacheAvailable = true;
    await fake.advance(30_000);
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
    assert.equal(fake.timers.size, 0, 'The monitor stops once the purge is acknowledged');
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

  it('a lost tombstone response followed by revoked closes claims until the host original receipt completes purge', async (t) => {
    let stored;
    const { coordinator, fake, local, journal, cache } = setup(t, { journal: { append: (original, authority) => {
      const result = journal.append(original, authority);
      stored = result;
      return new Promise(() => {}); // The response is lost permanently after commitment.
    } } });
    const refusal = assert.rejects(coordinator.purge({ authority: host() }), status(504));
    await fake.advance(10_000);
    await refusal;
    await assert.rejects(coordinator.purge({ authority: host() }), code('revoked'),
      'The reference JournalPort refuses replay after committing its tombstone; local authorization must fail closed');
    assert.equal(local.state, 'REVOKED');
    assert.ok([local.captureSignal, local.microphoneSignal, local.outputSignal, local.pendingSignal].every((signal) => signal.aborted));
    assert.throws(() => local.assertNewClaim(), code('revoked'));
    assert.throws(() => new CapabilityGuard({ verifier: verifier() }).authorize('ledger.claim', jwt(), local.scope), code('revoked'));
    let forwardReceipt = false;
    const monitor = new AuthorityMonitor({ session: local, purgeCoordinator: coordinator, clock: fake.clock, scheduler: fake.scheduler,
      fetchAuthority: () => authorityResponse(fake, { tombstone: 'purge', ...(forwardReceipt ? { tombstone_record: stored } : {}) }) });
    monitor.start();
    await fake.advance(0);
    assert.equal(local.state, 'PURGING');
    assert.equal(cache.size, 1, 'A refusal/flag cannot invent the host receipt');
    assert.throws(() => local.assertNewClaim(), code('revoked'));
    forwardReceipt = true;
    await fake.advance(30_000);
    assert.equal(local.state, 'PURGED');
    assert.equal(local.purgeAcknowledged, true);
    assert.equal(cache.size, 0);
    assert.equal(fake.timers.size, 0);
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
    assert.deepEqual(events, ['inventory', 'cache', 'ack'], 'A recorded acknowledgement ends retries');
    await coordinator.purge({ authority: host() });
    assert.deepEqual(events, ['inventory', 'cache', 'ack'], 'Host-originated completion retains the recorded acknowledgement');
  });

  it('concurrent purge callers still verify host authentication and original tombstone identity', async (t) => {
    const response = deferred();
    const { coordinator, local, journal, cache } = setup(t, { acknowledge: () => response.promise });
    const stored = journal.append(bytes(record('session.control', { action: 'purge' }, { writer: { kind: 'host' } })), host());
    const completion = coordinator.complete(stored);
    await flush();
    assert.equal(local.state, 'PURGING');
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
    assert.equal(local.state, 'PURGING');
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
