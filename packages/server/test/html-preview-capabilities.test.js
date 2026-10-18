import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHTMLPreviewCapabilities } from '../src/html-preview-capabilities.js';

const scope = { sessionId: 'session-one', artifactId: 'artifact-one', ownerHash: 'owner-hash',
  consentRevision: 1, contentDigest: 'digest' };
test('AIT-352: capabilities are unique, bounded, expiring and consumed exactly once', () => {
  let now = 1000;
  const registry = createHTMLPreviewCapabilities({ capacity: 2, now: () => now });
  const first = registry.mint(scope), second = registry.mint({ ...scope, artifactId: 'artifact-two' });
  assert.notEqual(first, second); assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  const third = registry.mint({ ...scope, sessionId: 'session-two' });
  assert.equal(registry.redeem(first), null, 'oldest evicted at capacity');
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
