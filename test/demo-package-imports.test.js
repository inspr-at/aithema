import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Browsers currently load source URLs without an import map. Only these modules
// may use those paths; admin-view is shared with Node and the operator page.
const browserExceptions = new Set(['host.js', 'consent-page.js', 'admin-view.js', 'fake-voice.js']);
function sources(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(join(directory, entry.name), relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}
// Includes static imports/re-exports, side effects and dynamic imports with
// quoted or template-literal specifiers (including interpolated templates).
function assertPackageImports(files, exceptions = browserExceptions) {
  const needed = new Set();
  for (const [file, source] of files) {
    const deep = /(?:from\s*|import\s*(?:\(\s*)?)["'`][^"'`]*\.\.\/(?:packages|plugins)\/[^"'`]*\/src\//u.test(source);
    if (deep) {
      assert.ok(exceptions.has(file), `${file} must import a package export`);
      needed.add(file);
    }
  }
  for (const file of exceptions) assert.ok(needed.has(file), `${file} has a stale source-import exception`);
}

test('demo server modules consume Aithema only through package exports', () => {
  const directory = new URL('../demo/', import.meta.url);
  assertPackageImports(sources(fileURLToPath(directory)).map(file =>
    [file, readFileSync(new URL(file, directory), 'utf8')]));
});

test('import guard catches quoted and template-literal deep imports and re-exports', () => {
  const path = '../packages/core/src/index.js';
  for (const source of [
    `import { x } from '${path}';`, `export { x } from "${path}";`, `import '${path}';`,
    `import('${path}')`, 'import(`' + path + '`)',
    'import(`../plugins/${plugin}/src/index.js`)',
  ]) assert.throws(() => assertPackageImports([['server.js', source]], new Set()), /must import a package export/u);
  assert.doesNotThrow(() => assertPackageImports([['server.js', "import { x } from '@inspr/aithema-core';"]], new Set()));
});

test('import guard rejects unused and deleted-file exceptions', () => {
  for (const files of [[], [['old.js', "import '@inspr/aithema-core';"]]]) {
    assert.throws(() => assertPackageImports(files, new Set(['old.js'])), /stale source-import exception/u);
  }
  assert.doesNotThrow(() => assertPackageImports([['browser.js', "import '../packages/ui/src/index.js';"]], new Set(['browser.js'])));
});
