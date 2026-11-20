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

// AIT-582 r4: the scanner parses with TypeScript; one fixture per r3 re-gate finding.
const reasons = files => scan(files).escapes.map(({ member, kind, specifier, reason }) =>
  specifier === undefined ? `${member}: ${reason}` : `${member} ${kind} ${specifier}: ${reason}`);

test('r4 finding 1: a contextual keyword used as a name divides like any other name', () => {
  assert.deepEqual(cjs([
    "let of = 6; of / [require('../../outside.cjs')][0] / 2;",
    "let async = 6; async / [require('../../async.cjs')][0] / 2;",
    "let get = 6; get / [require('../../get.cjs')][0] / 2;",
  ].join('\n')), [
    'require() ../../outside.cjs -> outside.cjs',
    'require() ../../async.cjs -> async.cjs',
    'require() ../../get.cjs -> get.cjs',
  ]);
});

test('r4 finding 2: literals fold through any parentheses', () => {
  assert.deepEqual(escapes('src/a.js', [
    "import('../' + ('../outside.js'));",
    "import(('../') + '../left.js');",
    "import('../' + ('../' + name));",
    "require.resolve(('./' + ('../' + '../nested.cjs')));",
  ].join('\n')), [
    'import() ../../outside.js -> outside.js',
    'import() ../../left.js -> left.js',
    'import() ../../ -> /',
    'require.resolve() ./../../nested.cjs -> nested.cjs',
  ]);
});

test('r4 finding 3: every absolute specifier and file: URL fails, in every form', () => {
  assert.deepEqual(reasons({
    'src/a.cjs': [
      "require('//package/outside.cjs');",
      "require('/package/src/b.cjs');",
      "require.resolve('file:///package/src/b.cjs');",
    ].join('\n'),
    'src/b.js': [
      "import '//package/src/b.js';",
      "new URL('/package/src/c.json', import.meta.url);",
      "import.meta.resolve('FILE:///package/src/c.js');",
    ].join('\n'),
    'src/c.d.ts': '/// <reference path="/package/src/types.d.ts" />',
  }), [
    'src/a.cjs require() //package/outside.cjs: is absolute, so it is not inside package/',
    'src/a.cjs require() /package/src/b.cjs: is absolute, so it is not inside package/',
    'src/a.cjs require.resolve() file:///package/src/b.cjs: is a file: URL, so it is not inside package/',
    'src/b.js import //package/src/b.js: is absolute, so it is not inside package/',
    'src/b.js new URL(…, import.meta.url) /package/src/c.json: is absolute, so it is not inside package/',
    'src/b.js import.meta.resolve() FILE:///package/src/c.js: is a file: URL, so it is not inside package/',
    'src/c.d.ts reference path /package/src/types.d.ts: is absolute, so it is not inside package/',
  ]);
});

test('r4 finding 4: legal code after debugger and other statement ends is never a scan failure', () => {
  const text = [
    'debugger',
    "/[)]/.test(')');",
    "if (a) b(); else /[}]/.test('}');",
    "do /[(]/.test('('); while (false)",
    "import './inside.js';",
  ].join('\n');
  assert.deepEqual(scan({ 'src/a.js': text }), { scanned: 1, escapes: [] });
});

test('r4 low: a malformed escape in any template chunk fails as unreadable', () => {
  assert.deepEqual(reasons({
    'src/a.js': 'import(`./${name}\\xZZ`);',
    'src/b.js': 'import(`./${a}/${b}\\u{110000}`);',
    'src/c.js': "require.resolve(flag ? `./${a}\\u12` : './inside.js');",
  }), [
    'src/a.js import() ./: has a malformed escape and cannot be checked',
    'src/b.js import() ./: has a malformed escape and cannot be checked',
    'src/c.js require.resolve() ./: has a malformed escape and cannot be checked',
  ]);
});

