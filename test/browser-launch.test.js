import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import browserLauncher, { launchTimeout } from './browser/launch.js';

async function fixture(t, hangs, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launch-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executablePath = join(dir, 'browser');
  await writeFile(executablePath, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/launch-browser.mjs', import.meta.url).href)};\n`, { mode: 0o755 });
  const record = join(dir, 'attempts');
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(message));
  return { messages, record, options: { executablePath, timeout: 500, protocolTimeout: 2000,
    waitForInitialPage: false, defaultViewport: null, userDataDir: dir,
    env: { ...process.env, AIT_LAUNCH_RECORD: record, AIT_LAUNCH_HANGS: String(hangs), ...extra } },
    attempts: async () => (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse) };
}

for (const pipe of [false, true]) {
  test(`launch timeout retries once, after process and profile cleanup (${pipe ? 'pipe' : 'WS'})`, async t => {
    const f = await fixture(t, 1);
    const browser = await browserLauncher.launch({ ...f.options, pipe });
    t.after(() => browser.close());
    const attempts = await f.attempts();
    assert.equal(attempts.length, 2);
    assert.equal(browser.process().pid, attempts[1].pid);
    assert.throws(() => process.kill(attempts[0].pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(attempts[0].profile), { code: 'ENOENT' });
    assert.deepEqual(f.messages, ['infra: browser launch (retry 1/1)']);
  });

  test(`two launch timeouts fail with infra message and no third attempt (${pipe ? 'pipe' : 'WS'})`, async t => {
    const f = await fixture(t, 2);
    await assert.rejects(browserLauncher.launch({ ...f.options, pipe }), /infra: browser launch timed out after two attempts \(500 ms per attempt\)/u);
    const attempts = await f.attempts();
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.throws(() => process.kill(attempt.pid, 0), { code: 'ESRCH' });
      await assert.rejects(access(attempt.profile), { code: 'ENOENT' });
    }
    assert.deepEqual(f.messages, ['infra: browser launch (retry 1/1)']);
  });
}

test('non-timeout launch error is never retried', async t => {
  const f = await fixture(t, 0, { AIT_LAUNCH_ERROR: '1' });
  await assert.rejects(browserLauncher.launch(f.options), /deliberate non-timeout launch failure/u);
  assert.equal((await f.attempts()).length, 1);
  assert.deepEqual(f.messages, []);
});

test('explicit caller timeout is used on both attempts', async t => {
  const f = await fixture(t, 2);
  await assert.rejects(browserLauncher.launch({ ...f.options, timeout: 650 }), /\(650 ms per attempt\)/u);
  assert.equal((await f.attempts()).length, 2);
  assert.equal(launchTimeout, 60_000);
});

test('initial page timeout is not retried', async t => {
  const f = await fixture(t, 0);
  await assert.rejects(browserLauncher.launch({ ...f.options, waitForInitialPage: true }), /Timed out/u);
  assert.equal((await f.attempts()).length, 1);
  assert.deepEqual(f.messages, []);
});
