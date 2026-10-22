import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { discoverUnitTests, readUnitWeights, packUnitTests, assertUnitCoverage, assertUnitHeadroom, unitShardCount, unitUnknownFileSeconds } from '../scripts/unit-shards.js';
import * as results from '../scripts/check-unit-results.js';

const expected = { runId: '123', sha: 'a'.repeat(40), attempt: 2, shardAttempts: [2, 1] };
const plan = { shards: [['a'], ['b']] };
const summary = file => ({ type: 'test:summary', success: true, duration_ms: 1000,
  ...(file ? { file } : {}), counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } });
const manifests = () => ['a', 'b'].map((file, index) => [
  { type: 'run', schema: 1, ...expected, attempt: expected.shardAttempts[index], shard: `${index + 1}/2`, files: [file] },
  summary(file), summary(),
]);

test('AIT-456: one unknown new unit file fits the plan without a main timing import', () => {
  const files = [...discoverUnitTests(), 'test/new-average-file.test.js'];
  const packing = packUnitTests(files, readUnitWeights());
  assertUnitCoverage(files, packing.shards);
  assert.doesNotThrow(() => assertUnitHeadroom(packing));
  assert.throws(() => assertUnitHeadroom(packUnitTests(['slow'], { slow: 421 }, 1)), /exceeds 420/u);
});

test('AIT-456: a partial rerun accepts each shard latest successful attempt and proves the count', () => {
  assert.equal(results.assertUnitResults(manifests(), plan, expected), 2);
  const stale = manifests(); stale[0][0].attempt = 1;
  assert.throws(() => results.assertUnitResults(stale, plan, expected), /provenance/u);
  const future = manifests(); future[1][0].attempt = 3;
  assert.throws(() => results.assertUnitResults(future, plan, expected), /provenance/u);
  const duplicate = manifests(); duplicate[0].push(summary('a'));
  assert.throws(() => results.assertUnitResults(duplicate, plan, expected), /exactly-once/u);
});

test('AIT-456: measured overruns and missing or invalid durations fail closed', () => {
  const current = { ...expected, attempt: 1, shardAttempts: [1, 1] };
  for (const duration of [395001, 0, -1, NaN, Infinity, undefined, '1000']) {
    const rows = manifests(); rows[0][0].attempt = 1; rows[0][2].duration_ms = duration;
    assert.throws(() => results.assertUnitResults(rows, plan, current), /duration|exceeds 420/u);
  }
  const boundary = manifests(); boundary[0][0].attempt = 1; boundary[0][2].duration_ms = 395000;
  assert.equal(results.assertUnitResults(boundary, plan, current), 2);
});

test('AIT-456: three is the smallest count with average-file growth room; the boundary fails closed', () => {
  // A fixed duration fixture keeps this boundary test independent of future
  // test-file additions and timing refreshes. Discovery is checked above.
  const files = Array.from({ length: 9 }, (_, index) => `measured-${index}`);
  const weights = Object.fromEntries(files.map(file => [file, 180]));
  assert.equal(unitUnknownFileSeconds, 8);
  assert.equal(unitShardCount, 3);
  for (const count of [1, 2]) assert.throws(() => assertUnitHeadroom(packUnitTests(files, weights, count)), /exceeds 420/u);
  const withGrowth = count => packUnitTests([...files,
    ...Array.from({ length: count }, (_, index) => `test/future-${String(index).padStart(4, '0')}.test.js`)], weights);
  let growth = 0;
  while (Math.max(...withGrowth(growth + 1).projected) <= 420) growth++;
  assert.ok(growth > 1);
  assert.doesNotThrow(() => assertUnitHeadroom(withGrowth(growth)));
  assert.throws(() => assertUnitHeadroom(withGrowth(growth + 1)), /exceeds 420/u);
});

