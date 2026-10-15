// Run remotely with node --test --test-name-pattern='diagnostic|host' scripts/unit-soak.js.
// Kept outside the default unit glob: this explicitly requested soak launches child suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function run(label, command, args, env = {}) {
  const started = performance.now();
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  console.log(`${label}: exit=${code}, duration_ms=${(performance.now() - started).toFixed(1)}`);
  console.log(output.split('\n').filter(line => /# (tests|pass|fail|duration_ms)|reflected in understanding:/.test(line)).join('\n'));
  if (code !== 0) console.log(output);
  assert.match(output, /# tests [1-9][0-9]*/, `${label} must actually execute tests`);
  return code;
}

async function hosts() {
  let failures = 0;
  for (let i = 1; i <= 50; i++) {
    failures += (await run(`host ${i}/50`, process.execPath,
      ['--test', '--test-reporter=tap', '--test-timeout=180000', '--import', './scripts/unit-watchdog.js', 'demo/test/host.test.js'],
      { AITHEMA_WAIT_TIMING: '1' })) !== 0;
  }
  assert.equal(failures, 0, 'all 50 host runs must pass');
}

test('diagnostic: unit suite under bounded CPU stress, then host 50 times', { timeout: 850_000 }, async () => {
  // One CPU worker at 20% duty, only during the full suite; no extra suite concurrency.
  const stress = spawn(process.execPath, ['-e', 'setInterval(() => { const end = performance.now() + 10; while (performance.now() < end) {} }, 50)'], { stdio: 'ignore' });
  let code;
  try { code = await run('unit with stress', 'npm', ['test', '--', '--test-reporter=tap']); }
  finally { stress.kill(); }
  await hosts();
  assert.equal(code, 0, 'unit suite under stress must pass');
});

test('host: 50 consecutive runs', { timeout: 850_000 }, hosts);
