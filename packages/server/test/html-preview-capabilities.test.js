import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHTMLPreviewCapabilities } from '../src/html-preview-capabilities.js';

const scope = { sessionId: 'session-one', artifactId: 'artifact-one', ownerHash: 'owner-hash',
  consentRevision: 1, contentDigest: 'digest' };
test('AIT-352: capabilities are unique, expiring and consumed exactly once', () => {
  let now = 1000;
  const registry = createHTMLPreviewCapabilities({ now: () => now });
  const first = registry.mint(scope), second = registry.mint({ ...scope, artifactId: 'artifact-two' });
  assert.notEqual(first, second); assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  const third = registry.mint({ ...scope, sessionId: 'session-two' });
  assert.deepEqual(registry.redeem(first), { ...scope, expiresAt: 61000 });
  assert.deepEqual(registry.redeem(second), { ...scope, artifactId: 'artifact-two', expiresAt: 61000 });
  assert.equal(registry.redeem(second), null, 'single use');
  assert.deepEqual(registry.redeem(third), { ...scope, sessionId: 'session-two', expiresAt: 61000 });
  const expired = registry.mint(scope); now = 61000;
  assert.equal(registry.redeem(expired), null, 'expiry is inclusive at 60 seconds');
  const cleared = registry.mint(scope); registry.clear(); assert.equal(registry.redeem(cleared), null);
  for (const value of [undefined, '', 'x', 'x'.repeat(10000)]) assert.equal(registry.redeem(value), null);
});
test('AIT-352: capability limits cannot exceed the expiry and memory ceilings', () => {
  for (const options of [{ capacity: 0 }, { capacity: 10001 }, { capacity: 1.5 }, { ttlMs: 0 }, { ttlMs: 60001 }]) {
    assert.throws(() => createHTMLPreviewCapabilities(options), TypeError);
  }
});

test('AIT-352: a full live registry refuses minting without evicting another session', () => {
  let now = 1000;
  const registry = createHTMLPreviewCapabilities({ capacity: 2, perSessionCapacity: 1, now: () => now });
  const first = registry.mint(scope);
  now += 1000;
  const second = registry.mint({ ...scope, sessionId: 'session-two', ownerHash: 'other-owner' });
  assert.equal(registry.mint({ ...scope, sessionId: 'session-three' }), null, 'live capacity refuses mint');
  assert.equal(registry.redeem(first)?.sessionId, scope.sessionId, 'first live token survives saturation');
  assert.equal(registry.redeem(second)?.sessionId, 'session-two', 'other owner survives saturation');
});

test('AIT-352: expired tokens are purged before refusing a full registry', () => {
  let now = 1000;
  const registry = createHTMLPreviewCapabilities({ capacity: 2, perSessionCapacity: 1, now: () => now });
  const expired = registry.mint(scope);
  now += 1000;
  const live = registry.mint({ ...scope, sessionId: 'session-two' });
  now = 61000;
  const replacement = registry.mint({ ...scope, sessionId: 'session-three' });
  assert.match(replacement, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(registry.redeem(expired), null);
  assert.equal(registry.redeem(live)?.sessionId, 'session-two');
  assert.equal(registry.redeem(replacement)?.sessionId, 'session-three');
});

test("AIT-352: the default session cap replaces only that session's oldest token", () => {
  const registry = createHTMLPreviewCapabilities();
  const other = registry.mint({ ...scope, sessionId: 'other-session' });
  const tokens = Array.from({ length: 8 }, () => registry.mint(scope));
  const replacement = registry.mint(scope);
  assert.equal(registry.redeem(tokens[0]), null, 'only the over-quota session loses its oldest token');
  for (const token of tokens.slice(1)) assert.equal(registry.redeem(token)?.sessionId, scope.sessionId);
  assert.equal(registry.redeem(other)?.sessionId, 'other-session', 'same owner, different session is protected');
  assert.equal(registry.redeem(replacement)?.sessionId, scope.sessionId);
});

test('AIT-352: backwards wall clock does not extend the monotonic 60 second window', t => {
  let wall = 100000, monotonic = 1000;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => monotonic);
  const registry = createHTMLPreviewCapabilities();
  const token = registry.mint(scope);
  wall -= 3600000;
  monotonic += 60000;
  assert.equal(registry.redeem(token), null, 'expires after 60 seconds even when the wall clock goes backwards');
});

test('AIT-352: a backwards injected monotonic clock invalidates outstanding tokens', () => {
  let now = 1000;
  const registry = createHTMLPreviewCapabilities({ now: () => now });
  const token = registry.mint(scope);
  now = 999;
  assert.equal(registry.redeem(token), null, 'a regressed injected clock must fail closed');
});
