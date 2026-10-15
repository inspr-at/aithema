import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, importSpecifiers, parseSource, renderLayerTable } from '../scripts/check-boundaries.mjs';
import { checkCiEnv, ciEnvReads, renderCiEnvTable } from '../scripts/check-ci-env.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const declarations = JSON.parse(readFileSync(new URL('../scripts/ci-env-declarations.json', import.meta.url), 'utf8'));

test('AIT-202: packages and plugins obey declared layers and public exports', () => {
  assert.deepEqual(checkBoundaries(root), []);
});
test('AIT-202: test CI environment reads are explicit and unchanged', () => {
  assert.deepEqual(checkCiEnv(root, declarations), []);
});
test('AIT-202: architecture tables render the actual enforcement policy', () => {
  const doc = readFileSync(resolve(root, 'docs/architecture.md'), 'utf8');
  assert.ok(doc.includes(renderLayerTable()), 'layer table drift');
  assert.ok(doc.includes(renderCiEnvTable(declarations)), 'CI env table drift');
});

test('parser finds static, dynamic, re-export, require and template imports without reading comments or strings', () => {
  const source = "import 'one'; export * from 'two'; export { x } from 'three'; import(`four`); import(`five${x}`); require(name); import('six'); // import('ignored')\nconst text = \"import('ignored')\";";
  assert.deepEqual(importSpecifiers(parseSource('fixture.js', source)).map(item => item.specifier),
    ['one', 'two', 'three', 'four', undefined, undefined, 'six']);
  assert.throws(() => parseSource('broken.js', 'import {'), /cannot parse/u);
});
test('ambient detector handles computed access, destructuring and process aliases', () => {
  const ast = parseSource('fixture.js', "process['env'][`CI`]; process.env[name]; const { CI } = process.env; import { env } from 'node:process'; const p = process;");
  assert.deepEqual(ciEnvReads(ast), ['CI', 'alias process', 'import node:process', 'process.env', 'process.env[name]'].sort());
});

test('CI declarations reject new variables, added reads, indirect aliases and stale entries', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-ci-env-'));
  mkdirSync(resolve(dir, 'test'));
  const file = resolve(dir, 'test/fixture.js');
  const declared = { 'test/fixture.js': { reads: ['CI'], reason: 'Explicit matrix selection' } };
  writeFileSync(file, 'process.env.CI;');
  assert.deepEqual(checkCiEnv(dir, declared), []);
  for (const source of ["process.env.CI; process.env.RUNNER_OS;", "process.env.CI; process.env.CI;",
    "const e = process.env; e.CI;", "const p = process; p.env.GITHUB_ACTIONS;", "globalThis.process.env.CI;"]) {
    writeFileSync(file, source);
    // Equivalent direct global access still needs only the declared CI entry.
    assert.equal(checkCiEnv(dir, declared).length, source.startsWith('globalThis') ? 0 : 1, source);
  }
  writeFileSync(file, '');
  assert.equal(checkCiEnv(dir, declared).length, 1);
  assert.equal(checkCiEnv(dir, { 'test/removed.js': { reads: ['CI'], reason: 'Removed fixture' } }).length, 1);
});

test('boundary fixtures reject forbidden layers, unexported paths, dev leaks and unknown imports', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-boundaries-'));
  const put = (path, source) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), source); };
  for (const name of ['core', 'server', 'ui']) {
    put(`packages/${name}/package.json`, JSON.stringify({ name: `@inspr/aithema-${name}`, exports: { '.': './src/index.js', './public': './src/public.js' } }));
    put(`packages/${name}/src/index.js`, ''); put(`packages/${name}/src/public.js`, ''); put(`packages/${name}/src/private.js`, '');
  }
  put('plugins/fake-voice/src/index.js', '');
  put('plugins/adapter/src/index.js', [
    "import '../../../packages/core/src/public.js';", "import '@inspr/aithema-core/public';", // allowed
    "export * from '../../../packages/core/src/private.js';", "import('@inspr/aithema-server/src/private.js');",
    "import(`../../../packages/ui/src/private.js`);", "import('../../../plugins/fake-voice/src/index.js');",
    "import(name);", "import '../../../packages/core/test/private.js';", "import '@inspr/aithema-unknown';",
  ].join('\n'));
  put('packages/core/src/index.js', "import '../../server/src/public.js';");
  put('packages/ui/src/index.js', "import '@inspr/aithema-server';");
  put('packages/server/src/index.js', "import '../../../plugins/adapter/src/index.js';");
  const errors = checkBoundaries(dir);
  assert.equal(errors.length, 10, errors.join('\n'));
  assert.equal(errors.filter(error => error.includes('Forbidden')).length, 2);
  assert.equal(errors.filter(error => error.includes('Unexported')).length, 4);
  assert.ok(errors.some(error => error.includes('Test-only')));
  assert.ok(errors.some(error => error.includes('Non-literal')));
  assert.ok(errors.some(error => error.includes('dev/test')));
  assert.ok(errors.some(error => error.includes('Unknown workspace')));
});
