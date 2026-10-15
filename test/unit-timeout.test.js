import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNIT_FILE_TIMEOUT_MS } from '../scripts/unit-watchdog.js';

const watchdog = fileURLToPath(new URL('../scripts/unit-watchdog.js', import.meta.url));

test('AIT-193: npm test applies the three-minute deadline and watchdog to every worker', () => {
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
  assert.equal(UNIT_FILE_TIMEOUT_MS, 180_000);
  assert.match(command, /--test-timeout=180000\b/u);
  assert.match(command, /--import \.\/scripts\/unit-watchdog\.js\b/u);
});

for (const [name, body] of [
  ['leaked-interval', "test('assertions complete', () => { setInterval(() => {}, 1000); });"],
  ['stuck-after', "test('assertions complete', () => {}); test.after(() => new Promise(() => {})); setInterval(() => {}, 1000);"],
]) test(`AIT-193: the unit runner bounds and names a ${name} file`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'aithema-unit-timeout-'));
  try {
    const fixture = join(directory, `${name}.test.cjs`);
    writeFileSync(fixture, `const test = require('node:test');\nconst { armUnitWatchdog } = require(${JSON.stringify(watchdog)});\narmUnitWatchdog(200);\n${body}\n`);
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=200', '--import', watchdog, fixture], {
      env: childEnv, encoding: 'utf8', timeout: 5000, detached: true,
    });
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, 'the runner must exit before the outer watchdog');
    assert.equal(result.status, 1, output);
    assert.match(output, new RegExp(`${name}\\.test\\.cjs`, 'u'));
    assert.match(output, /timed out|testTimeoutFailure/u);
    assert.match(output, /Active resources:/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
