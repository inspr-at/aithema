import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

it('parses side-effect, multiline, static, dynamic, export-from and CJS imports with line numbers', () => {
  const source = `import './side.js';
import {
  from as renamed,
  thing
} from './static.js';
export { thing as exported } from './exports.js';
export * as nested from './nested.js';
const one = import(/*comment*/ './dynamic.js', { with: { type: 'json' } });
const two = require('./common.cjs');
module.require('./module.cjs');
module['require']('./computed.cjs');
require.resolve('./resolve.cjs');
const three = import(\`./template.js\`);`;
  const entries = moduleSpecifiers(source, 'contracts/test.js');
  assert.deepEqual(entries.map((e) => e.specifier), ['./side.js', './static.js', './exports.js', './nested.js', './dynamic.js', './common.cjs', './module.cjs', './computed.cjs', './resolve.cjs', './template.js']);
  assert.equal(entries[1].line, 5);
});

for (const [name, source] of [
  ['builtins and relative references', `import { readFile } from 'node:fs'; export * from './local.js'; import('node:test/reporters'); require('./common.cjs');`],
  ['comments and strings', `// import('../runtime/evil.js')\n/* require('package') */\nconst text = "export * from '../lib/evil.js'"; const t = \`import('bad')\`;`],
  ['regex literals', String.raw`const r = /import\('..\/runtime\/evil.js'\)/; const c = /[/'"\x60]/;`],
  ['regex after control conditions', String.raw`if (true) /require\('bare'\)/.test(''); while (false) /import\('bad'\)/.test('');`],
  ['property names', `const api = { import(x) { return x; }, require(x) { return x; } }; api.import('example');`],
  ['multiline object and class methods', `const obj = { import(x)\n{ return x; } }; class C { require(x)\n{ return x; } }`],
  ['methods with quoted parentheses in their defaults', `const obj = { require(x = ')') { return x; }, import(x = '(') { return x; } }; class C { require(x = ')') { return x; } }`],
  ['division and a safe dynamic import', `const n = 5 / 2; const other = n / import('./local.js') / 2;`],
  ['template expressions with allowed imports', `const text = \`hello \${import('./local.js')}\`;`],
  ['export without from followed by imports', `export { thing };\nconst thing = import('./local.js');`],
  ['importing node:module', `import { createRequire, register } from 'node:module';\nimport module from 'node:module';\nconst local = createRequire(import.meta.url);`],
  ['literal module.register and immediate createRequire calls', `import module from 'node:module';\nmodule.register('./hook.js', import.meta.url);\nmodule?.register('./optional.js', import.meta.url);\nmodule['register']('./computed.js', import.meta.url);\ncreateRequire(import.meta.url)('./common.cjs');\n(createRequire(import.meta.url))('./grouped.cjs');\ncreateRequire(import.meta.url)?.('./chained.cjs');\nmodule.createRequire(import.meta.url).resolve('./resolved.cjs');`],
]) {
  it(`accepts ${name}`, (t) => assert.equal(verifyLicenceBoundary(fixture(t, source)), 1));
}

for (const [name, source, specifier] of [
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
  it(`rejects ${name} with the file and decoded specifier`, (t) => {
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), (error) => {
      assert.match(error.message, /contracts\/check.js/);
      assert.ok(error.message.includes(JSON.stringify(specifier)), error.message);
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
    assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /contracts\/check.js:1: non-literal/);
  });
}

it('allows nested references within each tree but rejects prefix lookalikes and traversal', (t) => {
  const root = fixture(t, `import '../local.js';`, 'contracts/nested/check.mjs');
  write(root, 'element/nested/check.cjs', `require('../local.cjs');`);
  assert.equal(verifyLicenceBoundary(root), 2);
  write(root, 'element/nested/check.cjs', `require('../../element-other/index.cjs');`);
  assert.throws(() => verifyLicenceBoundary(root), /element\/nested\/check.cjs.*element-other/);
});

