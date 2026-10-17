// Remote-only wall-time measurement, deliberately outside npm test's glob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function measure(label, args, trace) {
  const started = performance.now(), env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (trace) env.AITHEMA_UNIT_TRACE_HANDLES = '1'; else delete env.AITHEMA_UNIT_TRACE_HANDLES;
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const ms = Math.round(performance.now() - started);
  console.log(`${label}: exit=${code}, wall_ms=${ms}`);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `${label}.log`), output);
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `${label}.json`), JSON.stringify({ label, code, wall_ms: ms }));
  }
  assert.equal(code, 0, output.slice(-12000));
}
for (const mode of ['baseline', 'default', 'trace']) test(`AIT-299 watchdog cost ${mode}`, { timeout: 240_000 }, async () => {
  const files = (await readdir('packages/ui/test')).filter(name => /^host-.*\.test\.js$/.test(name)).map(name => `packages/ui/test/${name}`);
  const args = ['--test', '--test-timeout=180000', '--import', './scripts/unit-watchdog.js', '--test-skip-pattern=AIT-299'];
  await measure(`${mode}-host`, [...args, ...files], mode === 'trace');
  // Identical scope before and after; omit the new red-before regressions only.
  const command = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).scripts.test;
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  childEnv.AITHEMA_UNIT_TRACE_HANDLES = mode === 'trace' ? '1' : '';
  const child = spawn('/bin/sh', ['-c', `${command} --test-skip-pattern=AIT-299`], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = performance.now(); let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const ms = Math.round(performance.now() - started);
  console.log(`${mode}-full: exit=${code}, wall_ms=${ms}`);
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `${mode}-full.json`), JSON.stringify({ label: `${mode}-full`, code, wall_ms: ms }));
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `${mode}-full.log`), output);
  assert.equal(code, 0, output.slice(-12000));
});
