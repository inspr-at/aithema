# AIT-198 investigation and OPS handoff

The superseding-turn charge is reproduced and fixed. The reported production
failure for a held, isolated in-scope turn is **not yet explained**. Do not treat
this draft as proof that the 19/19 production failure is resolved.

## Evidence

All test execution below used mbp2606 through remote-browser.sh. No env files
were opened and no live provider calls were made by the builder.

- Red: committed test head `222e216`, 2/3 pass. Reply latency 1 s, analysis
  latency 6 s, actual OpenRouter adapter, handlers, scope gate, admission and
  SQLite ledger, with fake fetch only. A second in-scope turn at 2 s aborts the
  first analysis: `outcome=uncertain`, `usage=null`, settled=max=18314 micro.
  The replacement completes at actual cost 110 micro.
- Green: fix head `8e677c6`, 227/227 targeted tests pass, including all three
  slow-provider cases, budget and cancellation tests, safeguards, adapter,
  account-cap and diagnostic tests. The superseded paid analysis now finishes
  with usage and actual cost; only the current project revision publishes.
- The isolated in-scope DE case and the off-topic-at-2-s case already passed on
  `222e216` before the fix. The isolated case also passes against the reported
  bad deployment `b47a7fb4` (detached probe `89c4969`, 1/1 pass). There is no
  justified good/bad predicate for bisecting the isolated production failure.
- `onScope` does not call `lanes.supersede` at `b47a7fb4`
  (`packages/server/src/handlers.js:109-111`). That call was added by
  `93e05c21` on October 15 for AIT-188; it cannot explain failures beginning
  with the earlier b47a7fb deployment. Identical input/selection also does not
  satisfy the cancellation condition in `SessionLanes.supersede`.

## Confirmed cancellation cause and fix

`f2e9f71e46d3a7b52be7a8db4b409ff86604c27a` introduced unconditional stale-input
transport abortion in `next/packages/core/src/lanes.js:21-25` (now
`packages/core/src/lanes.js:26-35`). AIT-188 (`93e05c21`) preserved it for new
in-scope project revisions while allowing off-topic-only suffixes to survive.
This is the confirmed cause of the reproduced **superseding-turn** defect,
not a proven regression commit for the isolated production incident.

The lane now distinguishes provider lifetime from permission to publish:

- An admitted project analysis survives append-only person turns, retaining its
  original request. A replacement waits for its receipt before starting.
- An old result publishes only when AIT-188's suffix classification permits it;
  new project input still invalidates publication of the old assessment.
- Off-topic content cannot enter the already-dispatched request. Off-topic-only
  suffixes and purpose pause retain the original project assessment.
- Consent, withdrawal, erasure, corrections, upload/locale/identity revisions and
  changes to the selected processing still invalidate the operation.

## Budget finding

`packages/core/src/invocation.js:37-52` settles on abort. Before dispatch it
reports a zero-usage cancellation. After dispatch it uses known usage (or an
authoritative provider cost for OpenRouter); without evidence it reports
`uncertain`. `packages/server/src/budget.js:291-301` releases unconsumed claims,
charges known usage/cost, and retains the maximum for an unknown dispatched
outcome. Runtime finish also conservatively settles a plugin that omitted its
terminal (`packages/server/src/plugin-runtime.js`).

The cancelled partial-stream/account-cap and admission/withdrawal tests confirm
these distinctions. OpenRouter's unknown authoritative cost cannot be called
zero merely because a transport was closed: the upstream may have continued
and billed the request. Its account hold remains conservative until receipt
reconciliation. The fix prevents avoidable cancellation from destroying the
receipt; it does not silently refund genuinely unknown provider liabilities.

## Container log counters

Next to reply counters, handlers emit value-free objects with `count: 1` and
`lane: 'understanding'`:

`understanding.started`, `understanding.completed`, `understanding.superseded`,
`understanding.deferred`, `understanding.aborted`, `understanding.uncertain`,
and `understanding.failed`.

`uncertain` records actual ledger settlement, separately from the lane result.
`aborted`/`failed` include only fixed reasons such as `revoked`, `deadline`,
`provider-4xx`, `provider-5xx`, `invalid-output`, or `provider`. No session IDs,
turns, provider responses, credentials, or model values are logged. Logger
failure cannot interrupt processing. Compare aborted/started and
uncertain/started counts to detect a 100% failure rate.

## OPS diagnostic

With the host configuration already injected into the process, OPS runs:

```sh
node scripts/understanding-diagnostic.mjs --allow-live
```

The command never loads configuration files, refuses CI and missing
`--allow-live`, caps outbound requests at three (including retries), uses a
separate in-memory ledger and an account cap of at most $1, and exits nonzero
unless both cases pass:

1. In-scope DE project only: one completed analysis with usage and publication.
2. A separate in-scope project, followed by off-topic input 250 ms after analysis
   admission: retained publication with usage, confirmed off-topic scope, no
   max-charged uncertain analysis.

To fit two independent analyses and a real off-topic classification into three
calls, the synthetic initial project scope is explicitly seeded in host storage.
The command reports `project_scope_seeded: true`; it does not claim to test
live in-scope classification. The AIT-181 reply diagnostic tests that separately.
All analysis, off-topic reply, admission, ledger and publication paths are real.
The independent fetch cap and pre-admission cap prevent extra calls even if
scope is misclassified. Output contains only case names, booleans, counts and
fixed outcome/reason enums. `overlapped: false` fails the overlap case rather
than claiming to have tested a race that did not occur.

OPS should retain the value-free output and, for a held production failure,
provide elapsed dispatch-to-terminal time, HTTP/error class and cancellation
or deadline reason. These distinguish the still-unexplained isolated failure.
