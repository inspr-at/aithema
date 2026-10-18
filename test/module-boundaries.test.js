import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, importSpecifiers, parseSource, renderLayerTable, renderExceptionTable } from '../scripts/check-boundaries.mjs';
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
  assert.ok(doc.includes(renderExceptionTable()), 'exception table drift');
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
  assert.deepEqual(ciEnvReads(ast), ['CI', 'alias process', 'import node:process', 'destructure { CI }', 'process.env[name]'].sort());
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
  const computed = { 'test/fixture.js': { reads: ['process.env[key]'], reason: 'Explicit forwarding',
    computedContexts: ["child = ['CI'].map(key => process.env[key])"] } };
  writeFileSync(file, "const child = ['CI'].map(key => process.env[key]);");
  assert.deepEqual(checkCiEnv(dir, computed), []);
  writeFileSync(file, "const child = ['CI', 'GITHUB_ACTIONS'].map(key => process.env[key]);");
  assert.equal(checkCiEnv(dir, computed).length, 1, 'changing the computed key list needs a declaration');
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
  assert.equal(errors.filter(error => error.includes('Forbidden')).length, 3);
  assert.equal(errors.filter(error => error.includes('Unexported')).length, 3);
  assert.ok(errors.some(error => error.includes('Test-only')));
  assert.ok(errors.some(error => error.includes('Non-literal')));
  assert.ok(errors.some(error => error.includes('dev/test')));
  assert.ok(errors.some(error => error.includes('Unknown workspace')));
});

test('createRequire aliases and namespace factories participate in the same import check', () => {
  const source = "import { createRequire as factory } from 'node:module'; const load = factory(import.meta.url); load('one'); load(name); import * as mod from 'module'; const other = mod.createRequire(import.meta.url); other(`two`);";
  assert.deepEqual(importSpecifiers(parseSource('fixture.js', source)).map(item => item.specifier), ['node:module', 'one', undefined, 'module', 'two']);
});

test('changing destructured environment keys requires a declaration', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-destructure-'));
  mkdirSync(resolve(dir, 'test'));
  const file = resolve(dir, 'test/fixture.js');
  const declared = { 'test/fixture.js': { reads: ['destructure { CI }'], reason: 'Pinned binding keys' } };
  writeFileSync(file, 'const { CI } = process.env;');
  assert.deepEqual(checkCiEnv(dir, declared), []);
  for (const binding of ['{ GITHUB_ACTIONS }', '{ CI, RUNNER_OS }', '{ CI: renamed }', '{ ...rest }', '{ [key]: value }']) {
    writeFileSync(file, `const ${binding} = process.env;`);
    assert.equal(checkCiEnv(dir, declared).length, 1, binding);
  }
});

test('AIT-160 qualification host allowances pin the source edge and OPS module expression', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-qualification-edge-'));
  const put = (path, source) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), source); };
  const host = "import '../plugins/composed-voice/ops/qualification-server.mjs';\nimport(pathToFileURL(resolve(process.env.AITHEMA_COMPOSED_QUALIFICATION_MODULE)).href);";
  put('plugins/composed-voice/ops/qualification-server.mjs', ''); put('demo/server.js', host);
  assert.deepEqual(checkBoundaries(dir), []);
  put('demo/other.js', host);
  assert.ok(checkBoundaries(dir).some(error => error.includes('Demo must import a package export')));
  assert.ok(checkBoundaries(dir).some(error => error.includes('Non-literal')));
  put('demo/other.js', '');
  put('demo/server.js', host.replace('AITHEMA_COMPOSED_QUALIFICATION_MODULE', 'AITHEMA_OTHER_MODULE'));
  assert.ok(checkBoundaries(dir).some(error => error.includes('Non-literal')));
});


test('dev exemptions stay exact and AIT-211 server-to-plugin edges are forbidden', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-exact-edges-'));
  const put = (path, source) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), source); };
  put('packages/core/package.json', JSON.stringify({ name: '@inspr/aithema-core', exports: { '.': './src/index.js' } }));
  put('packages/core/src/index.js', '');
  put('packages/server/package.json', JSON.stringify({ name: '@inspr/aithema-server', exports: { '.': './src/index.js', './dev/local-voice': './src/dev/local-voice.js' } }));
  put('packages/server/src/index.js', '');
  put('packages/server/src/dev/local-voice.js', "import '@inspr/aithema-core';");
  put('plugins/claude-html/package.json', JSON.stringify({ name: '@inspr/aithema-plugin-claude-html', exports: { '.': './src/index.js', './html-artifact': './src/html-artifact.js', './new': './src/new.js' } }));
  for (const name of ['index', 'html-artifact', 'new']) put(`plugins/claude-html/src/${name}.js`, '');
  put('plugins/openai-images/package.json', JSON.stringify({ name: '@inspr/aithema-plugin-openai-images', exports: { '.': './src/index.js', './image-artifact': './src/image-artifact.js' } }));
  for (const name of ['index', 'image-artifact']) put(`plugins/openai-images/src/${name}.js`, '');
  put('demo/server.js', "import '@inspr/aithema-server/dev/local-voice';");
  put('plugins/fake-voice/src/server.js', "export * from '../../../packages/server/src/dev/local-voice.js';");
  assert.deepEqual(checkBoundaries(dir), []);
  for (const file of ['plugin-runtime', 'local-html', 'local-images', 'new']) {
    for (const specifier of ['@inspr/aithema-plugin-claude-html', '@inspr/aithema-plugin-claude-html/html-artifact',
      '@inspr/aithema-plugin-openai-images', '@inspr/aithema-plugin-openai-images/image-artifact',
      '../../../plugins/claude-html/src/index.js', '../../../plugins/openai-images/src/image-artifact.js']) {
      put(`packages/server/src/${file}.js`, `import '${specifier}';`);
      const errors = checkBoundaries(dir);
      assert.equal(errors.length, 1, errors.join('\n'));
      assert.match(errors[0], /Forbidden server → plugin/u, `${file}: ${specifier}`);
    }
    put(`packages/server/src/${file}.js`, '');
  }
  put('packages/core/dev/bypass.js', "import '@inspr/aithema-server';");
  assert.ok(checkBoundaries(dir).some(error => error.includes('Forbidden core')));
  put('packages/core/dev/bypass.js', '');
  put('plugins/claude-html/src/new.js', "import '@inspr/aithema-server/dev/local-voice';");
  assert.ok(checkBoundaries(dir).some(error => error.includes('dev/test')));
});


