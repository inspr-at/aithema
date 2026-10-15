// AIT-192: CI artifact directories must not accidentally enable the full matrix.
// Nightly invokes the browser command with CI unset and an evidence directory.
export const fullMatrix = Boolean(process.env.AITHEMA_EVIDENCE_DIR) && !process.env.CI;

// Keep every state in each original locale/theme. A state group includes any
// transitions whose geometry must be compared at the same width. Group offsets
// rotate widths across states; both locales use the same width so cross-locale
// geometry comparisons remain meaningful. Full evidence retains the old product.
export function matrixWidths(widths, theme, stateGroup = 0, group) {
  const original = matrixGroupWidths[group];
  if (!original || JSON.stringify(widths) !== JSON.stringify(original)) {
    throw new Error(`${group} width coverage: expected ${JSON.stringify(original)}, received ${JSON.stringify(widths)}`);
  }
  if (fullMatrix) return widths;
  // AIT-192 round 2: the measured endpoint floor exceeds Tick's 30s/job
  // allowance. Width-specific F1/L2/zero-shift DOM sweeps never use rotation.
  return [widths[(stateGroup + Number(theme === 'dark')) % widths.length]];
}

// Validate the original call-site width list even when PR rotation would
// select the same number of widths after a deletion.
export const matrixGroupWidths = Object.freeze({
  'display-band': [390, 1024, 1440],
  'display-account': [1440, 390, 320],
  'display-settings-footer': [1440, 390],
  'display-settings-email': [1440, 390],
  'display-canvas': [390, 1024, 1440],
  'display-orb': [390, 1024, 1440],
  'display-held': [1440, 390, 1024],
  'display-notices': [1440, 1024, 390],
  'integrated-flow': [390, 1024, 1440],
  'integrated-narrow': [320, 600, 680, 768, 900, 1000],
  'continuity': [1440, 1024, 390],
  'confirmation-mail': [600, 375],
  'confirmation-landing': [390, 1440],
  'mail-reservation': [390, 1024, 1440],
  'mail-latch': [390, 1024, 1440],
  'email-ask': [390, 1024, 1440],
  'email-ask-folded': [1024, 1440],
  'visitor-credit': [1440, 1024, 390],
});

// Fixed contracts count observed cases AFTER their assertions. Do not derive
// these expectations from the loops/state lists they protect. Both PR and
// nightly execute these guards, including when screenshots are disabled.
export const matrixCaseTotals = Object.freeze({
  'display-band': { full: 24, ci: 8 },
  'display-account': { full: 24, ci: 8 },
  'display-settings-footer': { full: 32, ci: 16 },
  'display-settings-email': { full: 24, ci: 12 },
  'display-canvas': { full: 48, ci: 16 },
  'display-orb': { full: 12, ci: 4 },
  'display-held': { full: 36, ci: 12 },
  'display-notices': { full: 120, ci: 40 }, // eight notice/dialog states + two waiting tooltips
  'integrated-flow': { full: 272, ci: 90 },
  'integrated-narrow': { full: 120, ci: 20 },
  'continuity': { full: 72, ci: 24 },
  'confirmation-mail': { full: 8, ci: 4 },
  'confirmation-landing': { full: 72, ci: 36 },
  'mail-reservation': { full: 156, ci: 52 },
  'mail-latch': { full: 60, ci: 20 },
  'email-ask': { full: 296, ci: 100 },
  'visitor-credit': { full: 444, ci: 148 },
});

export function assertMatrixCaseCount(group, actual, mode = fullMatrix ? 'full' : 'ci') {
  const totals = matrixCaseTotals[group];
  if (!totals) throw new Error(`Unknown matrix group: ${group}`);
  if (!Object.hasOwn(totals, mode) || actual !== totals[mode]) {
    throw new Error(`${group} ${mode} case coverage: expected ${totals[mode]}, executed ${actual}`);
  }
}

// Full evidence always uses the original width lists at each call site.
// The table above is an executable state/result contract, not a planned matrix.
