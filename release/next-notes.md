# Next release — unreleased

## Host notes

- AIT-532: CI and nightly browser capacity expands from nine to twelve shards.
  A parallel `browser` aggregate requires the complete matrix to succeed;
  docs-only and verified duplicate-main pushes report explicit worker success.
  Both browser summaries retain `!cancelled()` and accept skipped workers only
  for verified first-attempt duplicate main pushes; PRs and merge groups require
  successful workers.
  The four required `browser (n/4)` aliases remain during the transition.
  The new aggregate is initially optional; DEVOPS changes the ruleset only after
  owner approval, and aliases can be removed only after the coordinator confirms
  the switch. No GitHub settings change in this delivery. Timing/evidence artifact
  names use `N-of-12`, with historical timing imports retained. The 405 s planner
  target and 420 s hard ceiling are unchanged. There is no host API change.
