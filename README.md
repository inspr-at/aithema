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
export. The first voice integration supplies a durable ElevenLabs call lifecycle, audio rail
and local fake agent. Concept generation now supplies a spending-intent lane, durable byte history and
a viewer with feedback. Requirement approval, files/uploads and host integration
remain later work. START cutover and live provider/OIDC proof are also later work;
handover to PAIMOS is planned. Sessions now have visitor ownership, authoritative
consent checks, engine-wide pause, withdrawal/erasure and an exclusive writer.
The demo is for localhost and defaults to labelled deterministic reasoning, voice
and image fakes.

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

Run the browser smoke test separately with an installed Google Chrome or Chromium:

```sh
npm run test:browser
# For a browser outside the standard macOS/Linux locations:
CHROME_PATH=/absolute/path/to/chrome npm run test:browser
```

It uses exactly pinned `puppeteer-core` without downloading a browser, starts the
mock demo on a free port with a temporary database, and always clicks **Allow mock
processing** (`#grant`), waiting for a 200 consent POST response, `#consent-status`
to read "Mock processing allowed." and an enabled composer textarea. It then
clicks **Withdraw consent** (`#revoke`), checks a 200 consent POST response and a
disabled textarea, and grants again, checking the same response, message and
enabled textarea. It also checks keyboard submission, transcript/understanding
updates, reload and a ZIP download. Console errors, page exceptions and failed
same-origin requests fail the test. The separate PR CI `browser` job runs on
Ubuntu with Node 24 and a five-minute limit;
`npm test` does not require a browser. To prove the missing JSON content-type
regression is detected, run `AITHEMA_BROWSER_REGRESSION=1 npm run test:browser`:
this serves a test-only faulty `demo/host.js` session POST and must fail with 415,
without changing the demo files.

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
| `plugins/codex-imagegen` — `@inspr/aithema-plugin-codex-imagegen` | Server-side Codex CLI image generation/editing on the operator account, with private references and process-group cancellation |
| `plugins/extract-{pdf,ooxml,text}` — `@inspr/aithema-plugin-extract-{pdf,ooxml,text}` | Offline bounded PDF, DOCX/XLSX/PPTX and literal text extractors |
| `demo/` | Labelled localhost host and its tests |
| `test/` | Shared JavaScript test helpers; package tests live beside each package |
| `tests/`, `scripts/check-dco.py` | DCO history tests and contribution checker |

The server exports `SQLiteStorage`, `createHandlers` and `exportSession`; its
`/http` export supplies `listen` and `httpAdapter`. Await handlers' `resume()` on
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
| `GET /api/sessions/:id/concepts` | Saved concept metadata, progress, intent and cost ceiling |
| `POST /api/sessions/:id/concepts` | Record `{clientEventId, intent: true, sourceTurnId}` and request a concept once understanding is ready |
| `POST /api/sessions/:id/concepts/eligibility` | Record `{eligible: false}` on page hide/end; never request a render |
| `GET /api/sessions/:id/concepts/:artifactId/image` | Owner-authenticated bytes; `?download=1` returns an attachment |
| `GET /api/sessions/:id/concepts/:artifactId/provenance` | Provenance sidecar |
| `POST /api/sessions/:id/concepts/:artifactId/feedback` | `{clientEventId, vote: up/down/clear, chips: string[]}`; no generation |
| `POST /api/sessions/:id/concepts/:artifactId/regenerate` | A fresh explicit intent and separately admitted refinement |
| `POST /api/sessions/:id/concepts/:artifactId/reject` | Archive with negative feedback; no generation |
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


## Voice host integration

The demo defaults to **Fake voice — local simulated agent, no provider network**.
Allow local mock consent, select Start call, then use the labelled host controls
to simulate speech, a spoken interruption or transport loss. Type in the composer
while the call runs. Pause/Resume waits for the engine acknowledgement; blur
pauses automatically, and focus never resumes. The agent and provider API are
in-process fakes; only session persistence/control uses localhost HTTP.
`AITHEMA_VOICE_MODE=off` disables it. No microphone audio is captured in fake mode.

For a host, register `createVoiceProvider(...)` alongside the selected reasoning
plugin, configure `presets[preset].bindings.voice`, and pass
`voice: {secrets, closeOrphan?}` into `createHandlers`. Create `secrets` with
`createFacadeSecrets()` or supply a server-only vault implementing
`provision(ref)`, `resolve(ref)` and `revoke(ref)`. Await `handlers.resume()` before
accepting traffic. See the [voice plugin README](plugins/elevenlabs/README.md)
for the complete binding and provisioning ports. Agent id, provider-key secret
reference, public HTTPS facade base URL and exact account qualification are
required. The built-in start2 host supplies START's international qualification and separate
durable consent items. It never treats the mock grant as ElevenLabs consent.
`AITHEMA_PUBLIC_ORIGIN` selects the public Host and callback origin; pass the
original Host through the HTTPS reverse proxy. Custom private host modules remain
optional.

Browser hosts import `createVoiceControl` from `@inspr/aithema-ui/voice-control`,
and `createElevenLabsClient` from `@inspr/aithema-plugin-elevenlabs/client`.
Use the control's `persistEvent(event, {providerSessionId})` to feed durable
acknowledgements into `component.receive`, then pass the client as `voiceClient`
to `component.configure`. The demo is a complete reference. Serve client ESM,
the SDK IIFE and worklets; never serve the plugin's server or facade modules.
The localhost demo serves the pinned SDK at `/vendor/elevenlabs/lib.iife.js` and
standalone worklets at `/vendor/elevenlabs/worklets/{raw-audio,audio-concat}.js`.
The rail reads optional `audioLevels()` input/output measurements; the orb's
outer size remains fixed. Blocked SDK audio playback offers a user-gesture retry.
Hosts with an additional Web Audio context can supply `voicePlayback` to resume it.

Voice finals are ordinary durable `turn.final` events. A genuine heard prefix is
an idempotent `turn.corrected`, with the unspoken suffix removed from projection,
replay and export. Understanding uses the same revision guards and withdrawal
path as typed input. During a call the composer persists a durable person turn
before `sendText`; later provider echoes of that text within the call are
de-duplicated. Assistant finals record whether their text was `facade-produced`
or `browser-asserted`; exports mark browser assertions explicitly. These labels
identify text provenance, without confirming playback. Understanding/focus changes call
`updateContext`. Audio barge-in is native; there is no force-interrupt button.
Unsupported commands and presets stay disabled with a reason. Automatic updates
keep the rail, composer and export targets at fixed positions.

