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
      ['light', 'dark'].map(theme => matrixWidths([390, 1024, 1440], theme, group, 'email-ask'))) }));
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

// Browser suites pass observed result-array lengths, never planned loop sizes.
// A dropped state/width must fail in either execution mode.
test('executed case guard rejects a dropped state or width in CI and full evidence', async () => {
  const { assertMatrixCaseCount, matrixCaseTotals } = await import('./browser/matrix-coverage.js');
  assert.equal(typeof assertMatrixCaseCount, 'function');
  for (const [group, totals] of Object.entries(matrixCaseTotals)) {
    for (const mode of ['ci', 'full']) {
      assert.doesNotThrow(() => assertMatrixCaseCount(group, totals[mode], mode));
      assert.throws(() => assertMatrixCaseCount(group, totals[mode] - 1, mode), /case coverage/);
      assert.throws(() => assertMatrixCaseCount(group, totals[mode] + 1, mode), /case coverage/);
    }
  }
  assert.equal(matrixCaseTotals['email-ask'].full, 296);
  assert.equal(matrixCaseTotals['visitor-credit'].full, 444);
  assert.throws(() => assertMatrixCaseCount('unregistered', 0), /Unknown matrix group/);
});

test('Tick width-specific DOM pass lines retain every original width in PR CI', () => {
  for (const [file, widths] of [
    ['tick-followups.test.js', '[390, 393, 400, 412, 430, 440, 447, 448, 460, 479, 480, 500, 550, 1024, 1440]'],
    ['pause-phone.test.js', '[390, 393]'],
  ]) {
    const source = readFileSync(new URL(`./browser/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(`for (const width of ${widths})`), `${file}: original DOM width sweep`);
    assert.ok(!source.includes('matrixWidths('), `${file}: width-specific and 0 px shift assertions must not rotate`);
  }
});

test('every rotated group has a live executed-count assertion', async () => {
  const { matrixCaseTotals } = await import('./browser/matrix-coverage.js');
  const files = ['start2-display.test.js', 'start2-display-matrix-helpers.js',
    'start2-display-continuity.test.js', 'confirmation-design.test.js',
    'email-mail-space.test.js', 'email-ask.test.js', 'visitor-credit-tiers-helpers.js'];
  const source = files.map(file => readFileSync(new URL(`./browser/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.equal(Object.keys(matrixCaseTotals).length, 17);
  for (const group of Object.keys(matrixCaseTotals)) {
    assert.ok(source.includes(`assertMatrixCaseCount('${group}',`), `${group}: executable guard required`);
  }
});

test('deleting an original call-site width fails before rotation in CI and nightly', () => {
  const base = { ...process.env }; delete base.CI; delete base.AITHEMA_EVIDENCE_DIR;
  for (const env of [{ ...base, CI: 'true' }, { ...base, AITHEMA_EVIDENCE_DIR: '/tmp/evidence' }]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { matrixWidths, matrixGroupWidths } from ${JSON.stringify(moduleUrl)};
      for (const [group, widths] of Object.entries(matrixGroupWidths)) {
        assert.doesNotThrow(() => matrixWidths(widths, 'light', 0, group));
        for (let i = 0; i < widths.length; i++) {
          assert.throws(() => matrixWidths(widths.filter((_, index) => index !== i), 'light', 0, group), /width coverage/);
        }
      }
    `], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
