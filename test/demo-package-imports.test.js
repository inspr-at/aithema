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
test('demo server modules consume Aithema only through package exports', () => {
  const directory = new URL('../demo/', import.meta.url);
  for (const file of sources(fileURLToPath(directory))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    const deep = /(?:from\s*|import\s*(?:\(\s*)?)["'][^"']*\.\.\/(?:packages|plugins)\/[^"']*\/src\//u.test(source);
    if (deep) assert.ok(browserExceptions.has(file), `${file} must import a package export`);
  }
});