Duration holds reserve provider and visitor ceilings separately.
Set the upstream session cap to at least the voice maximum plus the delegated
reaction maximum (`cap ≥ voice max + reaction max`), since the open voice hold
counts toward `used()` while facade reactions and heartbeats check admission.
Allow further headroom for understanding, settled usage and overlapping recovery
holds. Recovery reserves the remaining duration and settles the old call in the
background. Invalidation commits and cancels lanes immediately, revokes callback
auth and sends `voice.state: closing` so the browser ends its SDK session before
provider settlement. `handlers.idle()` and `handlers.close()` await settlements.
`budget.used(sessionId)` tracks upstream spend;
`budget.visitorUsed(sessionId)` tracks voice visitor credits. Terminal usage
retains full `providerSeconds`/`providerMinutes`, `pausedSeconds`, `visitorSeconds`,
provider credits and both micro-unit costs. Confirmed pauses reduce visitor
seconds and cost while upstream usage still accrues. Unknown dispatched closure
charges both reserved maxima. Startup releases undispatched holds, conservatively
settles dispatched holds, revokes callback auth and retains pending orphan
reconciliation under SQLite's exclusive writer. A host's bounded `closeOrphan`
port may return authenticated final usage to correct cost without emitting a
second terminal receipt. Pending records remain durable when that port fails.

## Plugins, bindings and admission

Kinds are `reasoning` (`stream`, `structured`), `stt` (`transcribe`, optional
`stream`), `tts` (`speak`), `live-voice` (`start` → session), `ui-generation`
(`generate`, `edit`), `extractor` (`extract`) and `exporter` (`export`). Reasoning,
the ElevenLabs live-voice integration, standalone UI generation and extractors are
implemented here. Every operation takes `{signal, deadlineAt}`;
[plugin-contract.d.ts](packages/core/src/plugin-contract.d.ts) documents the later
ports, including independent voice input/output, acknowledged pause/resume,
turn ids, transcript policy and delegated/native reasoning. The [ElevenLabs README](plugins/elevenlabs/README.md) documents duration bindings,
Fetch routes, server-only callback provisioning and browser integration.

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

## Document extractors (AIT-100 part A)

`@inspr/aithema-core/extractor` exports `createExtractor`, `assertExtractor`,
`isExtraction`, `sniffDocument`, `EXTRACTOR_LIMITS` and `UPLOAD_LIMITS`. Register
`createPDFExtractor()`, `createOOXMLExtractor()` and `createTextExtractor()` from
their workspace packages in `PluginRegistry`, then pass the host-admitted
entries to `createExtractor({plugins, limits})`. Call
`extract(bytes, {mediaType?, filename?}, {signal, deadlineAt, limits?})` on that
dispatcher or a plugin. Limits at construction and invocation only decrease.
The declared type and filename never select a parser; ZIP central-directory
inspection identifies Office parts, and binary signatures take precedence over
text. CSV and Markdown detection is heuristic; ambiguous textual content stays
plain text. Malformed ZIPs and unsupported binaries cannot fall through to text.

Results have `{status, text, segments, mediaType, truncated, limits}`.
`status: 'accepted'` includes stable local `segment:N` IDs and optional one-based
`page` (PDF page, spreadsheet sheet or presentation slide). `status: 'unreadable'`
has empty text/segments and a typed `reason`: `unsupported`, `empty`, `malformed`,
`encrypted` or `limit`. Scanned PDFs are unreadable without an OCR fallback.
Cancellation/deadlines reject with `PluginError.code` `cancelled`/`deadline`;
the child is SIGKILL'd and reaped before acknowledgement. These local, zero-cost
plugins take no budget claim or billable terminal reporter. Text, XML, Markdown,
CSV and JSON remain literal untrusted source content, including foreign approval
claims from Gen-2 handover JSON; XML entities are never resolved.

All three plugins parse in child processes, with one active parser across kinds.
Queue time counts against the wall-clock deadline. A file is capped at 2 MiB,
60,000 output UTF-16 code units including segment separators, 100 PDF pages or
Office sheets/slides, 10 seconds and a 128 MiB V8 old-space heap. Separately,
the parent samples child RSS every 25 ms and SIGKILLs/reaps it above `maxRssMb`
(default 384 MiB); the result is unreadable with reason `limit`. Linux reads
`VmRSS` in KiB from `/proc/<pid>/status`; macOS uses
`ps -o rss=`. Monitoring failures refuse work with `unavailable`. Sampling is
not an atomic allocation limit: the child can overshoot between observations.
Hosts needing a hard OS limit may additionally use a delegated cgroup or
systemd user service with `MemoryMax=384M` on Linux where supported; neither
requires root when the controller is delegated. No OS limit is required by
the plugin. Crash/OOM exits without a result also report `limit`.

The nested FlateDecode PDF bomb regression measures a fresh small-PDF child's
sampled peak RSS with the watchdog, then sets its cap to that peak rounded up
to MiB plus 48 MiB. A second small PDF must be accepted at that cap, and the
bomb must exceed it, return `unreadable` with reason `limit`, and be SIGKILL'd
and reaped. On macOS arm64, two root-suite runs measured **62.63 and 64.25 MiB
on Node v24.20.0**, and **74.25 and 74.45 MiB on Node v26.10.0**. The production
384 MiB default therefore had at least **309.55 MiB of headroom** over these
small-PDF baselines. Sampled peaks vary with scheduling and runtime; the test
recalibrates on every run rather than assuming a fixed startup RSS.

Office archives are capped at 512 entries, 100:1 declared compression ratio,
16 MiB per part and 48 MiB total
uncompressed data, including skipped parts; inflated sizes and CRCs must match.
Office part targets are de-duplicated before scanning, and self-closing XML
elements contribute empty values without consuming subsequent cells or runs.
Parser children inherit no credentials and cannot write files, spawn children
or workers; transport guards deny HTTP, sockets, DNS, UDP, fetch and WebSocket.
Only trusted plugin modules run in children; this is not an OS sandbox for
arbitrary third-party executable code. Input/output and expansion ceilings also
bound parser buffers. No document bytes are persisted by these plugins.
Async children exit on IPC disconnect. A CPU-bound parser cannot service that
event, so deployments must terminate the whole process group on parent loss
(for example systemd `KillMode=control-group`), rather than only the parent.
PDF dependency permissions follow `import.meta.resolve('unpdf')`, including
its bundled PDF.js 6.1.200; they do not assume a workspace node_modules path.

`extractorConformance(plugin, {bytes, mediaType, expectedText?}, options)` is
re-exported by the core conformance module. Options require local `stallBytes`,
`unreadableBytes`, `workCount`, `activeCount`, `killedCount`, `requestCount` and
`waitForWork`; manifests supporting PDF, XLSX or PPTX must also supply
`pageBytes`. An optional `archiveBombBytes` fixture must return unreadable
`limit`. The kit checks manifest/health, output/segment shape, lying MIME/filename
with every other supported format and text/plain, caps, unreadable
results, preflight and active cancellation/deadlines, child reaping and no
network attempts. `test/extractor-fixtures.js` supplies tiny generated documents
and a trusted CPU-stalling worker that otherwise delegates to the real parsers.
Deadline checks also settle when a child is killed before its `started` message.
`workerURL` on plugin factories is a trusted test seam, never upload metadata.

