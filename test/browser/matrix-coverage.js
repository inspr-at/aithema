// AIT-192: CI artifact directories must not accidentally enable the full matrix.
// Nightly invokes the browser command with CI unset and an evidence directory.
export const fullMatrix = Boolean(process.env.AITHEMA_EVIDENCE_DIR) && !process.env.CI;

// Keep every state in each original locale/theme. A state group includes any
// transitions whose geometry must be compared at the same width. Group offsets
// rotate widths across states; both locales use the same width so cross-locale
// geometry comparisons remain meaningful. Full evidence retains the old product.
export function matrixWidths(widths, theme, stateGroup = 0) {
  if (fullMatrix) return widths;
  // Tick's PR floor: endpoints stay; only the intermediate widths rotate.
  const middle = widths.filter(width => width !== 390 && width !== 1440);
  return [...new Set([390, 1440, ...(middle.length ? [middle[(stateGroup + Number(theme === 'dark')) % middle.length]] : [])])];
}

// Fixed contracts count observed cases AFTER their assertions. Do not derive
// these expectations from the loops/state lists they protect. Both PR and
// nightly execute these guards, including when screenshots are disabled.
export const matrixCaseTotals = Object.freeze({
  'display-band': { full: 24, ci: 24 },
  'display-account': { full: 24, ci: 24 },
  'display-settings-footer': { full: 32, ci: 32 },
  'display-settings-email': { full: 24, ci: 24 },
  'display-canvas': { full: 48, ci: 48 },
  'display-orb': { full: 12, ci: 12 },
  'display-held': { full: 36, ci: 36 },
  'display-notices': { full: 108, ci: 108 },
  'integrated-flow': { full: 272, ci: 272 },
  'integrated-narrow': { full: 120, ci: 60 },
  'continuity': { full: 72, ci: 72 },
  'confirmation-mail': { full: 8, ci: 12 },
  'confirmation-landing': { full: 72, ci: 72 },
  'mail-reservation': { full: 156, ci: 156 },
  'mail-latch': { full: 60, ci: 60 },
  'email-ask': { full: 296, ci: 296 },
  'visitor-credit': { full: 444, ci: 444 },
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