const job = (shard, attempt, extra = {}) => ({ name: `unit (${shard}/2)`, run_id: 123, run_attempt: attempt,
  runner_id: 42, runner_name: 'fixture-runner', head_sha: expected.sha,
  steps: [{ name: 'Set up job', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z', conclusion: 'success' }],
  status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:03:00Z', ...extra });
const jobs = () => [job(1, 1, { conclusion: 'failure' }), job(2, 1), job(1, 2)];

test('AIT-456: latest job metadata permits partial reruns and rejects failed, missing or ambiguous latest jobs', () => {
  const latest = results.latestUnitJobs(jobs(), 2, expected);
  assert.deepEqual(latest.map(row => row.run_attempt), [2, 1]);
  for (const change of [
    rows => { rows.pop(); }, rows => { rows.splice(1, 1); }, rows => { rows.push(job(1, 2)); },
    rows => { rows[2].conclusion = 'failure'; }, rows => { rows[2].conclusion = 'cancelled'; },
    rows => { rows[2].status = 'in_progress'; }, rows => { rows[2].run_attempt = 3; },
    rows => { rows[2].run_id = 456; }, rows => { delete rows[2].run_attempt; },
    rows => { rows[2].completed_at = 'invalid'; }, rows => { rows[2].completed_at = rows[2].started_at; },
    rows => { rows[2].completed_at = '2026-01-01T00:07:01Z'; },
  ]) {
    const rows = jobs(); change(rows);
    assert.throws(() => results.latestUnitJobs(rows, 2, expected));
  }
  const boundary = jobs(); boundary[2].completed_at = '2026-01-01T00:07:00Z';
  assert.equal(results.latestUnitJobs(boundary, 2, expected).length, 2);
});

test('AIT-456: GitHub copied successful jobs retain their actual execution attempt, but a rerun needs fresh evidence', () => {
  // GitHub creates new check IDs/run_attempt values for retained successes,
  // copying the original timestamps, runner and steps (CI 39704541114).
  const rows = [job(1, 1), job(2, 1), job(2, 2), job(1, 2, {
    started_at: '2026-01-01T00:04:00Z', completed_at: '2026-01-01T00:06:00Z',
  })];
  const latest = results.latestUnitJobs(rows, 2, expected);
  assert.deepEqual(latest.map(row => row.run_attempt), [2, 1]);
  assert.equal(results.assertUnitResults(manifests(), plan, { ...expected, shardAttempts: latest.map(row => row.run_attempt) }), 2);
  const stale = manifests(); stale[0][0].attempt = 1;
  assert.throws(() => results.assertUnitResults(stale, plan, { ...expected, shardAttempts: latest.map(row => row.run_attempt) }), /provenance/u);
  const actualRerun = structuredClone(rows);
  actualRerun[2].started_at = '2026-01-01T00:04:00Z'; actualRerun[2].completed_at = '2026-01-01T00:06:00Z';
  assert.deepEqual(results.latestUnitJobs(actualRerun, 2, expected).map(row => row.run_attempt), [2, 2]);
  for (const change of [
    row => { row.runner_id++; }, row => { row.runner_name = 'other'; }, row => { row.head_sha = 'b'.repeat(40); },
    row => { row.steps[0].completed_at = '2026-01-01T00:00:02Z'; }, row => { delete row.steps; },
  ]) {
    const distinct = structuredClone(rows); change(distinct[2]);
    assert.deepEqual(results.latestUnitJobs(distinct, 2, expected).map(row => row.run_attempt), [2, 2]);
  }
  for (const field of ['runner_name', 'head_sha', 'runner_id', 'steps']) {
    const incomplete = structuredClone(rows); incomplete.forEach(row => { delete row[field]; });
    assert.deepEqual(results.latestUnitJobs(incomplete, 2, expected).map(row => row.run_attempt), [2, 2]);
  }
});

test('AIT-456: artifact selection uses the jobs latest attempts and never falls back to a stale manifest', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-rerun-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (shard, attempt, rows) => {
    const path = join(directory, `unit-timings-${shard}-of-2-attempt-${attempt}`);
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'timings.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  };
  const stale = manifests(); stale[0][0].attempt = 1;
  write(1, 1, stale[0]); write(2, 1, stale[1]);
  assert.throws(() => results.readUnitResultArtifacts(directory, 2, expected), /ENOENT/u);
  write(1, 2, stale[0]);
  assert.throws(() => results.assertUnitResults(results.readUnitResultArtifacts(directory, 2, expected), plan, expected), /provenance/u);
  write(1, 2, manifests()[0]);
  assert.equal(results.assertUnitResults(results.readUnitResultArtifacts(directory, 2, expected), plan, expected), 2);
});

test('AIT-456: job lookup requests all attempts and pages before choosing the latest shard', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-jobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, 'calls.json');
  const pages = [{ jobs: jobs().slice(0, 2) }, { jobs: jobs().slice(2) }];
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(pages))});\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = directory + ':' + originalPath;
    const rows = results.fetchUnitJobs('123', 'inspr-at/aithema');
    assert.deepEqual(rows, jobs());
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), ['api', '--paginate', '--slurp',
      'repos/inspr-at/aithema/actions/runs/123/jobs?filter=all&per_page=100']);
    assert.deepEqual(results.latestUnitJobs(rows, 2, expected).map(row => row.run_attempt), [2, 1]);
    assert.throws(() => results.fetchUnitJobs('invalid', 'inspr-at/aithema'), /scope/u);
    assert.throws(() => results.fetchUnitJobs('123', '../other'), /scope/u);
  } finally { process.env.PATH = originalPath; }
});

test('AIT-456: workflow retains attempt-specific evidence and grants only the aggregate job read access to jobs', () => {
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(ci.permissions, { contents: 'read' });
  assert.deepEqual(ci.jobs.test.permissions, { contents: 'read', actions: 'read' });
  const download = ci.jobs.test.steps.find(step => step.name === 'Download unit result manifests');
  assert.equal(download.with.pattern, 'unit-timings-*-of-3-attempt-*');
  const verify = ci.jobs.test.steps.find(step => step.run?.includes('check-unit-results.js'));
  assert.deepEqual(verify.env, { GH_TOKEN: '${{ github.token }}' });
  for (const id of ['test', 'unit']) {
    for (const step of ci.jobs[id].steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))) {
      assert.ok(step.with.name.endsWith('-attempt-${{ github.run_attempt }}'));
      assert.equal(step.with.overwrite, undefined);
    }
  }
});
