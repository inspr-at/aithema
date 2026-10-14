export const SOURCE_PROVENANCE_PATH = 'release/source-provenance.json';
export const SOURCE_PROVENANCE_SCHEMA = 'aithema-source-provenance/0.1';

const COMMIT_ID = /^[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertCommitId(value, label) {
  if (typeof value !== 'string' || !COMMIT_ID.test(value)) {
    throw new Error(`${label} must be a 40-character lowercase commit object id`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertSha256Digest(value, label) {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new Error(`${label} must be a sha256-prefixed digest`);
  }
  return value;
}

/**
 * @param {string | Buffer | object} raw
 * @returns {object}
 */
export function parseSourceProvenance(raw) {
  const provenance = (typeof raw === 'string' || Buffer.isBuffer(raw))
    ? JSON.parse(raw.toString('utf8'))
    : raw;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('source provenance must be an object');
  }
  if (provenance.schema !== SOURCE_PROVENANCE_SCHEMA) {
    throw new Error(`source provenance schema must be ${SOURCE_PROVENANCE_SCHEMA}`);
  }
  assertCommitId(provenance.private_source_commit, 'private_source_commit');
  assertCommitId(provenance.current_source_commit, 'current_source_commit');
  assertSha256Digest(provenance.runtime_tree_digest, 'runtime_tree_digest');
  assertSha256Digest(provenance.lock_digest, 'lock_digest');
  if (!Number.isInteger(provenance.export_mtime_epoch) || provenance.export_mtime_epoch <= 0) {
    throw new Error('source provenance must record a positive export_mtime_epoch');
  }
  return provenance;
}

/**
 * Keep the original private commit labelled as lineage. The current commit is
 * whatever Git HEAD actually is after a later public init.
 * @param {string | Buffer | object | null | undefined} existing
 * @param {string} currentCommit
 * @returns {{ privateSourceCommit: string, currentSourceCommit: string }}
 */
export function inheritPrivateSourceCommit(existing, currentCommit) {
  const current = assertCommitId(currentCommit, 'current source commit');
  if (existing == null) {
    return { privateSourceCommit: current, currentSourceCommit: current };
  }
  const parsed = parseSourceProvenance(existing);
  return {
    privateSourceCommit: parsed.private_source_commit,
    currentSourceCommit: current,
  };
}

/**
 * @param {object} input
 * @returns {string}
 */
export function buildSourceProvenanceText({
  privateSourceCommit,
  currentSourceCommit,
  exportMtimeEpoch,
  runtimeTreeDigest,
  lockDigest,
}) {
  const provenance = {
    schema: SOURCE_PROVENANCE_SCHEMA,
    private_source_commit: assertCommitId(privateSourceCommit, 'private_source_commit'),
    current_source_commit: assertCommitId(currentSourceCommit, 'current_source_commit'),
    export_mtime_epoch: exportMtimeEpoch,
    runtime_tree_digest: assertSha256Digest(runtimeTreeDigest, 'runtime_tree_digest'),
    lock_digest: assertSha256Digest(lockDigest, 'lock_digest'),
    normalization_note:
      'private_source_commit is lineage from the original private export. '
      + 'current_source_commit is the Git commit actually exported. '
      + 'runtime_tree_digest uses the AIT-10 path+blob-sha inventory; it is not a Git tree object id.',
  };
  parseSourceProvenance(provenance);
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/**
 * Content binding for tree-mode: recorded runtime tree/lock must match the
 * files on disk before the private commit may be claimed. This is not a
 * signature of origin.
 * @param {object} provenance
 * @param {{ treeDigest: string, lockDigest: string }} computed
 */
export function assertRuntimeProvenanceBinding(provenance, computed) {
  const bound = parseSourceProvenance(provenance);
  if (computed.treeDigest !== bound.runtime_tree_digest) {
    throw new Error(
      'tree-mode provenance mismatch: runtime tree does not match the recorded export',
    );
  }
  if (computed.lockDigest !== bound.lock_digest) {
    throw new Error(
      'tree-mode provenance mismatch: lock digest does not match the recorded export',
    );
  }
}