for (const parenthesis of ['(', ')']) {
  for (const suffix of ['', '.href']) {
    const base = `new URL(${JSON.stringify(parenthesis)}, import.meta.url)${suffix}`;
    for (const call of ['createRequire', 'module.createRequire', "module['createRequire']"]) {
      it(`quoted ${parenthesis} in ${call} base cannot hide a literal load (${suffix || 'URL'})`, (t) => {
        const source = `${call}(${base})('pdfkit');`;
        assert.deepEqual(moduleSpecifiers(source).map((entry) => entry.specifier), ['pdfkit']);
        assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /rejects specifier "pdfkit"/);
      });
      it(`quoted ${parenthesis} in ${call} base cannot hide a computed load (${suffix || 'URL'})`, (t) => {
        assert.throws(() => verifyLicenceBoundary(fixture(t, `${call}(${base})(name);`)), /non-literal createRequire specifier/);
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
  it(`${name} resolves a literal URL base inside its own tree`, (t) => {
    const root = fixture(t, call('new URL("./nested/anchor.js", import.meta.url).href'));
    write(root, 'contracts/nested/provider.js', 'export {};');
    assert.equal(verifyLicenceBoundary(root), 2);
  });
  it(`${name} rejects a foreign loader base even with a local-looking specifier`, (t) => {
    const root = fixture(t, call('new URL("../runtime/provider.js", import.meta.url)'));
    write(root, 'runtime/provider.js', 'export {};');
    assert.throws(() => verifyLicenceBoundary(root), /contracts\/check.js:1: licence boundary/);
  });
  it(`${name} rejects computed loader bases`, (t) => {
    for (const base of ['parent', 'new URL(name, import.meta.url)', 'new URL("./anchor.js", parent)',
      'import.meta.url + suffix', 'new URL(")", import.meta.url).href + suffix']) {
      assert.throws(() => verifyLicenceBoundary(fixture(t, call(base))), /unproven .* loader base/);
    }
  });
}

it('resolves loads against the loader base rather than the source file', (t) => {
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
    assert.equal(verifyLicenceBoundary(fixture(t, source)), 1);
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
  ]) assert.throws(() => verifyLicenceBoundary(fixture(t, source)), /loader base|licence boundary/);
});

it('rejects symlink ancestors in loader bases, including a missing leaf', (t) => {
  for (const [, call] of loaderCalls) {
    const root = fixture(t, call('new URL("./link/missing/anchor.js", import.meta.url)'));
    mkdirSync(join(root, 'runtime'));
    symlinkSync('../runtime', join(root, 'contracts/link'));
    assert.throws(() => verifyLicenceBoundary(root), /licence boundary/);
  }
});

const boundarySource = readFileSync(new URL('../release/lib/licence-boundary.mjs', import.meta.url), 'utf8');
for (const [name, before, after, source] of [
  ['quoted closing parenthesis', "punct(tokens[index], ')')", "tokens[index].value === ')'",
    `createRequire(new URL(")", import.meta.url).href)('pdfkit');`],
  ['quoted opening parenthesis', "punct(tokens[index], '(')", "tokens[index].value === '('",
    `createRequire(new URL("(", import.meta.url).href)('pdfkit');`],
  ['createRequire base authority', "loaderBase(tokens.slice(open + 1, end), token, 'createRequire')", 'importMetaBase',
    `createRequire(new URL('../runtime/provider.js', import.meta.url))('./provider.js');`],
  ['stored createRequire base check', "add(token, 'loader base', base);", '',
    `const load = createRequire(new URL('../runtime/provider.js', import.meta.url)); load('./provider.js');`],
  ['register base authority', "loaderBase(registerParent(args[1]), token, 'module.register')", 'importMetaBase',
    `module.register('./provider.js', new URL('../runtime/provider.js', import.meta.url));`],
  ['base containment check', 'if (!safeFileURL(tree, base)) return false;', '',
    `module.register('../contracts/provider.js', new URL('../runtime/provider.js', import.meta.url));`],
  ['target resolution base', 'new URL(specifier, base)', 'new URL(specifier, pathToFileURL(file))',
    `module.register('../provider.js', new URL('./nested/anchor.js', import.meta.url));`],
]) {
  it(`mutation proof: ${name} turns its regression red`, async (t) => {
    assert.equal(boundarySource.split(before).length, 2, 'exactly one mutation site');
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(boundarySource.replace(before, after)).toString('base64')}`);
    const root = fixture(t, source);
    const regression = (api) => {
      if (name === 'target resolution base') assert.equal(api.verifyLicenceBoundary(root), 1);
      else if (name.startsWith('quoted')) assert.deepEqual(api.moduleSpecifiers(source).map((entry) => entry.specifier), ['pdfkit']);
      else assert.throws(() => api.verifyLicenceBoundary(root), /licence boundary/);
    };
    regression({ moduleSpecifiers, verifyLicenceBoundary });
    assert.throws(() => regression(mutant));
  });
}

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
