import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNIT_FILE_TIMEOUT_MS } from '../scripts/unit-watchdog.js';
import { assertUnitCoverage, assertUnitHeadroom, discoverUnitTests, packUnitTests, readUnitWeights, selectUnitShard, unitConcurrency, unitJobOverheadSeconds, unitJobTargetSeconds, unitPlan, unitTestCommand, unitUnknownFileSeconds } from '../scripts/unit-shards.js';
import { assertUnitResults } from '../scripts/check-unit-results.js';
import { unitFileMeasurements } from '../scripts/update-unit-timings.js';

const watchdog = fileURLToPath(new URL('../scripts/unit-watchdog.js', import.meta.url));

function workerEnvironment() {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env;
}

test('AIT-193: npm test applies the three-minute deadline and watchdog to every worker', () => {
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
  assert.equal(UNIT_FILE_TIMEOUT_MS, 180_000);
  assert.match(command, /--test-timeout=180000\b/u);
  assert.match(command, /--import \.\/scripts\/unit-watchdog\.js\b/u);
  // AIT-456: preserve every existing deadline/assertion; extend this guard with
  // discovery, deterministic scheduling and adversarial result manifests.
  assert.equal(unitConcurrency, 3);
  assert.equal(unitJobTargetSeconds, 420);
  const files = discoverUnitTests(), packing = unitPlan();
  assertUnitCoverage(files, packing.shards);
  assertUnitHeadroom(packing);
  assert.ok(unitJobOverheadSeconds + Object.values(readUnitWeights()).reduce((sum, seconds) => sum + seconds, 0) /
    unitConcurrency > unitJobTargetSeconds, 'One shard cannot meet the target even before its longest-file scheduling allowance');
  assert.deepEqual(packing.shards.flat().sort(), files);
  assert.equal(new Set(packing.shards.flat()).size, files.length);
  assert.ok(unitTestCommand().includes('--test-timeout=180000'));
  assert.ok(unitTestCommand().includes('./scripts/unit-watchdog.js'));
  assert.deepEqual(packUnitTests(['d', 'b', 'c', 'a'], { a: 30, b: 20, c: 10, d: 10 }),
    packUnitTests(['a', 'c', 'b', 'd'], { d: 10, c: 10, b: 20, a: 30 }));
  assert.deepEqual(packUnitTests(['new'], {}, 1).totals, [unitUnknownFileSeconds]);
  for (const weights of [{ a: 0 }, { a: -1 }, { a: Infinity }, { a: NaN }]) {
    assert.throws(() => packUnitTests(['a'], weights), /Invalid/u);
  }
  for (const count of [0, -1, 1.5]) assert.throws(() => packUnitTests(['a'], { a: 1 }, count), /Invalid/u);
  for (const shards of [[['a'], []], [['a'], ['a']], [['a']], [['a'], ['b', 'extra']]]) {
    assert.throws(() => assertUnitCoverage(['a', 'b'], shards), /exactly once/u);
  }
  assert.throws(() => assertUnitHeadroom({ projected: [421] }), /exceeds 420/u);
  assert.throws(() => assertUnitHeadroom({ projected: [NaN] }), /exceeds 420/u);
  assert.doesNotThrow(() => assertUnitHeadroom({ projected: [420] }));
  for (const args of [[], ['--shard'], ['--shard', '0/2'], ['--shard', '3/2'], ['--shard', '1/3'],
    ['--shard', '1/2', '--test-name-pattern=x']]) {
    assert.throws(() => selectUnitShard(args, packing), /Use --shard/u);
  }
  packing.shards.forEach((shard, index) => assert.deepEqual(selectUnitShard(['--shard', `${index + 1}/2`], packing), shard));
  const expected = { runId: '123', sha: 'a'.repeat(40), attempt: 1 };
  const summary = file => ({ type: 'test:summary', success: true, duration_ms: 1, ...(file ? { file } : {}),
    counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } });
  const fixture = ['a', 'b'].map((file, index) => [
    { type: 'run', schema: 1, ...expected, shard: `${index + 1}/2`, files: [file] }, summary(file), summary(),
  ]);
  const plan = { shards: [['a'], ['b']] };
  assert.equal(assertUnitResults(fixture, plan, expected), 2);
  assert.deepEqual(unitFileMeasurements(fixture[0]), { a: { seconds: 0.001, tests: 1 } });
  assert.throws(() => unitFileMeasurements([...fixture[0], summary('a')]), /Duplicate|Incomplete/u);
  assert.throws(() => unitFileMeasurements(fixture[0].slice(0, -1)), /Incomplete/u);
  const invalidDuration = structuredClone(fixture[0]); invalidDuration[1].duration_ms = 0;
  assert.throws(() => unitFileMeasurements(invalidDuration), /Invalid unit file duration/u);
  assert.throws(() => assertUnitResults(fixture.slice(0, 1), plan, expected), /Missing/u);
  for (const change of [
    rows => { rows[0][0].sha = 'b'.repeat(40); },
    rows => { rows[0][0].attempt++; },
    rows => { rows[0][0].files = ['b']; },
    rows => { rows[0][1].file = 'b'; },
    rows => { rows[0].push(summary('a')); },
    rows => { rows[0].pop(); },
    rows => { rows[0][2].counts.tests++; },
    rows => { rows[0][1].success = false; },
    ...['failed', 'cancelled', 'skipped', 'todo'].map(key => rows => { rows[0][1].counts[key] = 1; }),
  ]) {
    const rows = structuredClone(fixture); change(rows);
    assert.throws(() => assertUnitResults(rows, plan, expected));
  }
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
