import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {'utf8' | 'buffer'} [encoding]
 * @returns {string | Buffer}
 */
function git(repoRoot, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {string} path
 */
export function validateArchivePath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`invalid archive path: ${path}`);
  }
  if (path.includes('\0') || path.includes('\n') || path.includes('\r')) {
    throw new Error(`archive path contains control characters: ${path}`);
  }
  if (path.startsWith('-')) {
    throw new Error(`archive path looks like an option: ${path}`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`archive path must be relative: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`archive path traversal rejected: ${path}`);
  }
}

/**
 * @param {string} [ref]
 */
export function assertCommitRef(ref) {
  if (ref === undefined) return;
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) {
    throw new Error(`invalid commit ref: ${ref}`);
  }
}

/**
 * @param {string} repoRoot
 * @param {string} [ref]
 * @returns {string}
 */
export function resolveCommit(repoRoot, ref = 'HEAD') {
  assertCommitRef(ref);
  const commit = String(git(repoRoot, ['rev-parse', '--verify', ref], 'utf8')).trim();
  const type = String(git(repoRoot, ['cat-file', '-t', commit], 'utf8')).trim();
  if (type !== 'commit') {
    throw new Error(`release source must be a commit object, got ${type} for ${ref}`);
  }
  return commit;
}

/**
 * @typedef {{ mode: string, type: string, object: string, path: string }} TreeEntry
 */

/**
 * @param {string} repoRoot
 * @param {string} treeish
 * @param {string} [prefix]
 * @returns {TreeEntry[]}
 */
export function listTreeEntries(repoRoot, treeish, prefix = '') {
  const args = ['ls-tree', '-r', '-z', treeish];
  if (prefix) args.push('--', prefix);
  const raw = git(repoRoot, args, 'buffer');
  const entries = [];
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab);
    const path = record.slice(tab + 1);
    validateArchivePath(path);
    const parts = meta.split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`unexpected ls-tree metadata for ${path}`);
    }
    entries.push({
      mode: parts[0],
      type: parts[1],
      object: parts[2],
      path,
    });
  }
  return entries;
}

/**
 * @param {TreeEntry} entry
 */
function assertBlobEntry(entry) {
  if (entry.mode === '120000' || entry.type === 'link') {
    throw new Error(`allowlisted symlink rejected: ${entry.path}`);
  }
  if (entry.mode === '160000' || entry.type === 'commit') {
    throw new Error(`allowlisted gitlink rejected: ${entry.path}`);
  }
  if (entry.type === 'tree') {
    throw new Error(`allowlisted path is a directory tree entry, use trailing / in allowlist: ${entry.path}`);
  }
  if (entry.type !== 'blob') {
    throw new Error(`allowlisted path has unsupported git type ${entry.type}: ${entry.path}`);
  }
  if (!entry.mode.startsWith('100')) {
    throw new Error(`allowlisted path has non-file mode ${entry.mode}: ${entry.path}`);
  }
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string[]} allowlistPaths
 * @returns {string[]}
 */
export function expandAllowlistPaths(repoRoot, commit, allowlistPaths) {
  const files = new Set();
  for (const entry of allowlistPaths) {
    validateArchivePath(entry.replace(/\/$/, ''));
    if (entry.includes('..')) {
      throw new Error(`allowlist path traversal rejected: ${entry}`);
    }
    const normalized = entry.replace(/\/$/, '');
    if (!normalized) continue;
    if (entry.endsWith('/')) {
      const listing = listTreeEntries(repoRoot, commit, normalized);
      if (!listing.length) {
        throw new Error(`allowlisted directory missing at ${commit}: ${normalized}/`);
      }
      for (const item of listing) {
        assertBlobEntry(item);
        files.add(item.path);
      }
      continue;
    }
    const matches = listTreeEntries(repoRoot, commit, normalized).filter((item) => item.path === normalized);
    if (!matches.length) {
      throw new Error(`allowlisted path missing at ${commit}: ${normalized}`);
    }
    const [item] = matches;
    if (item.type === 'tree') {
      for (const child of listTreeEntries(repoRoot, commit, normalized)) {
        assertBlobEntry(child);
        files.add(child.path);
      }
      continue;
    }
    assertBlobEntry(item);
    files.add(normalized);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string} path
 * @returns {string}
 */
function gitBlobSha(repoRoot, commit, path) {
  const [item] = listTreeEntries(repoRoot, commit, path).filter((entry) => entry.path === path);
  if (!item) throw new Error(`missing git blob for ${path} at ${commit}`);
  assertBlobEntry(item);
  return item.object;
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string[]} paths
 * @returns {string}
 */
export function treeDigest(repoRoot, commit, paths) {
  const lines = paths.map((path) => `${path}\t${gitBlobSha(repoRoot, commit, path)}`);
  return `sha256:${createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')}`;
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string} path
 * @returns {Buffer}
 */
export function readBlob(repoRoot, commit, path) {
  validateArchivePath(path);
  const [item] = listTreeEntries(repoRoot, commit, path).filter((entry) => entry.path === path);
  if (!item) throw new Error(`missing git blob for ${path} at ${commit}`);
  assertBlobEntry(item);
  return execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Commit timestamp used as the deterministic mtime for every staged file.
 * Fails closed: a non-commit object or an unparseable epoch must never silently
 * become 0, which would produce a non-reproducible artifact under a manifest
 * whose source is not a commit.
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {number}
 */
export function commitEpochSeconds(repoRoot, commit) {
  const type = String(git(repoRoot, ['cat-file', '-t', commit], 'utf8')).trim();
  if (type !== 'commit') {
    throw new Error(`commit timestamp requires a commit object, got ${type} for ${commit}`);
  }
  const raw = String(git(repoRoot, ['show', '-s', '--format=%ct', commit], 'utf8')).trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`invalid commit epoch for ${commit}: ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid commit epoch for ${commit}: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * @param {unknown} allowlist
 * @param {string} label
 */
function assertAllowlistShape(allowlist, label) {
  if (!Array.isArray(allowlist?.paths) || !allowlist.paths.length) {
    throw new Error(`${label} must declare a non-empty paths array`);
  }
  if (!Array.isArray(allowlist.forbidden_patterns)) {
    throw new Error(`${label} must declare a forbidden_patterns array`);
  }
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string} allowlistPath
 * @returns {object}
 */
export function readAllowlistFromCommit(repoRoot, commit, allowlistPath) {
  const raw = readBlob(repoRoot, commit, allowlistPath);
  const allowlist = JSON.parse(raw.toString('utf8'));
  assertAllowlistShape(allowlist, `allowlist ${allowlistPath} at ${commit}`);
  return allowlist;
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {object}
 */
export function readAllowlistAtCommit(repoRoot, commit) {
  return readAllowlistFromCommit(repoRoot, commit, 'release/allowlist.json');
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {object}
 */
export function readSourceAllowlistAtCommit(repoRoot, commit) {
  return readAllowlistFromCommit(repoRoot, commit, 'release/source-allowlist.json');
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {object}
 */
export function readPackageJsonAtCommit(repoRoot, commit) {
  const raw = readBlob(repoRoot, commit, 'package.json');
  return JSON.parse(raw.toString('utf8'));
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function currentIndexTree(repoRoot) {
  return String(git(repoRoot, ['write-tree'], 'utf8')).trim();
}
