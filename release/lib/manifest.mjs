import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256File, sha256Prefixed } from './digest.mjs';

/** Rename failures that mean "another publisher already owns this coordinate". */
const OCCUPIED_TARGET_CODES = new Set(['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR']);

/**
 * @param {string} version
 * @returns {string}
 */
export function stableArtifactFilename(version) {
  return `inspr-aithema-core-${version}.tgz`;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function stableManifestFilename(version) {
  return `inspr-aithema-core-${version}.manifest.json`;
}

/**
 * One release coordinate is one directory. The artifact and its manifest are
 * published together by a single directory rename, so a reader never observes
 * one without the other.
 * @param {string} version
 * @returns {string}
 */
export function stableReleaseDirname(version) {
  return `inspr-aithema-core-${version}`;
}

/**
 * @param {object} input
 * @returns {object}
 */
export function buildManifest({
  commit,
  treeDigest,
  lockDigest,
  version,
  versionScheme,
  releaseChannel,
  artifactCoordinate,
  artifactPath,
  artifactSha256,
}) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) {
    throw new Error(`manifest source commit must be a full commit object id, got ${commit}`);
  }
  return {
    schema: 'aithema-release-manifest/0.1',
    version_scheme: versionScheme,
    version,
    private: true,
    release_channel: releaseChannel,
    source: {
      commit,
      tree_digest: treeDigest,
      lock_digest: lockDigest,
    },
    artifacts: [
      {
        coordinate: artifactCoordinate,
        path: artifactPath,
        sha256: sha256Prefixed(artifactSha256),
      },
    ],
  };
}

/**
 * @param {object} manifest
 * @returns {string}
 */
export function canonicalManifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Manifest sidecar binds only the release artifact, never itself (no circular self-hash).
 * @param {object} manifest
 */
export function assertManifestBinding(manifest) {
  if (manifest.schema !== 'aithema-release-manifest/0.1') {
    throw new Error('runtime manifest schema must be aithema-release-manifest/0.1');
  }
  const sourceKeys = Object.keys(manifest.source || {}).sort();
  if (sourceKeys.join(',') !== 'commit,lock_digest,tree_digest') {
    throw new Error(
      'runtime manifest source must stay commit, tree_digest, lock_digest under frozen schema 0.1',
    );
  }
  if (typeof manifest.source.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.source.commit)) {
    throw new Error('runtime manifest source.commit must be a 40-character lowercase commit object id');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
    throw new Error('manifest must list exactly one release artifact');
  }
  const [artifact] = manifest.artifacts;
  if (!artifact.coordinate?.endsWith('.tgz')) {
    throw new Error('manifest artifact coordinate must reference the release tarball');
  }
  if (!artifact.sha256?.startsWith('sha256:')) {
    throw new Error('manifest artifact digest must be sha256-prefixed');
  }
  if (typeof artifact.path !== 'string' || !artifact.path) {
    throw new Error('manifest artifact path must be a non-empty string');
  }
  if (artifact.path.includes('/') || artifact.path.includes('\\')) {
    throw new Error('manifest artifact path must be coordinate-relative');
  }
  if (artifact.path === '.' || artifact.path === '..' || artifact.path.startsWith('-') || artifact.path.includes('\0')) {
    throw new Error(`manifest artifact path is not a plain file name: ${artifact.path}`);
  }
}

/**
 * lstat a release output path without ever following a symlink into it.
 * @param {string} targetPath
 * @returns {import('node:fs').Stats | null}
 */
function lstatOrNull(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} filePath
 * @returns {Buffer | null}
 */
function readRegularFileOrNull(filePath) {
  const stat = lstatOrNull(filePath);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) {
    throw new Error(`release output must not follow symlinks: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`release output must be a regular file: ${filePath}`);
  }
  return readFileSync(filePath);
}

/**
 * Re-hash a published release directory against its own manifest.
 * @param {string} releaseDir
 * @param {string} manifestName
 * @returns {{ manifest: object, artifactPath: string, sha256: string }}
 */
export function verifyReleasePair(releaseDir, manifestName) {
  const manifestPath = join(releaseDir, manifestName);
  const manifestBytes = readRegularFileOrNull(manifestPath);
  if (manifestBytes === null) {
    throw new Error(`no release manifest to verify at ${manifestPath}`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertManifestBinding(manifest);
  const [artifact] = manifest.artifacts;
  const artifactPath = join(releaseDir, artifact.path);
  const artifactBytes = readRegularFileOrNull(artifactPath);
  if (artifactBytes === null) {
    throw new Error(`no release artifact to verify at ${artifactPath}`);
  }
  const actual = sha256Prefixed(sha256File(artifactPath));
  if (actual !== artifact.sha256) {
    throw new Error(
      `published artifact digest mismatch at ${artifact.coordinate}: ${actual} != ${artifact.sha256}`,
    );
  }
  return { manifest, artifactPath, sha256: actual };
}

/**
 * Inspect an existing release coordinate without following symlinks.
 * @param {string} releaseDir
 * @param {string} artifactName
 * @param {string} manifestName
 * @returns {{ state: 'absent' | 'empty' | 'published', artifact?: Buffer, manifest?: string }}
 */
function inspectReleaseDir(releaseDir, artifactName, manifestName) {
  const stat = lstatOrNull(releaseDir);
  if (stat === null) return { state: 'absent' };
  if (stat.isSymbolicLink()) {
    throw new Error(`release output must not follow symlinks: ${releaseDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`release coordinate is occupied by a non-directory: ${releaseDir}`);
  }
  const artifact = readRegularFileOrNull(join(releaseDir, artifactName));
  const manifest = readRegularFileOrNull(join(releaseDir, manifestName));
  if (artifact === null && manifest === null) {
    const entries = readdirSync(releaseDir);
    if (entries.length) {
      throw new Error(
        `release coordinate directory holds unrelated files, refusing to publish into it: ${releaseDir}`,
      );
    }
    return { state: 'empty' };
  }
  if (artifact === null || manifest === null) {
    throw new Error(
      `refusing to leave mismatched artifact/manifest pair at ${releaseDir}: `
      + `move the incomplete directory aside (trash it) and rebuild`,
    );
  }
  return { state: 'published', artifact, manifest: manifest.toString('utf8') };
}