test('r4: TypeScript import forms and .mts/.cts members are scanned', () => {
  assert.equal(scannedMember('src/a.mts'), true);
  assert.equal(scannedMember('src/a.cts'), true);
  assert.deepEqual(reasons({
    'src/a.ts': [
      "import fs = require('../../equals.cjs');",
      "import type { T } from '../../types.js';",
      "export type { U } from '../../reexport.js';",
      "type Q = typeof import('../../query.js');",
      "import ok = require('./inside.cjs');",
    ].join('\n'),
    'src/b.mts': "export * from '../../module.mjs';",
    'src/c.cts': "import x = require('../../common.cjs');",
  }), [
    'src/a.ts import = require() ../../equals.cjs: resolves to equals.cjs, outside package/',
    'src/a.ts from ../../types.js: resolves to types.js, outside package/',
    'src/a.ts from ../../reexport.js: resolves to reexport.js, outside package/',
    'src/a.ts import() ../../query.js: resolves to query.js, outside package/',
    'src/b.mts from ../../module.mjs: resolves to module.mjs, outside package/',
    'src/c.cts import = require() ../../common.cjs: resolves to common.cjs, outside package/',
  ]);
});

test('r4: a member with a syntax error fails as not scanned completely', () => {
  const [failure, ...rest] = reasons({ 'src/a.js': "const = 1;\nimport './inside.js';", 'src/ok.js': "import './inside.js';" });
  assert.deepEqual(rest, []);
  assert.match(failure, /^src\/a\.js: could not be scanned completely \(line 1: .+\), so its imports cannot be checked$/u);
});

test('r4: a later chunk that climbs after a computed part fails closed', () => {
  assert.deepEqual(reasons({
    'src/a.js': 'import(`./${dir}/../../x.js`);',
    'src/b.js': "import('./' + dir + '/../../y.js');",
    'src/ok.js': "import(`./locales/${lang}.json`); import('./' + name + '.js');",
  }), [
    'src/a.js import() ./: may climb outside package/ (a later part of the argument contains ..)',
    'src/b.js import() ./: may climb outside package/ (a later part of the argument contains ..)',
  ]);
});

// AIT-582 r5: one fixture per r4 re-gate finding (LEAD option A, final narrow round).
test('r5 a: parentheses and TypeScript wrappers around callees and receivers are seen through', () => {
  assert.deepEqual(reasons({
    'src/a.cjs': [
      "(require)('../../paren.cjs');",
      "(require).resolve('../../receiver.cjs');",
      "(require.resolve)('../../callee.cjs');",
    ].join('\n'),
    'src/b.js': [
      "new URL('../../meta.js', (import.meta).url);",
      "new URL('../../url.js', (import.meta.url));",
      "new (URL)('../../ctor.js', import.meta.url);",
      "(import.meta).resolve('../../resolve.js');",
      "(import.meta.resolve)('../../bound.js');",
    ].join('\n'),
    'src/c.ts': [
      "(require as any)('../../as.cjs');",
      "require!('../../bang.cjs');",
      "(<any>require).resolve('../../cast.cjs');",
      "new URL('../../sat.js', (import.meta as ImportMeta).url);",
      "(import.meta satisfies ImportMeta).resolve('../../satisfies.js');",
    ].join('\n'),
  }), [
    'src/a.cjs require() ../../paren.cjs: resolves to paren.cjs, outside package/',
    'src/a.cjs require.resolve() ../../receiver.cjs: resolves to receiver.cjs, outside package/',
    'src/a.cjs require.resolve() ../../callee.cjs: resolves to callee.cjs, outside package/',
    'src/b.js new URL(…, import.meta.url) ../../meta.js: resolves to meta.js, outside package/',
    'src/b.js new URL(…, import.meta.url) ../../url.js: resolves to url.js, outside package/',
    'src/b.js new URL(…, import.meta.url) ../../ctor.js: resolves to ctor.js, outside package/',
    'src/b.js import.meta.resolve() ../../resolve.js: resolves to resolve.js, outside package/',
    'src/b.js import.meta.resolve() ../../bound.js: resolves to bound.js, outside package/',
    'src/c.ts require() ../../as.cjs: resolves to as.cjs, outside package/',
    'src/c.ts require() ../../bang.cjs: resolves to bang.cjs, outside package/',
    'src/c.ts require.resolve() ../../cast.cjs: resolves to cast.cjs, outside package/',
    'src/c.ts new URL(…, import.meta.url) ../../sat.js: resolves to sat.js, outside package/',
    'src/c.ts import.meta.resolve() ../../satisfies.js: resolves to satisfies.js, outside package/',
  ]);
});

