# AIT-212: failed paid lanes require an explicit Retry after reconnect

Opening an event stream uses reconnect scheduling. Each requested lane is checked
against its recorded current-input-revision failure before scheduling. Failed lanes
are skipped independently, including when both lanes failed. The existing Retry
endpoint uses normal scheduling and existing in-flight deduplication, admission
and terminal settlement. Successful attempts clear the lane's failure; input
revision changes remove obsolete failure state; invalidation clears it.

AIT-213 stores sanitized per-session/per-lane failures in SQLite `lane_failures`,
including the input revision. Records survive handler recreation, database reopen,
restart and deployment. Both boot recovery and event-stream reconnect skip current
failed lanes. `operations.lastFailure` is derived from the remaining current-revision
records: after understanding recovers, a remaining reaction failure becomes visible
through the existing single Retry. Explicit Retry also includes recorded failed lanes
when ordinary scheduling requests only understanding (for example during voice).
There is no provider diagnostic or person-authored content in these records.

A deliberate **Resume** from the person (text or voice pause/resume) uses normal
scheduling and may re-run a failed lane because the person chose to continue. This
is distinct from the server's boot `handlers.resume()`, which preserves failures.
The existing settlement and credits rules remain unchanged: a fully received 4xx
without usage settles at zero, except 408/499; timeouts and uncertain failures settle
conservatively. A reconnect adds no charge regardless of the failed attempt's cost.

`unfinished` also consults the existing purpose-assessment recovery selector, so an
earlier unassessed in-scope turn survives a later all-off-topic pause. Repeated
reconnects assess that input once; all-off-topic input causes zero provider work.
No provider settlement, compatibility-retry, UI copy, font or layout rules change.
The `copy.understandingFailed` assertion already uses exact element text matching
in `packages/ui/test/session-element.test.js`, with no unescaped regular expression.

## Remote red-to-green evidence

All tests used committed archives on mbp2606; no local tests, builds, browsers,
environment files or live providers. AIT-201 PR #176 was open at start, so tests
use existing handler/safeguards fixtures. `aeon issue get AIT-212` returned API 403;
the supplied ticket brief was used. No review gate was run.

Red commit: `9cfd17070b`.

- Unit run `9cfd17070b-82028`: 3/5 passed. Failed-paid reconnect made two
  provider calls instead of one; earlier in-scope reconnect recovery made zero
  assessments instead of one. Explicit Retry, genuinely unfinished input and
  all-off-topic zero-work controls passed before the fix.
- Browser run `9cfd17070b-83131`: 0/1 passed. Reconnect added one provider call
  (2 → 3) and one settled understanding budget attempt without a Retry click.

Green fix: `0e40bb1850`.

- Unit run `0e40bb1850-87942`: 92/92 passed, 1.826 seconds, including all
  existing AIT-197 recovery/supersession and handler tests.
- Browser run `0e40bb1850-89454`: 11/11 passed, 35.341 seconds. Eight AIT-212
  combinations (DE/EN × 390/1440 × light/dark) each prove zero reconnect calls,
  admissions and settlements; one enabled Retry; and one normally settled
  explicit retry attempt. Existing AIT-198 browser checks also pass.

Viewport captures use reduced motion and wait for fonts, animation completion
and two animation frames. Production font stacks remain identical to the Chrome
baseline. Eight `ait212-*-reconnected.png` files and `ait212-passes.json` are in
`/Users/markus/Code/aithema-worktrees/ait-212-evidence/`. Captures identify the
validated fix head; subsequent changes add tests/documentation only.

Additional server coverage at `55a2a35a53`: run `55a2a35a53-96212` passed
94/94 in 1.644 seconds, including reaction-only and simultaneous two-lane
failures. Three reconnects leave each failed lane at one call; explicit Retry
recovers each failed lane exactly once.

## Round 2 / AIT-213 evidence

