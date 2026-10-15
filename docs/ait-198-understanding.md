# AIT-198 round 4: user-final analysis requests and unbilled rejections

OPS confirmed the production cause with the extended diagnostic on `9707a75`:
the reply succeeds, then understanding sends roles `[system,user,user,assistant]`
with thinking and effort enabled. Anthropic rejects that assistant prefill with
HTTP 400 `invalid_request_error`, without usage or cost. The purpose policy
publishes the reply before starting understanding; the former seeded sequence
hid this order. The round-3 schema hypothesis was separate and did not explain
this confirmed incident.

The round-4 regressions use a fake provider that rejects assistant-final thinking
requests, with the real purpose gate, handlers, adapter, admissions and SQLite
ledger. They retain the unseeded reply-before-understanding order, the published
assistant transcript, configured low effort, 8000 output tokens, actual usage
settlement and exactly one `understanding.updated` event. Draft and final prompt
coverage checks both user-final and assistant-final transcripts.

A fully received provider 4xx rejection without usage is authoritative evidence
of an unbilled request. It settles as cancelled, with zero tokens and zero cost,
releasing both the session hold and the provider account reservation. This rule
also covers the separate concept HTML provider path. Explicit billed usage/cost
is retained. A usage-bearing rejection without an authoritative price stays
uncertain. A 5xx without cost stays conservative: no applicable no-billing
contract has been established, and generation may already have started. Network
failure, timeout, abort or an unreadable response after dispatch likewise retains
the ceiling until authoritative evidence arrives. Failed understanding still
releases visitor credits independently of provider liability.

The request-shape instruction is host context, separate from person turns.
The shared understanding builder applies it to draft and final requests without
changing configured reasoning or effort. Concept HTML already sends one user
message containing the visitor context and requests reasoning disabled.
Schema compatibility is still restricted to explicit response-format/schema
rejections on HTTP 400/422; a plain `invalid_request_error` takes the failed path.
The understanding loop admits at most one prompt-only retry, with a distinct
attempt and settlement.

## Earlier rounds

The following round-3 evidence is historical; the zero-cost 4xx rule above
supersedes its conservative treatment of unbilled HTTP rejections.

The strict understanding request sent the full host schema, including numeric
`minimum`/`maximum`, while AIT-181 had already removed those constraints from
reply requests. A fake provider rejecting those keywords with HTTP 400 reproduces
the production ledger shape: `uncertain`, no usage, settled=max=18,314 micro.
The shared portable schema fixes that reproduction. OPS must still run the live
diagnostic to establish whether this is the cause of the production incident.

## Round 3 delta evidence

Tests-only commit `e5588dc` reproduces all round-3 findings on mbp2606.
The focused routing, published-analysis/unknown-cost and stuck-state unit run is
0/3; the browser focus and stuck-overview run is 0/2. The HTTP regressions also
show two attempts for non-compatibility 4xx where exactly one is required.

Round 3 restores Azure's default exclusion and requires an explicit schema
compatibility rejection on HTTP 400/422 for the prompt-only retry. Visitor
release now belongs to the failed lane, independently of provider cost certainty.
The inline Retry node stays mounted. Missing reply with idle lanes and no failure
uses that same quiet failure line, with no visible footer Retry. The browser
matrix covers DE/EN at 390/1440, viewport evidence, focus retention and exact
zero displacement; the original failed/uncertain settlement and recovery matrix
remains in place. No layout tolerance was widened. Normal-overview preservation
fixtures include an assistant reply so they do not represent the new stuck state.

## Red and green evidence

All execution uses mbp2606 through remote-browser.sh. The builder does not open
env files, make live provider calls, or run review gates.

- `2b074da`: lifecycle 5/9 pass. The portable-schema, separately admitted retry,
  unknown-spend refund and actual-spend refund assertions fail. The fake uses the
  real adapter, purpose gate, handlers, admission, SQLite ledger and owner wallet.
- `4948772`: lifecycle + adapter 49/49 pass. The bounds-rejecting fake now produces
  one completed analysis, actual cost 110 micro and `understanding.updated`.
  A separate constrained-400 fake requires exactly two admissions: one strict,
  one prompt-only, with distinct attempt IDs and one successful publication.
  Bounds remain enforced host-side; an out-of-range readiness value still fails.
- `5e4cc58`: the qualified browser fixture reaches and fails the required failure
  copy assertion. Subsequent checks require actual owner-wallet release, quiet
  ink, no alert box, working inline Retry, recovery without reload and exact
  zero displacement in DE/EN at 390/1440, for uncertain and known-cost failures.
- `1af40af`: diagnostic 3/4 pass; the seeded case fails the new unseeded sequence
  assertion. Its replacement uses a controlled fake gate instead of a timing sleep.
- The browser fixture also caught a schema-free feature-availability quote being
  incorrectly refused after schema normalization. `e5cbf32` preserves these quotes;
  they never send a provider request.

