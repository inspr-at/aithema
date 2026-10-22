// Import small timing artifacts only; never execute tests or download screenshots.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverUnitTests, repositoryRoot } from './unit-shards.js';

const repository = 'inspr-at/aithema';
// One explicit, immutable profiling exception. Future observations must be main
// pushes. Bootstrap passed all 6,936 tests before a /dev/null reporter fsync
// failed after the complete successful suite summary. Admit those measurements
// only for this exact run/head; this exception cannot admit a failed test.
const bootstrapRun = '39699662257';
const bootstrapHead = '1cd43c080d52b9e825a19088d1aa521e95ae1e85';
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const api = path => JSON.parse(gh(['api', `repos/${repository}/${path}`]));

export function unitFileMeasurements(records) {
  const summaries = records.filter(record => record.type === 'test:summary');
  const final = summaries.filter(record => !record.file), files = summaries.filter(record => record.file);
  if (final.length !== 1 || !files.length || summaries.some(record => !record.success ||
      ['failed', 'cancelled', 'skipped', 'todo'].some(key => record.counts?.[key] !== 0) ||
      !Number.isInteger(record.counts?.tests) || record.counts.tests < 1 || record.counts.passed !== record.counts.tests) ||
      files.reduce((sum, record) => sum + record.counts.tests, 0) !== final[0].counts.tests) {
    throw new Error('Incomplete or unsuccessful unit measurements');
  }
  if (new Set(files.map(record => record.file)).size !== files.length) throw new Error('Duplicate unit file measurements');
  return Object.fromEntries(files.map(record => {
    if (!Number.isFinite(record.duration_ms) || record.duration_ms <= 0) throw new Error('Invalid unit file duration');
    return [record.file, { seconds: record.duration_ms / 1000, tests: record.counts.tests }];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), ids = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--run' || !/^\d+$/u.test(args[index + 1] ?? '')) throw new Error('Use --run RUN_ID [--run RUN_ID ...]');
    ids.push(args[index + 1]);
  }
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Supply distinct CI run IDs');
  const runs = [], samples = new Map(), tests = new Map();
  const files = discoverUnitTests();
  for (const id of ids) {
    const run = api(`actions/runs/${id}`), bootstrap = id === bootstrapRun && run.head_sha === bootstrapHead;
    if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' ||
        (bootstrap ? !['success', 'failure'].includes(run.conclusion) : run.conclusion !== 'success') ||
        (!bootstrap && (run.event !== 'push' || run.head_branch !== 'main'))) {
      throw new Error(`Untrusted unit timing run ${id}: require successful canonical main CI`);
    }
    if (!bootstrap) {
      const comparison = api(`compare/${run.head_sha}...main`);
      if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== run.head_sha) {
        throw new Error('Unit timing head is not on canonical main history');
      }
    }
    const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-timings-'));
    try {
      gh(['run', 'download', id, '--repo', repository, '--pattern', 'unit-timings-*', '--dir', directory]);
      const imported = new Map(); let testedSha;
      for (const artifact of readdirSync(directory)) {
        const records = readFileSync(join(directory, artifact, 'timings.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const header = records[0];
        // PR GITHUB_SHA is the tested merge ref, rather than run.head_sha.
        if (header.type !== 'run' || header.schema !== 1 || header.runId !== id || header.attempt !== run.run_attempt ||
            !/^[a-f\d]{40}$/u.test(header.sha ?? '') || (!bootstrap && header.sha !== run.head_sha) ||
            (testedSha && testedSha !== header.sha)) throw new Error('Unit artifact provenance mismatch');
        testedSha = header.sha;
        for (const [file, measurement] of Object.entries(unitFileMeasurements(records))) {
          if (imported.has(file)) throw new Error(`Duplicate unit file across artifacts: ${file}`);
          imported.set(file, measurement);
        }
      }
      if (JSON.stringify([...imported.keys()].sort()) !== JSON.stringify(files)) throw new Error('Unit measurement file set differs from npm test');
      for (const [file, measurement] of imported) {
        if (!samples.has(file)) samples.set(file, []);
        samples.get(file).push(measurement.seconds);
        if (tests.has(file) && tests.get(file) !== measurement.tests) throw new Error(`Unit test count changed: ${file}`);
        tests.set(file, measurement.tests);
      }
      runs.push({ runId: id, attempt: run.run_attempt, headSha: run.head_sha, testedSha,
        event: run.event, observedAt: run.created_at, conclusion: run.conclusion, bootstrap });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const measured = Object.fromEntries(files.map(file => {
    const values = samples.get(file), sorted = [...values].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    return [file, { seconds: Math.ceil(p95 * (values.length < 5 ? 1.25 : 1) * 1000) / 1000,
      tests: tests.get(file), samples: values }];
  }));
  const measurement = { schema: 1, method: 'whole-file worker duration; nearest-rank p95; 25% margin below five samples',
    runs, totalTests: [...tests.values()].reduce((sum, count) => sum + count, 0), files: measured };
  writeFileSync(resolve(repositoryRoot, 'scripts/unit-timings.json'), JSON.stringify(measurement, null, 2) + '\n');
  console.log(`Imported ${runs.length} CI runs, ${files.length} unit files, ${measurement.totalTests} tests.`);
}