Part B wiring points, still pending:

| Surface | Required integration |
| --- | --- |
| `packages/server/src/handlers.js`, HTTP adapter | Owner-authenticated `POST /api/sessions/:id/uploads` using the existing `x-aithema-session-token`/ownership port, and `DELETE /api/sessions/:id/uploads/:uploadId`. Bound streamed request bytes before multipart buffering: 8 MiB/request, 4 files/request, 8 documents/session. Apply one shared `deadlineAt = now + 25_000` to a batch, connected to disconnect, withdrawal and erasure signals. Return sanitized accepted/unreadable records; re-read ownership, consent revision, tombstone and available slots after extraction before durable publication. Byte-bound idempotency must reject reuse with different bytes. |
| Preset configuration / plugin registration | `best` and `eu` may explicitly admit these host-local plugins with the same maximum 2 MiB/file, 60,000 characters/file and 100 pages/sheets/slides; `custom` selects them and may lower every ceiling. `device` must leave server upload extraction unavailable until a browser extractor is implemented and admitted. No server plugin claims device placement or provider residency. Hosts enforce allowed sniffed formats, request/session quotas and consent before dispatch. |
| `packages/server/src/storage.js`, core source/lane hydration and export | Persist accepted extracted text/segments as erasable upload sources with a host upload ID, sniffed type, bounded display filename and truncation/limit metadata. Namespace `segment:N` by immutable upload/content revision for citations; never cite unreadable records or import document approval as authority. Treat excerpts as untrusted evidence in reaction/understanding prompts and enforce the 16,000-character provider document context ceiling. Raw document bytes need not be retained. Acknowledge only after persistence and owner/consent revalidation. |
| `packages/ui/src/*` | Upload affordance and accessible chips for accepted, truncated and unreadable files, with honest reason and paste-text guidance; safe filename/text rendering, page/segment citations and an owner-authenticated remove action. Client limits are hints; server limits remain authoritative. |
| Withdrawal, consent withdrawal, erasure and expiry | Abort pending upload work and wait for child reaping; persist source tombstones and invalidate dependent understanding, working-spec citations, concept inputs and cached exports before acknowledgement. Erase extracted text, quotes and any retained bytes; replay/restart/export hydrate tombstones without resurrecting sources. Rebuild from remaining inputs through normal lanes. Retain only allowed IDs, hashes, timestamps and tombstone metadata. |

## UI generation and concepts (AIT-103)

The core exports `assertUIGeneration`, `isUIArtifact` and
`uiGenerationConformance`. The kind exposes
`generate(spec, feedback, options)` and `edit(artifact, spec, feedback, options)`.
Both operations use the host-built `spec.prompt` and optional `size`, `quality`, `format`.
`spec.references` may carry up to nine `{bytes, mediaType, role}` records, with
roles `previous`, `rejected` or `upload`. Each reference contains private
`Uint8Array` bytes of at most 12 MiB, with PNG/WebP/JPEG headers matching its
media type. URLs and extra reference fields are rejected. The host prompt owns
reference order, negative-reference guidance and all product prompt policy;
`feedback` is a string of untrusted visitor design content. The operation
options are the same `{signal, deadlineAt, attempt, report}` authority envelope
as reasoning. An artifact contains `Uint8Array bytes`, truthful `mediaType`,
actual `width`/`height`, a SHA-256 `promptDigest` and `provenance` metadata.
It carries no provider URL, secret, binding or raw prompt. Types live in
[`ui-generation.d.ts`](packages/core/src/ui-generation.d.ts), re-exported from
the shared plugin contract. `isUIArtifact` checks shape and exact metadata keys;
the async conformance kit additionally checks the content against those fields.

`createOpenAIImages({binding, resolveSecret, fetchImpl, baseUrl})` comes from
`@inspr/aithema-plugin-openai-images`. It requires an explicit private binding
for `openai-images` / `gpt-image-2` / effort `none`, with the endpoint set to
the API base URL (normally `https://api.openai.com/v1`). An optional `baseUrl`
must match that binding. HTTP is restricted to loopback fixtures. The server
resolves `binding.secretRef` at runtime (the default resolver reads the named
environment variable); the host owns account qualification and consent.
Local health checks configuration without contacting a provider.

The adapter posts JSON to `/images/generations` without references. With
references it posts private multipart `image[]` bytes to `/images/edits`, as
does `edit`, which prepends the artifact as a previous reference (at most eight
additional references). The request follows the official
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
Known contract limitation (gate Low 6): malformed caller input currently maps
to `invalid-output`, because the shared error codes have no input-error code.
The public manifest contains technical capabilities and public model references
only (D4), with location, quality qualification and rates explicitly unverified.
The shared two-rate cost schema cannot express separate text and image input
rates, so prices remain `null`. START's reservation is a product ceiling, not
a vendor price. The host must supply researched conservative private image rates and
input/output bounds through `createImageBinding` before live admission; chat
UTF-8 token bounds do not bound image tokens. No live provider call or qualification was performed.

The artifact embeds XMP using IPTC Digital Source Type
`trainedAlgorithmicMedia` / `ai-generated` for generation without references and
`compositeWithTrainedAlgorithmicMedia` / `ai-manipulated` for every refinement.
This single rule applies to both `generate` with previous/rejected/upload
references (the edit endpoint) and explicit `edit`. Its response metadata includes
a SHA-256 Content-Digest of the final marked bytes, provider/model and generation
time. It makes no C2PA signature or local watermark claim. Storage preserves
the marked bytes and metadata; image GETs provide `Content-Digest`, truthful
`Content-Type`, `x-aithema-origin` and a provenance sidecar.
Embedding replaces existing PNG/WebP XMP blocks with one current record.

`createConceptIntent`, `reduceConceptIntent`, `planConceptIntent` and
`conceptResultDisposition` implement the pure spending policy. The host passes
timestamps and may override `{thresholds: [25,40,72], idleMs: 120000,
refreshTurns: 2, historyMax: 1000}`. Readiness only arms milestones; a durable
`intent-recorded` event bound to a substantive visitor turn is required.
Opening a viewer never records intent; ending records durable ineligibility. Pause blocks fresh work
for all triggers. Same-milestone progress waits for two new answers unless a
new uploaded reference or recorded visual intent exists. Generated history
used for continuity and regressed readiness cannot earn an early refresh; idle
can refresh after one answer and 120 seconds of quiet since input or the last render
in the pure policy. The server has no idle timer or periodic session scan and never
schedules idle generation: elapsed server time provides no client presence.
Voice close, expiry/erasure and page hide record `eligible: false`; a new person
turn or explicit request restores eligibility. Hidden/busy eligibility and
pause/resume reset the pure policy's quiet clock. Automatic failed attempts
also consume the revision's deduplication slot.

