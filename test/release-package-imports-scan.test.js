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

// AIT-582 r3: the five scanner findings from the cross-family gate, one fixture each.
const cjs = text => escapes('src/a.cjs', text);

test('r3 finding 1: division after an expression never swallows a specifier', () => {
  assert.deepEqual(cjs([
    "n++ / require('../../outside.cjs') / 2;",
    "x.y-- / require('../../postfix.cjs') / 2;",
    "const o = {} / require('../../object.cjs') / 2;",
    "const f = function () {} / require('../../function.cjs') / 2;",
    "const k = class {} / require('../../class.cjs') / 2;",
    'const t = `${a}` / require(\'../../template.cjs\') / 2;',
    "a.return / require('../../member.cjs') / 2;",
    "𝑥 / require('../../astral.cjs') / 2;",
  ].join('\n')), [
    'require() ../../outside.cjs -> outside.cjs',
    'require() ../../postfix.cjs -> postfix.cjs',
    'require() ../../object.cjs -> object.cjs',
    'require() ../../function.cjs -> function.cjs',
    'require() ../../class.cjs -> class.cjs',
    'require() ../../template.cjs -> template.cjs',
    'require() ../../member.cjs -> member.cjs',
    'require() ../../astral.cjs -> astral.cjs',
  ]);
});

test('r3 finding 1: a regular expression after a statement head is not read as code', () => {
  const text = [
    "if (x) /import('..\\/..\\/if.js')/.test(y);",
    "while (x) /from '..\\/..\\/while.js'/.exec(y);",
    "for (;;) /require('..\\/..\\/for.cjs')/.test(y);",
    "with (x) /import('..\\/..\\/with.js')/.test(y);",
    "{ } /import('..\\/..\\/block.js')/.test(y);",
    "function f() {} /import('..\\/..\\/declaration.js')/.test(y);",
    "class C {} /import('..\\/..\\/class.js')/.test(y);",
    "const g = () => {}\n/import('..\\/..\\/arrow.js')/.test(y);",
    "label: { } /import('..\\/..\\/label.js')/.test(y);",
    "a\n++/import('..\\/..\\/prefix.js')/.lastIndex;",
    "const h = `${/import('..\\/..\\/substitution.js')/.source}`;",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(text), []);
  assert.deepEqual(escapes('src/a.js', text), []);
});

test('r3 finding 2: the specifier argument is parsed as a balanced expression', () => {
  assert.deepEqual(escapes('src/a.js', [
    "import(('../../outside.js'));",
    'new URL(`../../${name}.json`, import.meta.url);',
    'new URL(`../../${a}/${b}.json`, (import.meta.url));',
    "import(/* why */ ('../../comment.js'), { with: { type: 'json' } });",
    "import('../../' + name);",
    "import('../' + '../joined.js');",
    'import(`../..${sep}x.js`);',
    "import(flag ? '../../ternary.js' : './inside.js');",
  ].join('\n')), [
    'import() ../../outside.js -> outside.js',
    'new URL(…, import.meta.url) ../../ -> /',
    'new URL(…, import.meta.url) ../../ -> /',
    'import() ../../comment.js -> comment.js',
    'import() ../../ -> /',
    'import() ../../joined.js -> joined.js',
    'import() ../.. -> /',
    'import() ../../ternary.js -> ternary.js',
  ]);
});

test('r3 finding 3: require and require.resolve resolve as file paths, not URLs', () => {
  assert.deepEqual(cjs([
    "require('./dir?/../../../outside.cjs');",
    "require.resolve('./dir#/../../../hash.cjs');",
    "require('..\\\\..\\\\windows.cjs');",
    "require('./inside?/../ok.cjs');",
    "require('%2e%2e/%2e%2e/literal.cjs');",
  ].join('\n')), [
    'require() ./dir?/../../../outside.cjs -> outside.cjs',
    'require.resolve() ./dir#/../../../hash.cjs -> hash.cjs',
    'require() ..\\..\\windows.cjs -> windows.cjs',
  ]);
});

test('r3 finding 4: CR, U+2028 and U+2029 end a line comment', () => {
  for (const terminator of ['\r', '\u2028', '\u2029']) {
    assert.deepEqual(escapes('src/a.js', `// note${terminator}import '../../outside.js';`), ['import ../../outside.js -> outside.js'], JSON.stringify(terminator));
    assert.deepEqual(escapes('src/a.js', `#!/usr/bin/env node${terminator}import '../../hashbang.js';`), ['import ../../hashbang.js -> hashbang.js'], JSON.stringify(terminator));
  }
});

test('r3 finding 5: legal raw templates and malformed cooked escapes never crash the scan', () => {
  assert.deepEqual(escapes('src/a.js', [
    'const raw = String.raw`\\u{110000}`, other = String.raw`\\u{FFFFFFFFFFFF}\\x\\u12`;',
    "import '../../after.js';",
  ].join('\n')), ['import ../../after.js -> after.js']);
  assert.deepEqual(scan({ 'src/a.js': "import('\\u{110000}/../../x.js');" }).escapes.map(({ kind, reason }) => `${kind}: ${reason}`),
    ['import(): has a malformed escape and cannot be checked']);
});

test('r3: legacy octal and identifier escapes are read like the engine', () => {
  assert.deepEqual(cjs([
    "require('\\56\\56/\\56\\56/octal.cjs');",
    "\\u0072equire('../../escaped.cjs');",
  ].join('\n')), [
    'require() ../../octal.cjs -> octal.cjs',
    'require() ../../escaped.cjs -> escaped.cjs',
  ]);
});

test('r3: a member the tokenizer cannot finish cleanly fails closed', () => {
  const reasons = files => scan(files).escapes.map(({ member, reason }) => `${member}: ${reason}`);
  assert.deepEqual(reasons({
    'src/template.js': 'const a = `unterminated ${b}',
    'src/comment.js': '/* unterminated',
    'src/string.js': "const s = 'unterminated\nimport '../../x.js';",
    'src/open.js': 'if (x) { f(',
    'src/close.js': 'f(x)) }',
    'src/ok.js': 'export default { a: 1 } / 2;\nif (x) { y = [`${z}`]; }',
  }), [
    'src/template.js: could not be scanned completely (unterminated template), so its imports cannot be checked',
    'src/comment.js: could not be scanned completely (unterminated comment), so its imports cannot be checked',
    'src/string.js: could not be scanned completely (unterminated string), so its imports cannot be checked',
    'src/open.js: could not be scanned completely (unclosed bracket), so its imports cannot be checked',
    'src/close.js: could not be scanned completely (unmatched closing bracket), so its imports cannot be checked',
  ]);
});
