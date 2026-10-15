import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const moduleUrl = new URL('./browser/matrix-coverage.js', import.meta.url).href;
function selection(env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { fullMatrix, matrixWidths } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ fullMatrix, groups: [0, 1, 2].map(group =>
      ['light', 'dark'].map(theme => matrixWidths([390, 1024, 1440], theme, group))) }));
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('CI artifacts keep deterministic width rotation; full evidence retains every width', () => {
  const base = { ...process.env }; delete base.CI; delete base.AITHEMA_EVIDENCE_DIR;
  const ci = selection({ ...base, CI: 'true', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' });
  assert.deepEqual(ci, { fullMatrix: false, groups: [
    [[390], [1024]], [[1024], [1440]], [[1440], [390]],
  ] });
  assert.deepEqual(selection(base), ci);
  assert.deepEqual(selection({ ...base, AITHEMA_EVIDENCE_DIR: '/tmp/evidence' }), {
    fullMatrix: true, groups: Array.from({ length: 3 }, () => [[390, 1024, 1440], [390, 1024, 1440]]),
  });
});

test('nightly runs every browser shard with CI unset and an evidence directory', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.browser;
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
  const step = job.steps.find(step => step.name === 'Full browser matrix with evidence');
  assert.equal(step.run, 'env -u CI npm run test:browser -- --shard ${{ matrix.shard }}/4');
  assert.equal(step.env.AITHEMA_EVIDENCE_DIR, '${{ runner.temp }}/evidence');
  assert.ok(job.steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()'));
});