The reducer records a frozen job before dispatch. A normal input advance keeps
the result as history at its original revision. Removing a source/reference
(explicitly or in replacement input) invalidates only jobs that used it; adding
then removing an unrelated source preserves the paid result. Per-source epochs
prevent re-adding a removed dependency from resurrecting its old render.
Source removal drops dependent history references and clears intent only when
its own source turn is removed. `source-removed` requires `{source: "turn" |
"reference", id}`; identical IDs in the two namespaces stay independent. A consent withdrawal clears
all history and invalidates pending results even after consent is restored.
A renewal with unchanged covered processing preserves intent, history and
pending results while recording the newer consent revision. The host reports
coverage for the job's processing scope; any loss/change of that scope must
record uncovered consent before a new grant. The host erases invalidated bytes.
This port tightens START's final-on-pause exception to the engine-wide pause
contract; pausing after dispatch still records the admitted result. Explicit
regeneration/retry requires both an intent ID different from the latest attempt
and a new input revision; repeated delivery of the same revision cannot spend
again. Planning and request events require an explicit `progress`, `idle` or
`manual` trigger; a missing or unknown trigger throws.

`ConceptLane` runs alongside reaction and understanding. It records durable
`concept.state` events before dispatch and after success/failure, and
`concept.feedback` events for thumbs, guidance and archive changes. It consumes
only current, final understanding on the same readiness scale shown in the UI.
A first render needs an armed threshold as well as intent; quiet time cannot
replace enough understanding. The Request control is itself an expressed visual
wish, bound to an active person turn. After an earlier admitted attempt, that
control uses the manual trigger, even with no additional turns. Conversational
intent comes only from the model's structured understanding output:
`conceptIntent: {request_quote: "exact full current person message"}` or `null`.
The trimmed quote must equal the latest active person turn's trimmed content;
assistant text, partial quotes and unmatched quotes are rejected. A durable current-turn marker is consumed once
and cleared on consent changes/end, preventing old turns from reviving intent
on assistant voice events, resume or a new consent grant. No keyword matcher
records spending intent. The deterministic mock always returns `null`.

`presets[preset].bindings.images` uses `createImageBinding({...common,
imageCost: {inputMicro, outputMicro, maxInputTokens, maxOutputTokens}})`. The
common fields are the existing private binding, including `maxMicro`, legal
qualification, exact account/model/endpoint/routing, and `secretRef`. The
conservative input rate must cover both text and image-input token prices;
the token ceilings must cover the admitted image sizes, quality, reference count
and provider output. Their maximum cost must fit `maxMicro`. These are private
host facts, never public manifest rates. Only `{maxMicro}` reaches the UI as a
cost ceiling, formatted by host copy. No live price, qualification or provider
call is claimed by this implementation.

The runtime admits image attempts into the same `SQLiteBudgetLedger` under
lane `concept`. Fresh exact `generate` or `edit` processing coverage is checked
at admission, claim consumption and publication; references select the edit
scope. Preset, pause, ownership, tombstone, private evidence, health and budget
checks fail closed. Known usage settles at the private image rates, overruns
remain visible, and unknown dispatched usage retains the reserved maximum.
Restart releases undispatched holds, settles dispatched holds conservatively,
and marks interrupted concepts failed without repeating a provider call.
Retry and regenerate require fresh intent IDs and byte-bound client receipts.
Only a new explicit request can retry a failed revision.

SQLite stores PNG/WebP/JPEG bytes in `concept_artifacts` BLOBs, with provenance,
digests and frozen source dependencies. There is a 64 MiB content ceiling per
session; admission requires room for a maximum 12 MiB image. Generated reference
dependencies are expanded transitively. Prompts are reconstructed in memory for
the invocation and never persisted in journal metadata. Feedback text lives in
erasable content records; events, receipts and snapshots hold content references.
Withdrawal/expiry erases dependent image bytes and feedback before acknowledgement,
while unrelated history remains. Consent withdrawal and full erasure remove all
concept content, cancel pending work and await budget settlement. Removed reference
IDs have the same path through `await handlers.removeConceptReference(id, referenceId)`.
Replay and hydration replace erased artifacts/feedback with tombstones. Export
includes saved images, `concepts.json` and provenance sidecars when current image
coverage permits publication. Otherwise it omits image bytes, provenance and
feedback content, retains non-content concept metadata, and still exports the
transcript and understanding. Removed content cannot return through export.

The feature matrix gates requests/refinements and feedback with reasons; device
images remain unavailable. Pause permits cached images. The UI reserves fixed
space for the scene/progress/countdown, transcript preview and Concept tab;
automatic viewer/control updates wait for pointer leave. The countdown is an
estimate and never reaches completion until durable success. The single modal
viewer has a title, previous/next/count, keyboard/touch navigation, authenticated
same-origin download GET, cost-labelled regeneration, thumbs, removable guidance
and Reject and archive, which returns to the conversation. All concept copy is
host i18n, and all feedback is rendered as literal text. Opening, navigating,
downloading, liking, rejecting and ending a call never record spending intent.

The labelled local demo registers `createLocalImages()` and `localImageBinding`
by default. It draws a small valid deterministic PNG, with fixture provider/model
provenance; the UI explicitly labels it as fake, with no AI/provider network.
Allow mock consent, describe needs (the mock recognises `operations: hosted;
data: public; systems: API; reach: international`), then select Request concept.
Feedback changes the next fixture's palette and references. Restart retains
images and feedback but loses the demo host's consent grant; grant again to view.
`AITHEMA_IMAGE_MODE=off` disables images.

Live OpenAI remains explicitly configured and unverified: select
`AITHEMA_IMAGE_MODE=openai` and set `AITHEMA_IMAGE_HOST_MODULE` to a private
server-only module exporting `createImageHost({storage})`. It returns
`{binding, consent, policy, resolveSecret?}`; the binding is the image binding
above for `openai-images` / `gpt-image-2` / `none` and API base URL
`https://api.openai.com/v1`. `policy.endpoints` must admit that exact URL.
The authoritative consent port must be shared with any live voice host; the
local mock grant does not cover OpenAI. Only `binding.secretRef` identifies the
key; the server resolves it at dispatch through `resolveSecret(ref)` (or the
named environment variable), never the browser. Keys present in the environment
do not select a provider. No live calls were run.

AIT-100 part B remains separate. Hosts can already provide
`concepts: {references(session)}` to `createHandlers`: return owner-scoped,
tombstone-aware `{id, role: 'upload', load: () => ({bytes, mediaType})}` descriptors
with immutable opaque source IDs, never URLs. Enumerate metadata without reading
bytes; `load()` runs only after planning selects generation. Existing in-memory
`{id, bytes, mediaType, role: 'upload'}` descriptors also work. The base reference
is the latest liked available item, falling back to the latest available item;
one latest archived rejection is sent as a negative reference, matching START.
At most nine total references are used, each
at most 12 MiB. After durably removing the upload source, await
`handlers.removeConceptReference(sessionId, sourceId)` before acknowledgement.
The included fake tests exercise this port, dependency-scoped removal and an
upload/turn with the same ID. Upload routes and their UI will arrive on AIT-100.

