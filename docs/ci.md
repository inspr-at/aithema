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

Every `test/browser/<name>.test.js` owns a sibling `<name>.weight.json`.
The `seconds` value is the sum of **measured per-test rolling p95** durations,
with a **25% safety margin while a workload has fewer than five samples**.
At five or more samples the planner uses the measured sum directly. Packing remains
deterministic LPT across **six** bins. `npm run test:browser-shards` checks
complete, exactly-once coverage and the **420 s per-bin ceiling**; this leaves
headroom for installation, Chrome startup, process cleanup and artifact upload
within the unchanged ten-minute job timeout. Required check names stay unchanged.

Each CI shard writes `browser-timings-N-of-6` artifacts (14-day retention).
`scripts/browser-timing-reporter.js` records passing top-level `node:test`
durations in seconds alongside the run ID, attempt, commit and workload hash.
Nested subtests are excluded because their parent's duration already includes
them. Failed, cancelled, skipped, todo or incomplete batches cannot enter the
measurement set. Remote runs remain useful for profiling and UI evidence;
GitHub CI is the planner's comparable timing source.

Refresh from the latest 20 successful canonical main push CI runs:

```sh
npm run update:browser-timings
npm run update:browser-timings -- --run RUN_ID --run ANOTHER_RUN_ID
npm run test:browser-shards
```

The script downloads only the small timing artifacts through the selected `gh`
account, pinned to `inspr-at/aithema`. Both automatic selection and explicit
`--run` imports require a successful `push` event on `main` in that repository,
with `head_repository.full_name == inspr-at/aithema` and the CI workflow path.
GitHub's compare API must confirm that the head SHA is an ancestor of current
canonical main. Every artifact's workflow run ID, head repository ID, branch and
SHA must match the verified run; every JSONL header must match its run ID,
attempt and SHA. PR, pull_request_target, fork and merge-group runs are rejected.
Local `--artifacts` imports are no longer accepted because local bytes cannot
prove their origin. It validates all input before writing siblings, deduplicates
run/attempt
pairs, and retains the latest 20 successful executions **per workload**. For each
top-level test it selects sorted observation `ceil(0.95 * n)` (nearest rank),
then sums those p95 values for the file, rounding upward only to millisecond
precision. For fewer than five samples, it multiplies that measured sum by 1.25
and rounds upward to milliseconds. At five or more samples no margin is added.
The sample count and full provenance remain visible.

The workload hash covers the test plus transitive statically referenced helpers
and fixtures under `test/`. Changing those inputs starts a fresh series when a
matching trusted CI artifact arrives; the new series immediately regains the
25% margin until it has five samples. Old workloads are not permanent floors.
Product implementation changes remain in the rolling window. Artifacts
for older workload hashes are ignored, and files without matching observations
stay unchanged. Review sibling changes with the code, then commit the generated
measurements. New files need a measured sibling before joining the required
suite. The pre-policy PR calibration below is explicitly bootstrap data; it is
retained with the warmup margin, while all future imports enforce the main-push
policy. Main will produce the first eligible artifacts after this change merges.
Missing, malformed, nonpositive, inconsistent or orphaned measurements
fail the guard. The updater never changes the shard count, budget or checks.

`test/browser-shards.test.js` covers discovery, exact coverage, deterministic
packing and the live budget. `test/browser-timings.test.js` covers percentile
selection, window eviction, provenance, invalid/incomplete imports, workload
changes, duplicate runs and per-test coverage consistency.

AIT-216 final regeneration evidence (2026-10-16): main
`429b72f277119e2204e8478d6629ac8787ffb190` was merged with signoff, without
rebasing. The one-time migration extraction read that revision's
`scripts/browser-shards.js` literal and generated every sibling JSON from each
entry's numeric seconds and measurement-evidence comment, including
`upload-capacity`, `composed-media` and `language-first-paint`. No weights were
hand-merged. The inline table was then replaced by the per-file reader;
main's six-shard packing code and required summary workflow stayed unchanged.

The one-time proof ran on mbp2606 against the committed merge
`32ba251765b78a5940ce228236550f2c388ed4e3`, run `32ba251765-68752`:
`31/31 equal; identical layout (shard membership/order and totals)`.
Projected totals were `380 / 380 / 390 / 370 / 380 / 380` seconds; the largest
was 390s and main's unchanged <= 420s plan ceiling passed. The legacy and current
packing functions were identical. All 53 targeted shard, workflow/summary,
merge-queue and module/CI-environment tests passed, including missing, invalid
and orphaned weight guards. Algorithm fixtures remain self-contained; the
real-plan test enforces the live ceiling. This records migration identity, not
a permanent constraint on future test additions or measured weight refreshes.


## AIT-251 measurement and coverage evidence

