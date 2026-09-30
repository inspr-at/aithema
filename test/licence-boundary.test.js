import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { moduleSpecifiers, verifyLicenceBoundary } from '../release/lib/licence-boundary.mjs';
import { trashTemp } from './fixtures/packaging-support.mjs';

function fixture(t, source, path = 'contracts/check.js') {
  const root = mkdtempSync(join(tmpdir(), 'aithema-licence-boundary-'));
  t.after(() => trashTemp(root));
  write(root, path, source);
  return root;
}
function write(root, path, source) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

it('parses only static declarations, string aliases and attributes with line numbers', () => {
  const source = `import './side.js';
import {
  from as renamed,
  thing
} from './static.js';
import defaultValue, { "from" as named } from './default.js';
import defaultValue2, * as namespace from './namespace.js';
export { thing as exported } from './exports.js';
export * as nested from './nested.js';
export * as "namespace" from './string-namespace.js';
import data from './data.json' with { type: 'json' };
export { data as "{" } from './export.json' with { type: 'json' };
export { thing };`;
  const entries = moduleSpecifiers(source, 'contracts/test.js');
  assert.deepEqual(entries.map((e) => e.specifier), ['./side.js', './static.js', './default.js', './namespace.js', './exports.js', './nested.js', './string-namespace.js', './data.json', './export.json']);
  assert.equal(entries[1].line, 5);
  assert.equal(entries[4].kind, 'export from');
});

for (const [name, source] of [
  ['allowlisted builtins and relative references', `import { readFile } from 'node:fs'; export * from './local.js';`],
  ['comments and strings', `// import('../runtime/evil.js')\n/* require('package') */\nconst text = "export * from '../lib/evil.js'"; const t = \`import('bad')\`;`],
  ['regex literals', String.raw`const r = /import\('..\/runtime\/evil.js'\)/; const c = /[/'"\x60]/;`],
  ['regex after control conditions', String.raw`if (true) /require\('bare'\)/.test(''); while (false) /import\('bad'\)/.test('');`],
  ['import and export property names', `const api = { import(x) { return x; }, export: 1 }; api.import('example');`],
  ['multiline object and class import methods', `const obj = { import(x)\n{ return x; } }; class C { import(x)\n{ return x; } }`],
  ['methods with quoted parentheses in defaults', `const obj = { import(x = ')') { return x; } }; class C { import(x = '(') { return x; } }`],
  ['division', `const n = 5 / 2; const other = n / 2;`],
  ['template raw text and harmless substitutions', 'const text = `require import( process ${1 + 2} ${`module ${3}`}`;'],
  ['export without from followed by imports', `const thing = 1; export { thing };\nimport './local.js';`],
  ['import.meta.url', `const here = new URL('./local.json', import.meta.url);`],
  ['quoted forbidden property names', `const api = { 'require': 1, 'process': 2 }; api['require'];`],
]) {
  it(`accepts ${name}`, (t) => assert.equal(verifyLicenceBoundary(fixture(t, source)), 1));
}

