# ElevenLabs live voice

`@inspr/aithema-plugin-elevenlabs` is a private `0.0.0` workspace package under
AGPL-3.0-only. Part A supplies the adapter. Part B connects it to Fetch routes, the durable
session journal, duration ledger, audio rail and localhost fake demo under AIT-97. Tests use injected local fakes; no live calling or provider qualification
is claimed.

The generic behavior comes from Augmentoring's START `agent-token.ts`,
`call-reconcile.ts`, `llm/chat/completions.ts`, `pause.ts`, `v2.ts` and
`providers/elevenlabs.ts`. Branding, personas, account data and commercial policy
are excluded. `@elevenlabs/client` is pinned to START's locked **1.17.0**.
INSPR holds the rights to this port under the approved revised D3 decision.

## AIT-101 callback contract (AIT-115 revision)

The deployment callback uses **one deployment-scoped bearer secret shared across
calls**, stored as an ElevenLabs workspace secret and referenced by secret id in
the host-created agent. Its value never enters agent JSON inline or browser data.
`POST /api/voice/llm/chat/completions` compares the bearer in constant time before
reading the body. `elevenlabs_extra_body.aithema_call` binds a fresh callback identity
to an active owned call. START uses the same static-bearer pattern in
`src/pages/api/v2/llm/chat/completions.ts`.

The agent's custom-LLM URL is the **base** `${origin}/api/voice/llm`. ElevenLabs'
custom-LLM client (an OpenAI SDK) appends `/chat/completions` itself, as START's
agent URL `…/api/v2/llm` shows. Configuring the full path made the platform call
`…/chat/completions/chat/completions`. That path fell outside a host's exact-path
basic-auth bypass, so every reply got a 401 (first live test, 2026-10-10, AIT-126).
Keep a reverse proxy's bypass on the exact callback path.

`voice: {secrets, staticSecretRef}` selects this mode in `createHandlers`;
`createVoiceProvider({..., staticFacade:true})` disables per-call provisioning.
`createCompletionsHandler({..., staticSecretRef})` resolves the deployment secret
before `getCall(request, options, identity)`. The identity is a UUID returned as
`facadeCallId` in a start/recover receipt, sent by the SDK as `customLlmExtraBody`.
It rotates on recovery while `callId` stays stable, fencing previous callbacks.
A body may carry a matching top-level identity as well, but the nested identity
is mandatory in static mode. No cookie, provider model or body option selects
authority. Ownership, consent and input revisions, pause, browser liveness,
spend deadline, call closure and separately admitted reasoning still apply.

Closing a call removes its identity immediately. It leaves the shared deployment
secret in place for other calls. Static mode disables
`/api/voice/:callId/llm/chat/completions`; it never mutates the agent per call.
The legacy route/provisioning ports below remain available to existing hosts.

## Contract and controls

