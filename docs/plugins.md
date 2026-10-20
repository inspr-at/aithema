# Plugin contract

Aithema accepts model adapters as host-selected modules. A plugin does not need
an entry in `plugins/`, a core patch, or a server patch. Import its factory in
the host, register the instance with `PluginRegistry`, and configure private
bindings and preset choices. The executable example is the standalone package
[`test/fixtures/external-plugin/`](../test/fixtures/external-plugin/package.json)
and its [host configuration](../test/fixtures/external-plugin-host.js).
It is a deterministic fake, not a qualified provider. Development workspace
packages remain private at `0.0.0`; this proof does not publish an npm package.
See [Embedding Aithema](embedding.md) for installation and host ownership.

## Kinds and ports

`PLUGIN_KINDS` and `MANIFEST_SCHEMA` are public exports of
`@inspr/aithema-core`. The registry requires `health` for every plugin, in
addition to its kind's operations. These are the actual kind IDs:

| Kind | Port and operations | Host routing |
| --- | --- | --- |
| `reasoning` | `Reasoning.stream`, `structured`, `health` | Replies use `reaction`; analysis uses `understanding`. They may bind different models. |
| `stt` | `STT.transcribe`, optional `stream` | Transcription; declare supported audio formats. |
| `tts` | `TTS.speak` | Speech synthesis; yields audio bytes. |
| `live-voice` | `LiveVoice.start` → `VoiceSession` | Voice agent with native or delegated reasoning; separate server and browser entrypoints. |
| `ui-generation` | `UIGeneration.generate`, `edit` or `HTMLGeneration.generate`, `edit` | Visual choices select `images` or `html`; HTML declares `text/html`. |
| `extractor` | `Extractor.extract` | Bounded document extraction, never an implicit reasoning route. |
| `exporter` | `Exporter.export` | Export bytes and media type; admission requires host integration. |

“Model”, “image”, “HTML” and “concept” describe product roles, not extra manifest
kind IDs. The concept lane invokes the selected image or HTML port. Text/PDF/OOXML
extractors use isolated offline workers with byte, time and output bounds. Voice
components use `STTComponent`/`TTSComponent` with `AudioFormatPort` and component
usage terminals; their accounting is distinct from reasoning tokens.

## Manifest and capabilities

The manifest is public technical metadata. Validate it with `validateManifest`;
`PluginRegistry.register` rejects invalid manifests, duplicate IDs, missing
operations and missing health. <a id="contract-manifest-freeze"></a>
Registration keeps an already deeply frozen manifest by identity; otherwise it
deep-clones and deep-freezes a copy. Later edits to an unfrozen original cannot
change the registered manifest.

`liveVoice.capabilities.interruption` is optional. Only `'native'` together
with `liveVoice.ownership.turnTaking: 'provider'` permits browser SDK
interruption evidence on the session voice-events route. Missing, emulated or
unavailable declarations retain coordinator authority; no provider ID grants it.

Required fields are `id`, `version`, `apiVersion` (currently `^1.0.0`), `kinds`,
`placement` (`server` or `browser`), `entrypoints`, `configSchema`, `vendor` and
`models`. The selected placement must have an entrypoint. A model declares `id`
(an exact model or `*`), `operations`, `streaming`, `structured`, `efforts`,
`languages`, `germanQuality`, `formats`, `processingLocations`, `qualification`,
`evidence`, `expiresAt`, and `cost` (`unit`, `inputMicro`, `outputMicro`,
`reviewedAt`). Null prices mean unknown, not free. Metadata dates must parse.
Only operations supported by the declared kinds are valid.

Optional `presentation` supplies a label and translated labels/consent items.
A translated `consentItem` has `id`, `version`, `title`, `recipients` and `text`.
The host must actually present and grant that item through its consent port;
metadata does not grant consent. `configSchema` describes configuration shape;
private defaults, credential/account references and legal evidence do not belong
there. Keep those in server-private bindings.

