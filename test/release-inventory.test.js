import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { expandAllowlistPathsFromTree } from '../release/lib/tree.mjs';
import { SBOM_PATH } from '../release/lib/sbom.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
function files(prefix) {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

it('both closed inventories cover every file in contracts, lib and all current runtime subtrees', () => {
  const runtime = new Set(expandAllowlistPathsFromTree(root, read('release/allowlist.json').paths));
  const source = new Set(expandAllowlistPathsFromTree(root, read('release/source-allowlist.json').paths));
  for (const prefix of ['contracts', 'lib', 'runtime']) {
    for (const path of files(prefix)) {
      assert.ok(runtime.has(path), `runtime inventory omits ${path}`);
      assert.ok(source.has(path), `source inventory omits ${path}`);
    }
  }
  for (const path of ['runtime/journal/client.js', 'runtime/settings/resolver.js', 'runtime/ports/reasoning.js', 'runtime/budget/gate.js', 'runtime/audit/writer.js', 'runtime/hosts/aeon/index.js', 'contracts/authz-record.schema.json']) {
    assert.ok(runtime.has(path), `runtime inventory must retain ${path}`);
  }
  assert.equal(runtime.has('release/build-release.mjs'), false);
  assert.equal(runtime.has('test/packaging.test.js'), false);
});

it('the source inventory carries the shared SBOM generator and both licence-check helpers', () => {
  const source = new Set(expandAllowlistPathsFromTree(root, read('release/source-allowlist.json').paths));
  for (const path of ['release/lib/sbom.mjs', 'release/lib/model-assets.mjs', 'release/lib/licence-boundary.mjs']) assert.ok(source.has(path));
  const inventory = read('release/publication-inventory.json');
  for (const item of Object.values(inventory.exports)) assert.deepEqual(item.generated_files, [SBOM_PATH]);
  assert.ok(inventory.included_in_public_source.includes('contracts/'));
});
