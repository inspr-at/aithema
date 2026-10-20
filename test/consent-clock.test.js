import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installConsentClock } from './fixtures/consent-clock.js';

test('AIT-371: consent time advances without replacing or advancing the page wall clock', () => {
  let wallNow = 10000, consent = 0;
  const PageDate = class extends Date {};
  const realNow = PageDate.now = () => wallNow;
  const window = { setTimeout() { throw new Error('consent timer reached the real scheduler'); }, clearTimeout() {} };
  runInNewContext(`(${installConsentClock.toString()})()`, { window, Date: PageDate });
  assert.equal(PageDate.now, realNow, 'installing the consent clock preserves Date.now');
  window.setTimeout(function consentTimer() { consent++; }, 4000);
  wallNow += 25;
  window.clock.tick(3999);
  assert.equal(consent, 0);
  assert.equal(PageDate.now(), wallNow, 'virtual consent time does not advance the page clock');
  window.clock.tick(1);
  assert.equal(consent, 1);
  assert.equal(PageDate.now(), wallNow, 'consent callbacks leave the page clock untouched');
});

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
