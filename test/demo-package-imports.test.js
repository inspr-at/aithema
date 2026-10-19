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

test('AIT-350: Grok browser source URLs reject internal paths and accept declared public exports', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'aithema-grok-public-exports-'));
  mkdirSync(resolve(root, 'plugins/grok-voice/src'), { recursive: true });
  mkdirSync(resolve(root, 'packages/core/src/internal'), { recursive: true });
  writeFileSync(resolve(root, 'plugins/grok-voice/package.json'), JSON.stringify({
    name: '@inspr/aithema-plugin-grok-voice', exports: { './client': './src/client.js' },
  }));
  writeFileSync(resolve(root, 'packages/core/package.json'), JSON.stringify({
    name: '@inspr/aithema-core', exports: { '.': './src/index.js' },
  }));
  writeFileSync(resolve(root, 'packages/core/src/index.js'), 'export const value = 1;');
  writeFileSync(resolve(root, 'packages/core/src/internal/x.js'), 'export const value = 1;');
  const browserFile = resolve(root, 'plugins/grok-voice/src/client.js');
  writeFileSync(browserFile, "import { value } from '../../../packages/core/src/internal/x.js';");
  assert.deepEqual(checkBoundaries(root), [
    'plugins/grok-voice/src/client.js:1: Unexported target in packages/core: ../../../packages/core/src/internal/x.js',
  ]);
  // The same assertion used for the real browser graph must reject the private URL.
  assert.throws(() => {
    assert.deepEqual(checkBoundaries(root), [], 'Grok browser source URLs must resolve declared public exports');
  }, { code: 'ERR_ASSERTION' });
  writeFileSync(browserFile, "import { value } from '../../../packages/core/src/index.js';");
  assert.deepEqual(checkBoundaries(root), [], 'Grok browser source URLs must resolve declared public exports');
});
