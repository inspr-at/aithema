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

## Recovery notices and last-reply repetition (AIT-138 c)

Successful recovery emits public notice flags after queued final/heard persistence
has drained. A final committed during that drain clears tentative speech's
unconfirmed flag. Playback mode records whether audio was still in flight;
completed playback does not acquire uncertainty merely because a reply exists.
Only the correction callback establishes a heard prefix. These checkpoints never
bind operations, alias provider generations or admit reasoning (Rule C).

`replayLastReply()` returns `{ kind: 'text', text }` for the most recent durably
acknowledged assistant callback, preserving its original whitespace and complete
text, including the remainder beyond any heard prefix. The rail opens an
accessible dialog with that exact reply and a short DE/EN explanation. Recovery
never invokes this command automatically. Pause, holds, recovery, output-off and
terminal hang-up fence it; the UI also rejects late results after a new turn or
hold and closes any open fallback dialog.

This is the explicitly approved fallback, pending **Tick and LEAD's decision**:
the pinned `@elevenlabs/client` **1.17.0** `BaseConversation.d.ts` exposes user
messages and contextual updates, with no arbitrary-agent-text speak command.
The documented [client-to-server events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events)
and [JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script)
likewise supply no such path. `sendUserMessage` starts an agent turn, so it is
unsuitable for repetition. This integration retains no complete per-reply audio;
an in-flight audio fragment cannot honestly replay the entire reply. A separate
TTS request would add provider spend and require its own admission, outside this
part's constraints.

**Incremental repetition cost: EUR 0 (0 micro), 0 model calls, 0 TTS requests,
0 new admissions.** Existing live conversation duration is still metered under
the admitted call; opening the text dialog does not pause or extend that call.
No new provider API capability or live audio replay qualification is claimed.
If a transport cuts a new reply before its complete final callback is available,
the notice keeps its repeat button visibly disabled and explains why. It never
substitutes the previous answer for that interrupted reply.

## Contract and controls

Core exports the runtime contract at `@inspr/aithema-core/live-voice`.
AIT-102 PR 1 adds optional `ports.serverAdapter`, `ports.browserMedia`,
`ports.replyExecutor` and `ports.components` contracts alongside the existing
session API. Server adapters validate private configuration, start admitted
segments, stop them and return authenticated reconciliation evidence. Browser
media consumes `{callId, providerSessionId, expiresAt, opaque}` grants; only the
adapter interprets `opaque`. Capture, playback and teardown delegate to the
existing client and retain its lifecycle, interruption and hold fences.

`createElevenLabsConfig({agentId, publicFacadeBaseUrl?, usdPerCredit?})` owns the
private adapter fields. Both duration and server bindings accept `adapterConfig`;
their legacy fields are enumerable getters, preserving existing JSON and binding
hashes. `adapterConfig` is non-enumerable and frozen. `model === agentId` remains
required until PR 2b; public routes and facade wiring remain in place until PR 2a.
The server adapter exposes this private config through `ports.serverAdapter.config`.

`createElevenLabsReplyExecutor({execute})` reads today's operation SSE response
into operation identity, text deltas and completion. Inject the existing admitted
operation execution in-process, returning `{operation, response}` with identity
from the Rule C store; input envelopes never supply operation keys. The envelope's source label is no authentication
mechanism. Provider callbacks must pass today's bearer and owned-call checks first.
A future server coordinator must remain in-process, with no browser fields or
network route. The shared executor's SSE implementation is unchanged in this PR.
STT/TTS belong to the agent platform: their separate component ports return coded
`unavailable`. Future independent kits negotiate audio format and report component
usage with explicit attempt, role, unit, quantity, cost, source and estimate status;
this bridge invents neither component usage nor a second parent charge.

The baseline at `test/fixtures/elevenlabs-wire.json` was captured remotely from
unchanged main `550b4de`. `test/voice-wire-fixtures.js` records synthetic callback
request/response bytes, SSE, retries, history growth/truncation, partial failure,
the opener guard, token/signed-URL minting and delayed closure/usage reconciliation.
Only generated reply UUIDs are normalized; frame boundaries, JSON field order,
whitespace, headers and cost precedence are compared byte for byte. Its versioned
`aithema-voice-wire` format is available to PRs 2a/2b and AIT-139. Default maximum
duration remains 3600 seconds; a new-host default change requires the later OPS pin.

