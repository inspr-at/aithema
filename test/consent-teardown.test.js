import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

async function probe(mode) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    let output = '', killed = false;
    const child = spawn(process.execPath, ['--test-reporter=spec',
      'test/fixtures/consent-teardown-probe.mjs', mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 2000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, output }); });
  });
}

test('AIT-455: consent teardown closes an accepted connection without HTTP headers', async () => {
  const result = await probe('preconnect');
  assert.match(result.output, /forced teardown probe reached/u);
  assert.equal(result.killed, false, `teardown hit the outer watchdog: ${result.output}`);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
});

test('AIT-455: a forced browser teardown hang fails fast with the suite and step', async () => {
  const result = await probe('browser-hang');
  assert.match(result.output, /forced teardown probe reached/u);
  assert.equal(result.killed, false, `teardown hit the outer watchdog: ${result.output}`);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /AIT-364: cross-tab single-item consent withdrawal removes HTML and images/u);
  assert.match(result.output, /AIT-364 consent teardown: browser pages and storage: exceeded 25 ms/u);
});
