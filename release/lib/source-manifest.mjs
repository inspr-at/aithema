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
export function stableSourceArtifactFilename(version) {
  return `inspr-aithema-core-source-${version}.tgz`;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function stableSourceManifestFilename(version) {
  return `inspr-aithema-core-source-${version}.manifest.json`;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function stableSourceReleaseDirname(version) {
  return `inspr-aithema-core-source-${version}`;
}

/**
 * @param {object} input
 * @returns {object}
 */
export function buildSourceManifest({
  privateSourceCommit,
  currentSourceCommit,
  treeDigest,
  lockDigest,
  version,
  versionScheme,
  releaseChannel,
  artifactCoordinate,
  artifactPath,
  artifactSha256,
  pathCount,
}) {
  if (typeof privateSourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(privateSourceCommit)) {
    throw new Error(
      `source manifest private provenance commit must be a full commit object id, got ${privateSourceCommit}`,
    );
  }
  if (typeof currentSourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(currentSourceCommit)) {
    throw new Error(
      `source manifest current source commit must be a full commit object id, got ${currentSourceCommit}`,
    );
  }
  return {
    schema: 'aithema-source-manifest/0.1',
    version_scheme: versionScheme,
    version,
    private: true,
    release_channel: releaseChannel,
    source: {
      private_source_commit: privateSourceCommit,
      current_source_commit: currentSourceCommit,
      tree_digest: treeDigest,
      lock_digest: lockDigest,
      path_count: pathCount,
      normalization_note:
        'Exported tree digest is content-addressed from the allowlisted inventory; '
        + 'it is not identical to the private Git tree object id. '
        + 'private_source_commit is original lineage; current_source_commit is the exported Git commit.',
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
export function canonicalSourceManifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * @param {object} manifest
 */
export function assertSourceManifestBinding(manifest) {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
    throw new Error('source manifest must list exactly one export artifact');
  }
  const [artifact] = manifest.artifacts;
  if (!artifact.coordinate?.endsWith('.tgz')) {
    throw new Error('source manifest artifact coordinate must reference the export tarball');
  }
  if (!artifact.sha256?.startsWith('sha256:')) {
    throw new Error('source manifest artifact digest must be sha256-prefixed');
  }
  if (typeof artifact.path !== 'string' || !artifact.path) {
    throw new Error('source manifest artifact path must be a non-empty string');
  }
  if (artifact.path.includes('/') || artifact.path.includes('\\')) {
    throw new Error('source manifest artifact path must be coordinate-relative');
  }
  if (!manifest.source?.private_source_commit) {
    throw new Error('source manifest must record private_source_commit provenance');
  }
  if (!manifest.source?.current_source_commit) {
    throw new Error('source manifest must record current_source_commit');
  }
  if (!manifest.source?.tree_digest?.startsWith('sha256:')) {
    throw new Error('source manifest must record a sha256 tree digest');
  }
}

/**
 * @param {string} filePath
 * @returns {import('node:fs').Stats | null}
 */
function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath);
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
    throw new Error(`source export output must not follow symlinks: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`source export output must be a regular file: ${filePath}`);
  }
  return readFileSync(filePath);
}

/**
 * @param {string} releaseDir
 * @param {string} manifestName
 */
export function verifySourceReleasePair(releaseDir, manifestName) {
  const manifestPath = join(releaseDir, manifestName);
  const manifestBytes = readRegularFileOrNull(manifestPath);
  if (manifestBytes === null) {
    throw new Error(`no source manifest to verify at ${manifestPath}`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertSourceManifestBinding(manifest);
  const [artifact] = manifest.artifacts;
  const artifactPath = join(releaseDir, artifact.path);
  const artifactBytes = readRegularFileOrNull(artifactPath);
  if (artifactBytes === null) {
    throw new Error(`no source artifact to verify at ${artifactPath}`);
  }
  const actual = sha256Prefixed(sha256File(artifactPath));
  if (actual !== artifact.sha256) {
    throw new Error(
      `published source artifact digest mismatch at ${artifact.coordinate}: ${actual} != ${artifact.sha256}`,
    );
  }
  return { manifest, artifactPath, sha256: actual };
}

/**
 * @param {string} releaseDir
 * @param {string} artifactName
 * @param {string} manifestName
 */
function inspectSourceReleaseDir(releaseDir, artifactName, manifestName) {
  const stat = lstatOrNull(releaseDir);
  if (stat === null) return { state: 'absent' };
  if (stat.isSymbolicLink()) {
    throw new Error(`source export output must not follow symlinks: ${releaseDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`source export coordinate is occupied by a non-directory: ${releaseDir}`);
  }
  const artifact = readRegularFileOrNull(join(releaseDir, artifactName));
  const manifest = readRegularFileOrNull(join(releaseDir, manifestName));
  if (artifact === null && manifest === null) {
    const entries = readdirSync(releaseDir);
    if (entries.length) {
      throw new Error(
        `source export coordinate directory holds unrelated files, refusing to publish into it: ${releaseDir}`,
      );
    }
    return { state: 'empty' };
  }
  if (artifact === null || manifest === null) {
    throw new Error(
      `refusing to leave mismatched source artifact/manifest pair at ${releaseDir}: `
      + 'move the incomplete directory aside (trash it) and rebuild',
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
    throw new Error(`refusing to overwrite non-identical source artifact at ${artifactCoordinate}`);
  }
  if (published.manifest !== manifestText) {
    throw new Error(`refusing to overwrite non-identical source manifest at ${artifactCoordinate}`);
  }
}

/**
 * @param {string} stageDir
 * @returns {string | null}
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
 * @param {object} input
 */
export function publishImmutableSourcePair({
  releaseDir,
  artifactName,
  artifactBytes,
  manifestName,
  manifestText,
  artifactCoordinate,
}) {
  const outDir = dirname(releaseDir);
  const existing = inspectSourceReleaseDir(releaseDir, artifactName, manifestName);
  if (existing.state === 'published') {
    assertIdenticalPublication(existing, artifactBytes, manifestText, artifactCoordinate);
    verifySourceReleasePair(releaseDir, manifestName);
    return { status: 'identical', releaseDir, concurrent: false, residue: null };
  }

  mkdirSync(outDir, { recursive: true });
  const stageDir = mkdtempSync(join(outDir, '.publish-source-'));
  try {
    writeFileSync(join(stageDir, artifactName), artifactBytes);
    writeFileSync(join(stageDir, manifestName), manifestText, 'utf8');
    verifySourceReleasePair(stageDir, manifestName);
  } catch (error) {
    throw withResidue(error, discardStage(stageDir));
  }

  try {
    renameSync(stageDir, releaseDir);
  } catch (error) {
    if (!OCCUPIED_TARGET_CODES.has(error?.code)) {
      throw withResidue(error, discardStage(stageDir));
    }
    try {
      const winner = inspectSourceReleaseDir(releaseDir, artifactName, manifestName);
      if (winner.state !== 'published') {
        throw new Error(`source export coordinate ${releaseDir} could not be claimed and holds no published pair`);
      }
      assertIdenticalPublication(winner, artifactBytes, manifestText, artifactCoordinate);
      verifySourceReleasePair(releaseDir, manifestName);
    } catch (conflict) {
      throw withResidue(conflict, discardStage(stageDir));
    }
    return { status: 'identical', releaseDir, concurrent: true, residue: discardStage(stageDir) };
  }

  verifySourceReleasePair(releaseDir, manifestName);
  return { status: 'published', releaseDir, concurrent: false, residue: null };
}
