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

The signed main merge was conflict-free (no manual merge hunks); both the AIT-212
changes and main's package exports/release tooling are retained.

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