`createCodexImagegen({binding})` from `@inspr/aithema-plugin-codex-imagegen`
implements the same server-only generate/edit contract. The operator supplies
`binding.model`, `binding.effort`, and
`binding.routing.codex = {binaryPath, codexHome, timeoutMs, trustedPromptsOnly: true}`
(absolute dedicated account directory, executable path or PATH name, timeout
1–1,800,000 ms). Common binding
fields remain required; `secretRef` is unused because CODEX_HOME selects the
operator's authenticated CLI account. Require `maxMicro: 0` and zero rates.
Provision a dedicated `CODEX_HOME` holding only the operator's `auth.json`;
never point it at a personal Codex home. Startup and each render inspect only
directory names and metadata, rejecting `config.toml`, `AGENTS.md`, symlinks
and every other entry; authentication bytes are never inspected by the adapter.
The CLI runs with `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and
explicit `-c` overrides for workspace-write, network off, no additional writable
roots or implicit system temp roots, no MCP servers, web search disabled, zero
project-doc bytes/no fallback docs, and an empty shell environment policy.
The child receives only PATH, LANG, CODEX_HOME and workspace-local HOME/TMPDIR.

Compatibility is checked locally before rendering with bounded, non-rendering
`exec ... --help` and `features list` calls in an empty temporary Codex home;
rejected flags/features, missing
help evidence or unexpected enabled tools fail closed. Supported shell, code,
browser, app/plugin, MCP-discovery, file-view, agent and other tool switches are
disabled; built-in image generation stays enabled. **H2 limitation:** installed
Codex CLI 0.162.0 still lists `unified_exec stable true` after `--disable
unified_exec -c features.unified_exec=false`. Its `apply_patch_freeform` switch
is removed, so it also cannot establish that `apply_patch` is disabled. Shell
commands can still read files outside the workspace, including authentication
material, and encode them into an image. The adapter therefore refuses bindings
unless the operator explicitly sets `trustedPromptsOnly === true`. That setting
attests that every host prompt, feedback string and reference is trusted; never
forward raw visitor content under this binding. The prompt instruction remains
defence in depth. This flag does not make untrusted text safe. See the cited CLI
help/feature lines in `plugins/codex-imagegen/src/cli.js`.

The adapter passes private references through variadic `-i` and the full host
brief through stdin, enforces one active CLI across instances, kills/reaps its
process group and cleans its private workspace before settlement. Descendants
that call `setsid` or detach into a new process group **can escape** this kill;
an OS process supervisor/isolation boundary is needed to contain such children.
`--ephemeral` avoids persisted sessions, but does not promise removal of every
tool-generated cache or copy; the auth-only home is revalidated on the next call.
Only one output file is accepted, regardless of extension; symlinks and hard
links are rejected. Sniffed format must match the request and header-derived
dimensions must be within 5% on each axis of `spec.size` (default 1536×1024),
with at most 4096 pixels per side and 12 MiB of encoded bytes.

Dispatched reports add `chargedMicro: 0` (the claim maximum) and `durationMs`.
Failures, crashes, deadlines and cancellation after the child spawns report
`outcome: 'uncertain'` without usage, matching shared settlement semantics.
Successful zero token totals are monetary settlement units, not measured CLI
consumption. Preflight/refusal keeps the exact shared zero report. Provenance
identifies `codex-imagegen`, the bound model and byte digest through response
fields. Health checks executable/account-directory availability and startup
compatibility without authenticating or rendering. All tests use a fake
executable; no live Codex render is performed.

AIT-113 part B wiring requirements, still pending:

- Register/bind the plugin in the images lane with current consent and zero
  monetary admission; enforce the trusted-prompts restriction before selection.
- **Require per-session and per-day render rate limits before visitors can
  trigger any renders**, with an atomic operator-account daily quota shared
  across sessions/instances. Zero monetary rates and the single active slot
  do not bound subscription usage. Count dispatched failed/uncertain attempts;
  cancellation must not restore quota. Raw visitor prompts also require a
  CLI/OS boundary that actually prevents arbitrary file reads.
- Persist the provenance sidecar, uncertain settlement and elapsed time;
  propagate cancellation/deadlines and contain detached descendants with a
  process supervisor when enabling this route.

The reusable conformance call is
`uiGenerationConformance(plugin, {spec, feedback, artifact},
{stallSpec, stallFeedback, requestCount, expectedUsage?})`. Local fixtures must
stall both operations and count outbound calls synchronously. The kit computes
SHA-256 with `crypto.subtle` over the final artifact bytes and compares it with
`provenance.subject.contentDigest`. The core `imageInfo` reader checks PNG,
WebP and JPEG signatures/headers and their actual dimensions (not pixel decoding).
The kit also checks manifest/health, terminal reports, consumption/refusal and
preflight plus active cancellation/deadlines. Optional `expectedUsage:
{inputTokens, outputTokens}` checks exact completed-call totals, including
under-reporting or unknown usage. Reference fixtures pass `spec.references`;
CI tests their multipart transport, limits and broken content/usage fixtures.

## Host ports (AIT-104 part A)

Core exports pure identity, handover and credit reducers plus owner-bound library
and delivery contracts. There is no HTTP, persistent storage, mail, CRM or billing
implementation in these modules. Reducers return `{state, events}`; handover also
returns a `delivery` effect. Part B persists state before dispatching effects and
adds the routes/UI below. Host copy, branding, persona, legal text and schedules
remain host-owned.

`createIdentity({roles?, role?, demoBypass?, policy?})` starts a guest. Default
roles are `private`, `company`, `representative`, `agency`; hosts may replace the
taxonomy. `reduceIdentity(state, {type, now, ...})` accepts `request-verification`
and `change-address` with `address`, `resend`, `delivery` with
`{address, revision, status: 'sent'|'failed'}`, and authoritative `verification`
with `{address, revision, verified: true}`. Host time is monotonic milliseconds.
`verification.requested` carries the address/revision/deadline for host delivery;
it does not claim mail was sent. Resend is allowed at `now >= resendAt`, including
when a lost delivery result leaves `delivery: 'requested'`; the revision rejects
late delivery results and confirmation for the old request. Each resend
invalidates older evidence. Changing
an address immediately relocks both surfaces and retains the cooldown. Expiry
rejects late confirmation. The defaults are a 60-second cooldown and 30-minute
expiry. `tick`, `role`, `pause {origin: 'manual'|'visibility', paused}` and
`visibility {visible}` update renderable `identity.state` events. Confirmation
emits `identity.unlocked` and preserves manual pause. Visible confirmation can
release the verification detour's visibility pause; hidden confirmation sets
the one-shot `releaseVisibilityOnReturn` flag, consumed on the next visible
event. An ordinary blur pause remains paused on return and needs acknowledged
resume. A new visibility pause or address change cancels a pending release.
Demo bypass unlocks without claiming verified identity. Only trusted creation
can grant it; the host-only `demo {origin: 'host', enabled: false}` event revokes
it when an operator grant ends. Never expose this event to visitor input.
Use separate session identity metadata; the existing reasoning `session.actor`
is an evidence-based actor selection and must not become an authentication claim.

`assertLibraryPort(port)` requires `list({search?, offset?, limit?})`, `open(id)`,
`rename(id, title)`, `delete(id)`, `new({title?, locale?, processingPreset?, preset?})`
and `reset(id)`. Lists return `{items, total, offset, limit}` with metadata
`{id, title, revision, createdAt, updatedAt}`; open/new/reset also return `session`.
Titles/search are at most 200 characters, pages 1–100 rows. Search is a literal,
case-insensitive title substring: SQL hosts must escape `%` and `_` in `LIKE`.
Lists sort by descending `updatedAt`, then ID. Offset pages can shift when a
rename or other update lands between reads, causing repeated or skipped rows;
clients refresh from offset zero after mutations and deduplicate displayed IDs.
Metadata revision is
distinct from the core input fingerprint. Delete must acknowledge `{id, erased:
true}` only after the existing storage erasure/invalidation path completes. Reset
erases the old conversation and creates a fresh ID retaining locale/preset.
Concurrent resets of the same ID share one erasure and one replacement;
failed erasure retains the original and releases the slot for retry.
New/reset only change conversation data. Hosts must retain the same owner wallet
and credit guard across them, as described below. `createMemoryLibrary({erase?, now?})` returns
`{port, wasErased}`. Its default erasure is limited to its own memory;
a supplied `erase({id, revision})` must confirm `{erased: true}`.
`libraryConformance(port, {wasErased, foreignPort?, timeoutMs?})` runs destructive
local fixtures and needs an independent observer of the storage erasure path.
The optional `foreignPort` is bound to a second owner in the same fixture store:
its list must exclude the first owner's IDs, and open/rename/delete/reset of those
IDs must reject with `code: 'not-found'`, leaving the first owner's data unchanged.
The kit also checks literal `%`/`_` searches when absent and when only `50% plan`
or `under_score plan` matches. Use fresh fixtures with globally distinct IDs.

`createHandover({sessionId})` and `reduceHandover` accept `request {revision}`,
explicit `retry {revision}` for the current failed revision only,
`result {revision, attempt, status, receiptId?}` and
`recover`. Use the complete `inputRevision(session)` fingerprint as revision.
`handover.state` exposes `idle`, `preparing`, `sent`, `failed` and retry state;
effects carry `{sessionId, revision, idempotencyKey, attempt}`. The host's
`deliver(effect)` resolves `{status: 'sent', receiptId}` only on confirmed
delivery, otherwise rejects. Prepare the host payload from that exact revision;
persist receipts and deduplicate concurrent deliveries across restarts by the
same key, including failed/interrupted retries. Sent revisions stay idempotent
after later revisions. Core retains at most `HANDOVER_REVISION_LIMIT` (100)
revision records, preserving every retained idempotency key. At the bound,
a new revision emits `handover.limit-reached {reason: 'revision-limit', limit}`
without delivery; retry of the current failed revision remains available.
The host must retain durable deduplication receipts regardless of core history.
Offer, mail, CRM and future Paimos intake belong to the
host. `createFakeHandoverHost()` returns `{port, failNext, deliveryCount}`;
`handoverConformance(port, {failNext, deliveryCount, timeoutMs?})` checks a local
fixture's receipts, failures, retries, conflicting keys and concurrent delivery.

`budgetCreditView(ledger, sessionId, ownerWallet)` projects `owner`, `session` and
`voiceVisitor` balances as `{limitMicro, committedMicro, availableMicro, overrunMicro}`.
Both existing SQLite ledger caps are per conversation: `session` is upstream
usage, and `voiceVisitor` is that conversation's voice charge, not the owner's
wallet. Ledger `used`/`visitorUsed` include holds and conservative uncertain
settlement. A required host wallet is bound to the authenticated owner across
all their conversations. It supplies synchronous `balance()` returning
`{limitMicro, committedMicro}`, synchronous `canAdmit({sessionId, maxMicro,
maxVisitorMicro})` returning a boolean preview, and `admit(request)` returning
`{ok: boolean}` (possibly asynchronously) after atomic owner admission. Admission
must be idempotent for concurrent and serial retries of the same `attemptId` and
request. Store the fingerprint (`sessionId`, `lane`, `maxMicro`, `maxVisitorMicro`
with default `0`, `requestSha256`, `bindingSha256`) with that ID. Reuse with a
different fingerprint must return `{ok: false, reason: 'attempt-conflict'}` and
must neither return the old hold nor change it. Retain the fingerprint after
release. The required `release({attemptId})` hook must await removal of only
that hold; repeated and unknown releases are harmless. The host owns wallet
billing, reservations, settlement and recovery; core adds no billing policy.

`creditAdmission(ledger, sessionId, maxMicro, maxVisitorMicro, ownerWallet)` is a
preview. Paid hosts must call `await admitCredits(ledger, request, ownerWallet)`:
it requires confirmed owner admission before the existing atomic `ledger.admit`.
Both ports receive the same frozen request snapshot with the caller's `attemptId`
or a generated ID. Use that ID for admission, settlement and recovery; the ledger
must preserve it in its admission result. Core holds an in-flight set through
wallet admission, ledger admission and any release. Concurrent duplicates throw
`code: 'already-claimed'` before either port is called. Multi-process hosts must
implement the same exclusion at the wallet or ledger across their processes.
Owner denial maps to `host-limit` and never admits the ledger; an unavailable or
malformed wallet fails closed. Success returns `{ok: true, reason: null, admission}`;
preview and ordinary owner denials return `{ok: false, reason, balance}`. Wallet
conflicts return `{ok: false, reason: 'attempt-conflict', attemptId}`. A definitive
ledger refusal must reject with `code: 'not-admitted'` and guarantee that no
reservation was created. Core then awaits owner release and returns
`{ok: false, reason, attemptId}` without `balance`. Ledger `already-claimed`
errors retain the existing owner hold. An unknown ledger outcome (for example
a remote timeout after a possible reservation) must be an error, not a definitive
refusal: propagate it without releasing the hold and reconcile by `attemptId`.
Wallet errors and release failures also propagate, with `attemptId` attached to
thrown errors for recovery, including generated IDs. Continue the existing claim
and settlement path only after success. `maxVisitorMicro` keeps the ledger's
parameter name and remains a per-conversation voice maximum.

`ownerWalletConformance(port, request, {timeoutMs?})` runs destructive checks on
a fresh, owner-bound local fixture with an affordable positive `maxMicro` and
the complete fingerprint fields. It checks concurrent/serial admission
idempotency, mismatches of every fingerprint field with unchanged holds,
idempotent release and conflicts after release. Never run the kit on a live wallet.

`createCredits({sessionId, durationMs?})`
and `reduceCredits` accept `start`, `balance {balance}`, `pause {paused}`, `tick`,
authoritative `limit {reason: 'session'|'voiceVisitor'|'host-limit'}` and `closed`, all
with `now`. Hosts persist one credit guard state per owner and create it only
when that owner has no existing guard. On library new/reset, persist
`rebindCredits(existingState, newSessionId)` and re-read the balance; do not call
`createCredits` again. Rebinding preserves start/deadline, pause and terminal
state, so neither operation restores the owner's balance or one-hour allowance.
The one-hour wall-clock guard starts once and pause never extends it.
A full outstanding hold only updates the view. An actual denial/elapsed guard
emits one `conversation.end-requested`; the host stops fresh work, closes transport,
settles outstanding claims and then records `closed`, preserving the transcript.
`requestCreditTopUp(port, {sessionId}, options?)` invokes optional host `topUp`,
returning `requested`/`unavailable`; it changes neither ledger totals nor the guard.

Part B wires the following owner-authenticated surface, with bounded input,
safe copy and durable acknowledgements:

| Surface | Required integration |
| --- | --- |
| Identity routes and inline verification | `POST /api/sessions/:id/identity` for address/role, `POST .../identity/resend`, `GET .../identity` for polling. A host verification landing page performs read-only inspection; its explicit confirmation POST redeems host-owned evidence before recording `verification`. Bind evidence to session, address and revision; reject expiry/reuse. Poll/focus updates unlock assessment and concepts while preserving manual pause and hidden-tab holds. Tokens and addresses use erasable records; public replay must hydrate tombstones. |
| Library routes and view | `GET /api/library?search=&offset=&limit=`, `POST /api/library` (new), `GET /api/library/:id` (open), `PATCH /api/library/:id` (rename), `DELETE /api/library/:id`, `POST /api/library/:id/reset`. Bind the port to the authenticated owner and check every target. Delete/reset await the existing `storage.erase` path, including uploads/concepts, pending-work cancellation and export/cache invalidation. Render search, paging, open, rename, delete confirmation, new/reset and empty/error states. |
| Handover button/state and route | `POST /api/sessions/:id/handover` for request/retry; publish durable `handover.state` through session replay. Persist `preparing` before calling the configured host delivery port, recheck ownership/revision/consent, report honest sent/failed outcomes, and recover interrupted deliveries using the same key. Keep host payloads erasable and provider errors out of events. |
| Credits slot and routes | `GET /api/sessions/:id/credits` and optional `POST .../credits/top-up`. Bind the wallet to the authenticated owner across conversations, use `admitCredits` before dispatch, and retain/rebind that owner's guard on new/reset. Render owner, session and voiceVisitor balances, guard countdown, limit reason and host top-up action; guard/denial stop fresh work and close/settle admitted transports gracefully. Re-read host credit policy after verification/top-up; no UI or new/reset action grants funds or admits work. |
| Account menu / actor role | Host account/status, current address, configured role choices and change/resend controls consume `identity.state`. Propagate explicit role selection through the existing reasoning actor-selection path without treating inferred roles as identity proof. |
| Settings/preset and legal/footer slots | Connect the existing preset/settings panel and feature matrix to host-approved model, effort, voice, visuals and connector choices. Supply account menu, library view, verification inline, handover button/state, credits, legal links, footer status, branding and optional release-history slots; all text/link destinations are host configuration. |

The new core tests cover each reducer, the reference hosts, broken hosts for
both conformance kits, and projections against the existing SQLite budget ledger.
These are integration contracts; production routes and UI slots are Part B work.

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
| `src/scripts/{concept-viewer,concept-backdrop}.ts`, `src/lib/{generated-ui-view,generated-ui-progress,generated-ui-idle}.ts`, `src/pages/index.astro` (concepts) | `packages/ui/src/{concept-view,session-element,styles}.js` | one immersive viewer, preview, fixed controls, estimated countdown, feedback and cost copy; no START branding |
| `src/pages/api/v2/generated-ui/index.ts` | `packages/core/src/concept-lane.js`, `packages/server/src/{concept-handlers,image-binding,local-images,storage}.js` | durable intent/progress, private-byte references, exact image scopes, conservative private costs, byte history and erasure |
| `tests/generated-ui.test.ts` | `packages/core/test/concept-intent.test.js`, `plugins/openai-images/test/openai-images.test.js` | selected spending, slow-render, removal/withdrawal and private image transport cases with fakes |
| `src/lib/{extract,ooxml}.ts`, `src/pages/api/upload.ts`; Gen-2 `runtime/{extract,pdf-extract-child}.js`, `lib/{extract-limits,intake}.js` | `packages/core/src/extractor*.js`, `plugins/extract-{pdf,ooxml,text}/` | bounded offline extraction and byte sniffing; child kill/reaping, stricter ZIP bomb/CRC checks, added PPTX and citable segments; foreign approval stays untrusted source text |

## License and contributions

Aithema's core, server, UI and plugins are **AGPL-3.0-only**; see [LICENSE](LICENSE).
Third-party dependencies retain their own licences, recorded in [NOTICES.json](NOTICES.json).
Commercial-host licensing must follow the applicable licence or a separately
formalised grant from INSPR; this README grants no exception.

Every contribution commit requires a matching `Signed-off-by` trailer under the
[Developer Certificate of Origin 1.1](DCO), created with `git commit --signoff`.
External contributions also require an agreement with INSPR permitting relicensing;
DCO sign-off alone is insufficient. Review, merge and release remain maintainer-controlled.


## Test-host deployment (AIT-115)

Run a pinned source commit with Node 24 or the provided `node:24-bookworm-slim`
Dockerfile: `npm ci --omit=dev`, then `node demo/server.js`. The ElevenLabs SDK
1.17.0 is a runtime dependency; the host serves its IIFE and worklets locally.
The image runs as `node`, binds port 3000 and uses its `/data` volume for SQLite.
Mount `/data` writable by that user, preserve the SQLite database plus WAL on
restart, and run exactly one writer. Set `AITHEMA_COMMIT` to the deployed full
source SHA. The container healthcheck supplies the configured public Host while
connecting over local HTTP. Readiness of voice is separately visible in
`/demo/config` and the session feature matrix; `/healthz` is a process probe.

| Environment | Meaning / default |
| --- | --- |
| `PORT` | Listen port; local/container default `3000` |
| `AITHEMA_LISTEN_HOST` | Bind address; local `127.0.0.1`, image `0.0.0.0` |
| `AITHEMA_PUBLIC_ORIGIN` | Canonical origin, e.g. `https://start2.augmentoring.com`, without trailing slash; accepted Host, facade base URL and Secure cookies |
| `AITHEMA_DB` | Persistent SQLite path; local `.data/session.sqlite`, image `/data/session.sqlite` |
| `AITHEMA_COMMIT` | Deployed source SHA; `/healthz` reports this or `null` |
| `AITHEMA_PROVIDER` | `openrouter` for live reasoning; defaults to `mock` |
| `OPENROUTER_API_KEY` | Account credential supplied by OPS through its secret service |
| `OPENROUTER_MODEL` | Exact model id; default `openai/gpt-4.1-mini`; only START-consented OpenAI, Anthropic or xAI providers are admitted |
| `AITHEMA_OPENROUTER_CAP_USD` | Lifetime persisted account cap; decimal USD with up to six fractional digits, default `10` |
| `AITHEMA_OPENROUTER_RESERVE_USD` | Conservative per-request hold, default `1`; requests exceeding its byte/output price bound are refused before dispatch |
| `AITHEMA_VOICE_MODE` | `elevenlabs` enables startup ensure; default `fake`; `off` disables voice |
| `ELEVENLABS_API_KEY` | ElevenLabs account key; reference resolves server-side only |
| `AITHEMA_ELEVENLABS_TEMPLATE_AGENT_ID` | START agent to GET for selected voice/language/ASR/turn/privacy settings; never a write target |
| `AITHEMA_VOICE_FACADE_SECRET` | Deployment callback bearer supplied by OPS; startup creates/updates its owned workspace-secret reference |
| `AITHEMA_IMAGE_MODE` | Use `off` for the first live smoke; default `fake`; `openai` requires a separate host module |
| `AITHEMA_VOICE_HOST_MODULE` | Optional server-only host override; unset selects built-in start2 host |