for (const [name, source] of [
  ['AGPL lib static import', `import { thing } from '../lib/index.js';`, '../lib/index.js'],
  ['AGPL runtime re-export', `export * from '../runtime/index.js';`, '../runtime/index.js'],
  ['cross-tree import', `import '../element/index.js';`, '../element/index.js'],
  ['bare package', `import 'pdfkit';`, 'pdfkit'],
  ['unprefixed builtin', `require('fs');`, 'fs'],
  ['fake node builtin', `import 'node:nonexistent';`, 'node:nonexistent'],
  ['remote URL', `import('https://example.invalid/module.js');`, 'https://example.invalid/module.js'],
  ['file URL', `export * from 'file:///foreign.js';`, 'file:///foreign.js'],
  ['data URL', `import('data:text/javascript,export default 1');`, 'data:text/javascript,export default 1'],
  ['hex escapes', String.raw`import('\x2e\x2e/runtime/evil.js');`, '../runtime/evil.js'],
  ['unicode escapes', String.raw`require('\u002e\u{2e}/lib/evil.js');`, '../lib/evil.js'],
  ['escaped require identifier', String.raw`requ\u0069re('../runtime/evil.js');`, '../runtime/evil.js'],
  ['nested template expression', `const text = \`a \${\`b \${import('../runtime/evil.js')}\`}\`;`, '../runtime/evil.js'],
  ['division after function expression', `const f = function() {} / import('../runtime/evil.js') / 2;`, '../runtime/evil.js'],
  ['division after arrow expression', `const f = (() => {}) / import('../runtime/evil.js') / 2;`, '../runtime/evil.js'],
  ['division after nested class expression', `const C = class extends (class {}) {} / import('pdfkit') / 2;`, 'pdfkit'],
  ['division after nested unparenthesized class expression', `const C = class extends class {} {} / import('pdfkit') / 2;`, 'pdfkit'],
  ['division after async function expression', `const f = async function() {} / import('pdfkit') / 2;`, 'pdfkit'],
  ['percent-encoded traversal', `import('./%2e%2e/runtime/evil.js');`, './%2e%2e/runtime/evil.js'],
  ['backslash traversal', String.raw`import('./..\\runtime/evil.js');`, './..\\runtime/evil.js'],
  ['optional require', `require?.('../runtime/evil.js');`, '../runtime/evil.js'],
  ['dynamic after number literal', `const n = 0 / import('../runtime/evil.js');`, '../runtime/evil.js'],
  ['import followed by a block with ASI', `import('pdfkit')\n{}`, 'pdfkit'],
  ['require followed by a block with ASI', `require('pdfkit')\n{}`, 'pdfkit'],
  ['import followed by a block inside a function', `function f() { import('pdfkit')\n{} }`, 'pdfkit'],
  ['import followed by a block inside a labelled block', `function f() { label: { import('pdfkit')\n{} } }`, 'pdfkit'],
  ['import followed by a block inside a static class block', `class C { static { import('pdfkit')\n{} } }`, 'pdfkit'],
  ['import followed by a block inside consecutive blocks', `function f() { {} { import('pdfkit')\n{} } }`, 'pdfkit'],
  ['import followed by a block inside nested blocks', `function f() { { import('pdfkit')\n{} } }`, 'pdfkit'],
  ['import after a Unicode line separator in a comment', `// comment\u2028import('pdfkit');`, 'pdfkit'],
  ['import after a Unicode paragraph separator in a comment', `// comment\u2029import('pdfkit');`, 'pdfkit'],
  ['Unicode line continuation in a specifier', "import('./..\\\u2028/../runtime/evil.js');", './../../runtime/evil.js'],
  ['static hex escapes', String.raw`import '\x2e\x2e/runtime/evil.js';`, '../runtime/evil.js'],
  ['static unicode escapes', String.raw`import '\u002e\u{2e}/lib/evil.js';`, '../lib/evil.js'],
  ['static percent-encoded traversal', `import './%2e%2e/runtime/evil.js';`, './%2e%2e/runtime/evil.js'],
  ['static backslash traversal', String.raw`import './..\\runtime/evil.js';`, './..\\runtime/evil.js'],
  ['module.register package', `module.register('pdfkit');`, 'pdfkit'],
  ['module.register traversal', `module.register('../runtime/evil.js');`, '../runtime/evil.js'],
  ['optional module.register', `module?.register('../lib/evil.js');`, '../lib/evil.js'],
  ['computed module.register', `module['register']('../runtime/evil.js');`, '../runtime/evil.js'],
  ['optional computed module.register', `module?.['register']('../element/index.js');`, '../element/index.js'],
  ['escaped module.register', String.raw`modul\u0065.register('../runtime/evil.js');`, '../runtime/evil.js'],
  ['module.register template specifier', 'module.register(`../runtime/evil.js`);', '../runtime/evil.js'],
  ['createRequire immediate package', `createRequire(import.meta.url)('pdfkit');`, 'pdfkit'],
  ['createRequire immediate traversal', `createRequire(import.meta.url)('../runtime/evil.js');`, '../runtime/evil.js'],
  ['grouped createRequire call', `(createRequire(import.meta.url))('../lib/evil.js');`, '../lib/evil.js'],
  ['nested grouped createRequire call', `((createRequire(import.meta.url)))('../runtime/evil.js');`, '../runtime/evil.js'],
  ['optional immediate createRequire', `createRequire(import.meta.url)?.('../runtime/evil.js');`, '../runtime/evil.js'],
  ['optional createRequire construction', `createRequire?.(import.meta.url)('../lib/evil.js');`, '../lib/evil.js'],
  ['module.createRequire immediate call', `module.createRequire(import.meta.url)('pdfkit');`, 'pdfkit'],
  ['computed createRequire immediate call', `module['createRequire'](import.meta.url)('../runtime/evil.js');`, '../runtime/evil.js'],
  ['createRequire resolve', `createRequire(import.meta.url).resolve('pdfkit');`, 'pdfkit'],
  ['optional createRequire resolve', `createRequire(import.meta.url)?.resolve?.('../lib/evil.js');`, '../lib/evil.js'],
  ['optional createRequire resolve call', `createRequire(import.meta.url)?.resolve('pdfkit');`, 'pdfkit'],
  ['optional module.register call', `module.register?.('../runtime/evil.js');`, '../runtime/evil.js'],
]) {
  it(`rejects ${name} with the file and line`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), (error) => {
      assert.match(error.message, /contracts\/check.js/);
      assert.match(error.message, /:\d+: licence boundary/);
      return true;
    });
  });
}

