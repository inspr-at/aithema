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
Visitors choose the processing preset, model, response style, voice and visual
concepts within the host's allowlist, enforced and acknowledged by the server.
The server host surface supplies email verification/unlock, an owner conversation
library, handover retry and a server-computed credits slot; `<aithema-session>`
shows them when the host passes `configure({host})` (AIT-104 B2).
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
updates, the settings dialog (focus moves in and returns, Custom preset, Swift model
and Low response style each acknowledged by a 200 settings POST, the next reply
coming from Swift and labelled with it), persistence of that choice across reload,
a ZIP download, the dialog at a 400 × 800 viewport (inside the viewport, no
horizontal overflow, hovering presets, selects and gauges moves no control, Escape
returns focus) and the Advanced tab against a loopback OpenAI-compatible fixture
(handshake, model choice and a streamed test chat). Console errors, page exceptions and failed
same-origin requests fail the test. The separate PR CI `browser` job runs on
Ubuntu with Node 24 and a five-minute limit;
`npm test` does not require a browser. To prove the missing JSON content-type
regression is detected, run `AITHEMA_BROWSER_REGRESSION=1 npm run test:browser`:
this serves a test-only faulty `demo/host.js` session POST and must fail with 415,
without changing the demo files. `test/browser/host-surface.test.js` covers the host
surface UI (below) against the demo with `AITHEMA_DEMO_VERIFY=1` and
`AITHEMA_DEMO_HANDOVER_FAIL=1`; set `AITHEMA_EVIDENCE_DIR` to save its screenshots.

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

**Settings** in the processing panel opens the visitor settings dialog; a new
conversation first offers the preset chooser (Best models, In the EU, On my device,
Custom) and then a ready card. The demo operator allowlist (`demo/choices.js`) offers
Mock reasoning plus the OpenRouter-style mock models `mock/swift` and `mock/deep`
with their own response styles, fake voice and fake images; ElevenLabs, OpenAI
GPT Image 2 and an OpenRouter model are declared but not configured, and In the EU
has no qualified account, so all of them stay visibly unavailable with the server's
reason. The Advanced tab connects a model running on this computer. With
`AITHEMA_PROVIDER` set the demo is a live host: its allowlist offers only the
configured route (speech and understanding models as one model option, at their
configured effort) and the configured voice and images, never a mock or an
unconfigured option.

The demo stays on the mock even when provider environment variables exist.
`AITHEMA_PROVIDER=openrouter|mistral` explicitly selects a provider.
OpenRouter requires `OPENROUTER_MODEL` for understanding and
`AITHEMA_OPENROUTER_PRICES` for every configured model; missing or invalid values
refuse startup. `OPENROUTER_SPEECH_MODEL` selects reaction replies (spoken and
typed, including the voice facade) and defaults to `OPENROUTER_MODEL`.
Choose a fast speech model for the seven-second platform timeout; replies are
capped by `OPENROUTER_MAX_TOKENS` (default `1200`), while understanding uses
`OPENROUTER_ANALYSIS_MAX_TOKENS` (default `8000`); START found smaller analysis
ceilings truncated real assessments. Every request requires parameter-capable
upstreams. `OPENROUTER_PROVIDER_ONLY` is the optional comma-separated upstream
allow-list and must mirror START exactly as part of the legal profile.
`OPENROUTER_ANALYSIS_PROVIDER_IGNORE` defaults to `Azure` for understanding only.
`MISTRAL_MODEL` selects the Mistral model. Live OpenRouter uses the START host
qualification below and still requires current consent; Mistral remains
unverified until a host supplies private qualification and current consent.
Keys resolve from `OPENROUTER_API_KEY` or `MISTRAL_API_KEY` only at runtime; they
never enter manifests, snapshots, UI or logs. Tests never use these environment keys.
The demo mock consent does not cover live providers.

## Host surface API (AIT-104 B1)

Pass `host` to `createHandlers`. Its ports are server configuration: the module
never accepts a client actor, role, verification status, balance or handover
revision. `ownership.token(request)` authenticates every host route; the demo
uses the existing HttpOnly visitor cookie, and the default adapter uses
`x-aithema-session-token`. Create the first session with `POST /api/sessions` to
establish ownership. Foreign or erased session IDs return the same 404 before
port calls and deduplication. Library list/new require an owner (401 otherwise).
POSTs accept JSON; empty commands below use `{}`. Responses are uncached.

In this table, `S` is `/api/sessions/:id` and `L` is `/api/library`.

| Method and route | JSON payload / query | Response |
| --- | --- | --- |
| `GET S/identity` | — | `{identity}` |
| `POST S/identity/request` | `{address}` | `{identity}` after requesting host mail |
| `POST S/identity/resend` | `{}` | `{identity}`; cooldown returns 429 with `error: "resend-rate-limit"` |
| `POST S/identity/change` | `{address}` | Immediately revokes old evidence, then requests mail under the same cooldown |
| `POST S/identity/confirm` | `{token}` | `{identity}` using host-confirmed address/revision evidence; exhausted attempts return 429 with `error: "confirmation-rate-limit"` |
| `POST S/identity/unlock` | `{}` | `{identity}` after authoritative host polling |
| `GET L` | `search`, `offset` (default 0), `limit` (default 20, max 100) | `{items,total,offset,limit}` |
| `POST L` | Optional `{title,locale,processingPreset,settings}` | 201 `{id,title,revision,createdAt,updatedAt,session}` |
| `GET L/:id` | — | Library metadata and public `session` snapshot |
| `POST L/:id/rename` | `{title}` (max 200 characters) | Updated metadata |
| `POST L/:id/delete` | `{}` | `{id,erased:true,providerDeletion:"not-confirmed"}` after storage erasure and invalidation |
| `POST L/:id/reset` | `{}` | 201 replacement entry, fresh transcript, `providerDeletion:"not-confirmed"`; previous ID is erased |
| `GET S/handover` | — | `{handover,offer}`; the host owns the offer |
| `POST S/handover` | `{}` | `{handover}` for the server's current input revision |
| `POST S/handover/retry` | `{}` | `{handover}`; retries a failed revision with its original key, joins concurrent delivery |
| `GET S/credits` | — | `{balance,limitSlot}` from `credits.js`, the budget ledger and owner wallet |

Identity includes `status`, `role`, `roles`, `address`, `verificationRevision`,
`delivery`, `expired`, `resendAfterMs`, `canResend`, `pollVerification`,
`verificationRequired`, `confirmationAttemptsRemaining`,
`assessmentUnlocked`, `conceptsUnlocked`, `canRunAssessment`, `canRunConcepts`,
`paused`, `manualPaused` and `demoBypass`. Address changes invalidate stale links
even during cooldown. Unlock retains manual pause; `POST S/pause {paused:false}`
is the existing explicit resume. The verification lock is an explicit host
policy, **off by default**: set `host.policy.verificationRequired: true` only
with an identity port that declares `deliversVerification: true` and actually
delivers verification through `requestVerification` and `verify` (START parity).
It gates assessment and fresh concept admission; transcript export stays
available. New conversations persist their policy. Conversations created before
B1 are adopted with the lock off on restart. When the host policy is turned off,
adoption removes an existing lock and journals `identity.policy-changed` with
`reason: "host-policy-disabled"`, followed by `identity.state`. This includes a
database created with `AITHEMA_DEMO_VERIFY=1` and later opened in live mode.
Adoption retains verification status, attempt counts and pause state; enabling
the policy applies only to new conversations. Only trusted host configuration
may enable a labelled demo bypass. An unlocked guest remains unidentified:
`session.identified` follows verified identity, and live assessment still waits
for `preset.anonymousTurns` unless the visitor has actually verified.

Token confirmation permits five attempts per requested verification revision by
default (`identity.configuration().policy.maxConfirmationAttempts`, an integer
from 1 through 10). Each attempt
is reserved durably in the same SQLite transaction as its state event, before
calling the host, including calls that fail or are interrupted. Once exhausted,
confirmation returns 429 without consulting the port until a new verification
is requested under the resend cooldown. Polling authoritative host evidence
does not redeem a token or spend a confirmation attempt.

The existing `GET S/events` SSE stream carries durable `identity.state`,
`verification.requested`, `identity.resend-blocked`, `identity.unlocked`, `identity.policy-changed`,
`handover.state`, `handover.limit-reached`, `library.state`, `credits.state`,
`credits.limit-reached` and `conversation.end-requested`, in the usual
`{sessionId,seq,generation,type,at,data}` envelope. Snapshots project `identity`,
`handover`, `library` and `credits`; host reducer state commits with its events.
Identity and credits GETs are read-only, including their first read on an older
conversation: they never append events or persist state. Unlock polling emits
events only when reducer state changes; countdowns and repeated replies do not
grow the journal. Identity addresses and library titles are erasable content references in the
journal. Verification tokens never enter snapshots or events. Restart recovers
a preparing handover as retryable `failed` with `delivery-interrupted`.

