# CI runner use

Aithema runs on the organization's hosted runners. The organization is on GitHub
Enterprise (about 500 concurrent hosted jobs), and Aithema uses about 2 % of its
CI hours (measured baseline AEON-1407, 2026-10-15). All seven browser shards run
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

Seven worker shards report `browser (1/7)` through `browser (7/7)`. The ruleset
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

## AIT-312 capacity calibration (2026-10-18)

At the supplied base `24047f9f`, six projected totals were
`405.227 / 402.583 / 402.739 / 402.660 / 405.979 / 401.163` s.
Regenerating sibling weights with the AIT-251 importer from the latest 20
successful main runs admitted 19 first-attempt runs. Run `39040473267`
(attempt 2) was excluded after strict header/attempt provenance rejection;
no provenance checks were relaxed. Each sibling records its contributing
runs, hashes, per-test samples and rolling p95. Lower generated values are
supported by those main observations (including retirement of the warmup
margin where applicable); every provisional floor in the packer is retained.

Main advanced to `c5d6aa28` (AIT-309) during PR creation. Its new geometry
and footer floors are retained in the signed merge. With those floors and the
base weights, the six-bin plan matches LEAD's decision:
`411.191 / 412.845 / 412.618 / 413.178 / 415.380 / 411.078` s.

With refreshed weights and both incoming floors, the old six-bin greedy plan would be
`438.036 / 442.292 / 443.210 / 439.969 / 436.426 / 437.999` s, exceeding the 420 s ceiling.
Seven bins plus deterministic whole-file refinement produce
`377.070 / 377.456 / 376.192 / 375.703 / 377.409 / 377.769 / 376.333` s.
The maximum is **377.769 s**, leaving **42.231 s** below the hard ceiling.

The base main CI run `39114014147` measured summed top-level file work of
`351.270 / 348.941 / 303.716 / 335.940 / 342.441 / 367.104` s in its six
`browser-timings-N-of-6` artifacts. The AIT-312 PR handoff reports the matching
seven-shard CI measurements and artifact names. File work excludes runner
setup and artifact upload, so it differs from whole-job elapsed time.

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
deterministic LPT across **seven** bins, followed by whole-file moves/swaps
that reduce the maximum load, then squared load, without worsening LPT's
makespan bound. Equal candidates keep stable iteration order. If local
refinement still exceeds 400 s, a deterministic whole-file placement search
tries at most 100,000 nodes to meet that target. On failure it retains the
original plan for the guard's diagnostics. `npm run test:browser-shards` checks
complete, exactly-once coverage, a separate **400 s projected headroom target**, and the
unchanged **420 s per-bin ceiling**; this leaves
headroom for installation, Chrome startup, process cleanup and artifact upload
within the unchanged ten-minute job timeout. Required check names stay unchanged.

When the headroom guard trips, the shard command and unit test fail with each
overloaded shard's total, file paths, and individual weights. Review the measured
workloads and repack; retain measured floors and never lower weights without
evidence. This planning target does not change the 420 s hard ceiling.