for (const source of [
  'import(path);', `import('./local.js' + name);`, 'import(`./${name}.js`);',
  `import(('./local.js'));`, `import();`, `require(name);`, `require('./local.js' + name);`,
  'module.register(path);', 'module.register(name, import.meta.url);', 'module?.register(path);',
  `module['register'](name);`, 'module.register();', 'module.register(`./${name}.js`);',
  'createRequire(import.meta.url)(name);', `createRequire(import.meta.url)('./' + name);`,
  '(createRequire(import.meta.url))(name);', 'createRequire(import.meta.url)();',
  'createRequire?.(import.meta.url)(name);', 'module.createRequire(import.meta.url)(path);',
  `module['createRequire'](import.meta.url)(name);`,   'createRequire(import.meta.url).resolve(name);',
  'createRequire(import.meta.url)?.resolve?.(name);',
  'createRequire(import.meta.url)?.resolve(name);',
  'module.register?.(path);',
]) {
  it(`rejects non-literal loading: ${source}`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /contracts\/check.js:1: licence boundary/);
  });
}

it('allows nested references within each tree but rejects prefix lookalikes and traversal', (t) => {
  const root = fixture(t, `import '../local.js';`, 'contracts/nested/check.mjs');
  write(root, 'element/nested/check.mjs', `import '../local.js';`);
  assert.equal(verifyLicenceBoundary(root), 2);
  write(root, 'element/nested/check.mjs', `import '../../element-other/index.js';`);
  assert.throws(() => verifyLicenceBoundary(root), /element\/nested\/check.mjs.*element-other/);
});

for (const parenthesis of ['(', ')']) {
  for (const suffix of ['', '.href']) {
    const base = `new URL(${JSON.stringify(parenthesis)}, import.meta.url)${suffix}`;
    for (const call of ['createRequire', 'module.createRequire', "module['createRequire']"]) {
      it(`quoted ${parenthesis} in ${call} base cannot hide a literal load (${suffix || 'URL'})`, (t) => {
        const source = `${call}(${base})('pdfkit');`;
        assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /licence boundary/);
      });
      it(`quoted ${parenthesis} in ${call} base cannot hide a computed load (${suffix || 'URL'})`, (t) => {
        assert.throws(() => verifyLicenceBoundary(fixture(t, `${call}(${base})(name);`)), /licence boundary/);
      });
    }
  }
}

const loaderCalls = [
  ['immediate createRequire', (base) => `createRequire(${base})('./provider.js');`],
  ['stored createRequire', (base) => `const load = createRequire(${base}); load('./provider.js');`],
  ['createRequire resolve', (base) => `createRequire(${base}).resolve('./provider.js');`],
  ['module.createRequire', (base) => `module.createRequire(${base})('./provider.js');`],
  ['computed createRequire', (base) => `module['createRequire'](${base})('./provider.js');`],
  ['module.register', (base) => `module.register('./provider.js', ${base});`],
  ['computed module.register', (base) => `module['register']('./provider.js', ${base});`],
  ['optional module.register', (base) => `module?.register?.('./provider.js', ${base});`],
  ['module.register options', (base) => `module.register('./provider.js', { parentURL: ${base}, data: { synthetic: true } });`],
];