`balance` contains `sessionId` plus `owner`, `session` and `voiceVisitor`, each
with `limitMicro`, `committedMicro`, `availableMicro`, `overrunMicro`.
`limitSlot` contains `sessionId`, `status`, `balance`, `remainingMs`, `endReason`,
`canStartPaidWork` and `topUpOwnedByHost`. The one-hour clock begins with the first
accepted text turn; the owner guard retains its deadline, pause and terminal
status across new/reset. This route projects the guard; live hosts own paid
admission, settlement, top-up policy and execution of end requests.

Host adapter contract:

- `identity.configuration({sessionId,ownerToken})` synchronously supplies
  `createIdentity` options (roles, policy, demo bypass). `requestVerification`
  receives `{sessionId,ownerToken,address,revision,expiresAt}` and returns
  `{status:"sent"|"failed"}`. `verify` receives the same owner/session binding,
  current `address`, `revision` and optional `token`, returning
  `{verified,address,revision}` from its own token redemption or poll state.
  Calls receive an abort signal and deadline; the configuration's policy sets
  the resend cooldown, verification TTL and positive, bounded
  `maxConfirmationAttempts` (integer 1–10, default 5). Hosts must enforce equivalent durable,
  race-safe attempt limits on any alternate token redemption endpoints; tokens
  must be compared in constant time, single-use, expiry-bound and revision-bound.
  `deliversVerification: true` attests real delivery capability when the host
  enables `host.policy.verificationRequired`.
- `library(ownerToken,hooks)` supplies the Part A library port. Use `hooks.create`
  for settings-aware conversation creation and await `hooks.erase(id)` for the
  storage erasure, lane cancellation and durable invalidation path; `hooks.publish`
  publishes library metadata events. List/search/paging policy belongs to the port.
- `handover(ownerToken)` supplies the Part A delivery port, optionally with
  `offer({sessionId,session}) -> {available,...}`. Delivery receives only the
  server-generated session/revision/key/attempt; the host owns all mail/content
  and must persist delivery receipts in production. No CRM is implemented here.
- `wallet(ownerToken)` supplies the Part A owner wallet. The view includes
  existing ledger holds and settlements. Production hosts must use
  `admitCredits` for authoritative owner reservations and own settlement/recovery;
  the demo wallet and handover sink are local fakes.

`demo/host-ports.js` supplies a SQLite-backed library and labelled in-memory
mail, handover and wallet ports. **Demo-only route:** `GET S/demo/outbox` returns
`{label,messages:[{sessionId,address,revision,expiresAt,token,verified}]}` for the
owner, enabling B2 to submit the token to `S/identity/confirm`. It returns 404
whenever `AITHEMA_PROVIDER` is set, including explicit `mock`; configured live
provider mode supplies no fake verification or handover delivery and never
enables the lock. The default demo needs no verification and makes no verified
identity claim. Set `AITHEMA_DEMO_VERIFY=1` explicitly to enable the demo lock
with the fake outbox; this flag has no effect when `AITHEMA_PROVIDER` is set.
Demo tokens use constant-time comparison and are removed from the outbox after
one redemption (`token: null`); tokenless polling retains the verified fact.
`/demo/config` exposes `hostLabel`, `demoHost` and `verificationRequired`.
The destructive local port kits test owner isolation,
storage erasure, delivery deduplication and wallet reservation fingerprints.

## Host surface UI (AIT-104 B2)

`configure({..., host: {library, verification, handover, credits, locale}})` turns
on the host surface inside `<aithema-session>`; each flag shows one part, and every
fact comes from the routes above. Without `host` nothing changes.

- **Host bar** above the understanding pane (wide) or above the conversation (narrow):
  **Conversations**, the verification entry, the `account` slot and the credits line.
- **Verification** (`verification: true`): while host policy locks the assessment,
  the understanding pane shows the email form in its place (START EmailLock);
  otherwise the bar offers a quiet **Verify your email** that opens a small dialog.
  Send, resend with a visible cooldown, change address; 400 and 429 answers are
  plain words. While a link is pending the component polls `S/identity/unlock`
  (every 4 s, not while the page is hidden). Unlocking keeps a manual pause and
  says so; focus in the form moves to Resume or the composer.
- **Library** (`library: true`): a dialog listing the owner's conversations with
  search (server side), sortable Title and Last activity columns, open, inline
  rename, delete and reset with a confirmation that states the erasure, and New.
  Rows are keyed; confirmations share the footer's cell, so nothing moves. The
  shown order is fixed when the list is loaded, searched or sorted: saving a rename
  or a background reload keeps every row in place.
  Opening, creating or resetting dispatches a cancelable
  `aithema-open-conversation` event with `{session, reason, previousSessionId}`
  (`reason` is `open`, `new`, `reset` or `deleted`). A host that owns per-conversation
  clients (voice) calls `preventDefault()` and reconfigures; otherwise the element
  switches itself.
- **Handover** (`handover: true`): a band under the assessment, shown when the host
  offer is available, with the `handover-offer` slot, one action (Arrange,
  Send update, Retry) whose box never changes, and its state in words, including
  `handover.limit-reached`.
- **Credits** (`credits: true` or `{format(micro, locale)}`): the owner balance and
  the conversation's remaining minutes; on `credits.limit-reached` or an ending
  slot the line names the reason and shows the `credits-limit` slot. The owner's
  deadline keeps running during a pause, so the countdown does too; the line adds
  that a pause only keeps new work from starting. New and reset keep the owner's
  time guard (`rebindCredits`), so a new conversation does not lift the limit.

Named slots, all host content (the demo fills each with labelled demo text, only
while its demo host is active; a live provider host shows none of the demo copy):

| Slot | Where |
| --- | --- |
| `account` | Right end of the host bar (account menu) |
| `credits-limit` | After the credits line once the limit is reached (top-up or next step) |
| `handover-offer` | Offer copy in the handover band (default: a generic sentence) |
| `legal` | Footer row under the workspace, left (legal links) |
| `footer` | Footer row, right (status or imprint); the row shows only when a slot is filled |

New interaction controls that start AI processing (Send confirmation link,
Send link again, library open/New/Reset, the Reset confirmation) list `ai-notice`
in their `aria-describedby`; the verification dialog repeats the notice in view,
since the modal covers the conversation's line. The demo shows a **Fake mail (demo only)** outbox button
whenever its demo host is active (`demoHost`); it lists `GET S/demo/outbox` and
confirms a link through `S/identity/confirm`; the outbox shows the AI notice and its
confirm links are described by it. The demo's handover success line says that only
a local test recipient got the request. `AITHEMA_DEMO_HANDOVER_FAIL=n`
(1–10, demo only) fails the first n fake handover deliveries to show Retry.

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
| `plugins/claude-html` — `@inspr/aithema-plugin-claude-html` | Server-side Claude click-dummy HTML generation/editing through OpenRouter, with a hard USD spend cap |
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
core imports, as the demo does. Copy and CSS tokens belong to the host. Optional
`deviceConnector` (the browser device plugin factory, `createDeviceReasoning`) and
`deviceEndpoint` enable the settings Advanced tab; `voiceClients` maps host voice
option ids to browser voice clients, falling back to `voiceClient`. The component
emits `aithema-new-conversation` with `{processingPreset, settings, previousSessionId}`
when the visitor starts a separate conversation (General tab, or crossing into or
out of On my device once a conversation has started), and `aithema-consent` with
`{sessionId, reason, features}` when a choice needs consent; the host's consent
interface answers it outside the modal dialog.

| Request | Result |
| --- | --- |
| `POST /api/sessions` | New session snapshot; accepts `processingPreset: best|eu|device|custom` and an explicit `settings: {model, effort, voice, visuals}` choice |
| `GET /api/sessions/:id` | Durable snapshot, current operational flags and the public `engine` description of the processing choice |
| `GET /api/sessions/:id/settings` | Public settings catalog: every offered preset, model, effort, voice and visual option with manifest facts and its current verdict |
| `POST /api/sessions/:id/settings` | `{processingPreset, model?, effort?, voice?, visuals?, baseRevision}` option ids; `baseRevision` is required; acknowledged `settings.changed`, updated feature matrix and consent need |
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
current `checkedAt` timestamp; only the local mock has a built-in scope. A host
ledger's `grant({sessionId, consentRevision, decision, scopes})` receives the
visitor's item `decision` (the body's `processing`) and the private scopes of the
session's current processing choice, so it can record exactly what the visitor
agreed to; returning `false` refuses the grant.
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

