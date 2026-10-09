# Aithema

Aithema is the *Need* of INSPR: conversation and files become requirements a person approves before any work begins.

This repository is now the reset line of the embeddable requirements conversation:
core, server, UI web components and provider plugins, under **AGPL-3.0-only**.

## Status

The public repository has existed since **2026-09-22**. Releases **v0.1.0–v0.10.1**
belong to the previous generation, preserved at the signed tag
`archive/gen2-2026-10-01` (`b73faac`). Main carries only the reset generation;
later slices port what they need with `git show archive/gen2-2026-10-01:<path>`.

The reset line is **unreleased work in progress**. The first text vertical supplies
conversation, live understanding, durable events, restart/resume and session ZIP
export. Requirement approval, files/uploads, voice, concepts and host integration
remain later work. START cutover and live provider/OIDC proof are also later work;
handover to PAIMOS is planned. Sessions now have visitor ownership, authoritative
consent checks, engine-wide pause, withdrawal/erasure and an exclusive writer.
The demo is for localhost.

All packages are private with placeholder version `0.0.0`; versioning is decided
at release preparation (AIT-32). The old release workflow has been removed;
a lean release pipeline returns in **AIT-105**.

## Tests and demo

Use **Node.js 24 or newer**, npm and Python 3. From the repository root:

```sh
npm ci
npm test
python3 -I -m unittest discover -s tests -p test_dco.py
npm run demo
```

Open http://127.0.0.1:3000 and stop the server with Ctrl+C. PR CI and nightly run
`npm ci` and `npm test` once, with ten-minute limits. DCO checks run separately.
Tests use deterministic mocks and local HTTP fixtures; they make no live provider calls.

The demo visibly labels **Mock reasoning** by default. Its deterministic responses
recognize statements such as `operations: hosted; data: public; systems: API;
reach: international`; they do not prove model quality. Browser local storage
keeps the session id; an HttpOnly, SameSite=Strict cookie binds it to the visitor.
Allow mock processing on the consent screen before reasoning starts. The demo
ledger expires grants after twelve months and loses them on server restart;
grant again to continue processing. Reload or restart the server to resume from
`.data/session.sqlite`; New conversation creates a separate session without
erasing the previous one. `PORT` and `AITHEMA_DB` override the port and database.
The demo accepts only loopback Host headers and JSON POSTs.

The demo stays on the mock even when provider environment variables exist.
`AITHEMA_PROVIDER=openrouter|mistral` explicitly selects a provider; `OPENROUTER_MODEL`
and `MISTRAL_MODEL` select its model. These demo bindings remain **unverified** and
cannot dispatch until a host supplies private qualification and current consent.
Keys resolve from `OPENROUTER_API_KEY` or `MISTRAL_API_KEY` only at runtime; they
never enter manifests, snapshots, UI or logs. Tests never use these environment keys.
The demo mock consent does not cover live providers.

## Package layout

The private `aithema` root is an ESM npm workspace with one `package-lock.json`.

| Path / package | Contents |
| --- | --- |
| `packages/core` — `@inspr/aithema-core` | Session/event and understanding reducers, readiness, prompts, cancellable engine lanes |
| `packages/server` — `@inspr/aithema-server` | Fetch handlers, SSE, SQLite storage, session export, mock server bin |
| `packages/ui` — `@inspr/aithema-ui` | Framework-neutral `<aithema-session>` web component and English host copy |
| `plugins/mistral` — `@inspr/aithema-plugin-mistral` | Mistral streaming and JSON Schema reasoning |
| `plugins/device` — `@inspr/aithema-plugin-device` | Browser-only literal loopback text connector |
| `plugins/openrouter` — `@inspr/aithema-plugin-openrouter` | Streaming reasoning and strict JSON Schema output |
| `plugins/elevenlabs` — `@inspr/aithema-plugin-elevenlabs` | Live voice server/browser halves, custom-LLM facade and fake-only conformance |
| `plugins/openai-images` — `@inspr/aithema-plugin-openai-images` | Server-side GPT Image 2 generation/editing, byte artifacts and provenance |
| `demo/` | Labelled localhost host and its tests |
| `test/` | Shared JavaScript test helpers; package tests live beside each package |
| `tests/`, `scripts/check-dco.py` | DCO history tests and contribution checker |

The server exports `SQLiteStorage`, `createHandlers` and `exportSession`; its
`/http` export supplies `listen` and `httpAdapter`. Call handlers' `resume()` on
startup and `close()` before closing storage. A standalone mock server runs with
`node packages/server/bin/server.js`; set `AITHEMA_DB` for persistence. Its mock
ledger also requires an explicit consent grant and loses grants on restart.

