// Run through remote-browser.sh only. Each iteration gets a fresh Node process,
// demo server and (for the browser case) Chrome profile, with no concurrent runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = [
  ['unit', 'demo/test/uploads.test.js', '^demo cookie ownership, existing consent, multipart route and durable upload snapshot$'],
  ['browser', 'test/browser/demo.test.js', '^document uploads:'],
];

for (const [name, file, pattern] of cases) {
  test(`AIT-142 soak: ${name} (30 isolated runs)`, { timeout: 840_000 }, async t => {
    let passed = 0;
    t.diagnostic(`Node ${process.version}; ${process.platform}/${process.arch}; sequential ${file}`);
    for (let run = 1; run <= 30; run++) {
      await t.test(`run ${run}/30`, async () => {
        const child = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${pattern}`, file],
          { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ?? code));
        });
        assert.equal(code, 0, output);
        assert.match(output, /ℹ tests 1\b/u, 'the named test must actually run');
        passed++;
      });
    }
    t.diagnostic(`AIT-142 ${name}: ${passed}/30 passed; ${30 - passed}/30 failed (${((30 - passed) / 30 * 100).toFixed(1)}%)`);
  });
}
