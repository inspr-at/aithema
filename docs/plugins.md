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
operations and missing health. Registration freezes a copy of the manifest.

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
export type Terminal = { attemptId: string; servedModel?: string; chargedMicro?: number } & ({ outcome: 'completed' | 'cancelled'; usage: Usage } | { outcome: 'uncertain' });
export interface OperationOptions {
  signal: AbortSignal;
  deadlineAt: number;
  attempt: { attemptId: string; claimId: string; consume(): Promise<void> | void };
  report(terminal: Terminal): Promise<void> | void;
}
export interface Health { available: boolean; reason?: string }
export interface Reasoning {
  stream(request: { system: string; messages: { role: string; content: string }[] }, options: OperationOptions): AsyncIterable<string>;
  structured(request: { system: string; messages: { role: string; content: string }[]; schema: object }, options: OperationOptions): Promise<unknown>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
```

Honor `signal` and the absolute `deadlineAt` for the entire operation, including
response-body reads. Consume the admitted claim **once, before outbound work**.
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
Yield only answer content; validate structured output against the requested
schema. Keep provider thinking out of reply deltas/finals and saved transcripts.
For providers with authoritative receipts, use
`beginInvocation(options, { authoritativeCost: true })`, record usage and cost,
and finish in `finally`. Missing cost then produces an uncertain terminal even
if tokens were observed. The external fixture tests this behavior through the
real budget ledger. Provider-specific reconciliation is an optional extension;
it must preserve conservative holds until trustworthy evidence arrives.

Voice uses `VoiceTerminal` with closure confirmation, duration, upstream/visitor
costs and provider identity. Components report `ComponentTerminal` and
`ComponentUsage` units. Images and HTML must return their validated artifacts,
origin and generator provenance, and report their actual costs through the
admitted operation. Do not invent watermark/signature assurances.

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
    options?: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<ConsentGrant | { covered: false }> | ConsentGrant | { covered: false };
  grant?(query: { sessionId: string; consentRevision: number }): Promise<void> | void;
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

Private text bindings use `createBinding` and the `PrivateBinding` shape:
plugin/model/effort, endpoint/routing, account/secret references, call/token
ceilings, rates and legal evidence. The adapter exposes `binding` and optionally
`bind(binding)` to return an instance for the effective route. No credential
value is public. Evidence must match the account, secret reference, model,
endpoint and route, be currently qualified, and satisfy the preset policy.

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
- `TTS`
- `TTSComponent`
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
