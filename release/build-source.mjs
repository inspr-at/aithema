#!/usr/bin/env node
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from './lib/digest.mjs';
import {
  assertCommitRef,
  commitEpochSeconds,
  expandAllowlistPaths,
  readAllowlistFromCommit,
  readBlob,
  readPackageJsonAtCommit,
  readSourceAllowlistAtCommit,
  resolveCommit,
  treeDigest,
} from './lib/git.mjs';
import {
  SOURCE_PROVENANCE_PATH,
  buildSourceProvenanceText,
  inheritPrivateSourceCommit,
  parseSourceProvenance,
} from './lib/provenance.mjs';
import {
  assertSourceManifestBinding,
  buildSourceManifest,
  canonicalSourceManifestText,
  publishImmutableSourcePair,
  stableSourceArtifactFilename,
  stableSourceManifestFilename,
  stableSourceReleaseDirname,
} from './lib/source-manifest.mjs';
import { assertCanonicalReleaseToolchain, createDeterministicSourceTarball, stageSourceTree } from './lib/tarball.mjs';
import {
  expandAllowlistPathsFromTree,
  hasGitMetadata,
  treeDigestFromTree,
} from './lib/tree.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Order-independent JSON encoding, used only to compare two allowlists.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @param {string} repoRoot
 * @param {string} [commitRef]
 * @returns {{ commit: string, allowlist: object, fromTree: boolean }}
 */
export function resolveSourceExport(repoRoot, commitRef) {
  assertCommitRef(commitRef);
  if (!hasGitMetadata(repoRoot)) {
    const allowlist = JSON.parse(readFileSync(join(repoRoot, 'release/source-allowlist.json'), 'utf8'));
    expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
    const provenance = parseSourceProvenance(readFileSync(join(repoRoot, SOURCE_PROVENANCE_PATH), 'utf8'));
    return { commit: provenance.current_source_commit, allowlist, fromTree: true };
  }
  const commit = resolveCommit(repoRoot, commitRef ?? 'HEAD');
  const allowlist = readSourceAllowlistAtCommit(repoRoot, commit);
  expandAllowlistPaths(repoRoot, commit, allowlist.paths);
  return { commit, allowlist, fromTree: false };
}

/**
 * Build one immutable public-source export from a single Git commit.
 *
 * Generated `release/source-provenance.json` is rewritten on each export. An
 * already-exported provenance blob is read first so `private_source_commit`
 * stays the original private lineage after a later public `git init`.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {string} [options.commit]
 * @param {object} [options.allowlist]
 * @param {string} [options.outDir]
 */