AIT-139 adds independent synthetic v1 oracles in
`test/fixtures/voice-observability-callbacks.json` and
`test/fixtures/voice-observability-reconciliation.json`. The offline replay in
`test/voice-observability-wire.js` covers growth, truncation, duplicate stream/JSON
readers and partial failure; reconciliation tests inject the exact recorded GET
responses for pending closure, estimated usage and confirmed usage. These
expectations are authored independently of the production recorder and shared
with `plugins/composed-voice/test/observability.test.js` through
`test/voice-observability-fixtures.js`. Each oracle cites the vendor documentation
for its wire shapes and distinguishes local extensions and synthetic timing
scenarios. The original
`elevenlabs-wire.json` remains byte-identical.

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

The manifest declares `capabilities.interruption: 'native'` with provider-owned
turn-taking. A genuine heard-prefix correction, its length-only interruption
marker and its persistence receipt commit in one storage transaction. Failed
marker writes roll back the correction so a retry can save both. A refused
interruption marker still ends the client call as `transcript-persistence-failed`;
changing that visitor-visible outcome requires a separate Tick decision.

Provider 429 responses retain `Retry-After` only for integer delta-seconds or a
strict HTTP-date (IMF-fixdate, RFC 850 or asctime, interpreted in UTC). Invalid
dates, times, weekdays, zones and trailing junk are omitted. Valid dates become
nonnegative whole seconds, rounded up; the existing lifecycle delay cap stays
60 seconds.

AIT-146 repairs playback at that native callback, synchronously and independently
of transcript persistence. SDK 1.17.0's WebRTC output `interrupt()` is a no-op;
its WebSocket output fades for two seconds and the concat worklet continues
rendering queued PCM until `clearInterrupted`. The adapter mutes through the
SDK's volume path, clears the WebSocket worklet immediately, and fences late
audio before the connection can forward it to the queue. WebSocket playback
unlocks synchronously on the first audio event with a newer provider id, before
`WebSocketConnection.handleMessage` forwards it to output listeners (pinned
SDK `dist/utils/WebSocketConnection.js:160-171`). It does not wait for the
complete `agent_response`, which can follow streamed TTS audio.

WebRTC unlocks on the first newer provider `agent_chat_response_part` start or
nonempty delta, or an audio event carrying alignment and a newer provider id,
whichever arrives first. The pinned SDK routes provider data-channel audio
through `handleMessage` (`dist/utils/WebRTCConnection.js:292-310`); streamed
text parts retain their id in `onAgentChatResponsePart`
(`dist/BaseConversation.js:254-257`, `381-383`; `@elevenlabs/types`
`dist/generated/types/asyncapi-types.d.ts:148-157`). Alignment identifies TTS
metadata from the provider: the local analyser synthesizes audio events with
unrelated sequential ids and no alignment (`dist/utils/WebRTCConnection.js:435-449`).
Those counters and listening/speaking notifications cannot unlock playback.
LiveKit handles the media stream and its interruption; the replay checks the
SDK audio element's volume and stale provider metadata, without simulating
RTP ordering between the media track and data channel.

Fresh ids are recorded even during pause or output-off; output volume still
honors both controls, and acknowledged resume uses the updated interruption
state. A fresh audio id also fences delayed interruptions and older provider
audio, while additional chunks with the same fresh id remain valid. Final
callbacks received during pause still do not emit or persist transcript turns.
The SDK internals used here are covered by replay against the pinned SDK and
its actual generated worklet. Updating the SDK requires requalifying that path.
Only the existing correction callback supplies a genuine heard prefix.

