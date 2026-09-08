import { currentBaseline } from '../lib/stream.js';
import { pendingProposalList } from '../runtime/controller.js';
import { escapeHtml } from './config.js';

/**
 * Neutral workspace HTML. User content and AI output are escaped text only.
 * @param {{
 *   mode: string,
 *   labelledDemo: boolean,
 *   providerLive: boolean,
 *   providerId: string,
 *   actor: import('../runtime/identity.js').VerifiedActor | null,
 *   projects?: readonly { project_ref: string, title: string }[],
 *   project?: object | null,
 *   notice?: string,
 *   error?: string,
 * }} model
 */
export function renderWorkspacePage(model) {
  const demoBanner = model.labelledDemo
    ? `<p class="banner demo" role="status"><strong>Demo / mock</strong> — labelled loopback identity${
      model.providerLive ? '; configured adapter, not live production' : '; not live AI'
    }.</p>`
    : '';

  if (model.project) {
    return renderProjectPage(model, demoBanner);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Requirements workspace</title>
  ${sharedStyles()}
</head>
<body>
  ${demoBanner}
  <h1>Requirements workspace</h1>
  <p>Conversation builds an evolving understanding and unapproved proposals. Only a mapped human reviewer can confirm a baseline.</p>
  ${model.error ? `<p class="error">${escapeHtml(model.error)}</p>` : ''}
  ${model.notice ? `<p class="notice">${escapeHtml(model.notice)}</p>` : ''}
  ${model.actor ? renderSignedInHome(model) : renderSignIn(model)}
</body>
</html>`;
}

function sharedStyles() {
  return `<style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; max-width: 100%; }
    body { margin: 0 auto; width: min(52rem, 100%); padding: 1rem; line-height: 1.45; }
    h1, h2, h3, p, li, label, a, .meta, .wrap, .banner, .error, .notice { overflow-wrap: anywhere; word-break: break-word; }
    .banner { padding: .5rem .75rem; margin: 0 0 .75rem; border: 1px solid #8a5a00; background: #fff4d6; font-size: .9rem; }
    .error { padding: .75rem 1rem; border: 2px solid #8a1f1f; background: #fde8e8; }
    .notice { padding: .75rem 1rem; border: 1px solid #1f4f8a; background: #e8f1fd; }
    section { margin: 1rem 0; padding: .75rem 0; border-top: 1px solid #ccc; }
    section.primary { border-top: none; padding-top: 0; }
    pre, .turn, .digest { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; }
    .turn { margin: .5rem 0; padding: .5rem .75rem; background: #f4f4f4; }
    .assistant { background: #eef2ea; }
    label { display: block; margin: .35rem 0; }
    input, textarea, select, button { max-width: 100%; }
    textarea { width: 100%; min-height: 4.5rem; }
    .meta { color: #333; font-size: .9rem; }
    button, .button { font: inherit; padding: .4rem .8rem; }
    details.secondary { margin: .75rem 0; padding: .35rem 0; border-top: 1px solid #ddd; }
    details.secondary > summary { cursor: pointer; font-weight: 600; }
    .project-title { margin: 0 0 .5rem; font-size: 1.35rem; }
    .next-question { margin: .5rem 0 1rem; padding: .75rem; background: #f8f9fc; border-left: 3px solid #1f4f8a; }
  </style>`;
}

function renderProjectPage(model, demoBanner) {
  const project = model.project;
  const pending = pendingProposalList(project.stream);
  const understanding = project.understanding;
  const turns = (project.transcript ?? []).map((entry) => (
    `<div class="turn ${escapeHtml(entry.role)}"><strong>${escapeHtml(entry.role)}</strong>
      <pre>${escapeHtml(entry.content)}</pre></div>`
  )).join('');
  const facts = (understanding?.facts ?? []).map((fact) => (
    `<li><strong>${escapeHtml(fact.key)}</strong>: ${escapeHtml(fact.value)}</li>`
  )).join('');
  const open = (understanding?.open_questions ?? []).map((q) => `<li>${escapeHtml(q)}</li>`).join('');
  const proposals = pending.map((proposal) => {
    const body = proposal.requirement
      ? `${proposal.requirement.requirement_ref}: ${proposal.requirement.statement}`
      : proposal.summary;
    return `<label><input type="checkbox" name="proposal_refs" value="${escapeHtml(proposal.proposal_ref)}">
      ${escapeHtml(proposal.kind)} — ${escapeHtml(body)}</label>`;
  }).join('');
  const canReview = model.actor.actor_kind === 'human' && model.actor.roles.includes('requirements_approver');
  const next = understanding?.next_question
    ? `<div class="next-question"><strong>Focused next question:</strong> ${escapeHtml(understanding.next_question)}</div>`
    : '<p class="meta">No focused next question yet.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)}</title>
  ${sharedStyles()}
</head>
<body>
  ${demoBanner}
  <h1 class="project-title">${escapeHtml(project.title)}</h1>
  ${model.error ? `<p class="error">${escapeHtml(model.error)}</p>` : ''}
  ${model.notice ? `<p class="notice">${escapeHtml(model.notice)}</p>` : ''}
  <section class="primary">
    ${next}
    <form method="post" action="/projects/${encodeURIComponent(project.project_ref)}/turns">
      <input type="hidden" name="expected_revision" value="${escapeHtml(String(project.revision))}">
      <label>Your message <textarea name="message" required maxlength="8000"></textarea></label>
      <button type="submit">Send</button>
    </form>
  </section>
  <section>
    <h2>Pending proposals</h2>
    <p class="meta">Unapproved — selecting them does not start delivery.</p>
    ${pending.length && canReview ? `
      <form method="post" action="/projects/${encodeURIComponent(project.project_ref)}/review">
        <input type="hidden" name="expected_revision" value="${escapeHtml(String(project.revision))}">
        ${proposals}
        <button type="submit" name="action" value="approve">Approve selected into a new baseline</button>
        <button type="submit" name="action" value="reject">Reject selected</button>
      </form>` : pending.length
    ? `<div>${proposals || ''}</div><p class="meta">Only a mapped human reviewer can approve or reject.</p>`
    : '<p class="meta">No pending proposals.</p>'}
  </section>
  <section>
    <h2>Reviewed baseline</h2>
    ${renderReviewedExports(project)}
  </section>
  <details class="secondary">
    <summary>Conversation history</summary>
    ${turns || '<p class="meta">No turns yet.</p>'}
  </details>
  <details class="secondary">
    <summary>Evolving understanding</summary>
    <p>${escapeHtml(understanding?.summary ?? 'Understanding updates after a complete assistant turn.')}</p>
    <ul>${facts}</ul>
    <h3>Open questions</h3>
    <ul>${open || '<li>None recorded.</li>'}</ul>
  </details>
  ${renderSecondaryControls(model)}
</body>
</html>`;
}

function renderSignIn(model) {
  if (!model.labelledDemo) {
    return '<p>Production identity uses a configured JWT/JWKS gateway. Send an <code>Authorization: Bearer</code> token from the operator-issued OIDC session. There is no permissive production login form.</p>';
  }
  const options = (model.demoSubjects ?? []).map((entry) => (
    `<option value="${escapeHtml(entry.subject)}">${escapeHtml(entry.subject)} (${escapeHtml(entry.actor_kind)})</option>`
  )).join('');
  return `<form method="post" action="/session/demo">
    <p>Choose a configured demo actor. Roles are server-mapped and cannot be declared in the browser.</p>
    <label>Demo actor
      <select name="subject">${options}</select>
    </label>
    <button type="submit">Continue with labelled demo identity</button>
  </form>`;
}

function renderSignedInHome(model) {
  return `${renderProjectNav(model, false)}${renderIdentityDetails(model)}`;
}

function renderProjectNav(model, collapsed) {
  const list = (model.projects ?? []).map((project) => (
    `<li><a class="wrap" href="/projects/${encodeURIComponent(project.project_ref)}">${escapeHtml(project.title)}</a></li>`
  )).join('');
  const form = `<form method="post" action="/projects">
      <label>Title <input name="title" required maxlength="200"></label>
      <p>Project kinds are not mutually exclusive:</p>
      <label><input type="checkbox" name="project_kinds" value="new_product" checked> new product</label>
      <label><input type="checkbox" name="project_kinds" value="iteration" checked> iteration</label>
      <label><input type="checkbox" name="project_kinds" value="integration"> integration</label>
      <button type="submit">Create project</button>
    </form>`;
  if (!collapsed) {
    return `
  <section>
    <h2>Projects</h2>
    <ul>${list || '<li>No projects yet.</li>'}</ul>
    ${form}
  </section>`;
  }
  return `
  <details class="secondary">
    <summary>Projects and new work</summary>
    <ul>${list || '<li>No projects yet.</li>'}</ul>
    ${form}
  </details>`;
}

function renderIdentityDetails(model) {
  if (!model.actor) return '';
  return `
  <details class="secondary">
    <summary>Identity and access</summary>
    <p class="meta wrap">Subject ${escapeHtml(model.actor.subject)} · party ${escapeHtml(model.actor.party_ref)} · actor kind <strong>${escapeHtml(model.actor.actor_kind)}</strong> · roles ${escapeHtml(model.actor.roles.join(', '))}</p>
    <p>Access is the current verified membership for this subject. Sharing a party name does not share project access. Only a mapped human reviewer can approve a baseline.</p>
  </details>`;
}

function renderSecondaryControls(model) {
  const project = model.project;
  const baseline = project ? currentBaseline(project.stream) : null;
  return `${renderDocumentIntake(model)}${renderProjectNav(model, true)}${renderIdentityDetails(model)}${renderRevisionDetails(model, baseline)}${renderWorkspaceExplainer(model)}`;
}

function renderWorkspaceExplainer(model) {
  return `
  <details class="secondary">
    <summary>About this workspace</summary>
    <p>Conversation builds an evolving understanding and unapproved proposals. Only a mapped human reviewer can confirm a baseline. AI cannot approve or start delivery. Product, iteration, and integration may overlap.</p>
    <p class="meta">Provider: ${escapeHtml(model.providerId)} (${model.providerLive ? 'configured adapter' : 'labelled mock — not live AI'})</p>
    ${model.project
    ? `<p class="meta wrap">Kinds: ${escapeHtml(model.project.project_kinds.join(', '))}</p>`
    : ''}
  </details>`;
}

function renderRevisionDetails(model, baseline) {
  const project = model.project;
  if (!project) return '';
  return `
  <details class="secondary">
    <summary>Revision and handover identifiers</summary>
    <p class="meta wrap">Project ${escapeHtml(project.project_ref)} · revision ${escapeHtml(String(project.revision))} · conversation ${escapeHtml(project.conversation_ref)}</p>
    ${baseline
    ? `<p class="digest wrap">baseline_ref ${escapeHtml(baseline.baseline_ref)} · digest ${escapeHtml(baseline.content_digest)} · seal ${escapeHtml(baseline.revision_seal)}</p>
      <p class="meta">Full stream handover includes pending proposals. Reviewed portable exports bind one approved revision and omit unapproved notes.</p>
      <p><a class="button" href="/projects/${encodeURIComponent(project.project_ref)}/handover.json">Download JSON handover</a>
         <a class="button" href="/projects/${encodeURIComponent(project.project_ref)}/handover.csv">Download CSV handover</a></p>`
    : '<p class="meta">No approved baseline yet.</p>'}
  </details>`;
}

function renderReviewedExports(project) {
  const baselines = project.stream?.baselines ?? [];
  if (!baselines.length) {
    return '<p class="meta">No approved baseline yet.</p>';
  }
  const current = baselines.at(-1);
  const earlier = baselines.slice(0, -1);
  return `
    <p class="meta">A reviewed baseline is on record. Downloads bind this exact baseline_ref and revision.</p>
    ${exportLinkRow(project.project_ref, current)}
    ${earlier.length ? `
      <details class="secondary">
        <summary>Earlier reviewed revisions</summary>
        ${earlier.map((item) => exportLinkRow(project.project_ref, item)).join('')}
      </details>` : ''}`;
}

function exportLinkRow(projectRef, baseline) {
  const base = `/projects/${encodeURIComponent(projectRef)}/export?baseline_ref=${encodeURIComponent(baseline.baseline_ref)}&revision=${encodeURIComponent(String(baseline.revision))}`;
  return `<p class="meta wrap">revision ${escapeHtml(String(baseline.revision))} · ${escapeHtml(baseline.baseline_ref)}</p>
    <p>
      <a class="button" href="${base}&format=json">JSON</a>
      <a class="button" href="${base}&format=csv">CSV</a>
      <a class="button" href="${base}&format=html">HTML</a>
      <a class="button" href="${base}&format=pdf">PDF</a>
    </p>`;
}

function renderDocumentIntake(model) {
  const project = model.project;
  if (!project) return '';
  const docs = (project.documents ?? []).map((doc) => {
    const status = doc.extraction_reason === 'ok'
      ? (doc.truncated ? 'readable, truncated' : 'readable')
      : doc.extraction_reason;
    const interpret = doc.source_kind !== 'own_format' && doc.extraction_reason === 'ok'
      ? `<form method="post" action="/projects/${encodeURIComponent(project.project_ref)}/documents/${encodeURIComponent(doc.document_ref)}/interpret">
          <input type="hidden" name="expected_revision" value="${escapeHtml(String(project.revision))}">
          <button type="submit">Interpret into proposals</button>
        </form>`
      : doc.source_kind === 'own_format'
        ? '<p class="meta">Own-format JSON was proposed on upload and still needs human approval.</p>'
        : '';
    return `<li>
      <p class="wrap">${escapeHtml(doc.filename)} · ${escapeHtml(doc.media_type)} · ${escapeHtml(status)}</p>
      ${interpret}
    </li>`;
  }).join('');
  return `
  <details class="secondary">
    <summary>Document intake</summary>
    <p class="meta">Own-format JSON is validated and becomes unapproved proposals. Other text/CSV/JSON/XML/PDF files keep extracted text only until you Interpret. Raw uploads are not stored.</p>
    <form method="post" action="/projects/${encodeURIComponent(project.project_ref)}/documents" enctype="multipart/form-data">
      <input type="hidden" name="expected_revision" value="${escapeHtml(String(project.revision))}">
      <label>Files
        <input type="file" name="files" multiple accept=".json,.csv,.txt,.xml,.pdf,application/json,text/csv,text/plain,application/xml,text/xml,application/pdf">
      </label>
      <button type="submit">Upload for review</button>
    </form>
    <ul>${docs || '<li class="meta">No documents yet.</li>'}</ul>
  </details>`;
}
