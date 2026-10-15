// Run only on the remote test host, via remote-browser.sh … unit <this file>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

for (const [label, count, args] of [
  ['host surface', 5, ['--test', '--test-timeout=180000', '--import', './scripts/unit-watchdog.js', 'packages/ui/test/host-surface.test.js']],
  ['full unit suite', 5, ['test']],
]) test(`AIT-193: ${label} ${count} times`, { timeout: 840_000 }, async t => {
  const results = [];
  let runningChild;
  t.after(() => {
    if (runningChild?.pid && runningChild.exitCode === null && runningChild.signalCode === null) process.kill(-runningChild.pid, 'SIGKILL');
  });
  for (let i = 1; i <= count; i++) {
    const start = performance.now();
    let output = '';
    // A nested node --test must not inherit the outer runner's worker IPC mode.
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CHROME_PATH', 'CI', 'AITHEMA_EVIDENCE_DIR', 'npm_config_cache', 'NPM_CONFIG_CACHE']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    childEnv.AITHEMA_UNIT_HANDLES = '1';
    const child = spawn(label === 'host surface' ? process.execPath : 'npm', args, { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runningChild = child;
    const watchdog = setTimeout(() => {
      console.error(`[AIT-193] ${label} run=${i} exceeded 240000ms; terminating this run's process group`);
      process.kill(-child.pid, 'SIGKILL');
    }, 240_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let status;
    try {
      status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    } finally { clearTimeout(watchdog); }
    const durationMs = Math.round(performance.now() - start);
    const testCount = Number(/(?:ℹ|#) tests (\d+)/u.exec(output)?.[1] ?? 0);
    results.push({ run: i, durationMs, testCount, ...status });
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, `${label.replaceAll(' ', '-')}.json`), JSON.stringify({ node: process.version, results }, null, 2));
      writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, `${label.replaceAll(' ', '-')}-${i}.log`), output);
    }
    console.log(`[AIT-193] ${label} run=${i}/${count} duration_ms=${durationMs} tests=${testCount} exit=${status.code} signal=${status.signal}`);
    console.log(output.split('\n').filter(line => /AIT-193|unit-handles|at .*\/src\/|at .*host-surface.test|Timeout|MESSAGEPORT|TCPWRAP/.test(line)).join('\n'));
    if (status.code !== 0) console.log(output.slice(-30000));
    assert.equal(status.code, 0);
    assert.ok(testCount > 0, 'the child must actually execute tests');
  }
  const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
  console.log(`[AIT-193] ${label}: ${count}/${count} clean exits; min/median/max=${durations[0]}/${durations[Math.floor(count / 2)]}/${durations.at(-1)}ms`);
});
