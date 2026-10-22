import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertUnitMeasuredHeadroom, unitJobTargetSeconds, unitPlan } from './unit-shards.js';

// filter=all includes jobs retained from earlier attempts after a partial rerun.
// Paginate: counting just the first page could hide a more recent failed job.
export function fetchUnitJobs(runId, repository = process.env.GITHUB_REPOSITORY) {
  if (!/^\d+$/u.test(runId ?? '') || !/^[a-z\d][a-z\d-]*\/[a-z\d][\w.-]*$/iu.test(repository ?? '')) throw new Error('Invalid unit jobs API scope');
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
    `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page.jobs))) throw new Error('Missing unit jobs API pages');
  return pages.flatMap(page => page.jobs);
}

export function latestUnitJobs(jobs, count, expectedRun) {
  if (!Number.isInteger(expectedRun.attempt) || expectedRun.attempt < 1) throw new Error('Invalid unit run attempt');
  return Array.from({ length: count }, (_, index) => {
    const matching = jobs.filter(job => job.name === `unit (${index + 1}/${count})`);
    if (!matching.length || matching.some(job => String(job.run_id) !== expectedRun.runId ||
        !Number.isInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > expectedRun.attempt)) {
      throw new Error('Missing unit job or invalid job provenance');
    }
    const attempt = Math.max(...matching.map(job => job.run_attempt));
    const latest = matching.filter(job => job.run_attempt === attempt);
    if (latest.length !== 1 || latest[0].status !== 'completed' || latest[0].conclusion !== 'success') {
      throw new Error('Latest unit shard attempt did not succeed');
    }
    const job = latest[0], seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid measured unit job duration');
    if (seconds > unitJobTargetSeconds) throw new Error(`Measured unit job exceeds ${unitJobTargetSeconds}s: ${job.name} ${seconds}s`);
    // GitHub copies retained successes into a rerun with new check IDs and
    // run_attempt, but the ORIGINAL execution timestamps, runner and steps.
    // Find that execution's first attempt, never an older distinct execution.
    // Missing history/metadata cannot authorize fallback to an old artifact.
    const execution = matching.filter(row => row.status === 'completed' && row.conclusion === 'success' &&
      row.started_at === job.started_at && row.completed_at === job.completed_at && row.head_sha === job.head_sha &&
      /^[a-f\d]{40}$/u.test(row.head_sha ?? '') && typeof row.runner_name === 'string' && row.runner_name.length > 0 &&
      Number.isInteger(row.runner_id) && row.runner_id > 0 && row.runner_id === job.runner_id && row.runner_name === job.runner_name &&
      Array.isArray(row.steps) && row.steps.length > 0 && JSON.stringify(row.steps) === JSON.stringify(job.steps));
    return execution.sort((a, b) => a.run_attempt - b.run_attempt)[0] ?? job;
  });
}

export function readUnitResultArtifacts(directory, count, expectedRun) {
  if (expectedRun.shardAttempts?.length !== count) throw new Error('Missing latest unit shard attempts');
  return expectedRun.shardAttempts.map((attempt, index) => readFileSync(resolve(directory,
    `unit-timings-${index + 1}-of-${count}-attempt-${attempt}`, 'timings.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)));
}

export function assertUnitResults(recordsByShard, packing, expectedRun) {
  if (recordsByShard.length !== packing.shards.length) throw new Error('Missing unit shard results');
  let tests = 0;
  for (let index = 0; index < packing.shards.length; index++) {
    const records = recordsByShard[index], header = records[0];
    if (header?.type !== 'run' || header.schema !== 1 || header.shard !== `${index + 1}/${packing.shards.length}` ||
        header.runId !== expectedRun.runId || header.sha !== expectedRun.sha ||
        !Number.isInteger(header.attempt) || header.attempt < 1 || header.attempt > expectedRun.attempt ||
        header.attempt !== (expectedRun.shardAttempts?.[index] ?? expectedRun.attempt) ||
        JSON.stringify([...(header.files ?? [])].sort()) !== JSON.stringify([...packing.shards[index]].sort())) {
      throw new Error('Unit artifact provenance or assignment mismatch');
    }
    const summaries = records.slice(1), final = summaries.filter(record => !record.file);
    if (final.length !== 1 || summaries.some(record => record.type !== 'test:summary' || !record.success ||
        ['failed', 'cancelled', 'skipped', 'todo'].some(key => record.counts?.[key] !== 0) ||
        !Number.isInteger(record.counts?.tests) || record.counts.tests < 1 || record.counts.passed !== record.counts.tests)) {
      throw new Error('Incomplete or unsuccessful unit summary');
    }
    const files = summaries.filter(record => record.file);
    if (JSON.stringify(files.map(record => record.file).sort()) !== JSON.stringify([...packing.shards[index]].sort()) ||
        files.reduce((sum, record) => sum + record.counts.tests, 0) !== final[0].counts.tests) {
      throw new Error('Unit result files/counts do not match the exactly-once assignment');
    }
    if (!Number.isFinite(final[0].duration_ms)) throw new Error('Invalid measured unit duration');
    assertUnitMeasuredHeadroom(final[0].duration_ms / 1000);
    tests += final[0].counts.tests;
  }
  return tests;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packing = unitPlan();
  const expectedRun = { runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  const jobs = latestUnitJobs(fetchUnitJobs(expectedRun.runId), packing.shards.length, expectedRun);
  expectedRun.shardAttempts = jobs.map(job => job.run_attempt);
  const records = readUnitResultArtifacts(process.argv[2], packing.shards.length, expectedRun);
  const tests = assertUnitResults(records, packing, expectedRun);
  records.forEach((rows, index) => {
    const summary = rows.find(row => row.type === 'test:summary' && !row.file);
    const job = jobs[index], seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
    console.log(`Unit shard ${index + 1}/${records.length}: attempt ${job.run_attempt}; ${summary.counts.tests} tests; ` +
      `${(summary.duration_ms / 1000).toFixed(3)}s suite elapsed; ${seconds}s complete job / ${unitJobTargetSeconds}s target.`);
  });
  const baseline = JSON.parse(readFileSync(new URL('./unit-timings.json', import.meta.url), 'utf8'));
  console.log(`Unit count evidence: measured baseline ${baseline.totalTests}; current ${tests}.`);
  console.log(`Unit coverage verified: ${tests} tests passed, ${packing.shards.flat().length} files exactly once; zero failed/cancelled/skipped/todo.`);
}