export function buildSourceExport({
  repoRoot = defaultRepoRoot,
  commit,
  allowlist,
  outDir = join(repoRoot, 'dist'),
} = {}) {
  assertCanonicalReleaseToolchain();
  if (!hasGitMetadata(repoRoot)) {
    throw new Error('source export requires a Git commit; initialize a public repository from the extracted tree first');
  }
  const resolvedCommit = resolveCommit(repoRoot, commit ?? 'HEAD');
  const resolvedAllowlist = readSourceAllowlistAtCommit(repoRoot, resolvedCommit);
  if (allowlist !== undefined && canonicalJson(allowlist) !== canonicalJson(resolvedAllowlist)) {
    throw new Error(
      `caller allowlist does not match the source allowlist committed at ${resolvedCommit}; `
      + 'the export source cannot be widened through build options',
    );
  }
  const pkg = readPackageJsonAtCommit(repoRoot, resolvedCommit);
  const version = pkg.version;
  const artifactName = stableSourceArtifactFilename(version);
  const manifestName = stableSourceManifestFilename(version);
  const releaseDir = join(outDir, stableSourceReleaseDirname(version));
  const artifactPath = join(releaseDir, artifactName);
  const manifestPath = join(releaseDir, manifestName);
  const artifactCoordinate = `source:@inspr/aithema-core@${version}.tgz`;

  const paths = expandAllowlistPaths(repoRoot, resolvedCommit, resolvedAllowlist.paths);
  for (const path of paths) {
    for (const pattern of resolvedAllowlist.forbidden_patterns) {
      if (new RegExp(pattern).test(path)) {
        throw new Error(`allowlisted path matches forbidden pattern ${pattern}: ${path}`);
      }
    }
  }

  const files = new Map();
  for (const path of paths) {
    files.set(path, readBlob(repoRoot, resolvedCommit, path));
  }

  const existingProvenance = files.get(SOURCE_PROVENANCE_PATH);
  const lineage = inheritPrivateSourceCommit(existingProvenance ?? null, resolvedCommit);
  const runtimeAllowlist = readAllowlistFromCommit(repoRoot, resolvedCommit, 'release/allowlist.json');
  const runtimePaths = expandAllowlistPaths(repoRoot, resolvedCommit, runtimeAllowlist.paths);
  const runtimeTreeDigest = treeDigest(repoRoot, resolvedCommit, runtimePaths);
  const lockDigest = `sha256:${sha256(files.get('package-lock.json'))}`;
  const mtimeEpoch = commitEpochSeconds(repoRoot, resolvedCommit);
  files.set(
    SOURCE_PROVENANCE_PATH,
    Buffer.from(buildSourceProvenanceText({
      privateSourceCommit: lineage.privateSourceCommit,
      currentSourceCommit: lineage.currentSourceCommit,
      exportMtimeEpoch: mtimeEpoch,
      runtimeTreeDigest,
      lockDigest,
    }), 'utf8'),
  );
  const exportPaths = [...files.keys()].sort((a, b) => a.localeCompare(b));

  const stageRoot = mkdtempSync(join(tmpdir(), 'aithema-source-stage-'));
  const sourceRoot = stageSourceTree(stageRoot, files);
  const sourceTreeDigest = treeDigestFromTree(sourceRoot, exportPaths);
  const probePath = join(stageRoot, 'probe-source.tgz');
  createDeterministicSourceTarball(sourceRoot, probePath, mtimeEpoch);
  const artifactBytes = readFileSync(probePath);
  const artifactSha256 = sha256(artifactBytes);

  const manifest = buildSourceManifest({
    privateSourceCommit: lineage.privateSourceCommit,
    currentSourceCommit: lineage.currentSourceCommit,
    treeDigest: sourceTreeDigest,
    lockDigest,
    version,
    versionScheme: 'legacy-semver-private',
    releaseChannel: 'public-source-candidate',
    artifactCoordinate,
    artifactPath: artifactName,
    artifactSha256,
    pathCount: exportPaths.length,
  });
  assertSourceManifestBinding(manifest);
  const manifestText = canonicalSourceManifestText(manifest);

  const publication = publishImmutableSourcePair({
    releaseDir,
    artifactName,
    artifactBytes,
    manifestName,
    manifestText,
    artifactCoordinate,
  });

  return {
    releaseDir,
    artifactPath,
    manifestPath,
    manifest,
    manifestText,
    artifactSha256,
    artifactBytes,
    paths: exportPaths,
    commit: lineage.currentSourceCommit,
    publication,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit') options.commit = argv[++index];
    else if (arg === '--out-dir') options.outDir = resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node release/build-source.mjs [--commit <ref>] [--out-dir <path>]\n');
    process.exit(0);
  }
  const source = resolveSourceExport(defaultRepoRoot, args.commit);
  const result = buildSourceExport({
    repoRoot: defaultRepoRoot,
    commit: source.fromTree ? undefined : source.commit,
    allowlist: source.allowlist,
    outDir: args.outDir ?? join(defaultRepoRoot, 'dist'),
  });
  process.stdout.write(`${JSON.stringify({
    private_source_commit: result.manifest.source.private_source_commit,
    current_source_commit: result.manifest.source.current_source_commit,
    release_dir: result.releaseDir,
    publication: result.publication.status,
    artifact: result.manifest.artifacts[0],
    tree_digest: result.manifest.source.tree_digest,
    lock_digest: result.manifest.source.lock_digest,
    path_count: result.manifest.source.path_count,
  }, null, 2)}\n`);
}
