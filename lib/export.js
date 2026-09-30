import { boundary } from './boundary.js';
import { assertItemExtensions } from './extensions.js';
import { assertWorkingSpec } from './working-spec.js';
import { canonicalJson } from '../contracts/validate.js';
/** @import { Baseline, Constraint, Decision, Proposal, Requirement, RequirementsHandover, RequirementsStream } from './types.js' */
import { encodeRequirementsCsv } from './csv.js';
import { currentBaseline } from './stream.js';
import { assertNonEmptyString, validateBaselineClaim, validateProposal } from './validate.js';

/**
 * @typedef {{namespace: string, version: string, data: unknown} &
 * ({item_ref: string, item_version: number} | {proposal_ref: string})} HandoverExtension
 * @typedef {{registry?: import('./extensions.js').ExtensionRegistry,
 * workingSpec?: import('./working-spec.js').WorkingSpec}} ExtensionExportOptions
 * @typedef {RequirementsHandover & {extensions?: readonly HandoverExtension[]}} ExtendedHandover
 */

function extensionSection(stream, workingSpec, registry) {
  if (workingSpec !== undefined) assertWorkingSpec(workingSpec, registry);
  // Also validate retained proposal history, including decided proposals.
  for (const proposal of stream.proposals) assertItemExtensions(proposal.extensions, registry);
  const sources = workingSpec === undefined ? stream.proposals : workingSpec.items;
  return Object.freeze(sources.flatMap((source) => {
    assertItemExtensions(source.extensions, registry);
    const identity = workingSpec === undefined ? { proposal_ref: source.proposal_ref }
      : { item_ref: source.item_ref, item_version: source.version };
    return Object.entries(source.extensions ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, instance]) => Object.freeze({ ...identity, namespace: key.split('@')[0], version: instance.version, data: instance.data }));
  }));
}

function assertExtensionSection(section, registry) {
  if (section === undefined) return;
  const invalid = (message) => Object.assign(new Error(message), { code: 'extension_invalid', status: 422 });
  if (!Array.isArray(section)) throw invalid('handover extensions must be a typed array');
  const groups = new Map();
  for (const entry of section) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !['namespace', 'version', 'data'].every((key) => Object.hasOwn(entry, key))) throw invalid('invalid handover extension entry');
    const item = Object.hasOwn(entry, 'item_ref');
    const allowed = item ? ['namespace', 'version', 'data', 'item_ref', 'item_version'] : ['namespace', 'version', 'data', 'proposal_ref'];
    if (Object.keys(entry).some((key) => !allowed.includes(key)) ||
        typeof entry[item ? 'item_ref' : 'proposal_ref'] !== 'string' || !entry[item ? 'item_ref' : 'proposal_ref'].trim() ||
        item && (!Number.isSafeInteger(entry.item_version) || entry.item_version < 1) ||
        typeof entry.namespace !== 'string' || typeof entry.version !== 'string') throw invalid('handover extensions require an item version or proposal identity');
    const identity = canonicalJson(item ? [entry.item_ref, entry.item_version] : [entry.proposal_ref]);
    const map = groups.get(identity) ?? Object.create(null);
    const key = `${entry.namespace}@${entry.version.split('.')[0]}`;
    if (Object.hasOwn(map, key)) throw invalid('duplicate handover extension for an item or proposal');
    map[key] = { version: entry.version, data: entry.data };
    groups.set(identity, map);
  }
  for (const map of groups.values()) assertItemExtensions(map, registry);
}

/**
 * @param {RequirementsStream} stream
 * @param {string} [exportedAt]
 * @param {ExtensionExportOptions} [options]
 * @returns {ExtendedHandover}
 */
function exportHandoverJsonImpl(stream, exportedAt = new Date().toISOString(), { registry = [], workingSpec = stream.working_spec } = {}) {
  const baseline = currentBaseline(stream);
  const pending = stream.proposals.filter(
    (proposal) => !stream.decisions.some((decision) => decision.proposal_ref === proposal.proposal_ref),
  );
  const extensions = extensionSection(stream, workingSpec, registry);
  return Object.freeze({
    handover_version: 'aithema.handover/0.1',
    stream_ref: stream.stream_ref,
    exported_at: exportedAt,
    baseline,
    pending_proposals: Object.freeze([...pending]),
    decisions: Object.freeze([...stream.decisions]),
    ...(extensions.length ? { extensions } : {}),
  });
}