/**
 * @param {{ artifact: Buffer, manifest: string }} published
 * @param {Buffer} artifactBytes
 * @param {string} manifestText
 * @param {string} artifactCoordinate
 */
function assertIdenticalPublication(published, artifactBytes, manifestText, artifactCoordinate) {
  if (!published.artifact.equals(artifactBytes)) {
    throw new Error(`refusing to overwrite non-identical artifact at ${artifactCoordinate}`);
  }
  if (published.manifest !== manifestText) {
    throw new Error(`refusing to overwrite non-identical manifest at ${artifactCoordinate}`);
  }
}

/**
 * Discard our own staging directory. Deletes go through `trash` only; there is
 * no rm/unlink fallback, so a failed discard is reported as residue instead.
 * @param {string} stageDir
 * @returns {string | null} residue path when the discard did not happen
 */
function discardStage(stageDir) {
  try {
    execFileSync('trash', [stageDir], { stdio: ['ignore', 'ignore', 'ignore'] });
    return null;
  } catch {
    return stageDir;
  }
}

/**
 * @param {unknown} error
 * @param {string | null} residue
 */
function withResidue(error, residue) {
  if (!residue) return error;
  const augmented = new Error(`${error instanceof Error ? error.message : String(error)} (staging residue left at ${residue})`);
  augmented.cause = error;
  return augmented;
}

/**
 * Publish one immutable release coordinate as a single directory.
 *
 * The pair is staged in a sibling temp directory and committed with exactly one
 * `rename(2)` of that directory. A directory rename onto a populated directory
 * fails, so publication is no-replace: a concurrent builder with different bytes
 * loses the race and raises, and a byte-identical repeat is idempotent. A crash
 * before the rename leaves the coordinate absent, never half-published.
 *
 * @param {object} input
 * @param {string} input.releaseDir
 * @param {string} input.artifactName
 * @param {Buffer} input.artifactBytes
 * @param {string} input.manifestName
 * @param {string} input.manifestText
 * @param {string} input.artifactCoordinate
 * @returns {{ status: 'published' | 'identical', releaseDir: string, concurrent: boolean, residue: string | null }}
 */
export function publishImmutableReleasePair({
  releaseDir,
  artifactName,
  artifactBytes,
  manifestName,
  manifestText,
  artifactCoordinate,
}) {
  const outDir = dirname(releaseDir);
  const existing = inspectReleaseDir(releaseDir, artifactName, manifestName);
  if (existing.state === 'published') {
    assertIdenticalPublication(existing, artifactBytes, manifestText, artifactCoordinate);
    verifyReleasePair(releaseDir, manifestName);
    return { status: 'identical', releaseDir, concurrent: false, residue: null };
  }

  mkdirSync(outDir, { recursive: true });
  const stageDir = mkdtempSync(join(outDir, '.publish-'));
  try {
    writeFileSync(join(stageDir, artifactName), artifactBytes);
    writeFileSync(join(stageDir, manifestName), manifestText, 'utf8');
    verifyReleasePair(stageDir, manifestName);
  } catch (error) {
    throw withResidue(error, discardStage(stageDir));
  }

  try {
    renameSync(stageDir, releaseDir);
  } catch (error) {
    if (!OCCUPIED_TARGET_CODES.has(error?.code)) {
      throw withResidue(error, discardStage(stageDir));
    }
    // A concurrent publisher committed first. Its bytes win; ours must match.
    try {
      const winner = inspectReleaseDir(releaseDir, artifactName, manifestName);
      if (winner.state !== 'published') {
        throw new Error(`release coordinate ${releaseDir} could not be claimed and holds no published pair`);
      }
      assertIdenticalPublication(winner, artifactBytes, manifestText, artifactCoordinate);
      verifyReleasePair(releaseDir, manifestName);
    } catch (conflict) {
      throw withResidue(conflict, discardStage(stageDir));
    }
    return { status: 'identical', releaseDir, concurrent: true, residue: discardStage(stageDir) };
  }

  verifyReleasePair(releaseDir, manifestName);
  return { status: 'published', releaseDir, concurrent: false, residue: null };
}