Hosts configure the web component with `{copy, baseUrl, session, sessionToken}`
(the token is optional) and receive
`aithema-event` notifications. Serve its native ES modules with their relative
core imports, as the demo does. Copy and CSS tokens belong to the host.

| Request | Result |
| --- | --- |
| `POST /api/sessions` | New session snapshot; accepts `processingPreset: best|eu|device|custom` |
| `GET /api/sessions/:id` | Durable snapshot and current operational flags |
| `POST /api/sessions/:id/turns` | Durable turn; identical client id and request bytes replay the receipt, differing bytes conflict |
| `GET /api/sessions/:id/events` | SSE; resume using `Last-Event-ID` or `?after=<seq>` |
| `POST /api/sessions/:id/retry` | Retry unfinished reasoning for the current revision |
| `GET /api/sessions/:id/export` | Transcript JSON/Markdown and understanding JSON in a ZIP |
| `POST /api/sessions/:id/pause` | `{paused: true/false}`; acknowledged durable state and event |
| `POST /api/sessions/:id/withdraw` | `{turnId}`; erase a person statement and invalidate dependent understanding/replies atomically |
| `POST /api/sessions/:id/consent` | `{granted: true/false}`; grants delegate to the host ledger; withdrawal cancels lanes |
| `POST /api/sessions/:id/erase` | Erase all content, retain metadata and a session tombstone; provider deletion remains `not-confirmed` |

API clients retain the `x-aithema-session-token` response header from creation
and send it on every session request, including SSE and export. A host may supply
`ownership.token(request)` and `ownership.created(response, token, request)` to
bind tokens through cookies, as the demo does. Missing, wrong and erased ownership
all return 404. Tokens and their stored hashes are excluded from snapshots/export.

With the default header ownership, pass the creation response header as
`sessionToken` to `configure()`. The component sends it on every request, including
snapshot recovery, feature refresh, SSE, control POSTs and fetched ZIP downloads.
Host POSTs can use `postJson(url, body, {sessionToken})`. Keep the token out of
URLs, markup and stored session content. For cookie ownership, omit `sessionToken`
and serve the component and API on the same origin; the browser sends the host's
HttpOnly cookie. Set `Secure` for HTTPS requests, as the demo ownership hook does;
localhost HTTP remains usable. Hosts behind TLS termination must supply an
ownership hook that reflects their trusted transport configuration.
Snapshots make at most three attempts to obtain matching features and state;
continuous updates return 409 so the client can retry.

Hosts supply one `consent.coverage({sessionId, scope, consentRevision}, {signal, deadlineAt})` port
for admission and withdrawal; a supplied runtime and handlers share that same port. A covering
grant has `covered: true`, the matching purpose and item version, arrays covering
every recipient, upstream processor and data category, the same consent revision,
and a future `expiresAt` timestamp. The runtime derives the scope from each
private binding, including the exact plugin, model, endpoint, routing, account
reference and operation. External grants also echo that exact `scope` with a
current `checkedAt` timestamp; only the local mock has a built-in scope.
Missing/unavailable coverage fails closed at admission and again at claim consumption. Hosts notify
external revocation through `await handlers.withdrawConsent(id)` to persist the new
revision, abort running work immediately and await lane settlement before acknowledgement. `createMemoryConsentLedger()` is
the reference mock host ledger, not a durable legal record. Core-only hosts supply
an authoritative `admit` callback to `SessionLanes`; the legacy `beforeDispatch`
callback remains available for nonbillable bindings and defaults to refusal.

Pause permits cached reads and joins to an existing pass; fresh reaction and
understanding work waits for acknowledged resume. Input/channel controls are
independent. Withdrawal cancels stale work, clears derived content before ack,
and rebuilds from remaining person turns. Event rows and receipts contain only
metadata and SHA-256 byte fingerprints; erasable content lives separately.
Missing/erased records hydrate as tombstones, including on receipt replay,
restart and export. SQLite secure deletion and WAL checkpointing run before
erasure acknowledgement. `storage.expire(id, turnId)` uses the same invalidation;
hosts await `handlers.expire(cutoffTimestamp)` to cancel and rebuild as well.
The demo applies a twelve-month turn retention cutoff each minute.

