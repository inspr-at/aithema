import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
  ['division and a safe dynamic import', `const n = 5 / 2; const other = n / import('./local.js') / 2;`],
  ['template expressions with allowed imports', `const text = \`hello \${import('./local.js')}\`;`],
  ['export without from followed by imports', `export { thing };\nconst thing = import('./local.js');`],
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
