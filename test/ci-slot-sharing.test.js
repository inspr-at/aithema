import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { admittedPath } from '../release/pack.mjs';

const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const detector = ci.jobs.changes.steps.find(step => step.id === 'changes');
const lightCondition = "github.event_name == 'pull_request' && needs.changes.result == 'success' && needs.changes.outputs.docs-only == 'true'";
const heavyCondition = "(github.event_name != 'pull_request' || needs.changes.result != 'success' || needs.changes.outputs.docs-only != 'true')";
const expression = (value, github) => runInNewContext(value.slice(3, -2), { github });

test('dedupe cancels only PRs, with unique queue refs and all six browser shards in parallel', () => {
  assert.equal(ci.concurrency.group, 'ci-${{ github.event.pull_request.number || github.ref }}');
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  // AIT-207: all six shards run at once for every event (AEON-1407 baseline: Enterprise runners, Aithema ~2 % of CI hours).
  assert.equal(ci.jobs.browser.strategy['max-parallel'], undefined);
  assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
  const groups = [];
  for (const [event, ref, number] of [
    ['pull_request', 'refs/pull/204/merge', 204],
    ['pull_request', 'refs/pull/204/merge', 204],
    ['pull_request', 'refs/pull/205/merge', 205],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-204-aaa'],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-205-bbb'],
    ['push', 'refs/heads/main'],
  ]) {
    const github = { event_name: event, ref, event: { pull_request: number ? { number } : undefined } };
    // Missing pull_request properties evaluate to null in Actions expressions.
    github.event.pull_request ??= { number: null };
    groups.push(`ci-${expression('${{ github.event.pull_request.number || github.ref }}', github)}`);
    assert.equal(expression(ci.concurrency['cancel-in-progress'], github), event === 'pull_request');
  }
  assert.equal(groups[0], groups[1]);
  assert.equal(new Set(groups.slice(1)).size, 5);
});

test('required jobs always exist; docs-only success gates every heavy step', () => {
  assert.deepEqual(Object.keys(ci.on), ['pull_request', 'merge_group', 'push']);
  assert.equal(ci.on.pull_request, null); // No workflow-level paths filter.
  assert.deepEqual(ci.on.merge_group, { types: ['checks_requested'] });
  assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
  assert.equal(ci.jobs.browser.name, 'browser (${{ matrix.shard }}/6)');
  assert.equal(ci.jobs.changes.if, undefined);
  assert.equal(ci.jobs.changes.outputs['docs-only'], '${{ steps.changes.outputs.docs-only }}');
  assert.deepEqual(detector.env, {
    PR_BASE: '${{ github.event.pull_request.base.sha }}',
    PR_HEAD: '${{ github.event.pull_request.head.sha }}',
  });
  const checkout = ci.jobs.changes.steps.find(step => step.uses);
  assert.equal(checkout.if, "github.event_name == 'pull_request'");
  assert.equal(checkout.with['fetch-depth'], 0);
  for (const id of ['test', 'browser']) {
    const job = ci.jobs[id];
    assert.equal(job.if, '${{ !cancelled() }}');
    assert.equal(job.needs, 'changes');
    const [noop, ...heavy] = job.steps;
    assert.equal(noop.if, lightCondition);
    assert.match(noop.run, /^echo /u);
    assert.ok(heavy.length > 0);
    for (const step of heavy) {
      assert.equal(step.if, step.uses?.startsWith('actions/upload-artifact@')
        ? '${{ always() && ' + heavyCondition + ' }}'
        : heavyCondition);
    }
  }
  const dco = parse(readFileSync(new URL('../.github/workflows/dco.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(dco.jobs), ['dco', 'dco-tests']);
  assert.doesNotMatch(JSON.stringify(dco), /docs-only|paths-ignore/u);
});

function detect(event, paths = [], { rename = false, invalidBase = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'aithema-ci-paths-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'ci@example.invalid');
  writeFileSync(join(cwd, 'source.js'), 'code\n');
  git('add', '.');
  git('commit', '--signoff', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const path of paths) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'content\n');
  }
  if (rename) git('mv', 'source.js', 'docs/moved.md');
  git('add', '.');
  git('commit', '--signoff', '--allow-empty', '-qm', 'change');
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-e', '-c', detector.run], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output,
      PR_BASE: invalidBase ? 'missing-ref' : base, PR_HEAD: git('rev-parse', 'HEAD') },
  });
  const detected = { status: result.status, output: readFileSync(output, 'utf8'), stderr: result.stderr };
  rmSync(cwd, { recursive: true });
  return detected;
}