Assistant replies, including assistant voice transcripts, and generated
understanding objects carry `origin: "ai-generated"` in API snapshots, durable
event replay and exports. When known, `model` is the producing binding's exact
model id and `provider` is its plugin id. These are public identities; keys,
endpoints, routing and account references are excluded. `engine` separately
retains the visitor's selected model label and response style. Voice keeps its
`facade-produced` or `browser-asserted` transcript provenance alongside AI origin;
a matched facade completion names its reasoning producer. Person turns have no
AI-origin fields. Withdrawal, consent revision and erasure remove the origin,
model, provider and engine with their content, including replay and receipts.
An empty understanding after invalidation has no origin metadata. Older generated
records receive the origin label on read; unknown producers remain omitted.

`transcript.json` carries these fields per assistant turn, `transcript.md` visibly
marks each assistant turn `(AI-generated)`, and `understanding.json` carries the
generated understanding's fields. Robust text watermarking depends on upstream
providers and what is "technically feasible"; these provenance labels do not
implement a text watermark.

Every ZIP export includes `manifest.json` with `version: 1`, `generator:
{name: "aithema", version, commit?}`, an ISO-8601 `exportedAt`, and `files:
[{path, sha256, originalSha256?}]`. `generator.version` comes from the server
package; `commit` is the host's `AITHEMA_COMMIT` when it is a Git SHA. Each lowercase
hex SHA-256 covers the exact exported bytes, including JSON, Markdown, uploads,
concepts and provenance sidecars. The manifest itself is excluded from `files`
to avoid a recursive self-digest. Wrapped HTML also has `originalSha256` over
the stored artifact; its sidecar still describes that original. Image bytes
remain identical to the stored artifact. `withheld: [{id, reason}]` matches
`concepts-manifest.json`, including erased concepts. `erased: [{kind, id}]`
accounts for turn, upload and concept tombstones using IDs only; neither list
includes erased content, producer metadata or original digests.

A persistent `SQLiteStorage` holds an OS-backed exclusive lock on the canonical
database's companion `.writer.sqlite` file until close or process death. A second
writer refuses startup. Legacy unowned sessions migrate to the erasable layout
but remain inaccessible to visitors; create a new owned session. No ownership
takeover is provided.

## AI notice (AIT-119, EU AI Act Art. 50(1))

`<aithema-session>` tells people that they are talking to an AI system before the
first interaction, and keeps telling them. One quiet line sits directly under the
conversation header from the component's first paint: before the start card is
answered, before consent, typing or a call, and for the whole conversation. It is
sticky: while the page scrolls, it stays at the top of the viewport for as long as
any part of the conversation pane is in view, so it shows with every place an
interaction can begin (chooser options and Continue, the ready card, Start and
Retry call, the composer) at any width, without anyone scrolling to it. Keyboard
focus stops controls below it, never under it. It reads "You are talking to an
AI assistant. Spoken replies use a synthetic voice." (German: "Sie sprechen mit
einem KI-Assistenten. Gesprochene Antworten verwenden eine synthetische Stimme.").
The second sentence shows only while this conversation can speak: a voice client
is configured and voice is available or waits only for consent, a resume or the
provider. A hidden copy of the full notice holds the line's height, so the
sentence appearing or going never moves anything. Screen readers hear it through
`aria-describedby`, after each control's own description, on every one of those
entry points (each chooser option, Continue, the ready card's actions, Start and
Retry call, the message field, Attach files and Send); it is not a live region, so
it is not re-announced on every update. The conversation pane clips with
`overflow: clip` rather than `hidden`, so it is no scroll container and the line
can stick.

Hosts may reword the notice but cannot remove it. Set `aiNotice: {text, voice}`
in the copy bundle or pass `configure({..., aiNotice: {text, voice}})`, which wins
over the bundle. Each part that is missing, empty or only whitespace falls back,
first to the bundle, then to the default for the session language. The defaults
live in `packages/core/src/ai-notice.js` (`AI_NOTICE`, `aiNotice`, `aiNoticeText`).

The start2 voice host speaks the notice as the agent's first message, set
server-side at startup and fixed: "Sie sprechen mit einem KI-Assistenten;
Antworten sind synthetisch gesprochen. You are talking to an AI assistant with a
synthetic voice." (`SPOKEN_AI_NOTICE`). It is bilingual, German first, because a
call's language may differ from the agent's, and it is not host- or
browser-configurable: the agent refuses a `first_message` conversation override,
the plugin rejects a `firstMessage` override on the server and in the browser,
and the agent has no language presets, the only other way a language could pick
a greeting. Each call overrides only the language (`presentation(locale)`,
passed as `voice.presentation` to `createHandlers`), which changes speech
recognition and voice, not the greeting text. **Unverified live:** that a call
speaks this greeting first, and that the language override leaves it unchanged,
rests on the read-back and provider documentation; see the live smoke below.

## Voice host integration

The demo defaults to **Fake voice — local simulated agent, no provider network**.
Allow local mock consent, select Start call, then use the labelled host controls
to simulate speech, a spoken interruption or transport loss. Type in the composer
while the call runs. Pause/Resume waits for the engine acknowledgement; blur
pauses automatically, and focus never resumes. The agent and provider API are
in-process fakes; only session persistence/control uses localhost HTTP.
`AITHEMA_VOICE_MODE=off` disables it. No microphone audio is captured in fake mode.
With `AITHEMA_PROVIDER` set the demo is a live host: voice and image modes default to
`off`, a `fake` value is treated as `off`, and visitors are offered only configured
live providers.

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
Aggregate voice limits are optional: when `AITHEMA_VOICE_CAP_MINUTES` and
`AITHEMA_VOICE_CAP_MINUTES_PER_DAY` are unset there is **no aggregate voice cap**.
The demo reads both settings and persists its duration ledger in `AITHEMA_DB`.
OPS must set both for start2 before wider exposure. Each admission reserves the
call's maximum provider duration before facade provisioning or credential minting;
insufficient deployment or UTC-day headroom refuses voice with a translated reason.
Daily accounting uses the UTC date of admission, including each recovery attempt;
rollover opens a new daily bucket without deleting old holds or lifetime usage.
Confirmed closure settles to provider seconds (rounded up to milliseconds), including
paused time. Failed minting or startup journal writes before credential handoff
settle both money and duration to zero: no browser conversation was billable.
Uncertain and unreconciled attempts retain their entire hold until
authenticated reconciliation. Recovery keeps the logical call identity and original
deadline and reserves only the remaining duration: confirmed predecessors release
headroom, while an overlapping unconfirmed predecessor still holds its reservation,
so recovery can require additional headroom. Replayed commands do not reserve twice.
Library hosts pass `createVoiceCap({storage, ...voiceCapConfig(values)})` as
`voiceCap` to `createPluginRuntime`, await `handlers.resume()` at startup, and use
`runtime.reconcileVoice(attemptId, confirmedTerminal)` for later authenticated usage.
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
Start2/demo wires the provider's `reconcileLater` hook to an in-process retry:
every 30 seconds after the previous batch finishes, up to 10 pending calls are
checked through `closeOrphan`, each with a one-second deadline. Batches rotate
through pending calls; processing records and outages keep their holds and retry
without a restart. Confirmed reconciliation is recorded durably before releasing
the cap and acknowledging the call journal, so restarts replay the recorded usage
even if the provider's later duration differs. Shutdown stops and drains retries.
Library hosts can wire `reconcileLater: () => handlers.reconcileVoiceLater()`
and supply `voice.closeOrphan`; retry bounds are `voice.reconcileIntervalMs` and
`voice.reconcileBatchSize` (defaults 30,000 ms and 10).

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
runtime. `createOpenRouterReasoning` also requires a private `prices` map with
prompt/completion USD per token for every model it can bind. OpenRouter pins
routing with `require_parameters`, `allow_fallbacks: false` and the operator's
`max_price` ceiling; Mistral sends chat completions and JSON Schema directly.
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
whose later plugin slice is absent stay unavailable. The session's own preset
uses its stored choice; the other presets show their host defaults. The fixed
engine panel and deferred pointer updates keep controls stable.

Device is an explicit browser carve-out: text connects directly to an
OpenAI-compatible server at literal `localhost` or `127.0.0.1`, with a models
handshake, cancellation/deadlines, response limits, no redirects, credentials
or server proxy. The settings Advanced tab connects it, lists the handshake's
models and offers a test chat. The UI keeps device turns in this tab; reload discards them. The server
lanes refuse device work, and analysis, voice, transcription and images report
“unavailable on device”. Local export/persistence is not implemented in this
slice. Hosts pass `deviceConnector` (or a ready `deviceReasoning`) to `configure`
for that browser half; a visitor-connected model takes precedence.

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

## Processing settings (AIT-112)

The settings dialog (START `AiSettings`) has three tabs: **General** (new
conversation, consent position, recommended defaults), **AI model** (data processing
preset, model, response style, speaking and listening, visual concepts, six gauges,
a contextual help line, a providers disclosure and an acknowledged save state with
Try again) and **Advanced** (the local connector with START's setup and recovery
help). It is a native modal `<dialog>`: focus moves to Done and returns to its
opener, Escape closes menus first, and tabs, radios and listboxes support the
keyboard. Up to 40rem wide it fills the viewport. Every changing value sits in a
fixed box, so hover, saves and gauge updates never move a control. A conversation
starts with the preset chooser (START `LandingPresets`), covering the call and
concept rails until a choice is confirmed, and then a ready card
(START `ConversationReadiness`) until the first message. Custom opens the dialog.

