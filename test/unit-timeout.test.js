import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [name, body] of [
  ['leaked-interval', "test('assertions complete', () => { setInterval(() => {}, 1000); });"],
  ['stuck-after', "test('assertions complete', () => {}); test.after(() => new Promise(() => {})); setInterval(() => {}, 1000);"],
]) test(`AIT-193: the unit runner bounds and names a ${name} file`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-timeout-'));
  try {
    const fixture = join(directory, `${name}.test.cjs`);
    writeFileSync(fixture, `const test = require('node:test');\n${body}\n`);
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=200', fixture], {
      env: childEnv, encoding: 'utf8', timeout: 5000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, 'the runner must exit before the outer watchdog');
    assert.equal(result.status, 1, output);
    assert.match(output, new RegExp(`${name}\\.test\\.cjs`, 'u'));
    assert.match(output, /timed out|testTimeoutFailure/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
