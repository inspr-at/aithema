/**
 * @typedef {'technical' | 'data' | 'authority' | 'cost' | 'agreement'} ConstraintKind
 * @typedef {'new_product' | 'iteration' | 'integration'} ProjectKind
 * @typedef {'requirements_approver' | 'batch_authorizer' | 'delivery_party' | 'operator' | 'acceptance_party'} PartyRole
 */

/**
 * Caller-supplied verified authority. Aithema does not authenticate; it trusts
 * the adapter that verified the party and roles before invoking domain APIs.
 * Digests never authenticate an actor.
 * @typedef {{ party_ref: string, roles: readonly PartyRole[] }} VerifiedAuthority
 */

/**
 * @typedef {{ requirement_ref: string, statement: string, acceptance_criteria: readonly string[], constraint_refs: readonly string[] }} Requirement
 */

/**
 * @typedef {{ constraint_ref: string, kind: ConstraintKind, statement: string }} Constraint
 */

/**
 * content_digest covers requirements/constraints only.
 * revision_seal binds baseline_ref + revision + content_digest.
 * approved_by / approved_at are recorded claims, not digest-authenticated.
 * @typedef {{
 *   baseline_ref: string,
 *   revision: number,
 *   content_digest: string,
 *   revision_seal: string,
 *   approved_by: string,
 *   approved_at: string,
 *   requirements: readonly Requirement[],
 *   constraints: readonly Constraint[],
 * }} Baseline
 */

/**
 * Source handover identity retained as claims. Import never copies approval.
 * @typedef {{
 *   stream_ref: string,
 *   baseline_ref: string | null,
 *   revision: number,
 *   content_digest: string | null,
 *   revision_seal: string | null,
 *   claimed_approved_by: string | null,
 *   claimed_approved_at: string | null,
 *   source_proposal_ref: string | null,
 *   source_kind: string | null,
 * }} SourceClaim
 */

/**
 * @typedef {'add_requirement' | 'update_requirement' | 'add_constraint' | 'update_constraint' | 'import_bundle'} ProposalKind
 */

/**
 * Update proposals bind to the snapshot they were authored against.
 * against_* identify that baseline; approval rejects stale or conflicting updates.
 * @typedef {{
 *   proposal_ref: string,
 *   kind: ProposalKind,
 *   contributed_by: string,
 *   contributed_at: string,
 *   summary: string,
 *   requirement?: Requirement,
 *   constraint?: Constraint,
 *   import_requirements?: readonly Requirement[],
 *   import_constraints?: readonly Constraint[],
 *   source_claim?: SourceClaim,
 *   against_baseline_ref?: string,
 *   against_revision?: number,
 *   against_content_digest?: string,
 * }} Proposal
 */

/**
 * @typedef {{
 *   decision_ref: string,
 *   proposal_ref: string,
 *   decided_by: string,
 *   decided_at: string,
 *   outcome: 'approved' | 'rejected',
 *   note: string,
 * }} Decision
 */

/**
 * @typedef {{
 *   stream_ref: string,
 *   project_kinds: readonly ProjectKind[],
 *   baselines: readonly Baseline[],
 *   proposals: readonly Proposal[],
 *   decisions: readonly Decision[],
 * }} RequirementsStream
 */

/**
 * @typedef {{
 *   handover_version: 'aithema.handover/0.1',
 *   stream_ref: string,
 *   exported_at: string,
 *   baseline: Baseline | null,
 *   pending_proposals: readonly Proposal[],
 *   decisions: readonly Decision[],
 * }} RequirementsHandover
 */

export {};
