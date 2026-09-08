/**
 * Host-issued Flow identity and requirements-to-shell mapping.
 * Schema validity is display data, never a substitute for actor/project checks.
 */
import { createHash } from 'node:crypto';

import {
  AUTHORITY_DISCLAIMER,
  IDENTITY_CONTRACT_VERSION,
  identityBinding,
  identityStartIssues,
  normalizeIdentityContext,
} from '@inspr/flow-shell/identity';
import { normalizeShellState } from '@inspr/flow-shell/state';

import { currentBaseline } from '../lib/stream.js';
import { pendingProposalList } from '../runtime/controller.js';
import { joinMountPath } from '../runtime/public-path.js';

export const FLOW_HOST_ID = 'aithema';
export const FLOW_CONTEXT_TTL_MS = 8 * 60 * 60 * 1000;
export const FLOW_CONTEXT_FRESH_MS = 12 * 60 * 1000;
export const FLOW_OVERALL_FALLBACK_PERCENT = 5;
export const FLOW_OVERALL_WITH_BASELINE_PERCENT = 25;
export const FLOW_FALLBACK_ETA_MS = 45 * 60 * 1000;

const CONSEQUENTIAL = new Set(['flow:start-intent', 'flow:review-batch', 'flow:save-proposal']);

/**
 * @param {string} kind
 * @param {readonly unknown[]} parts
 */