test('inline createRequire and assignment aliases cannot bypass private imports', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-require-'));
  const put = (path, source) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), source); };
  put('packages/core/package.json', JSON.stringify({ name: '@inspr/aithema-core', exports: { '.': './src/index.js' } }));
  put('packages/core/src/index.js', ''); put('packages/core/src/private.js', '');
  const prefix = "import { createRequire as factory } from 'node:module'; import * as mod from 'module';";
  for (const expression of [
    "factory(import.meta.url)('@inspr/aithema-core/src/private.js');",
    "mod.createRequire(import.meta.url)('@inspr/aithema-core/src/private.js');",
    "let load; load = factory(import.meta.url); load('@inspr/aithema-core/src/private.js');",
    "let load; load = require; load('@inspr/aithema-core/src/private.js');",
    "let a, b, c; a = b; b = c; c = factory(import.meta.url); a('@inspr/aithema-core/src/private.js');",
    "const load = factory(import.meta.url); let alias; alias = load; alias('@inspr/aithema-core/src/private.js');",
  ]) {
    put('plugins/adapter/src/index.js', prefix + expression);
    assert.equal(checkBoundaries(dir).filter(error => error.includes('Unexported')).length, 1, expression);
  }
  for (const expression of ["factory(import.meta.url)(name);", "let load; load = require; load(name);"]) {
    put('plugins/adapter/src/index.js', prefix + expression);
    assert.ok(checkBoundaries(dir).some(error => error.includes('Non-literal')), expression);
  }
});

test('parameter defaults and assignments pin every destructured environment key', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-env-patterns-'));
  mkdirSync(resolve(dir, 'test'));
  const file = resolve(dir, 'test/fixture.js');
  const declared = { 'test/fixture.js': { reads: ['destructure { CI }'], reason: 'Pinned binding keys' } };
  for (const source of [binding => `function fixture(${binding} = process.env) {}`,
    binding => `let CI, GITHUB_ACTIONS, RUNNER_OS, renamed, rest, key, value; (${binding} = process.env);`,
    binding => `function fixture(${binding} = (process.env)) {}`]) {
    writeFileSync(file, source('{ CI }'));
    assert.deepEqual(checkCiEnv(dir, declared), []);
    for (const binding of ['{ GITHUB_ACTIONS }', '{ CI, RUNNER_OS }', '{ CI: renamed }', '{ ...rest }', '{ [key]: value }']) {
      writeFileSync(file, source(binding));
      assert.equal(checkCiEnv(dir, declared).length, 1, source(binding));
    }
  }
});

test('supported component and coordinator exports open while source-only proof edges stay exact', async () => {
  const components = await import('@inspr/aithema-core/voice-components');
  const core = await import('@inspr/aithema-core');
  for (const name of ['componentInvocation', 'assertSTTComponent', 'assertTTSComponent', 'voiceCompositionCapabilities', 'boundedEvents', 'audioQueue']) {
    assert.equal(typeof components[name], 'function');
    assert.equal(core[name], components[name]);
  }
  for (const specifier of ['@inspr/aithema-server/composed-voice']) {
    const coordinator = await import(specifier);
    assert.equal(typeof coordinator.createComposedVoiceCoordinator, 'function');
    assert.equal(typeof coordinator.callDurationSeconds, 'function');
  }
  const dir = mkdtempSync(resolve(tmpdir(), 'aithema-proof-edges-'));
  const put = (path, source) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), source); };
  put('packages/server/package.json', JSON.stringify({ name: '@inspr/aithema-server', exports: { '.': './src/index.js' } }));
  put('packages/server/src/index.js', ''); put('packages/server/src/composed-voice.js', ''); put('packages/server/src/new.js', '');
  put('plugins/composed-voice/src/server.js', "import '../../../packages/server/src/composed-voice.js';");
  assert.deepEqual(checkBoundaries(dir), []);
  put('plugins/composed-voice/src/new.js', "import '../../../packages/server/src/composed-voice.js';");
  assert.ok(checkBoundaries(dir).some(error => error.includes('Unexported')));
  put('plugins/composed-voice/src/new.js', '');
  put('plugins/composed-voice/src/server.js', "import '../../../packages/server/src/new.js';");
  assert.ok(checkBoundaries(dir).some(error => error.includes('Unexported')));
});

test('speech conformance kits share the supported core root export', async () => {
  const core = await import('@inspr/aithema-core');
  const kits = await import('../packages/core/src/conformance.js');
  for (const name of ['sttConformance', 'ttsConformance']) {
    assert.equal(typeof core[name], 'function');
    assert.equal(core[name], kits[name]);
  }
  await assert.rejects(import('@inspr/aithema-core/speech-conformance'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
