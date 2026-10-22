import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserWorkload } from '../scripts/browser-timings.js';

const sha = 'a'.repeat(40), branch = 'gh-readonly-queue/main/pr-123-aaa';
const run = { id: 123, event: 'merge_group', head_branch: branch, head_sha: sha, run_attempt: 1,
  path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z',
  repository: { full_name: 'inspr-at/aithema' }, head_repository: { id: 42, full_name: 'inspr-at/aithema' } };

for (const family of ['browser', 'unit']) test(`${family} collector imports only canonical CI on main history with matching artifact provenance`, t => {
  const root = mkdtempSync(join(tmpdir(), `merge-group-${family}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts', 'test/browser']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.js' } }));
  for (const script of ['browser-timings.js', 'update-browser-timings.js', 'unit-shards.js', 'check-unit-results.js', 'update-unit-timings.js']) {
    writeFileSync(join(root, 'scripts', script), readFileSync(new URL(`../scripts/${script}`, import.meta.url)));
  }
  const file = family === 'browser' ? 'test/browser/example.test.js' : 'test/example.test.js';
  writeFileSync(join(root, file), '// fixture workload');
  const resultPath = join(root, family === 'browser' ? file.replace('.test.js', '.weight.json') : 'scripts/unit-timings.json');
  const header = { type: 'run', schema: 1, runId: '123', attempt: 1, sha, shard: '1/1', observedAt: run.created_at,
    files: family === 'browser' ? { [file]: browserWorkload(file, root) } : [file] };
  const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 1 };
  const records = family === 'browser' ? [header,
    { type: 'test:pass', file, name: 'fixture', seconds: 1 }, { type: 'test:summary', success: true, counts }]
    : [header, { type: 'test:summary', file, success: true, counts, duration_ms: 1000 },
      { type: 'test:summary', success: true, counts, duration_ms: 1000 }];
  const invoke = (changes = {}, automatic = false) => {
    const metadata = { ...run, ...changes.run };
    const artifacts = Array.from({ length: 8 }, (_, i) => ({ name: `browser-timings-${i + 1}-of-8`, expired: false,
      workflow_run: { id: 123, head_sha: sha, head_branch: metadata.head_branch, head_repository_id: 42, ...changes.artifact } }));
    const payload = [{ ...header, ...changes.header }, ...records.slice(1)].map(record => JSON.stringify(record)).join('\n');
    const job = { name: 'unit (1/1)', run_id: 123, run_attempt: 1, status: 'completed', conclusion: 'success',
      started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:02Z' };
    writeFileSync(join(root, 'gh'), `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), reply = value => process.stdout.write(JSON.stringify(value));
if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/actions/runs/123') reply(${JSON.stringify(metadata)});
else if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/compare/${sha}...main') reply(${JSON.stringify(changes.comparison ?? { status: 'ahead', merge_base_commit: { sha } })});
else if (args[0] === 'api' && args[1] === 'repos/inspr-at/aithema/actions/runs/123/artifacts?per_page=100') reply({ artifacts: ${JSON.stringify(artifacts)} });
else if (args[0] === 'api' && args.includes('repos/inspr-at/aithema/actions/runs/123/jobs?filter=all&per_page=100')) reply([{ jobs: [${JSON.stringify(job)}] }]);
else if (args[0] === 'run' && args[1] === 'list') {
  if (args.includes('push')) reply([]);
  else if (args.includes('merge_group') && !args.includes('--branch')) reply([{ databaseId: 123 }]);
  else throw new Error('Discovery must select trusted event candidates without a main branch filter on merge groups');
} else if (args[0] === 'run' && args[1] === 'download' && args[2] === '123') {
  const dir = args[args.indexOf('--dir') + 1] + ${JSON.stringify(family === 'unit' ? '/unit-timings-1-of-1-attempt-1' : '')};
  mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/timings.jsonl', ${JSON.stringify(payload)});
} else throw new Error('Unexpected gh call: ' + JSON.stringify(args));
`, { mode: 0o755 });
    return spawnSync(process.execPath, [`scripts/update-${family}-timings.js`, ...(automatic ? [] : ['--run', '123'])], {
      cwd: root, encoding: 'utf8', env: { PATH: `${root}:${process.env.PATH}` },
    });
  };
  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr);
  const before = readFileSync(resultPath, 'utf8');
  const push = invoke({ run: { event: 'push', head_branch: 'main' } });
  assert.equal(push.status, 0, push.stderr);
  // Restore the merge-group fixture for atomic-write rejection checks.
  assert.equal(invoke().status, 0);
  for (const changes of [
    { run: { event: 'pull_request' } }, { run: { event: 'pull_request_target' } },
    { run: { head_repository: { id: 99, full_name: 'fork/aithema' } } },
    { run: { repository: { full_name: 'fork/aithema' } } },
    { run: { event: 'push', head_branch: branch } }, { run: { conclusion: 'failure' } },
    { run: { path: '.github/workflows/other.yml' } },
    { comparison: { status: 'diverged', merge_base_commit: { sha } } },
    { comparison: { status: 'ahead', merge_base_commit: { sha: 'b'.repeat(40) } } },
    { header: { sha: 'b'.repeat(40) } }, { header: { runId: '456' } }, { header: { attempt: 2 } },
    ...(family === 'browser' ? [{ artifact: { head_branch: 'main' } }, { artifact: { id: 456 } },
      { artifact: { head_repository_id: 99 } }, { artifact: { head_sha: 'b'.repeat(40) } }] : []),
  ]) {
    const rejected = invoke(changes);
    assert.notEqual(rejected.status, 0, JSON.stringify(changes));
    assert.equal(readFileSync(resultPath, 'utf8'), before, 'rejected input must leave measurements untouched');
  }
  if (family === 'browser') {
    const discovered = invoke({}, true);
    assert.equal(discovered.status, 0, discovered.stderr);
  }
});