Production requires no `ELEVENLABS_AGENT_ID`: the owned agent id comes from ensure
and is cached in `AITHEMA_DB`. An existing same-name foreign agent or multiple
exact-name matches disables voice with a value-free reason. Only a creation
receipt persisted in this database authorizes updates. Losing the ownership
cache never authorizes taking over an existing agent/secret; restore the database
or let the operator resolve the conflict. Secrets are not cached in SQLite.
Template prompts, personas, first messages, knowledge bases and tools are excluded.
The host's custom LLM has an empty prompt/greeting and no tools or knowledge base;
Aithema rebuilds the trusted session prompt at each callback.

Caddy must preserve the incoming `Host` header and terminate HTTPS. Protect
**everything** with `basic_auth`, except **POST**
`/api/voice/llm/chat/completions` and **GET** `/healthz` (method and path both must
match). Those exceptions still pass the Host allowlist; the callback additionally
requires the static bearer. Keep session, consent, SDK/worklet and `/demo/config`
paths behind basic auth. Forwarded headers never choose the origin or cookie
security. Browser requests with a foreign Origin are refused; provider callbacks
use bearer authentication instead of a browser Origin.

The consent panel ports START's English `models-international` and
`voice-elevenlabs` items, versions and twelve-month lapse. Grant them separately.
SQLite records the item choices, time, wording and consent revision without
conversation content. Coverage is checked against the exact configured processing
scope before admission/dispatch and fails closed on expiry, withdrawal or changed
binding. The old `{granted:true}` mock request cannot authorize these providers.
This host makes no EU residency, no-training or zero-retention claim. START's
self-serve Agents path is US-based; copied privacy flags are not entitlement proof.

