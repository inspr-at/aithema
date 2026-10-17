// Read-only GitHub access; writes only measured sibling .weight.json files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserWorkload, parseTimingArtifact, updateMeasurement, timingWindow, timingRepository,
  assertTrustedTimingRun, assertPullRequestTimingRun, assertTimingArtifactRun, assertTimingMainHistory } from './browser-timings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), runIds = [];
let pullNumber;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run' && /^\d+$/u.test(args[i + 1] ?? '')) runIds.push(args[++i]);
  else if (args[i] === '--pr' && /^\d+$/u.test(args[i + 1] ?? '') && !pullNumber) pullNumber = args[++i];
  else throw new Error('Use [--run RUN_ID ...] [--pr PR_NUMBER]; only verified canonical main push or explicitly selected current PR artifacts are accepted');
}
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (pullNumber && runIds.length !== 1) throw new Error('--pr requires exactly one --run');
const pull = pullNumber && JSON.parse(gh('api', `repos/${timingRepository}/pulls/${pullNumber}`));
const head = pullNumber && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const observations = new Map();
function readDirectory(directory, expectedRun) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) readDirectory(path, expectedRun);
    else if (entry.name.endsWith('.jsonl')) for (const [file, observation] of Object.entries(parseTimingArtifact(readFileSync(path, 'utf8'), expectedRun))) {
      if (!observations.has(file)) observations.set(file, []);
      observations.get(file).push(observation);
    }
  }
}
if (!runIds.length) {
  runIds.push(...JSON.parse(gh('run', 'list', '--repo', timingRepository, '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', String(timingWindow), '--json', 'databaseId')).map(run => String(run.databaseId)));
}
const temporary = mkdtempSync(join(tmpdir(), 'aithema-browser-timings-'));
try {
  for (const runId of runIds) {
    const run = JSON.parse(gh('api', `repos/${timingRepository}/actions/runs/${runId}`));
    if (pull) assertPullRequestTimingRun(run, runId, pull, head);
    else {
      assertTrustedTimingRun(run, runId);
      const comparison = JSON.parse(gh('api', `repos/${timingRepository}/compare/${run.head_sha}...main`));
      assertTimingMainHistory(comparison, run);
    }
    const artifacts = JSON.parse(gh('api', `repos/${timingRepository}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts
      .filter(artifact => /^browser-timings-[1-6]-of-6$/u.test(artifact.name) && !artifact.expired);
    if (!artifacts.length) { console.log(`CI ${runId}: predates timing artifacts or artifacts expired; skipped`); continue; }
    if (artifacts.length !== 6 || new Set(artifacts.map(artifact => artifact.name)).size !== 6) throw new Error(`CI ${runId}: incomplete six-shard timing artifacts`);
    for (const artifact of artifacts) assertTimingArtifactRun(artifact, run);
    const directory = join(temporary, runId);
    gh('run', 'download', runId, '--repo', timingRepository,
      ...artifacts.flatMap(artifact => ['--name', artifact.name]), '--dir', directory);
    // GitHub PR jobs run the synthetic merge commit. Bind the payload to the
    // independently fetched PR merge SHA, while artifact metadata binds the head.
    readDirectory(directory, pull ? { ...run, head_sha: pull.merge_commit_sha } : run);
  }
  if (!observations.size) throw new Error('No complete CI timing observations found');
  const writes = [];
  for (const [file, values] of observations) {
    if (!existsSync(resolve(root, file))) { console.log(`${file}: removed test; ignored`); continue; }
    const workload = browserWorkload(file, root), path = resolve(root, file.replace(/\.test\.js$/u, '.weight.json'));
    let previous;
    try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!values.some(value => value.workload === workload)) { console.log(`${file}: no observation of current test/fixture workload; unchanged`); continue; }
    const measurement = updateMeasurement(previous, values, workload);
    writes.push([path, `${JSON.stringify(measurement, null, 2)}\n`]);
    console.log(`${file}: ${previous?.seconds ?? 'unmeasured'} -> ${measurement.seconds}s (${measurement.timing.samples.length} CI samples)`);
  }
  // Validate the entire input before writing any weight.
  for (const [path, text] of writes) writeFileSync(path, text);
  if (!writes.length) throw new Error('No observations match the current workload');
} finally { rmSync(temporary, { recursive: true, force: true }); }