A persistent `SQLiteStorage` holds an OS-backed exclusive lock on the canonical
database's companion `.writer.sqlite` file until close or process death. A second
writer refuses startup. Legacy unowned sessions migrate to the erasable layout
but remain inaccessible to visitors; create a new owned session. No ownership
takeover is provided.

## Plugins, bindings and admission

Kinds are `reasoning` (`stream`, `structured`), `stt` (`transcribe`, optional
`stream`), `tts` (`speak`), `live-voice` (`start` → session), `ui-generation`
(`generate`, `edit`), `extractor` (`extract`) and `exporter` (`export`). Reasoning
the isolated ElevenLabs live-voice adapter and standalone UI generation are
implemented here. Every operation takes `{signal, deadlineAt}`;
[plugin-contract.d.ts](packages/core/src/plugin-contract.d.ts) documents the later
ports, including independent voice input/output, acknowledged pause/resume,
turn ids, transcript policy and delegated/native reasoning. The voice adapter has
no routes or UI integration yet; [its README](plugins/elevenlabs/README.md)
defines the Part B integration ports after AIT-97.

A static public **manifest** contains id, version, API range, kinds, placement,
entrypoints, a non-secret config schema and technical model capabilities/public
vendor facts. `MANIFEST_SCHEMA` and `validateManifest` are dependency-free.
Capabilities, German quality, locations, rates and evidence stay explicitly
unverified when they have not been qualified. Vendor nationality proves no
processing residency. Under D4, account references, legal profiles, consent
purposes, training/retention terms and account evidence belong exclusively in
private host configuration.

