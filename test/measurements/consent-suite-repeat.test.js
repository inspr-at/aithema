// Explicit AIT-455 qualification outside normal browser shards. Run through
// remote-browser.sh: 20 fresh suite processes, serial, with no retries.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('AIT-455: 20 consecutive AIT-364/365 consent suite runs', { timeout: 840_000 }, async t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (let repeat = 1; repeat <= 20; repeat++) {
    const started = performance.now();
    const { code, signal, output } = await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec',
        '--test-timeout=90000', '--test-name-pattern=^AIT-364:', 'test/browser/html-preview.test.js'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
    assert.equal(signal, null, `repeat ${repeat}/20 terminated: ${output}`);
    assert.equal(code, 0, `repeat ${repeat}/20 failed: ${output}`);
    assert.match(output, /tests 20\b/u, 'the parent and all 19 consent subtests actually ran');
    assert.match(output, /pass 20\b/u);
    assert.match(output, /fail 0\b/u);
    assert.match(output, /cancelled 0\b/u);
    assert.match(output, /skipped 0\b/u);
    t.diagnostic(`PASS AIT-455 repeat ${repeat}/20 (${Math.round(performance.now() - started)} ms)`);
  }
});
