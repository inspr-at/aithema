import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossPackageImports, moduleSpecifiers, scannedMember } from '../release/lib/package-imports.mjs';

// AIT-582 scanner rules: specifiers are found by tokens, never inside comments or plain strings.
const scan = (files) => crossPackageImports(new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])));
const escapes = (path, text) => scan({ [path]: text }).escapes.map(({ kind, specifier, target }) => `${kind} ${specifier} -> ${target}`);

test('every module specifier form that leaves package/ is reported with its resolved target', () => {
  assert.deepEqual(escapes('src/a.js', [
    "import x from '../../core/src/x.js';",
    "import '../../core/src/side.js';",
    "export { y } from \"../../core/src/y.js\";",
    'const z = await import(`../../core/src/z.js`);',
    "const u = new URL('../../ui/src/style.css', import.meta.url);",
    "const r = require('../../core/src/r.cjs');",
    "const q = require.resolve('../../core/package.json');",
    "const m = import.meta.resolve('../../core/src/m.js');",
    'const t = import(`../../plugins/${name}.js`);',
    "import data from '../../../release/version.json' with { type: 'json' };",
  ].join('\n')), [
    'from ../../core/src/x.js -> core/src/x.js',
    'import ../../core/src/side.js -> core/src/side.js',
    'from ../../core/src/y.js -> core/src/y.js',
    'import() ../../core/src/z.js -> core/src/z.js',
    'new URL(…, import.meta.url) ../../ui/src/style.css -> ui/src/style.css',
    'require() ../../core/src/r.cjs -> core/src/r.cjs',
    'require.resolve() ../../core/package.json -> core/package.json',
    'import.meta.resolve() ../../core/src/m.js -> core/src/m.js',
    'import() ../../plugins/ -> plugins/',
    'from ../../../release/version.json -> release/version.json',
  ]);
});

test('escaped, percent-encoded, absolute and multi-line specifiers resolve like the loader', () => {
  assert.deepEqual(escapes('src/a.mjs', [
    "import('\\x2e\\x2e/\\u002e\\u002e/core/x.js');",
    "new URL('%2e%2e/%2e%2e/core/x.json', import.meta.url);",
    "import '/etc/x.js';",
    "import 'file:///x.js';",
    'import {\n  a,\n} from // why\n  "../../x.js";',
    'import /* comment */ ( "../../y.js" );',
  ].join('\n')), [
    'import() ../../core/x.js -> core/x.js',
    'new URL(…, import.meta.url) %2e%2e/%2e%2e/core/x.json -> core/x.json',
    'import /etc/x.js -> etc/x.js',
    'import file:///x.js -> x.js',
    'from ../../x.js -> x.js',
    'import() ../../y.js -> y.js',
  ]);
});

test('in-package relative specifiers pass, including from nested members', () => {
  const result = scan({
    'src/a.js': "import './b.js'; import { c } from '../lib/c.js'; export * from './d/e.js';\nnew URL('./worklet.js', import.meta.url);",
    'src/d/e.js': "export { a } from '../a.js'; const f = import('../../package.json');",
    'bin/cli.js': "#!/usr/bin/env node\nimport '../src/a.js';",
    'src/index.d.ts': "/// <reference path=\"./types.d.ts\" />\nexport type A = import('./a.js').A;",
  });
  assert.deepEqual(result, { scanned: 4, escapes: [] });
});

test('comments, plain strings, regexes and member calls containing ../ are not specifiers', () => {
  const text = [
    "// import { x } from '../../core/src/x.js';",
    "/* export * from '../x.js'; import('../x.js') */",
    "const a = 'from ../x.js', b = \"import('../x.js')\", c = `require('../x.js')`;",
    "const d = /from '..\\/x.js'|import\\('\\.\\.\\/x'\\)/u.test(a) ? a.replace('../x.js', '') : x.from('../x.js');",
    "const e = { from: '../x.js', import: '../x.js' }, f = api.import('../x.js'), g = obj.require('../x.js');",
    "const h = new URL('../x.js', base), i = new URL('../x.js', 'https://host.invalid/');",
    "const j = `${'from'} ${`'../x.js'`}`, k = 'import(\\'../x.js\\')';",
    "const l = 1 / 2 / 3, m = '/' + '../x.js';",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(text), []);
  assert.deepEqual(escapes('src/a.js', text), []);
});

test('scheme URLs and bare package names are not relative specifiers', () => {
  assert.deepEqual(escapes('src/a.js', [
    "import x from '@inspr/aithema-core/x';",
    "import 'node:fs';",
    "new URL('https://host.invalid/x.js', import.meta.url);",
    "new URL('data:text/javascript,1', import.meta.url);",
  ].join('\n')), []);
});

test('TypeScript declarations and reference paths are scanned', () => {
  assert.equal(scannedMember('src/index.d.ts'), true);
  assert.equal(scannedMember('src/a.cjs'), true);
  assert.equal(scannedMember('README.md'), false);
  assert.equal(scannedMember('package.json'), false);
  assert.deepEqual(escapes('src/index.d.ts', "/// <reference path=\"../../core/types.d.ts\" />\nexport type A = import('../../core/src/a.js').A;"), [
    'reference path ../../core/types.d.ts -> core/types.d.ts',
    'import() ../../core/src/a.js -> core/src/a.js',
  ]);
});
