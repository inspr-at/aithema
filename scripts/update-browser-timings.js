// Read-only GitHub access; writes only measured sibling .weight.json files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserWorkload, parseTimingArtifact, updateMeasurement, timingWindow } from './browser-timings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), runIds = [], directories = [];
let branch = 'main';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run' && /^\d+$/u.test(args[i + 1] ?? '')) runIds.push(args[++i]);
  else if (args[i] === '--artifacts' && args[i + 1]) directories.push(resolve(args[++i]));
  else if (args[i] === '--branch' && args[i + 1]) branch = args[++i];
  else throw new Error('Use [--branch main] [--run RUN_ID ...] [--artifacts DIRECTORY ...]');
}
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const observations = new Map();
function readDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) readDirectory(path);
    else if (entry.name.endsWith('.jsonl')) for (const [file, observation] of Object.entries(parseTimingArtifact(readFileSync(path, 'utf8')))) {
      if (!observations.has(file)) observations.set(file, []);
      observations.get(file).push(observation);
    }
  }
}
if (!runIds.length && !directories.length) {
  runIds.push(...JSON.parse(gh('run', 'list', '--workflow', 'ci.yml', '--branch', branch, '--status', 'success', '--limit', String(timingWindow), '--json', 'databaseId')).map(run => String(run.databaseId)));
}
const temporary = mkdtempSync(join(tmpdir(), 'aithema-browser-timings-'));
try {
  for (const runId of runIds) {
    const run = JSON.parse(gh('run', 'view', runId, '--json', 'conclusion,status'));
    if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error(`CI run ${runId} is not green`);
    const artifacts = JSON.parse(gh('api', `repos/{owner}/{repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts
      .filter(artifact => /^browser-timings-[1-6]-of-6$/u.test(artifact.name) && !artifact.expired);
    if (!artifacts.length) { console.log(`CI ${runId}: predates timing artifacts or artifacts expired; skipped`); continue; }
    if (new Set(artifacts.map(artifact => artifact.name)).size !== 6) throw new Error(`CI ${runId}: incomplete six-shard timing artifacts`);
    const directory = join(temporary, runId);
    gh('run', 'download', runId, '--pattern', 'browser-timings-*-of-6', '--dir', directory);
    readDirectory(directory);
  }
  for (const directory of directories) readDirectory(directory);
  if (!observations.size) throw new Error('No complete CI timing observations found');
  const writes = [];
  for (const [file, values] of observations) {
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