`live-voice` additionally requires `liveVoice` and both entrypoints. Declare
reasoning ownership, transcript finality/persistence, billing and each command's
`native`, `emulated` or `unavailable` support. Pause/resume availability must
agree. Optional composition `ports` contain `serverAdapter`, `browserMedia`,
`replyExecutor` and STT/TTS `components`. Browser media receives a short-lived
opaque grant, never server credentials. Authenticated provider callbacks and
server coordinators own reply admission; browser transcripts cannot authorize it.

## Authority, lifetime and cost

The typed operation envelope below is checked against
[`plugin-contract.d.ts`](../packages/core/src/plugin-contract.d.ts).

```ts
export type Usage = { inputTokens: number; outputTokens: number };
export type Terminal = { attemptId: string; servedModel?: string; chargedMicro?: number } & ({ outcome: 'completed' | 'cancelled'; usage: Usage } | { outcome: 'uncertain'; usage?: Usage });
export interface OperationOptions {
  signal: AbortSignal;
  deadlineAt: number;
  now?: () => number;
  attempt: { attemptId: string; claimId: string; consume(): Promise<void> | void };
  report(terminal: Terminal): Promise<void> | void;
}
export interface Health { available: boolean; reason?: string }
export interface Reasoning {
  stream(request: { system: string; messages: { role: string; content: string }[] }, options: OperationOptions): AsyncIterable<string>;
  structured(request: { system: string; messages: { role: string; content: string }[]; schema: object }, options: OperationOptions): Promise<unknown>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt' | 'now'>): Promise<Health>;
}
```

Honor `signal` and the absolute `deadlineAt` for the entire operation, including
response-body reads. Pass the same optional `now` clock that produced the
deadline to nested operations and `operationScope`; it defaults to `Date.now`.
An explicitly configured runtime clock remains authoritative for policy checks;
otherwise handlers install `host.now`, then legacy `voice.now`, then `Date.now`.
The runtime exposes that shared clock as `runtime.now`; HTTP/voice deadlines,
continuation reservations, voice-cap and render UTC days/holds, concept lanes,
storage policy/evidence and voice callbacks use it. Exact
evidence expiry refuses admission before spend. Ledger settlement timestamps
retain the host clock for accounting attribution; evidence age and retry dates
use that same accounting epoch. Custom voice caps/render limiters must implement
`setClock(clock)` when installing an explicit runtime/host clock. Independent
providers/coordinators must receive `now: runtime.now` (see embedding clock rule).
Receipt reconciliation lookup
and repair-batch timeouts use separate elapsed wall-clock transport budgets.
Consume the admitted claim **once, before outbound work**.
A refused claim must produce no output or provider dispatch. A retry needs a new
admission. `beginInvocation`, `operationScope`, `PluginError` and
`normalizedError` are public helpers; always dispose operation scopes.

Report exactly one terminal for the matching attempt. Completed/cancelled usage
contains nonnegative safe-integer input/output token counts, including billable
reasoning tokens. `chargedMicro` is actual USD cost in whole micro-dollars;
`servedModel` records the actual producer when the provider resolved an alias.
Actual cost takes precedence over binding token rates. Without actual cost,
complete token evidence can use those rates. Unknown dispatched spend uses
`outcome: 'uncertain'` and retains its conservative reservation. A missing report
also settles conservatively and is rejected as invalid output. Never substitute
zero for unknown usage or price. Before dispatch, cancellation costs zero.

AIT-198's two obligations are independent: **never emit an assistant final made
from provider thinking** (including reasoning-only, truncated and cancelled
responses), and **report the cost even when no publishable answer exists**.
Yield only the reply wire output described below; never provider thinking.
Validate `structured` output against its requested schema. Keep provider thinking
out of reply deltas/finals and saved transcripts.
For providers with authoritative receipts, use
`beginInvocation(options, { authoritativeCost: true })`, record usage and cost,
and finish in `finally`. Missing cost then produces an uncertain terminal even
if tokens were observed. The external fixture tests this behavior through the
real budget ledger. The optional cost extensions below govern later reconciliation.