test('r5 b: drive letters and file: fail in every form, also as a template prefix or a folded literal', () => {
  const absolute = 'is absolute, so it is not inside package/', fileUrl = 'is a file: URL, so it is not inside package/';
  assert.deepEqual(reasons({
    'src/a.js': [
      "import 'C:/x.js';",
      "export * from 'd:\\\\y.js';",
      "import('C:/z.js');",
      'import(`C:/${name}`);',
      'import(`file:${name}`);',
      "import('FILE:' + name);",
      "import('fi' + 'le:///w.js');",
      "new URL('C:/u.json', import.meta.url);",
      "import.meta.resolve('c:\\\\m.js');",
    ].join('\n'),
    'src/b.cjs': [
      "require(`file:${name}`);",
      "require.resolve('C:' + '/r.cjs');",
      "require(`D:\\\\${name}`);",
    ].join('\n'),
  }), [
    `src/a.js import C:/x.js: ${absolute}`,
    `src/a.js from d:\\y.js: ${absolute}`,
    `src/a.js import() C:/z.js: ${absolute}`,
    `src/a.js import() C:/: ${absolute}`,
    `src/a.js import() file:: ${fileUrl}`,
    `src/a.js import() FILE:: ${fileUrl}`,
    `src/a.js import() file:///w.js: ${fileUrl}`,
    `src/a.js new URL(…, import.meta.url) C:/u.json: ${absolute}`,
    `src/a.js import.meta.resolve() c:\\m.js: ${absolute}`,
    `src/b.cjs require() file:: ${fileUrl}`,
    `src/b.cjs require.resolve() C:/r.cjs: ${absolute}`,
    `src/b.cjs require() D:\\: ${absolute}`,
  ]);
});

test('r5 c: percent-encoded dots and separators count for the later-.. rule', () => {
  const climb = 'may climb outside package/ (a later part of the argument contains ..)';
  assert.deepEqual(reasons({
    'src/a.js': 'import(`./${dir}/%2e%2e/%2e%2e/%2e%2e/x.js`);',
    'src/b.js': 'import(`./${dir}/%2E%2e/y.js`);',
    'src/c.js': 'import(`./${dir}/.%2e/z.js`);',
    'src/d.js': "import('./' + dir + '/..%2fw.js');",
    'src/e.js': 'import(`./${dir}%2F..%5Cv.js`);',
    'src/ok.js': 'import(`./${dir}/%2e/inside.js`); import(`./${dir}/%2e%2e.js`);',
  }), [
    `src/a.js import() ./: ${climb}`,
    `src/b.js import() ./: ${climb}`,
    `src/c.js import() ./: ${climb}`,
    `src/d.js import() ./: ${climb}`,
    `src/e.js import() ./: ${climb}`,
  ]);
});

test('r5 d: a very long + chain is walked without recursion and never throws', () => {
  const terms = 50000;
  const chain = Array.from({ length: terms }, (_, i) => `n${i}`).join(' + ');
  const folded = ["'../'", "'../'", "'deep'", ...Array.from({ length: terms - 4 }, () => "''"), "'.cjs'"].join(' + ');
  let result;
  assert.doesNotThrow(() => {
    result = reasons({
      'src/a.cjs': `const total = ${chain};\nrequire('../../after.cjs');`,
      'src/b.cjs': `require(${folded});`,
      'src/c.cjs': `require('./' + ${chain});`,
    });
  });
  assert.deepEqual(result, [
    'src/a.cjs require() ../../after.cjs: resolves to after.cjs, outside package/',
    'src/b.cjs require() ../../deep.cjs: resolves to deep.cjs, outside package/',
  ]);
});

test('r5 low: an escape error in a closed literal is not a scan failure; an unterminated literal still is', () => {
  const [unterminatedString, unterminatedTemplate, ...rest] = reasons({
    'src/a.js': "const s = '\\u{12';\nimport './inside.js';",
    'src/b.js': "const s = 'ok';\nconst t = `\\u{12${x}`;\nimport './inside.js';",
    'src/c.js': "const s = '\\u{12;\nimport './inside.js';",
    'src/d.js': 'const t = `\\u{12;\nimport "./inside.js";',
  });
  assert.deepEqual(rest, []);
  assert.match(unterminatedString, /^src\/c\.js: could not be scanned completely \(.+\), so its imports cannot be checked$/u);
  assert.match(unterminatedTemplate, /^src\/d\.js: could not be scanned completely \(.+\), so its imports cannot be checked$/u);
});
