# Next release — unreleased

## Host notes

- AIT-514: the existing `copy.summary` heading is visible with new EN/DE defaults,
  “What we understood so far” / “Unser Verständnis bisher”. Host overrides win.
- Additive `copy.summaryMore`: “Read more” / “Mehr anzeigen”; shared
  `copy.showLess`: “Show less” / “Weniger anzeigen”. Missing keys use locale
  fallbacks. Long summaries use a measured nine-line clamp and fade with an
  accessible native expand/collapse button. Expansion survives rewrites within
  the mounted conversation and resets on a different conversation or erasure.
- Summary and signal prompt guidance now addresses the visitor with “you” / “Sie”
  while preserving quoted evidence. No schema, event, option or export change.
