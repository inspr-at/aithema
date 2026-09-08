import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Git blob object id for one file. Same algorithm `git hash-object` uses, so a
 * tree-mode digest can match the frozen AIT-10 `path\\t<blob sha>` tree digest
 * without changing that field's meaning.
 * @param {Buffer} data
 * @returns {string}
 */
export function gitBlobSha1(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

/**
 * @param {Buffer | string} data
 * @returns {string}
 */
export function sha256(data) {
  const hash = createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

/**
 * @param {string} hex
 * @returns {string}
 */
export function sha256Prefixed(hex) {
  return `sha256:${hex}`;
}
