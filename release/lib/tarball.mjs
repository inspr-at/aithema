import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * @param {string} dir
 * @param {string} [base]
 * @returns {string[]}
 */
function listFilesSorted(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesSorted(full, base));
    else if (st.isFile()) out.push(relative(base, full));
  }
  return out;
}

/**
 * @param {string} root
 * @param {number} mtimeEpoch
 */
function normalizeTreeTimes(root, mtimeEpoch) {
  const when = new Date(mtimeEpoch * 1000);
  for (const rel of listFilesSorted(root)) {
    utimesSync(join(root, rel), when, when);
  }
  utimesSync(root, when, when);
}

/**
 * Stage allowlisted blobs under package/ with deterministic directory layout.
 * @param {string} stageRoot
 * @param {ReadonlyMap<string, Buffer>} files
 */
export function stagePackageTree(stageRoot, files) {
  const packageRoot = join(stageRoot, 'package');
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = join(packageRoot, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return packageRoot;
}

/**
 * Stage allowlisted blobs at the export root with deterministic directory layout.
 * @param {string} stageRoot
 * @param {ReadonlyMap<string, Buffer>} files
 */
export function stageSourceTree(stageRoot, files) {
  const sourceRoot = join(stageRoot, 'source');
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = join(sourceRoot, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return sourceRoot;
}

export const BSD_TAR_CREATE_FLAGS = [
  '--disable-copyfile',
  '--no-mac-metadata',
  '--no-xattrs',
  '--uid=0',
  '--gid=0',
];

/** GNU tar fallback used on Linux (ubuntu-latest) after BSD-only flags fail. */
export const GNU_TAR_FALLBACK_FLAGS = [
  '--create',
  '--format=gnu',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--no-recursion',
];

/**
 * Canonical artifact-producing toolchain for published bytes. Local BSD tar is
 * still used when present; GNU and BSD archives are not byte-identical.
 * Timestamp input is the Git committer epoch, reused by tree-mode from
 * provenance.export_mtime_epoch for the same current_source_commit.
 */
export const CANONICAL_ARTIFACT_TOOLCHAIN = {
  ci_runner: 'ubuntu-latest',
  node: '22',
  tar_family: 'gnu',
  tar_format: 'gnu',
  timestamp_policy: 'git-committer-epoch-seconds',
};

/**
 * @param {string} versionOutput `tar --version` text
 * @returns {'gnu' | 'bsd' | 'unknown'}
 */
export function identifyTarFamily(versionOutput) {
  const text = String(versionOutput);
  if (/\bGNU tar\b/i.test(text)) return 'gnu';
  if (/\bbsdtar\b/i.test(text) || /\bbsd tar\b/i.test(text) || /libarchive/i.test(text)) {
    return 'bsd';
  }
  return 'unknown';
}

/**
 * Enforce the declared CI toolchain only when the canonical release workflow
 * sets AITHEMA_CANONICAL_RELEASE=1. Local BSD tar builds stay valid and are
 * not claimed to be byte-identical to GNU tar archives.
 *
 * @param {object} [input]
 * @param {string} [input.tarVersionText]
 * @param {string} [input.nodeVersion]
 * @param {boolean} [input.requireCanonical]
 * @returns {{ enforced: boolean, tar_family?: string, node?: string, timestamp_policy: string }}
 */
export function assertCanonicalReleaseToolchain({
  tarVersionText,
  nodeVersion = process.versions.node,
  requireCanonical = process.env.AITHEMA_CANONICAL_RELEASE === '1',
} = {}) {
  const timestampPolicy = CANONICAL_ARTIFACT_TOOLCHAIN.timestamp_policy;
  if (!requireCanonical) {
    return { enforced: false, timestamp_policy: timestampPolicy };
  }
  const tarText = tarVersionText ?? execFileSync('tar', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tarFamily = identifyTarFamily(tarText);
  if (tarFamily !== CANONICAL_ARTIFACT_TOOLCHAIN.tar_family) {
    throw new Error(
      `canonical release requires ${CANONICAL_ARTIFACT_TOOLCHAIN.tar_family} tar, got ${tarFamily}`,
    );
  }
  const nodeMajor = String(nodeVersion).split('.')[0];
  if (nodeMajor !== CANONICAL_ARTIFACT_TOOLCHAIN.node) {
    throw new Error(
      `canonical release requires Node ${CANONICAL_ARTIFACT_TOOLCHAIN.node}, got ${nodeVersion}`,
    );
  }
  return {
    enforced: true,
    tar_family: tarFamily,
    node: String(nodeVersion),
    timestamp_policy: timestampPolicy,
  };
}

/**
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} input.listPath
 * @param {string} input.tarPath
 * @param {NodeJS.ProcessEnv} input.env
 */
function createArchiveFromFileList({ cwd, listPath, tarPath, env }) {
  try {
    execFileSync(
      'tar',
      ['-cf', tarPath, ...BSD_TAR_CREATE_FLAGS, '-T', listPath],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    execFileSync(
      'tar',
      [...GNU_TAR_FALLBACK_FLAGS, '--files-from', listPath, '-f', tarPath],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
}

/**
 * Create a deterministic gzip tarball from a staged package/ directory.
 * @param {string} packageRoot
 * @param {string} outputPath
 * @param {number} mtimeEpoch
 */
export function createDeterministicSourceTarball(sourceRoot, outputPath, mtimeEpoch) {
  const stageParent = dirname(sourceRoot);
  normalizeTreeTimes(sourceRoot, mtimeEpoch);
  const fileList = listFilesSorted(sourceRoot);
  const listPath = join(stageParent, 'source-tar-list.txt');
  const tarPath = join(stageParent, 'source.tar');
  writeFileSync(listPath, `${fileList.join('\n')}\n`, 'utf8');
  mkdirSync(dirname(outputPath), { recursive: true });
  const env = { ...process.env, COPYFILE_DISABLE: '1' };
  createArchiveFromFileList({ cwd: sourceRoot, listPath, tarPath, env });
  const archive = gzipSync(readFileSync(tarPath), { level: 9 });
  writeFileSync(outputPath, archive);
}

export function createDeterministicTarball(packageRoot, outputPath, mtimeEpoch) {
  const stageParent = dirname(packageRoot);
  normalizeTreeTimes(packageRoot, mtimeEpoch);
  const fileList = listFilesSorted(packageRoot).map((rel) => join('package', rel));
  const listPath = join(stageParent, 'tar-list.txt');
  const tarPath = join(stageParent, 'package.tar');
  writeFileSync(listPath, `${fileList.join('\n')}\n`, 'utf8');
  mkdirSync(dirname(outputPath), { recursive: true });
  const env = { ...process.env, COPYFILE_DISABLE: '1' };
  createArchiveFromFileList({ cwd: stageParent, listPath, tarPath, env });
  const archive = gzipSync(readFileSync(tarPath), { level: 9 });
  writeFileSync(outputPath, archive);
}
