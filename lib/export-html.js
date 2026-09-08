/** @import { Baseline, Constraint, Requirement, RequirementsHandover } from './types.js' */
import { escapeHtml } from './text.js';
import { reviewedHandoverIdentity } from './portable.js';

/**
 * Standalone self-contained HTML for one reviewed baseline. No scripts,
 * event handlers, or external asset/url fetches. User/model strings are text.
 * @param {RequirementsHandover} handover
 */
export function exportReviewedHtml(handover) {
  const identity = reviewedHandoverIdentity(handover);
  const baseline = handover.baseline;
  const requirements = baseline.requirements.map((requirement) => requirementSection(requirement)).join('');
  const constraints = baseline.constraints.length
    ? baseline.constraints.map((constraint) => constraintRow(constraint)).join('')
    : '<tr><td colspan="3">None recorded in this reviewed snapshot.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reviewed handover ${escapeHtml(identity.baseline_ref)} r${escapeHtml(String(identity.revision))}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, "Noto Sans", "DejaVu Sans", sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; }
    body { margin: 0 auto; width: min(52rem, 100%); padding: 1rem; line-height: 1.45; color: #111; background: #fff; }
    h1, h2, p, td, th, li, .wrap { overflow-wrap: anywhere; word-break: break-word; }
    h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
    h2 { font-size: 1.1rem; margin: 1.25rem 0 .5rem; page-break-after: avoid; }
    .meta { font-size: .9rem; color: #222; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #ccc; padding: .4rem .5rem; vertical-align: top; text-align: left; }
    th { background: #f4f4f4; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    .claim { font-size: .85rem; }
    @media print {
      body { width: auto; }
      a { color: inherit; text-decoration: none; }
      h2 { page-break-after: avoid; }
      section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>Reviewed requirements handover</h1>
  <p class="meta wrap">stream_ref ${escapeHtml(handover.stream_ref)}</p>
  <p class="meta wrap">baseline_ref ${escapeHtml(identity.baseline_ref)}</p>
  <p class="meta wrap">revision ${escapeHtml(String(identity.revision))}</p>
  <p class="meta wrap">content_digest ${escapeHtml(identity.content_digest)}</p>
  <p class="meta wrap">revision_seal ${escapeHtml(identity.revision_seal)}</p>
  <p class="claim wrap">Recorded approval claim: approved_by ${escapeHtml(baseline.approved_by)} at ${escapeHtml(baseline.approved_at)}. This claim is not imported authority.</p>
  <p class="claim">Unapproved proposals, conversation notes, provider configuration, and identity maps are excluded.</p>
  <p class="meta">Exported at ${escapeHtml(handover.exported_at)}</p>
  <h2>Requirements</h2>
  ${requirements}
  <h2>Constraints</h2>
  <table>
    <thead><tr><th>constraint_ref</th><th>kind</th><th>statement</th></tr></thead>
    <tbody>${constraints}</tbody>
  </table>
</body>
</html>
`;
}

/**
 * @param {Requirement} requirement
 */
function requirementSection(requirement) {
  const criteria = requirement.acceptance_criteria
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
  const refs = requirement.constraint_refs.length
    ? requirement.constraint_refs.map((ref) => escapeHtml(ref)).join(', ')
    : 'None';
  return `<section>
    <h2 class="wrap">${escapeHtml(requirement.requirement_ref)}</h2>
    <p class="wrap">${escapeHtml(requirement.statement)}</p>
    <p class="meta">Acceptance criteria</p>
    <ul>${criteria}</ul>
    <p class="meta wrap">constraint_refs: ${refs}</p>
  </section>`;
}

/**
 * @param {Constraint} constraint
 */
function constraintRow(constraint) {
  return `<tr>
    <td class="wrap">${escapeHtml(constraint.constraint_ref)}</td>
    <td class="wrap">${escapeHtml(constraint.kind)}</td>
    <td class="wrap">${escapeHtml(constraint.statement)}</td>
  </tr>`;
}

/**
 * Guardrail for tests and QA: exported HTML must not carry active script or
 * external fetches. Presence of these tokens means the exporter leaked markup.
 * @param {string} html
 */
export function htmlExportHasActiveContent(html) {
  const lower = html.toLowerCase();
  if (lower.includes('<script')) return true;
  if (/href\s*=\s*['"]?\s*javascript:/i.test(html)) return true;
  if (/\son[a-z]+\s*=/i.test(html)) return true;
  if (/url\s*\(\s*['"]?\s*https?:/i.test(html)) return true;
  if (/<(iframe|object|embed|link|img)\b/i.test(html)) return true;
  return false;
}
