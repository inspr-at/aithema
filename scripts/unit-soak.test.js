// Run only on the remote test host, via remote-browser.sh … unit <this file>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

for (const [label, count, args] of [
  ['host surface', 5, ['--test', '--test-timeout=60000', 'packages/ui/test/host-surface.test.js']],
  ['full unit suite', 2, ['test']],
]) test(`AIT-193: ${label} ${count} times`, { timeout: 840_000 }, async () => {
  for (let i = 1; i <= count; i++) {
    const start = performance.now();
    let output = '';
    // A nested node --test must not inherit the outer runner's worker IPC mode.
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(label === 'host surface' ? process.execPath : 'npm', args, { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const watchdog = setTimeout(() => {
      console.error(`[AIT-193] ${label} run=${i} exceeded 180000ms; terminating this run's process group`);
      process.kill(-child.pid, 'SIGKILL');
    }, 180_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    clearTimeout(watchdog);
    console.log(`[AIT-193] ${label} run=${i}/${count} duration_ms=${Math.round(performance.now() - start)} exit=${status.code} signal=${status.signal}`);
    console.log(output.split('\n').filter(line => /AIT-193|unit-handles|at .*\/src\/|at .*host-surface.test|Timeout|MESSAGEPORT|TCPWRAP/.test(line)).join('\n'));
    if (status.code !== 0) console.log(output.slice(-30000));
    assert.equal(status.code, 0);
    assert.match(output, /(?:tests [1-9]|# tests [1-9])/u, 'the child must actually execute tests');
  }
});
