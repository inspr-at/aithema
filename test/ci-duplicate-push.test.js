import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const sha = 'a'.repeat(40), repository = 'inspr-at/aithema';
const run = () => ({ id: 123, name: 'ci', path: '.github/workflows/ci.yml', event: 'merge_group',
  head_sha: sha, status: 'completed', conclusion: 'success',
  repository: { full_name: repository }, head_repository: { full_name: repository } });
const context = (event = 'push', duplicate = '123', result = 'success', attempt = 1) => ({
  github: { event_name: event, ref: 'refs/heads/main', run_attempt: attempt },
  needs: { changes: { result, outputs: { 'duplicate-of': duplicate, 'docs-only': 'false' } } },
  cancelled: () => false, always: () => true,
});
const evaluate = (expression, ctx) => runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, '')
  .replaceAll('outputs.duplicate-of', "outputs['duplicate-of']").replaceAll('outputs.docs-only', "outputs['docs-only']"), ctx);

function lookup(t, response = { workflow_runs: [run()] }, { event = 'push', ref = 'refs/heads/main', attempt = '1', failure = false, timeout = false } = {}) {
  const step = ci.jobs.changes.steps.find(step => step.id === 'duplicate');
  assert.ok(step, 'changes must contain the bounded, fail-safe duplicate lookup');
  const directory = mkdtempSync(join(tmpdir(), 'duplicate-push-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output'), summary = join(directory, 'summary'), calls = join(directory, 'calls');
  for (const path of [output, summary, calls]) writeFileSync(path, '');
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${failure ? 'process.exit(1);' : `process.stdout.write(${JSON.stringify(typeof response === 'string' ? response : JSON.stringify(response))});`}
`, { mode: 0o755 });
  // Inject an immediate subprocess timeout: no real waiting or network.
  const script = timeout ? step.run.replace("import subprocess", "import subprocess\nsubprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired(args[0], kwargs['timeout']))") : step.run;
  const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH}`, GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
      GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  return { output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8'), calls: readFileSync(calls, 'utf8') };
}

test('same-SHA successful merge-group CI is recorded with a bounded least-privilege lookup', t => {
  const result = lookup(t);
  assert.equal(result.output, 'duplicate-of=123\n');
  assert.match(result.summary, /https:\/\/github.com\/inspr-at\/aithema\/actions\/runs\/123/u);
  const [args] = result.calls.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(args, ['api', `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&status=success&per_page=100`]);
  assert.deepEqual(ci.permissions, { contents: 'read' });
  assert.deepEqual(ci.jobs.changes.permissions, { contents: 'read', actions: 'read' });
  assert.equal(ci.jobs.changes.outputs['duplicate-of'], '${{ steps.duplicate.outputs.duplicate-of }}');
  const step = ci.jobs.changes.steps.find(step => step.id === 'duplicate');
  assert.deepEqual(step.env, { GH_TOKEN: '${{ github.token }}' });
  assert.match(step.run, /timeout=15/u);
  assert.doesNotMatch(step.run, /sleep|while\s|--paginate|secrets\./u);
  for (const [id, job] of Object.entries(ci.jobs)) {
    if (!['changes', 'test'].includes(id)) assert.equal(job.permissions, undefined);
  }
});

test('missing, failed, unrelated, malformed and untrusted runs fall back to full CI', t => {
  for (const changes of [
    { event: 'push' }, { event: 'pull_request' }, { head_sha: 'b'.repeat(40) },
    { status: 'in_progress' }, { conclusion: 'failure' }, { name: 'other' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'fork/aithema' } },
    { head_repository: { full_name: 'fork/aithema' } }, { id: 'invalid' },
  ]) assert.equal(lookup(t, { workflow_runs: [{ ...run(), ...changes }] }).output, 'duplicate-of=\n');
  for (const response of [{ workflow_runs: [] }, {}, { workflow_runs: null }, 'not json']) {
    assert.equal(lookup(t, response).output, 'duplicate-of=\n');
  }
  for (const options of [{ failure: true }, { timeout: true }]) assert.equal(lookup(t, undefined, options).output, 'duplicate-of=\n');
});

test('PRs, merge groups, non-main pushes and reruns never query or skip', t => {
  for (const options of [{ event: 'pull_request' }, { event: 'merge_group' }, { ref: 'refs/heads/feature' }, { attempt: '2' }]) {
    const result = lookup(t, undefined, options);
    assert.equal(result.output, 'duplicate-of=\n');
    assert.equal(result.calls, '');
  }
});

test('duplicate pushes skip every worker and pack/boot; all other contexts run full CI', () => {
  const contexts = [context()];
  for (const event of ['push', 'pull_request', 'merge_group']) {
    for (const result of ['success', 'failure', 'skipped', '']) {
      for (const duplicate of ['', '123']) for (const attempt of [1, 2]) {
        contexts.push(context(event, duplicate, result, attempt));
      }
    }
  }
  contexts.push({ ...context(), github: { ...context().github, ref: 'refs/heads/feature' } });
  for (const ctx of contexts) {
    const duplicate = ctx.github.event_name === 'push' && ctx.github.ref === 'refs/heads/main' && ctx.github.run_attempt === 1 &&
      ctx.needs.changes.result === 'success' && ctx.needs.changes.outputs['duplicate-of'] !== '';
    for (const id of ['unit', 'browser', 'preview-security']) assert.equal(evaluate(ci.jobs[id].if, ctx), !duplicate, id);
    for (const step of ci.jobs.test.steps) {
      if (step.name === 'Docs-only success' || step.name === 'Require every unit shard') continue;
      assert.equal(evaluate(step.if, ctx), !duplicate, step.name ?? step.run ?? step.uses);
    }
  }
});

test('required aggregates allow only verified duplicate skips and never mask a failure', () => {
  for (const [id, dependency] of [['test', 'unit'], ['browser-required', 'browser']]) {
    const gate = ci.jobs[id].steps.find(step => step.name === `Require every ${dependency} shard`);
    assert.ok(gate);
    for (const ctx of [context(), context('push', ''), context('pull_request'), context('merge_group'), context('push', '123', 'failure'), context('push', '123', 'success', 2)]) {
      const duplicate = ctx.github.event_name === 'push' && ctx.github.run_attempt === 1 && ctx.needs.changes.result === 'success' && ctx.needs.changes.outputs['duplicate-of'] !== '';
      for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const env = Object.fromEntries(Object.entries(gate.env ?? {}).map(([key, value]) => [key, String(evaluate(value, ctx))]));
        const command = gate.run.replaceAll(`\${{ needs.${dependency}.result }}`, result);
        const executed = spawnSync('bash', ['-c', command], { env: { ...process.env, ...env } });
        assert.equal(executed.status === 0, result === 'success' || (duplicate && result === 'skipped'), `${id}: ${result} / ${JSON.stringify(ctx)}`);
      }
    }
  }
});

test('all resource caps, shard counts and required names retain the main baseline', () => {
  assert.deepEqual(Object.keys(ci.on), ['pull_request', 'merge_group', 'push']);
  assert.deepEqual(Object.fromEntries(Object.entries(ci.jobs).map(([id, job]) => [id, [job.name ?? id, job['timeout-minutes'], job.strategy?.matrix.shard]])), {
    changes: ['changes', 5, undefined], test: ['test', 10, undefined],
    browser: ['browser (${{ matrix.shard }}/8)', 10, [1, 2, 3, 4, 5, 6, 7, 8]],
    'browser-required': ['browser (${{ matrix.shard }}/4)', 1, [1, 2, 3, 4]],
    unit: ['unit (${{ matrix.shard }}/3)', 10, [1, 2, 3]], 'preview-security': ['preview-security', 6, undefined],
  });
  assert.equal(ci.jobs.test.steps.find(step => step.name === 'Boot standalone host from candidate tarballs')['timeout-minutes'], 2);
});
