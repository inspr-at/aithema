import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_LAUNCH_TIMEOUT, ADMIN_STEP_TIMEOUT, adminSteps } from './browser/admin-steps.js';

test('admin protocol deadlines identify the original matrix cell and operation', async () => {
  const { at, run } = adminSteps();
  at('audit-empty', { locale: 'en', theme: 'dark', width: 1024 });
  const pending = run('page.screenshot -mail', () => new Promise(() => {}), { timeout: 1 });
  at('next-state', { width: 1440 });
  await assert.rejects(pending, /state=audit-empty locale=en theme=dark width=1024: page.screenshot -mail: deadline exceeded \(1 ms\)/u);
});

test('admin steps preserve protocol errors and synchronous failures as causes', async () => {
  const { run } = adminSteps();
  const cause = new Error('protocol disconnected');
  for (const work of [() => { throw cause; }, () => Promise.reject(cause)]) {
    await assert.rejects(run('page.evaluate', work), error => {
      assert.equal(error.cause, cause);
      assert.match(error.message, /state=setup locale=de theme=light width=390: page.evaluate: protocol disconnected/u);
      return true;
    });
  }
});

test('cancelling the outer test interrupts a held POST but still permits bounded cleanup', async () => {
  const controller = new AbortController(), { at, run } = adminSteps(controller.signal);
  at('flow-saving', { locale: 'de', theme: 'dark', width: 390 });
  const pending = run('settings POST arrival', () => new Promise(() => {}));
  controller.abort();
  await assert.rejects(pending, /state=flow-saving locale=de theme=dark width=390: settings POST arrival/u);
  let released = false;
  await run('release fixture', () => { released = true; }, { cleanup: true });
  assert.equal(released, true);
  await assert.rejects(run('browser.close', () => new Promise(() => {}), { timeout: 1, cleanup: true }), /browser.close: deadline exceeded/u);
});

test('an already cancelled test never starts another protocol operation', async () => {
  const controller = new AbortController(); controller.abort();
  const { run } = adminSteps(controller.signal);
  let called = false;
  await assert.rejects(run('page.goto', () => { called = true; }));
  assert.equal(called, false);
});

test('a launch deadline aborts the underlying operation instead of abandoning its child', async t => {
  assert.equal(ADMIN_LAUNCH_TIMEOUT, 30_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { at, run } = adminSteps();
  at('launch', { locale: 'en' });
  let operationSignal, stopped = false;
  const pending = run('puppeteer.launch', signal => {
    operationSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      stopped = true;
      reject(signal.reason);
    }, { once: true }));
  }, { timeout: ADMIN_LAUNCH_TIMEOUT });
  const rejected = assert.rejects(pending, /state=launch locale=en theme=light width=390: puppeteer.launch: deadline exceeded \(30000 ms\)/u);
  await Promise.resolve();
  t.mock.timers.tick(ADMIN_LAUNCH_TIMEOUT - 1);
  assert.equal(operationSignal.aborted, false);
  assert.equal(stopped, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(operationSignal.aborted, true);
  assert.equal(stopped, true);
});

test('page steps retain their 15 s default deadline', async t => {
  assert.equal(ADMIN_STEP_TIMEOUT, 15_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { run } = adminSteps();
  let operationSignal;
  const pending = run('page.evaluate', signal => {
    operationSignal = signal;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(pending, /page.evaluate: deadline exceeded \(15000 ms\)/u);
  await Promise.resolve();
  t.mock.timers.tick(ADMIN_STEP_TIMEOUT - 1);
  assert.equal(operationSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(operationSignal.aborted, true);
});
