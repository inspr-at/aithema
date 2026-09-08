import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { gitBlobSha1 } from './digest.mjs';
import { validateArchivePath } from './git.mjs';

/**
 * @param {string} root
 * @param {string} relPath
 * @returns {import('node:fs').Stats}
 */
function lstatRelative(root, relPath) {
  validateArchivePath(relPath);
  const full = join(root, relPath);
  try {
    return lstatSync(full);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`allowlisted path missing on disk: ${relPath}`);
    }
    throw error;
  }
}

/**
 * @param {string} root
 * @param {string} relPath
 */
function assertRegularFile(root, relPath) {
  const stat = lstatRelative(root, relPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`allowlisted symlink rejected: ${relPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`allowlisted path is not a regular file: ${relPath}`);
  }
}

/**
 * @param {string} root
 * @param {string} prefix
 * @returns {string[]}
 */
function listFilesUnderPrefix(root, prefix) {
  const normalized = prefix.replace(/\/$/, '');
  const base = join(root, normalized);
  const out = [];
  const walk = (dir, relDir) => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      const full = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`allowlisted symlink rejected: ${rel}`);
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`allowlisted path has unsupported file type: ${rel}`);
      }
      out.push(rel);
    }
  };
  walk(base, normalized);
  return out;
}

/**
 * @param {string} root
 * @param {string[]} allowlistPaths
 * @returns {string[]}
 */
export function expandAllowlistPathsFromTree(root, allowlistPaths) {
  const files = new Set();
  for (const entry of allowlistPaths) {
    validateArchivePath(entry.replace(/\/$/, ''));
    if (entry.includes('..')) {
      throw new Error(`allowlist path traversal rejected: ${entry}`);
    }
    const normalized = entry.replace(/\/$/, '');
    if (!normalized) continue;
    if (entry.endsWith('/')) {
      const listing = listFilesUnderPrefix(root, normalized);
      if (!listing.length) {
        throw new Error(`allowlisted directory missing on disk: ${normalized}/`);
      }
      for (const path of listing) files.add(path);
      continue;
    }
    const stat = lstatRelative(root, normalized);
    if (stat.isDirectory()) {
      for (const path of listFilesUnderPrefix(root, normalized)) files.add(path);
      continue;
    }
    assertRegularFile(root, normalized);
    files.add(normalized);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} root
 * @param {string} path
 * @returns {Buffer}
 */
export function readTreeFile(root, path) {
  assertRegularFile(root, path);
  return readFileSync(join(root, path));
}

/**
 * AIT-10 runtime tree digest: `path\\t<git blob sha1>` over the allowlisted
 * inventory. Tree-mode uses the same blob-id algorithm as `git hash-object`.
 * @param {Iterable<[string, Buffer]>} entries
 * @returns {string}
 */
export function treeDigestFromEntries(entries) {
  const lines = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${path}\t${gitBlobSha1(content)}`);
  return `sha256:${createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')}`;
}

/**
 * Runtime/source tree digest from a materialized directory.
 * @param {string} root
 * @param {string[]} paths
 * @returns {string}
 */
export function treeDigestFromTree(root, paths) {
  return treeDigestFromEntries(paths.map((path) => [path, readTreeFile(root, path)]));
}

/**
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function hasGitMetadata(repoRoot) {
  try {
    const stat = lstatSync(join(repoRoot, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