for (const [name, call] of loaderCalls) {
  it(`${name} rejects even a literal URL base inside its own tree`, (t) => {
    const root = fixture(t, call('new URL("./nested/anchor.js", import.meta.url).href'));
    write(root, 'contracts/nested/provider.js', 'export {};');
    assert.throws(() => verifyLicenceBoundary(root), /licence boundary/);
  });
  it(`${name} rejects a foreign loader base even with a local-looking specifier`, (t) => {
    const root = fixture(t, call('new URL("../runtime/provider.js", import.meta.url)'));
    write(root, 'runtime/provider.js', 'export {};');
    assert.throws(() => verifyLicenceBoundary(root), /contracts\/check.js:1: licence boundary/);
  });
  it(`${name} rejects computed loader bases`, (t) => {
    for (const base of ['parent', 'new URL(name, import.meta.url)', 'new URL("./anchor.js", parent)',
      'import.meta.url + suffix', 'new URL(")", import.meta.url).href + suffix']) {
      assert.throws(() => verifyLicenceBoundary(fixture(t, call(base))), /licence boundary/);
    }
  });
}

it('rejects loads regardless of loader base or a local target', (t) => {
  for (const source of [
    `createRequire(new URL('./nested/anchor.js', import.meta.url))('../../runtime/provider.js');`,
    `module.register('../../runtime/provider.js', new URL('./nested/anchor.js', import.meta.url));`,
  ]) {
    // Relative to check.js this ends outside the repository; relative to the
    // declared base it resolves to runtime/provider.js. Both must be refused.
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /licence boundary/);
  }
  for (const source of [
    `createRequire(new URL('./nested/anchor.js', import.meta.url))('../provider.js');`,
    `module.register('../provider.js', new URL('./nested/anchor.js', import.meta.url));`,
  ]) {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /licence boundary/);
  }
});

it('rejects absent, remote, malformed and ambiguous register parents', (t) => {
  for (const source of [
    `module.register('./provider.js');`,
    `module.register('./provider.js', 'https://example.invalid/anchor.js');`,
    `module.register('./provider.js', { data: {} });`,
    `module.register('./provider.js', { parentURL: import.meta.url, ...options });`,
    `module.register('./provider.js', { parentURL: import.meta.url, parentURL: parent });`,
    `createRequire('relative.js')('./provider.js');`,
    `createRequire('data:text/javascript,export default 1')('./provider.js');`,
  ]) assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /licence boundary/);
});

it('rejects symlink ancestors in loader bases, including a missing leaf', (t) => {
  for (const [, call] of loaderCalls) {
    const root = fixture(t, call('new URL("./link/missing/anchor.js", import.meta.url)'));
    mkdirSync(join(root, 'runtime'));
    symlinkSync('../runtime', join(root, 'contracts/link'));
    assert.throws(() => verifyLicenceBoundary(root), /licence boundary/);
  }
});


it('checks .js/.mjs/.cjs recursively and permits an absent element tree', (t) => {
  const root = fixture(t, `import 'node:crypto';`);
  write(root, 'runtime/ignored.js', `import('external-runtime-dependency');`);
  assert.equal(verifyLicenceBoundary(root), 1);
  write(root, 'element/nested/evil.mjs', `export * from '../../runtime/ignored.js';`);
  assert.throws(() => verifyLicenceBoundary(root), /element\/nested\/evil.mjs.*runtime/);
});

it('rejects symlinked boundary files and directories', (t) => {
  const root = fixture(t, 'export {};');
  write(root, 'runtime/foreign.js', 'export {};');
  symlinkSync('../runtime/foreign.js', join(root, 'contracts/link.js'));
  assert.throws(() => verifyLicenceBoundary(root), /contracts\/link.js.*symlink/);
  const second = fixture(t, `import './link/foreign.js';`);
  mkdirSync(join(second, 'runtime'));
  symlinkSync('../runtime', join(second, 'contracts/link'));
  assert.throws(() => verifyLicenceBoundary(second), /contracts\/(?:check.js|link).*boundary/);
});

it('fails closed on malformed strings, templates, comments and regex literals', (t) => {
  for (const source of [`import('unterminated);`, 'const t = `unfinished', '/* unfinished', 'const r = /unfinished']) {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /unterminated/);
  }
});

const boundarySource = readFileSync(new URL('../release/lib/licence-boundary.mjs', import.meta.url), 'utf8');
const forbidden = [
  'require', 'createRequire', 'register', 'registerHooks', 'getBuiltinModule',
  'module', 'process', 'eval', 'Function', 'Worker', 'global', 'globalThis',
  'WebAssembly', 'importScripts', 'SharedWorker',
];

