import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserWorkload, p95, measuredSeconds, parseTimingArtifact, updateMeasurement, assertMeasuredWeight, plannedSeconds, assertTrustedTimingRun, assertTimingArtifactRun, assertTimingMainHistory } from '../scripts/browser-timings.js';

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
  assert.throws(() => parseTimingArtifact(artifact({ 2: { counts: { failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 2 } } }) + '\n' + artifact().split('\n')[1]), /duplicate/u);
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
  assert.equal(updateMeasurement(old, [{ workload: changed, sample: sample('2', 10) }], changed).seconds, 12.5, 'hash reset restores the warmup margin');
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
  assert.ok(observed.sample.tests[0].seconds >= 0.01, 'parent includes the real nested duration');
  assert.equal(observed.workload, browserWorkload(file, root));
  const failed = run("const { test } = require('node:test'); test('failed', () => { throw new Error('intentional timing fixture failure'); });");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /intentional timing fixture failure/u);
  assert.throws(() => parseTimingArtifact(failed.stdout), /failed/u);
});

const trustedRun = () => ({ id: 123, event: 'push', head_branch: 'main', head_sha: sha, run_attempt: 1,
  path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
  repository: { full_name: 'inspr-at/aithema' }, head_repository: { id: 42, full_name: 'inspr-at/aithema' } });