The initial signed main merge (`211179a6`, release candidate #173) was conflict-free;
both the AIT-212 changes and main's package exports/release tooling are retained.
A follow-up signed merge of `c9591f14` retains AIT-201's shared provider kit,
analysis rendezvous and low analysis effort, plus AIT-209's bounded browser launch.
Its only conflict was in `test/fixtures/understanding-failure.js`: the provider setup
keeps the shared kit and all five failure kinds; storage and the `/restart` endpoint
keep the disk-backed lifecycle; `/stats` counts kit calls. `handlers.js` and shard
weights merged automatically, retaining durable failure handling and both weights.
The understanding settlement assertion also accepts AIT-201's optional `error` field.

Red commit `b794b8f6b6`, mbp2606 run `b794b8f6b6-85441`: 17/19 handler tests
passed. The disk-backed restart regression and remaining-lane visibility regression
both failed. The restart test closes handlers and SQLite, reopens the same database,
runs boot recovery and reconnects three times; it requires zero new calls, admissions
and settlements, one exposed failure, one deduplicated explicit Retry and later work
for a new turn. The partial recovery regression uses the understanding-only scheduler
path and requires the remaining reaction failure to stay visible and retryable.

The browser matrix extends Tick's existing approved post-reconnect presentation
without changing UI code, copy, font stacks or layout. Every DE/EN × 390/1440 ×
light/dark case now covers received usage, unbilled 400, timeout 408, timeout 499 and
uncertain 503. Each closes handlers and SQLite, reopens the database, runs boot
recovery, reconnects, asserts exactly one visible enabled Retry, and verifies one
explicit retry attempt. Pass lines and JSON record available credits immediately
after failure and after reconnect and assert equality of the entire owner balance.
They also distinguish provider settlement at zero, with received usage, or
conservatively; failed understanding visitor charges remain governed by AIT-198.
Viewport evidence retains reduced motion, settled animations and loaded fonts.

Green evidence head: `7ca3832ca3`.

- mbp2606 browser run `7ca3832ca3-18003`: 11/11 passed in 44.890 seconds.
  All 40 restart/reconnect cases passed, with one visible enabled Retry and exactly
  one settled explicit retry attempt each. Captures and `ait212-passes.json` are in
  `/Users/markus/Code/aithema-worktrees/ait-212-evidence/round2/` (63 files).
- mbp2606 unit run `7ca3832ca3-34558`: handlers, storage and safeguards, 106/106
  passed in 1.313 seconds, including disk reopen, boot recovery, three reconnects,
  repeated-click deduplication, newer input, stale cleanup and partial recovery.
- Full PR CI unit job `38801292295 / 116651183288`: 3,783/3,783 passed in
  193.634 seconds (job wall time 3m29s), including the two new regressions.
- An initial browser assertion compared complete ledger rows across boot and
  caught harmless existing-receipt reconciliation annotations. The final assertion
  checks call count and every admission/settlement field while allowing the two
  reconciliation metadata fields to change. Full owner balances still compare equal.

Sample pass lines, DE/390/light (the JSON includes all 40 cases). Displayed credits
are available micro-USD divided by 10,000; the fixture shares a visitor wallet, so
later rows also include earlier successful replies and explicit retries. **Every
reconnect delta is zero.** Failed understanding visitor spend is zero in every row;
provider settlement follows the unchanged AIT-198 receipt rules.

| Failure kind | Credits after failure | Credits after reconnect | Provider settlement (micro-USD) | Settlement evidence |
| --- | ---: | ---: | ---: | --- |
| Received usage, invalid result | 990 | 990 | 100,000 | Received usage |
| Fully received 400, no usage | 970 | 970 | 0 | Unbilled rejection |
| 408, no usage | 950 | 950 | 802,567 | Conservative timeout |
| 499, no usage | 930 | 930 | 802,567 | Conservative timeout |
| 503, no usage | 910 | 910 | 802,567 | Conservative uncertainty |

The English request has a conservative ceiling of 802,568 micro-USD; it also
produces zero reconnect delta. No review gate was run.

After the follow-up main merge, evidence was recaptured at `be9a268d7e` using the
shared AIT-201 provider kit. Browser run `be9a268d7e-71649` passed 11/11 in 45.026
seconds; all 40 credits comparisons and settlement classifications above remain
identical. The same evidence directory now contains these refreshed captures and
JSON (head `be9a268d7e`). Unit run `be9a268d7e-87742` passed 118/118 in 1.344
seconds: handlers, storage, safeguards and the shard guard. This includes the signed
merge's optional settlement error field, boot/reconnect durability and partial-lane
recovery. Subsequent changes record this evidence only.


## AIT-221: shared Retry follows the first failure

When reply/reaction and understanding both fail on the current input revision,
the existing Retry button sits in the reply failure notice, first in reading
order. It keeps the existing handler: one explicit request retries both failed
lanes, reaction first. Status updates retain its node and keyboard focus.
Overview-only failure still uses AIT-198's inline overview Retry; reaction-only
failure retains its footer Retry. There is exactly one visible Retry. The
configured AIT-242 project action returns when Retry leaves the footer; its
existing CSS still hides it while a footer Retry occupies the row.

Red-before: test commit `1ae0eb8af1`, mbp2606 run `1ae0eb8af1-47389`, fails the
first-failure placement assertion in all eight DE/EN × 390/1440 × light/dark
cases. Fix `55250cf108`, remote run `55250cf108-54980`, passes the full changed
browser file (26/26, 60.692487 s), including unchanged AIT-198/AIT-212 exact
0 px guards and AIT-242's footer matrix. The expanded check reuses one page,
iterates states in-page, verifies overview-only placement, project visibility,
keyboard focus, and one settled attempt per failed lane after a single click.
No `process.env.CI` reads were added or changed.

The measured file weight is 80 s (round 60.692487 s up to 70, plus 10 s margin).
The six planned shards are 410/420/420/420/420/420 s; shard count is unchanged.
Final-head viewport evidence belongs at
`/Users/markus/Code/aithema-evidence/AIT-221/<head>/`: two failures, overview-only
and recovered states at 390/1024/1440 × light/dark × DE/EN, reduced motion,
pinned Chrome baseline fonts, settled animations and blurred controls. The
390 captures also show the overview and footer in separate viewports.
