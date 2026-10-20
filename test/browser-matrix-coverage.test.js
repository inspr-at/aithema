import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const moduleUrl = new URL('./browser/matrix-coverage.js', import.meta.url).href;
function selection(env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { fullMatrix, a11yEvidenceMode, matrixWidths } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ fullMatrix, a11yEvidenceMode, ci: process.env.CI, groups: [0, 1, 2].map(group =>
      ['light', 'dark'].map(theme => matrixWidths([390, 1024, 1440], theme, group, 'email-ask'))) }));
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('CI artifacts keep deterministic width rotation; full evidence retains every width', () => {
  const base = { ...process.env }; delete base.CI; delete base.GITHUB_ACTIONS; delete base.AITHEMA_EVIDENCE_DIR; delete base.AITHEMA_FULL_MATRIX;
  const ci = selection({ ...base, CI: 'true', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' });
  assert.deepEqual(ci, { fullMatrix: false, a11yEvidenceMode: false, ci: 'true', groups: [
    [[390], [1024]], [[1024], [1440]], [[1440], [390]],
  ] });
  const { ci: ignoredCI, ...localRotation } = ci;
  assert.deepEqual(selection(base), localRotation);
  assert.deepEqual(selection({ ...base, AITHEMA_EVIDENCE_DIR: '/tmp/evidence' }), {
    fullMatrix: true, a11yEvidenceMode: true, groups: Array.from({ length: 3 }, () => [[390, 1024, 1440], [390, 1024, 1440]]),
  });
  const nightly = selection({ ...base, GITHUB_ACTIONS: 'true', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' });
  assert.equal(nightly.fullMatrix, true, 'nightly retains its full browser matrix');
  assert.equal(nightly.a11yEvidenceMode, false, 'nightly never admits the manual axe audit');
  assert.deepEqual(selection({ ...base, CI: 'true', GITHUB_ACTIONS: 'true', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' }), ci);
  const explicit = selection({ ...base, CI: 'true', GITHUB_ACTIONS: 'true', AITHEMA_FULL_MATRIX: '1', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' });
  assert.equal(explicit.fullMatrix, true);
  assert.equal(explicit.ci, 'true', 'full matrix retains CI timing budgets');
  assert.equal(explicit.a11yEvidenceMode, false);
  assert.deepEqual(explicit.groups, Array.from({ length: 3 }, () => [[390, 1024, 1440], [390, 1024, 1440]]));
  assert.deepEqual(selection({ ...base, CI: 'true', AITHEMA_FULL_MATRIX: '0', AITHEMA_EVIDENCE_DIR: '/tmp/evidence' }), ci);
});

test('nightly runs every browser shard with its own full-matrix switch and CI timing policy', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.browser;
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(job.name, 'full browser (${{ matrix.shard }}/7)');
  assert.ok(job.steps.some(step => step.with?.name === 'full-browser-evidence-${{ matrix.shard }}-of-7'));
  const step = job.steps.find(step => step.name === 'Full browser matrix with evidence');
  assert.equal(step.run, 'npm run test:browser -- --shard ${{ matrix.shard }}/7');
  assert.equal(step.env.AITHEMA_FULL_MATRIX, '1');
  assert.equal(step.env.CI, undefined, 'GitHub Actions keeps its default CI=true');
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
