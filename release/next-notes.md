# Next release — unreleased

## Host notes

- AIT-514: the existing `copy.summary` heading is visible with new EN/DE defaults,
  “Understood so far” / “Bisher verstanden”. Host overrides win.
- Additive `copy.summaryMore`: “Read more” / “Mehr anzeigen”; shared
  `copy.showLess`: “Show less” / “Weniger anzeigen”. Missing keys use locale
  fallbacks. Long summaries use a measured height-aware clamp and fade: nine
  lines in tall panes, otherwise three to nine whole lines based on the pane,
  heading row, first signal and the active 44 px bottom fade, remeasured on
  resize, font and locale changes.
  If three lines still leave the first signal below the fold (1024×640), the
  clamp stays at three and the signal remains reachable by scrolling the pane.
  The accessible native expand/collapse button stays beside the heading in both
  states. Expansion survives rewrites within
  the mounted conversation and resets on a different conversation or erasure.
- Summary and signal prompt guidance now addresses the visitor with “you” / “Sie”
  while preserving quoted evidence. No schema, event, option or export change.
