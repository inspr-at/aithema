# Aithema reset slice 1

Private, isolated npm workspaces for AIT-96. Node **24 or newer**, native ESM,
Fetch handlers, custom elements and `node:test`. The existing root package and
release/version scheme are unchanged. Public licensing remains AGPL-3.0-only.

```sh
cd next
npm ci
npm test
npm run demo
```

Open http://127.0.0.1:3000. The heading is **Demo — Aithema reset slice 1**.
The demo accepts only `127.0.0.1:<port>` and `localhost:<port>` Host headers;
all POSTs require `Content-Type: application/json` (optional charset accepted).
Mock reasoning is the default and is visibly labelled. It recognizes explicit
`operations: hosted; data: public; systems: API; reach: international` statements;
it does not simulate a real model's understanding quality. The session id is
kept in browser local storage. Reload the page, or stop/restart the server, to
resume. The default SQLite file is `next/.data/session.sqlite` (git-ignored).
`PORT` and `AITHEMA_DB` override the port and database path. New conversation
creates another session; it does not erase the prior one.

When `OPENROUTER_API_KEY` is present at runtime, the demo binds OpenRouter using
the model in `demo/config.js`, optionally overridden by `OPENROUTER_MODEL`.
No credential is read from a file or sent to the browser. Both reasoning
operations accept `{signal, deadlineAt}`. The plugin uses the documented
[Chat Completions streaming](https://openrouter.ai/docs/api/reference/streaming)
and [JSON Schema output](https://openrouter.ai/docs/guides/features/structured-outputs)
formats, including parameter-capable routing. Unsupported schema/model bindings
fail instead of falling back. No real provider call is made by the tests.

## Host integration

`@inspr/aithema-next-core` exports the session/event reducer, START preset,
understanding reducer, readiness display helpers, generic prompt policy,
`SessionLanes`, and labelled mock reasoning. Presets parameterize slots,
required slots, actor/engagement taxonomies, talk threshold/marker and anonymous
analysis admission. Slot names are English identifiers; `requirements` is the
optional START `auflagen` slot. Constraint values/evidence are capped at 240/500
characters and must match a user statement after normalization. Drafts preserve
corroborated slots, narrative and readiness; finals can correct/reopen them.
Selected human actors survive model readings. Input revision includes human
turn revision, consent revision, withdrawal revision and locale. Every lane is
single-flight per session and aborts flights with an obsolete revision. Reaction
and understanding run independently, so an obsolete assessment cannot delay
the latest reply. `SessionLanes` accepts an optional distinct `draftReasoning`
binding; the shared default binding runs only the final understanding pass.

`@inspr/aithema-next-server` exports `SQLiteStorage`, `createHandlers`,
`exportSession` and `zipStore`; its `/http` export supplies `listen` and
`httpAdapter`. `createHandlers({storage, reasoning, sessionOptions, hostPrompt,
deadlineMs})` returns `handle(Request)`, `resume()`, `idle()` and `close()`.
Call `resume()` on startup to finish outstanding current-revision work and
`close()` before closing storage. A small mock-only bin is available at
`node packages/server/bin/server.js`; set `AITHEMA_DB` to persist that bin.

| Request | Result |
| --- | --- |
| `POST /api/sessions`, body `{ "locale": "en" }` | `201` session snapshot |
| `GET /api/sessions/:id` | latest durable session snapshot including `seq`, plus current operational flags |
| `POST /api/sessions/:id/turns`, body `{ "clientEventId": "unique-id", "content": "…" }` | durable `turn.final` event |
| `GET /api/sessions/:id/events`, header `Last-Event-ID: <seq>` | missed durable events, then live SSE |
| `POST /api/sessions/:id/retry` | retry unfinished reasoning for current revision |
| `GET /api/sessions/:id/export` | ZIP with transcript JSON/Markdown and understanding JSON |

SSE also accepts `?after=<seq>`; the header takes precedence. Every durable
event has `{sessionId, seq, type, data}`. SSE `id` is `seq`; transient
`turn.partial`, `lane.failed` and `lane.status` have no id and are never persisted.
GET snapshots include `operations: {inputRevision, running, lastFailure}`.
`running` lists the active lanes; `lastFailure` is a sanitized lane failure for
the current input revision, retained by the server until that lane succeeds.
These operational flags are separate from the durable session/events. Opening
an SSE subscription reschedules unfinished work; snapshots and lane-status
messages let a freshly configured UI show Retry when work is unfinished and
no job is running. A rejected cursor (`400`) makes the client restore the
snapshot and reconnect with its sequence. The default
host authorizes immediate demo analysis; pass `{demo:false}` in `sessionOptions`
for START's three-person-turn admission, or `{identified:true}` for immediate
analysis. Host configuration, including actor/preset and demo admission, cannot
be changed by session-create request bodies.

SQLite commits each turn event, snapshot and idempotency receipt together,
using WAL and `synchronous=FULL`. Acknowledgement follows commit. An identical
client id and **identical request bytes** return the original receipt; different
bytes conflict (`409`), including different JSON whitespace/key order. Event
rows reject update/delete. Projection writes compare the expected input
revision inside the transaction. Resume reads only durable events after the
cursor; transient deltas are dropped. A slow SSE consumer is disconnected and
can replay. Requests are limited to 32 KiB, enough for 8,000 non-ASCII characters
plus JSON overhead; person messages to 8,000 characters;
transcripts to 500 entries/250,000 characters; reaction output to 16,000 chars.
Errors use fixed operational messages and never log content or credentials.

`@inspr/aithema-next-ui` registers `<aithema-session>`. Pass all visible copy
and the restored session from your host:

```js
import '@inspr/aithema-next-ui';
import { en } from '@inspr/aithema-next-ui/i18n/en';
element.configure({ copy: en, baseUrl: '', session: restoredSession });
element.addEventListener('aithema-event', event => { /* durable host notification */ });
```

Browser hosts serve these source modules with their relative core imports (as
the demo does); no build step or framework is required. Copy is assigned via
`textContent`. CSS tokens include `--aithema-paper`, `--aithema-ink`,
`--aithema-muted`, `--aithema-accent`, `--aithema-amber`, `--aithema-line`,
`--aithema-surface` and `--aithema-font`. The panes stack below 60rem. Cmd/Ctrl+
Enter sends and Enter inserts a line. The understanding meter retains START's
75% talk threshold at the 30% marker. Clarified details preserve expansion;
expand/collapse-all is supported. Automatic pane changes wait while the pointer
is over the affected region. Fixed pane heights and internal scrolling keep
the composer, headings and export control stationary.

## Ported from START

Source reference: `start-agm-com` main `1d4078c`, read-only port oracle.
**INSPR holds the rights to the ported generic code**, per approved decision D3
(revised, 2026-10-09). Augmentoring identity, branding, persona, funnel and offer
policy were removed. Root `LICENSE` and `NOTICES` are untouched.

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

## Slice boundaries and known deviations

This is the approved slice-1 vertical, not a production host. AIT-97 owns
ownership/auth, consent coverage/admission, durable pause, tombstones,
withdrawal/erasure and exclusive-writer enforcement. Those mechanisms are not
implemented here. Do not expose the demo beyond localhost. Input revision has
consent/withdrawal coordinates ready for the next slice, but no mutation API.
Working-spec confirmation/baselines, sources/uploads, concepts, voice,
library/account/settings/credits/handover UI, manifest/budget/health/terminal
report conformance and release packaging remain in their planned later slices.

The demo uses one reasoning binding for both lanes and skips the separate draft
call, matching START's same-model optimization. The core retains draft/final
passes for distinct bindings; host configuration of separate draft/analysis
models and budget admission belong to the plugin-contract slice. Each lane has
a hard 30-second deadline per flight, configurable by the host. Multiple quick user
turns coalesce to a reply/assessment for the latest revision; superseded replies
are never published. Manual retry replaces START's one automatic analysis retry;
SSE reconnect retries every second. “Clarify now”/guided question focus is not
implemented in this text vertical; history and settled/open rendering are kept.
Actor and engagement are persisted but not rendered, matching the consumed
START understanding payload. Only the English host bundle ships; locale is
retained for model prompts and future host bundles.

Visual parity is adapted to a fixed-height conversation/aside, with pointer-
deferred updates and no animation. DOM tests verify behaviour and safe
rendering; pixel comparison in a real browser and real model quality/capability
qualification are not performed. The mock is intentionally deterministic and
has no persona. No existing root packaging/source-export suite is run; only
the new isolated `next` CI job is added, with a ten-minute timeout.