`createSpendCap({storage, account, capMicro})`, exported by the server package,
reserves under a SQLite transaction. A second plugin can share account
`start2-openrouter` and the same database. Every OpenRouter request asks for
`usage.include`; final streaming or non-streaming `usage.cost` settles its hold
in upward-rounded microdollars. Missing usage, cancellation, broken responses and
process death keep the whole hold, including across restart. The cap counts both
actual cost and these holds, across all sessions and reasoning lanes. START's
byte bound plus framing allowance and `provider.max_price` routing caps ensure
a request fits its reservation; oversized requests are refused before spending.
Raising the cap does not reset the counter. Do not remove uncertain holds merely
to make another request fit.

The startup ensure code marks these **UNVERIFIED API SHAPE** assumptions, absent
from START's source: paginated agent list; agent create/PATCH and detailed
TTS/ASR/turn/privacy fields; `custom_llm` secret-id authentication; platform
allowlist/override fields; workspace-secret list/create/PATCH bodies; the
conversation-details `conversation_id` echo used for closure binding. Local fakes
exercise the assumed contracts. The coordinator must verify the live shapes
before enabling this deployment.

Coordinator live smoke, after its Claude approval gate:

1. Before service startup/writes, use OPS's secret-aware tooling for authenticated
   read-only GETs: `/v1/convai/agents?page_size=100` (follow `next_cursor`),
   `/v1/convai/agents/<template-id>`, `/v1/convai/workspace/secrets` and
   `/v1/convai/conversations/<existing-completed-id>`. Inspect only
   names/ids and the required field shapes. Confirm no ambiguous `aithema-start2`,
   confirm template voice/language/privacy and platform overrides, and confirm
   API documentation for create/PATCH and secret-id auth; GETs alone cannot prove
   write payloads. Never print key, secret or full config bodies.
