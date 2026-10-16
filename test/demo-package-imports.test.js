import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBoundaries } from '../scripts/check-boundaries.mjs';

test('unified host policy rejects deep imports, dynamic paths and stale browser exceptions', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'aithema-host-policy-'));
  mkdirSync(resolve(root, 'demo'));
  mkdirSync(resolve(root, 'packages/core/src'), { recursive: true });
  writeFileSync(resolve(root, 'packages/core/package.json'), JSON.stringify({ name: '@inspr/aithema-core', exports: { '.': './src/index.js' } }));
  writeFileSync(resolve(root, 'packages/core/src/index.js'), '');
  for (const source of ["import '../packages/core/src/index.js';", "export * from '../packages/core/src/index.js';", "import(`../packages/${name}/src/index.js`);"]) {
    writeFileSync(resolve(root, 'demo/server.js'), source);
    assert.equal(checkBoundaries(root).length, 1, source);
  }
  writeFileSync(resolve(root, 'demo/server.js'), "import '@inspr/aithema-core';");
  assert.deepEqual(checkBoundaries(root), []);
  writeFileSync(resolve(root, 'demo/host.js'), "import '@inspr/aithema-core';");
  assert.match(checkBoundaries(root)[0], /stale browser source exception/u);
});