LEAD's AIT-313 decision B (2026-10-18) raises the projected target from 380 s
because the first queued PR after AIT-312, AIT-310 (#280), could not fit it.
Merge-group run [39116724441](https://github.com/inspr-at/aithema/actions/runs/39116724441)
projected 381.944 s and 381.261 s on shards 1/7 and 3/7. With AIT-310's measured
floor, total projected work is 2655.3 s across 33 files: the seven-shard lower
bound is 379.33 s, and whole-file packing cannot meet 380 s. The 400 s target
corresponds to about 320 s real work with the 1.25 projection margin; AIT-312
measured a 308.2 s shard maximum against 377.8 s projected. Seven shards and the
420 s ceiling stay unchanged. **If the 400 s guard trips again before the floors
are re-derived in AIT-314, add an eighth shard; do not raise the target again.**

Each CI shard writes `browser-timings-N-of-7` artifacts (14-day retention).
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

The importer accepts complete historical six-shard and current seven-shard runs;
it rejects mixed counts, missing indices, duplicates, and expired artifacts.
CI screenshots use `browser-evidence-N-of-7`; the full nightly matrix uses
`full-browser-evidence-N-of-7`. All seven workers run concurrently, so this adds
runner minutes while keeping wall-clock time comparable.

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
hand-merged. The inline table was then replaced by the per-file reader.
At that calibration, main's six-shard packing code and required summary
workflow stayed unchanged; AIT-312 later expands worker capacity to seven.

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
floor. At that calibration there were six shards; AIT-312 later adds the
seventh while preserving the 420s ceiling and four required alias names.


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
ceiling. Those historical six-shard totals precede AIT-312; the hard ceiling
and four required alias names remain unchanged.

The remote targeted timing, shard and server upload suite passed **78/78** on
mbp2606. Coverage includes canonical push selection, explicit PR/fork rejection,
main ancestry, artifact/header mismatches, atomic rejection, local-import
rejection, 1/4/5+ sample margins, workload reset and the extraction overlap.


## AIT-230 deterministic evidence and pixel verdicts

Use `captureEvidence` from `test/browser/start2-display-helpers.js` for settled
QA screenshots. It blurs controls, moves the pointer outside the viewport,
waits for fonts and finite animations (including nested shadow roots), snaps
all scroll origins to integer `scrollTop`/`scrollLeft` with instant scrolling
(transcript first), then requires two requestAnimationFrames with unchanged
assistant-marker geometry, no scroll event and no active animation. Fractional
scroll limits snap inward when rounding would clamp back to a fraction. It fails
after five seconds rather than accepting unsettled evidence. Fixtures use
reduced motion and the pinned baseline font stacks; deliberately timed
animation paint probes retain their explicit clocks. Use viewport captures
for sticky/fixed UI. During settling only, a capture-phase listener drains
repeat transcript notifications whose final offsets are identical. This breaks
the test scene's follower feedback: `QuestionCard.scheduleReserve` calls the
latest-reply follower, which writes bottom then the same final reply offset,
queuing another notification despite zero net movement. Changed offsets still
reach the component's handlers; listeners are removed before returning. Without
this drain the 320px scene produced about 300 scroll events in five seconds and
correctly failed the idle-frame gate. Restore focus with `preventScroll` after
capturing only when the test needs to continue a keyboard interaction.

Launch evidence browsers with the shared `evidenceBrowserArgs`:
`--disable-partial-raster --disable-gpu-rasterization`. This uses full CPU-rasterized
tiles while retaining the GPU compositor, real product styles, Chrome headless
shell **155.0.8059.39**, and the pinned font stacks. The flags apply only to
explicit evidence runs, so PR CI retains its normal rendering cost. Both sides
of a verdict must use the same raster configuration, recorded in the manifest.
See [Chromium's raster flags](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md#rendering--gpu)
and [GPU-raster override](https://github.com/chromium/chromium/blob/main/gpu/config/gpu_finch_features.cc).

Class I is **16 changed edge pixels**, not a 16px layout translation. In two
complete captures after scroll settling alone, the marker had identical bounds
(`[43.390625, 170.734375, 12, 12]` at 390×420), but 16 edge pixels still differed
by up to five RGB levels. One other pixel varied in the composer's shadow.
That **26/28** intermediate result rules out geometry settling alone. The
capture renderer therefore pins full CPU raster instead of accepting hardware
partial-tile edge coverage as a UI change. No marker CSS, pixel mask or tolerance
is used; the same 28-state proof below must pass with the marker exact.

`node scripts/evidence-diff.js BEFORE_DIR AFTER_DIR` compares the original
AIT-225 28-state evidence directories, including the capture metadata in
`ait-225-evidence.json`. It emits per-shot counts and SHA-256 hashes and exits
nonzero for a failed verdict, a missing state, a dimension mismatch or changed
icon bounds or raster configuration. The tolerance policy is deliberately local:

| Noise class | Policy |
| --- | --- |
| T — transcript scroll raster | Exact pixels. Snap scroll origins and drain scroll handlers before capture. |
| I — assistant marker edge | Exact pixels, including its gradient and edge; the marker is excluded from tolerance boxes. |
| R — composer/attachment SVG antialiasing | At most **3 changed pixels per screenshot**, each with **RGB channel delta ≤ 1**, only within the unpadded SVG bounding rectangles recorded by the capture helper. Alpha remains exact. |
| All other paint | Exact pixels; no whole-image threshold, alignment, cropping, blur, image editing or ignored region. |

Reproduce on mbp2606 only: commit first, run `remote-browser.sh WORKTREE browser
test/browser/question-card.test.js test/evidence-diff.test.js` twice with distinct
`EVIDENCE_OUT` directories, then run the comparison command above. Each run
starts a fresh browser/profile and completes all 20 layout scenes; it emits the
same 28 viewport states as Tick's AIT-225 round-5 comparison (DE/EN × light/dark:
card and bounded options at 1440/390, plus 390×508/420/320 keyboard states).
The exhaustive screenshots stay evidence-only; PR CI adds two short contracts
in the existing page and pure pixel-policy unit checks, with no added browser
file, shard, ceiling or check-name change.

Before: Tick's unchanged `d2338b8` recapture matched **22/28** exactly
(`s119/tick-r5/comparison.json`, `baselineRecapture` column).

After: **28/28 exact pixel matches, zero tolerated pixels**, from two complete
independent captures of unchanged **`50a268d7d5da5af032d1885c9cbb14f6a8ce2a03`**
on mbp2606. Runs `50a268d7d5-45173` and `50a268d7d5-72194` each passed **27/27**
tests, completing in 91.921s and 92.085s respectively. All 28 PNG pairs also
have identical SHA-256 hashes. Every capture recorded integer scroll origins,
two settled frames and identical marker geometry. Each 320px scene drained one
no-op transcript notification. No screenshots were edited or selected from a
mixture of runs.

The committed [proof manifest](../test/fixtures/ait-230-evidence-proof.json)
records all 28 filenames, both PNG hashes, icon bounds, frame summaries, raster
configuration, source head and remote run identities. Raw complete captures
remain in `.data/ait-230/capture-raster-a` and `capture-raster-b` in the AIT-230
worktree. Run `node scripts/evidence-diff.js .data/ait-230/capture-raster-a
.data/ait-230/capture-raster-b` to reproduce the verdict without launching a
browser. The final documentation/manifest commit leaves the captured browser
fixture unchanged. PR checks are linked on [draft PR #228](https://github.com/inspr-at/aithema/pull/228).


## AIT-314 main-only floor re-derivation (2026-10-18)

Base: `ee435d8fcb630021945bac000d1bba155182d7cf`. Session: AIT-314-b1.
All five sources below are successful canonical `push` runs on `main`,
attempt 1, with complete `browser-timings-1-of-7` through
`browser-timings-7-of-7` artifacts. The updater verified repository, workflow,
event, conclusion, main ancestry, artifact metadata and JSONL headers before
writing any sibling. PR timings were not imported.

| Key | Main CI run | Head |
| --- | --- | --- |
| A | [39119980802](https://github.com/inspr-at/aithema/actions/runs/39119980802) | `ee435d8f` |
| B | [39119578412](https://github.com/inspr-at/aithema/actions/runs/39119578412) | `beb35ba2` |
| C | [39119554362](https://github.com/inspr-at/aithema/actions/runs/39119554362) | `d227aeae` |
| D | [39119045746](https://github.com/inspr-at/aithema/actions/runs/39119045746) | `5142319e` |
| E | [39116626384](https://github.com/inspr-at/aithema/actions/runs/39116626384) | `3c99bd62` |

Reproduce the refresh without running tests or a browser:

```sh
node scripts/update-browser-timings.js \
  --run 39119980802 --run 39119578412 --run 39119554362 \
  --run 39119045746 --run 39116626384
```

All 33 sibling weights were regenerated together, retaining the existing
latest-20-per-workload policy and full per-test observations/run provenance.
A workload change resets its series; it does not combine older hashes to reach
five samples. The 1.25 warmup multiplier still applies only below five matching
samples. At five or more, the generated weight is the sum of per-test rolling
p95 values without that multiplier. Neither the 7 shards, 420s ceiling, 400s
target, packing algorithm nor workflow/check names changes.

Completed-file work below sums only completed top-level tests, never nested
tests or shard/setup wall time. Values are seconds, rounded here to six decimals;
full precision for the current workload is retained in the sibling samples.
Times are in A/B/C/D/E order.
An asterisk marks an **older workload**, shown for comparison and excluded from
that file’s current p95. “File p95” is nearest-rank p95 of the matching completed
file sums from these five runs (max for this short series).

| File under `test/browser/` | Completed-file work A / B / C / D / E | Matching evidence | File p95 |
| --- | --- | --- | ---: |
| `start2-display-geometry.test.js` | 173.573548 / 152.219004 / 153.509304* / 156.938041* / 154.750617* | A, B | 173.573548 |
| `html-preview.test.js` | 27.731402 / 27.044118 / 28.303396 / 28.240569 / 28.507805 | A, B, C, D, E | 28.507805 |
| `start2-display.test.js` | 183.289711 / 200.705108 / 204.808288 / 195.947586 / 201.902352 | A, B, C, D, E | 204.808288 |
| `start2-display-continuity.test.js` | 40.612706 / 51.071719 / 51.960601 / 49.560871 / 50.051918 | A, B, C, D, E | 51.960601 |
| `start2-display-matrix.test.js` | 50.794811 / 45.261128 / 48.488182 / 53.037904 / 53.517648 | A, B, C, D, E | 53.517648 |
| `footer-width-sweep.test.js` | 28.994435 / 36.446089 / 36.760658* / 37.874524* / 36.890290* | A, B | 36.446089 |
| `consent-lines.test.js` | 95.835199 / 120.127260 / 93.319737 / 121.761565 / 120.259114 | A, B, C, D, E | 121.761565 |
| `host-surface.test.js` | 75.602189 / 85.046400 / 88.369428 / 85.279756 / 85.031475 | A, B, C, D, E | 88.369428 |
| `start-look.test.js` | 40.533498 / 33.942554 / 39.136332 / 37.591742 / 37.961440 | A, B, C, D, E | 40.533498 |
| `voice-presentation.test.js` | 138.483278 / 136.212264 / 137.944134 / 130.185210* / 131.102297* | A, B, C | 138.483278 |
| `email-mail-space.test.js` | 67.033599 / 65.264823 / 62.114587 / 65.655780 / 65.138732 | A, B, C, D, E | 67.033599 |

The planning p95 below follows `scripts/browser-timings.js`: sum each
top-level test’s nearest-rank p95 over its retained rolling series, then round
up to milliseconds. It can exceed the p95 of whole-file sums because different
tests peak in different runs. The hypothetical “×1.25” column uses the same
upward millisecond rounding; it is applied to the weight only for short series.
Sibling links provide every retained run ID, SHA, workload hash and per-test
time, including older trusted main observations already present at the base.
Parenthesized numbers beside old floors are AIT tickets. Every literal
per-ticket floor in the base is covered below, including superseded blocks.

| File / rolling evidence | Samples | Rolling per-test p95 sum | ×1.25 | Generated weight | Literal floors before → after | Decision |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| [`start2-display-geometry.test.js`](../test/browser/start2-display-geometry.weight.json) | 2 | 173.574 | 216.968 | 216.968 | 141.186 (299), 193 (309), 196 (301) → removed | Remove all three: regenerated warmup weight raises effective allocation 196 → 216.968; confirm on main. |
| [`html-preview.test.js`](../test/browser/html-preview.weight.json) | 20 | 28.727 | 35.909 | 28.727 | 31.792 (282) → removed | Mature main p95 replaces PR warmup floor. |
| [`start2-display.test.js`](../test/browser/start2-display.weight.json) | 6 | 206.080 | 257.601 | 206.080 | 185.675 (283), 221.814 (290) → removed | Mature main p95 replaces both PR floors; AIT-304’s unmerged 257s is outside this base. |
| [`start2-display-continuity.test.js`](../test/browser/start2-display-continuity.weight.json) | 8 | 51.966 | 64.958 | 51.966 | 58.570 (283) → removed | Mature main p95 replaces PR warmup floor. |
| [`start2-display-matrix.test.js`](../test/browser/start2-display-matrix.weight.json) | 8 | 53.747 | 67.184 | 53.747 | 65.560 (283) → removed | Mature main p95 replaces PR warmup floor. |
| [`footer-width-sweep.test.js`](../test/browser/footer-width-sweep.weight.json) | 2 | 36.447 | 45.559 | 45.559 | 41.875 (281), 46 (309) → 46 | Keep 46: only two current-workload samples; remove superseded 41.875 block. |
| [`consent-lines.test.js`](../test/browser/consent-lines.weight.json) | 8 | 126.939 | 158.674 | 126.939 | 146.156 (290) → removed | Mature main p95 replaces expanded-workload PR floor. |
| [`host-surface.test.js`](../test/browser/host-surface.weight.json) | 8 | 88.370 | 110.463 | 88.370 | 107.270 (297) → removed | Mature main p95 replaces PR warmup floor. |
| [`start-look.test.js`](../test/browser/start-look.weight.json) | 6 | 40.534 | 50.668 | 40.534 | 48.167 (307) → removed | Mature main p95 replaces readiness-matrix PR floor. |
| [`voice-presentation.test.js`](../test/browser/voice-presentation.weight.json) | 3 | 138.653 | 173.317 | 173.317 | 153.649 (302), 174.746 (310) → 174.746 | Keep 174.746: only three credit-matrix samples; remove superseded 153.649 block. |
| [`email-mail-space.test.js`](../test/browser/email-mail-space.weight.json) | 7 | 67.644 | 84.555 | 67.644 | 83 (311) → removed | Mature main p95 replaces condition-settling PR floor. |

Removed mature floors no longer reserve a permanent 25% PR margin after main
has met the existing five-sample threshold. Each regenerated weight covers its
matching five-run file p95 above. Geometry remains in warmup: its new 216.968s
weight exceeds all three old floors, so removing those blocks **increases** its
effective allocation. Footer and voice retain their higher floors pending more
matching main samples; the new smaller warmup weights alone do not justify
lowering these short-series reservations.

Packed projected file-work totals (seconds):

| Plan | Shards 1–7 | Sum | Maximum | Headroom to 400s |
| --- | --- | ---: | ---: | ---: |
| Base weights + base floors | 381.944 / 381.337 / 379.535 / 378.185 / 378.590 / 380.353 / 378.359 | 2658.303 | 381.944 | 18.056 |
| Refreshed weights + base floors | 343.677 / 342.542 / 342.597 / 346.277 / 342.558 / 343.291 / 344.938 | 2405.880 | 346.277 | 53.723 |
| Refreshed weights + retained footer/voice floors | 330.451 / 328.766 / 329.007 / 332.916 / 327.708 / 329.213 / 329.497 | 2307.558 | 332.916 | 67.084 |

Regeneration accounts for 252.423s of total planned-work reduction; removing
redundant/stale floors accounts for another 98.322s. Combined, total planned
work falls 350.745s and the packed maximum falls 49.028s. This is a planning
recalibration; no tests, assertions, fixtures or product work were removed.

For a comparable projected-versus-measured gap, replay the **same completed
file observations** into each plan’s whole-file bins. This holds measured work
fixed while allowing the packing to change. Run A’s base replay exactly matches
its actual seven artifact shard totals; the after columns are a replay, not a
claim that main already ran the new packing. Earlier runs also include the
older workloads marked above; A and B are all-current-workload comparisons.
Gap is `(projected maximum / measured maximum - 1) × 100`.

| Evidence | Before measured max | Before gap vs 381.944s | After replay measured max | After gap vs 332.916s |
| --- | ---: | ---: | ---: | ---: |
| A | 317.878 | 64.066s / 20.15% | 318.491 | 14.425s / 4.53% |
| B | 312.264 | 69.680s / 22.31% | 319.297 | 13.619s / 4.27% |
| C | 318.773 | 63.171s / 19.82% | 320.114 | 12.802s / 4.00% |
| D | 312.805 | 69.139s / 22.10% | 322.132 | 10.784s / 3.35% |
| E | 312.726 | 69.218s / 22.13% | 319.631 | 13.285s / 4.16% |

Run A’s total measured file work is 2027.399s. Aggregate planned-versus-measured
overhead falls from 31.12% (2658.303s) to 13.82% (2307.558s); this aggregate
metric differs from the packed-maximum gap above. Actual new-layout runtime
will be checked by PR CI and then a follow-up main run.

Follow-up main confirmation: prioritize geometry’s increased 216.968s warmup
weight (two samples), retained footer 46s floor (two samples) and retained voice
174.746s floor (three samples). Accumulate at least five matching main samples
before deciding whether the latter floors can go. Also confirm the eight
mature-file floor removals in the first post-merge main packing, particularly
start2-display, consent-lines and host-surface. PR timings are diagnostic only.
If the 400s guard trips before landing, escalate to the separate eighth-shard
capacity decision; do not raise the target. Historical merge constraint for
AIT-314: the PR required coordinator confirmation that the AIT-315 release had
been published before merging.


## AIT-321 consent revision workload (2026-10-18)

The existing `test/browser/consent-lines.test.js` owns the two-page stale-image
regression and the six DE/EN × 320/390/1440 reload/evidence states. No browser
file or shard is added. Keep **7 shards**, the **400 s projected headroom guard**,
the 420 s hard ceiling, and all existing shard/check names.

The temporary **137 s** floor in `scripts/browser-shards.js` preserves the old
126.939 s rolling-main file weight and adds 25% on the measured new coverage:
0.897227781 s for the two-page regression in PR CI
[39128561317](https://github.com/inspr-at/aithema/actions/runs/39128561317)
(shard 5/7), plus 6.770130083 s for all six viewport states on mbp2606 run
`7c8a8cb564-36837`. The latter passed the exact copy, single POST, focus, busy,
icon clearance, two-line 320 DE case, and strict 0 px checks. Formula:
`ceil(126.939 + 1.25 × (0.897227781 + 6.770130083)) = 137`.
This diagnostic PR/remote evidence does not enter trusted rolling-main p95
history. Final PR CI remeasures the full changed file; its timings and viewport
artifacts are linked from PR #290. The guard must pass before handoff.
