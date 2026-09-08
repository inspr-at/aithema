/** @import { Baseline, RequirementsHandover, RequirementsStream } from './types.js' */
import { assertRehydratedBaseline } from './validate.js';
import { handoverToCsv, handoverRevisionIdentity } from './export.js';

/**
 * Locate one retained approved snapshot. Revision and baseline_ref must agree
 * so two formats cannot race a mutable "latest".
 * @param {RequirementsStream} stream
 * @param {{ baseline_ref?: unknown, revision?: unknown }} identity
 * @returns {Baseline}
 */
export function findApprovedBaseline(stream, identity) {
  const baselineRef = typeof identity.baseline_ref === 'string' ? identity.baseline_ref.trim() : '';
  const revision = typeof identity.revision === 'string' && identity.revision.trim()
    ? Number(identity.revision)
    : identity.revision;
  if (!baselineRef) {
    throw Object.assign(new Error('baseline_ref is required for a reviewed export'), { code: 'export_ref_required' });
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw Object.assign(new Error('revision must be a positive integer'), { code: 'export_revision_invalid' });
  }
  const found = (stream.baselines ?? []).find(
    (item) => item.baseline_ref === baselineRef && item.revision === revision,
  );
  if (!found) {
    throw Object.assign(
      new Error(`no approved baseline ${baselineRef} at revision ${revision}`),
      { code: 'export_revision_unknown' },
    );
  }
  assertRehydratedBaseline(found);
  return found;
}

/**
 * Portable reviewed handover: one approved snapshot, no pending proposals,
 * decisions, transcript, provider config, or identity map.
 * @param {RequirementsStream} stream
 * @param {{ baseline_ref: string, revision: number }} identity
 * @param {string} [exportedAt]
 * @returns {RequirementsHandover}
 */
export function exportReviewedHandover(stream, identity, exportedAt = new Date().toISOString()) {
  const baseline = findApprovedBaseline(stream, identity);
  return Object.freeze({
    handover_version: 'aithema.handover/0.1',
    stream_ref: stream.stream_ref,
    exported_at: exportedAt,
    baseline,
    pending_proposals: Object.freeze([]),
    decisions: Object.freeze([]),
  });
}

/**
 * @param {RequirementsStream} stream
 * @param {{ baseline_ref: string, revision: number }} identity
 * @param {{ field?: string, value?: string }} [header]
 * @param {string} [exportedAt]
 */
export function exportReviewedCsv(stream, identity, header, exportedAt) {
  return handoverToCsv(exportReviewedHandover(stream, identity, exportedAt), header);
}

/**
 * @param {RequirementsHandover} handover
 */
export function reviewedHandoverIdentity(handover) {
  const identity = handoverRevisionIdentity(handover);
  if (!identity.baseline_ref || !identity.revision) {
    throw Object.assign(new Error('reviewed export requires an approved baseline'), { code: 'export_no_baseline' });
  }
  return identity;
}