Hosts list visitor choices per preset as `presets[p].choices = {models, voices,
visuals, defaults}`. A model option is `{id, label?, binding | bindings: {reaction,
understanding}, efforts?, effort?, quality?}`; voice options are `{id, label?, binding?}`
and visual options `{id, label?, kind?, binding?}`. One Visuals control governs both
visual kinds: `kind` is `images` (default) or `html`, and the selected option's kind
decides whether a concept is an image or an HTML click-dummy (legacy presets keep the
`bindings.visuals` rule below). An option without a binding is declared but not configured
and shows that reason. `efforts` lists the response styles the host permits; the
chosen effort replaces the binding's effort, and the manifest must support it.
`quality` is an optional public rating `{score, source: {name, url, asOf}}`.
Presets without `choices` keep working: their single bindings form one implicit
`default` option per lane. Invalid choices fail at runtime creation. On my device is
offered unless the host sets `presets.device = false`.

The browser only ever sends option ids. `POST /settings` checks the request shape,
the preset's allowlist, the effort list and every static admission rule (plugin,
manifest operation and effort, evidence, residency and endpoint policy) on each lane
the choice runs, reaction and understanding alike, and refuses
anything else with `409 {error: 'setting-not-allowed', field, reason}`; a crafted
binding or unknown key returns 400. Dynamic refusals (consent, pause, health,
budget) do not block saving: the choice is stored and admission keeps refusing
dispatch until they clear. The acknowledgement reports `consent.required` with the
affected features; the dialog, chooser and ready card then emit `aithema-consent`.
Every save names the revision it was based on: a missing `baseRevision` returns 400
`base-revision-required`, and any base other than the stored revision (a stale write
or a replay) returns 409 `settings-conflict`; both carry the current choice and
revision. Resending the current choice on the current revision is idempotent. Session
creation runs the same static validation on the requested preset and its defaults,
so an unoffered preset is refused rather than created. Consent grants receive only
the scopes of operations the selected manifests support and the preset admits.
A conversation keeps at most 1000 choices.

Every admission takes its binding from the stored choice: reaction and understanding
use the model option with the chosen effort, live voice uses the voice option,
concept images use the visuals option, and `off` makes the feature unavailable.
Assistant turns and exports name the model and response style that produced them.
Each concept records the visuals option that produced it and is read and exported
only while that option is still admitted, so switching visuals off stops new renders
without hiding earlier ones. A changed choice supersedes in-flight lane work exactly
like new input and reruns unanswered input with the new binding; completed replies
and understanding stay cached. A visuals change also supersedes a running concept
render. While a voice call runs, changes return `voice-call-active` and the dialog
offers **End call and apply**; a call started under an older choice is never
recovered under a newer one.

Settings are durable per conversation (`settings.changed` events and the snapshot).
Creation pins concrete defaults, so later host default changes never mix into a
running conversation. A new conversation for the same owner offers the owner's last
confirmed choice while the host still offers it. A choice is erasable content: the
journal keeps only a reference, and erasure tombstones it, resets the snapshot choice
and drops reply engine labels with their replies, so an erased conversation no longer
supplies it. A started conversation (even with every turn withdrawn) cannot switch
into or out of On my device in place (`new-conversation-required`); the dialog offers
a separate conversation. Streaming reply fragments carry the settings revision they
started under; when a change supersedes a reply, the client clears its partial text
and ignores older fragments.

The six gauges (AI quality, speed, cost, privacy, voice, images) come from core
`settingsGauges` over the catalog's public facts: manifest qualification, efforts,
streaming, cost, processing locations, live-voice capabilities and image operations,
plus the host's public policy and whether a binding charges nothing. Unverified
manifests show **Unverified**; speed is a preference index from the response style,
not a measurement. The OpenRouter manifest now lists the efforts its adapter
forwards (`none`, `low`, `medium`, `high`, `xhigh`, `max`, as checked by START on
2026-09-13); which model supports which effort remains the host's allowlist decision.

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
PNG/JPEG fallback is identified from the returned bytes. PNG/WebP/JPEG dimensions
come from the image headers. The response is bounded at 18 MiB and each image,
including provider metadata, at 12 MiB. A URL response is downloaded inside
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

Image artifacts keep the provider-returned PNG/JPEG/WebP bytes byte-identical
through storage, serving, downloads and ZIP export. Aithema never injects or
replaces XMP/IPTC metadata or changes WebP header flags. Our IPTC-equivalent
Digital Source Type (`trainedAlgorithmicMedia` / `ai-generated` for generation,
`compositeWithTrainedAlgorithmicMedia` / `ai-manipulated` for refinement),
provider/model, SHA-256 prompt digest, generation time and original-byte
Content-Digest live in the provenance sidecar and each image entry's
`provenance` in `concepts-manifest.json`. The refinement rule applies both to
`generate` with previous/rejected/upload references and explicit `edit`.
Image GETs provide `Content-Digest`, truthful `Content-Type`, `x-aithema-origin`
and an owner-authenticated provenance sidecar.