/**
 * @param {unknown} handover
 * @param {{registry?: import('./extensions.js').ExtensionRegistry}} [options]
 * @returns {ExtendedHandover}
 */
function parseHandoverJsonImpl(handover, { registry = [] } = {}) {
  if (handover === null || typeof handover !== 'object' || Array.isArray(handover)) {
    throw new Error('handover must be an object');
  }
  if (handover.handover_version !== 'aithema.handover/0.1') {
    throw new Error('unsupported handover_version');
  }
  assertNonEmptyString(handover.stream_ref, 'stream_ref');
  if (typeof handover.exported_at !== 'string' || !handover.exported_at) {
    throw new Error('exported_at is required in handover');
  }
  if (!Array.isArray(handover.pending_proposals)) {
    throw new Error('pending_proposals must be an array');
  }
  if (!Array.isArray(handover.decisions)) {
    throw new Error('decisions must be an array');
  }
  if (handover.baseline !== null && handover.baseline !== undefined) {
    validateBaselineClaim(handover.baseline);
  } else if (handover.baseline !== null) {
    throw new Error('handover baseline must be an object or null');
  }
  for (const [index, proposal] of handover.pending_proposals.entries()) {
    validateProposal(proposal, `pending_proposals[${index}]`);
    assertItemExtensions(proposal.extensions, registry);
  }
  assertExtensionSection(handover.extensions, registry);
  return handover;
}

/**
 * @param {Requirement} requirement
 * @param {string} prefix
 */
function requirementRows(requirement, prefix) {
  const rows = [[`${prefix}:statement`, requirement.statement]];
  for (const [index, criterion] of requirement.acceptance_criteria.entries()) {
    rows.push([`${prefix}:acceptance_criterion:${index + 1}`, criterion]);
  }
  for (const constraintRef of requirement.constraint_refs) {
    rows.push([`${prefix}:constraint_ref`, constraintRef]);
  }
  return rows;
}

/**
 * @param {Constraint} constraint
 * @param {string} prefix
 */
function constraintRows(constraint, prefix) {
  return [
    [`${prefix}:kind`, constraint.kind],
    [`${prefix}:statement`, constraint.statement],
  ];
}

/**
 * @param {Proposal} proposal
 */
function proposalRows(proposal) {
  const prefix = `proposal:${proposal.proposal_ref}`;
  const rows = [
    [`${prefix}:kind`, proposal.kind],
    [`${prefix}:summary`, proposal.summary],
    [`${prefix}:contributed_by`, proposal.contributed_by],
    [`${prefix}:contributed_at`, proposal.contributed_at],
  ];
  if (proposal.requirement) {
    rows.push(...requirementRows(proposal.requirement, `${prefix}:requirement:${proposal.requirement.requirement_ref}`));
  }
  if (proposal.constraint) {
    rows.push(...constraintRows(proposal.constraint, `${prefix}:constraint:${proposal.constraint.constraint_ref}`));
  }
  for (const requirement of proposal.import_requirements ?? []) {
    rows.push(...requirementRows(requirement, `${prefix}:requirement:${requirement.requirement_ref}`));
  }
  for (const constraint of proposal.import_constraints ?? []) {
    rows.push(...constraintRows(constraint, `${prefix}:constraint:${constraint.constraint_ref}`));
  }
  const claim = proposal.source_claim;
  if (claim) {
    if (claim.stream_ref) rows.push([`${prefix}:source_stream_ref`, claim.stream_ref]);
    if (claim.baseline_ref) rows.push([`${prefix}:source_baseline_ref`, claim.baseline_ref]);
    rows.push([`${prefix}:source_revision`, String(claim.revision)]);
    if (claim.content_digest) rows.push([`${prefix}:source_content_digest`, claim.content_digest]);
    if (claim.revision_seal) rows.push([`${prefix}:source_revision_seal`, claim.revision_seal]);
    if (claim.claimed_approved_by) {
      rows.push([`${prefix}:source_claimed_approved_by`, claim.claimed_approved_by]);
    }
    if (claim.source_kind) rows.push([`${prefix}:source_kind`, claim.source_kind]);
  }
  return rows;
}

