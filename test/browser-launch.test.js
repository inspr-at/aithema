import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { browserStep } from './browser/browser-step.js';
import browserLauncher, { launchTimeout, navigationTimeout, boundPage } from './browser/launch.js';

async function fixture(t, hangs, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launch-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executablePath = join(dir, 'browser');
  await writeFile(executablePath, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/launch-browser.mjs', import.meta.url).href)};\n`, { mode: 0o755 });
  const record = join(dir, 'attempts');
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(message));
  return { messages, record, options: { executablePath, timeout: 2000, protocolTimeout: 5000,
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
    await assert.rejects(browserLauncher.launch({ ...f.options, pipe }), /infra: browser launch timed out after two attempts \(2000 ms per attempt\)/u);
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
  await assert.rejects(browserLauncher.launch({ ...f.options, timeout: 2250 }), /\(2250 ms per attempt\)/u);
  assert.equal((await f.attempts()).length, 2);
  assert.equal(launchTimeout, 60_000);
});

test('initial page timeout is not retried', async t => {
  const f = await fixture(t, 0);
  await assert.rejects(browserLauncher.launch({ ...f.options, waitForInitialPage: true }), /Timed out/u);
  assert.equal((await f.attempts()).length, 1);
  assert.deepEqual(f.messages, []);
});

test('a caller abort during startup is never retried', async t => {
  const f = await fixture(t, 2);
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(browserLauncher.launch({ ...f.options, signal: controller.signal }), /caller cancelled|aborted/iu);
  assert.deepEqual(f.messages, []);
});

// AIT-227: callers historically supplied the real account HOME. The central
// launcher must replace it and keep all writable Chrome paths beside its profile.
test('concurrent launches isolate HOME, profile, cache and temp despite caller HOME', async t => {
  const fixtures = await Promise.all([fixture(t, 0), fixture(t, 0)]);
  const browsers = await Promise.all(fixtures.map(f => browserLauncher.launch({
    ...f.options, env: { ...f.options.env, HOME: '/caller-home-must-never-be-used' },
  })));
  t.after(() => Promise.all(browsers.map(browser => browser.close())));
  if (process.platform === 'darwin') for (const browser of browsers) {
    assert.ok(browser.process().spawnargs.includes('--disable-metal-shader-cache'));
    assert.ok(browser.process().spawnargs.includes('--enable-gpu'));
  }
  const attempts = (await Promise.all(fixtures.map(f => f.attempts()))).flat();
  assert.equal(attempts.length, 2);
  for (const key of ['profile', 'home', 'tmpdir', 'cache', 'config']) {
    assert.notEqual(attempts[0][key], attempts[1][key], `${key} shared between browsers`);
    for (const [i, attempt] of attempts.entries()) {
      assert.equal(typeof attempt[key], 'string', `${key} must be explicit`);
      const path = relative(fixtures[i].options.userDataDir, attempt[key]);
      assert.ok(path && !path.startsWith('..') && !isAbsolute(path), `${key} must stay inside the run`);
    }
  }
});

test('navigation has a hard deadline and identifies its test file', async () => {
  let defaults, observed;
  const page = { setDefaultNavigationTimeout(value) { defaults = value; },
    async goto(_url, options) { observed = options; throw new Error('navigation timeout'); } };
  boundPage(page, 'orb-reveal.test.js');
  assert.equal(defaults, navigationTimeout);
  for (const [requested, expected] of [[0, 30_000], [120_000, 30_000], [500, 500]]) {
    await assert.rejects(page.goto('http://fixture/', { timeout: requested, waitUntil: 'domcontentloaded' }), /orb-reveal.test.js: page.goto failed: navigation timeout/u);
    assert.equal(observed.timeout, expected);
    assert.equal(observed.waitUntil, 'domcontentloaded');
  }
});

test('a stalled WebSocket upgrade is bounded and cleaned before retry', async t => {
  const f = await fixture(t, 1, { AIT_LAUNCH_HANDSHAKE: '1' });
  const browser = await browserLauncher.launch(f.options);
  t.after(() => browser.close());
  const attempts = await f.attempts();
  assert.equal(attempts.length, 2);
  assert.throws(() => process.kill(attempts[0].pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(attempts[0].profile), { code: 'ENOENT' });
  assert.deepEqual(f.messages, ['infra: browser launch (retry 1/1)']);
});

test('fixture latches fail with the file and step instead of waiting for the file deadline', async () => {
  await assert.rejects(browserStep('confirmation-design.test.js: server POST arrival',
    () => new Promise(() => {}), 20), /confirmation-design.test.js: server POST arrival: exceeded 20 ms/u);
  assert.equal(await browserStep('ready', async () => 'value'), 'value');
});
