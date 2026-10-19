// Explicit AIT-398 remote qualification, outside the normal browser shards.
// Run via remote-browser.sh; every repeat is a fresh run, never a retry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('AIT-398: 30 consecutive stale-editor reload runs', { timeout: 840_000 }, async t => {
  const childEnv = { ...process.env };
  // A fresh node --test must not inherit the parent's recursive-run guard.
  delete childEnv.NODE_TEST_CONTEXT;
  for (let repeat = 1; repeat <= 30; repeat++) {
    const started = Date.now();
    const { code, signal, output } = await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec',
        '--test-name-pattern=AIT-321: stale editor reload', 'test/browser/consent-lines.test.js'],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
    assert.equal(signal, null, `repeat ${repeat}/30 terminated: ${output}`);
    assert.equal(code, 0, `repeat ${repeat}/30 failed: ${output}`);
    assert.match(output, /tests 1\b/u, 'the named browser test actually ran');
    t.diagnostic(`PASS AIT-398 repeat ${repeat}/30 (${Date.now() - started} ms)`);
  }
});