/**
 * @param {Baseline | null} baseline
 * @param {readonly Proposal[]} pending
 * @param {readonly Decision[]} decisions
 */
function baselineRows(baseline, pending, decisions) {
  const rows = [];
  if (baseline) {
    rows.push(['baseline_ref', baseline.baseline_ref]);
    rows.push(['revision', String(baseline.revision)]);
    rows.push(['content_digest', baseline.content_digest]);
    rows.push(['revision_seal', baseline.revision_seal]);
    rows.push(['approved_by', baseline.approved_by]);
    rows.push(['approved_at', baseline.approved_at]);
    for (const requirement of baseline.requirements) {
      rows.push(...requirementRows(requirement, `requirement:${requirement.requirement_ref}`));
    }
    for (const constraint of baseline.constraints) {
      rows.push(...constraintRows(constraint, `constraint:${constraint.constraint_ref}`));
    }
  } else {
    rows.push(['baseline_ref', '(none)']);
    rows.push(['revision', '0']);
    rows.push(['content_digest', '(none)']);
    rows.push(['revision_seal', '(none)']);
  }

  rows.push(['pending_proposals', String(pending.length)]);
  for (const proposal of pending) {
    rows.push(...proposalRows(proposal));
  }

  rows.push(['decisions', String(decisions.length)]);
  for (const decision of decisions) {
    rows.push([`decision:${decision.decision_ref}:proposal_ref`, decision.proposal_ref]);
    rows.push([`decision:${decision.decision_ref}:outcome`, decision.outcome]);
    rows.push([`decision:${decision.decision_ref}:decided_by`, decision.decided_by]);
  }

  return rows;
}

/**
 * CSV export identifies the same revision and digest as the JSON handover.
 * @param {RequirementsStream} stream
 * @param {{ field?: string, value?: string }} [header]
 * @param {string} [exportedAt]
 * @param {ExtensionExportOptions} [options]
 */
function exportHandoverCsvImpl(stream, header, exportedAt, options = {}) {
  return handoverToCsvImpl(exportHandoverJsonImpl(stream, exportedAt, options), header, options);
}

/**
 * @param {ExtendedHandover} handover
 * @param {{ field?: string, value?: string }} [header]
 * @param {{registry?: import('./extensions.js').ExtensionRegistry}} [options]
 */
function handoverToCsvImpl(handover, header, { registry = [] } = {}) {
  assertExtensionSection(handover.extensions, registry);
  const rows = [
    ['handover_version', handover.handover_version],
    ['stream_ref', handover.stream_ref],
    ['exported_at', handover.exported_at],
    ...baselineRows(handover.baseline, handover.pending_proposals, handover.decisions),
    ...(handover.extensions ?? []).flatMap((entry) => {
      const identity = Object.hasOwn(entry, 'item_ref') ? `item:${entry.item_ref}:${entry.item_version}` : `proposal:${entry.proposal_ref}`;
      const prefix = `${identity}:extension:${entry.namespace}@${entry.version}`;
      return [[`${prefix}:namespace`, entry.namespace], [`${prefix}:version`, entry.version], [`${prefix}:data`, canonicalJson(entry.data)]];
    }),
  ];
  return encodeRequirementsCsv(rows, {
    field: header?.field ?? 'Field',
    value: header?.value ?? 'Value',
  });
}

/**
 * @param {RequirementsHandover} handover
 */
function handoverRevisionIdentityImpl(handover) {
  if (!handover.baseline) {
    return { baseline_ref: null, revision: 0, content_digest: null, revision_seal: null };
  }
  return {
    baseline_ref: handover.baseline.baseline_ref,
    revision: handover.baseline.revision,
    content_digest: handover.baseline.content_digest,
    revision_seal: handover.baseline.revision_seal,
  };
}

export const exportHandoverJson = boundary(exportHandoverJsonImpl);
export const parseHandoverJson = boundary(parseHandoverJsonImpl);
export const exportHandoverCsv = boundary(exportHandoverCsvImpl);
export const handoverToCsv = boundary(handoverToCsvImpl);
export const handoverRevisionIdentity = boundary(handoverRevisionIdentityImpl);