for (const name of forbidden) {
  it(`forbids the ${name} identifier in every code position, even without a call`, (t) => {
    const root = fixture(t, `const value = ${name};`);
    assert.throws(() => verifyLicenceBoundary(root), /licence boundary rejects identifier/);
    for (const source of [
      `const ${name} = 1;`, `const api = { ${name}: 1 };`, `api.${name};`,
      `api?.${name};`, `class C { ${name}() {} }`, `function ${name}() {}`,
      `import { value as ${name} } from './local.js';`,
      `export { value as ${name} } from './local.js';`,
      `const text = \`outer \${\`inner \${${name}}\`}\`;`,
      `${name[0]}\\u${name.charCodeAt(1).toString(16).padStart(4, '0')}${name.slice(2)};`,
    ]) assert.throws(() => moduleSpecifiers(source), /licence boundary rejects identifier/, source);
    assert.deepEqual(moduleSpecifiers(`// ${name}\n/* ${name} */\nconst s = '${name}'; const t = \`${name}\`; const r = /${name}/;`), []);
  });
}

for (const builtin of ['node:module', 'node:vm', 'node:worker_threads', 'node:child_process', 'node:wasi', 'node:inspector', 'node:test', 'node:test/reporters', 'node:fs/promises', 'node:nonexistent']) {
  it(`rejects non-allowlisted builtin ${builtin}, including a neutral namespace alias`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, `import * as neutral from '${builtin}';`)), /rejects specifier/);
  });
}

for (const name of ['node:crypto', 'node:fs', 'node:path', 'node:url']) {
  it(`allows only the exact builtin spelling ${name}`, (t) => {
    assert.equal(verifyLicenceBoundary(fixture(t, `import * as neutral from '${name}';`)), 1);
    assert.throws(() => verifyLicenceBoundary(fixture(t, `import '${name.slice(5)}';`)), /rejects specifier/);
  });
}

for (const source of [
  `import('./local.js');`, `import('node:crypto');`, 'import(`./local.js`);',
  `const { resolve } = import.meta;`, `const meta = import.meta; meta['resolve']('../runtime/hook.js');`,
  `import.meta.resolve('./local.js');`, `import.meta['resolve']('./local.js');`,
  `import.meta?.resolve('./local.js');`, `import.meta['url'];`,
  `const text = \`outer \${\`inner \${import('./local.js')}\`}\`;`,
]) {
  it(`rejects non-static loading capability: ${source}`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /licence boundary rejects/);
  });
}

for (const source of [
  `function f() { import './local.js'; }`, `if (true) { export * from './local.js'; }`,
  `import path;`, `import { thing } from path;`, 'import `./local.js`;',
  `export * from path;`, `export { thing } from path;`,
  `import { ';' } from './local.js';`, `import * as ns;`,
  `import { x as 'alias' } from './local.js';`, `import { x y } from './local.js';`,
]) {
  it(`fails closed outside the static declaration grammar: ${source}`, () => {
    assert.throws(() => moduleSpecifiers(source), /requires a static top-level literal/);
  });
}

// Exact payloads reported by r1/r2. These are source data, never evaluated.
const reviewedBypasses = [
  ['r1 quoted closing parenthesis', `createRequire(new URL(")", import.meta.url).href)("pdfkit")`],
  ['r1 quoted closing parenthesis computed target', `createRequire(new URL(")", import.meta.url).href)(name)`],
  ['r1 foreign createRequire base', `createRequire(new URL("../runtime/provider.js", import.meta.url))("./provider.js")`],
  ['r1 foreign register base', `module.register("./provider.js", new URL("../runtime/provider.js", import.meta.url))`],
  ['r2 grouped createRequire identifier', `(createRequire)(import.meta.url)('../runtime/provider.cjs')`],
  ['r2 grouped module receiver', `(module).register('../runtime/hook.js', import.meta.url)`],
  ['r2 process builtin module', `process.getBuiltinModule('node:module').register('../runtime/hook.js', import.meta.url)`],
  ['r2 imported register', `import { register } from 'node:module'; register('../runtime/hook.js', import.meta.url)`],
  ['r2 aliased createRequire import', `import { createRequire as cr } from 'node:module'; cr(import.meta.url)('../runtime/provider.cjs')`],
  ['r2 stored loader', `const load = createRequire(import.meta.url); load('../runtime/provider.cjs')`],
  ['r2 loader call method', `createRequire(import.meta.url).call(null, '../runtime/provider.cjs')`],
  ['r2 quoted dot before side-effect import', `"."\nimport "../runtime/provider.js"`],
  ['r2 quoted function before require', `"function"\nrequire("../runtime/provider.cjs")`, 'contracts/check.cjs'],
  ['r2 quoted semicolon import alias', `import { ";" as semi } from "../runtime/provider.js"`],
  ['r2 quoted opening brace export alias', `export { "{" as opened } from "../runtime/provider.js"`],
];
for (const [name, source, path] of reviewedBypasses) {
  it(`review regression: ${name}`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source, path)), /licence boundary/);
  });
}

