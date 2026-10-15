// Remote example: node --test --test-name-pattern='^host:' scripts/unit-soak.js.
// Select ^diagnostic: for the original-budget investigation or ^unit: for 15 suites.
// Kept outside the default unit glob: this explicitly requested soak launches child suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function watchdogCost(armUnitWatchdog) {
  const ticks = 20_000, samples = [];
  const measure = async () => {
    const started = performance.now();
    for (let i = 0; i < ticks; i++) await new Promise(resolve => setImmediate(resolve));
    return performance.now() - started;
  };
  for (let i = 0; i < 5; i++) {
    const baseline = await measure(), timer = armUnitWatchdog();
    assert.equal(timer.hasRef(), false);
    try {
      const armed = await measure();
      samples.push({ baseline_ms: baseline, armed_ms: armed, delta_ns_per_tick: (armed - baseline) * 1e6 / ticks });
    } finally { clearTimeout(timer); }
  }
  console.log(`watchdog 5 pairs of ${ticks} event-loop ticks: ${JSON.stringify(samples)}`);
}

async function run(label, command, args, env = {}, requireTests = true) {
  const started = performance.now();
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  console.log(`${label}: exit=${code}, duration_ms=${(performance.now() - started).toFixed(1)}`);
  console.log(output.split('\n').filter(line => /(?:#|ℹ) (tests|pass|fail|duration_ms)|reflected in understanding:|^watchdog/.test(line)).join('; '));
  if (code !== 0) console.log(output);
  if (requireTests) assert.ok(/(?:#|ℹ) tests [1-9][0-9]*/.test(output), `${label} must actually execute tests`);
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
  try { code = await run('unit with stress', 'npm', ['test'], { AITHEMA_WAIT_TIMING: '1' }); }
  finally { stress.kill(); }
  await hosts();
  assert.equal(code, 0, 'unit suite under stress must pass');
});

test('host: 50 consecutive runs', { timeout: 850_000 }, async () => {
  // Import in a non-test child: the watchdog auto-arms in test workers, and the
  // soak controller deliberately outlives the per-file three-minute budget.
  assert.equal(await run('watchdog benchmark', process.execPath, ['--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import { armUnitWatchdog } from './scripts/unit-watchdog.js'; await (${watchdogCost.toString()})(armUnitWatchdog);`], {}, false), 0);
  await hosts();
});

test('unit: 15 consecutive full suites', { timeout: 850_000 }, async () => {
  for (let i = 1; i <= 15; i++) assert.equal(await run(`unit ${i}/15`, 'npm', ['test'], { AITHEMA_WAIT_TIMING: '1' }), 0);
});
