// Explicit remote-only investigation/soak; outside npm test's default glob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const files = ['packages/ui/test/concepts.test.js', 'packages/ui/test/host-surface.test.js',
  'packages/ui/test/host-credits.test.js', 'packages/ui/test/host-settlement.test.js', 'packages/ui/test/host-limits.test.js',
  'packages/ui/test/layout.test.js', 'plugins/codex-imagegen/test/codex-imagegen.test.js', 'test/unit-timeout.test.js'];
async function run(label, args) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CHROME_PATH: process.env.CHROME_PATH, AITHEMA_EVIDENCE_DIR: process.env.AITHEMA_EVIDENCE_DIR };
  if (label.startsWith('browser-')) delete env.AITHEMA_EVIDENCE_DIR;
  const started = performance.now();
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `${label}.log`), output);
  console.log(`${label}: exit=${code}, duration_ms=${Math.round(performance.now() - started)}; ${output.split('\n').filter(line => /^# (tests|pass|fail|duration_ms)/.test(line)).join('; ')}`);
  if (code !== 0) console.log(output.slice(-45000));
  assert.ok(/# tests [1-9]/.test(output), 'the child must execute tests');
  return code;
}
function pressure(t) {
  // One bounded CPU worker, no parallel suites and no unbounded core fanout.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => { const end = performance.now() + 25; while (performance.now() < end) {} }, 50)'], { stdio: 'ignore' });
  t.after(() => child.kill());
}
const args = ['--test', '--test-reporter=tap', '--test-concurrency=2', '--test-timeout=180000', '--import', './scripts/unit-watchdog.js'];
test('AIT-298 diagnostic baseline under bounded CPU pressure', { timeout: 230_000 }, async t => {
  pressure(t);
  const profile = process.env.AITHEMA_EVIDENCE_DIR ? ['--cpu-prof', `--cpu-prof-dir=${process.env.AITHEMA_EVIDENCE_DIR}`] : [];
  assert.equal(await run('diagnostic', [...profile, ...args, ...files]), 0);
});
test('AIT-298 unit files 20 times under bounded CPU pressure', { timeout: 840_000 }, async t => {
  pressure(t);
  for (let i = 1; i <= 20; i++) assert.equal(await run(`unit-${i}`, [...args, ...files]), 0, `iteration ${i}`);
});
test('AIT-298 browser file 20 times under bounded CPU pressure', { timeout: 840_000 }, async t => {
  pressure(t);
  for (let i = 1; i <= 20; i++) assert.equal(await run(`browser-${i}`, ['--test', '--test-reporter=tap', '--test-concurrency=2',
    '--test-name-pattern=AIT-276', 'test/browser/start2-display-geometry.test.js']), 0, `iteration ${i}`);
});

test('AIT-299 controlled regressions under bounded CPU pressure', { timeout: 230_000 }, async t => {
  pressure(t);
  assert.equal(await run('ait299-red-before', [...args, '--test-name-pattern=AIT-299',
    'packages/ui/test/host-limits.test.js', 'packages/ui/test/layout.test.js', 'packages/ui/test/concepts.test.js', 'test/unit-timeout.test.js']), 0);
});

test('AIT-299 host-limit and layout 20 times under bounded CPU pressure', { timeout: 230_000 }, async t => {
  pressure(t);
  for (let i = 1; i <= 20; i++) assert.equal(await run(`ait299-limit-${i}`, [...args, 'packages/ui/test/host-limits.test.js', 'packages/ui/test/layout.test.js']), 0, `iteration ${i}`);
});
