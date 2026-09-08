/**
 * Clean consumer proof for an independently installed @inspr/aithema-core artifact.
 *
 * This script must be copied INTO the consumer directory before it is run. Every
 * specifier is resolved first and asserted to live under that consumer's own
 * `node_modules`, so the proof cannot silently pass against monorepo source via
 * ESM self-reference, a parent `node_modules`, or NODE_PATH. With the dependency
 * absent, resolution fails and the process exits non-zero.
 *
 * Explicit labelled mock provider/identity only; no live provider or OIDC calls.
 */
import assert from 'node:assert/strict';

const CONSUMER_SPECIFIERS = [
  '@inspr/aithema-core',
  '@inspr/aithema-core/runtime',
  '@inspr/aithema-core/workspace',
  '@inspr/flow-shell',
  'unpdf',
];

/**
 * @returns {Record<string, string>} specifier -> resolved file URL
 */
function assertResolvedFromConsumerInstall() {
  const installRoot = new URL('node_modules/', import.meta.url).href;
  const resolved = {};
  for (const specifier of CONSUMER_SPECIFIERS) {
    const url = import.meta.resolve(specifier);
    if (!url.startsWith(installRoot)) {
      throw new Error(
        `${specifier} did not resolve from the consumer installation: ${url} (expected under ${installRoot})`,
      );
    }
    resolved[specifier] = url;
  }
  return resolved;
}

/**
 * @param {object} core
 * @param {object} identityInput
 */
function reviewedFixture(core, approver, contributor) {
  let stream = core.createStream('stream:consumer-proof', ['new_product']);
  stream = core.proposeRequirement(stream, contributor, {
    requirement_ref: 'req.consumer',
    statement: 'Clean install can export Straße café reviewed handover',
    acceptance_criteria: ['PDF, HTML, CSV, and JSON bind the same digest'],
    constraint_refs: [],
  });
  stream = core.approveBaselineFromProposals(
    stream,
    approver,
    stream.proposals.map((proposal) => proposal.proposal_ref),
    'baseline:consumer-v1',
    '2026-09-07T18:00:00.000Z',
  );
  const baseline = stream.baselines.at(-1);
  const identity = { baseline_ref: baseline.baseline_ref, revision: baseline.revision };
  const handover = core.exportReviewedHandover(stream, identity, '2026-09-07T18:05:00.000Z');
  return { stream, identity, handover };
}

async function main() {
  const resolved = assertResolvedFromConsumerInstall();

  const core = await import('@inspr/aithema-core');
  const runtime = await import('@inspr/aithema-core/runtime');
  const workspace = await import('@inspr/aithema-core/workspace');
  const { extractText, getDocumentProxy } = await import('unpdf');

  const approver = { party_ref: 'party:consumer-approver', roles: ['requirements_approver'] };
  const contributor = { party_ref: 'party:consumer-contributor', roles: ['delivery_party'] };

  const { stream, identity, handover } = reviewedFixture(core, approver, contributor);
  const csv = core.exportReviewedCsv(stream, identity, undefined, '2026-09-07T18:05:00.000Z');
  const html = core.exportReviewedHtml(handover);
  const pdf = await core.exportReviewedPdf(handover);
  assert.ok(csv.includes(handover.baseline.content_digest));
  assert.equal(html.includes('<script>'), false);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const extracted = await extractText(proxy, { mergePages: false });
    assert.match(extracted.text.join('\n'), /Straße café/);
  } finally {
    await proxy.loadingTask?.destroy?.();
  }

  let intakeTarget = core.createStream('stream:intake-target', ['new_product']);
  intakeTarget = core.proposeRequirement(intakeTarget, contributor, {
    requirement_ref: 'req.keep',
    statement: 'OLD',
    acceptance_criteria: ['check'],
    constraint_refs: [],
  });
  intakeTarget = core.approveBaselineFromProposals(
    intakeTarget,
    approver,
    intakeTarget.proposals.map((proposal) => proposal.proposal_ref),
    'baseline:intake-v1',
  );
  const imported = core.importReviewedOwnFormat(intakeTarget, contributor, handover);
  assert.ok(imported.stream.proposals.length >= 1);
  assert.ok(imported.added + imported.updated >= 1);

  const provider = runtime.createProviderFromRegistry({
    mode: 'demo',
    defaultProvider: 'mock',
    providers: {
      mock: { kind: 'mock', chunkDelayMs: 0 },
    },
  });
  assert.ok(provider instanceof runtime.MockLlmProvider);
  assert.equal(runtime.MOCK_PROVIDER_ID, 'mock');
  assert.match(runtime.MOCK_REPLY_MARK, /Demo \/ test provider/i);

  const config = workspace.normalizeWorkspaceConfig({
    mode: 'demo',
    listenHost: '127.0.0.1',
    listenPort: 0,
    dataDir: './.data',
    defaultProvider: 'mock',
    identity: {
      kind: 'demo',
      defaultSubject: 'demo-reviewer',
      memberships: [{
        subject: 'demo-reviewer',
        party_ref: 'party:demo-reviewer',
        actor_kind: 'human',
        roles: ['requirements_approver', 'delivery_party'],
        projects: [],
      }],
    },
    providers: {
      mock: { kind: 'mock', chunkDelayMs: 0 },
    },
  });
  assert.equal(config.labelledDemo, true);
  const page = workspace.renderWorkspacePage({
    mode: config.mode,
    labelledDemo: config.labelledDemo,
    providerLive: false,
    providerId: 'mock',
    demoSubjects: [{ subject: 'demo-reviewer', actor_kind: 'human' }],
  });
  assert.match(page, /Demo \/ mock/i);
  assert.match(page, /not live AI/i);
  assert.match(page, /<inspr-flow-shell /);
  assert.match(page, /workspace-flow-host\.js/);

  const full = core.exportHandoverJson(core.createStream('stream:json', ['new_product']));
  assert.equal(full.pending_proposals.length, 0);

  console.log(JSON.stringify({
    ok: true,
    digest: handover.baseline.content_digest,
    exports: ['json', 'csv', 'html', 'pdf'],
    mock_provider: runtime.MOCK_PROVIDER_ID,
    install_root: new URL('node_modules/', import.meta.url).href,
    resolved,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