2. Start the pinned host with the environment above. Confirm it creates one owned
   agent and one workspace secret. GET the owned agent, inspecting only its name,
   id and callback/allowlist/secret-reference fields. Verify template id was never
   a write target, its prompt was not copied, and the bearer is a secret id reference.
   Restart with the same database; it must update that same agent without duplicates.
3. GET public `/healthz` without basic auth or a session; expect
   `{"ok":true,"commit":"<deployed-sha>"}`. A foreign Host must receive 403. Confirm
   other methods on that path and all session/asset paths remain basic-auth protected.
   POST the callback without/wrong bearer: 401, even with malformed JSON. Correct
   bearer with no/unknown/ended identity: 403. `/api/voice/<call-id>/...` is disabled.
4. Open the HTTPS page with basic auth. Confirm the ownership cookie has Secure,
   HttpOnly and SameSite=Strict. Before consent, live voice/reasoning must be denied;
   the mock grant alone must be refused. Select both separate items and grant them.
   Start a call, speak, hear an answer, type during voice, pause/resume and close.
   Observe durable turns and authenticated final provider usage; no per-call agent
   PATCH occurs. Withdraw consent mid-call and confirm later callbacks cannot reason.
5. Inspect value-free SQLite `spend_reservations` totals: non-stream analysis and
   streaming reaction costs sum; missing/uncertain usage retains the hold. Restart
   and confirm totals persist. On an isolated small-cap test database, once the
   next reservation would exceed the cap, the next call must be refused with no
   OpenRouter dispatch. Keep production ownership/cost state intact.

The built-in host has no confirmed server-side hangup endpoint. Browser hangup,
lease expiry and the owned agent's 600-second platform ceiling remain the
backstops. Until authenticated final details arrive, closure stays conservative
and pending reconciliation survives restart. Provider write shapes and real-key
smoke verification belong to the coordinator; none were run by the builder.
