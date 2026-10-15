import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('an explicit CHROME_PATH is authoritative, including a refusing stub or missing path', () => {
  for (const [path, status] of [['/usr/bin/false', 0], ['/no-such-aithema-browser', 1]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { browserPath } from "./scripts/install-test-browser.js"; console.log(await browserPath());'], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, CHROME_PATH: path }, encoding: 'utf8',
    });
    assert.equal(child.status, status, child.stderr);
    if (status === 0) assert.equal(child.stdout.trim(), path);
    else assert.match(child.stderr, /ENOENT/u);
  }
});
