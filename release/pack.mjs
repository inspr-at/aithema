import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTreeEntries, readBlob, resolveCommit, commitEpochSeconds, validateArchivePath } from './lib/git.mjs';
import { sha256, gitBlobSha1 } from './lib/digest.mjs';
import { stagePackageTree, createDeterministicTarball, assertCanonicalReleaseToolchain } from './lib/tarball.mjs';
import { assertRuntimeProvenanceBinding, buildSourceProvenanceText } from './lib/provenance.mjs';
import { parseVersion, assertReleaseTag } from './lib/version.mjs';
import { verifyPresentation } from './presentation-pin.mjs';
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => `sha256:${sha256(bytes)}`;
const forbidden = path => path.split('/').some(part => /^(?:\.env|env\.)/u.test(part) || /(?:\.example|\.age)$/u.test(part));
export function admittedPath(path) {
  return !forbidden(path) && (['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'docs/embedding.md'].includes(path) ||
    /^(?:packages|plugins)\/[^/]+\/(?:package\.json|src\/.+|bin\/.+)$/u.test(path) ||
    /^demo\/(?!test\/)[^/]+\.(?:js|css|html)$/u.test(path) || /^release\/(?:[^/]+\.(?:json|mjs)|lib\/[^/]+\.mjs)$/u.test(path));
}
// Tree listing does not read disallowed file contents. Release builds read admitted Git blobs only.
export function releasePaths(root) {
  root = root instanceof URL ? fileURLToPath(root) : root;
  const paths = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix + name;
      if (forbidden(path) || ['.git', 'node_modules', 'dist'].includes(name)) continue;
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink()) { if (admittedPath(path)) throw new Error('Release rejects symlink'); continue; }
      if (stat.isDirectory()) walk(join(dir, name), path + '/');
      else if (admittedPath(path)) paths.push(path);
    }
  }
  walk(root); return paths;
}
function treeDigest(files) {
  return digest([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => `${path}\t${gitBlobSha1(bytes)}`).join('\n'));
}
function packageVersions(files, source) {
  const packages = [...files.keys()].filter(path => /^(?:packages|plugins)\/[^/]+\/package\.json$/u.test(path)).sort();
  const names = new Set(packages.map(path => JSON.parse(files.get(path)).name));
  const setVersion = pkg => {
    pkg.version = source.version;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) if (names.has(name)) pkg[field][name] = source.version;
    }
    return pkg;
  };
  const inventory = packages.map(path => {
    const pkg = setVersion(JSON.parse(files.get(path))); files.set(path, Buffer.from(json(pkg)));
    return { name: pkg.name, version: pkg.version, path, exports: pkg.exports ?? {}, license: pkg.license };
  });
  files.set('package.json', Buffer.from(json(setVersion(JSON.parse(files.get('package.json'))))));
  const lock = JSON.parse(files.get('package-lock.json')); lock.version = source.version;
  for (const [path, pkg] of Object.entries(lock.packages)) if (path === '' || packages.some(file => file.slice(0, -13) === path)) setVersion(pkg);
  files.set('package-lock.json', Buffer.from(json(lock)));
  return inventory;
}
export function packRelease({ root = fileURLToPath(new URL('../', import.meta.url)), output, dryRun = false, ref } = {}) {
  root = resolve(root); if (!output) throw new Error('New output directory required');
  const commit = resolveCommit(root);
  const entries = listTreeEntries(root, commit).filter(entry => admittedPath(entry.path));
  if (entries.some(entry => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) throw new Error('Release requires regular Git blobs');
  const files = new Map(entries.map(entry => [entry.path, readBlob(root, commit, entry.path)]));
  const declared = JSON.parse(files.get('release/version.json'));
  parseVersion(declared);
  if (!dryRun) assertReleaseTag(ref, declared);
  const source = dryRun ? { ...declared, version_scheme: 'inspr-calver-3', version: declared.status === 'reserved' ? declared.version : declared.dry_run_version,
    release_sequence: declared.release_sequence ?? declared.migration.first_calendar_sequence } : declared;
  parseVersion(source); verifyPresentation(root);
  assertCanonicalReleaseToolchain();
  const sourceTree = treeDigest(files), lockDigest = digest(files.get('package-lock.json'));
  const packages = packageVersions(files, source);
  const epoch = commitEpochSeconds(root, commit);
  files.set('release/runtime.json', Buffer.from(json({ ...source, mode: dryRun ? 'dry-run' : 'release', source: { commit, tree_digest: sourceTree, lock_digest: lockDigest }, date: new Date(epoch * 1000).toISOString() })));
  const lock = JSON.parse(files.get('package-lock.json'));
  files.set('release/sbom.spdx.json', Buffer.from(json({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: `aithema-reset-${source.version}`, documentNamespace: `https://github.com/inspr-at/aithema/releases/${source.version}/${commit}`,
    creationInfo: { created: new Date(epoch * 1000).toISOString(), creators: ['Tool: aithema-release-prep'] },
    packages: Object.entries(lock.packages).filter(([, pkg]) => pkg.version && !pkg.link).map(([path, pkg], index) => ({
      SPDXID: `SPDXRef-Package-${index}`, name: pkg.name ?? path.replace(/^node_modules\//u, ''), versionInfo: pkg.version,
      downloadLocation: pkg.resolved ?? 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: pkg.license ?? 'NOASSERTION',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${(pkg.name ?? path.replace(/^node_modules\//u, '')).replace('@', '%40')}@${pkg.version}` }],
    })) })));
  // Archived provenance contract: the exported tree/lock must bind the claimed source commit.
  const provenance = buildSourceProvenanceText({ privateSourceCommit: commit, currentSourceCommit: commit, exportMtimeEpoch: epoch,
    runtimeTreeDigest: treeDigest(files), lockDigest: digest(files.get('package-lock.json')) });
  assertRuntimeProvenanceBinding(JSON.parse(provenance), { treeDigest: treeDigest(files), lockDigest: digest(files.get('package-lock.json')) });
  files.set('release/source-provenance.json', Buffer.from(provenance));
  const stage = mkdtempSync(join(tmpdir(), 'aithema-release-'));
  const packageRoot = stagePackageTree(stage, files), directory = resolve(output); mkdirSync(directory, { recursive: false });
  const filename = `aithema-reset-${source.version}.tgz`, artifactPath = join(directory, filename);
  createDeterministicTarball(packageRoot, artifactPath, epoch);
  const manifest = { schema: 'aithema-release-set/1', mode: dryRun ? 'dry-run' : 'release', version_scheme: source.version_scheme, version: source.version,
    release_channel: source.release_channel, release_sequence: source.release_sequence, migration: { ...source.migration, first_calendar_version: source.migration.first_calendar_version ?? source.version },
    source: { commit, tree_digest: sourceTree, lock_digest: lockDigest }, toolchain: { node: '24', tar: 'canonical GNU in CI; BSD local verification' },
    validation: { policy: 'PR dry-run plus separate release qualification', run: process.env.GITHUB_RUN_ID ?? 'offline-test' },
    packages, files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) })),
    artifacts: [{ coordinate: `workspace/npm-tgz/any/any/default/${filename}`, path: filename, sha256: digest(readFileSync(artifactPath)) }] };
  writeFileSync(join(directory, 'release-set.json'), json(manifest), { flag: 'wx' }); verifyRelease(directory);
  return { directory, artifactPath, manifest };
}
export function verifyRelease(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'release-set.json'))); parseVersion(manifest);
  if (manifest.schema !== 'aithema-release-set/1' || !['dry-run', 'release'].includes(manifest.mode) || !/^[a-f0-9]{40}$/u.test(manifest.source.commit) ||
    !Number.isSafeInteger(manifest.release_sequence) || manifest.release_sequence < 1 || !manifest.release_channel || manifest.artifacts.length !== 1) throw new Error('Invalid release-set manifest');
  for (const artifact of manifest.artifacts) {
    validateArchivePath(artifact.path);
    if (artifact.path.includes('/') || !/^sha256:[a-f0-9]{64}$/u.test(artifact.sha256) || artifact.coordinate !== `workspace/npm-tgz/any/any/default/${artifact.path}`) throw new Error('Invalid artifact coordinate');
    const path = join(directory, artifact.path); if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Artifact must be regular file');
    if (digest(readFileSync(path)) !== artifact.sha256) throw new Error('Artifact digest mismatch');
    const paths = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n');
    const expected = manifest.files.map(file => `package/${file.path}`).sort();
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(expected)) throw new Error('Artifact file inventory mismatch');
    const listing = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8' }).trim().split('\n');
    if (listing.length !== paths.length || listing.some(line => !line.startsWith('-'))) throw new Error('Artifact requires regular members');
    const byPath = new Map(manifest.files.map(file => [file.path, file]));
    if (byPath.size !== manifest.files.length) throw new Error('Duplicate artifact member');
    const total = manifest.files.reduce((sum, file) => {
      validateArchivePath(file.path);
      if (forbidden(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 16 * 1024 * 1024) throw new Error('Invalid artifact member');
      return sum + file.size;
    }, 0);
    if (total > 128 * 1024 * 1024) throw new Error('Artifact exceeds verification limit');
    // tar streams regular members in listing order; one decompression verifies the complete closure.
    const payload = execFileSync('tar', ['-xOzf', path], { maxBuffer: total + 1 });
    if (payload.length !== total) throw new Error('Artifact member size mismatch');
    const members = new Map(); let offset = 0;
    for (const name of paths) {
      const file = byPath.get(name.slice('package/'.length)), bytes = payload.subarray(offset, offset + file.size);
      offset += file.size;
      if (digest(bytes) !== file.sha256) throw new Error('Artifact member digest mismatch');
      members.set(file.path, bytes);
    }
    const runtime = JSON.parse(members.get('release/runtime.json')), provenance = JSON.parse(members.get('release/source-provenance.json'));
    if (['version', 'version_scheme', 'release_channel', 'release_sequence', 'mode'].some(key => runtime[key] !== manifest[key]) ||
      runtime.source.commit !== manifest.source.commit || provenance.current_source_commit !== manifest.source.commit ||
      runtime.source.tree_digest !== manifest.source.tree_digest || runtime.source.lock_digest !== manifest.source.lock_digest) throw new Error('Artifact source commit/metadata binding mismatch');
    const bound = new Map(members); bound.delete('release/source-provenance.json');
    assertRuntimeProvenanceBinding(provenance, { treeDigest: treeDigest(bound), lockDigest: digest(members.get('package-lock.json')) });
    for (const pkg of manifest.packages) {
      const emitted = JSON.parse(members.get(pkg.path)); if (emitted.name !== pkg.name || emitted.version !== manifest.version || pkg.version !== manifest.version) throw new Error('Package version mapping mismatch');
    }
  }
  return manifest;
}
export function rollbackArtifact(directory, trustedManifest, coordinate) {
  if (trustedManifest.mode !== 'release') throw new Error('A dry-run cannot be rollback evidence');
  const actual = verifyRelease(directory);
  if (actual.mode !== 'release') throw new Error('A dry-run cannot be rollback evidence');
  // Caller supplies the retained immutable manifest, not a mutable latest alias.
  if (['version_scheme', 'version', 'release_channel', 'release_sequence'].some(key => actual[key] !== trustedManifest[key]) ||
    JSON.stringify(actual.source) !== JSON.stringify(trustedManifest.source) || JSON.stringify(actual.artifacts) !== JSON.stringify(trustedManifest.artifacts)) throw new Error('Rollback manifest mismatch');
  const artifact = actual.artifacts.find(item => item.coordinate === coordinate); if (!artifact) throw new Error('Rollback artifact coordinate missing');
  return { ...artifact, deploymentEvent: { action: 'rollback', version_scheme: actual.version_scheme, version: actual.version, release_sequence: actual.release_sequence, coordinate, sha256: artifact.sha256 } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output, ref] = process.argv.slice(2);
  if (command === 'verify') console.log(JSON.stringify(verifyRelease(output)));
  else if (command === 'pack') console.log(JSON.stringify(packRelease({ output, ref }).manifest));
  else throw new Error('Usage: node release/pack.mjs pack <new-output-directory> <refs/tags/vVERSION> | verify <directory>');
}