export function opaqueHostRef(kind, ...parts) {
  const digest = createHash('sha256');
  digest.update(`${FLOW_HOST_ID}:${kind}:`);
  for (const part of parts) {
    digest.update(Buffer.from(String(part), 'utf8'));
    digest.update(Buffer.from([0]));
  }
  return `${FLOW_HOST_ID}:${kind}-${digest.digest('hex').slice(0, 32)}`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function initialsFromRef(ref) {
  const hex = createHash('sha256').update(String(ref)).digest('hex');
  const letters = hex.replace(/[^a-f]/g, '').slice(0, 2) || hex.slice(0, 2);
  return letters.slice(0, 2).toUpperCase();
}

/**
 * @param {{
 *   actor: import('../runtime/identity.js').VerifiedActor,
 *   project?: object | null,
 *   labelledDemo: boolean,
 *   identityConfig?: { kind?: string, issuer?: string } | null,
 *   now?: number,
 * }} input
 */
export function issueFlowIdentityContext(input) {
  const { actor, project, labelledDemo, identityConfig, now = Date.now() } = input;
  if (!actor || !project) return null;

  const localHost = labelledDemo || identityConfig?.kind === 'demo';
  const principalKind = localHost ? 'local_host' : 'oidc_backed';
  const principalRef = opaqueHostRef('prin', actor.subject);
  const projectRef = opaqueHostRef('proj', project.project_ref);
  const bindingRef = opaqueHostRef('bind', actor.subject, project.project_ref, actor.actor_kind);
  const baseline = currentBaseline(project.stream);
  const contextRevision = opaqueHostRef(
    'ctxrev',
    actor.subject,
    project.project_ref,
    actor.actor_kind,
    String(project.revision),
    baseline?.content_digest ?? 'none',
  );

  const context = {
    contract_version: IDENTITY_CONTRACT_VERSION,
    evaluated_at: iso(now),
    host_id: FLOW_HOST_ID,
    principal_kind: principalKind,
    principal_ref: principalRef,
    binding_ref: bindingRef,
    organization_ref: null,
    project_ref: projectRef,
    actor_kind: actor.actor_kind,
    issued_at: iso(now),
    expires_at: iso(now + FLOW_CONTEXT_TTL_MS),
    fresh_until: iso(now + FLOW_CONTEXT_FRESH_MS),
    context_revision: contextRevision,
    authority_disclaimer: AUTHORITY_DISCLAIMER,
    display: {
      user_label: labelledDemo
        ? (actor.actor_kind === 'human' ? 'Labelled demo human' : 'Labelled demo agent')
        : (actor.actor_kind === 'human' ? 'Host-verified human' : 'Host-verified agent'),
      user_initials: initialsFromRef(principalRef),
      project_label: String(project.title || 'Project').slice(0, 80),
      fixture_label: labelledDemo
        ? 'Labelled loopback demo identity. No live identity.'
        : 'Host-issued OIDC-backed context. Not live identity.',
    },
  };

  if (principalKind === 'oidc_backed') {
    const issuer = typeof identityConfig?.issuer === 'string' ? identityConfig.issuer : '';
    if (!issuer) {
      throw Object.assign(new Error('OIDC-backed Flow context requires a configured issuer'), {
        code: 'forbidden',
      });
    }
    context.issuer_descriptor = {
      kind: 'verified_issuer_descriptor',
      issuer_ref: opaqueHostRef('iss', issuer),
    };
    context.display.issuer_label = 'Configured OIDC issuer';
  }

  const normalized = normalizeIdentityContext(context);
  if (normalized.status !== 'present') {
    throw Object.assign(
      new Error(normalized.reasons.join(' ') || 'Flow identity context was rejected.'),
      { code: 'forbidden', reasons: normalized.reasons },
    );
  }
  return context;
}

function unknownGate(message, gateKind) {
  return {
    status: 'unknown',
    message,
    gateKind,
    evidenceRef: null,
    observedAt: null,
    freshUntil: null,
    targetRef: null,
  };
}

function forecastGuess(percent, estimatedFinish, asOf) {
  return {
    percent_complete: percent,
    estimated_finish: estimatedFinish,
    kind: 'educated_guess',
    as_of: asOf,
    basis: { kind: 'manual_estimate', evidence_ref: null },
    conditional_on: null,
    previous_target: null,
  };
}

/**
 * @param {{
 *   actor: import('../runtime/identity.js').VerifiedActor | null,
 *   project?: object | null,
 *   labelledDemo: boolean,
 *   identityConfig?: object | null,
 *   now?: number,
 * }} input
 */
export function buildWorkspaceFlowState(input) {
  const { actor, project = null, labelledDemo, identityConfig = null, now = Date.now() } = input;
  const identityContext = actor && project
    ? issueFlowIdentityContext({ actor, project, labelledDemo, identityConfig, now })
    : null;
  const baseline = project ? currentBaseline(project.stream) : null;
  const pending = project ? pendingProposalList(project.stream) : [];
  const observedAt = baseline?.approved_at ?? project?.updated_at ?? iso(now);
  const asOf = iso(now);
  const estimatedFinish = iso(now + FLOW_FALLBACK_ETA_MS);

  const scopeItems = baseline
    ? baseline.requirements.map((item) => item.statement).filter(Boolean).slice(0, 12)
    : pending.map((item) => item.summary || item.requirement?.statement).filter(Boolean).slice(0, 12);

  const payload = {
    evaluatedAt: asOf,
    header: {
      appName: 'INSPR',
      instanceLabel: labelledDemo ? 'Aithema labelled demo' : 'Aithema workspace',
      version: 'workspace',
      userInitials: identityContext
        ? identityContext.display.user_initials
        : (actor ? initialsFromRef(actor.actor_kind) : '?'),
      userLabel: identityContext
        ? identityContext.display.user_label
        : (labelledDemo ? 'Labelled demo' : 'Workspace'),
      projectName: project?.title || 'Requirements workspace',
      projectSubtitle: labelledDemo ? 'Labelled demo · not live identity' : 'Host-issued workspace context',
    },
    health: {
      status: 'available',
      label: labelledDemo ? 'Labelled demo workspace' : 'Workspace available',
      checkedLabel: 'Check workspace health',
      url: null,
    },
    delivery: {
      liveReleaseLabel: 'Aithema requirements workspace',
      batchTitle: project?.title || 'Requirements workspace',
      batchSummary: baseline
        ? `${pending.length} unapproved proposals · approved baseline on record`
        : `${pending.length} unapproved proposals · no approved baseline yet`,
      draftCount: pending.length,
      mapDetail: baseline
        ? 'Aithema requirements baseline is on record in this workspace. Paimos build, Pharos delivery, and Janus access stay unknown and gated until an external integration provides evidence. Stage exploration never starts work.'
        : 'No approved Aithema baseline yet. Confirm proposals in this workspace before any delivery work. Paimos, Pharos, and Janus evidence is not available here.',
      batchRef: project ? opaqueHostRef('batch', project.project_ref) : null,
      baselineRef: baseline?.baseline_ref ?? null,
      baselineDigest: baseline?.content_digest ?? null,
      status: 'draft',
      activeStage: 0,
      stageEvidence: [
        baseline ? 'performed' : 'unknown',
        'unknown',
        'unknown',
        'unknown',
      ],
      batchStatusLabel: baseline ? 'Requirements recorded · delivery gated' : 'Requirements in progress',
      scopeItems,
    },
    prerequisites: {
      requirementsBaseline: baseline
        ? {
          status: 'pass',
          message: 'Approved requirements baseline is on record in this workspace.',
          gateKind: 'requirements_baseline',
          evidenceRef: opaqueHostRef('ev', baseline.baseline_ref, baseline.content_digest),
          observedAt,
          freshUntil: iso(now + FLOW_CONTEXT_FRESH_MS),
          digest: baseline.content_digest,
        }
        : unknownGate(
          'No approved requirements baseline yet. Confirm proposals in this workspace before delivery work.',
          'requirements_baseline',
        ),
      deployArtifact: unknownGate(
        'Paimos deployable artifact evidence is not available in this Aithema workspace. That stage stays gated.',
        'artifact',
      ),
      pharosTarget: unknownGate(
        'Pharos target readiness is not reported here. Delivery stays unknown until an external integration provides it.',
        'target_readiness',
      ),
      janusGate: unknownGate(
        'Janus access evidence is not reported here. Access stays unknown until an external integration provides it.',
        'access',
      ),
    },
    progress: {
      taskLabel: baseline ? 'Requirements baseline' : 'Requirements in progress',
      overallLabel: 'Overall',
      task: baseline
        ? {
          progress: {
            status: 'done',
            percent_complete: 100,
            eta: null,
            basis: { kind: 'observed_work', evidence_ref: opaqueHostRef('ev', baseline.baseline_ref) },
            reporter: { kind: 'human', reporter_ref: opaqueHostRef('rep', 'workspace') },
            reported_at: observedAt,
            fresh_until: iso(now + FLOW_CONTEXT_FRESH_MS),
            freshness: 'fresh',
          },
          forecast: forecastGuess(100, observedAt, asOf),
        }
        : {
          progress: {
            status: 'pending',
            percent_complete: null,
            eta: null,
            basis: { kind: 'unknown', evidence_ref: null },
            reporter: { kind: 'system', reporter_ref: opaqueHostRef('rep', 'workspace') },
            reported_at: asOf,
            fresh_until: iso(now + FLOW_CONTEXT_FRESH_MS),
            freshness: 'unknown',
          },
          forecast: forecastGuess(0, estimatedFinish, asOf),
        },
      overall: {
        progress: {
          status: 'pending',
          percent_complete: null,
          eta: null,
          basis: { kind: 'unknown', evidence_ref: null },
          reporter: { kind: 'system', reporter_ref: opaqueHostRef('rep', 'workspace') },
          reported_at: asOf,
          fresh_until: iso(now + FLOW_CONTEXT_FRESH_MS),
          freshness: 'unknown',
        },
        forecast: forecastGuess(
          baseline ? FLOW_OVERALL_WITH_BASELINE_PERCENT : FLOW_OVERALL_FALLBACK_PERCENT,
          estimatedFinish,
          asOf,
        ),
      },
      freshnessLabel: baseline ? 'Updated from workspace records' : 'Educated guess · observations missing',
    },
    executionModes: ['manual', 'assisted', 'automatic'],
    selectedExecutionMode: 'manual',
    selectedAction: 'build',
    identityContext,
  };

  const normalized = normalizeShellState(payload);
  if (identityContext && normalized.identity.status !== 'present') {
    throw Object.assign(
      new Error(normalized.identity.reasons?.join(' ') || 'Flow identity context was rejected.'),
      { code: 'forbidden' },
    );
  }
  return payload;
}

function submittedBinding(intent) {
  return intent?.identity
    ?? intent?.detail?.identity
    ?? intent?.snapshot?.identity
    ?? null;
}

function submittedFreshnessIssues(submitted, now) {
  if (!submitted || typeof submitted !== 'object' || submitted.status !== 'present') {
    return [];
  }
  const reasons = [];
  const issued = Date.parse(submitted.issuedAt ?? submitted.issued_at ?? '');
  const expires = Date.parse(submitted.expiresAt ?? submitted.expires_at ?? '');
  const freshUntil = Date.parse(submitted.freshUntil ?? submitted.fresh_until ?? '');
  if (Number.isNaN(issued) || issued > now + 60_000) {
    reasons.push('Host identity context is not yet valid.');
  }
  if (Number.isNaN(expires) || now >= expires) {
    reasons.push('Host identity context has expired.');
  }
  if (Number.isNaN(freshUntil) || now >= freshUntil) {
    reasons.push('Host identity context is stale.');
  }
  return reasons;
}

function bindingMismatch(currentContext, submitted) {
  const current = identityBinding(normalizeIdentityContext(currentContext));
  if (!submitted || typeof submitted !== 'object') {
    return ['Host identity context is required before a consequential start.'];
  }
  if (current.status !== 'present') {
    return ['Host identity context is required before a consequential start.'];
  }
  const reasons = [];
  if (submitted.status && submitted.status !== 'present') {
    reasons.push('Host identity context was rejected.');
  }
  if (submitted.principalRef !== current.principalRef) {
    reasons.push('Host principal binding does not match the current verified actor.');
  }
  if (submitted.projectRef !== current.projectRef) {
    reasons.push('Flow context is bound to a different project.');
  }
  if (submitted.actorKind !== current.actorKind) {
    reasons.push('Actor kind does not match the current verified actor.');
  }
  if (submitted.bindingRef !== current.bindingRef) {
    reasons.push('Host identity binding does not match the current context.');
  }
  if (submitted.contextRevision !== current.contextRevision) {
    reasons.push('Host identity context has changed. Refresh and retry.');
  }
  return reasons;
}

/**
 * Revalidate actor/project-derived context. Does not grant execution authority.
 * @param {{
 *   actor: import('../runtime/identity.js').VerifiedActor,
 *   project?: object | null,
 *   labelledDemo: boolean,
 *   identityConfig?: object | null,
 *   publicBasePath?: string,
 *   intent: object,
 *   now?: number,
 * }} input
 */
export function handleHostFlowIntent(input) {
  const {
    actor,
    project = null,
    labelledDemo,
    identityConfig = null,
    publicBasePath = '',
    intent,
    now = Date.now(),
  } = input;
  if (!actor) {
    throw Object.assign(new Error('Verified identity required.'), { code: 'unauthorized', status: 401 });
  }
  const type = intent?.type || intent?.detail?.type;
  const current = buildWorkspaceFlowState({ actor, project, labelledDemo, identityConfig, now });

  if (CONSEQUENTIAL.has(type)) {
    if (!project) {
      throw Object.assign(new Error('A current project is required for this Flow intent.'), {
        code: 'forbidden',
        status: 403,
      });
    }
    const mismatch = bindingMismatch(current.identityContext, submittedBinding(intent));
    if (mismatch.length) {
      throw Object.assign(new Error(mismatch[0]), {
        code: 'stale_context',
        status: 409,
        issues: mismatch,
      });
    }
    const submitted = submittedBinding(intent);
    const freshness = [
      ...submittedFreshnessIssues(submitted, now),
      ...identityStartIssues(
        normalizeIdentityContext(current.identityContext),
        { now, requireHuman: type === 'flow:start-intent' },
      ),
    ];
    if (freshness.length) {
      const status = freshness.some((item) => /human host principal/i.test(item)) ? 403 : 409;
      throw Object.assign(new Error(freshness[0]), {
        code: status === 403 ? 'forbidden' : 'stale_context',
        status,
        issues: freshness,
      });
    }
  }

  if (type === 'flow:start-intent') {
    return {
      executed: false,
      unsupported: true,
      routed: null,
      reason:
        'Paimos build, Pharos delivery, and Janus access are not integrated in this Aithema workspace. The host revalidated the current actor and project; no delivery work was started.',
      notice:
        'Downstream start is unsupported here. Use the existing review and handover controls for requirements. This is not a delivery success.',
    };
  }
  if (type === 'flow:review-batch') {
    return {
      executed: false,
      unsupported: false,
      routed: 'workspace-review',
      location: joinMountPath(publicBasePath, `/projects/${encodeURIComponent(project.project_ref)}#workspace-review`),
      reason: null,
      notice:
        'Requirements review stays in this workspace. Use the existing authenticated approve, reject, and handover controls. This is not a delivery start.',
    };
  }
  if (type === 'flow:save-proposal') {
    return {
      executed: false,
      unsupported: false,
      routed: 'workspace-conversation',
      location: joinMountPath(publicBasePath, `/projects/${encodeURIComponent(project.project_ref)}#workspace-compose`),
      reason: null,
      notice:
        'Draft ideas stay in this workspace conversation as unapproved proposals. A Flow idea is not a delivery start.',
    };
  }
  if (type === 'flow:health') {
    return {
      executed: false,
      unsupported: false,
      routed: 'health',
      location: joinMountPath(publicBasePath, '/health'),
      notice: 'Workspace health is the existing /health probe. It is not delivery evidence.',
    };
  }
  return {
    executed: false,
    unsupported: false,
    routed: null,
    notice: 'Stage navigation and header actions do not start delivery.',
  };
}
