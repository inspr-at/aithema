import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installConsentClock } from './fixtures/consent-clock.js';

for (const delay of [100, 2000, 4000, 8000]) test(`AIT-365 R2: consent clock leaves unrelated ${delay} ms timers on the real clock`, () => {
  const scheduled = [], cancelled = [];
  const window = { setTimeout(callback, ms, ...args) { scheduled.push({ callback, ms, args }); return 42; }, clearTimeout(id) { cancelled.push(id); } };
  runInNewContext(`(${installConsentClock.toString()})()`, { window, Date: class extends Date {} });
  let unrelated = 0, consent = 0;
  const real = window.setTimeout(() => unrelated++, delay);
  const virtual = window.setTimeout(function consentTimer() { consent++; }, delay);
  assert.equal(scheduled.length, 1, 'only the unrelated timer reaches the real scheduler');
  assert.equal(real, 42); assert.equal(window.clock.pending(), 1);
  window.clock.tick(delay);
  assert.equal(consent, 1); assert.equal(unrelated, 0);
  window.clearTimeout(real); assert.deepEqual(cancelled, [42]);
  assert.ok(virtual < 0);
});
