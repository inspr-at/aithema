import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('AIT-532: parallel browser aggregate covers all twelve workers while retaining required aliases', () => {
  assert.deepEqual(ci.jobs.browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const aggregate = ci.jobs['browser-aggregate'];
  assert.ok(aggregate, 'Add a parallel aggregate before switching required checks');
  assert.equal(aggregate.name, 'browser');
  assert.deepEqual(aggregate.needs, ['changes', 'browser']);
  assert.equal(aggregate.if, '${{ always() }}');
  assert.equal(aggregate['timeout-minutes'], 1);
  assert.equal(aggregate['continue-on-error'], undefined);
  assert.equal(aggregate.strategy, undefined);
  const aliases = ci.jobs['browser-required'];
  assert.equal(aliases.name, 'browser (${{ matrix.shard }}/4)');
  assert.deepEqual(aliases.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.deepEqual(aliases.needs, aggregate.needs);
  assert.deepEqual(aliases.steps, aggregate.steps, 'Required aliases retain the same result semantics');
});

test('AIT-532: browser aggregate and every required alias reject failed, cancelled, skipped or missing workers', () => {
  for (const id of ['browser-aggregate', 'browser-required']) {
    const aggregate = ci.jobs[id];
    assert.ok(aggregate, `${id} exists`);
    assert.equal(aggregate.if, '${{ always() }}');
    assert.equal(aggregate.steps.length, 1);
    const gate = aggregate.steps[0];
    assert.equal(gate.if, undefined, 'The result gate also runs for docs-only PRs');
    assert.equal(gate['continue-on-error'], undefined);
    for (const event of ['pull_request', 'merge_group', 'push']) {
      for (const docsOnly of ['true', 'false', '']) {
        for (const changesResult of ['success', 'failure', 'skipped']) {
          for (const duplicate of ['', '123']) {
            const context = {
              github: { event_name: event, ref: 'refs/heads/main', run_attempt: 1 },
              needs: { changes: { result: changesResult, outputs: { 'docs-only': docsOnly, 'duplicate-of': duplicate } } },
            };
            const env = Object.fromEntries(Object.entries(gate.env ?? {}).map(([key, value]) => [key,
              String(runInNewContext(value.slice(3, -2).replaceAll('outputs.duplicate-of', "outputs['duplicate-of']"), context))]));
            for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
              const command = gate.run.replaceAll('${{ needs.browser.result }}', result);
              const executed = spawnSync('bash', ['-c', command], { env });
              assert.equal(executed.status === 0, result === 'success',
                `${event}: changes=${changesResult}, docs=${docsOnly}, duplicate=${duplicate}, result=${result}`);
            }
          }
        }
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