Credential presence is detected structurally from PNG `caBX` chunks, JPEG
APP11 JUMBF segments with the exact `c2pa` description label (including
numbered continuations), and WebP `C2PA` chunks. Sidecars record
`credentials: {c2pa: "present"|"absent", manifestByteLength, verification:
"not-verified"}`; the byte length excludes image chunk/segment framing and
repeated JPEG superbox headers. **Present means present (not verified)**:
Aithema does not validate signatures, certificates, assertions or trust chains;
`assurances.digitallySigned: false` makes no verified-signature claim.
OpenAI's watermark status is `provider-declared`, with a source note for its
[SynthID declaration](https://help.openai.com/en/articles/8912793); no local
watermark detection is claimed. Fake/local images retain their provider
identity and disclosure, report C2PA `absent`, and use watermark `unknown`.

Existing stored images with embedded XMP and legacy provenance remain readable,
downloadable, exportable and usable as edit references without changing their
bytes. This cannot repair any upstream signature invalidated by earlier
metadata injection. A future re-signing path could record the original OpenAI
image as a C2PA ingredient and sign the derived image; signing and new native
dependencies are outside this change.

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
upload/turn with the same ID. Document upload routes ship in AIT-100 B1 and
their attachment UI in B2 (below). Image upload references remain a host port.

Document uploads use `POST /api/sessions/:id/uploads` with `multipart/form-data`:
one `clientEventId`, optional `inputRevision`, and `file` or repeated `files`.
The same cookie/header ownership port as turns runs before body parsing and
receipt lookup. A new upload returns HTTP 202 with
`{accepted:true, uploads:[...], events:[...], replayed:false, limits}`; retries
return HTTP 200 and the current states with the original upload IDs. Receipts
bind exact file bytes, names, order and the explicitly supplied revision;
multipart boundary changes and client MIME labels do not change that identity.
Different content under the same ID conflicts (409). Unauthorized or erased
sessions return 404, invalid forms 400, oversized requests/files or session
capacity 413, and unavailable upload processing 403 with a `reason`.

`upload.state` is durable/SSE: `{id,state,at,contentRef,hash,...}` with hydrated
metadata (`filename`, sniffed `mediaType`, source `bytes`, `deadlineAt`) while
pending; accepted states add `text`, `truncated`, `extractor`; unreadable states
carry `reason` (`unsupported`, `empty`, `malformed`, `encrypted`, `limit`,
`deadline`, `cancelled`, `unavailable`). GET `/api/sessions/:id/uploads` returns
`{uploads,limits}`; the session snapshot includes the same upload states.
Withdraw with DELETE `/api/sessions/:id/uploads/:uploadId` or POST
`/api/sessions/:id/uploads/:uploadId/withdraw`. The acknowledgement contains
`{withdrawn:uploadId,event,providerDeletion:'not-confirmed'}`. Withdrawn states
retain the ID and tombstone flags. Replay keeps the original transition with
`erased:true,withdrawn:true` and the ID only when its content is gone; consumers
must treat those flags as a tombstone. No original-byte download route exists.

In `<aithema-session>` (B2), Attach opens the native picker (multiple files), and
files dropped on the conversation upload the same way. Before sending, the client
names refused types, oversized files and an overfull conversation in plain words,
using the limits the route reports; files that fit are packed into requests under
the per-request ceilings. The request size counts the multipart body byte for byte
(clientEventId, each part's headers with the escaped UTF-8 filename and type, and
a boundary of the 70-character maximum); a host request limit too small for any
file says so instead of showing a size. When the `uploads` verdict is unavailable,
Attach stays focusable and says the server's reason. Each upload is a fixed-width
transcript line keyed by its ID with its name (as text, one line), size and state
in reserved slots, so no state change or withdrawal moves or resizes it; Withdraw
upload uses the POST route. Upload, limit and withdraw requests pass the same-origin guard of the
concept view and carry the owner header or cookie. Extracted text never renders.

The demo registers the local text, PDF and OOXML plugins by default. Other
hosts register them in `PluginRegistry`, allow their IDs in the preset's
`plugins`, and supply `extractors:[{plugin:'extract-text'},
{plugin:'extract-pdf'},{plugin:'extract-ooxml'}]` (optional lowering-only parser
`limits` per binding). The `uploads` feature-matrix entry explains missing
extractors, policy/consent refusal, pause, device unavailability and health.
The runtime admits a single-use zero-cost extractor attempt with cancellation,
deadline and one terminal report; it has no implicit plugin fallback.

START defaults apply at the route: 20 MiB/file, 64 MiB/request, eight files per
request and session, and a 25-second batch budget. The added per-session source
byte ceiling defaults to 160 MiB (eight times START's file ceiling); pending and
unreadable uploads reserve capacity, withdrawal releases it. Hosts can lower
these ceilings through `createHandlers({uploads:{limits}})`. Part A's hard parser
ceilings remain stricter: 2 MiB input, 60,000 extracted characters, 100 pages,
10 seconds/parser, and the existing archive/heap/RSS caps. Larger admitted
documents become unreadable with `reason:'limit'`. Binary signatures and Office
structure plus the extension select media type; client MIME is ignored.

Original bytes are erasable SQLite content while pending and discarded after
extraction, matching START's document-original retention policy. Text/names
live in erasable records; journal, receipts and snapshots keep references.
Withdrawal/erasure deletes bytes and text, clears dependent replies,
understanding and concepts, cancels/reaps running extraction, and rejects late
publication. Restart/replay/export hydrate missing or withdrawn content as
tombstones. `uploads.json` in the ZIP contains accepted full extracted text and
metadata, unreadable metadata/reason, and withdrawn/erased IDs only. Original
document bytes are excluded. START's current conversation ZIP omits uploads;
including their extracted text here is the explicit AIT-100 export requirement.

START's existing `models-international` item explicitly covers “text read from
uploaded files”; its exact text is already in `demo/processing-consent.js` and
is reused. Uploads require current `file-text` coverage on every configured
selected reasoning lane; a scope without that category disables them. The
deterministic local demo uses its existing mock grant. No legal text was added.
Provider dispatch rechecks coverage, including after a settings change.
Accepted text joins reaction/understanding at user-message authority as escaped
UNTRUSTED data, with a 16,000-character total framing-inclusive budget and a
12,000-character per-file cap; newest then relevant documents lead and clipping
is marked. Upload state advances `inputRevision`, including document-only
understanding. Person-turn evidence and HTML `visitorWords` stay person words;
image concept prompts have a separate bounded document section, as START does.

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
identifies `codex-imagegen`, the bound model, prompt digest, generation time and
byte digest through the sidecar and export manifest. Local output reports C2PA
credentials `absent` and watermark status `unknown`. Health checks executable
and account-directory availability and startup compatibility without
authenticating or rendering. All tests use a fake
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

## HTML click-dummies (AIT-113 part A(b))

The `ui-generation` kind also produces **html artifacts**: one self-contained,
clickable click-dummy document. A plugin declares `text/html` in its model
`formats`. The artifact is `{bytes, mediaType: 'text/html', promptDigest,
provenance}` with exactly these keys. `bytes` is UTF-8 and at most 512 KiB
(`MAX_HTML_BYTES`). `provenance` has the image record's shape with `modality:
'html'` and a `text/html` subject digest. The core exports `inspectHTML(bytes)`,
`isHTMLArtifact`, `verifyHTMLArtifact` (shape, policy and SHA-256 digest) and
`HTML_PREVIEW_CSP`. Types are in [`ui-html.d.ts`](packages/core/src/ui-html.d.ts).
`isUIArtifact` stays image-only.

The continuous concept lane accepts a preset's `bindings.html` as well as
`bindings.images`. HTML is primary when both are present; `bindings.visuals =
'html' | 'images'` explicitly selects one. An unavailable HTML binding never
silently falls back to a different processor. Both kinds use the existing
person opt-in, spending intent, milestones, input revisions and cancellation
rules. HTML refreshes call `edit(previousArtifact, spec, feedback)` with the
current summary, constraint slot values, open questions, active person words
and session language. HTML bytes, media type, digest and provenance live in the
same erasable artifact store; source withdrawal, consent withdrawal and full
erasure remove the dependent content and feedback.

The B2 viewer can use these owner-authenticated routes (session cookie or
`x-aithema-session-token`; every response is `no-store`):

| Route | Payload / result |
| --- | --- |
| `GET /api/sessions/:id` | `conceptVisualKind`, `concepts`, `conceptStatus`, `conceptCost`, `featureMatrix.best.html` |
| `GET /api/sessions/:id/concepts` | `{items, intent, status, visualKind, cost}`; metadata only, with `mediaType`, `operation`, `provenance`, source IDs and feedback on each item |
| `POST /api/sessions/:id/concepts` | `{clientEventId, intent:true, sourceTurnId}` records person opt-in; returns `{accepted:true, event, replayed}`, normally HTTP 202 |
| `GET /api/sessions/:id/concepts/:artifactId/html` | UTF-8 bytes as `application/octet-stream`, `nosniff`, attachment; load as data into `<aithema-html-preview>`, never navigate to this route |
| `GET /api/sessions/:id/concepts/:artifactId/provenance` | Provenance JSON |
| `POST /api/sessions/:id/concepts/:artifactId/feedback` | `{clientEventId, vote:'up'|'down'|'clear', chips:[...]}`; does not generate |
| `POST /api/sessions/:id/concepts/:artifactId/reject` | `{clientEventId}` archives the draft; does not generate |
| `POST /api/sessions/:id/concepts/:artifactId/regenerate` | `{clientEventId, intent:true, sourceTurnId}` requests an admitted edit |
| `GET /api/sessions/:id/events` | Existing SSE `concept.state` events: `data.status.phase` is `waiting`, `pending`, `ready` or `failed`; `data.artifact` appears on completion |
| `GET /api/sessions/:id/export` | ZIP with `concepts/:artifactId.html` and its original `.provenance.json` |

Exports use the core `frameDocument` wrapper: the preview CSP precedes all draft
content. A second CSP disables scripts in downloaded files. The download does
not have the preview's opaque-origin frame and host navigation gate, so a
standalone copy is deliberately a passive document. Network requests and form
submission are blocked; permitted links stay within the document. The provenance
digest describes the original stored artifact, before the export wrapper;
`manifest.json` records both the original and wrapped export-byte digests.

`AITHEMA_HTML_MODE` defaults to `fake`, a deterministic local clickable HTML
generator with escaped summary and open questions. `off` removes its binding. On a
live host (`AITHEMA_PROVIDER` set) it defaults to `off`; an explicit `fake` is offered
only as a visuals option labelled as a demo.
`claude` uses `AITHEMA_HTML_MODEL` (default `anthropic/claude-opus-5.5`), requires
positive operator prices, and injects the same persistent SQLite account spend
port used by reaction, understanding and delegated voice reasoning. There is no
second file counter. HTML sends START's `provider.only`, analysis `ignore`,
`require_parameters`, `allow_fallbacks:false` and decimal-exact `max_price`;
the output ceiling is 8,000 tokens, with reasoning disabled.

START has no separate HTML consent item. The demo reuses its verbatim
`models-international` item only when the Anthropic processor, account, secret
reference, actual endpoint and complete provider routing match an existing
reasoning binding. Otherwise HTML stays unavailable with `HTML consent scope
unavailable: START has no matching HTML item` until an authoritative scope covers
it. Generate and edit have separate exact processing scopes, checked again at
claim consumption and publication. A host with its own matching consent item
can provide a qualified HTML binding and the existing consent port.

All UI render attempts share persistent lifetime-session and deployment UTC-day
limits, default 20 and 200. Counts are recorded atomically at claim consumption;
failed or crashed attempts remain counted. Reads, feedback and exports do not
count. Refusals return HTTP 429 with a clear `reason`, also recorded in failed
concept status for automatic refreshes. The session count survives erasure and
restart; the daily count resets at UTC midnight.

`inspectHTML` returns stable problem codes. It accepts exactly one document:
`<!doctype html>` first, one `html`/`head`/`body`, `</html>` last, valid UTF-8 and
no control characters. It rejects:

- absolute URLs anywhere (XML namespace names excepted);
- `href` values that do not start with `#`;
- `src`/`poster` values other than `data:image/`, and any script `src`;
- fetching attributes such as `srcset` or `ping`;
- CSS `@import` and `url()` values other than `data:` or `#`;
- `<base>`, `<link>`, frames, `object`/`embed` and `http-equiv`;
- form `action`, `formaction` and POST forms;
- module scripts;
- script network, storage and navigation APIs, and the usual obfuscation
  primitives.

`uiGenerationConformance` now accepts only artifact media types that the manifest
declares. It verifies html results with `verifyHTMLArtifact`, so a fixture whose
document references the network fails.

The static policy is defense in depth. It describes output a well-behaved model
writes, and it can be bypassed by obfuscation. The enforcement boundary is the
preview below. Never serve the bytes as a page from the host origin; render them
only through `<aithema-html-preview>`.

### `<aithema-html-preview>`

`import '@inspr/aithema-ui/html-preview'` defines a standalone element. Set
`element.artifact = {bytes, mediaType}` (extra fields are ignored; `null` clears
it). Optionally set `element.copy` (`label`, `title`, `width`, `wide`, `phone`,
`empty`, `invalid`, `policy`). Before rendering, the embedding document must
declare `<meta http-equiv="Content-Security-Policy" content="frame-src 'none';
child-src 'none'">` in its head. Also send that policy in the HTML response's
`Content-Security-Policy` header (the demo does both). `srcdoc` is not fetched;
HTTP(S) and other fetched frame destinations are denied. The element:

- re-runs `inspectHTML`; it shows `invalid` in place instead of rendering
  failing bytes;
- verifies the host's declared policy with an inert sandboxed `srcdoc` probe
  that navigates itself to a scriptless `data:` document. No socket is used.
  It requires a trusted, enforced `securitypolicyviolation` event from the
  host's `frame-src`/`child-src` policy with both directives set to `'none'`.
  Report-only, weaker and synthetic events do not qualify. Until verification
  succeeds, or if it times out, it shows a visible `policy` reason and renders
  no draft. A proof is cached per document; the declaration is checked again
  on every render;
- renders the document only in a fresh `<iframe sandbox="allow-scripts">`. There
  is no `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-modals` or
  `allow-top-navigation`, so the draft runs in an opaque origin;
- builds the `srcdoc` as `<!doctype html>`, then a CSP meta (`default-src 'none';
  style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src
  data:; form-action 'none'; base-uri 'none'`), then the draft without its own
  doctype. The page stays in standards mode, and the policy applies before any
  draft content;
- sets `referrerpolicy="no-referrer"` and an `allow` list that turns off powerful
  features;
- shows a visible **Draft — generated** label. It reserves a fixed stage height
  (`--aithema-preview-height`, default `min(48rem, 80svh)`). A Wide/Phone switch
  (arrow keys) changes only the frame's width (`--aithema-preview-phone`, default
  390 px). Nothing around it moves, and switching never reloads the draft;
- keeps keyboard focus in the preview when a new draft replaces the one being
  used. Clearing or rejecting a focused draft restores focus to the selected
  width control. Tab moves from the switch into the draft;
- exposes `state` (`empty`, `ready`, `invalid`, `policy`).

`npm run test:browser` also runs `test/browser/html-preview.test.js` in real
Chrome. A hostile draft that passes the static policy through string splitting
proves the following:

- its origin is `null`;
- reading the parent DOM, `document.cookie` and `localStorage` throws
  `SecurityError`;
- `fetch` fails and an image beacon is blocked;
- `window.open` returns `null`;
- form submission and top navigation make **no** request.

The test then drives the sample click-dummy (`test/fixtures/click-dummy.html`) by
pointer and keyboard. It checks standards mode, the one-column phone layout and
a stage that does not move. Set `AITHEMA_EVIDENCE_DIR` to keep screenshots
(wide/phone, light/dark).

The browser fixture also attempts self-navigation in an immediate inline script
(before the first load) and after load. Both target local HTML pages whose
scripts beacon back. It requires enforced host-CSP violations and **zero**
navigation requests and destination-script requests. The old second-load
heuristic has been removed: it runs too late to contain a scripted destination.
Entity-encoded executable attributes are rejected by the static validator.
These are browser assertions, not evidence from happy-dom; a blocked Chrome
launch means this validation is unavailable, never passed.

### Claude via OpenRouter

`createClaudeHTML({binding, spendPath | spend, capMicro, resolveSecret,
fetchImpl, baseUrl})` comes from `@inspr/aithema-plugin-claude-html` (private
workspace, server placement, manifest model `*` with `text/html`). The private
binding must name plugin `claude-html` and an `anthropic/claude-*` model. The
operator chooses the model; `DEFAULT_MODEL` is `anthropic/claude-opus-5.5`. A
binding is required; there are no default rates. `binding.rates.inputUSD` and
`outputUSD` must be explicit positive USD prices **per token**, alongside the
existing generic `inputMicro`/`outputMicro` fields. The
endpoint is the API base (`https://openrouter.ai/api/v1`), and `baseUrl` must
match it. HTTP is loopback-only. `binding.secretRef` is resolved per call on the
server. It is never logged, put in an artifact or sent to the browser.

Each call posts one non-streaming chat completion to `/chat/completions`, with
`usage: {include: true}`, `max_tokens = binding.maxTokens`, and no provider
fallbacks. Only `effort: 'none'` is admitted, and every request explicitly sends
`reasoning: {enabled: false}` to disable thinking. Every request also sends
`provider.max_price: {prompt: inputUSD * 1_000_000, completion: outputUSD *
1_000_000}` in USD **per million tokens**, overriding any routing price ceiling.
**UNVERIFIED API SHAPE:** `provider.max_price` and `reasoning.enabled` were not
verified against the live API in this fix round, which forbids network calls.
The request carries:

- a fixed system prompt. It holds the quality bar (no layout shift, text space,
  light/dark/phone, keyboard, the GUI-27 antipatterns, plain words in one
  language) and the sandbox rules. It forbids inventing metrics, testimonials,
  prices or capabilities, and asks the model to show open questions instead of
  deciding them;
- a user message with the host brief (`spec.prompt`, trusted). The visitor data
  (`spec.understanding {summary, slots, openQuestions}`, `spec.visitorWords`,
  `feedback`) goes in as escaped JSON marked untrusted. For `edit`, the previous
  dummy is included.

`spec.language` sets the page language. The revision number comes from the
previous dummy's head comment (`spec.revision` overrides it). Every dummy carries
a head comment, a "Revision N" note and a sample-data disclosure. `edit`
requires feedback and a verified previous html artifact. `references` are not
supported. Inputs are bounded (brief 32,000, words 60,000, feedback 8,000
characters) before any spend.

The plugin extracts one document from the model text, then repairs it. Repairs
only *remove* capability: fences and prose, `<link>`, `http-equiv`, `@import`,
and external anchors (rewritten to `#`). It then embeds an `aithema-provenance`
comment after the doctype and re-runs `inspectHTML`. Anything still unsafe,
truncated (`finish_reason` other than `stop`) or larger than 512 KiB is rejected
as `invalid-output`/`limit`. Known usage and cost stay charged.

The invocation contract matches the other plugins:

- the claim is consumed before dispatch;
- exactly one terminal report is made;
- preflight cancellation or deadline settles at zero;
- a dispatched call without usage reports `uncertain`;
- a host-ignored transport is still released by the operation lifetime.

**Spend cap.** Before dispatch the plugin computes a conservative ceiling:
UTF-8 byte length of the full serialized request messages (at most one input
token per byte) times `inputUSD`, plus `maxTokens` times `outputUSD`. Decimal
arithmetic rounds each contribution up to micro-dollars. `max_tokens` is always
sent and reasoning is disabled. If the ceiling exceeds the admitted `maxMicro`,
or spent plus reservations plus the ceiling exceeds `capMicro` (default USD 10),
the call **hard-stops with `limit` before dispatch**.

`usage.cost` (USD credits) replaces the reservation with the real cost. A cost
above the reserved ceiling is recorded, the result is rejected and `health()`
reports `{available: false, reason: 'cost ceiling breached'}`; the default file
persists that refusal across restarts. Unknown dispatched cost, including
401/402/403/429 responses, cancellation, deadlines and 5xx, keeps the full
computed ceiling charged. Only provably unsent requests may release it. A crash
leaves open reservations counted.

The default `createSpendLedger({path, capMicro})` is a JSON counter. Each
transaction uses an `O_EXCL` lock containing the owner PID; a live, unknown or
malformed owner fails closed. Only a provably dead PID permits stale-lock
recovery, with an exclusive recovery guard preventing competing takeovers.
Writes synchronize the temporary file before rename, then the committed file
and its directory after rename. An unreadable/locked counter or failed
settlement closes the plugin.
Reset the cap only by deliberately replacing the counter's stored state.

For AIT-115/part B, inject `spend: {reserve(ceilingMicro), settle(handle,
actualMicro), snapshot()}`. Methods may be asynchronous and handles are opaque.
`snapshot()` returns safe nonnegative `spentMicro` and `reservedMicro` integers;
it may also return a persisted `costCeilingBreached` flag. `reserve` must
atomically enforce the same shared USD cap across all lanes and processes.
The plugin's snapshot check alone does not provide interprocess admission.

Tests use only a local fake OpenRouter server: request shape, repair, rejection,
cap exhaustion and persistence, concurrency, cancellation, deadlines, refusal
and the reusable conformance kit.

### Wiring for part B

Hosts still need to do the following:

- register `createClaudeHTML` with a `spendPath` under the deployment's data
  directory, and bind it in `presets[preset].bindings.images` (or a dedicated
  lane) with required per-token USD rates and `maxMicro`/`maxTokens` sized for
  the byte-based ceiling; part B can inject the shared AIT-115 spend counter;
- build `spec` from the session's understanding, visitor turns and language;
- persist html artifacts like image artifacts (bytes as erasable content plus
  `mediaType`, `promptDigest` and provenance), using `verifyHTMLArtifact` before
  publication;
- serve the bytes to the owner only as data (`application/octet-stream` or JSON,
  `no-store`), never as `text/html` from the host origin;
- declare the required host CSP in the HTML head and response header, then
  render them with `<aithema-html-preview>` after its runtime policy probe.

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
| `src/lib/providers/openai-image.ts`, `src/lib/provenance.ts` | `plugins/openai-images/src/` | server Images generate/edit with lifetime/claim contract, bounded private bytes, byte-preserving IPTC-equivalent sidecars and digest metadata; no branding or legal/account facts |
| `src/scripts/{concept-viewer,concept-backdrop}.ts`, `src/lib/{generated-ui-view,generated-ui-progress,generated-ui-idle}.ts`, `src/pages/index.astro` (concepts) | `packages/ui/src/{concept-view,session-element,styles}.js` | one immersive viewer, preview, fixed controls, estimated countdown, feedback and cost copy; no START branding |
| `src/pages/api/v2/generated-ui/index.ts` | `packages/core/src/concept-lane.js`, `packages/server/src/{concept-handlers,image-binding,local-images,storage}.js` | durable intent/progress, private-byte references, exact image scopes, conservative private costs, byte history and erasure |
| `tests/generated-ui.test.ts` | `packages/core/test/concept-intent.test.js`, `plugins/openai-images/test/openai-images.test.js` | selected spending, slow-render, removal/withdrawal and private image transport cases with fakes |
| `src/components/AiSettings.astro`, `src/scripts/{ai-settings,settings-controls}.ts`, `src/styles/{ai-settings,settings-compact}.css` | `packages/ui/src/{settings-dialog,settings-styles}.js` | tabbed dialog, processing radios, listbox selects, response-style slider, six liquid gauges, fixed help line, autosave with acknowledgement and retry, Done/Continue; native modal, host tokens and copy |
| `src/lib/{engine-settings,engine-runtime}.ts`, `src/pages/api/v2/engine.ts` | `packages/core/src/settings.js`, `packages/server/src/{plugin-runtime,handlers,storage}.js` | id-only selections against a host allowlist, static refusals vs dynamic admission, effort preference, durable revisions, busy-call refusal, uncovered choices saved and gated by consent |
| `src/components/LandingPresets.astro`, `src/scripts/landing-presets.ts`, `src/styles/landing-presets.css` | `packages/ui/src/session-element.js` | in-component preset chooser with measured summary and Custom-opens-settings; acknowledged confirmation instead of navigation |
| `src/components/ConversationReadiness.astro`, `src/content/conversation-readiness.ts` | `packages/ui/src/session-element.js` | ready card rows for model, consent, microphone, voice output and visual concepts |
| `src/pages/local.astro`, `src/scripts/local.ts`, `src/lib/local-openai.ts` | `packages/ui/src/local-connector.js`, `plugins/device/src/index.js` | Advanced tab: handshake, model choice, test chat, quick and detailed setup, error-specific recovery; no API key, cookies or iframe |
| `src/lib/i18n.ts` (settings, landing, local and help copy) | `packages/ui/src/i18n/en.js` | English-only host copy without START branding or offer wording |
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
OPS pins the base image digest at build time with
`--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<approved-digest>`.
The image runs as `node`, binds port 3000 and uses its `/data` volume for SQLite.
App files and installed dependencies belong to root and have no write bits.
Run the container with `--read-only` and a writable `/data` volume, so only
`/data` is writable by the runtime user.
Mount `/data` writable by that user, preserve the SQLite database plus WAL on
restart, and run exactly one writer. Set `AITHEMA_COMMIT` to the deployed full
source SHA. The container healthcheck uses `node:http` to supply the configured
public Host while connecting over local HTTP. This keeps the Host gate active
even for loopback callers and avoids relying on `fetch` to override Host.
Readiness of voice is separately visible in
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
| `OPENROUTER_MODEL` | Required understanding model id when `AITHEMA_PROVIDER=openrouter`; no default; only START-consented OpenAI, Anthropic or xAI providers are admitted |
| `OPENROUTER_SPEECH_MODEL` | Reaction model for spoken and typed replies and the voice facade; defaults to `OPENROUTER_MODEL`; capped by `OPENROUTER_MAX_TOKENS`; choose for the seven-second platform timeout |
| `OPENROUTER_MAX_TOKENS` | Reply token ceiling for reaction/speech; default `1200`; used in the per-request spend ceiling |
| `OPENROUTER_ANALYSIS_MAX_TOKENS` | Understanding token ceiling; default `8000`; START found lower values truncated real analyses; used in the per-request spend ceiling |
| `OPENROUTER_PROVIDER_ONLY` | Comma-separated upstream allow-list sent as `provider.only` on every request; unset means no restriction; part of the legal profile; must mirror START exactly |
| `OPENROUTER_ANALYSIS_PROVIDER_IGNORE` | Comma-separated upstream exclusions sent as `provider.ignore` on understanding/analysis and HTML; default `Azure`, whose START workspace rejects `response_format` despite advertised support |
| `AITHEMA_OPENROUTER_PRICES` | Required JSON for every configured model: `{"<model>":{"prompt":<USD per token>,"completion":<USD per token>}}`; finite nonnegative prices; no catalog defaults |
| `AITHEMA_OPENROUTER_CAP_USD` | Lifetime persisted account cap; decimal USD with up to six fractional digits, default `10` |
| `AITHEMA_VOICE_MODE` | `elevenlabs` enables startup ensure; default `fake` locally and `off` on a live host, where `fake` is refused; `off` disables voice |
| `AITHEMA_VOICE_CAP_MINUTES` | Optional deployment lifetime voice-minute budget in `AITHEMA_DB`; nonnegative decimal minutes (up to six fractional digits); unset means no aggregate total cap; `0` refuses new calls |
| `AITHEMA_VOICE_CAP_MINUTES_PER_DAY` | Optional deployment voice-minute budget per UTC admission day in `AITHEMA_DB`; same decimal format; unset means no aggregate daily cap; OPS sets this and the total cap for start2 |
| `ELEVENLABS_API_KEY` | ElevenLabs account key; reference resolves server-side only |
| `AITHEMA_ELEVENLABS_TEMPLATE_AGENT_ID` | START agent to GET for selected voice/language/ASR/turn/privacy settings; never a write target |
| `AITHEMA_VOICE_FACADE_SECRET` | Deployment callback bearer supplied by OPS; startup creates/updates its owned workspace-secret reference |
| `AITHEMA_IMAGE_MODE` | Default `fake` locally and `off` on a live host, where `fake` is refused; `openai` requires a separate host module |
| `AITHEMA_HTML_MODE` | `fake` (local default) generates local clickable HTML, offered on a live host only when set explicitly and labelled as a demo; `claude` uses the shared SQLite OpenRouter cap and requires current matching consent; `off` (live default) disables HTML |
| `AITHEMA_HTML_MODEL` | `anthropic/claude-opus-5.5` (default); Claude model ID required in `AITHEMA_OPENROUTER_PRICES`; output capped at 8,000 tokens |
| `AITHEMA_UI_RENDERS_PER_SESSION` | Persistent lifetime limit shared by HTML and images; default `20`; `0` disables generation |
| `AITHEMA_UI_RENDERS_PER_DAY` | Persistent deployment-wide UTC-day limit shared by HTML and images; default `200`; `0` disables generation |
| `AITHEMA_UPLOAD_MAX_BYTES` | Document route file ceiling; default `20971520` (20 MiB), lowering only; parser input remains capped at 2 MiB |
| `AITHEMA_UPLOAD_MAX_REQUEST_BYTES` | Multipart streaming body ceiling; default `67108864` (64 MiB), lowering only |
| `AITHEMA_UPLOAD_MAX_FILES` | Active document count per session, including pending/unreadable; default `8`, lowering only |
| `AITHEMA_UPLOAD_MAX_SESSION_BYTES` | Active source-byte count per session; default `167772160` (160 MiB), lowering only; withdrawal releases capacity |
| `AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS_PER_SESSION` | Concurrent upload requests per session; default `2`, lowering only; excess requests receive `429` before their bodies are read |
| `AITHEMA_UPLOAD_MAX_CONCURRENT_REQUESTS` | Concurrent upload requests across the deployment's server process, shared by handler instances; default `4`, lowering only; excess requests receive `429` before parsing |
| `AITHEMA_VOICE_HOST_MODULE` | Optional server-only host override; unset selects built-in start2 host |

Multipart admission permits at most the configured file count plus two scalar
parts, with an 8 KiB header ceiling per part, before calling the native parser.
Only headers with empty payloads enter `formData()`; file content is a view of
the buffered request. Declared-length bodies use one buffer; undeclared bodies
use Node 24's resizable backing store to avoid repeated full-body copies and
final concatenation. Single-chunk bodies need no buffering copy.
Upload expiry withdraws and cancels only the expired upload; newer pending
uploads in that session and work in other sessions continue processing.

Production requires no `ELEVENLABS_AGENT_ID`: the owned agent id comes from ensure
and is cached in `AITHEMA_DB`. An existing same-name foreign agent or multiple
exact-name matches disables voice with a value-free reason. Only a creation
receipt persisted in this database authorizes updates. Losing the ownership
cache never authorizes taking over an existing agent/secret; restore the database
or let the operator resolve the conflict. Secrets are not cached in SQLite.
If a workspace-secret POST succeeds remotely but its response has no valid
`secret_id`, startup reports `secret-create-invalid`; later starts report
`secret-ownership-unproven`. This conflict is sticky because the host cannot
prove ownership from the remote name. The value-free log names only
`aithema-start2-facade`. OPS stops the host, preserves the database/WAL, and uses
its secret-aware tooling to inspect only secret names, ids and `used_by`.
After confirming there is no local creation receipt and that the remote secret
is an unused orphan, delete the orphan secret named **`aithema-start2-facade`**
by its id, then restart. The host creates a new secret and persists its receipt.
If the secret is in use or ownership is uncertain, restore the proven receipt
from backup or resolve that ownership first; do not delete an active secret.
Template prompts, personas, first messages, knowledge bases and tools are excluded.
The host's custom LLM has an empty prompt and no tools or knowledge base;
Aithema rebuilds the trusted session prompt at each callback. Its greeting is
Aithema's own fixed spoken AI notice (see "AI notice" above), never START's, and
its language presets are cleared. The agent allows only a per-conversation
`language` override; `first_message` is explicitly disabled
(`platform_settings.overrides.conversation_config_override.agent`, the shape
verified on START's agent by read-only GET 2026-10-09).
After every agent create or PATCH, startup GETs the owned agent and verifies
its name/id, auth enabled, exactly one allowlist hostname equal to the public
origin's host (including any port), the extra-body override, explicit
conversation override flags (`agent.language` exactly `true`,
`agent.first_message` exactly `false`, every other flag exactly `false`; an
omitted, null or string flag disables voice), a first message equal to the
notice, `language_presets` exactly `{}` (omitted or null disables voice),
`custom-llm` selection, callback URL, owned secret id and every copied
privacy field.
Any mismatch disables voice with `agent-readback-mismatch`; logs contain only
the owned name/id and failing field names. A failed GET also disables voice.

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
provides the port `{reserve(ceilingMicro) → handle, settle(handle, actualMicro),
snapshot()}`. A second plugin can inject the same port, or share account
`start2-openrouter` and the same database. `snapshot()` returns
`{spentMicro, reservedMicro, capMicro, breached}`. Reservations and settlements
run under SQLite transactions. Every OpenRouter request sends the binding's
`max_tokens` (default 1200 for reaction, 8000 for understanding),
`provider.require_parameters: true`, and `provider.max_price` derived from the
operator's prices using exact decimal arithmetic before JSON number conversion.
Configured upstream allow-lists apply to both lanes; the
analysis exclusion applies only to understanding. **verified live 2026-10-09**:
those routing prices are in USD per MILLION tokens and OpenRouter enforces them
before dispatch (404, "No endpoints found that satisfy the max price").
`reasoning: {enabled:false}` is accepted and sent when effort is `none`.

The request ceiling is the UTF-8 byte length of the complete serialized messages
array, including the system message, multiplied by the configured prompt price,
plus `max_tokens` multiplied by the completion price. Decimal arithmetic rounds
that sum upward to microdollars. The port reserves this ceiling (with a minimum
one-microdollar hold for free prices), refusing before dispatch when
`spent + reserved + ceiling > cap`. The existing per-binding USD 1 lane maximum
also refuses oversized requests. `AITHEMA_OPENROUTER_RESERVE_USD` is removed.

Every request asks for `usage.include`; final streaming or non-streaming
`usage.cost` settles its hold in upward-rounded microdollars. Known cost remains
billable even if structured output is invalid or the HTTP status is an error.
Missing usage, cancellation, incomplete streams and process death retain the
whole hold across restart. No dispatched hold is released without `usage.cost`.
An actual cost above its ceiling is recorded in full and permanently marks the
account breached, refusing all further calls, even if the account cap still has
room. Streaming stops as soon as it reports such an overrun. For example,
USD 9.50 spent plus a USD 1.00 ceiling refuses before dispatch; an unexpected
USD 1.00 charge after a smaller admitted ceiling records USD 10.50 and locks the
account. Raising the cap does not reset the counter or clear a ceiling breach.
Do not remove uncertain holds merely to make another request fit.
**The cap drains through uncertain holds by design**, including barge-in,
aborted voice streams and crashes; restart does not replenish that budget.

OPS reconciliation of uncertain holds:

1. Stop the sole writer and back up SQLite plus WAL. List unsettled
   `spend_reservations` for `start2-openrouter` (`actual_micro IS NULL`), keeping
   their ids and ceilings intact.
2. If the provider response carried a generation id retained in OPS request
   records, use authenticated OpenRouter generation lookup
   `GET /api/v1/generation?id=<generation-id>` through secret-aware tooling.
   Otherwise obtain the account's OpenRouter activity export. Match each billed
   generation unambiguously to its reservation using OPS request records; the
   host does not currently persist generation ids or that correlation itself.
   A missing export row or interrupted client stream is not proof of zero cost.
3. Once authoritative provider evidence proves the billed USD cost for that
   reservation, round it upward to microdollars and call the spend-cap port's
   `settle({id: <reservation-id>}, actualMicro)` for the same account/database.
   Keep the evidence reference in the OPS record. Record the full charge even
   above the original ceiling; this preserves the permanent breach latch.
   Do not delete reservations or reduce settled charges. If correlation or final
   cost remains uncertain, leave the full hold in place.
4. Check `snapshot()` totals against the evidence and confirm any ceiling breach
   still refuses admission, then restart the sole writer. Reconciliation is an
   OPS action; startup does not release dispatched holds automatically.

The following shapes are **verified by read-only GET 2026-10-09** in the
coordinator's AIT-115 comment: paginated agent list and ids/names; agent GET
`conversation_config` TTS/ASR/turn/language/custom-LLM fields and
`platform_settings` auth/privacy/overrides; `/v1/convai/secrets` with
`secrets[] {type, secret_id, name, used_by}`; conversation-details
`conversation_id` echo and `metadata.call_duration_secs/cost`. The conversation
cost is provider credits, not USD. `/v1/convai/workspace/secrets` returns 404.

**UNVERIFIED API SHAPE** remains on agent create/PATCH bodies and secret
write bodies: POST `/v1/convai/secrets`
`{type:'new', name, value}` and PATCH `/v1/convai/secrets/{secret_id}`
`{type:'update', name, value}`. The platform allowlist item `{hostname}` follows
ElevenLabs docs but was empty in the live GET. Local fakes exercise these write
contracts; the coordinator must verify them before enabling this deployment.

Coordinator live smoke, after its Claude approval gate:

1. Before service startup/writes, use OPS's secret-aware tooling for authenticated
   read-only GETs: `/v1/convai/agents?page_size=100` (follow `next_cursor`),
   `/v1/convai/agents/<template-id>`, `/v1/convai/secrets` and
   `/v1/convai/conversations/<existing-completed-id>`. Inspect only
   names/ids and the required field shapes. Confirm no ambiguous `aithema-start2`,
   confirm template voice/language/privacy and platform overrides, and confirm
   API documentation for create/PATCH and secret-id auth; GETs alone cannot prove
   write payloads. Also verify OpenRouter `provider.max_price` units against the
   configured per-token prices. Never print key, secret or full config bodies.
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
   **AI notice (AIT-119, unverified until this step):** in an English and a German
   conversation, verify live that the spoken greeting is the notice, word for
   word, before anything else is said; the agent GET shows the first-message
   override disabled and no language presets.
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