The owned `aithema-start2` startup policy uses `turn_eagerness: patient`,
`turn_timeout: 12`, `spelling_patience: auto`, `turn_model: turn_v3`, and
`speculative_turn: false`. It replaces template ASR keywords with Aithema,
Hosting, Domain, Webshop, Schnittstelle and Datenschutz. Each policy field and
the exact keyword list must match the provider GET after create/PATCH; otherwise
voice remains disabled. START's template receives only GET requests.
[ElevenLabs' conversation-flow guidance](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)
recommends patient turns and longer silence timeouts for detailed information
collection. The 12-second setting is the silence fallback, not a guaranteed
minimum pause before every reply.

Evidence from the reported call shows six interrupted agent turns and the user
fragment "Ich hab noch kei-" at 748 seconds, followed by a reply at 754 seconds.
The fragment was already truncated in the provider transcript; the browser
does not finalize partial captions itself. The normal provider turn setting is
a tuning hypothesis for that truncation, not proof of its acoustic cause.
Offline replay covers immediate cutoff (under 300 ms), queued/late audio,
channel controls, and a complete German utterance across virtual thinking and
spelling pauses. Provider endpointing is supplied by the fake in that replay.
Applying the startup policy to the live owned agent and verifying German speech
with pauses remain coordinator checks; this builder makes no provider calls.

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

`overrides.agent.language` and `overrides.agent.firstMessage` are allowed on
the server and in the browser (AIT-127, AIT-175). Hosts configure DE/EN openers;
`aiNoticeText(language)` supplies a neutral default. Opening copy must include
the matching "KI-Assistenz" or "AI assistant" disclosure, omit the other
language's disclosure, and be at most 1000 characters. This checks structure;
the host is responsible for what its copy means. Hosts may also configure
`spokenContinuations: {de, en}` with the same disclosure rules. The server passes
`{hasPriorTurns}` as the second argument to `presentation(locale, context)`;
saved, active conversation turns select the continuation for a fresh voice start
or an explicit Resume that replaces the transport. Automatic transport recovery
stays empty. Continuation copy uses the already allowed per-call first-message
override; it does not change the managed agent's opening or permissions.
Model, prompt, credential and custom-LLM overrides are rejected. Startup receives
`spokenOpeners: {de, en}`, enables both platform fields on the receipt-owned
agent, and checks exact read-back against the configured base-language opener.
The per-call opener comes from the same host configuration. Visual AI disclosure
and consent remain separate and unchanged. At deploy OPS restarts start2 with
its existing database/WAL; normal ensure PATCHes and GETs only its owned agent.
START's template remains GET-only. With AIT-224 an unchanged owned agent uses
GET only. Drift PATCHes the changed top-level managed configuration and reads it
back. Existing strict verification remains fatal; additional managed fields such
as prompt text, tools and knowledge base are warn-only on read-back. Built-in tool
nulls, RAG tool info and provider metadata are unmanaged. Allowlist items compare
by hostname only, with one matching host still required. Empty template picks
are ignored, while language presets remain an intentional exact clear.

The facade secret uses a local SHA-256 last-written receipt in
`host_voice_secret_hashes`, keyed by host secret name and provider secret id.
Only a successful POST/PATCH updates it; the raw secret is never persisted or
logged. Matching hashes skip the secret PATCH, rotation writes once, and an
existing ownership receipt without a hash requires one initial PATCH.
See the root AI-notice section for the exact
start2 sentences and deploy instructions.
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
Known usage records provider seconds/minutes/credits, separate paused and
visitor seconds, and both costs. Upstream cost prefers `metadata.cost_fiat`
(total USD), then `metadata.cost` (total credits) converted with the private
binding's configurable `usdPerCredit`. When the total is absent, charging
components supply the credits: platform/call, LLM, and post-call analysis.
The total and its components are never added together. See the provider's
[current metadata schema](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/conversation_history_metadata_common_model.py)
and [charging schema](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/conversation_charging_common_model.py).
Without a usable charge/conversion, real duration × configured per-minute rate
is recorded with `costEstimated: true` and `costSource: 'duration-estimate'`.
Estimates stay in uncertain spend and may later be replaced by actual charges.
USD amounts round upwards once to whole microUSD. Visitor pause accounting
continues to use its separate per-minute rate.

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

The callback body limit is **8 MiB (8,388,608 bytes)**, configurable with
`maxRequestBytes`. The current integration observes cumulative per-generation
history in the callback `messages` array. The [custom-LLM documentation](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)
describes OpenAI-compatible chat requests; it does not promise untruncated
history in every configuration. The [full-history fixture](test/facade.test.js)
passes 36 user/assistant entries above 64 KiB and checks that every entry survives
the facade unchanged. The host uses its canonical session history for reasoning,
plus only the newest unrecorded callback input. The observed growth of
72,176 bytes after about four minutes projects to about 2.1 MiB at the 120-minute
voice cap, leaving nearly fourfold headroom. `readJson` counts actual bytes,
coalesces tiny chunks into bounded 64 KiB slabs, and cancels body reads on the
facade deadline. Parsing temporarily also requires a contiguous byte buffer,
decoded text and the JSON object. The HTTP adapter uses a bounded intermediary
stream so reader cancellation preserves the socket until the JSON reply is sent;
early replies close the connection without draining the remaining upload.
For AIT-137, operation identity uses only this authenticated callback body:
SHA-256 of session, call, provider generation, original user-message count and
the digest of the exact body/history prefix through its last user message.
System/assistant history, exact text and provider metadata remain in the digest;
`stream` is a reader representation and is excluded. Client finals never modify
operation identity or state. A different prefix starts a new operation;
identical retry bodies coalesce and replay.

Null/empty user entries, absent user entries, explicit `history_truncated` or
`messages_truncated` indicators (top-level or in `elevenlabs_extra_body`) make the
ordinal unknown. Identical unknown bodies still have the same key. A previously
unseen lower ordinal is treated as possibly regressed/truncated and starts new
work. Truncation that changes the body can cause an additional operation and
charge; it cannot capture an old ordinal slot, refuse new work as obsolete or
fence paid work. A silently truncated body byte-identical to an earlier full
retry cannot be identified from that body alone; integrations that truncate
must signal incompleteness. No history completeness is inferred from client
receipts or predecessor operations.

The client stamps each unique user final with `userTurnOrdinal` in capture order
within the call and provider generation, before enqueueing persistence. Assistant
finals and duplicate event IDs do not advance it. Finals suppressed while paused
leave gaps, and recovery starts the new generation at one. `event_id` is retained.
These fields are transcript metadata only. Every completion has an opaque reply
ID belonging to its operation, including coalesced readers and replays. The
first SSE frame carries `metadata.aithema_reply_id`. The owned agent enables and
read-back verifies the [custom-LLM `agent_response_metadata` event](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events).
SDK 1.17.0 forwards it through `onDebug`; its provider `event_id` lets the client
carry `replyId` on that exact assistant final. The server looks up the reply ID
and stamps its operation's ordinal. Text only checks that receipt's bytes.
Missing or unknown IDs never select an ordinal by text. If metadata arrives
after its final, a `reply` persistence receipt adds a `turn.annotated` event with
the reply ID and ordinal. This changes transcript metadata only, is idempotent,
and keeps heard corrections on the same turn. No receipt-correlating operation
aliases, binding or ambiguity log remain.

For an already admitted voice reply, append-only ordinary user/assistant finals
and reply-identity annotations are benign. User finals must exactly account for
the numeric input-revision increment; prior transcript bytes and uploads must
remain unchanged. Consent/conversation-consent, withdrawal, locale and session
revision changes, ownership loss, pause, erasure, processing-choice changes and
call cancellation retain their dispatch fences. Upload changes and heard-prefix
corrections are not append-only finals. Fresh consent coverage and the budget's
single-use claim still refuse withdrawal or revoked spend. Other reasoning
lanes keep their strict input-revision checks.

The 30-second callback timeout, call leases
and earlier admission deadline still apply; iterator disposal and settlement
each have a separate one-second bound.

Failures before SSE starts return JSON `{error: code}` with `cache-control:
no-store`: `method-not-allowed` → 405; `unauthorized`/`auth` → 401;
`not-admitted` → 403; `invalid-output` → 400; `limit` → 413; `deadline` → 504;
`cancelled`, `already-claimed`, `unavailable`, `rate-limit`, `provider` → 502.
Unknown facade errors become `provider`; the HTTP adapter's fallback is 500
`server-error`. Oversized request bodies always use 413
`{"error":"limit"}`. After SSE starts, failures emit `data: {"error":"code"}`
and close without a stop frame or `[DONE]`; the HTTP status is already 200.

The provider-neutral turn executor and server lifecycle share the host's
`voice.log` port. New stage records are JSON strings, one line per stage, with
`event`, `callHash`, `generationHash`, `turnHash` and `attemptHash`. IDs are SHA-256
hashes with separate domains for generations, turns and attempts; the turn uses
the first random operation-attempt ID rather than speech or a history digest.
Correlation survives explicit replacement and server restart. Transport
reconnect records contain call/generation hashes only.

| Event | Additional allowlisted fields |
| --- | --- |
| `voice.turn.admission` | `admissionMs` |
| `voice.turn.first-token` | `firstTokenMs` |
| `voice.turn.completion` | `totalMs`, `outcome` (`completed`/`failed`), optional bounded `cause` |
| `voice.turn.retry` | bounded `cause` (duplicate callback, replay, benign admission race or failed-attempt code) |
| `voice.turn.closure` | `closureConfirmed`, `costEstimated`, `reconciliationAgeMs` |
| `voice.segment.reconnect` | bounded `cause` |

Times are nonnegative milliseconds from writer start, including admission time,
clamped to the previous stage duration if the wall clock moves backwards.
First token means the first nonempty validated executor delta; it is recorded
once per attempt, regardless of chunk or reader count. Completion follows the
durable terminal write. Exactly one confirmed segment closure is reported per
settled writer attempt in that generation; pending writers receive it after their
terminal write. Uncertain lookups wait for confirmation, and later usage updates
use reconciliation records rather than another closure. Diagnostic deduplication
is bounded to 4096 entries per executor; eviction or restart can permit a repeat.
Reconciliation age starts at segment end, or segment start for an open orphan.
Existing object records `voice.cost-reconciled` and `voice.reconciliation-retry`
retain their fields and add generation correlation and reconciliation age.

For example (hashes abbreviated here; records contain 64 hex characters):

```json
{"event":"voice.turn.first-token","callHash":"ab…","generationHash":"cd…","turnHash":"ef…","attemptHash":"12…","firstTokenMs":230}
```

The closed field/value allowlist omits speech, prompts, email addresses,
credentials, headers, URLs and exception messages. Logging failures cannot
change execution or accounting. There are no per-chunk turn records.

The optional `log` port defaults to stdout JSON lines, one per completed,
failed or cancelled callback: `{time,level,event:"voice-callback",status,
latencyMs,requestBytes,responseBytes,errorCode,callIdHash}`. Bytes mean observed
request bytes and serialized/enqueued response bytes; rejected unread bodies
count as zero. `callIdHash` is the first 16 SHA-256 hex characters of the resolved
call id, or null before resolution. Success uses info/null; every failure uses
error/a stable code. Bodies, URLs, raw identities, error messages, authorization,
cookies and keys never enter these lines.

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
browserLivenessDeadlineAt,overrides?,facadeCallId?}`. The language and matching
AI notice come from the server host's `presentation(session.locale)` configuration.
Browsers never supply server authority, API keys or
facade secrets; joined tests carry authority in-process solely for conformance.

`persistEvent(event)` writes final/heard events and late `reply` annotations durably with idempotent turn ids.
Persistence failure ends the call rather than claiming a durable turn.
Consume `session.events`; SDK activity signals are not transcript evidence.

AIT-235 event finding (offline, SDK **1.17.0**): both user transcript events
exist in `@elevenlabs/types/generated/types/asyncapi-types.ts` and are enabled
in the owned agent's `client_events` (also recorded in the agent-readback fixture).
`tentative_user_transcript` carries
`tentative_user_transcription_event.user_transcript`; the SDK forwards it through
`onDebug` and the adapter emits a non-durable user `partial`. Each hypothesis
replaces the preceding text. `user_transcript` carries
`user_transcription_event.{user_transcript,event_id}`; the SDK calls `onMessage`
and the adapter persists a user `final` before exposing it. This is the start2
Conversational AI path, independent of AIT-160's composed STT path. Offline
inspection establishes support and wiring, not a fresh observation of a live call.
The conversation shows hypotheses in a muted, labelled provisional user bubble,
hidden from assistive technology. The saved final promotes the same row and
keeps its position; final text uses normal bubble sizing and can grow. A provider
final arriving before the saved turn stays in that row until persistence is attached.
Completed turn ids and ordinals fence late partials. Because tentative events lack
a provider turn id, the adapter admits a new hypothesis only after the next
speaking-to-listening boundary. Speaking and assistant finals discard unfinished
hypotheses.
Pause, recovery, call end and invalidation discard provisional text. DE/EN labels
belong to the UI; the transcript text always comes from provider events.

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
is 1–86400. With `reservationSeconds`, the expected segment cost must fit
`maxMicro`; admission/start reserves at least `minRunwaySeconds` (host default 120). Rolling extensions reserve elapsed time
plus one segment; a refused next segment uses the already funded time before
closing with `budget-limit`. A shorter technical call reserves
its entire remaining duration. Insufficient funds return `host-limit` before facade
provisioning or credential minting; the rail uses its existing “Credits aufgebraucht”
state. An extension refusal keeps the existing clean close. Every adapter close
logs `{event: 'voice-closed', reason, callHash, providerHash}` once, without raw ids. Without that optional
setting the legacy full-duration bound applies. Visitor holds are computed
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
retries this port within five seconds per pending call; failure keeps the pending
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

## Facade secret drift recovery (OPS)

OPS: use this section when callbacks repeatedly return 401 after an external
secret-value edit. With the same `facadeSecrets` store passed to the voice host
and callback adapter, three bearer rejections within a rolling five minutes clear
only that secret's SHA-256 write receipt and immediately re-run the existing
ensure path in process. Ownership checks still apply; the owned secret gets one
idempotent PATCH with the current configured value. No restart or DB edit is
needed. One stray request or an expired group cannot trigger repair.

Repairs are limited in memory to one per thirty minutes, including failed or
ambiguous PATCH attempts. Any failed repair goes off with `transient: true` and
uses the existing unref'd backoff timer, delayed until the write cooldown expires,
so a later successful ensure restores the prepared runtime without a restart.
While no binding exists, the orphan sweep catches `closeOrphan`'s
`AgentEnsureError`, retains the durable pending call and retries later.
The detector stores at most three timestamps and starts no extra timers. A fresh
threshold is required for a new repair after cooldown; shutdown disconnects detection and cancels
retries. Restart resets the in-memory limit, and an invalidated receipt also makes
the next boot repair the value. Hosts without the shared store have no detector.
Each repair logs only `{event: 'voice-secret-repair', name}`. Bad requests remain
401 before any body read; credentials, headers, hashes and counters never enter
that event or public reasons. Persistent 401s after repair require OPS to check
host configuration and secret ownership using value-free diagnostics.

## Native end-call event contract and GET-only agent health (AIT-379)

The managed `conversation_config.conversation.client_events` contract is:

```json
["conversation_initiation_metadata", "asr_initiation_metadata", "audio", "interruption", "user_transcript", "tentative_user_transcript", "agent_response", "agent_response_correction", "agent_chat_response_part", "agent_response_metadata", "agent_tool_response", "ping"]
```

Ensure writes this complete list and verifies it exactly on readback, including
order and cardinality. Missing, duplicate, extra or reordered events disable voice
with `agent-readback-mismatch`; diagnostics identify the setting in `fields` and
provide an event-specific `remediation`. Provider values and credentials are not
logged. An older captured agent without `agent_tool_response` needs the authorized
host ensure to apply the contract before it is healthy.

Native `end_call` is an intentional end. SDK 1.17.0 receives it through
`agent_tool_response` and forwards `onAgentToolResponse`; the adapter closes media
and the logical session immediately. Its explicit `end_call` disconnect context
also remains terminal. Late disconnect/error callbacks cannot reconnect the call.
The existing ended message and Start control permit a fresh call. Transport
failures retain their three automatic recovery attempts, then Waiting/Resume.

OPS can import the server-only health check using the configured agent identity
and the host's existing secret resolver (no credential literal or environment dump):

```js
import { checkAgentHealth } from '@inspr/aithema-plugin-elevenlabs/agent-health';

const health = await checkAgentHealth({
  agentId: configuredAgentId,
  apiBaseUrl: configuredApiBaseUrl,
  resolveSecret,
});
```

This function sends exactly one `GET /v1/convai/agents/:agentId`, inspects only
`conversation_config.conversation.client_events`, and returns
`{healthy: true, agentId, clientEvents}` when it matches. It does not list agents,
read workspace secrets, run ensure, start a conversation or mutate configuration.
`secretRef` defaults to `ELEVENLABS_API_KEY`; the host may pass its configured
reference. Requests refuse redirects and use a 15-second deadline, optional abort
signal and bounded JSON read. An incomplete/drifted contract throws
`AgentHealthError` with code `agent-client-events-mismatch`, missing required event
names and an instruction to run the authorized host ensure, then repeat the check.
HTTP/network failures expose safe retry/access guidance without provider bodies.
All AIT-379 validation uses offline fixtures; no live health check was run.
