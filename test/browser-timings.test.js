import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserWorkload, p95, measuredSeconds, parseTimingArtifact, updateMeasurement, assertMeasuredWeight } from '../scripts/browser-timings.js';

const workload = 'a'.repeat(64), sha = 'b'.repeat(40), file = 'test/browser/example.test.js';
const sample = (runId = '1', seconds = 10) => ({ runId, attempt: 1, sha, observedAt: new Date(2026, 9, Number(runId)).toISOString(), tests: [{ name: 'first', seconds }] });
const artifact = overrides => [
  { type: 'run', schema: 1, runId: '123', attempt: 1, sha, observedAt: '2026-10-16T12:00:00Z', files: { [file]: workload } },
  { type: 'test:pass', file: `/checkout/${file}`, name: 'first', seconds: 2, skip: false, todo: false },
  { type: 'test:summary', success: true, counts: { failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 1 } },
].map((record, index) => JSON.stringify({ ...record, ...overrides?.[index] })).join('\n');

test('nearest-rank rolling p95 uses measured observations, including a warming window', () => {
  assert.equal(p95([1]), 1);
  assert.equal(p95([3, 1, 2]), 3);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => 20 - i)), 19);
  for (const values of [[], [0], [-1], [NaN], [Infinity], ['10']]) assert.throws(() => p95(values), /positive finite/u);
  assert.equal(measuredSeconds([{ ...sample(), tests: [{ name: 'a', seconds: 1 }, { name: 'b', seconds: 10 }] },
    { ...sample('2'), tests: [{ name: 'a', seconds: 10 }, { name: 'b', seconds: 1 }] }]), 20, 'sum per-test p95, rather than p95 of the file sum');
});

test('artifact import retains CI provenance and rejects incomplete or unsuccessful coverage', () => {
  const parsed = parseTimingArtifact(artifact());
  assert.equal(parsed[file].workload, workload);
  assert.deepEqual(parsed[file].sample.tests, [{ name: 'first', seconds: 2 }]);
  assert.equal(parsed[file].sample.runId, '123');
  for (const overrides of [
    { 2: { success: false } }, { 2: { counts: { failed: 1, cancelled: 0, skipped: 0, todo: 0 } } },
    { 1: { skip: true } }, { 1: { todo: true } }, { 1: { type: 'test:fail' } },
    { 1: { seconds: 0 } }, { 1: { file: '/checkout/test/browser/unknown.test.js' } },
    { 0: { runId: 'remote' } }, { 0: { files: {} } }, { 0: { sha: '' } },
  ]) assert.throws(() => parseTimingArtifact(artifact(overrides)));
  assert.throws(() => parseTimingArtifact(artifact().split('\n').slice(0, 2).join('\n')), /Incomplete/u);
  assert.throws(() => parseTimingArtifact(artifact() + '\n' + artifact().split('\n')[1]), /duplicate/u);
});

test('updates are deterministic, idempotent and keep only the latest twenty executions', () => {
  const observations = Array.from({ length: 21 }, (_, i) => ({ workload, sample: sample(String(i + 1), i + 1) }));
  const weight = updateMeasurement(undefined, observations.reverse(), workload);
  assert.equal(weight.timing.samples.length, 20);
  assert.equal(weight.timing.samples[0].runId, '2');
  assert.equal(weight.seconds, 20);
  assertMeasuredWeight(weight);
  assert.deepEqual(updateMeasurement(weight, observations, workload), weight);
  assert.throws(() => updateMeasurement(weight, [{ workload, sample: sample('2', 99) }], workload), /Conflicting/u);
  assert.throws(() => assertMeasuredWeight({ ...weight, seconds: 21 }), /differs/u);
});

test('changed workloads retire the old series; changed test coverage cannot silently shrink a sample', () => {
  const old = updateMeasurement(undefined, [{ workload, sample: sample('1', 100) }], workload);
  const changed = 'c'.repeat(64);
  assert.equal(updateMeasurement(old, [{ workload: changed, sample: sample('2', 10) }], changed).seconds, 10);
  assert.throws(() => updateMeasurement(old, [], changed), /Expected 1/u);
  assert.throws(() => measuredSeconds([sample(), { ...sample('2'), tests: [{ name: 'different', seconds: 1 }] }]), /coverage changed/u);
  assert.throws(() => measuredSeconds([sample(), sample()]), /Duplicate/u);
});

test('workload fingerprints follow test helpers and fixtures without including product implementation', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-workload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  mkdirSync(join(root, 'test/fixtures'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  writeFileSync(join(root, file), "import './helper.js';\nnew URL('../fixtures/server.js', import.meta.url);\n");
  writeFileSync(join(root, 'test/browser/helper.js'), "import './example.test.js';\nimport '../../packages/product.js';\n");
  writeFileSync(join(root, 'test/fixtures/server.js'), 'fixture one');
  writeFileSync(join(root, 'packages/product.js'), 'product one');
  const before = browserWorkload(file, root);
  writeFileSync(join(root, 'packages/product.js'), 'product two');
  assert.equal(browserWorkload(file, root), before);
  writeFileSync(join(root, 'test/fixtures/server.js'), 'fixture two');
  assert.notEqual(browserWorkload(file, root), before);
});

test('the actual Node reporter records the parent once and rejects a real failed run', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-timing-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  const reporter = fileURLToPath(new URL('../scripts/browser-timing-reporter.js', import.meta.url));
  const run = source => {
    writeFileSync(join(root, file), source);
    return spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], { cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha, BROWSER_TIMING_FILES: JSON.stringify([file]) } });
  };
  const passed = run("const { test } = require('node:test'); test('parent', async t => { await t.test('child', async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); });");
  assert.equal(passed.status, 0, passed.stderr);
  const observed = parseTimingArtifact(passed.stdout)[file];
  assert.equal(observed.sample.tests.length, 1);
  assert.equal(observed.sample.tests[0].name, 'parent');
  assert.ok(observed.sample.tests[0].seconds >= 0.02, 'parent includes the real nested duration');
  assert.equal(observed.workload, browserWorkload(file, root));
  const failed = run("const { test } = require('node:test'); test('failed', () => { throw new Error('intentional timing fixture failure'); });");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /intentional timing fixture failure/u);
  assert.throws(() => parseTimingArtifact(failed.stdout), /failed/u);
});
