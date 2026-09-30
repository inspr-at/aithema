import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { addSbom, buildSbom, integrityHashes, SBOM_PATH, sbomBytes } from '../release/lib/sbom.mjs';
import { createDeterministicTarball, createDeterministicSourceTarball, stagePackageTree, stageSourceTree } from '../release/lib/tarball.mjs';
import { trashTemp } from './fixtures/packaging-support.mjs';

const epoch = 1_700_000_000;
const digest = (alg, size, byte = 0xab) => `${alg}-${Buffer.alloc(size, byte).toString('base64')}`;
const pkg = { name: '@example/core', version: '1.0.0', license: 'AGPL-3.0-only', dependencies: { '@example/lib': '2.0.0' } };
function fixture() {
  return {
    name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: {
      '': structuredClone(pkg),
      'node_modules/@example/lib': { version: '2.0.0', license: 'MIT', integrity: digest('sha512', 64), resolved: 'https://registry.example.invalid/lib.tgz' },
      'node_modules/@example/lib/node_modules/child': { version: '1.2.3', license: '(MIT AND Zlib)', integrity: digest('sha256', 32), dev: true },
    },
  };
}
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

it('generates CycloneDX 1.6, root and transitive purls, licences, SRI hashes and the fixed epoch', () => {
  const bom = buildSbom(pkg, fixture(), epoch);
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.6');
  assert.equal(bom.version, 1);
  assert.equal(bom.metadata.timestamp, '2023-11-14T22:13:20.000Z');
  assert.equal(bom.metadata.component.purl, 'pkg:npm/%40example/core@1.0.0');
  assert.deepEqual(bom.metadata.component.licenses, [{ license: { id: 'AGPL-3.0-only' } }]);
  assert.equal(bom.components.length, 2);
  assert.equal(bom.components[0].purl, 'pkg:npm/%40example/lib@2.0.0');
  assert.deepEqual(bom.components[0].hashes, [{ alg: 'SHA-512', content: 'ab'.repeat(64) }]);
  assert.deepEqual(bom.components[0].licenses, [{ license: { id: 'MIT' } }]);
  assert.deepEqual(bom.components[1].licenses, [{ expression: '(MIT AND Zlib)' }]);
  assert.equal(bom.components[1].scope, 'excluded');
});

it('is byte-identical with reordered package keys, dependencies and lock entries', () => {
  const lock = fixture();
  const reversed = { ...lock, packages: Object.fromEntries(Object.entries(lock.packages).reverse()) };
  assert.deepEqual(sbomBytes(pkg, lock, epoch), sbomBytes({ ...pkg, dependencies: { ...pkg.dependencies } }, reversed, epoch));
  assert.notDeepEqual(sbomBytes(pkg, lock, epoch), sbomBytes(pkg, lock, epoch + 1));
});

it('preserves distinct installations and aliased npm package names', () => {
  const lock = fixture();
  lock.packages['node_modules/alias'] = { name: '@example/lib', ...lock.packages['node_modules/@example/lib'] };
  const components = buildSbom(pkg, lock, epoch).components;
  assert.equal(components[0].purl, components[2].purl);
  assert.notEqual(components[0]['bom-ref'], components[2]['bom-ref']);
});

it('represents absent lockfile licence evidence explicitly and retains optional packages', () => {
  const lock = fixture();
  delete lock.packages['node_modules/@example/lib'].license;
  lock.packages['node_modules/@example/lib'].optional = true;
  const component = buildSbom(pkg, lock, epoch).components[0];
  assert.equal('licenses' in component, false);
  assert.ok(component.properties.some((p) => p.name === 'aithema:license-evidence' && p.value.includes('Not declared')));
  assert.equal(component.hashes.length, 1);
});

it('preserves named licences without inventing invalid SPDX identifiers', () => {
  const lock = fixture();
  lock.packages['node_modules/@example/lib'].license = 'Custom-License';
  assert.deepEqual(buildSbom(pkg, lock, epoch).components[0].licenses, [{ license: { name: 'Custom-License' } }]);
});

