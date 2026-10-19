import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, gitBlobSha1 } from '../../release/lib/digest.mjs';
import { stagePackageTree, createDeterministicTarball } from '../../release/lib/tarball.mjs';
import { buildSourceProvenanceText } from '../../release/lib/provenance.mjs';
import { moduleFiles } from '../../release/lib/modules.mjs';

export const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const digest = bytes => 'sha256:' + sha256(bytes);
export const version = { ...JSON.parse(readFileSync(new URL('../../release/version.json', import.meta.url))),
  version: '261019120000.0.0', release_sequence: 19 };
export function treeDigest(files) {
  return digest([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => `${path}\t${gitBlobSha1(bytes)}`).join('\n'));
}

// A tiny, real workspace and module archive, through the production tar writer.
export function releaseSet(t, { mode = 'candidate', commit = 'a'.repeat(40), mutateFiles = () => {},
  mutateManifest = () => {}, mutateModule = () => {}, badProvenance = false, run = 'candidate-run' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aithema-normalize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'out'); mkdirSync(directory);
  const source = { commit, tree_digest: digest('source'), lock_digest: digest('source lock') };
  const runtime = json({ ...version, mode, source, date: '2026-10-19T12:00:00.000Z' });
  const pkg = { name: '@inspr/fixture', version: version.version, license: 'AGPL-3.0-only', exports: { '.': './src/index.js' } };
  const packages = [{ name: pkg.name, version: pkg.version, path: 'packages/fixture/package.json', license: pkg.license, exports: pkg.exports, publish: true }];
  const files = new Map(Object.entries({
    'package.json': json({ name: 'fixture', private: true, version: version.version }),
    'package-lock.json': json({ lockfileVersion: 3, version: version.version, packages: {} }),
    'LICENSE': Buffer.from('AGPL fixture\n'), 'README.md': Buffer.from('Source\n'), 'docs/embedding.md': Buffer.from('Guide\n'),
    'packages/fixture/package.json': json(pkg), 'packages/fixture/src/index.js': Buffer.from('export const fixture = true;\n'),
    'release/runtime.json': runtime, 'packages/server/src/release-runtime.json': runtime,
    'release/ordinary.json': json({ mode: 'candidate', packing: { run: 'fixed' }, runtime_tree_digest: 'fixed' }),
  }));
  mutateFiles(files);
  files.set('release/source-provenance.json', Buffer.from(buildSourceProvenanceText({
    privateSourceCommit: commit, currentSourceCommit: commit, exportMtimeEpoch: 1792411200,
    runtimeTreeDigest: badProvenance ? digest('wrong') : treeDigest(files), lockDigest: digest(files.get('package-lock.json')),
  })));
  const inventory = members => [...members].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) }));
  const writeArchive = (name, members) => {
    createDeterministicTarball(stagePackageTree(join(root, name), members), join(directory, name), 1792411200);
    return digest(readFileSync(join(directory, name)));
  };
  const workspace = `aithema-reset-${version.version}.tgz`, module = `inspr-fixture-${version.version}.tgz`;
  const members = moduleFiles(files, packages[0]); mutateModule(members);
  const manifest = { schema: 'aithema-release-set/1', mode, version_scheme: version.version_scheme,
    version: version.version, release_channel: version.release_channel, release_sequence: version.release_sequence,
    migration: version.migration, source, toolchain: { node: '24' }, packing: { run }, validation: { policy: 'fixture' },
    packages, files: inventory(files), artifacts: [
      { kind: 'workspace', path: workspace, coordinate: `workspace/npm-tgz/any/any/default/${workspace}`, sha256: writeArchive(workspace, files) },
      { kind: 'module', name: pkg.name, path: module, coordinate: `npm-tgz/${pkg.name}/${version.version}`,
        sha256: writeArchive(module, members), files: inventory(members) },
    ] };
  mutateManifest(manifest);
  writeFileSync(join(directory, 'release-set.json'), json(manifest));
  return { directory, manifest, files };
}