Voice uses `VoiceTerminal` with closure confirmation, duration, upstream/visitor
costs and provider identity. Components report `ComponentTerminal` and
`ComponentUsage` units. Images and HTML must return their validated artifacts,
origin and generator provenance, and report their actual costs through the
admitted operation. Do not invent watermark/signature assurances.

## Reply wire output

<a id="contract-reply-request"></a>
The `Reasoning` type above is the minimal port. At runtime, text reaction
requests also carry `schema` (in addition to `system`, `messages`, `locale`,
`preset`, `draft` and `documentMessageIndex`). With an enabled purpose policy,
they carry normalized `purposePolicy`, `offTopicTurns` and private
`hiddenGuidance`; `schema` then includes `scope`. Without that policy they carry
the ordinary reply schema. Voice replies without a purpose policy omit schema.
Do not expose private guidance in output or logs.

<a id="contract-reply-policy"></a>
With a purpose policy, `stream` yields string chunks which concatenate to one
JSON object matching the supplied schema: `content` (complete natural reply),
`question_short` (string or null), `options` (up to four `{text, likely?}`
choices, at most one likely), and `scope` (`in`, `unclear`, `off`). Put `content`
first. JSON fences are accepted. The host buffers the whole stream before UI or
TTS publication, parses JSON and rejects plain text, empty content, invalid
normalized base replies and unsafe output. Card metadata is normalized rather
than strictly validating the entire raw object: malformed choices are dropped;
missing/invalid scope becomes `unclear`, clearing choices. Off-topic or unsafe
output cannot publish the provider's requested off-topic content.

<a id="contract-reply-plain"></a>
Without a purpose policy, lanes use `ReplyStream`: plain text is accepted, even
though text requests carry a schema and prompt for JSON. Content-first JSON
streams decoded `content` only; final parsing supplies optional question cards.
Malformed card metadata is dropped without failing usable content. Empty replies
are rejected; reply content is bounded to 16000 characters. Never yield SSE
framing or provider reasoning as reply content.

## Failures and retry

<a id="contract-error-codes"></a>
Throw `PluginError` with one of these codes. When it reaches the HTTP handler,
the response is `{error: code}` (with a reason only for specific allowlisted host
messages), with these status codes. `normalizedError` preserves `PluginError`,
turns an ordinary error into `provider`, and gives an aborted signal precedence
(`deadline` for TimeoutError, otherwise `cancelled`).

| Code | HTTP status |
| --- | --- |
| `cancelled` | 502 |
| `deadline` | 502 |
| `not-admitted` | 403 |
| `already-claimed` | 502 |
| `unavailable` | 502 |
| `auth` | 502 |
| `rate-limit` | 429 |
| `provider` | 502 |
| `invalid-output` | 502 |
| `limit` | 502 |

<a id="contract-reply-retry"></a>
The purpose-policy collector permits at most two reply attempts. Each invocation
needs fresh admission and its own settlement. Rejected output (`TypeError`,
`invalid-output`, or a parsed reply rejected by the guard) permits the second
attempt with additional safe-JSON guidance. Two rejected outputs yield a host
neutral question or off-topic redirect, never the rejected wire text.
`responseFormatUnsupported: true` on a constrained attempt requests a second,
prompt-only attempt (`replySchemaConstrained: false`); it still carries `schema`
and must return safe JSON. `providerErrorClass: '4xx'` labels that retry's reason
`provider-4xx`, otherwise `schema-unsupported`. A provider error during the second
attempt falls back unless its class is `4xx`; other provider errors propagate.
Generic first-attempt errors, auth, rate-limit, cancellation and deadline are
not automatically retried.

<a id="contract-http-settlement"></a>
The shared chat-completions adapter sets `providerErrorClass` from the HTTP
status (`4xx` or `5xx`). It sets `responseFormatUnsupported` only for HTTP 400/422
when a `response_format` was sent and the fully read error contains explicit
schema/parameter compatibility evidence. Status alone, unrelated 400s, 408/499,
429 and 5xx do not enable that retry. Other adapters may explicitly signal a
streamed capability refusal with this flag; the collector trusts that signal.
A fully received 4xx with no usage settles at zero except 408/499. Usage-bearing
errors and 5xx without actual cost stay conservative for authoritative-cost
adapters; actual receipts still settle actual cost. Incomplete/erroring body
reads cannot prove zero spend. This is settlement evidence, independent of
whether an answer is publishable.