it('decodes and sorts all supported SRI algorithms, deduplicates hashes, and accepts SRI options', () => {
  const sri = [digest('sha512', 64), digest('sha1', 20), digest('sha384', 48), digest('sha256', 32), digest('sha1', 20)].join(' ');
  assert.deepEqual(integrityHashes(sri).map((h) => h.alg), ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
  assert.deepEqual(integrityHashes(`${digest('sha256', 32)}?fixture`), [{ alg: 'SHA-256', content: 'ab'.repeat(32) }]);
});

it('rejects missing, unsupported, truncated, and non-canonical integrity values', () => {
  for (const value of [undefined, '', 'md5-AAAA', 'sha512-AA==', 'sha256-***', `${digest('sha256', 32)}junk`]) {
    assert.throws(() => integrityHashes(value), /integrity/);
  }
});

it('rejects invalid epochs and unsupported or inconsistent lockfiles', () => {
  for (const value of [undefined, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => buildSbom(pkg, fixture(), value), /epoch/);
  assert.throws(() => buildSbom(pkg, { lockfileVersion: 1 }, epoch), /lockfile/);
  for (const key of ['name', 'version', 'license', 'dependencies']) {
    const lock = fixture();
    lock.packages[''][key] = key === 'dependencies' ? {} : 'wrong';
    assert.throws(() => buildSbom(pkg, lock, epoch), new RegExp(`disagree on ${key}`));
  }
  const lock = fixture();
  lock.packages['node_modules/@example/lib'].link = true;
  assert.throws(() => buildSbom(pkg, lock, epoch), /path or link/);
  const traversal = fixture();
  traversal.packages['../node_modules/foreign'] = { ...traversal.packages['node_modules/@example/lib'] };
  assert.throws(() => buildSbom(pkg, traversal, epoch), /path or link/);
});

it('rejects malformed package metadata, unsupported resolutions and absent integrity', () => {
  for (const changes of [{ version: '' }, { license: '' }, { name: 'bad/name' }, { resolved: 'file:../foreign' }, { resolved: 'https://user:password@example.invalid/a' }, { integrity: undefined }]) {
    const lock = fixture();
    Object.assign(lock.packages['node_modules/@example/lib'], changes);
    assert.throws(() => buildSbom(pkg, lock, epoch));
  }
});

it('generates an SBOM from the real lockfile using no installed-package or network lookups', () => {
  const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  const lock = read('package-lock.json');
  const bom = buildSbom(read('package.json'), lock, epoch);
  assert.equal(bom.components.length, Object.keys(lock.packages).length - 1);
  assert.ok(bom.components.every((c) => c.purl.startsWith('pkg:npm/') && c.hashes.length));
});

it('stages identical generated SBOMs and byte-identical runtime/source tarballs in independent builds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aithema-sbom-'));
  t.after(() => trashTemp(root));
  const outputs = [];
  for (const dir of ['a', 'b']) {
    const files = new Map([['package.json', bytes(pkg)], ['package-lock.json', bytes(fixture())], [SBOM_PATH, Buffer.from('stale')]]);
    addSbom(files, epoch);
    assert.deepEqual(files.get(SBOM_PATH), sbomBytes(pkg, fixture(), epoch));
    const stage = join(root, dir);
    const runtime = join(stage, 'runtime.tgz');
    const source = join(stage, 'source.tgz');
    createDeterministicTarball(stagePackageTree(stage, files), runtime, epoch);
    createDeterministicSourceTarball(stageSourceTree(stage, files), source, epoch);
    const extract = (archive, path) => execFileSync('tar', ['-xOzf', archive, path]);
    assert.deepEqual(extract(runtime, `package/${SBOM_PATH}`), extract(source, SBOM_PATH));
    outputs.push([readFileSync(runtime), readFileSync(source)]);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.throws(() => addSbom(new Map(), epoch), /input missing/);
});
