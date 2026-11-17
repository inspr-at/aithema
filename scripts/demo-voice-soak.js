// Explicit remote soak: node --test scripts/demo-voice-soak.js.
// Every invocation runs the unchanged per-test budget in a fresh process/window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

for (let run = 1; run <= 20; run++) {
  test(`demo voice ordering: consecutive run ${run}/20`, async t => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--import', './test/fixtures/slow-voice-render.js', 'demo/test/voice.test.js'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(code, 0, `run ${run}/20 must pass:\n${output}`);
    assert.match(output, /^# tests 1$/mu, 'each child must execute the demo voice test');
    assert.match(output, /^# pass 1$/mu, 'each child must pass the demo voice test');
    t.diagnostic(output.split('\n').filter(line => /# (duration_ms|AIT-495)/u.test(line)).join('; '));
  });
}