## Optional cost extensions

<a id="contract-cost-reservation"></a>
These are runtime extensions, not required members of the minimal typed port.
`estimateCost(request, operation)` is optional: it supplies the reservation in
feature evaluation and again for actual admission; the latter must be a safe
integer within `binding.maxMicro`. Without it, reasoning reserves
`binding.maxMicro`; a separate prompt/token bound still checks that ceiling.
`providerOptions(isStream)` is optional: its adapter options enter the serialized
prompt byte bound alongside `request.providerOptions`, system, messages and
schema. Neither replaces the required consume/report contract.

<a id="contract-cost-reconciliation"></a>
`reconcileCost(record, options)` is optional: its presence enables durable
provider-cost metadata and supplies `attempt.observeCost(evidence)` and
`attempt.dispatchCost()` on admitted options. Call dispatchCost at outbound
dispatch, observeCost as generation identity, observed floor or actual receipt
arrives. They persist evidence and dispatch state in the budget ledger, separate
from the required terminal report. The runtime calls reconcileCost for uncertain
attempts without an actual receipt, with a deadline capped at five seconds.
Return receipt evidence with safe-integer `chargedMicro` and the matching
`generationId` when one is recorded; mismatched identity cannot release a hold.
Without this hook, these attempt extensions are absent and uncertain terminals
retain their reservation.

`uncertainEstimateMicro` is an optional configured fallback;
`estimateUncertainCost(request, operation)` optionally overrides it per request.
After the reconciliation window, a valid configured
estimate can replace the uncertain reservation, never below observed spend or a
previous estimate. Without evidence or an estimate, the hold remains pending.
`costEvidence(attemptId)` optionally supplies saved receipts before lookup;
`usageCost(usage, model)` optionally supplies an observed token-cost floor;
`reconcileSpend(attemptId, chargedMicro)` optionally repairs an adapter's spend
ledger after non-estimated reconciliation. Actual evidence can correct an
estimated settlement later. Receipt lookups are bounded to twelve attempts when
a generation ID is present.

The behavioural drift guard is [plugin-contract-behaviour.test.js](../test/plugin-contract-behaviour.test.js).
Its test names include the stable paragraph anchors above; the typed inventory
is additionally checked by [embedding.test.js](../test/embedding.test.js).

## Consent and data scope

```ts
export interface ProcessingScope {
  purpose: string; recipients: string[]; upstreamProcessors: string[]; dataCategories: string[];
  itemVersion: string | number;
  plugin?: string; model?: string; endpoint?: string; routing?: object; accountRef?: string; operation?: string;
}
export interface ConsentGrant extends ProcessingScope {
  covered: true; consentRevision: number; expiresAt: number;
  scope?: ProcessingScope; checkedAt?: number; withdrawn?: boolean;
}
export interface ConsentPort {
  coverage(query: { sessionId: string; scope: ProcessingScope; consentRevision: number },
    options?: Pick<OperationOptions, 'signal' | 'deadlineAt' | 'now'>): Promise<ConsentGrant | { covered: false }> | ConsentGrant | { covered: false };
  grant?(query: { sessionId: string; consentRevision: number;
    decision?: { contract?: string; items?: string[]; revision?: number };
    scopes?: ProcessingScope[] }): Promise<boolean | void> | boolean | void;
  withdraw?(query: { sessionId: string }): Promise<void> | void;
}
```

The host supplies authoritative `coverage`, not a browser assertion. Derive each
operation's query with `processingScope(binding, operation)`. Cover the purpose,
recipient chain, data categories, item version and current consent revision.
For a plugin scope, return the exact queried `scope`, a fresh `checkedAt` and a
future `expiresAt`. Withdrawn/expired/mismatched grants deny dispatch. The runtime
checks coverage at selection and again when consuming the claim. Accepted uploads
also require `file-text` coverage. A plugin's technical qualification claim or
vendor nationality cannot replace account-specific legal evidence.

