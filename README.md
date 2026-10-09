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

An `OPENROUTER_API_KEY` supplied at runtime selects the OpenRouter plugin;
`demo/config.js` supplies the model, overridden by `OPENROUTER_MODEL`.
Credentials stay on the server. Streaming and structured-output paths are tested
against fixtures; a live binding still needs qualification.

## Package layout

The private `aithema` root is an ESM npm workspace with one `package-lock.json`.

| Path / package | Contents |
| --- | --- |
| `packages/core` — `@inspr/aithema-core` | Session/event and understanding reducers, readiness, prompts, cancellable engine lanes |
| `packages/server` — `@inspr/aithema-server` | Fetch handlers, SSE, SQLite storage, session export, mock server bin |
| `packages/ui` — `@inspr/aithema-ui` | Framework-neutral `<aithema-session>` web component and English host copy |
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
| `POST /api/sessions` | New session snapshot |
| `GET /api/sessions/:id` | Durable snapshot and current operational flags |
| `POST /api/sessions/:id/turns` | Durable turn; identical client id and request bytes replay the receipt, differing bytes conflict |
| `GET /api/sessions/:id/events` | SSE; resume using `Last-Event-ID` or `?after=<seq>` |
| `POST /api/sessions/:id/retry` | Retry unfinished reasoning for the current revision |
| `GET /api/sessions/:id/export` | Transcript JSON/Markdown and understanding JSON in a ZIP |

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
