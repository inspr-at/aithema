import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNIT_FILE_TIMEOUT_MS } from '../scripts/unit-watchdog.js';

const watchdog = fileURLToPath(new URL('../scripts/unit-watchdog.js', import.meta.url));

function workerEnvironment() {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env;
}

test('AIT-193: npm test applies the three-minute deadline and watchdog to every worker', () => {
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
  assert.equal(UNIT_FILE_TIMEOUT_MS, 180_000);
  assert.match(command, /--test-timeout=180000\b/u);
  assert.match(command, /--import \.\/scripts\/unit-watchdog\.js\b/u);
});

for (const [name, body] of [
  ['leaked-interval', "test('assertions complete', () => { setInterval(() => {}, 1000); });"],
  ['stuck-after', "test('assertions complete', () => {}); test.after(() => new Promise(() => {})); setInterval(() => {}, 1000);"],
]) test(`AIT-193: the unit runner bounds and names a ${name} file`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-timeout-'));
  try {
    const fixture = join(directory, `${name}.test.cjs`);
    writeFileSync(fixture, `const test = require('node:test');\nconst { armUnitWatchdog } = require(${JSON.stringify(watchdog)});\narmUnitWatchdog(200);\n${body}\n`);
    const childEnv = workerEnvironment();
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=200', '--import', watchdog, fixture], {
      env: childEnv, encoding: 'utf8', timeout: 5000, detached: true,
    });
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, 'the runner must exit before the outer watchdog');
    assert.equal(result.status, 1, output);
    assert.match(output, new RegExp(`${name}\\.test\\.cjs`, 'u'));
    assert.match(output, /timed out|testTimeoutFailure/u);
    assert.match(output, /Active resources:/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AIT-298: file timeout identifies the completed subtest and open-handle creation site', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-diagnostic-'));
  try {
    const fixture = join(directory, 'owned-handle.test.cjs');
    writeFileSync(fixture, `const test = require('node:test');
const { armUnitWatchdog } = require(${JSON.stringify(watchdog)});
armUnitWatchdog(200);
test('leaking wallet poll', () => { setInterval(function walletPoll() {}, 1000); });`);
    const childEnv = workerEnvironment(); childEnv.AITHEMA_UNIT_TRACE_HANDLES = '1';
    const result = spawnSync(process.execPath, ['--test', '--import', watchdog, fixture], { env: childEnv, encoding: 'utf8', timeout: 5000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Last completed subtest: leaking wallet poll/);
    assert.match(output, /Open Timeout .*created in leaking wallet poll/);
    assert.match(output, /owned-handle\.test\.cjs:4/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AIT-298: late uncaught callbacks print their error stack and originating subtest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-uncaught-'));
  try {
    const fixture = join(directory, 'late-callback.test.cjs');
    writeFileSync(fixture, `const test = require('node:test');
test('reject concept', () => { setTimeout(function withdrawalNotice() { throw new TypeError('gone getRootNode'); }, 40); });`);
    const childEnv = workerEnvironment();
    const result = spawnSync(process.execPath, ['--test', '--import', watchdog, fixture], { env: childEnv, encoding: 'utf8', timeout: 5000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Unit uncaught error:/);
    assert.match(output, /Async origin: reject concept/);
    assert.match(output, /TypeError: gone getRootNode/);
    assert.match(output, /withdrawalNotice .*late-callback\.test\.cjs:2/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AIT-299: default watchdog keeps timeout context without expensive handle stacks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-default-'));
  try {
    const fixture = join(directory, 'default-handle.test.cjs');
    writeFileSync(fixture, `const test = require('node:test');
const { armUnitWatchdog } = require(${JSON.stringify(watchdog)});
armUnitWatchdog(200);
test('wallet poll without tracing', () => { setInterval(() => {}, 1000); });`);
    const childEnv = workerEnvironment(); delete childEnv.AITHEMA_UNIT_TRACE_HANDLES;
    const result = spawnSync(process.execPath, ['--test', '--import', watchdog, fixture], { env: childEnv, encoding: 'utf8', timeout: 5000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Last completed subtest: wallet poll without tracing/);
    assert.match(output, /Active resources:.*Timeout/);
    assert.doesNotMatch(output, /Open Timeout|Resource created here/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


for (const trace of [false, true]) test(`AIT-299 r2: watchdog creates ${trace ? 'one opt-in' : 'no default'} async hook`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-hook-'));
  try {
    const fixture = join(directory, 'hook-count.test.cjs');
    writeFileSync(fixture, `const assert = require('node:assert/strict');
// Initialize Node's own lazy runner hook before counting watchdog hooks.
require('node:test').beforeEach(() => {});
const hooks = require('node:async_hooks'), original = hooks.createHook;
let created = 0;
hooks.createHook = (...args) => { created++; return original(...args); };
require('node:module').syncBuiltinESMExports();
require(${JSON.stringify(watchdog)});
assert.equal(created, ${trace ? 1 : 0}, 'watchdog hook count');
require('node:test')('attributed without tracing', () => {});`);
    const childEnv = workerEnvironment();
    if (trace) childEnv.AITHEMA_UNIT_TRACE_HANDLES = '1'; else delete childEnv.AITHEMA_UNIT_TRACE_HANDLES;
    const result = spawnSync(process.execPath, ['--test', fixture], { env: childEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