// Generated from every quoted keyword/punctuator spelling in the scanner,
// including its lexer context tables. A spelling added later joins this corpus.
const spellings = [...new Set([...boundarySource.matchAll(/'([^'\\\n]*)'/g)]
  .map((match) => match[1]).filter((value) => /^[A-Za-z]+$|^[()[\]{}.;,:*?+=!\/-]+$/.test(value)))].sort();
for (const spelling of spellings) {
  it(`token data cannot hide or invent an edge: ${JSON.stringify(spelling)}`, (t) => {
    const literal = JSON.stringify(spelling);
    const root = fixture(t, 'export {};');
    for (const [source, expected] of [
      [`${literal}\n`, []],
      [`const value = ${literal};\n`, []],
      [`import { ${literal} as alias } from './local.js';\n`, ['./local.js']],
      [`export { original as ${literal} } from './local.js';\n`, ['./local.js']],
      [`const api = { ${literal}: 1 }; api[${literal}];\n`, []],
    ]) {
      assert.deepEqual(moduleSpecifiers(source).map((edge) => edge.specifier), expected, source);
      write(root, 'contracts/check.js', source);
      assert.equal(verifyLicenceBoundary(root), 1);
      const outside = `${source}import '../runtime/provider.js';`;
      assert.deepEqual(moduleSpecifiers(outside).map((edge) => edge.specifier), [...expected, '../runtime/provider.js']);
      write(root, 'contracts/check.js', outside);
      assert.throws(() => verifyLicenceBoundary(root), /rejects specifier "\.\.\/runtime\/provider.js"/);
    }
  });
}

for (const keyword of ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do', 'function', 'class', 'if', 'while', 'for', 'with', 'switch', 'catch']) {
  it(`keyword property ${keyword} cannot change division into regex`, () => {
    assert.throws(() => moduleSpecifiers(`api.${keyword} / import('../runtime/provider.js') / 2;`), /dynamic import/);
    for (const dot of ['.', '?.']) {
      assert.throws(() => moduleSpecifiers(String.raw`api${dot}${keyword}(1) / require('\x2e\x2e\x2fruntime\x2fprovider.cjs') / 2;`), /licence boundary rejects identifier/);
    }
  });
}

async function mutated(before, after) {
  assert.equal(boundarySource.split(before).length, 2, `exactly one mutation site: ${before}`);
  return import(`data:text/javascript;base64,${Buffer.from(boundarySource.replace(before, after)).toString('base64')}`);
}

