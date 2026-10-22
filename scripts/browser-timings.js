import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export const timingWindow = 20;
export const timingMinimumSamples = 5;
export const timingWarmupMargin = 1.25;
export const timingRepository = 'inspr-at/aithema';
const positive = value => Number.isFinite(value) && value > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Test/fixture changes start a new workload series. Product changes remain in
// the rolling window, so ordinary implementation variance still informs p95.
export function browserWorkload(file, root = process.cwd()) {
  const sources = new Map();
  function visit(path) {
    const name = relative(root, path).replaceAll('\\', '/');
    if (!name.startsWith('test/') || sources.has(name)) return;
    const bytes = readFileSync(path); sources.set(name, bytes);
    if (!/\.[cm]?js$/u.test(path)) return;
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*)['"](\.[^'"]+)['"]/gu)) {
      const dependency = resolve(dirname(path), match[1]);
      if (existsSync(dependency)) visit(dependency);
    }
  }
  visit(resolve(root, file));
  const hash = createHash('sha256');
  for (const [name, bytes] of [...sources].sort(([a], [b]) => compare(a, b))) hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

export function p95(values) {
  if (!values.length || values.some(value => !positive(value))) throw new Error('p95 needs positive finite observations');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

function validateSample(sample) {
  if (!/^\d+$/u.test(sample?.runId ?? '') || !Number.isInteger(sample.attempt) || sample.attempt < 1 ||
      !/^[a-f\d]{40}$/u.test(sample.sha ?? '') || !Number.isFinite(Date.parse(sample.observedAt)) || !sample.tests?.length) {
    throw new Error('Invalid CI timing provenance');
  }
  const names = new Set();
  for (const test of sample.tests) {
    if (typeof test.name !== 'string' || !test.name.trim() || names.has(test.name) || !positive(test.seconds)) {
      throw new Error('Invalid or duplicate top-level test timing');
    }
    names.add(test.name);
  }
}

export function measuredSeconds(samples) {
  if (!samples.length || samples.length > timingWindow) throw new Error(`Expected 1..${timingWindow} CI samples`);
  const runs = new Set(), durations = new Map();
  let expected;
  for (const sample of samples) {
    validateSample(sample);
    const id = `${sample.runId}-${sample.attempt}`;
    if (runs.has(id)) throw new Error('Duplicate CI timing sample');
    runs.add(id);
    const names = sample.tests.map(test => test.name).sort();
    if (expected && JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Top-level test coverage changed within one workload');
    expected = names;
    for (const { name, seconds } of sample.tests) {
      if (!durations.has(name)) durations.set(name, []);
      durations.get(name).push(seconds);
    }
  }
  // Sum each top-level test's nearest-rank p95, never nested durations. Keep
  // millisecond precision with upward rounding.
  return Math.ceil([...durations.values()].reduce((sum, values) => sum + p95(values), 0) * 1000) / 1000;
}

export function plannedSeconds(samples) {
  const measured = measuredSeconds(samples);
  return samples.length < timingMinimumSamples ? Math.ceil(measured * timingWarmupMargin * 1000) / 1000 : measured;
}

export function assertMeasuredWeight(measurement) {
  const timing = measurement?.timing;
  if (timing?.schema !== 1 || timing.window !== timingWindow || !/^[a-f\d]{64}$/u.test(timing.workload ?? '')) {
    throw new Error('Missing rolling p95 CI timing samples; run scripts/update-browser-timings.js');
  }
  if (measurement.seconds !== plannedSeconds(timing.samples)) throw new Error('Browser weight differs from measured per-test p95 with warmup margin');
}

// REST run metadata comes from the canonical repository, never the artifact.
// Main ancestry must also be confirmed by the caller through GitHub's compare API.
export function assertTrustedTimingRun(run, expectedRunId) {
  if (String(run?.id) !== String(expectedRunId) ||
      !((run.event === 'push' && run.head_branch === 'main') || run.event === 'merge_group') ||
      typeof run.head_branch !== 'string' || !run.head_branch ||
      run.repository?.full_name !== timingRepository || run.head_repository?.full_name !== timingRepository ||
      !Number.isInteger(run.head_repository?.id) || !/^[a-f\d]{40}$/u.test(run.head_sha ?? '') ||
      !Number.isInteger(run.run_attempt) || run.run_attempt < 1 ||
      run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Untrusted timing run ${expectedRunId}: require successful canonical main push or merge-group CI`);
  }
}

export function assertTimingArtifactRun(artifact, run) {
  if (artifact?.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha ||
      artifact.workflow_run.head_branch !== run.head_branch || artifact.workflow_run.head_repository_id !== run.head_repository.id) {
    throw new Error('Timing artifact run provenance mismatch');
  }
}

export function assertTimingMainHistory(comparison, run) {
  if (!['ahead', 'identical'].includes(comparison?.status) || comparison.merge_base_commit?.sha !== run.head_sha) {
    throw new Error(`Timing run ${run.id}: head SHA is not on canonical main history`);
  }
}

export function parseTimingArtifact(text, expectedRun) {
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  const header = records[0], summary = records.findLast(record => record.type === 'test:summary' && !record.file);
  if (expectedRun && (header.runId !== String(expectedRun.id) || header.sha !== expectedRun.head_sha || header.attempt !== expectedRun.run_attempt)) {
    throw new Error('Timing artifact header provenance mismatch');
  }
  if (header?.type !== 'run' || header.schema !== 1 || !header.files || !summary?.success ||
      ['failed', 'cancelled', 'skipped', 'todo'].some(key => summary.counts?.[key] !== 0)) {
    throw new Error('Incomplete, failed, skipped or unsupported browser timing artifact');
  }
  const files = Object.keys(header.files), tests = new Map(files.map(file => [file, []]));
  if (!files.length || files.some(file => !/^test\/browser\/[^/]+\.test\.js$/u.test(file) || !/^[a-f\d]{64}$/u.test(header.files[file]))) {
    throw new Error('Invalid browser timing file manifest');
  }
  for (const record of records.slice(1)) {
    if (!['test:pass', 'test:fail'].includes(record.type)) continue;
    const path = record.file?.replaceAll('\\', '/');
    const file = files.find(file => path === file || path?.endsWith(`/${file}`));
    if (!file || record.type !== 'test:pass' || record.skip || record.todo) throw new Error('Unsuccessful or unassigned browser timing');
    tests.get(file).push({ name: record.name, seconds: record.seconds });
  }
  if (summary.counts.topLevel !== [...tests.values()].reduce((sum, values) => sum + values.length, 0)) {
    throw new Error('Incomplete top-level timing coverage');
  }
  return Object.fromEntries(files.map(file => {
    const sample = { runId: header.runId, attempt: header.attempt, sha: header.sha,
      observedAt: header.observedAt, tests: tests.get(file).sort((a, b) => compare(a.name, b.name)) };
    validateSample(sample);
    return [file, { workload: header.files[file], sample }];
  }));
}

export function updateMeasurement(previous, observations, workload) {
  const samples = new Map();
  if (previous?.timing?.workload === workload) {
    assertMeasuredWeight(previous);
    for (const sample of previous.timing.samples) samples.set(`${sample.runId}-${sample.attempt}`, sample);
  }
  for (const observation of observations) {
    if (observation.workload !== workload) continue;
    validateSample(observation.sample);
    const sample = observation.sample, key = `${sample.runId}-${sample.attempt}`;
    if (samples.has(key) && JSON.stringify(samples.get(key)) !== JSON.stringify(sample)) throw new Error(`Conflicting timing observation ${key}`);
    samples.set(key, sample);
  }
  const latest = [...samples.values()].sort((a, b) => compare(a.observedAt, b.observedAt) || Number(a.runId) - Number(b.runId) || a.attempt - b.attempt).slice(-timingWindow);
  return { seconds: plannedSeconds(latest), evidence: `Sum of top-level test rolling p95 (nearest rank, latest ${timingWindow} successful CI executions per workload); ${latest.length < timingMinimumSamples ? '25% warmup margin until 5 samples; ' : ''}runs ${latest.map(sample => `${sample.runId}-${sample.attempt}`).join(', ')}. Source: browser-timings-N-of-M artifacts; npm run update:browser-timings.`,
    timing: { schema: 1, window: timingWindow, workload, samples: latest } };
}
