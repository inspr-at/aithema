import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('AIT-511: parallel browser aggregate covers all fifteen workers while retaining required aliases', () => {
  assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const aggregate = ci.jobs['browser-aggregate'];
  assert.ok(aggregate, 'Add a parallel aggregate before switching required checks');
  assert.equal(aggregate.name, 'browser');
  assert.deepEqual(aggregate.needs, ['changes', 'browser']);
  assert.equal(aggregate.if, '${{ !cancelled() }}');
  assert.equal(aggregate['timeout-minutes'], 1);
  assert.equal(aggregate['continue-on-error'], undefined);
  assert.equal(aggregate.strategy, undefined);
  const aliases = ci.jobs['browser-required'];
  assert.equal(aliases.name, 'browser (${{ matrix.shard }}/4)');
  assert.deepEqual(aliases.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.deepEqual(aliases.needs, aggregate.needs);
  assert.deepEqual(aliases.steps, aggregate.steps, 'Required aliases retain the same result semantics');
});

test('AIT-532: browser summaries accept skipped workers only for verified first-attempt duplicate main pushes', () => {
  const scenarios = [
    ['pull_request', 'refs/pull/1/merge', 1],
    ['pull_request', 'refs/heads/main', 1],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 1],
    ['merge_group', 'refs/heads/main', 1],
    ['push', 'refs/heads/main', 1],
    ['push', 'refs/heads/main', 2],
    ['push', 'refs/heads/feature', 1],
  ];
  for (const id of ['browser-aggregate', 'browser-required']) {
    const aggregate = ci.jobs[id];
    assert.ok(aggregate, `${id} exists`);
    assert.equal(aggregate.if, '${{ !cancelled() }}');
    for (const cancelled of [true, false]) {
      assert.equal(runInNewContext(aggregate.if.slice(3, -2), { cancelled: () => cancelled }), !cancelled);
    }
    assert.equal(aggregate.steps.length, 1);
    const gate = aggregate.steps[0];
    assert.equal(gate.if, undefined, 'The result gate also runs for docs-only PRs');
    assert.equal(gate['continue-on-error'], undefined);
    for (const [event, ref, attempt] of scenarios) {
      for (const docsOnly of ['true', 'false', '']) {
        for (const changesResult of ['success', 'failure', 'cancelled', 'skipped', '']) {
          for (const duplicate of ['', '123']) {
            const context = {
              github: { event_name: event, ref, run_attempt: attempt },
              needs: { changes: { result: changesResult, outputs: { 'docs-only': docsOnly, 'duplicate-of': duplicate } } },
            };
            const env = Object.fromEntries(Object.entries(gate.env ?? {}).map(([key, value]) => [key,
              String(runInNewContext(value.slice(3, -2).replaceAll('outputs.duplicate-of', "outputs['duplicate-of']"), context))]));
            const verifiedDuplicate = event === 'push' && ref === 'refs/heads/main' && attempt === 1 &&
              changesResult === 'success' && duplicate !== '';
            for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
              const command = gate.run.replaceAll('${{ needs.browser.result }}', result);
              const executed = spawnSync('bash', ['-c', command], { env });
              assert.equal(executed.status === 0, result === 'success' || (verifiedDuplicate && result === 'skipped'),
                `${id}: ${event}, ref=${ref}, attempt=${attempt}, changes=${changesResult}, docs=${docsOnly}, duplicate=${duplicate}, result=${result}`);
            }
          }
        }
      }
    }
  }
});

// Keep the skip exception independently pinned even if the job-condition check
// above fails first: a verified duplicate has already passed merge-group CI.
test('AIT-532: both browser gates preserve the narrow DUPLICATE_PUSH exception', () => {
  for (const id of ['browser-required', 'browser-aggregate']) {
    const gate = ci.jobs[id].steps[0];
    assert.ok(gate.env?.DUPLICATE_PUSH, `${id} must verify duplicate provenance`);
    assert.equal(gate.env.DUPLICATE_PUSH, ci.jobs.test.steps.find(step => step.name === 'Require every unit shard').env.DUPLICATE_PUSH);
    for (const duplicate of ['true', 'false']) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const command = gate.run.replaceAll('${{ needs.browser.result }}', result);
        assert.equal(spawnSync('bash', ['-c', command], { env: { DUPLICATE_PUSH: duplicate } }).status === 0,
          result === 'success' || (duplicate === 'true' && result === 'skipped'), `${id}: ${duplicate}/${result}`);
      }
    }
  }
});


test('AIT-532: no worker can be omitted or allowed to fail inside the matrix', () => {
  const worker = ci.jobs.browser;
  assert.equal(worker.if, '${{ !cancelled() }}');
  assert.equal(worker.strategy['fail-fast'], false);
  assert.equal(worker['continue-on-error'], undefined);
  assert.equal(worker.strategy['max-parallel'], undefined);
  assert.equal(worker.strategy.matrix.exclude, undefined);
  assert.equal(worker.strategy.matrix.include, undefined);
  assert.equal(worker.steps.some(step => step['continue-on-error']), false);
  assert.equal(worker.steps[0].name, 'Docs-only success');
  assert.ok(worker.steps.some(step => step.name === 'Duplicate-main success'));
});