// Each previously missing loader/base proof now depends on the same code
// authority. Removing it restores acceptance, regardless of the call's syntax.
for (const [name, source, path] of reviewedBypasses.filter(([, source]) => /createRequire|module\.|process\.|require\(|register\(/.test(source))) {
  it(`mutation proof: code authority protects ${name}`, async (t) => {
    // Imports of node:module have two independent guards. This mutation isolates
    // the name guard by substituting an admissible intra-tree module specifier.
    const isolated = source.replace("'node:module'", "'./local.js'");
    const root = fixture(t, isolated, path);
    const mutant = await mutated('checkCode(tokens, source, file);', '');
    const regression = (api) => assert.throws(() => api.verifyLicenceBoundary(root), /licence boundary/);
    regression({ verifyLicenceBoundary });
    assert.throws(() => regression(mutant));
  });
}

for (const [name, before, after, source, accepting] of [
  ['identifier policy', "is(token, 'id') && forbiddenNames.has(token.value)", 'false', 'const value = require;'],
  ['member keyword regex goal', '!previous?.member &&', '', String.raw`api.if(1) / require('\x2e\x2e\x2fruntime\x2fprovider.cjs') / 2;`],
  ['dynamic import policy', "reject(token, 'dynamic import');", '', `const api = { value: import('./local.js') };`],
  ['import.meta authority', "reject(token, 'import.meta capability (only import.meta.url is allowed)');", ';', `import.meta.resolve('../runtime/hook.js');`],
  ['nested template traversal', 'for (const child of embedded) scan(child, false);', '', 'const text = `outer ${`inner ${require(path)}`}`;'],
  ['static top-level grammar', '!topLevel || token.depth !== 0', 'false', `function f() { import './local.js'; }`],
  ['literal side-effect collection', "add(next, 'import');", '', `import '../runtime/provider.js';`],
  ['shared from collection for import', 'add(tokens[cursor + 1], kind);', '', `import { thing } from '../runtime/provider.js';`],
  ['shared from collection for export', 'add(tokens[cursor + 1], kind);', '', `export { thing } from '../runtime/provider.js';`],
  ['shared from collection for namespace', 'add(tokens[cursor + 1], kind);', '', `export * from '../runtime/provider.js';`],
  ['explicit builtin allowlist', 'allowedBuiltins.has(specifier)', 'true', `import * as neutral from 'node:module'; neutral['register']('../runtime/hook.js', import.meta.url);`],
  ['relative target containment', 'safeFileURL(tree, new URL(specifier, pathToFileURL(file)))', 'true', `import '../runtime/provider.js';`],
  ['walker calls the policy', "moduleSpecifiers(readFileSync(path, 'utf8'), file)", '[]', `import '../runtime/provider.js';`],
  ['typed token authority', 'token?.type === type &&', 'token &&', `"."\nimport './local.js';`, true],
  ['typed method opening parenthesis', "is(tokens[index], 'punct', '(')", "tokens[index].value === '('", `const api = { import(x = '(') { return x; } };`, true],
  ['typed method closing parenthesis', "is(tokens[index], 'punct', ')')", "tokens[index].value === ')'", `const api = { import(x = ')') { return x; } };`, true],
  ['typed import alias delimiter', "while (!is(tokens[cursor], 'punct', '}'))", "while (tokens[cursor]?.value !== '}')", `import { '}' as alias } from './local.js';`, true],
  ['typed export alias delimiter', "while (!is(tokens[cursor], 'punct', '}'))", "while (tokens[cursor]?.value !== '}')", `export { '}' as alias } from './local.js';`, true],
]) {
  it(`mutation proof: ${name} turns its regression red`, async (t) => {
    const root = fixture(t, source);
    const mutant = await mutated(before, after);
    const regression = (api) => {
      if (accepting) {
        assert.equal(api.verifyLicenceBoundary(root), 1);
        assert.deepEqual(api.moduleSpecifiers(source), moduleSpecifiers(source));
      }
      else assert.throws(() => api.verifyLicenceBoundary(root), /licence boundary/);
    };
    regression({ verifyLicenceBoundary, moduleSpecifiers });
    assert.throws(() => regression(mutant));
  });
}

it('accepts the real publishable tree with exactly its reviewed builtin imports', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.ok(verifyLicenceBoundary(root) >= 1);
  const edges = moduleSpecifiers(readFileSync(join(root, 'contracts/validate.js'), 'utf8'));
  assert.deepEqual(edges.filter((edge) => edge.specifier.startsWith('node:')).map((edge) => edge.specifier).sort(), ['node:crypto', 'node:fs', 'node:path', 'node:url']);
});

it('imports real publishable entrypoints under a confined Node resolve hook', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entries = ['contracts/validate.js', 'element/index.js'].filter((path) => existsSync(join(root, path)));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { dirname, isAbsolute, relative, sep } from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    const builtins = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);
    for (const entry of ${JSON.stringify(entries)}) {
      const tree = realpathSync(dirname(fileURLToPath(new URL(entry, pathToFileURL(${JSON.stringify(`${root}/`)})))));
      const hook = registerHooks({ resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (builtins.has(result.url)) return result;
        const path = realpathSync(fileURLToPath(result.url));
        const rel = relative(tree, path);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('outside publishable tree: ' + result.url);
        return result;
      }});
      try { await import(new URL(entry, pathToFileURL(${JSON.stringify(`${root}/`)}))); }
      finally { hook.deregister(); }
    }
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
