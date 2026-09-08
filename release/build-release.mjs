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
  readAllowlistAtCommit,
  readBlob,
  readPackageJsonAtCommit,
  resolveCommit,
  treeDigest,
} from './lib/git.mjs';
import {
  assertManifestBinding,
  buildManifest,
  canonicalManifestText,
  publishImmutableReleasePair,
  stableArtifactFilename,
  stableManifestFilename,
  stableReleaseDirname,
} from './lib/manifest.mjs';
import {
  SOURCE_PROVENANCE_PATH,
  assertRuntimeProvenanceBinding,
  parseSourceProvenance,
} from './lib/provenance.mjs';
import { assertCanonicalReleaseToolchain, createDeterministicTarball, stagePackageTree } from './lib/tarball.mjs';
import {
  expandAllowlistPathsFromTree,
  hasGitMetadata,
  readTreeFile,
  treeDigestFromEntries,
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
export function resolveReleaseSource(repoRoot, commitRef) {
  assertCommitRef(commitRef);
  if (!hasGitMetadata(repoRoot)) {
    const allowlist = JSON.parse(readFileSync(join(repoRoot, 'release/allowlist.json'), 'utf8'));
    expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
    const provenance = parseSourceProvenance(readFileSync(join(repoRoot, SOURCE_PROVENANCE_PATH), 'utf8'));
    return { commit: provenance.current_source_commit, allowlist, fromTree: true };
  }
  const commit = resolveCommit(repoRoot, commitRef ?? 'HEAD');
  const allowlist = readAllowlistAtCommit(repoRoot, commit);
  expandAllowlistPaths(repoRoot, commit, allowlist.paths);
  return { commit, allowlist, fromTree: false };
}

/**
 * @param {object} options
 */
function buildReleaseFromTree({
  repoRoot,
  allowlist,
  outDir,
  provenance,
}) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const version = pkg.version;
  const artifactName = stableArtifactFilename(version);
  const manifestName = stableManifestFilename(version);
  const releaseDir = join(outDir, stableReleaseDirname(version));
  const artifactPath = join(releaseDir, artifactName);
  const manifestPath = join(releaseDir, manifestName);
  const artifactCoordinate = `npm:@inspr/aithema-core@${version}.tgz`;

  const paths = expandAllowlistPathsFromTree(repoRoot, allowlist.paths);
  for (const path of paths) {
    for (const pattern of allowlist.forbidden_patterns) {
      if (new RegExp(pattern).test(path)) {
        throw new Error(`allowlisted path matches forbidden pattern ${pattern}: ${path}`);
      }
    }
  }

  const files = new Map();
  for (const path of paths) {
    files.set(path, readTreeFile(repoRoot, path));
  }

  const lockDigest = `sha256:${sha256(files.get('package-lock.json'))}`;
  const sourceTreeDigest = treeDigestFromEntries(files);
  assertRuntimeProvenanceBinding(provenance, { treeDigest: sourceTreeDigest, lockDigest });
  // Frozen runtime schema 0.1 has one source.commit: the Git commit actually
  // exported (current_source_commit). private_source_commit stays in provenance.
  const currentCommit = provenance.current_source_commit;
  const stageRoot = mkdtempSync(join(tmpdir(), 'aithema-release-stage-'));
  const packageRoot = stagePackageTree(stageRoot, files);
  const probePath = join(stageRoot, 'probe.tgz');
  createDeterministicTarball(packageRoot, probePath, provenance.export_mtime_epoch);
  const artifactBytes = readFileSync(probePath);
  const artifactSha256 = sha256(artifactBytes);

  const manifest = buildManifest({
    commit: currentCommit,
    treeDigest: sourceTreeDigest,
    lockDigest,
    version,
    versionScheme: 'legacy-semver-private',
    releaseChannel: 'private-source',
    artifactCoordinate,
    artifactPath: artifactName,
    artifactSha256,
  });
  assertManifestBinding(manifest);
  const manifestText = canonicalManifestText(manifest);

  const publication = publishImmutableReleasePair({
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
    paths,
    commit: currentCommit,
    publication,
  };
}

/**
 * Build one immutable release from a single Git commit.
 *
 * `commit` may be any ref (`HEAD`, a branch, a tag); it is always resolved to
 * the commit object id that the manifest records. The allowlist is always read
 * from that commit, so no caller option can widen the exported source: a
 * supplied allowlist is only accepted as an equality assertion.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {string} [options.commit]
 * @param {object} [options.allowlist]
 * @param {string} [options.outDir]
 */
export function buildRelease({
  repoRoot = defaultRepoRoot,
  commit,
  allowlist,
  outDir = join(repoRoot, 'dist'),
} = {}) {
  assertCanonicalReleaseToolchain();
  if (!hasGitMetadata(repoRoot)) {
    const resolvedAllowlist = JSON.parse(readFileSync(join(repoRoot, 'release/allowlist.json'), 'utf8'));
    if (allowlist !== undefined && canonicalJson(allowlist) !== canonicalJson(resolvedAllowlist)) {
      throw new Error('caller allowlist does not match release/allowlist.json on disk');
    }
    const provenance = parseSourceProvenance(readFileSync(join(repoRoot, SOURCE_PROVENANCE_PATH), 'utf8'));
    if (commit !== undefined && commit !== provenance.current_source_commit) {
      throw new Error(
        'caller commit does not match current_source_commit in provenance; '
        + 'runtime source.commit binds the exported Git commit, not private lineage',
      );
    }
    return buildReleaseFromTree({
      repoRoot,
      allowlist: resolvedAllowlist,
      outDir,
      provenance,
    });
  }

  const resolvedCommit = resolveCommit(repoRoot, commit ?? 'HEAD');
  const resolvedAllowlist = readAllowlistAtCommit(repoRoot, resolvedCommit);
  if (allowlist !== undefined && canonicalJson(allowlist) !== canonicalJson(resolvedAllowlist)) {
    throw new Error(
      `caller allowlist does not match the allowlist committed at ${resolvedCommit}; `
      + 'the release source cannot be widened through build options',
    );
  }
  const pkg = readPackageJsonAtCommit(repoRoot, resolvedCommit);
  const version = pkg.version;
  const artifactName = stableArtifactFilename(version);
  const manifestName = stableManifestFilename(version);
  const releaseDir = join(outDir, stableReleaseDirname(version));
  const artifactPath = join(releaseDir, artifactName);
  const manifestPath = join(releaseDir, manifestName);
  const artifactCoordinate = `npm:@inspr/aithema-core@${version}.tgz`;

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

  const lockDigest = `sha256:${sha256(files.get('package-lock.json'))}`;
  const sourceTreeDigest = treeDigest(repoRoot, resolvedCommit, paths);
  const stageRoot = mkdtempSync(join(tmpdir(), 'aithema-release-stage-'));
  const packageRoot = stagePackageTree(stageRoot, files);
  const mtimeEpoch = commitEpochSeconds(repoRoot, resolvedCommit);
  const probePath = join(stageRoot, 'probe.tgz');
  createDeterministicTarball(packageRoot, probePath, mtimeEpoch);
  const artifactBytes = readFileSync(probePath);
  const artifactSha256 = sha256(artifactBytes);

  const manifest = buildManifest({
    commit: resolvedCommit,
    treeDigest: sourceTreeDigest,
    lockDigest,
    version,
    versionScheme: 'legacy-semver-private',
    releaseChannel: 'private-source',
    artifactCoordinate,
    artifactPath: artifactName,
    artifactSha256,
  });
  assertManifestBinding(manifest);
  const manifestText = canonicalManifestText(manifest);

  const publication = publishImmutableReleasePair({
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
    paths,
    commit: resolvedCommit,
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
    process.stdout.write('Usage: node release/build-release.mjs [--commit <ref>] [--out-dir <path>]\n');
    process.exit(0);
  }
  const source = resolveReleaseSource(defaultRepoRoot, args.commit);
  const result = buildRelease({
    repoRoot: defaultRepoRoot,
    commit: source.commit,
    allowlist: source.allowlist,
    outDir: args.outDir ?? join(defaultRepoRoot, 'dist'),
  });
  process.stdout.write(`${JSON.stringify({
    commit: result.commit,
    release_dir: result.releaseDir,
    publication: result.publication.status,
    artifact: result.manifest.artifacts[0],
    tree_digest: result.manifest.source.tree_digest,
    lock_digest: result.manifest.source.lock_digest,
  }, null, 2)}\n`);
}