The HTTP host may additionally expose `describe(sessionId)` with public item
copy, contract and selected IDs, and accept a `decision` in `grant` with
`{ contract, items }`. These are host extensions used by the reference consent
page and external proof; they are **not** members of the minimal typed
`ConsentPort` above. The fixture validates the selected item and exact model,
endpoint, routing, account and operation; it cannot grant another provider's
item. Its in-memory ledger intentionally loses grants on restart. Production
hosts persist and audit their own decisions.

## Routing and health

**OpenAI Images compatibility note (AIT-300):** direct mode (`gpt-image-2`)
now admits only `https://api.openai.com/v1` outside loopback; other direct
endpoints, including custom proxy hosts, are rejected at construction before
any invocation. Hosts using those endpoints must switch to OpenRouter mode
(`openai/gpt-image-2`) at `https://openrouter.ai/api/v1` or a loopback fixture.
Both production base URLs permit one trailing slash. Both modes also admit
HTTP or HTTPS fixtures on `localhost`, `127.0.0.1` or `[::1]`, with any port
and base path. All endpoints reject queries, fragments, usernames and passwords;
an optional `baseUrl` must match the binding's parsed URL.

Private text bindings use `createBinding` and the `PrivateBinding` shape:
plugin/model/effort, endpoint/routing, account/secret references, call/token
ceilings, rates and legal evidence. The adapter exposes `binding` and optionally
`bind(binding)` to return an instance for the effective route. No credential
value is public. Evidence must match the account, secret reference, model,
endpoint and route, be currently qualified, and satisfy the preset policy.

`legal.countries` means the recipients' seat countries (ISO alpha-2), filtered by
the host's `policy.countries`. Optional `legal.processingCountries` means the
contractually guaranteed processing locations (ISO alpha-2, a non-empty array
when present). The `eu` preset requires both EU-only recipient seats in
`legal.countries` and EU-only guaranteed processing in `legal.processingCountries`;
the no-training rule still applies. A non-EU seat returns `recipient seat outside eu`;
missing processing countries return `processing countries missing`. Explicit
`processingCountries: undefined` is absent under every preset. Malformed processing
countries return `processing residency unverified` for any preset, and non-EU
processing returns `processing residency denied` for `eu`. These stable reasons
appear in DE/EN in the settings catalog and as codes in the refusal response.
START hosts on `best` need no change; non-eu presets keep their existing
recipient-seat country filters and do not require the new field.

Configure `createPluginRuntime({ storage, reasoning, registry, presets, consent })`
and pass it to `createHandlers`. Each preset allowlists `plugins`, permits its
endpoints in `policy`, and supplies `choices.models[].bindings.reaction` and
`.understanding`, plus the default option. A choice's single `binding` can serve
both lanes. Voice/visual choices carry their own validated bindings. Unavailable
choices remain unavailable; do not silently switch processors. See the
[external host](../test/fixtures/external-plugin-host.js) for the complete
configuration, including a separate consent item and fake account evidence.

`health({ signal, deadlineAt })` returns `Health`. Report real unavailability;
health does not authorize spend or consent. The runtime bounds health and denies
an unhealthy plugin before dispatch. Capability, effort, binding, consent,
ownership, pause, revisions and budget gates still apply. `device` is a
browser-only text route, not automatic server fallback.

## Adding a model

