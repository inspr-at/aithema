import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminSteps } from './browser/admin-steps.js';

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
