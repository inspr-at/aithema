// AIT-192: CI artifact directories must not accidentally enable the full matrix.
// Nightly invokes the browser command with CI unset and an evidence directory.
export const fullMatrix = Boolean(process.env.AITHEMA_EVIDENCE_DIR) && !process.env.CI;

// Keep every state in each original locale/theme. A state group includes any
// transitions whose geometry must be compared at the same width. Group offsets
// rotate widths across states; both locales use the same width so cross-locale
// geometry comparisons remain meaningful. Full evidence retains the old product.
export function matrixWidths(widths, theme, stateGroup = 0) {
  return fullMatrix ? widths : [widths[(stateGroup + Number(theme === 'dark')) % widths.length]];
}

// Old case -> new coverage mapping (AIT-192):
// Each original locale/theme/state/assertion is retained. CI chooses index
// (group + dark) % widths.length; nightly/full evidence chooses EVERY old width.
// Related transitions stay together so their original geometry baselines hold.
//
// File/group                             Old widths          CI group
// start2-display: opaque band             390/1024/1440       0
//   account folded/unfolded               1440/390/320        1
//   Settings footer: all 4 identities     1440/390            2
//   Settings email: all 3 identities      1440/390            3
//   canvas revocation: cause x folded     390/1024/1440       4
//   orb hit area                          390/1024/1440       5
//   held call / waiting / reload          1440/390/1024       7
//   all recovery/reply/tooltip states     1440/1024/390       8
//   clipboard + medium menu sweeps        original widths     ALL (unchanged)
// start2-display-matrix: full state flow  390/1024/1440       0
//   narrow footer/popups                  320/600/680/768/900/1000  1
//   geometry entry point                  original widths     ALL (unchanged)
// visitor-credit-tiers: all old DE + EN   1440/1024/390       2
//   (the former -en file now runs in visitor-credit-tiers.test.js)
// continuity: takeover/wake/restart flow  1440/1024/390       0
//   delayed-greeting regression           1024                unchanged
// confirmation: mail                     600/375             0
//   ready -> busy -> confirmed + variants 390/1440            1
//   320 no-style / reduced motion / no JS original             unchanged
// email-mail-space: reservation/save/mail 390/1024/1440       0
//   delayed/failed/policy-flip latch       390/1024/1440       1
//   loading status + privacy comparisons  original widths     ALL (unchanged)
// email-ask: each fixture group advances  390/1024/1440       0,1,2,...
//   before -> gate -> typing -> invalid -> saving -> saved -> dismissed = 0
//   mail -> saved-mail = 1; save-failed = 2; delivery-failed = 3
//   low-text/voice/given/confirmed/pending/out = 4..9
//   folded = 10 (CI chooses from 1024/1440 to keep folded in both locales)
//   footer digits / typing / stream / call -> low -> ended = 11..14
//   Both themes are asserted/captured at every state, after fixture setup.
//   Settings confirmation + privacy cases retain their original widths.
//
// Visible CI evidence changes: width subsets only for the groups above.
// Names/prefixes remain ait155-band, r3-demo-account, ait-147-settings-general,
// r3-settings-email/r3-verify-from-settings, folded-populated-canvas/revocation,
// orb-hit-area-open, ait-138/ait-138-c/ait-138-d, display/reveal/footer/menu,
// a2, c2-mail/c2-landing, ait-171, and ait164. The a2 pass manifest is now
// a2-de-en-pass-lines.json (formerly separate a2-de and a2-en manifests).
// Full nightly/evidence retains all old screenshot combinations and assertions.