Core exports the runtime contract at `@inspr/aithema-core/live-voice`.
`liveVoiceConformance` is re-exported by core's existing conformance export.
A joined local fixture supplies a dispatch counter, command-effect probes,
provider events and durable persistence observations. After closing every
dispatched mode, the fixture must independently observe a stopped provider:
`providerOpen(session, {mode})` returns `false`, or
`probe('close', session, {phase:'after', mode})` returns `{providerOpen:false}`.
This observation comes from fixture-owned SDK/provider state, outside the plugin.
Every non-uncertain terminal must also report `closureConfirmed:true`.
The kit checks single-use
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
requestProviderClose?, reconcileLater?, now?, closureTimeoutMs?,
closurePollIntervalMs?})` accepts private configuration
`{agentId, secretRef, apiBaseUrl?, upstreamMicroPerMinute, visitorMicroPerMinute}`.
Keys resolve only on the server at runtime. The manifest has technical
capabilities and public vendor facts/source URLs; account/legal qualification,
rates and secret references stay host-private.

`start({callId, transport?, facadeSecretRef, overrides?}, options)` consumes a server-admitted
single-use `{attemptId, claimId, maxMicro, consume}` before minting. `consume()`
may return a promise: startup awaits the host's fresh consent and ownership
checks before provisioning callback authentication or contacting the provider.
The host owns settlement on refusal; the plugin does not report it again. Options
include `signal`, `deadlineAt`, absolute `spendDeadlineAt`, absolute
`browserLivenessDeadlineAt` and `report(terminal)`. `prepareCall` is a server-only preflight port. The static adapter supplies a no-op
after startup has established deployment authentication. Legacy hosts can use it
to provision a per-call bearer named by `facadeSecretRef`. Neither that
secret nor reference belongs in SDK/browser initiation data. A host must establish its selected callback mode before enabling voice.
The startup ensure module owns global configuration; the call adapter does not
change it. Shared deployment authentication is explicit in static mode.

The token/signed URL GET uses `xi-api-key`, an injectable HTTPS base URL and no
redirects. HTTP is allowed only for loopback test endpoints (`localhost`,
`127.0.0.1`, `[::1]`). A provider conversation id is required. Signed URL minting asks for
single-use identity and also accepts an identity embedded in its URL. Receipts
carry a relative `credential.ttlMs:60000` application freshness window, measured
by the browser from receipt rather than against the server clock. SDK connection
is bounded by this window and the caller's deadline. ElevenLabs' signed
URL initiation TTL is 15 minutes; application freshness does not change it.

`saveCall(record, options)` persists private provider identity, admitted attempt,
maximum, deadlines and pauses before a credential is returned. Credentials
never enter this journal. Minting failures and journal failures before credential
handoff report confirmed cancellation with zero duration and zero upstream/visitor
cost, even when the provider allocated an id. Authority is consumed before minting;
the billable dispatch boundary is the successful credential handoff. A late result
from a timed-out mint cannot start or journal a call. When `options.paused` is present, atomically persist
the call record and AIT-97's engine-wide pause state, returning
`{acknowledged:true, paused}`. Serial transitions prevent pause/resume races.
Heartbeat renews only the browser lease, bounded by the unchanged spend deadline.
Pause renews neither deadline.

Only `overrides.agent.language` is allowed, on the server and in the browser;
first-message, model, prompt, credential and custom-LLM overrides are rejected.
The agent's first message is the spoken AI notice (AIT-119), set server-side,
which no browser may replace.
The start result exposes public identities/deadlines, `credential`, `pause`,
`resume`, `heartbeat`, `close(reason?, outcome?)`, private `snapshot()` and a
server-only call `signal` aborted at closure. Pass that signal alongside the
private record from the facade's `getCall` so active reasoning stops on closure.
Close immediately aborts pending pause/heartbeat operations through the call
signal. Close, cancellation and expired leases converge on one terminal.
Optional `requestProviderClose(call, options)` requests shutdown through a host's
supported server channel, bounded to one second or the remaining closure window.
Failure of that request still allows authenticated details to confirm closure.
SDK hangup is not upstream closure evidence: authenticated details must match the
provider id, have `done`/`failed` status and valid duration. Close polls within
`closureTimeoutMs` (default 30 seconds), starting at `closurePollIntervalMs`
(default 250 ms) and doubling the delay up to two seconds. `processing` records
and lookup failures are retryable. Each details request is bounded to five
seconds or the remaining closure window, allowing retries after a stalled GET.
Only exhaustion of that window yields an
`uncertain` dispatched report, charged at `maxMicro`. Terminal journal writes
have a separate one-second deadline so window exhaustion can still be persisted.
Optional `reconcileLater(record, options)` schedules durable host reconciliation
after an uncertain report, with a separate one-second deadline, even when
terminal reporting fails. Invalid `close` outcomes reject before any state
change; only `completed` and `cancelled` are accepted. The record
contains the provider id and conservative terminal, without credentials. The
host can later fetch final usage and correct its ledger; this hook never reports
the admitted attempt again, and memoized close keeps its original receipt.
Known usage records full provider seconds/minutes/credits, separate paused and
visitor seconds, and both costs. Per-minute rates are prorated by seconds and
rounded upward to integer micro-units, without START's commercial minimum-minute
charge. Known upstream overruns record actual cost and an overrun flag.

Known limitation: pause timestamps use the host clock while provider usage may
use `start_time_unix_secs` from the provider clock. Clock skew can shift pause
intervals into or out of the measured call window and affect visitor seconds.
This adapter does not compensate for that skew; hosts should synchronize clocks.

The facade is a Fetch-standard `(Request) => Promise<Response>` handler:
`createCompletionsHandler({getCall, resolveSecret, buildRequest, admitReasoning})`.
`getCall(request, options)` resolves a private route-bound call; its per-call
bearer secret is compared in constant time before parsing/admission.
ElevenLabs callbacks contain `elevenlabs_extra_body.aithema_call`, reflecting
the SDK's `customLlmExtraBody`. Direct callers may send top-level `aithema_call`;
when both are present they must agree. Requests contain `messages` and optional
boolean `stream`. Null-content messages and roles other than `user`/`assistant`
are dropped safely; only text from those two roles enters session reasoning.
Provider model/system/options cannot select the host binding.
`buildRequest({callId,messages}, options)` rebuilds trusted session context.
`admitReasoning({callId,request,options})` returns the runtime's
`{plugin, options, finish}`. Supply the runtime's current owned session and
authoritative consent port; async claim consumption rechecks coverage, ownership,
pause, tombstones and revisions before dispatch. The handler preserves the
admission's cancellation signal and earlier deadline. `plugin.stream` settles its own token claim once;
the handler sends OpenAI SSE deltas, a stop frame and `[DONE]`.
Cancellation, deadlines, broken streams and omitted usage cannot fabricate
success. `stream:false` or omitted `stream` uses the same admission for a normal
chat completion; only `stream:true` selects SSE.

## Browser half

Import `createElevenLabsClient` from `/client`. Native browser ESM needs no
wrapper build. Inject `{sdk: Conversation, control, persistEvent}` or map the
exact SDK browser distribution and its dependencies with a host import map.
`closeTimeoutMs` defaults to 45 seconds; `session.close()` also honors an earlier
explicit deadline. Configure it to cover any longer server closure window.
The SDK's self-hosted official IIFE `ElevenLabsClient.Conversation` is also
injectable. `workletPaths` supports self-hosted SDK worklets under restrictive
CSP. Do not serve server modules to browsers.

The `control` port has `start(request, options)`, `close(identity, options)`,
`pause(identity, options)`, `resume(identity, options)`, `heartbeat(identity,
options)` and optional `recover(identity, options)`. Identity is
`{callId,providerSessionId}`; close also carries `reason`. Start/recover return
only `{callId,providerSessionId,credential,spendDeadlineAt,
browserLivenessDeadlineAt,overrides?,facadeCallId?}`. The language override comes
from host configuration. Browsers never supply server authority, API keys or
facade secrets; joined tests carry authority in-process solely for conformance.

`persistEvent(event)` writes final/heard events durably with idempotent turn ids.
Persistence failure ends the call rather than claiming a durable turn.
Consume `session.events`; SDK activity signals are not transcript evidence.
After transport loss, fence old callbacks and reconcile the old attempt.
SDK 1.17.0 `onError` supplies tool (`clientToolName`), server (`errorType`) or
end-session error contexts; these preserve the active connection. It does not
emit the transport contexts recognized by the adapter, so recovery with this
SDK version relies on `onDisconnect`.
`recover` must admit a new claim for every retry. Three failures end the stream
and return control to the host. Channel selections survive recovery; there is
no provider/model fallback.

## Exact Part B wiring

These routes are mounted by `createHandlers({..., voice: {secrets}})` in
`@inspr/aithema-server`; Part A itself mounts none. Enforce AIT-97 ownership,
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
| `POST /api/voice/llm/chat/completions` | Static deployment bearer, fresh active-call identity; session prompt and runtime reaction admission |
| `POST /api/voice/:callId/llm/chat/completions` | Legacy hosts only; disabled in static mode |
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
the call's closure signal to the facade and invalidate its call identity on close.

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

## Enabling voice in a host (Part B)

`createVoiceProvider` wraps the server half with owned-session SQLite persistence.
Construct it with `{storage, binding, resolveSecret, provisionFacade, revokeFacade,
requestProviderClose?, reconcileLater?, closureTimeoutMs?, staticFacade?}`. Its provider binding
is `{agentId, secretRef, apiBaseUrl, upstreamMicroPerMinute, visitorMicroPerMinute}`.
`provisionFacade({callId, facadeSecretRef, url, ...record}, options)` must provision
the configured agent's custom-LLM callback with this exact per-call bearer reference
and public callback URL in legacy mode. Resolve the reference only inside that server channel.
It must return only after provisioning succeeds; a missing/provenly unsupported
channel leaves voice disabled. Keys and facade secrets are never client initiation
options. In legacy mode `revokeFacade(ref)` removes the callback secret on terminal save;
the route layer also revokes immediately when closure starts. Static mode does
neither: the shared secret survives, while the call identity is disabled.

Register that plugin in the runtime's `PluginRegistry`. The host-private voice
selection in `presets.best.bindings.voice` is:

```js
const voiceSelection = {
  plugin: 'elevenlabs', model: agentId, agentId, effort: 'none',
  endpoint: 'https://api.elevenlabs.io', accountRef, secretRef,
  maxMicro, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
  publicFacadeBaseUrl: 'https://your-public-host.example',
  maxTokens: 1, rates: {inputMicro: 0, outputMicro: 0},
  legal: qualifiedAccountProfile,
};
```

`createDurationBinding` validates it. `model` must equal the exact agent id, so
account evidence cannot qualify another agent accidentally. `maxDurationSeconds`
is 1–3600 and its upstream cost must fit `maxMicro`; visitor holds are computed
from their separate rate. The token fields are common binding compatibility fields;
voice duration never uses them as token rates. `legal.evidence` must match account,
secret reference, agent/model, endpoint and routing, with current qualification,
consent scope and the preset's endpoint/residency policy. Delegated reaction
reasoning must also be available. Native provider reasoning remains unavailable.

Use the same authoritative consent port for handlers and runtime; a grant must
cover `processingScope(voiceSelection, 'start')` and the chosen reaction binding.
The demo's local mock consent cannot authorize ElevenLabs. API start accepts
`{callId}`; controls accept `{providerSessionId}`, close also accepts `reason`,
and events accept `{providerSessionId, event}`. Client-declared deadlines, model,
keys, cost, pause timestamps and facade configuration are ignored. Heartbeats
renew a server-derived lease even while paused; they never extend the absolute
spend deadline. Recover keeps `callId`, rotates the provider identity and `facadeCallId`
(in legacy mode, the facade secret), and separately admits each attempt; three failed retries return control.
Transport loss during pause waits for acknowledged Resume before retrying.

```js
const secrets = createFacadeSecrets(); // server-only, reference memory vault
// provisionFacade resolves secrets.resolve(record.facadeSecretRef) internally
const handlers = createHandlers({storage, pluginRuntime, consent, ownership,
  voice: {secrets, closeOrphan}});