for (const [name, paths, light] of [
  ['packaged root Markdown', ['README.md'], false],
  ['unlisted Markdown and docs assets', ['guide/deep/info.md', 'docs/image.png'], false],
  ['unusual path characters', ['docs/line\nbreak.md', 'docs/with space.md'], false],
  ['allowlisted pure prose', ['docs/ci.md'], true],
  ['test-read packaged guide', ['docs/embedding.md'], false],
  ['mixed source and docs', ['docs/ci.md', 'packages/core/src/core.js'], false],
  ['root test Markdown', ['test/README.md'], false],
  ['Python test Markdown', ['tests/README.md'], false],
  ['nested test Markdown', ['packages/core/test/README.md'], false],
  ['tests inside docs', ['docs/test/example.md'], false],
  ['workflow changes', ['.github/workflows/ci.yml'], false],
  ['empty change', [], false],
]) {
  test(`actual workflow detector: ${name}`, () => {
    const result = detect('pull_request', paths);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `docs-only=${light}\n`);
  });
}

test('renaming code into docs cannot select the light path', () => {
  assert.equal(detect('pull_request', ['docs/other.md'], { rename: true }).output, 'docs-only=false\n');
});

test('failed change detection fails closed', () => {
  const result = detect('pull_request', ['README.md'], { invalidBase: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
});

for (const event of ['merge_group', 'push']) {
  test(`${event} always runs everything, even docs-only with unavailable PR refs`, () => {
    const result = detect(event, ['docs/ci.md'], { invalidBase: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'docs-only=false\n');
  });
}

// This file names paths to test classification; it does not consume their bytes.
test('light allowlist excludes every pack input and consumer-referenced file', () => {
  const paths = JSON.parse(detector.run.match(/light_paths = (\[[^\n]+\])/u)[1]);
  assert.ok(paths.length > 0);
  const root = new URL('../', import.meta.url);
  function sources(directory) {
    return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => {
      const path = directory + entry.name;
      if (/^(?:\.env|env\.)/u.test(entry.name)) return [];
      if (entry.isDirectory()) return sources(path + '/');
      return entry.isFile() && /\.(?:js|mjs|cjs|py|sh|json)$/u.test(path)
        && path !== 'test/ci-slot-sharing.test.js' ? [path] : [];
    });
  }
  const consumers = ['test/', 'release/', 'scripts/'].flatMap(sources);
  for (const path of paths) {
    assert.equal(admittedPath(path), false, `Pack reads ${path}`);
    for (const consumer of consumers) {
      assert.ok(!readFileSync(new URL(consumer, root), 'utf8').includes(path),
        `${consumer} references light-path file ${path}`);
    }
    assert.equal(detect('pull_request', [path]).output, 'docs-only=true\n');
  }
});

test('heavy jobs run on failed or absent detection; queue always runs everything', () => {
  for (const event of ['pull_request', 'merge_group', 'push']) {
    for (const result of ['success', 'failure', 'skipped', undefined]) {
      for (const output of ['true', 'false', '', undefined]) {
        const context = {
          github: { event_name: event },
          needs: { changes: { result, outputs: { 'docs-only': output } } },
          cancelled: () => false,
        };
        const light = event === 'pull_request' && result === 'success' && output === 'true';
        for (const id of ['test', 'browser']) {
          const job = ci.jobs[id];
          assert.equal(runInNewContext(job.if.slice(3, -2), context), true);
          for (const step of job.steps) {
            const condition = step.if.startsWith('${{') ? step.if.slice(3, -2) : step.if;
            const runs = runInNewContext(condition.replaceAll("outputs.docs-only", "outputs['docs-only']"), {
              ...context, always: () => true,
            });
            assert.equal(runs, step.name === 'Docs-only success' ? light : !light);
          }
          assert.equal(runInNewContext(job.if.slice(3, -2), { cancelled: () => true }), false);
        }
      }
    }
  }
});