A private **binding** selects plugin, exact model, effort, endpoint/routing,
account and secret references, token limit, per-token integer micro-unit rates
and an attempt ceiling. Reaction and understanding have separate bindings.
`createBinding` validates and freezes them; neither bindings nor keys belong in
session snapshots. Secret resolvers read their named environment reference at
runtime. OpenRouter pins routing with `require_parameters` and
`allow_fallbacks: false`; Mistral sends chat completions and JSON Schema directly.
Their health operation checks configured credentials locally; it is not a live
provider availability probe. Wire formats follow the official
[OpenRouter streaming documentation](https://openrouter.ai/docs/api_reference/streaming)
and [Mistral chat API](https://docs.mistral.ai/api/endpoint/chat).

The host creates a `PluginRegistry`, registers reasoning instances, then passes
`createPluginRuntime({storage, registry, presets, consent, budget})` into
`createHandlers({storage, pluginRuntime})`. `presets` has `best`, `eu` and
`custom` entries shaped as `{plugins: [id], bindings: {reaction, understanding},
policy: {endpoints: [exactUrl], countries?, noTraining?}}`. The host's private
binding `legal` profile carries `approved`, countries, training, retention,
purpose, recipient, processors, data categories, consent item version and
qualified account evidence with `verifiedAt`/`expiresAt` epoch milliseconds.
Evidence must match the effective account, secret reference, model, endpoint
and routing; no family-wide qualification or silent fallback exists.

Admission runs on the server before **every** dispatch: preset membership,
placement/operation support, pause, evidence identity and expiry, residency,
endpoint policy, current consent, health and budget. EU requires all processing
countries within the EU and no training. The unified consent port above checks
purpose, recipients, upstream processors, data categories, item version, revision,
expiry and exact binding coverage. `await attempt.consume()` queries it again and
rechecks durable ownership, revision, tombstone and pause before burning the claim.
The deterministic non-billable mock has no external legal qualification; a host
consent ledger still governs its local processing. The server and demo fail closed
without a current mock grant. A standalone canonical mock runtime may omit external
consent, as it has no external processing scope.

Snapshots expose `featureMatrix[preset][feature] = {available, reason}` for
text, analysis, voice, transcription and images. Each unavailable feature
carries its reason. Best permits host-qualified international bindings; EU
restricts residency; Custom uses only the host's explicit choices. Features
whose later plugin slice is absent stay unavailable. The web component emits
`aithema-preset` with `{processingPreset}`; the demo confirms the choice by
creating a new session, preserving the previous conversation. It stays on the
mock by default. The fixed preset panel and deferred pointer updates keep
controls stable.

Device is an explicit browser carve-out: text connects directly to an
OpenAI-compatible server at literal `localhost` or `127.0.0.1`, with a models
handshake, cancellation/deadlines, response limits, no redirects, credentials
or server proxy. Set the loopback endpoint in the demo before choosing On my
device. The UI keeps device turns in this tab; reload discards them. The server
lanes refuse device work, and analysis, voice, transcription and images report
“unavailable on device”. Local export/persistence is not implemented in this
slice. Hosts pass `deviceReasoning` to `configure` for that browser half.

Every billable call needs a new budget-admitted attempt and a single-use claim.
A conservative UTF-8 bound on the prompt, schema, provider options and framing,
plus the selected output limit, must fit the binding ceiling before dispatch.
Both server lanes reserve and claim in `SQLiteBudgetLedger` in the session's
SQLite database; no internal provider retry exists. Each invocation reports
exactly one `completed {usage}`, `cancelled {usage}` or `uncertain`. Known
usage settles with the binding's rates, including actual over-maximum cost with
an overrun flag; uncertain dispatched usage charges the entire claim maximum.
Undispatched claims settle cancelled at zero cost. Breaking a stream without
final usage is uncertain, even if the browser locally cancelled. A retry is a
new admission. Withdrawal and erasure abort the invocation and settle it before
acknowledgement. Cancellation retains known usage; an unresponsive dispatched
plugin without a terminal report settles uncertain, and its late results are ignored.
At startup, `handlers.resume()` recovers unfinished dispatched
claims at their maxima and releases undispatched reservations. It must run
before fresh work under the host's
exclusive-writer lifecycle. The slim ledger ports Gen-2
`runtime/budget/{gate,sqlite}.js`; residency/evidence admission ports
`runtime/settings/{resolver,capabilities}.js`.

To add a plugin, export a static valid manifest, implement the declared kind
and cancellable health operation, bind private operator selections, and run
`reasoningConformance(plugin, fixtureRequest, { stallRequest, requestCount })`
with local fixtures. Billable adapters must supply a stalled request and a
synchronous outbound request counter. Reasoning
must await consumption of the provided claim before dispatch and report terminal usage in
`finally`, including iterator return, cancellation and deadline. The reusable
kit checks manifest, health, error codes, claim consumption before dispatch,
refused consumes without requests, schema output and terminal counts, with
preflight and active stream/structured cancellation and deadlines. CI runs it
for OpenRouter, Mistral and mock and verifies that deliberately broken and
preflight-only fixtures fail. The
browser device half advertises text only and is not a full reasoning-kind
server implementation. No live provider qualification is claimed.

## UI generation and concept intent (AIT-103 part A)

The core exports `assertUIGeneration`, `isUIArtifact` and
`uiGenerationConformance`. The kind exposes
`generate(spec, feedback, options)` and `edit(artifact, feedback, options)`.
`spec` contains a host-built `prompt` and optional `size`, `quality`, `format`;
`feedback` is a string of untrusted visitor design content. The operation
options are the same `{signal, deadlineAt, attempt, report}` authority envelope
as reasoning. An artifact contains `Uint8Array bytes`, truthful `mediaType`,
actual `width`/`height`, a SHA-256 `promptDigest` and `provenance` metadata.
It carries no provider URL, secret, binding or raw prompt. Types live in
[`ui-generation.d.ts`](packages/core/src/ui-generation.d.ts), re-exported from
the shared plugin contract.

`createOpenAIImages({binding, resolveSecret, fetchImpl, baseUrl})` comes from
`@inspr/aithema-plugin-openai-images`. It requires an explicit private binding
for `openai-images` / `gpt-image-2` / effort `none`, with the endpoint set to
the API base URL (normally `https://api.openai.com/v1`). An optional `baseUrl`
must match that binding. HTTP is restricted to loopback fixtures. The server
resolves `binding.secretRef` at runtime (the default resolver reads the named
environment variable); the host owns account qualification and consent.
Local health checks configuration without contacting a provider.

The adapter posts JSON to `/images/generations` and private multipart image
bytes to `/images/edits`, following the official
[generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
and [edit reference](https://developers.openai.com/api/reference/python/resources/images/methods/edit).
Defaults follow START: one image, `1536x1024`, high quality and WebP output;
PNG fallback is identified from the returned bytes. PNG/WebP dimensions come
from the image headers. The response is bounded at 18 MiB and each image,
including embedded metadata, at 12 MiB. A URL response is downloaded inside
the server only when its exact origin appears in the private
`binding.routing.imageOrigins` allowlist; downloads carry no authorization or
cookies and reject redirects. Base64 is decoded locally.

Every call consumes its claim before dispatch and persists one terminal report.
Images API `usage.input_tokens` / `output_tokens` map to the shared terminal
token totals. Unknown dispatched usage, including local cancellation, reports
`uncertain`; known usage is retained on output failure. Preflight cancellation
and local failures settle at zero; authority refusal uses the authority's
zero-cost terminal without dispatch. There are no internal retries.
The public manifest contains technical capabilities and public model references
only (D4), with location, quality qualification and rates explicitly unverified.
The shared two-rate cost schema cannot express separate text and image input
rates, so prices remain `null`. START's reservation is a product ceiling, not
a vendor price. Part B must supply researched conservative private rates and
image input/output bounds before admission; chat UTF-8 token bounds do not
bound image tokens. No live provider call or qualification was performed.

The artifact embeds XMP using IPTC Digital Source Type
`trainedAlgorithmicMedia` for generation and
`compositeWithTrainedAlgorithmicMedia` for edits. Its response metadata includes
a SHA-256 Content-Digest of the final marked bytes, provider/model and generation
time. It makes no C2PA signature or local watermark claim. Part B must preserve
the metadata in persistence and provide owner-authenticated headers/sidecars.

`createConceptIntent`, `reduceConceptIntent`, `planConceptIntent` and
`conceptResultDisposition` implement the pure spending policy. The host passes
timestamps and may override `{thresholds: [25,40,72], idleMs: 120000,
refreshTurns: 2, historyMax: 1000}`. Readiness only arms milestones; a durable
`intent-recorded` event bound to a substantive visitor turn is required.
Opening a viewer and ending a conversation are inert. Pause blocks fresh work
for all triggers. Same-milestone progress waits for two new answers unless a
new reference or recorded visual feedback exists; idle can refresh after one
answer and 120 seconds of quiet since input or the last render. Hidden/busy
eligibility and pause/resume reset the quiet clock. Automatic failed attempts
also consume the revision's deduplication slot.

The reducer records a frozen job before dispatch. A normal input advance keeps
the result as history at its original revision. Removal (explicit or detected
in a replacement input) and consent changes invalidate it, even if a removed
source or consent is later restored. Source removal drops dependent history
references; consent changes clear history references. The host erases the bytes.
This port tightens START's final-on-pause exception to the engine-wide pause
contract. Explicit regeneration/retry must record a new intent/input revision;
repeated delivery of the same revision cannot spend again.

Part B wiring points, still pending:

| Surface | Required integration |
| --- | --- |
| `packages/core/src/lanes.js`, `session.js` | Add a concept lane and durable concept metadata. Feed `input-recorded {revision, turnIds, referenceIds}`, `intent-recorded {id, sourceTurnId}`, readiness/activity/pause/eligibility/consent events into the reducer. IDs identify immutable source records, including content revision. Exclude assistant turns and opening vocalizations. Include feedback/intent identity and consent revision in the concept input fingerprint. `request {id, trigger}` freezes a job; persist it before calling generate/edit. On restart mark interrupted jobs failed, preserving attempted revisions. |
| `packages/server/src/plugin-runtime.js`, `budget.js` | Map the concept lane to the existing `images` feature and `presets[preset].bindings.images`; admit both generate and edit scopes. Add `concept` to budget lanes, reserve image-specific ceilings, consume current coverage before dispatch, settle through the invocation contract and recover claims. The current admission path selects text/analysis and chat bounds, so direct image admission is not wired yet. Keep device images unavailable. |
| `packages/server/src/storage.js` and export | Persist artifact bytes as erasable content/BLOBs plus media type, dimensions, prompt digest and provenance; keep only IDs, hashes and source dependencies in durable events/snapshots/receipts. Persist frozen prompts/feedback in erasable records. Before publication re-read ownership/tombstone, consent coverage/revision and source records; call `conceptResultDisposition` to allow historical results or discard invalid ones. Erase dependent bytes/feedback on source removal, consent withdrawal, session erasure and expiry; tombstone-aware replay/export must never resurrect them. |
| `packages/server/src/handlers.js` | Owner-authenticated `POST /api/sessions/:id/concepts` (record explicit intent/feedback and enqueue), `GET /api/sessions/:id/concepts/:artifactId` (stored bytes), `GET .../:artifactId/provenance` (sidecar), and `POST .../:artifactId/feedback` (`up`, `down`, `clear`). Reads never enqueue paid work. Use byte-bound idempotency, sanitized errors, no-store responses and provenance/digest headers. Publish durable pending/completed/failed events only after persistence; withdrawal aborts/settles before ack. |
| `packages/ui/src/session-element.js` and styles/copy | Concept progress/countdown, retained preview/history, owner-authenticated byte loading, one accessible viewer with keyboard/touch controls and a disclosure badge. Estimates reserve completion for a persisted success event. Regenerate/retry records explicit intent with host cost copy. Like/reject chips refer to the exact artifact, persist positive/negative guidance and support clearing it. Viewing, liking, rejecting and clearing do not themselves invoke generation. Render feedback text safely; keep provider URLs/keys out of browser state. |
| `demo/*` and tests | Register a deterministic byte-producing image fixture by default, configure an images binding/consent scope, and test restart, history, erasure, ownership, pause, deduplication and feedback end-to-end. Live credentials never enable a provider implicitly. |

The reusable conformance call is
`uiGenerationConformance(plugin, {spec, feedback, artifact},
{stallSpec, stallFeedback, requestCount})`. Local fixtures must stall both
operations and count outbound calls synchronously. The kit checks byte artifacts,
provenance, manifest/health, terminal reports, consumption/refusal and preflight
plus active cancellation/deadlines. CI tests the adapter and broken fixtures.

## Ported from START

Source reference: `start-agm-com` main `1d4078c`, the read-only port oracle.
INSPR holds the rights to the ported generic code under approved decision D3
(revised, 2026-10-09). Augmentoring identity, branding, persona, funnel and offer
policy were removed. The table records the port in the current package layout.

| START source | New source | Adaptation |
| --- | --- | --- |
| `src/lib/qualification.ts` | `packages/core/src/understanding.js` | user-only evidence, normalization, build cap, selected actor preservation; host preset and English slot ids |
| `src/pages/api/analyze.ts` | `packages/core/src/{understanding,lanes}.js` | authoritative final; non-destructive draft with a distinct binding; cache, single flight, revision checks and persisted verification; Fetch/storage injection |
| `src/lib/guided-pass.ts` | `packages/core/src/readiness.js` | bounded question history, rewording matches, open/settled grouping |
| `src/lib/readiness-view.ts` | `packages/core/src/readiness.js` | threshold scale, five-row window, stable newly-cleared ordering |
| `src/lib/analysis-incremental.ts` | `packages/core/src/lanes.js`, `packages/ui/src/session-element.js` | latest-input guard, stale result rejection, current-input checking |
| `src/lib/analysis-recovery.ts`, `analysis-retry.ts` | `packages/server/src/handlers.js`, `packages/ui/src/session-element.js` | retain prior understanding, sanitized failure, manual retry and reconnect |
| `src/lib/prompts.ts` (generic policy only) | `packages/core/src/prompts.js` | evidence-only reasoning, untrusted data, one-question pacing, honest draft/stale state |
| `src/pages/index.astro`, `src/scripts/v2.ts` (conversation/aside) | `packages/ui/src/{session-element,styles}.js` | transcript bubbles, composer shortcuts, readiness/aside, expansion and responsive layout; host copy/tokens |
| `tests/{analyze-route,guided-pass,analysis-incremental,critical-surfaces}.test.ts` | `packages/core/test/`, `packages/ui/test/` | selected reducer/readiness/lane/UI behaviour cases converted to `node:test` |
| `src/lib/{generated-ui,generated-ui-idle,generated-ui-policy}.ts`, `src/pages/api/v2/generated-ui/index.ts` | `packages/core/src/concept-intent.js` | pure host policy; recorded intent, arming, cadence, dedupe and source/consent invalidation; historical slow results |
| `src/lib/providers/openai-image.ts`, `src/lib/provenance.ts` | `plugins/openai-images/src/` | server Images generate/edit with lifetime/claim contract, bounded private bytes, IPTC XMP and digest metadata; no branding or legal/account facts |
| `tests/generated-ui.test.ts` | `packages/core/test/concept-intent.test.js`, `plugins/openai-images/test/openai-images.test.js` | selected spending, slow-render, removal/withdrawal and private image transport cases with fakes |

## License and contributions

Aithema's core, server, UI and plugins are **AGPL-3.0-only**; see [LICENSE](LICENSE).
Third-party dependencies retain their own licences, recorded in [NOTICES.json](NOTICES.json).
Commercial-host licensing must follow the applicable licence or a separately
formalised grant from INSPR; this README grants no exception.

Every contribution commit requires a matching `Signed-off-by` trailer under the
[Developer Certificate of Origin 1.1](DCO), created with `git commit --signoff`.
External contributions also require an agreement with INSPR permitting relicensing;
DCO sign-off alone is insufficient. Review, merge and release remain maintainer-controlled.