await handlers.resume();
```

For durable hosts, `closeOrphan(record, {signal, deadlineAt})` requests supported
server shutdown and/or reads authenticated provider closure details. Return
`{providerSessionId, closureConfirmed:true, usage}` only with genuine final evidence.
The host must process `storage.voiceCalls()` records with `reconciliationPending`
on its durable scheduler, including across repeated restarts. The reference startup
retries this port within one second per pending call; failure keeps the pending
record and conservative charges. A confirmed reconciliation adjusts upstream and
visitor costs while preserving the original terminal receipt. Withdrawn/erased
sessions still permit this server-only cost reconciliation without restoring text.
The in-memory vault loses secrets at process death, thereby failing callback auth
closed; a production vault must revoke surviving external references too.

Browser setup uses `createVoiceControl({baseUrl, sessionId, sessionToken?, receive})`
and `createElevenLabsClient({sdk, control, persistEvent})`; pass that client as
`voiceClient` to `<aithema-session>.configure`. Track the public provider identity
from control start/recover and pass it to `persistEvent(event, {providerSessionId})`.
All rail strings are in the host's i18n bundle (`packages/ui/src/i18n/en.js`).
Pause/Resume and channel selections keep fixed targets. SDK audio elements with
blocked autoplay are retried by Enable sound on a gesture. An optional
`voicePlayback` callback handles a host-owned suspended audio context.

The demo defaults to `AITHEMA_VOICE_MODE=fake`. Its deterministic injected SDK and
provider API use no network; localhost routes still persist and settle the call.
Live mode is explicit `AITHEMA_VOICE_MODE=elevenlabs`. The demo's built-in
`demo/start2-voice-host.js` ensures `aithema-start2`; see the root deployment
section. An optional `AITHEMA_VOICE_HOST_MODULE=/absolute/path/to/private-host.mjs`
replaces that built-in host. That server-only
module exports `createVoiceHost({storage, facadeSecrets, resolveSecret})`, returning
`{binding: voiceSelection, policy, consent, provisionFacade, requestProviderClose?,
closeOrphan?}`. The key is selected by `binding.secretRef` and resolved at runtime.
The host module is never statically served. Provider calls in this change were tested only against localhost fakes.
Agent list/GET, `/v1/convai/secrets` GET and conversation identity/cost fields are
marked `verified by read-only GET 2026-10-09` from the coordinator's AIT-115 comment.
Agent/secret write bodies and the allowlist item remain marked
`UNVERIFIED API SHAPE` in `src/ensure-agent.js` for coordinator verification.

Native: text/context updates, microphone selection, audio barge-in and observed
heard prefixes. Emulated: output volume selection, engine pause/resume, automatic
recovery and visitor pause billing. Unavailable: force-interrupt control, native
provider reasoning, unconfigured/unqualified preset features. The SDK remains
pinned to 1.17.0; availability is demonstrated with local fakes, not live evidence.