The two fixed 2-second turn waits now poll for an actual dispatched ledger row.
Fake provider latency remains intentional in the original slow-provider tests.
The first full unit pass exposed older tests conflating provider liability with
visitor charges. Their exact provider amounts remain asserted in the session
ledger, with additional zero visitor-charge assertions for failed
understanding. Their invocation fixture now reports its actual success/failure
instead of unconditionally reporting failed during cleanup.

No assertion tolerance was widened. `ca71ae6` passes all eight UI cases with
exact 0 px geometry, including recovery through the inline retry. The overview
content area and build-readiness row reserve their final size before results.
The crash-recovery refund regression was red at `602e4ec`; recovery now releases
the visitor flag while retaining provider liability, with late-receipt coverage.

## Request parameters

Both reply and understanding strict requests use the same recursive portable
schema: type, enum, description, properties, items, anyOf, $defs and $ref, with
required keys and `additionalProperties: false` derived for objects. Numeric
bounds, lengths, patterns and other validation constraints remain in the full
host schema. Prompt-only compatibility carries the full schema in the prompt
and validates the result against that same host schema.

A constrained HTTP 400/422 with a response-format or schema compatibility rejection
admits at most one prompt-only retry, after the first attempt settles. Generic
4xx, auth, payment and rate-limit errors take the error path without a retry. Each attempt repeats normal consent, budget and price checks.
Cancellation, stale input and deadline checks still fence the retry. Unknown
first-attempt provider spend stays conservative even when the retry succeeds.

Parameter review against OpenRouter's official documentation:

- Keep `provider.require_parameters: true`: routing must honor requested schema,
  output ceiling and reasoning controls. Prompt-only retry omits response_format.
- Keep `provider.max_price` in USD per million tokens: it enforces the qualified
  price ceiling, independently from the local reservation.
- Keep `allow_fallbacks: false` and explicitly configured `only`/`ignore` policy.
  Understanding/analysis and HTML default to excluding Azure: its START workspace
  rejects `response_format` despite advertised support. This holds even when
  `OPENROUTER_PROVIDER_ONLY` is unset. Explicit exclusions still override the default.
- Keep the unified `reasoning` control: `{enabled:false}` for none, otherwise the
  validated configured effort. This avoids implicit reasoning spend and uses
  OpenRouter's documented Anthropic translation. Do not send duplicate native
  effort/thinking parameters or a second reasoning token budget.
- Keep receipt usage and streaming usage options for accounting.