test('timing runs require canonical main push provenance even for fork branches called main', () => {
  assert.doesNotThrow(() => assertTrustedTimingRun(trustedRun(), '123'));
  for (const changes of [
    { id: 456 }, { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'merge_group' },
    { head_branch: 'feature' }, { head_repository: { id: 99, full_name: 'fork/aithema' } },
    { repository: { full_name: 'fork/aithema' } }, { head_repository: null }, { head_sha: '' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { run_attempt: 0 }, { path: '.github/workflows/other.yml' },
  ]) assert.throws(() => assertTrustedTimingRun({ ...trustedRun(), ...changes }, '123'), /Untrusted timing run/u);
  for (const status of ['ahead', 'identical']) assert.doesNotThrow(() => assertTimingMainHistory({ status, merge_base_commit: { sha } }, trustedRun()));
  for (const comparison of [{ status: 'behind' }, { status: 'diverged' }, { status: 'ahead', merge_base_commit: { sha: 'c'.repeat(40) } }, {}]) {
    assert.throws(() => assertTimingMainHistory(comparison, trustedRun()), /not on canonical main history/u);
  }
});

test('every timing artifact and payload must match its independently verified run', () => {
  const run = trustedRun(), workflow_run = { id: 123, head_sha: sha, head_branch: 'main', head_repository_id: 42 };
  assert.doesNotThrow(() => assertTimingArtifactRun({ workflow_run }, run));
  for (const changes of [{ id: 456 }, { head_sha: 'c'.repeat(40) }, { head_branch: 'feature' }, { head_repository_id: 99 }]) {
    assert.throws(() => assertTimingArtifactRun({ workflow_run: { ...workflow_run, ...changes } }, run), /provenance mismatch/u);
  }
  assert.throws(() => assertTimingArtifactRun({}, run), /provenance mismatch/u);
  assert.doesNotThrow(() => parseTimingArtifact(artifact(), run));
  for (const changes of [{ runId: '456' }, { sha: 'c'.repeat(40) }, { attempt: 2 }]) {
    assert.throws(() => parseTimingArtifact(artifact({ 0: changes }), run), /header provenance mismatch/u);
  }
});

test('planning adds 25% for one and four samples and uses unpadded p95 at five or more', () => {
  for (const count of [1, 4, 5, 6]) {
    const observations = Array.from({ length: count }, (_, i) => ({ workload, sample: sample(String(i + 1), 10) }));
    const weight = updateMeasurement(undefined, observations, workload);
    assert.equal(weight.seconds, count < 5 ? 12.5 : 10);
    assert.equal(plannedSeconds(weight.timing.samples), weight.seconds);
    assertMeasuredWeight(weight);
    assert.deepEqual(updateMeasurement(weight, observations, workload), weight);
  }
  const four = updateMeasurement(undefined, Array.from({ length: 4 }, (_, i) => ({ workload, sample: sample(String(i + 1), 10) })), workload);
  const five = updateMeasurement(four, [{ workload, sample: sample('5', 10) }], workload);
  assert.equal(five.seconds, 10, 'the fifth sample retires the margin');
  const changed = 'c'.repeat(64);
  const reset = updateMeasurement(five, [{ workload: changed, sample: sample('6', 2) }], changed);
  assert.equal(reset.timing.samples.length, 1);
  assert.equal(reset.seconds, 2.5, 'test-file edits restart the margin as well as the series');
});

test('updater verifies GitHub provenance before importing and rejects local or PR sources', t => {
  const root = mkdtempSync(join(tmpdir(), 'timing-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test/browser'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const script of ['browser-timings.js', 'update-browser-timings.js']) {
    writeFileSync(join(root, 'scripts', script), readFileSync(new URL(`../scripts/${script}`, import.meta.url)));
  }
  writeFileSync(join(root, file), '// fixture workload');
  const payload = artifact({ 0: { files: { [file]: browserWorkload(file, root) } } });
  const run = trustedRun();
  const artifacts = Array.from({ length: 6 }, (_, i) => ({ name: `browser-timings-${i + 1}-of-6`, expired: false,
    workflow_run: { id: run.id, head_sha: sha, head_branch: 'main', head_repository_id: 42 } }));
  const weightPath = join(root, file.replace('.test.js', '.weight.json'));
  const invoke = (changes = {}, args = []) => {
    writeFileSync(join(root, 'gh'), `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), run = ${JSON.stringify({ ...run, ...changes.run })};
const artifacts = ${JSON.stringify(changes.artifacts ?? artifacts)};
const reply = value => process.stdout.write(JSON.stringify(value));
if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/actions/runs/123') reply(run);
else if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/compare/${sha}...main') reply(${JSON.stringify(changes.comparison ?? { status: 'ahead', merge_base_commit: { sha } })});
else if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/actions/runs/123/artifacts?per_page=100') reply({ artifacts });
else if (args[0] === 'run' && args[1] === 'list' && args[args.indexOf('--repo') + 1] === 'inspr-at/aithema' && args[args.indexOf('--event') + 1] === 'push' && args[args.indexOf('--branch') + 1] === 'main') reply([{ databaseId: 123 }]);
else if (args[0] === 'run' && args[1] === 'download' && args[2] === '123' && args[args.indexOf('--repo') + 1] === 'inspr-at/aithema' && JSON.stringify(args.filter((arg, i) => args[i - 1] === '--name')) === JSON.stringify(artifacts.map(a => a.name))) {
  const dir = args[args.indexOf('--dir') + 1]; mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/batch.jsonl', ${JSON.stringify(changes.payload ?? payload)});
} else throw new Error('Unexpected gh command: ' + JSON.stringify(args));
`, { mode: 0o755 });
    return spawnSync(process.execPath, ['scripts/update-browser-timings.js', ...args], {
      cwd: root, encoding: 'utf8', env: { PATH: `${root}:${process.env.PATH}` },
    });
  };
  const success = invoke();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(readFileSync(weightPath)).seconds, 2.5);
  const before = readFileSync(weightPath, 'utf8');
  for (const changes of [
    { run: { event: 'pull_request', head_repository: { id: 99, full_name: 'fork/aithema' } } },
    { run: { event: 'pull_request_target' } }, { run: { head_repository: { id: 99, full_name: 'fork/aithema' } } },
    { comparison: { status: 'diverged', merge_base_commit: { sha } } },
    { artifacts: artifacts.map((a, i) => i ? a : { ...a, workflow_run: { ...a.workflow_run, id: 999 } }) },
    { payload: artifact({ 0: { sha: 'c'.repeat(40) } }) },
  ]) {
    const rejected = invoke(changes, ['--run', '123']);
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stderr, /Untrusted|provenance mismatch|not on canonical main history/u);
    assert.equal(readFileSync(weightPath, 'utf8'), before, 'rejected input writes no weights');
  }
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...artifacts[0], name: `browser-timings-${i + 1}-of-7` }));
  const sevenSuccess = invoke({ artifacts: seven });
  assert.equal(sevenSuccess.status, 0, sevenSuccess.stderr);
  for (const incomplete of [artifacts.slice(1), seven.slice(1), [...seven.slice(1), seven[1]],
    [...artifacts, seven[6]], seven.map((a, i) => i ? a : { ...a, name: 'browser-timings-8-of-7' }),
    seven.map((a, i) => i ? a : { ...a, expired: true })]) {
    const rejected = invoke({ artifacts: incomplete });
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stderr, /incomplete or mixed/u);
    assert.equal(readFileSync(weightPath, 'utf8'), before, 'incomplete input writes no weights');
  }
  const local = invoke({}, ['--artifacts', root]);
  assert.notEqual(local.status, 0);
  assert.match(local.stderr, /only verified canonical main push/u);
});