Profiling started from `5d818c38`, with the weight table and the last three green
main runs: [38903749704](https://github.com/inspr-at/aithema/actions/runs/38903749704),
[38900650292](https://github.com/inspr-at/aithema/actions/runs/38900650292) and
[38898587783](https://github.com/inspr-at/aithema/actions/runs/38898587783).
The measured p95/maxima of those short series selected the five files below.
The comparable before/after table uses the instrumented unchanged-workload
[baseline 38908910516](https://github.com/inspr-at/aithema/actions/runs/38908910516)
and the first fully green optimized run
[38911873685](https://github.com/inspr-at/aithema/actions/runs/38911873685), both
on GitHub's Linux runners. Values sum top-level test durations, in seconds.

| Browser file | Before | After | Cause addressed |
| --- | ---: | ---: | --- |
| `pause-phone.test.js` | 203.641 | 170.348 | Reuse Chrome across compatible fixtures; 16ms real PCM replay replaces half a second of silence in each scene. |
| `upload-capacity.test.js` | 172.315 | 33.115 | Control only upload backoff timers; fence real extraction batches; hold the pending response while measuring the toast. |
| `composed-qualification.test.js` | 149.070 | 149.074 | Reuse Chrome for the six compatible valid cases; keep all six 20s media prefixes and both overlap refusals. Runtime is effectively unchanged. |
| `consent-lines.test.js` | 127.683 | 79.242 | Reuse Chrome, retaining fresh fixture pages and storage isolation. |
| `start2-display.test.js` | 99.330 | 94.294 | Wait for rendered frames and finite animations instead of fixed 120ms sleeps. |
| **Total** | **752.039** | **526.073** | **225.966s of measured work removed at the cause.** |

This measured saving is separate from replacing padded planning weights. The
original plan was **2500s**, with bins `410 / 420 / 420 / 420 / 410 / 420`.
The first generated p95 plan was **1746.395s**, with bins
`291.594 / 292.871 / 291.961 / 290.607 / 289.225 / 290.137`.
The five target files' original planning weights alone fell from **810s** to
**526.073s** (283.927s), while the measured comparison above independently
clears 200s. The updater also raises underweighted files when CI measures them
slower; for example language-first-paint rose from 50s to 109.563s.

All **655 original assertion calls** across the five files remain, and four
checks were added to ensure the controlled upload clock sees the production
5s/10s retry delays. No width, language, theme, state, top-level test or nested
scenario was removed. The real backoff timing, Retry-After, cancellation and
no-early-POST guards still execute in `packages/ui/test/uploads.test.js` in the
required unit suite. The browser fixtures still test real 11MiB files and
extractors, retained-file identity, exact attempt counts, pause/resume,
keyboard controls, accessibility trees, painted underlines and zero movement.
The final remote timing/upload verification passed **59/59**; upload viewport
evidence includes the settled phone toast and retry states, with blur and
pinned fonts. All five changed browser files were exercised on mbp2606, one
suite at a time, starting below load 10. Full browser validation is PR CI's job.

The committed siblings retain each source observation, SHA and workload hash.
The first plan has one sample per file (explicit warmup); subsequent refreshes
extend the rolling series rather than treating this first run as a permanent
floor. Six shards, the 420s ceiling and all required check names are unchanged.


Final calibration includes all three overlapping PRs (#216, #217, #218), merged
from main with signoff. The second green calibration run is
[38913449964](https://github.com/inspr-at/aithema/actions/runs/38913449964).
After importing it, the committed rolling p95 plan totals **1811.989s**, with
bins `302.498 / 300.173 / 300.958 / 301.703 / 304.539 / 302.118` seconds. The largest is
**304.539s**, below the unchanged 420s ceiling. The five target files now
plan **537.727s**, **272.273s less** than their original 810s allocation.
Thirty-one files have two CI observations; understanding-failure has one fresh
observation after AIT-221 changed its workload, replacing the explicitly marked
old series. This is a warming rolling p95 window, with no estimated samples.
The 23 shard/timing guard tests passed on mbp2606; the merged calibration's full
unit job and `npm run test:browser-shards` also passed. Final commit CI is linked
in the PR handoff.


AIT-251 round 2 restricts future timing imports to verified canonical main push
runs and applies the 25% warmup margin to every existing short series. The
extraction/next-upload overlap is covered by a server unit test in
`packages/server/test/uploads.test.js`: it holds the first extractor open,
starts reading the next multipart body, finishes extraction during that read,
then asserts retryable 429, no partial admission, and exactly one successful
retry using the same client event. No browser page or case is added.

After the margin, `npm run test:browser-shards` reports **2265.000s** total,
with bins `378.124 / 375.219 / 376.201 / 377.131 / 380.676 / 377.649` seconds.
The largest bin is **380.676s**, leaving **39.324s** under the unchanged 420s
ceiling. The six shards and all check names remain unchanged.

The remote targeted timing, shard and server upload suite passed **78/78** on
mbp2606. Coverage includes canonical push selection, explicit PR/fork rejection,
main ancestry, artifact/header mismatches, atomic rejection, local-import
rejection, 1/4/5+ sample margins, workload reset and the extraction overlap.