1. **Text:** create an independently importable package with declared public
   dependencies, a manifest and a factory. Implement `Reasoning.stream`,
   `structured`, `health`, lifetime/claim/report handling and schema validation.
   Follow [reply wire output](#contract-reply-policy): stream schema JSON under a
   purpose policy; the no-policy host also accepts plain text. Test both paths
   and [separate admissions for retries](#contract-reply-retry).
   Use public exports only. Give replies and analysis explicit host bindings;
   select the package solely through registry and preset configuration.
2. **Voice:** choose STT/TTS components or a live agent. Declare audio formats,
   ownership, transcript semantics, command support, server/browser entrypoints
   and billing. Implement closure, cancellation, liveness and duration/component
   receipts. Delegated reasoning needs its own admitted claim per call/reconnect.
3. **Image/HTML:** implement `ui-generation` operations and declare the formats.
   Configure the matching visual kind/binding. Preserve artifact limits, origin,
   prompt digest, generator provenance and HTML sandbox policy. Keep image and
   HTML cost units/ceilings explicit.
4. **Consent:** supply the plugin's own versioned item and show purpose, recipients
   and data categories. Configure actual account/route qualification and endpoint
   policy. Map item grants to exact processing scopes; test denial, expiry,
   withdrawal and route/model mismatch, including file text when supported.
5. **Costs:** provide safe-integer usage and actual micro-dollar receipts, including
   billable thinking, cancellation and failed output. Test price precedence and
   missing receipts retaining the conservative maximum. Never publish thinking
   as an assistant final. Separate voice visitor charges from upstream cost.
6. **Tests:** run manifest/contract, health, lifetime, authority, output and cost
   tests with fake transports. Add one real-browser host smoke proving replies,
   analysis/overview, the plugin's consent item and settled costs. Measure every
   new browser file on the authorized runner and record its weight in
   `scripts/browser-shards.js`. Provider qualification remains separate from fake
   conformance; no live credential is needed for this proof.

## Typed symbol index

The following inventory is checked exactly against all direct declarations and
named re-exports in `plugin-contract.d.ts`. Envelope/consent/reasoning shapes above
are also compared by TypeScript syntax tree; changes require an intentional
contract documentation update. Re-exported artifact/extractor definitions live
in their linked source modules.

<!-- contract-symbols:start -->
- `AudioFormat`
- `AudioFormatPort`
- `AudioQueue`
- `ComponentInvocation`
- `ComponentOperationOptions`
- `ComponentTerminal`
- `ComponentUsage`
- `ConsentGrant`
- `ConsentPort`
- `Exporter`
- `Extraction`
- `ExtractionLimits`
- `ExtractionMetadata`
- `ExtractionOptions`
- `ExtractionSegment`
- `Extractor`
- `HTMLGeneration`
- `HTMLProblem`
- `Health`
- `LaneBindings`
- `LiveVoice`
- `LiveVoiceDeclaration`
- `OperationOptions`
- `OperatorIdentityProvider`
- `OperatorSessionPort`
- `PrivateBinding`
- `ProcessingScope`
- `Reasoning`
- `STT`
- `STTComponent`
- `STTComponentCapabilities`
- `STTRequest`
- `STTStreamRequest`
- `STTTranscript`
- `TTS`
- `TTSAlignedChunk`
- `TTSComponent`
- `TTSComponentCapabilities`
- `TTSRequest`
- `Terminal`
- `UIArtifact`
- `UIFeedback`
- `UIGeneration`
- `UIHTMLArtifact`
- `UIHTMLSpec`
- `UIImageMediaType`
- `UIReference`
- `UISpec`
- `Usage`
- `VoiceBrowserMedia`
- `VoiceCallbackContext`
- `VoiceCallbackRoute`
- `VoiceCapability`
- `VoiceCommandOptions`
- `VoiceCompositionCapabilities`
- `VoiceEvent`
- `VoiceMediaGrant`
- `VoiceMediaOptions`
- `VoiceOperationIdentity`
- `VoicePorts`
- `VoicePresentation`
- `VoiceReconciliationEvidence`
- `VoiceReplyEnvelope`
- `VoiceReplyEvent`
- `VoiceReplyExecutor`
- `VoiceServerAdapter`
- `VoiceServerCallbacks`
- `VoiceServerSegment`
- `VoiceSession`
- `VoiceStartOptions`
- `VoiceTerminal`
- `VoiceTextAudio`
- `VoiceTextOptions`
- `VoiceTextQuote`
- `VoiceUsage`
<!-- contract-symbols:end -->
