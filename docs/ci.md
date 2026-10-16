# CI runner use

Aithema runs on the organization's hosted runners. The organization is on GitHub
Enterprise (about 500 concurrent hosted jobs), and Aithema uses about 2 % of its
CI hours (measured baseline AEON-1407, 2026-10-15). All six browser shards run
at once for every event. Per-PR cancellation and the docs-only light path stay
because they save runner minutes.

The CI concurrency group is `ci-${{ github.event.pull_request.number || github.ref }}`.
A newer run for the same PR cancels the older run. `cancel-in-progress` is
true only for `pull_request`; merge queue and main push runs never request
in-progress cancellation. Queue runs use their group-specific
`refs/heads/gh-readonly-queue/...` ref, separate from PR numbers and main.
GitHub can still replace pending runs in a shared concurrency group; main
runs therefore serialize, and the guarantee concerns in-progress runs.

## Docs-only PRs

The `changes` job compares the PR's base/head with a three-dot Git diff.
Only a nonempty change confined to the explicit pure-prose allowlist
(`docs/ci.md`) takes the light path. All other files require full CI, including
`README.md` and `docs/embedding.md`, which the release pack consumes; the
embedding guide is also parsed by a unit test. Moving source files into docs
requires full CI too. The unit guard checks allowlisted paths against release
pack admission and references in test, release, and script consumers.
Detection errors fail the changes job and run all heavy checks. The heavy jobs
use `!cancelled()` so a failed dependency cannot silently skip required checks;
only successful PR detection with an explicit `true` output can skip heavy steps.

Six worker shards report `browser (1/6)` through `browser (6/6)`. The ruleset
keeps its existing `browser (1/4)` through `browser (4/4)` required checks; each
is a summary that passes only when every worker shard succeeds. A failed or
skipped shard fails the summaries. PR and merge-group events use the same jobs.

On the light path, `test` and every worker shard run an explicit success step.
They skip dependency installation, packaging,
unit tests and browsers. Their check names stay unchanged; no workflow-level
path filter leaves required checks pending. The separate `dco` and `dco-tests`
jobs still run normally, so docs contributions also need commit signoffs.
Merge queue and main push runs always take the full path, even for docs.
Repository rulesets and required-check settings are unchanged.

## Retry failed jobs

After a transient failure, use **Re-run failed jobs** in the GitHub Actions run.
This preserves successful job results and avoids spending runner minutes on them
again. Push a new commit when the source needs fixing; PR dedupe cancels the
superseded CI run. A docs-only follow-up PR can verify the light path by checking
that all five CI check jobs report success without installation or browser steps.

## Validation and references

`test/ci-slot-sharing.test.js` parses the workflow and checks concurrency,
full browser parallelism, stable check jobs, and step guards. It also executes the actual
detector against temporary Git histories, including test fixtures, mixed changes,
renames, unusual filenames, errors, and docs-only merge queue/main events.
The existing merge-queue tests check all seven required check names.
Run tests on the designated remote test machine or in PR CI.

GitHub documents
[conditional cancellation and pending-run replacement](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency),
and [merge queue temporary branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
Validate workflow syntax and expression types with pinned `actionlint` v1.7.7;
no repository dependency or installation is needed.

Browser launches use a 60 s default per attempt (caller overrides preserved), with exactly one retry for a startup timeout only, after process/profile cleanup; page and test failures are never retried. The bound adds headroom above the 30 s failure in run [38788184134](https://github.com/inspr-at/aithema/actions/runs/38788184134); recent run [38795278547](https://github.com/inspr-at/aithema/actions/runs/38795278547) logged admin launches of 718.973, 42.021 and 56.389 ms. Run [38794838496](https://github.com/inspr-at/aithema/actions/runs/38794838496) also recorded 10,984.398, 172.377 and 180.271 ms, demonstrating contention well above the subsecond baseline; 60 s is about 5.5 times that observed maximum and twice the failed bound. Each attempt uses an isolated temporary profile under the caller's `userDataDir` (or the system temp directory).

## Browser shard weights

Every `test/browser/<name>.test.js` owns a sibling `<name>.weight.json`:

```json
{
  "seconds": 90,
  "evidence": "CI 38774634960-1: 76.396s; rounded up + 10s margin"
}
```

Sibling files keep additions and refreshes independent of a shared manifest and
avoid changing executable tests just to refresh timings. Discovery reads each
sibling; missing files, malformed JSON, nonpositive seconds or empty evidence
fail the shard guard with the offending path. No shared list needs editing.
Orphaned `.weight.json` files also fail the guard; remove or rename the sibling measurement when removing or renaming a test.

For a new file, measure it on the designated remote test machine or CI and
record the run/attempt and observed seconds. Sum top-level test durations only;
nested subtests are already included. Follow AIT-191: use the slowest observed
successful per-file duration, round **up** to a 10-second bucket, then add 10s
for variance (`Math.ceil(slowestSeconds / 10) * 10 + 10`). On refresh, retain
slower historical observations and never reduce an existing planning weight
because a newer run is faster. Preserve the historical floor and measurement
provenance in `evidence`. Estimates exclude setup, process overhead and evidence
upload; validate whole-job wall time against the 450s budget separately.

`test/browser-shards.test.js` checks weight parsing, missing weights and stale measurements.
Adding a browser test requires only its own sibling `.weight.json`; refreshing a
measurement edits only that sibling file. Algorithm unit tests use inline data,
so neither operation requires updating a shared fixture.

AIT-216 migration evidence (one-time comparison on mbp2606 against the legacy
literal in merge base `8d52ace2d36c1e8d40bcd2d738e1db5d7ad04cb7`):
`28/28 equal; identical layout (shard membership/order and totals)`.
Projected totals were `490 / 500 / 480 / 480` seconds. The legacy and current
packing function bodies were identical. This records migration identity, not a
permanent constraint on future test additions or measured weight refreshes.
