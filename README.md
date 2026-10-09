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
handover to PAIMOS is planned. Ownership/authentication, consent enforcement,
pause, erasure and exclusive-writer safety belong to AIT-97. The demo is for localhost.

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
keeps the session id. Reload or restart the server to resume from
`.data/session.sqlite`; New conversation creates a separate session without
erasing the previous one. `PORT` and `AITHEMA_DB` override the port and database.
The demo accepts only loopback Host headers and JSON POSTs.

The demo stays on the mock even when provider environment variables exist.
`AITHEMA_PROVIDER=openrouter|mistral` explicitly selects a provider; `OPENROUTER_MODEL`
and `MISTRAL_MODEL` select its model. These demo bindings remain **unverified** and
cannot dispatch until a host supplies private qualification and current consent.
Keys resolve from `OPENROUTER_API_KEY` or `MISTRAL_API_KEY` only at runtime; they
never enter manifests, snapshots, UI or logs. Tests never use these environment keys.

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
| `demo/` | Labelled localhost host and its tests |
| `test/` | Shared JavaScript test helpers; package tests live beside each package |
| `tests/`, `scripts/check-dco.py` | DCO history tests and contribution checker |

The server exports `SQLiteStorage`, `createHandlers` and `exportSession`; its
`/http` export supplies `listen` and `httpAdapter`. Call handlers' `resume()` on
startup and `close()` before closing storage. A standalone mock server runs with
`node packages/server/bin/server.js`; set `AITHEMA_DB` for persistence.

Hosts configure the web component with `{copy, baseUrl, session}` and receive
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

## Plugins, bindings and admission

Kinds are `reasoning` (`stream`, `structured`), `stt` (`transcribe`, optional
`stream`), `tts` (`speak`), `live-voice` (`start` → session), `ui-generation`
(`generate`, `edit`), `extractor` (`extract`) and `exporter` (`export`). Only
reasoning is implemented here. Every operation takes `{signal, deadlineAt}`;
[plugin-contract.d.ts](packages/core/src/plugin-contract.d.ts) documents the later
ports, including independent voice input/output, acknowledged pause/resume,
turn ids, transcript policy and delegated/native reasoning.

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
countries within the EU and no training. Hosts implementing the consent port
provide `coverage(session, processingScope, {signal, deadlineAt})`; the result
must contain the exact requested `scope`, a current `checkedAt`, a future
`expiresAt`, and no withdrawal. Missing/unavailable coverage fails closed.
The deterministic non-billable mock has no external processing and is exempt
from external legal/consent qualification. AIT-97 owns the broader session
safety contract; its consent adapter should expose this coverage port.

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
A conservative UTF-8 prompt/framing token bound plus the selected output
limit must fit the binding ceiling before dispatch. Both server lanes reserve and claim in `SQLiteBudgetLedger` in the session's
SQLite database; no internal provider retry exists. Each invocation reports
exactly one `completed {usage}`, `cancelled {usage}` or `uncertain`. Known
usage settles with the binding's rates; uncertain or over-maximum usage charges
the entire claim maximum. Breaking a stream without final usage is uncertain,
even if the browser locally cancelled. A retry is a new admission. At startup,
`handlers.resume()` recovers unfinished claims at their maxima and releases
unclaimed reservations. It must run before fresh work under the host's
exclusive-writer lifecycle. The slim ledger ports Gen-2
`runtime/budget/{gate,sqlite}.js`; residency/evidence admission ports
`runtime/settings/{resolver,capabilities}.js`.

To add a plugin, export a static valid manifest, implement the declared kind
and cancellable health operation, bind private operator selections, and run
`reasoningConformance(plugin, fixtureRequest)` with local fixtures. Reasoning
must consume the provided claim before dispatch and report terminal usage in
`finally`, including iterator return, cancellation and deadline. The reusable
kit checks manifest, health, error codes, claim consumption, schema output and
terminal counts, with preflight and active stream cancellation/deadlines. CI
runs it for OpenRouter, Mistral and mock and verifies a deliberately broken
fixture fails; provider tests also cover stalled structured responses. The
browser device half advertises text only and is not a full reasoning-kind
server implementation. No live provider qualification is claimed.

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

## License and contributions

Aithema's core, server, UI and plugins are **AGPL-3.0-only**; see [LICENSE](LICENSE).
Third-party dependencies retain their own licences, recorded in [NOTICES.json](NOTICES.json).
Commercial-host licensing must follow the applicable licence or a separately
formalised grant from INSPR; this README grants no exception.

Every contribution commit requires a matching `Signed-off-by` trailer under the
[Developer Certificate of Origin 1.1](DCO), created with `git commit --signoff`.
External contributions also require an agreement with INSPR permitting relicensing;
DCO sign-off alone is insufficient. Review, merge and release remain maintainer-controlled.
