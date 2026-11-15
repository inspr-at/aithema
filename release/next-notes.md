# Next release — unreleased

## Host notes

- AIT-514: the existing `copy.summary` heading is visible with new EN/DE defaults,
  “What we understood so far” / “Unser Verständnis bisher”. Host overrides win.
- Additive `copy.summaryMore`: “Read more” / “Mehr anzeigen”; shared
  `copy.showLess`: “Show less” / “Weniger anzeigen”. Missing keys use locale
  fallbacks. Long summaries use a measured height-aware clamp and fade: nine
  lines in tall panes, otherwise three to nine whole lines based on the pane,
  heading, toggle and first signal, remeasured on resize, font and locale changes.
  If three lines still leave the first signal below the fold (1024×640), the
  clamp stays at three and the signal remains reachable by scrolling the pane.
  The native expand/collapse button is accessible. Expansion survives rewrites within
  the mounted conversation and resets on a different conversation or erasure.
- Summary and signal prompt guidance now addresses the visitor with “you” / “Sie”
  while preserving quoted evidence. No schema, event, option or export change.