Sources: [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
This is a portability review, not a claim of a live Anthropic verification.

## Visitor credits and provider liability

Failed understanding lanes release visitor credits on settlement. Provider cost
uncertainty alone does not imply failure: a published analysis with unknown cost
retains its conservative visitor charge, which late receipts can reconcile.
A durable `visitor_credit_released` flag separates the visitor wallet from the
provider ledger. The owner wallet excludes released rows from display and future
owner-credit admission. Provider costs, actual receipts, per-session technical
budget and account spend caps retain their original conservative accounting.
Late reconciliation cannot re-charge a released visitor attempt. A plugin that
reports completed usage but then fails host validation also releases its credits.
The UI refreshes footer credits from the failure event, with no polling interval
required. The inline failure notice uses quiet ink and the required DE/EN copy;
the next successful event restores the usual overview. A missing reply with no
work running and no failure is a stuck state and uses the same overview notice
with exactly one inline Retry. Its button stays mounted across live renders to
preserve keyboard focus.

Local deadline, revoke, erase and consent/input fences after dispatch still report
uncertain provider cost when no authoritative receipt exists
(`packages/core/src/invocation.js`, `packages/server/src/budget.js`). Before
dispatch they report zero usage. A fetch abort before response headers gives no
generation ID and may leave the provider running. An input-only estimate cannot
safely bound that liability: the provider may generate and bill the full output
allowance after the client disconnects. No provider-side reduction to the input
estimate is proposed without an authoritative no-generation/cancellation receipt.
The visitor refund is independent of this provider liability.

## OPS diagnostic

With configuration already injected into the process, OPS runs:

```sh
node scripts/understanding-diagnostic.mjs --allow-live
```

The command never loads configuration files, refuses CI and missing --allow-live,
uses isolated in-memory storage and a provider account cap of at most $1. Both the
wire wrapper and admission wrapper independently enforce a total of five calls,
including compatibility retries. No builder live calls are needed.

The two aggregate reports share one sequence; compatibility attempts fit within
the five-call limit:

1. `live-sequence-de`: first visitor project turn -> real reply -> persisted
   onScope classification -> understanding. No scope seeding.
2. `in-then-off-de`: off-topic input as soon as that analysis is dispatched; a
   real off-topic reply classifies it while the original project analysis runs.
   The original analysis must complete with usage and publish once.

Both reports include `project_scope_seeded:false`, `shared_analysis:true`,
`reply_before_understanding`, per-attempt `dispatch_to_terminal_ms`, fixed
`outcome_reason`, HTTP/cancellation failure reasons and lane counts. A missed
overlap fails the overlap case; cap exhaustion or misclassification fails the run.
Per-wire-call records also print model IDs, parameter/property keys, role sequences,
HTTP status, provider error code/type and finish reason. They never print turns,
provider bodies, generation IDs, schema values, routing values, output or secrets. OPS retains this value-free
output before deployment. The two cases are one shared sequence, not two
independent isolated analyses.

### AIT-198-d1 wire diagnostics (diagnostics only)

Each `provider-call` row carries dispatch order and milliseconds since diagnostic
transport creation. Rows emit when the adapter reaches EOF, cancels its reader,
or encounters a transport/read error; output order can therefore differ from
dispatch order. Sort by `call_order` to reconstruct dispatch order. JSON responses
have both stream marker flags false. For SSE, `terminal_event_seen` means an
explicit terminal event/type (including error) or a non-null choice finish reason;
`done_seen` independently records `[DONE]`. `state:cancelled` can be normal after
the adapter consumes `[DONE]` without reading the HTTP body's EOF. Observation
does not clone or eagerly drain a response. Its bounded parser reports
`observation_truncated` if the adapter's byte limits are exceeded.

Fake example (not live evidence):

```json
{
  "case": "provider-call", "lane": "understanding", "call_order": 1, "offset_ms": 12,
  "http_status_class": "4xx", "http_status": 400,
  "provider_error_code": 400, "provider_error_type": "invalid_request_error",
  "finish_reason": null, "usage_present": false, "usage_cost_present": false,
  "request_shape": {
    "parameter_keys": ["max_tokens", "messages", "model", "provider", "reasoning", "response_format", "stream"],
    "message_count": 2, "roles": ["system", "user"],
    "response_format_present": true, "response_format_type": "json_schema",
    "schema_property_keys": ["progress", "summary"],
    "provider_routing_present": {"only": true, "ignore": false, "allow_fallbacks": true, "require_parameters": true},
    "reasoning_present": true, "effort_present": true, "max_tokens": 8000, "model": "anthropic/fixture"
  },
  "stream_end": {"requested": false, "done_seen": false, "terminal_event_seen": false, "state": "eof"},
  "observation_truncated": false
}
```

Presence flags report whether keys exist, including routing options set to false
and `usage.cost:0`. Missing status/code/type/finish reason are null. Error strings
are restricted to code-like tokens; free-form messages are ignored. Upstream
JSON errors in OpenRouter's `error.metadata.raw` contribute only code/type.
`effort_present` covers top-level effort/reasoning_effort and reasoning.effort.
Schema property keys cover only response_format.json_schema.schema.properties.

Offline fake transports exercise real handlers, adapter, admission and ledger:

| Understanding response | Usage | Cost | Current outcome |
| --- | --- | --- | --- |
| OpenRouter HTTP 400, error.code=400 | absent | absent | cancelled, provider-4xx failure, settled=0 (round 4) |
| Anthropic-shaped HTTP 529, error.type=overloaded_error | absent | absent | uncertain, provider-cost-unknown, settled=max |
| HTTP 200 with empty body | absent | absent | uncertain, provider-cost-unknown, settled=max |
| HTTP 200 with valid structured output and token usage | present | absent | uncertain, provider-cost-unknown, settled=max |

The adapter is configured with authoritativeCost=true in
`plugins/openrouter/src/index.js:26`. HTTP errors still attempt to observe usage
before throwing (`packages/core/src/chat-completions.js:142`); malformed/empty
200 bodies fail structured parsing (`packages/core/src/chat-completions.js:238`).
Before round 4, without an authoritative receipt, dispatched calls selected outcome=uncertain
(`packages/core/src/invocation.js:42-44`), which emits provider-cost-unknown
(`packages/core/src/lanes.js:75`). The ledger retains max_micro
(`packages/server/src/budget.js:295`). Thus this aggregate reason alone cannot
distinguish rejection from an empty or otherwise unbilled 200; OPS needs the new
wire rows. No provider, lane scheduling, request parameters or settlement logic
are changed in this diagnostic branch.

## Retained round-1 findings

The earlier slow-provider tests independently reproduced a superseding-project
turn abort, introduced by `f2e9f71`. That is separate from the isolated production
failure. Admitted project analysis now finishes its original request and retains
its receipt; a replacement waits, and only the permitted revision publishes.
Off-topic content cannot enter the paid original request. Consent, corrections,
erasure, withdrawal, locale and processing-choice changes still invalidate it.
The voice Resume assessment wake-up fix and value-free lane outcome counters
remain covered by the existing tests.
