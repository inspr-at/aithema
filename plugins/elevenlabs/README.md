# ElevenLabs live voice

`@inspr/aithema-plugin-elevenlabs` is a private `0.0.0` workspace package under
AGPL-3.0-only. Part A implements the adapter in isolation. Part B connects it to
routes, the durable session journal, audio rail and localhost demo after AIT-97
merges. Tests use injected local fakes; no live calling or provider qualification
is claimed.

The generic behavior comes from Augmentoring's START `agent-token.ts`,
`call-reconcile.ts`, `llm/chat/completions.ts`, `pause.ts`, `v2.ts` and
`providers/elevenlabs.ts`. Branding, personas, account data and commercial policy
are excluded. `@elevenlabs/client` is pinned to START's locked **1.17.0**.
INSPR holds the rights to this port under the approved revised D3 decision.

## Contract and controls

Core exports the runtime contract at `@inspr/aithema-core/live-voice`.
`liveVoiceConformance` is re-exported by core's existing conformance export.
A joined local fixture supplies a dispatch counter, command-effect probes,
provider events and durable persistence observations. The kit checks single-use
claims, preflight/active cancellation, both lifetime deadlines, acknowledged
commands, exact capability behavior, transcript/heard provenance and one terminal.

| Capability | Declaration | Behavior |
| --- | --- | --- |
| `sendText` | native | SDK `sendUserMessage`; provider final callbacks become durable turns |
| `updateContext` | native | SDK `sendContextualUpdate`; string/JSON context, no synthetic turn |
| `setInput` | native | SDK `setMicMuted`; independent of output |
| `setOutput` | emulated | SDK volume 0/1; input selection is preserved |
| `pause`, `resume` | emulated | Atomic engine-pause acknowledgement precedes local mute/unmute; channel selections are preserved |
| `interrupt` | native | Wait for native provider barge-in acknowledgement with input enabled |
| `heard` | native | Agent-response correction for an observed assistant turn and genuine prefix |
| Transcript | final turns, durable | Await `persistEvent` for final/heard events before emitting; partial captions stay transient |
| Reasoning | delegated | Authenticated facade uses the session's separately admitted reasoning binding |

Events are `listening`, `speaking`, `partial`, `final`, `heard {turnId,prefix}`,
`recovering`, `recovered`, and `ended {reason}`. `callId` remains stable;
`providerSessionId` changes on a newly admitted reconnect. Provider event ids
identify final turns and deduplicate echoes. A real final callback lacking an id
gets a local callback identity; content is never invented. Unknown/non-prefix
corrections and stale connection callbacks are discarded.

Native audio barge-in comes from ElevenLabs' `interruption` event. Version 1.17.0
has no public force-interrupt method; `sendUserActivity` only signals activity.
`interrupt({signal,deadlineAt})` waits for an actual native interruption callback
with microphone input enabled. It rejects on deadline/cancellation and while
paused/input-muted. It does not force speech to stop or claim a heard prefix.
Fakes drive that real callback rather than inventing an SDK force-interrupt
method. The declaration follows the concept's native audio barge-in column;
Part B must present it as audio barge-in, not a force-interrupt button.

## Server half

The `/server` export provides `createElevenLabsServer`,
`mintConversationCredential`, `reconcileUsage` and `createCompletionsHandler`.

`createElevenLabsServer({binding, resolveSecret, fetchImpl, saveCall, prepareCall,
requestProviderClose?, now?, closureTimeoutMs?})` accepts private configuration
`{agentId, secretRef, apiBaseUrl?, upstreamMicroPerMinute, visitorMicroPerMinute}`.
Keys resolve only on the server at runtime. The manifest has technical
capabilities and public vendor facts/source URLs; account/legal qualification,
rates and secret references stay host-private.

`start({callId, transport?, facadeSecretRef, overrides?}, options)` consumes a server-admitted
single-use `{attemptId, claimId, maxMicro, consume}` before minting. Options
include `signal`, `deadlineAt`, absolute `spendDeadlineAt`, absolute
`browserLivenessDeadlineAt` and `report(terminal)`. Required `prepareCall` is a
server-only provisioning port: arrange the configured agent's callback to use
the distinct per-call bearer secret named by `facadeSecretRef`. Neither that
secret nor reference belongs in SDK/browser initiation data. A host must prove
this provisioning path before enabling voice; the adapter does not change
global agent configuration or silently share callback secrets across calls.

The token/signed URL GET uses `xi-api-key`, an injectable base URL and no
redirects. A provider conversation id is required. Signed URL minting asks for
single-use identity and also accepts an identity embedded in its URL. Receipts
have a conservative 60-second application freshness window. ElevenLabs' signed
URL initiation TTL is 15 minutes; application freshness does not change it.

`saveCall(record, options)` persists private provider identity, admitted attempt,
maximum, deadlines and pauses before a credential is returned. Credentials
never enter this journal. When `options.paused` is present, atomically persist
the call record and AIT-97's engine-wide pause state, returning
`{acknowledged:true, paused}`. Serial transitions prevent pause/resume races.
Heartbeat renews only the browser lease, bounded by the unchanged spend deadline.
Pause renews neither deadline.

