import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const [reason, expected] of [
  ['admission deadline', 'retryable'], ['budget reconciling', 'wait'], ['plugin unhealthy', 'retryable'],
  ['consent port unavailable', 'retryable'], ['reply-in-flight', 'wait'],
  ['budget denied', 'terminal'], ['session', 'terminal'], ['one-hour', 'terminal'], ['host-limit', 'terminal'],
  ['consent-required', 'actionable'], ['current processing consent required', 'actionable'], ['paused', 'actionable'],
  ['invalid-request', 'terminal'],
]) test(`AIT-503 focus refusal classification: ${reason}`, async () => {
  const policy = await import('../src/focus-refusal.js');
  assert.equal(typeof policy.classifyFocusRefusal, 'function');
  const error = ['reply-in-flight', 'consent-required'].includes(reason) ? { reason } : { reason: 'not-admitted', admissionReason: reason };
  assert.equal(policy.classifyFocusRefusal(error), expected);
});

test('AIT-503 unknown focus refusals are terminal and cannot inherit object properties', async () => {
  const policy = await import('../src/focus-refusal.js');
  assert.equal(typeof policy.classifyFocusRefusal, 'function');
  for (const reason of [null, undefined, 'unknown', 'constructor', '__proto__']) {
    assert.equal(policy.classifyFocusRefusal({ reason }), 'terminal');
  }
  assert.equal(policy.classifyFocusRefusal({ reason: 'consent-required', admissionReason: 'unknown' }), 'actionable');
});

test('AIT-503 malformed-command error without a reason is terminal', async () => {
  const policy = await import('../src/focus-refusal.js');
  assert.equal(policy.classifyFocusRefusal({ status: 400, error: 'invalid-request' }), 'terminal');
  assert.equal(policy.classifyFocusRefusal({ error: 'reasoning-unavailable' }), 'terminal', 'opaque failure codes never imply a safe retry');
});

for (const error of [{ reason: 'network' }, { status: 503 }, { status: 500 }, { name: 'TypeError' }]) test(`AIT-503 retryable transport ${JSON.stringify(error)}`, async () => {
  const { classifyFocusRefusal } = await import('../src/focus-refusal.js');
  assert.equal(classifyFocusRefusal(error), 'retryable');
});

test('RC24 refusal policy is not a UI package export', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(manifest.exports, './focus-refusal'), false);
  assert.equal(Object.hasOwn(manifest.exports, './*'), false);
});