Only `overrides.agent.language` and `overrides.agent.firstMessage` are allowed;
model, prompt, credential and custom-LLM overrides are rejected.
The start result exposes public identities/deadlines, `credential`, `pause`,
`resume`, `heartbeat`, `close(reason?, outcome?)`, private `snapshot()` and a
server-only call `signal` aborted at closure. Pass that signal alongside the
private record from the facade's `getCall` so active reasoning stops on closure.
Close, cancellation and expired leases converge on one terminal.
Optional `requestProviderClose(call, options)` requests shutdown through a host's
supported server channel. SDK hangup is not upstream closure evidence:
authenticated details must match the provider id, have `done`/`failed` status
and valid duration. Otherwise the report is `uncertain`, charged at `maxMicro`.
Known usage records full provider seconds/minutes/credits, separate paused and
visitor seconds, and both costs. Per-minute rates are prorated by seconds and
rounded upward to integer micro-units, without START's commercial minimum-minute
charge. Known upstream overruns record actual cost and an overrun flag.

The facade is a Fetch-standard `(Request) => Promise<Response>` handler:
`createCompletionsHandler({getCall, resolveSecret, buildRequest, admitReasoning})`.
`getCall(request, options)` resolves a private route-bound call; its per-call
bearer secret is compared in constant time before parsing/admission.
Requests contain `aithema_call` (top-level or START-compatible `extra_body`),
text `messages` and optional `stream`; conflicting identities are rejected.
Provider model/system/options cannot select the host binding.
`buildRequest({callId,messages}, options)` rebuilds trusted session context.
`admitReasoning({callId,request,options})` returns the runtime's
`{plugin, options, finish}`. `plugin.stream` settles its own token claim once;
the handler sends OpenAI SSE deltas, a stop frame and `[DONE]`.
Cancellation, deadlines, broken streams and omitted usage cannot fabricate
success. `stream:false` uses the same admission for a normal chat completion.

## Browser half

Import `createElevenLabsClient` from `/client`. Native browser ESM needs no
wrapper build. Inject `{sdk: Conversation, control, persistEvent}` or map the
exact SDK browser distribution and its dependencies with a host import map.
The SDK's self-hosted official IIFE `ElevenLabsClient.Conversation` is also
injectable. `workletPaths` supports self-hosted SDK worklets under restrictive
CSP. Do not serve server modules to browsers.

The `control` port has `start(request, options)`, `close(identity, options)`,
`pause(identity, options)`, `resume(identity, options)`, `heartbeat(identity,
options)` and optional `recover(identity, options)`. Identity is
`{callId,providerSessionId}`; close also carries `reason`. Start/recover return
only `{callId,providerSessionId,credential,spendDeadlineAt,
browserLivenessDeadlineAt,overrides?}`. Language/first-message overrides come
from host configuration. Browsers never supply server authority, API keys or
facade secrets; joined tests carry authority in-process solely for conformance.

`persistEvent(event)` writes final/heard events durably with idempotent turn ids.
Persistence failure ends the call rather than claiming a durable turn.
Consume `session.events`; SDK activity signals are not transcript evidence.
After transport loss, fence old callbacks and reconcile the old attempt.
`recover` must admit a new claim for every retry. Three failures end the stream
and return control to the host. Channel selections survive recovery; there is
no provider/model fallback.

## Exact Part B wiring

These are proposed route names; Part A mounts none. Enforce AIT-97 ownership,
current consent, tombstones/revisions and pause before every new voice,
reasoning and recovery admission.

| Route to mount | Port / behavior |
| --- | --- |
| `POST /api/sessions/:id/voice` | Admit duration claim, provision callback auth, server `start`; return no-store credential receipt |
| `POST /api/sessions/:id/voice/:callId/pause` | Bound provider identity; atomic `saveCall` + AIT-97 pause acknowledgement |
| `POST /api/sessions/:id/voice/:callId/resume` | Atomic resume acknowledgement |
| `POST /api/sessions/:id/voice/:callId/heartbeat` | Server-derived browser lease; never trust a browser deadline |
| `POST /api/sessions/:id/voice/:callId/close` | Provider-confirmed reconciliation; one terminal and idempotent receipt |
| `POST /api/sessions/:id/voice/:callId/recover` | Reconcile previous provider id; new admitted claim/provider id, stable call id |
| `POST /api/voice/:callId/llm/chat/completions` | Route-bound per-call bearer auth; session prompt and runtime reaction admission |
| `POST /api/sessions/:id/voice/:callId/events` | Idempotent durable finals/heard corrections via `persistEvent` |

Extend SQLite budget/storage with duration claims/settlement; the existing
ledger admits only reaction/understanding token claims. Record visitor-credit
and upstream usage separately, per-provider pauses, deadlines and terminal
receipts. At startup settle unfinished dispatched calls at their maxima,
release undispatched claims and rehydrate lease expiry/closure under AIT-97's
exclusive writer. Facade reasoning remains a separately admitted reaction
attempt using the session's selected binding; native reasoning is not enabled.
Extend `pluginRuntime` admission/feature-matrix handling for the private duration
binding and the paired server/browser kind; today's token `createBinding` and
reaction/understanding `admit` path cannot admit a voice start. Apply current
host-private legal/evidence qualification to this exact voice selection. Pass
the call's closure signal to the facade and invalidate callback auth on close.

The audio rail wires Start/Close, input/output switches, acknowledged
Pause/Resume, composer `sendText`, context `updateContext` and native barge-in.
Consume `listening`/`speaking` for activity, `partial` for captions, `final` for
durable bubbles and analysis triggers, `heard` for correction of that turn's
assistant bubble, `recovering`/`recovered` for reconnect state, and `ended` for
teardown/retry control. Renew heartbeats while the owning browser is alive,
including while paused. Withdrawal, erasure, ownership loss and session closure
must close voice and invalidate the facade before further admission.
Serve ESM/SDK/worklets and add labelled fake voice to the demo. Live ElevenLabs
enablement requires a separately authorized provider verification.

Sources: [JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script),
[client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events),
[client-to-server events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events),
[custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm),
[authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication).
