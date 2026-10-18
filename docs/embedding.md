# Embedding Aithema

Aithema uses **INSPR-CalVer3**; `release/version.json` is the
single version authority. The root workspace is private. The release packer
emits independently installable core, server, UI and twelve provider/integration
plugin tarballs, with exact dependency pins, plus a retained workspace archive.
Aithema is published as immutable [GitHub releases](https://github.com/inspr-at/aithema/releases)
with signed, attested tarballs. Hosts pin a release with `deployment-pin.json`
and `release-set.json`. Node.js 24 or newer is required.
See [release notes](../release/notes.md) and the [GitHub release route](../release/README.md).

## Consume Aithema as a module (START or another thin host)

[START’s `host/`](https://github.com/augmentoring-team/start-agm-com/tree/main/host)
is the living reference for a thin host consuming Aithema’s release tarballs.
Follow that host’s current integration when wiring storage, consent and runtime
lifecycle into a consuming application.

For candidate validation on the build runner, retain the candidate directory
and its manifest digest.
Run `npm run release:verify -- /path/to/candidate/first` before installing.
From a separate host directory, install **all fifteen** module tarballs so npm
can resolve their exact mutual dependencies without a registry publication:

```sh
npm install --save-exact /path/to/candidate/first/inspr-aithema-*.tgz
```

Commit the host's lockfile and retain the deployment pin, manifest and tarballs.
Use `npm ci` with those retained paths for subsequent deployments. A browser
bundler resolves the UI and its core dependency; an unbundled browser needs an
import map for each exported package subpath. Workspace source browser URLs
are converted to declared package subpaths by `release:pack`.

For a published release, install the same fifteen modules by release URL in
one invocation, rather than from a package registry. The URL pattern is:

```sh
npm install --save-exact https://github.com/inspr-at/aithema/releases/download/<tag>/<pkg>.tgz
```

Use the exact `v<version>` tag and module filenames from `release-set.json`, and
pass all fifteen module URLs together. First download and verify the attested
SHA256SUMS, manifest and tarballs as described in the [release route](../release/README.md).
Commit the host lockfile with the URL resolutions and **sha512 integrity**; use
`npm ci` for repeat deployments and retain the verified artifacts for rollback.
Public release downloads need no consumer token. The Linux tag build tests the
exact published tarballs; historical BSD candidate digests do not cover them.

For HTML and images, the embedding host installs and registers
`createClaudeHTML` (`@inspr/aithema-plugin-claude-html`) and/or
`createOpenAIImages` (`@inspr/aithema-plugin-openai-images`) itself. Add their IDs
and private bindings to the selected preset, mark HTML choices `kind: 'html'`,
and supply authoritative consent covering their exact processing scopes. Claude
provides `estimateCost` for exact admission pricing; other HTML adapters may
provide it or reserve the full binding ceiling. See `demo/visual-plugins.js` and
`demo/server.js` for host composition. The server does not load provider defaults.

The host supplies durable storage, authoritative identity/ownership and consent,
and budget policy. The server and UI are mounted independently; the demo is
an example host, not a dependency of START. A mock-only host can compose them as
follows (the `ports` object is trusted START server configuration):

```js
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { SQLiteBudgetLedger, createPluginRuntime, mockPresets, createHandlers } from '@inspr/aithema-server';
import { httpAdapter } from '@inspr/aithema-server/http';

export async function mountAithema(ports) {
  const storage = ports.storage; // e.g. SQLiteStorage; host owns its lifecycle
  const consent = ports.consent; // coverage, grant and withdraw; shared with runtime
  const reasoning = createMockReasoning();
  const registry = new PluginRegistry().register(reasoning);
  const budget = new SQLiteBudgetLedger(storage, ports.budgetPolicy);
  const pluginRuntime = createPluginRuntime({ storage, consent, reasoning, registry,
    budget, presets: mockPresets() });
  const handlers = createHandlers({ storage, consent, pluginRuntime,
    ownership: ports.ownership, host: {
      identity: ports.identity, library: ports.library, handover: ports.handover,
      wallet: ports.wallet, walletForSession: ports.walletForSession, credits: ports.credits,
      policy: ports.policy, privacyDocumentConfigured: ports.privacyDocumentConfigured,
    } });
  await handlers.resume();
  return { middleware: httpAdapter(handlers.handle), handle: handlers.handle,
    close: () => handlers.close() };
}
```

Mount `middleware` in the host HTTP server, or route Web `Request` objects to
`handle`. Pass the host's authenticated cookie/session token through
`ownership.token`; ensure the same token reaches the web component. The browser
example below creates and mounts `<aithema-session>`. Call `close()` before
closing the host storage on shutdown. `walletForSession` supplies runtime
owner admission; `wallet(ownerToken)` and `credits` supply the host account UI.
For paid models, register the chosen plugin factory and supply qualified private
bindings in the preset choices; mock presets alone never enable a paid route.

Both `SQLiteBudgetLedger` caps apply **per conversation**: `sessionCapMicro`
(`session`) bounds upstream usage, and `visitorCapMicro` (`voiceVisitor`) bounds
only that conversation's voice charge. `maxVisitorMicro` is the admission's
per-conversation voice maximum; reasoning admissions use `0`. Despite its name,
`visitorCapMicro` does not bound a visitor's or owner's total across conversations.
Enforce owner- or visitor-wide limits in the host's owner-wallet port
(`canAdmit` preview and atomic `admit`), supplied through `walletForSession`.
See the [README host ports section](../README.md#host-ports-ait-104-part-a)
for the wallet admission contract.

## Server handlers

This complete local example starts a mock-only server. The memory ledger starts
with no consent; use the consent routes before any reasoning. SQLite is the
exclusive writer. Keep its database private and close handlers before storage.
No provider credentials or provider calls are involved.

```js
import { SQLiteStorage, createHandlers, createMemoryConsentLedger } from '@inspr/aithema-server';
import { listen, httpAdapter } from '@inspr/aithema-server/http';

const storage = new SQLiteStorage(':memory:');
const consent = createMemoryConsentLedger();
const handlers = createHandlers({ storage, consent });
await handlers.resume();
const { server, url } = await listen(handlers.handle, { port: 3000 });
console.log(url);
// A framework host can mount httpAdapter(handlers.handle) instead.
async function close() {
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close());
```

The default ownership adapter reads `x-aithema-session-token`. Supply an
unpredictable token when creating a session and retain it for every subsequent
request. A framework host should pass its own authenticated `ownership.token`
port (for example, its HttpOnly visitor cookie). A session ID alone is never
ownership. `POST /api/sessions` takes JSON and returns the public session.
The optional `ownership.created(response, ownerToken, request)` hook runs once
before returning a successful 201 from every session-creating route:
`POST /api/sessions`, `POST /api/library`, and `POST /api/library/:id/reset`.
Use it to set or renew the host's owner cookie; failed requests do not call it.
After upgrading to a release containing AIT-217, START can remove its
`compose.js` wrapper that calls `ownership.created` for the two library 201s.
`GET /api/sessions/:id/events` supplies durable SSE replay; `/export` downloads
the provenance-preserving ZIP. See the root README's route tables for commands,
settings, uploads, withdrawal, concepts, and host routes.

### Clarify now command (AIT-263)

`GET /api/sessions/:id` includes `openQuestionItems: [{id, question}]` for the
current final assessment. IDs belong to that assessment; replacements at the
same input revision also invalidate them. `inputRevision(session)` from core is
the client's revision token. SSE clients can derive items with core's
`openQuestionItems(session)`. Existing `understanding.openQuestions` stays an
array of strings.

Authenticated `POST /api/sessions/:id/focus-question` accepts
`{questionId, inputRevision}`. Success is HTTP 202
`{accepted: true, event}`. The durable event is the existing `question.focused`,
with `{question, questionId, requestId, chosenBy: 'user', inputRevision}`.
Focus changes neither the input revision nor the person transcript. The chosen
point is explicit host guidance for the next reaction prompt. Each attempt
uses ordinary reaction admission, including current consent, budget and host
conversation deadline checks. An already cached ordinary reply cannot suppress
this request. Automatic focus remains derived; user choice is erasable content.

Refusals are `{error: 'focus-refused', reason}`: `invalid-request` (400),
`stale-revision`, `stale-question`, `paused`, `reply-in-flight` (409), or
`consent-required`, `not-admitted` (403). Availability refusals also carry
`admissionReason` (including AIT-261's `one-hour` conversation deadline).
Wrong ownership uses the existing indistinguishable 404.
`stale-question` includes removed, clarified, draft/stale assessment and
withdrawn-source items. Only one reaction or focus availability request may be
in flight per session. Pending voice replies, speaking and unknown playback
state also refuse with `reply-in-flight`, including after availability checks.
Voice clients report speaking/listening through `control.reportActivity`;
these acknowledgements are private state, never transcript events.
Availability is rechecked transactionally before focus
publication; actual provider dispatch still belongs to reaction admission.

Completion is the usual assistant `turn.final` with `focusRequestId` matching
the focus event's `requestId`; normal `lane.status` / `lane.failed` describe
work and failures. After a failed attempt, `POST /api/sessions/:id/retry {}`
reuses the selected point with fresh admission. Reconnect retains recorded
failures and never retries them implicitly. New input or withdrawn evidence
invalidates the selection and prevents publication of its late reply.
An accepted selection survives a same-input assessment replacement when its
exact question text remains, including reordering. If the question disappears,
`lane.failed` carries `reason: 'focused-question-removed'` and `retryable: false`;
choose from the current assessment instead. Focus replies do not change purpose
classification, counters or direction history for unchanged input. Their host
instructions are covered by the private-guidance output check; the selected
public question text remains eligible for the reply.

The element exposes `openQuestionItems` and `focusQuestion(questionId)`. Each
current open point also has an always-visible “Clarify now” button in the overview.
This method resolves on 202, and throws the structured refusal on failure. Text replies follow normal SSE delivery. With
an active, audible ElevenLabs or local simulator call, focused assistant finals use the existing
call replay/speech path and its TTS admission, output mute, pause and lifetime
holds. Voice adapters expose the optional `VoiceSession.speakReply({turnId, text})`
port for already persisted replies. No synthetic SDK user message or transcript
turn triggers speech.

The overview controls follow these states:

- **Requesting:** start `focusQuestion(id)`; use reaction in `lane.status.running`
  to show the accepted request still working. Duplicate clicks get `reply-in-flight`.
- **Selected / asked:** `question.focused.chosenBy === 'user'` records the
  selection; matching `turn.final.focusRequestId` records the asked reply.
- **Stale item:** keep an old item ID, then replace the assessment, answer a
  question, or withdraw its input before submitting. Handle `stale-revision` or
  `stale-question`, refresh the snapshot and discard the old ID.
- **Retry:** fail or refuse reaction admission after focus was accepted; a
  current reaction `lane.failed` leaves the selection pending. Existing `/retry`
  attempts it again. A pre-acceptance consent or availability refusal needs that
  condition resolved before resubmitting the current item.

## Host retention contract

Use `await handlers.retire({ before, limit: 100 })` to erase **whole idle
sessions** and finish removing visitor-erased conversations, without possessing
visitor tokens. `before` is a nonnegative Unix millisecond timestamp; live-session
eligibility is strictly `lastActivity < before`. Erased sessions are eligible on
the next sweep after erase cancellation and the
`host.erased` hook finish, regardless of `before`. Visitor erase and library delete
queue retirement after that cleanup; direct storage erasure queues in the tombstone
transaction. A crash before queuing leaves a tombstone for startup backfill.
There is no additional idle window after erase or library delete. `limit`
is an integer from 1 to 1000 (default 100). The result is `{ retired, failed, more }`:
`retired` counts completed core erasures; `failed` counts sessions that failed
this call; `more` means another eligible, due retry or historical tombstone batch
exists. Repeated and overlapping calls are safe. An interrupted
retirement is durably queued and retried, including the host cleanup hook.
Hooks must therefore be idempotent. A failing session stays tombstoned and
pending with a durable attempt count and exponential backoff (1 second up to
1 hour); the batch continues. Deferred retries do not set `more`: call again
on the maintenance schedule even when `more` is false. Monitor `failed`;
host failures and pending reconciliation for erased sessions can delay deletion
beyond the intended retention window. Live-session retirement keeps its existing
accounting behavior and does not wait for billing reconciliation.

Last activity is the latest **server timestamp** of person- or host-initiated
activity: session creation, turns and other committed session changes, authorized
session and individual library requests (including reads and export), and the
completion of protected requests, streams and work the person started. Client
turn timestamps cannot backdate it. The rule lives in `SQLiteStorage.countsAsActivity`:
direct storage calls are host activity; `storage.systemWork(fn)` marks system work
and its asynchronous descendants as maintenance. System events, including
`expire` withdrawal events and the rebuild jobs they schedule, never renew the
idle clock. Hosts must wrap other system-originated work in `systemWork` too.
Failed ownership checks and read-only maintenance scans do not renew activity.
Expire and retire can use the same cutoff in either order without adding an
extra retention window. In-flight authorized requests, open SSE streams and running
text reasoning jobs exclude the session from retirement; active voice calls
and pending host deliveries also exclude it. An idle but connected page is therefore still active. Selection
and the final idle check run under the exclusive SQLite writer, before any
asynchronous cancellation or hook, so newly active sessions cannot be erased
from a stale candidate list. On migration, the latest stored event timestamp
initializes activity (unknown timestamps conservatively start at migration).

Retirement uses the erase route's `session.erased` invalidation: it broadcasts
and closes live streams and cancels lanes, concepts, uploads and voice. It then
withdraws consent, awaits `host.retired({ sessionId, ownerHash })`, and physically
deletes core rows in child-before-parent FK order, then the session. The owner
hash is captured inside the tombstone transaction. No owner token is invented;
the user erase route continues to use `host.erased({ sessionId, ownerToken })`.
The host hook runs after the tombstone commits and before the separate core
purge transaction; it may open its own transaction. The hook has a per-session deadline of 30 seconds (configure the positive integer
`retiredHookTimeoutMs` in `createHandlers`). A timeout or failure keeps core rows
pending for retry, counts as failed, and lets the batch continue. The timeout
cannot cancel host code; hooks must tolerate a late completion overlapping a retry.
Failures log only session ID and error class, never error content. Core purge and the final batch checkpoint truncate the WAL
for sessions already purged even if another session's hook fails.

| Data | After successful retirement |
| --- | --- |
| Session, settings, consent revision, owner hash | Deleted |
| Value-free event journal, receipts and content hashes | Deleted |
| Text, understanding, actor, focused question, identity and library projections | Deleted |
| Upload bytes, extracted text, concept blobs and feedback | Deleted |
| Host state, safeguards, voice calls, lifecycle and operation records | Deleted |
| Processing consent grants and history in the composed demo | Deleted |
| Per-session budget attempts, corrections, render claims, duration reservations | Deleted |
| Deployment spend, render and voice totals | Only value-free totals per account or UTC day remain; no session, owner, attempt or provider generation identifiers |
| Host-owned visitor accounts, mail, handover systems, backups and provider copies | Host controls their own retention; see below |

SQLite uses `secure_delete` and truncates its WAL before acknowledging the
full erase. Visitor-erased sessions defer retirement while a budget attempt is open,
while an associated spend reservation remains reserved or dispatched without an
actual amount, or while a provider cost receipt has a non-null `retryAt`. Session
and accounting metadata remain available during that pending work; content stays
erased. Retirement checks before host cleanup and again in the core purge
transaction, using durable backoff until those conditions clear. Terminal estimates
with no scheduled retry, uncertain receipts with no future settlement, and voice
`costEstimated` receipts alone do not block retirement. Their spend reservations
are aggregated into `retired_spend` using the existing spent/reserved/uncertain
categories, preserving conservative estimated amounts. Live-session retirement
uses the same aggregation without the billing deferral. If a plugin is removed
while a cost retry is scheduled, the next due cost reconciliation clears that
retry for an erased session, preserving the existing conservative charge and
receipt; no provider settlement is inferred. Live-session receipts remain
retryable if the plugin returns. Retained totals
are deployment spend/reserved/uncertain amounts and breach flags per account,
render counts per UTC day, and spent/reserved voice milliseconds per UTC day.
On low-volume days, a daily total may reveal one session's usage. Daily buckets
remain necessary for daily cap enforcement; hosts should aggregate reports by
week and restrict access to raw daily accounting. This does not erase independent backups or remote provider copies.
Core removes only its own explicit table list. Hosts must clean their own SQLite
and external session rows in the idempotent `retired` hook, including in-memory
projections. Index host `session_id` columns to avoid a full scan per session.
Host FKs to `sessions(id)` or core child tables such as `content`, `uploads`
and `concept_artifacts` must be removed or detached before the hook returns;
a remaining FK blocks core purge and causes a retry. Host tables are never
automatically deleted merely because they have a `session_id` column. Hosts may
retain legally required records such as consent proof: that is their decision,
to document under their own policy, with a schema independent of the deleted
session (or a detached nullable FK). For example:

```js
const host = {
  async retired({ sessionId, ownerHash }) {
    storage.transaction(() => {
      storage.db.prepare('DELETE FROM host_consent_events WHERE session_id=?').run(sessionId);
      storage.db.prepare('DELETE FROM host_consent_grants WHERE session_id=?').run(sessionId);
    });
    await removeExternalSessionData({ sessionId, ownerHash }); // idempotent
  },
};
```

The demo deletes its own consent history, session mail outbox and wallet holds. Visitor identity, visitor credit
accounts and deployment abuse controls are separate host records, governed by
the host's visitor-retention policy. Shared owner credit guards are removed
when they refer to the retired session. Do not promise provider-side deletion
from this API.

For a 24-hour idle policy, run at startup and on the host's existing maintenance
schedule. Drain batches with a short yield between calls; serialize the loop:

```js
let retaining = false;
async function retainIdleSessions() {
  if (retaining) return;
  retaining = true;
  const before = Date.now() - 24 * 60 * 60 * 1000;
  try {
    while ((await handlers.retire({ before, limit: 100 })).more) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { retaining = false; }
}
await retainIdleSessions();
const retentionTimer = setInterval(() => void retainIdleSessions().catch(reportRetentionFailure), 15 * 60_000);
// Shutdown: clearInterval(retentionTimer), await any running maintenance, then close handlers/storage.
```

A 15-minute schedule normally deletes after 24 hours of inactivity **plus up to
15 minutes and backlog/maintenance delays**. Privacy copy must reflect that
window and distinguish idle retention from a fixed lifetime. The demo keeps its
existing one-minute schedule and 365-day cutoff for live sessions, retiring at
most 100 sessions per tick. Visitor erase and library delete clear content
immediately. After erase cleanup finishes, the next scheduled sweep attempts
complete removal (the demo ticks every minute; the example above every 15 minutes).
Actual removal waits for an eligible batch, any pending reconciliation described
above, successful host retirement cleanup and the core purge/checkpoint; backlog,
retry backoff and maintenance outages can delay it. Until successful retirement, the tombstoned
session, value-free journal, hashes and accounting links remain. Afterward all
core session rows are gone; only the deployment totals described above remain.
Host privacy copy must describe these conditions and delays together with
separate host/provider retention.

Existing databases need no manual data rewrite: an additive partial index finds
historical tombstones, and each `retire` call queues at most `limit` of them in ID
order. Reopening safely restarts this bounded pass without resetting pending
attempt counts or backoff. Run the sweep at startup and continue scheduled ticks
even when `more` is false. The older `expire(before)` only withdraws old
turns/uploads; it is not a full-erasure contract. Expiry and live retirement
candidates use the indexed live-session set; tombstone backfill uses its own
index and never hydrates the historical session set.

## Web components

A browser build needs an import map or bundler resolving workspace package
specifiers, plus module JSON support for the bundled display config. Serve JS
as JavaScript and JSON as `application/json`; Node's package exports do not
configure browser resolution. The UI does not install providers on import.

Serve the loading shell in the initial HTML, before fetching or importing the
browser module. On the host server, import the static helpers (they have no DOM
dependency) and append `firstPaintStyles` to the host's render-blocking CSS:

```js
import { firstPaintMarkup, firstPaintStyles } from '@inspr/aithema-ui/first-paint';
// GET /host.css: return hostPaletteCSS + firstPaintStyles as text/css.
// Initial HTML (link /host.css in <head>):
const shell = `<main class="aithema-shell"><aithema-session>
  <h1 slot="brand">Aithema</h1>
</aithema-session>${firstPaintMarkup}</main>`;
```

The `.aithema-shell` CSS hook hides unmounted host content and reserves the
same header, rail and 44px controls through definition, session fetch and
`configure()`. The component sets `data-aithema-mounted` after its synchronous
mount; the CSS then replaces the decorative, inert shell. Do not use `:defined`
as a readiness signal: definition can precede configuration. Keep the stylesheet
render-blocking so slotted titles never paint without their final styling.
This shell uses CSS `:has()` and targets evergreen browsers only; older browsers
without `:has()` support need a host-provided CSS fallback.
On startup failure, move the host title outside the hidden component, remove
`.aithema-first-paint`, and show an alert with a reload button there. The demo
also uses a 15-second deadline if `aithema-session` never defines; definition
cancels that deadline so session/network latency does not trigger it.

The default geometry uses a 1520px shell, responsive gutters and 216px desktop
/ 88px phone actions. The shell uses inline-size containment: its width must
come from its container, never shrink-to-fit its content. Keep `.aithema-shell`
and its band the same width; apply
`--aithema-shell-max`, `--aithema-gutter` and `--aithema-header-actions-width`
overrides to the shell and both direct children. First paint reserves voice rows
using shell content width (including classic scrollbars) and a 27vw brand bound.
For wider actions, append CSS from
`headerRailReservation({ actionsWidth: '280px' })` in
`@inspr/aithema-ui/first-paint` after `firstPaintStyles`; pass matching `gutter`
and `brandWidth` bounds when customized. Arguments must be literal CSS lengths
or expressions because queries cannot read custom properties. Stay within these
bounds so mount never adds an unreserved row. Supply `--paper`, `--surface`,
`--accent` and `--line` with the same theme selection before paint.

The browser configures the element already present in that shell:

```js
import { AithemaSession } from '@inspr/aithema-ui';
import { en } from '@inspr/aithema-ui/i18n/en';
import { createVoiceControl } from '@inspr/aithema-ui/voice-control';
import { AithemaHTMLPreview, HTML_PREVIEW_HOST_CSP } from '@inspr/aithema-ui/html-preview';

const token = crypto.randomUUID();
const response = await fetch('/api/sessions', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token },
  body: JSON.stringify({ locale: 'en' })
});
if (!response.ok) throw new Error('Session creation failed');
const session = await response.json();
const element = document.querySelector('aithema-session');
element.configure({ copy: en, session, sessionToken: token, baseUrl: '' });
// Import registers <aithema-session> and <aithema-html-preview>.
// createVoiceControl handles neutral voice commands; supply adapter clients separately.
// Use HTML_PREVIEW_HOST_CSP when serving pages that embed generated HTML previews.
```

`configure({host})` enables selected library, verification, handover, credits,
locale and operator UI slots. It supplies presentation only; the server ports
still authorize every action. `voiceClients` maps allowed option IDs to browser
adapter clients; `voicePresentation` supplies that adapter's label and copy.
A host has bound voice when `voiceClient` is truthy or `voiceClients` contains
at least one truthy client under an option ID other than `off`. These clients represent the allowed catalog voice
options. An off-only/unconfigured host supplies neither (including an empty
`voiceClients` map); no rail, pause, microphone, synthetic-voice footer claim or
reply replay/text-reading action is mounted. This condition deliberately ignores
the currently selected voice, preset, consent and temporary availability verdicts:
a bound host retains its voice controls when voice is switched off or interrupted.
A catalog voice option without its browser client also mounts no voice chrome;
Settings continues to describe the server catalog. The demo maps an unbound
ElevenLabs runtime to `voiceMode: off`, so a setup `voiceDisabledReason` cannot
accidentally mount its browser adapter.
Hosts using the exported loading header can call
`firstPaintMarkupFor({ voice: false })` before serving an unbound host; the original
`firstPaintMarkup` export remains the bound-voice default. This keeps the phone
loading header at 68 px without painting voice placeholders.
The desktop header stays 90 px high through voice and conversation states;
the phone frame follows the approved voice-specific rows.

The host's `<h1 slot="brand">` is visible beside the orb and remains the page's
heading; without it the default brand keeps its previous hidden presentation.
Legal links in `slot="legal"` stand at the right of the footer bar on the entrance
and in conversation. `slot="footer"` stays in the info popup. On phones (under
600 px), the connection timer moves into that popup to leave room for legal links.
The approved full AI label and connection status remain visible at 1024 px.
The connection label reserves the widest short label in the current language,
with the full description in its tooltip and a polite live region. The status dot
and timer stay in place when the connection changes. At 700–899 px only hosts
with visible credits hide the label; the named status dot stays visible.
Credit-enabled hosts retain compact balance details below 1100 px; phone footers
use the short AI label, retain its marker and omit the decorative credit track.
Use quiet underlined legal links. Slot anchors directly (`<a slot="legal" ...>`)
to receive the module's 44 px targets. If you slot a wrapper such as `<nav>`,
its nested anchors remain host-owned: `::slotted(a)` cannot style descendants.
Give each nested anchor at least a 24×24 CSS px target (WCAG 2.2, 2.5.8),
and 44×44 px on touch, matching the module. For example:

```css
nav[slot="legal"] a {
  display: inline-flex;
  align-items: center;
  min-width: 24px;
  min-height: 24px;
}
@media (pointer: coarse) {
  nav[slot="legal"] a { min-width: 44px; min-height: 44px; }
}
```

The visible product name stays **Aithema 2026.10**. `host.version` may carry
`version`, `version_scheme`, `commit` and `date` from the immutable manifest;
the exact coordinate appears in the existing hover/focus details only. A new
host-version row labels `host.version.version` with the brand slot's `textContent`
(whitespace collapsed and trimmed), or `Host` in DE/EN without a brand. Brand text
changes update that row in place; a host `product` value never replaces the
Aithema label. The popup orders the AI notice, Aithema version, brand-labelled
host coordinate and muted build details. Both coordinates use the existing Pretty
presentation; the host coordinate has no additional copy control. CalVer3
uses the pinned shared Pretty renderer there, with canonical copy, UTC tooltip,
keyboard/touch interaction and reduced motion. The popup shows the notice, then
`Version 26.10.14 · 08:00` on its own line, then the host row (for example
`START · 26.10.14 · 08:00`), followed by muted UTC build details.
Tick’s approved separators are passed to the shared renderer by the product
adapter, with weight 1 for hours/minutes and dark ink for segments/separators;
the upstream bundle and base config stay pinned. `release/presentation.json`
records these intended product overrides. Copy confirmation replaces the
version in a reserved slot for 1.2 seconds. Unknown schemes hide only the
version row and log once, leaving the session usable. Auto colors use the host branding;
`host.version.display: "semver"` selects the full reduced coordinate in that same
popup, with the same canonical-copy interaction. Legacy details remain plain.

To enable **Projekt erstellen / Create project** beside the conversation download
at the bottom right of the overview, pass both top-level component options:

```js
element.configure({ copy: en, session, sessionToken: token,
  paimosImportUrl: 'https://pm.augmentoring.com/import/project-draft',
  paimosImportVersion: 1 });
```

`paimosImportUrl` must be a full HTTP(S) URL without embedded credentials;
`paimosImportVersion` must be the number `1`. Missing, invalid or unsupported
configuration omits the action without reserving space. **START points at
pm.augmentoring.com**; the destination belongs to the host and is never hard-wired
in Aithema. The demo optionally reads `AITHEMA_PAIMOS_IMPORT_URL` and supplies
version `1`; it is unset by default.

Clicking submits a generated `<form method="post" target="_blank">` to that URL,
with exactly one hidden field, `payload`, containing JSON. This is top-level
navigation in a new tab, with no fetch/CORS exchange or Aithema credentials.
The v1 payload contains `version: 1`, `source: { product: "aithema", host,
session_id }` (the embedding page's host, including any port), `language`,
`title`, `summary`, `facts`, `open_points` and `transcript: [{ role, text, at }]`.
It uses the same current understanding and active, unerased/unwithdrawn turns
as the conversation ZIP: summary is the current assessment, facts are the
observed signals and open points are the open questions. The title uses the
first summary line (up to 200 code points), falling back to the overview heading;
turn timestamps retain their RFC3339 values. Artifacts and uploads are not part
of this contract.

Contract v1 (AEON-1441) limits the summary to **4,000 code points**, facts and open
points to **50 items each**, each item to **500 code points**, and the transcript
to **2,000 turns**. Overlong summary and item text ends with a counted `…`;
later items beyond the cap are dropped. The serialized JSON is capped at
**512 KiB in UTF-8**. Both transcript caps keep the newest whole turns, dropping
the oldest first. A localized omitted-turn note stays complete inside the summary
limit by shortening the summary body. Oversized metadata fails without submitting.
Paimos stores a single-use draft for 30 minutes,
then redirects to `/new-project?draft=<id>`; the person signs in normally to claim
it (AEON-1441 / r136).

The UI's optional `host.operator` configuration supplies `provider`,
`url: '/api/operator/login/'`, `logoutUrl: '/api/operator/logout/'`, and the
authenticated operator's `name`. Set `operator.adminUrl` only when the host
provides an admin destination, for example
`host: { operator: { provider: 'Zitadel', url: '/api/operator/login/', logoutUrl: '/api/operator/logout/', name: 'Ada', adminUrl: '/admin' } }`.
`adminUrl` accepts same-origin relative paths (such as `/admin` or `./admin`)
or absolute HTTP(S) URLs. Other schemes, protocol-relative URLs, backslashes,
whitespace and malformed URLs fail closed. Omit it when no admin page exists:
the name has no admin anchor, dot separators or reserved admin space; native
sign-out remains available. The complete operator line is built synchronously
before attachment. The demo host explicitly supplies `/admin`; admin pages
remain host-owned.

## Host ports and presets

Hosts supply `identity`, `library(ownerToken)`, `handover(ownerToken)`,
`wallet(ownerToken)`, `credits`, and their authoritative `consent.coverage` port.
Identity verification must be delivered and checked by the host. Enabling
`policy.verificationRequired` requires `identity.deliversVerification === true`
and actual verification methods. Host collection requires a configured privacy
document. Pass the same consent port to handlers and plugin runtime. Consent,
budgets, ownership and pause are checked before every dispatch.

### Consent documents in Settings

To let visitors edit consent in Settings, the same authoritative consent port
also implements `describe(sessionId)`. It returns the following JSON object,
either synchronously or through a promise. This is a current description of the
ledger, never a grant from the browser.

| Field | Type and requirement |
| --- | --- |
| `contract` | Required non-empty string identifying the exact current terms. Change it when those terms change; validate it again in `grant({ decision })`. |
| `items` | Required array of item objects, possibly empty if no processing is offered. Each has a unique non-empty string `id`, a `version` that is a positive safe integer or non-empty string, and non-empty strings `title`, `recipients` and `text` (purpose and data use). Strings render as text, never HTML. |
| `selected` | Required array of unique item IDs from `items`, including only currently valid grants for this session and contract. An empty array grants nothing. |
| `mock` | Optional boolean; absent and `false` mean a real document. `true` adds mock labelling. It never removes or replaces described items or changes their feature mapping. |
| `intro`, `withdrawal` | Optional non-empty strings for a host consent page's introduction and withdrawal terms. Settings uses the configured, localized `copy.processingConsent.intro`/`withdrawal`, or the mock host copy described below. |
| `optional` | Optional array of unique known item IDs, for host consent-page presentations. Settings displays all items. |
| `features` | Optional object (not null or an array). Every value must be an array of unique known item IDs; empty arrays are valid. The validator does not restrict its keys. Invalid supplied values fail closed, even though the server replaces a valid supplied map with its own derived map. |

For example, a host using the local processing scope can return:

```js
const currentConsentDocument = {
  contract: 'host-processing-v1',
  items: [{ id: 'mock-processing', version: 1, title: 'Conversation processing',
    recipients: 'Your host processor', text: 'Your messages are processed to answer and build understanding.' }],
  selected: [],
};
```

For provider bindings, an item's `id` matches the binding's processing-scope
`purpose`. The local `mock-conversation` scope also accepts the established
`mock-processing` item ID, for both real and mock documents. The server derives
`features` from the session's actual processing scopes and known item IDs;
a supplied `features` map must pass the validation above, then the server replaces
it with the derived map. Hosts cannot override this mapping. The
consent GET response adds `features: { [feature]: string[] }` for `text`,
`analysis`, `voice`, `transcription`, `images`, `html` and `uploads`. Empty arrays
mean no matching described processing. Settings requires a non-empty mapping
for the requested feature, focuses its first missing item and preserves the
other selections. Saving sends `{ granted, processing: { contract, items } }`;
the ledger must validate the contract, IDs and current revision authoritatively.

The existing one-item mock shorthand `{ mock: true, selected: [] }` remains
supported: `selected` may contain only `mock-processing`, and `contract` is
optional. Its item version is 1 and its visible item comes from the host copy.
For real documents, hosts **must** override the localized
`copy.processingConsent.intro` and `copy.processingConsent.withdrawal` with their
actual consent and withdrawal terms, including where consent is stored and how
long it applies. Settings reads these copy keys, not the optional `intro` and
`withdrawal` fields in `describe()`. The default intro describes the selection,
recipients and purposes; the default withdrawal explains how to withdraw and
that past transfers cannot be undone. Neither states where consent is stored
or how long it applies.

Consent decisions bind to the revision shown to the visitor (AIT-321). The
server adds `consentRevision` (a non-negative safe integer) to
`GET /api/sessions/:id/consent`. Send that value as `processing.revision` on
**every** decision, including withdrawal:

```js
const doc = await fetch(`/api/sessions/${id}/consent`).then(r => r.json());
await postJson(`/api/sessions/${id}/consent`, {
  granted: true,
  processing: { contract: doc.contract, items: selectedItems, revision: doc.consentRevision },
});
```

A mismatched revision returns HTTP **409**
`{ error: 'consent-stale', consentRevision: <current> }` before calling the host
ledger, revising consent, invalidating work or broadcasting. An explicitly
invalid revision returns HTTP **400** `{ error: 'invalid-consent-revision' }`.
Reload the consent document, show the current selection, and require a new
visitor action; never automatically retry the refused decision.

`consent.grant({ sessionId, consentRevision, decision, scopes })` receives the
expected revision in `decision.revision`; the outer `consentRevision` remains
the **next** revision being granted. An authoritative host ledger should also
compare the expected revision atomically before writing. The server serializes
consent reads and decisions around asynchronous host ports within this handler
instance; shared ledgers across processes must enforce their own atomic check.
A successful POST returns the committed `consentRevision`. The reference editor
confirms it against the current document and the exact selected item IDs, so
hosts may version their contract string on every grant or withdrawal.

**Deprecated compatibility:** decisions that omit `processing.revision` retain
the previous unconditional behavior for existing hosts. They do not protect
against stale tabs. Migrate host decision writers to the document revision now;
removal of this compatibility path requires a separately announced breaking
host release. The reference Settings editor sends revisions whenever the server
supplies them.

A mock consent document uses `copy.host.*`; override it to match your ledger.
In particular, override `consentTitle`, `consentUse` (`off`, `html`, `images`)
and `consentPage.mockRecipients`, `mockConsequence`, `mockTerms`;
`consentPage.mockNotice` labels a full mock document. Defaults promise no ledger
duration or persistence. The demo overlays its existing twelve-month real
processing intro and memory-only/restart mock wording in `demo/consent-copy.js`,
used by both its host and consent page.

Invalid shapes fail closed before any editable items are exposed. The server
and UI share `validateConsentDocument` from
`@inspr/aithema-core/consent-document`. The host's log callback passed to
`createHandlers({ log })` receives `event: 'consent.document.invalid'` and a
field-specific `reason` beginning `Invalid consent.describe():`, without
document values. The HTTP response is a generic 500
`{ error: 'consent-document-unavailable' }`; visitors see the existing localized
consent failure state with saving disabled. Contract diagnostics stay in the
host log.

```js
import { PluginRegistry, createMockReasoning, PROCESSING_PRESETS, createBinding,
  createMemoryLibrary, assertLibraryPort, libraryConformance,
  assertHandoverPort, handoverConformance, assertOwnerWalletPort, ownerWalletConformance } from '@inspr/aithema-core';
import { createPluginRuntime, mockPresets } from '@inspr/aithema-server';

const reasoning = createMockReasoning();
const registry = new PluginRegistry().register(reasoning);
const presets = mockPresets();
// Given storage and the same host-owned consent ledger as the server:
function runtimeFor(storage, consent) {
  return createPluginRuntime({ storage, consent, reasoning, registry, presets });
}
// The reference library is memory-only. Production hosts persist owner-scoped records.
const library = assertLibraryPort(createMemoryLibrary());
```

`PROCESSING_PRESETS` contains `best`, `eu`, `device`, `custom`. The runtime's
`presets[preset].choices` contains `models` (separate `reaction`/`understanding`
bindings), `voices`, `visuals` (`images` or `html`) and defaults. Unbound options
stay unavailable. The `device` preset is a browser text-only carve-out; there
is no automatic server dispatch. `eu` needs qualified account-specific evidence
covering the exact route and current consent. A vendor's location alone never
admits processing. The mock presets do not qualify a paid provider.

Use `createBinding` for host-private text bindings. They contain plugin/model,
endpoint/routing, account and secret references, ceilings, prices and legal
qualification evidence. Secret resolution remains server-private; never
serialize bindings into plugin manifests, public sessions, docs or telemetry.
Voice, image and HTML bindings have their own validated contracts described in
the README. The host-port conformance helpers above test library, delivery,
wallet behavior and failure/recovery; they do not replace live qualification.

`legal.countries` lists the recipients' seat countries (ISO alpha-2); host
`policy.countries` filters those seats. Optional `legal.processingCountries`
lists the contractually guaranteed processing locations (ISO alpha-2, non-empty
when present). The `eu` preset requires both EU-only recipient seats in
`legal.countries` and EU-only guaranteed processing in `legal.processingCountries`,
with the existing no-training rule. Recipient seats alone do not establish
processing residency. A non-EU seat surfaces as `recipient seat outside eu`;
a missing processing guarantee as `processing countries missing`; a malformed
guarantee as `processing residency unverified`; and non-EU processing as
`processing residency denied`. The settings catalog exposes these reasons in
DE/EN and refuses the choice without switching presets. START hosts using `best`
need no change; `processingCountries` remains optional for non-eu presets
(explicit `undefined` is absent under every preset), and their country policy
filters keep their existing behavior.

For the plugin contract and the text, voice and image onboarding steps, see
[Adding a model](plugins.md#adding-a-model). The standalone external package proof
uses host configuration and public exports without core or server changes.

### Provider seats and the host privacy link

A private binding's `legal.countries` lists the **recipients' seat**, using ISO
3166-1 alpha-2 country codes (for example `['US', 'IE']`). It does not establish
or guarantee a processing location. For qualified bindings the public catalog
exposes these countries as `facts.hostCountries`; the host-countries privacy
gauge says “Providers based in …” and explains that processing may occur
elsewhere. The `eu` preset requires both EU-only seats and a separate EU-only
contractual guarantee in `legal.processingCountries`, as described above.
Existing enforced country policies retain their separate restriction wording.

The gauge localizes country names with `Intl.DisplayNames` and joins them with
`Intl.ListFormat` (long conjunction). The UI explicitly overrides the `US`
display name to **“USA” in German** and **“the US” in English**, so `['US', 'IE']`
reads “USA und Irland” / “the US and Ireland”.

Mark the host privacy-policy anchor with **`data-aithema-privacy`** in the
component's `legal` slot. The marker works on a directly slotted anchor or on
an anchor inside a slotted wrapper; text and URL names are never guessed:

```html
<aithema-session>
  <nav slot="legal">
    <a href="/legal/privacy" data-aithema-privacy>Privacy policy</a>
    <a href="/legal/imprint">Imprint</a>
  </nav>
</aithema-session>
```

For host countries, the help detail's “Datenschutzerklärung” / “privacy policy”
becomes a link to that anchor's web URL (relative URLs are resolved against the
host document). A host `target="_blank"` is preserved with `noopener noreferrer`.
Without a marked HTTP(S) link in the legal slot, the phrase stays plain text.
The privacy gauge accepts keyboard focus so the help link is reachable without
hovering. Host training metadata never implies “no training”; that wording
continues to belong to the existing enforced EU path. On subsequent catalog
reads, host qualification is recomputed at the runtime's `now()`; expired
binding evidence no longer qualifies the quality gauge.

## Shipped plugins

The following imports are checked against actual exports. They are factories,
not an instruction to contact these services. Production hosts provide their
own authorized binding, consent, budget and server-private secret resolver.

```js
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createMistralReasoning } from '@inspr/aithema-plugin-mistral';
import { createDeviceReasoning } from '@inspr/aithema-plugin-device';
import { createOpenAIImages } from '@inspr/aithema-plugin-openai-images';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { createCodexImagegen } from '@inspr/aithema-plugin-codex-imagegen';
import { createTextExtractor } from '@inspr/aithema-plugin-extract-text';
import { createPDFExtractor } from '@inspr/aithema-plugin-extract-pdf';
import { createOOXMLExtractor } from '@inspr/aithema-plugin-extract-ooxml';
import { createSmtpMail } from '@inspr/aithema-plugin-mail-smtp';
import { createZitadelOIDC } from '@inspr/aithema-plugin-zitadel-oidc';
import { manifest as elevenLabsManifest } from '@inspr/aithema-plugin-elevenlabs/manifest';
```

OpenRouter/Mistral are server reasoning adapters; device is browser-only.
ElevenLabs has separate server/client exports behind neutral live-voice ports;
the adapter owns STT, TTS and turn-taking, with delegated reasoning. The shipped
fake-voice sources are deterministic fixtures, not another qualified pipeline.
OpenAI images, Claude HTML and Codex image generation preserve artifact
provenance and their distinct lifetime/cost contracts. Text/PDF/OOXML extractors
run bounded offline workers. SMTP and Zitadel implement host integration,
not conversation processing policy. Never infer legal qualification from a
technical plugin manifest. Plugin contract `apiVersion` ranges describe a
protocol, not the CalVer3 package compatibility promise.

### OpenRouter image bindings

`createOpenAIImages` also accepts the `openai/gpt-image-2` model on
`https://openrouter.ai/api/v1`. The admitted binding selects the route: direct
OpenAI uses `gpt-image-2` on `https://api.openai.com/v1`. Mixed model/endpoint
pairs and other hosts are refused (loopback endpoints are for offline fixtures).
`baseUrl`, if supplied, must still match the binding endpoint.

The host can reuse its existing OpenRouter key through `secretRef`; keep its
resolver server-private. Attribution uses `routing.referer` and `routing.title`
as optional `http-referer` and `x-title` headers. Neither is a credential.

```js
const imageRoute = {
  plugin: 'openai-images', model: 'openai/gpt-image-2', effort: 'none',
  endpoint: 'https://openrouter.ai/api/v1',
  accountRef: host.openRouterAccountRef,
  secretRef: host.existingOpenRouterSecretRef,
  routing: { referer: 'https://start.example.test', title: 'START concept images' },
  maxMicro: host.imageCallCeilingMicro, maxTokens: host.imageTokenCeiling,
  rates: host.conservativeImageRates,
};
const imageBinding = {
  ...imageRoute,
  legal: {
    approved: host.imageLegalApproval,
    purpose: host.imageProcessingPurpose,
    recipient: 'OpenRouter, Inc.', processors: ['OpenAI'],
    countries: host.verifiedRecipientCountries,
    processingCountries: host.verifiedProcessingCountries,
    training: host.verifiedImageTrainingPolicy,
    retention: host.verifiedImageRetention,
    dataCategories: host.imageDataCategories,
    consentVersion: host.imageConsentVersion,
    evidence: {
      qualified: host.imageAccountQualified,
      accountRef: imageRoute.accountRef, secretRef: imageRoute.secretRef,
      endpoint: imageRoute.endpoint, model: imageRoute.model, routing: imageRoute.routing,
      verifiedAt: host.imageEvidenceVerifiedAt, expiresAt: host.imageEvidenceExpiresAt,
    },
  },
};
const images = createOpenAIImages({ binding: imageBinding, resolveSecret: host.resolveSecret });
```

These host fields require actual account evidence; the adapter supplies no legal
defaults. `countries` describes recipient seats, while `processingCountries`
describes guaranteed processing locations. Both recipient and upstream processor
must appear in consent: `processingScope(imageBinding, 'generate')` (and `'edit'`)
includes `recipients: ['OpenRouter, Inc.']` and `upstreamProcessors: ['OpenAI']`.
Prompt and reference-image transfers must be covered by the host's current grant.
The public model qualification remains `unverified`.

Gateway generate and edit send JSON to `/images`. References are private bytes
encoded as data URLs in `input_references`, at most nine images of at most 12 MiB
each, including the previous artifact first on edit. Output must be inline
`data[0].b64_json` containing PNG or WebP. Gateway URL-only results are refused:
START v1 used inline bytes, and supporting downloads would add another transfer
origin to that contract. Direct mode retains its multipart edits and private
download-origin allowlist.

OpenRouter `usage.cost` is authoritative USD spend, rounded up once to microUSD
and reported as `chargedMicro`, independent of token-rate estimates. Missing or
invalid cost settles as `uncertain`, retaining any known token usage and the
host's reservation rather than implying a free image. Provenance identifies
provider `openrouter`, model `openai/gpt-image-2`; the label identifies the route.
No paid qualification call is part of this adapter's offline tests.

### Mail copy and privacy links

The SMTP plugin accepts `copy: { en: { ... }, de: { ... } }`. Each supplied
field overrides `mailCopy`; missing fields and locales retain the demo defaults.
The subject, plain text and HTML use the same merged copy. Unknown locales or
fields and non-string values fail at construction. `brand` defaults to
`Aithema`; the `host` signature supports `{brand}` and `{host}`. Override both
`explanation` (with an allowance) and `explanationFallback` (without one) when
the host uses a sign-in flow rather than the demo's credits.

```js
import { createSmtpMail, smtpConfig } from '@inspr/aithema-plugin-mail-smtp';

const mail = createSmtpMail({
  config: smtpConfig(hostSmtpSettings),
  publicOrigin: 'https://start.example.test',
  privacyUrl: locale => `https://start.example.test/privacy?lang=${locale}`,
  copy: {
    en: {
      brand: 'Augmentoring Start',
      explanation: 'Confirm your address to sign in.',
      explanationFallback: 'Confirm your address to sign in.',
      host: 'Sent by {brand} at {host} because you requested a sign-in link.',
      privacy: 'We use your address to sign you in and delete it after 24 hours.',
      retention: 'Please delete this sign-in message within 24 hours.',
    },
    de: {
      brand: 'Augmentoring Start',
      explanation: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      explanationFallback: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      host: 'Gesendet von {brand} auf {host}, weil Sie einen Anmeldelink angefordert haben.',
      privacy: 'Wir nutzen Ihre Adresse zur Anmeldung und löschen sie nach 24 Stunden.',
      retention: 'Bitte löschen Sie diese Anmeldenachricht innerhalb von 24 Stunden.',
    },
  },
});
```

`privacyUrl` can also be an absolute HTTP(S) URL string. A function must return
a string synchronously; it is called and validated once for each supported
locale (`de`, `en`) at construction. The validated URL appears in both parts.
Without this option, `/privacy?locale=<locale>` appears only when
`privacyDocumentConfigured` is true, preserving the demo's behavior. Copy
changes wording, not the host's storage/deletion policy. HTML escapes copy and
URLs; custom `htmlTemplate` functions receive the same merged `copy` and should
render its wording. See the [plugin README](../plugins/mail-smtp/README.md) for
the full field list and fallback behavior.

## Document extraction limits

The offline text/PDF/OOXML extractor ceiling is **20 MiB (20,971,520 bytes)**.
An input of exactly that size can extract; a larger input returns
`unreadable` with reason `limit`. Other format, archive and worker bounds still
apply. Hosts can only lower extractor ceilings, including per-call overrides;
raising an override is clamped to the configured ceiling.

| Extractor bound | Ceiling |
| --- | --- |
| Source bytes | 20 MiB |
| Retained text | 60,000 characters, including segment separators |
| PDF pages / Office sheets or slides | 100 |
| Worker deadline | 10,000 ms |
| V8 old-space limit (`maxHeapMb`) | 128 MiB |
| Worker RSS watchdog | 384 MiB, sampled every 25 ms |
| OOXML ZIP entries | 512 |
| One uncompressed ZIP part | 16 MiB |
| Total uncompressed ZIP bytes | 48 MiB |
| ZIP compression ratio | 100:1 per part |
| Core `UPLOAD_LIMITS.maxRequestBytes` | 21 MiB |
| Server multipart request default/ceiling | 21 MiB (hosts may only lower it) |
| Server file default/ceiling | 20 MiB |
| Server files per request / documents per session | 8 / 8 |
| Server source-byte budget per session | 160 MiB |
| Upload request budget | 25,000 ms |

Uploads use literal `multipart/form-data` file bytes, without base64 encoding.
The core request budget allows one 20 MiB document plus 1 MiB of form framing;
the HTTP regression verifies the original bytes reach admission intact. The
server enforces the same 21 MiB request ceiling, which hosts may only lower.
At most three requests per server process reserve admission from before body
reads until all their files finish extraction. A full reservation returns a
retryable HTTP 429 busy (`upload-rate-limit`) before reading the body. The UI
plans sequential batches against the advertised limits (20 MiB/file and
21 MiB/request if the limits GET fails) and retries busy responses up to three
total attempts, waiting 5 then 10 seconds or the longer `Retry-After` delay.
Busy is shown only after the attempts fail. The conservative default payload
and worker allowance is **570 MiB**, plus fixed/service overhead, GC/allocator
slack and watchdog overshoot; see the [memory formula](extractor-limits.md#pending-jobs-and-resident-memory-round-2).
Only extracted
text survives completion; truncation remains explicit through `truncated: true`.
Image-only PDFs remain unreadable without OCR.

[AIT-219 measurements and reproduction](extractor-limits.md) record three runs
per format and size on mbp2606. The normal 20 MiB fixtures leave at least 30%
headroom for heap, RSS and elapsed time under the unchanged bounds. The
adversarial OOXML and PDF fixtures still trip safety bounds; a file's byte size
alone does not guarantee extractability.

## Version source, release mapping and rollback

`release/version.json` is the sole authority. The owner-authorized candidate reserves
one UTC second with `status: reserved`, an increasing `release_sequence` and
scheme `inspr-calver-3`.
`reserveVersion` accepts explicit candidate authorization separately from a
publish go. A candidate reservation authorizes no tag or registry publication.
The fixed `dry_run_version` remains test input only. Reuse the reserved
coordinate in every candidate/release output; build machines never choose their
own coordinate. The channel's next reservation must be strictly later; a same-second collision waits for the next
second. Retain the candidate source commit and manifest digest; rebuild that exact commit
with the same toolchain. The source-commit argument to `release:pack` allows that
reproduction after evidence-only commits. Changed product bytes require a new
candidate and a new coordinate before publication.

New reservations declare `inspr-calver-3` (**INSPR-CalVer3**),
`YYMMDDhhmmss.0.0`; npm accepts this syntax. MINOR/PATCH stay zero and caret/tilde
compatibility semantics do not apply. Workspace manifests and lock entries mirror
the reserved coordinate with exact internal dependency pins. The packer also
derives public plugin manifest versions from that source. External dependencies
retain their exact lock closure.

The historical release-order mapping is in `release/history.json`: the 11
legacy v0.x releases, ending `0.10.1`, followed by the first October release,
`261015164601.0.0` at ordinal 12. The migration anchor keeps that first calendar
coordinate fixed; subsequent releases extend the mapping by ordinal. Mixed-era
ordering requires the explicit anchor/channel/ordinal. The archived `legacy-semver-public` and `legacy-semver-private` declarations are explicitly accepted as legacy types and preserved verbatim; the new history mapping never rewrites their manifests. CalVer2 history remains readable as its own declared
identifier; v1 dates and legacy stable SemVer remain tagged types. No old tag,
release, artifact or signed attestation is renamed, rewritten or republished.

The PR unit job runs `release/dry-run.mjs`: pack twice, compare exact bytes and
manifest, and verify every member. It also runs the candidate and isolated
consumer checks; CI retains preparation artifacts for 90 days. `release.yml`
accepts only a pushed tag whose exact name matches the reservation and whose
commit belongs to `origin/main`. That tag job builds and tests the shipped
archives, attests them and publishes the immutable GitHub release. There is no
manual publication trigger or npm publication. The builder creates no tag;
OPS follows [the release runbook](../release/README.md) after Tick's QA and
Markus's Desk go.
Canonical release bytes use Node 24/GNU tar in CI. Byte reproducibility is
verified per runner; reproducibility across machines is out of scope. BSD tar
can prove two local packs identical but is not claimed to reproduce GNU bytes.
Rollback reuses the stored bytes.

The release set records source commit, source tree/lock digests, all member
digests, package coordinates, version scheme/channel/sequence and the packing
run. The commit checks page references real CI/merge-queue validation; packing
is not a validation run. Canonical runtime metadata is also generated inside
the server package, so it does not depend on the repository-level `release/`
directory when distributed separately. Preserve the tarball, manifest and signed
attestations together. Runtime metadata and exported ZIP generator provenance use the artifact's source commit,
not a caller-supplied replacement. AI notice, text producer identity,
AI-generated/manipulated disclosure and image/HTML sidecars stay intact.

Rollback takes a retained trusted release-set manifest and an exact
`(channel, version, artifact coordinate, sha256)` through `rollbackArtifact`.
It verifies retained bytes and records a new deployment event without rebuilding,
decrementing, reusing, or moving the release coordinate. A rollback fix is a new
later release. Dry-runs cannot serve as production rollback evidence. Existing
legacy rollback continues through the original immutable v0.x artifacts.

## Historical qualification checklist — first reset candidate

This checklist records the first candidate's preparation state. Unchecked items
describe that checkpoint, not the current publication status. For published
releases and their limits, see the [releases page](https://github.com/inspr-at/aithema/releases)
and [release notes](../release/notes.md).

Merged implementation and deterministic tests prove code delivery. They do not
prove measured provider performance, exchangeability, live deployment or adoption.
At that checkpoint, independent cross-family review remained pending and was
not run by the builder.
The value-free migration inventory is `release/inventory.json`, owned by AIT-32.

- [ ] Controller review of the version inventory, consumers, legacy anchor and compatibility window.
- [ ] Independent review of the exact shared presentation source/config/manifest pins in `release/presentation.json`; reproduce the closure with upstream `scripts/versioning-bundle.mjs <full-source-commit> <config-sha256> <new-directory>` on the build runner. The source repository is private: public PR CI verifies the pinned offline closure, and never obtains broader source access or new credentials. A build runner with that exact source checkout can use `node release/verify-upstream-presentation.mjs <source-checkout>` to regenerate and compare all bytes. That independent source re-export/pin review remains pending, and the payload is not adoption evidence.
- [x] Reserve the first candidate coordinate; build all package tarballs twice and verify identical digests (`release/candidate.mjs`).
- [x] External consumer imports every documented symbol and runtime export, mounts handlers and web components, locks dependencies, updates the dependency pin and rolls back retained candidate bytes (`release/consumer.mjs`). This is scratch-host evidence, not a START production deployment.
- [x] Wire tag-only GitHub artifact attestation (`.github/workflows/release.yml`); at that checkpoint, signed bundles awaited an authorized tag build.
- [x] AIT-139: **60-minute soak not measured** (Markus: “Kein Test”); explicitly stated in the release notes, not a release blocker.
- [x] AIT-160: **second voice pipeline not yet proven** (parked); explicitly stated in the release notes, not a release blocker.
- [ ] Independent presentation pin review stays with the cross-family gate.
- [ ] Markus's separate Desk publish go; candidate preparation itself performed no tag, GitHub release or registry publication.

Public code remains **AGPL-3.0-only** throughout core/server/UI/contract/plugins.
D3 revised (2026-10-09) retains INSPR's rights and allows the planned special
licence to Augmentoring to be formalised once real customers exist. DCO alone
is not a relicensing agreement. The superseded slice-10 legal check is dropped;
this preparation creates no licence grant. See README “Ported from START” and
its rights notes for source provenance.

## Consumer export surface (AIT-205)

German-first hosts import `de` from `@inspr/aithema-ui/i18n/de`; English hosts
import `en` from `@inspr/aithema-ui/i18n/en`. Both bundles have identical keys,
recursively. Operator copy belongs to `demo/admin-copy.js`, alongside the
internal operator page and HTTP handler; it is absent from these visitor bundles.

Live voice hosts import `createElevenLabsVoiceHost` and
`normalizeElevenLabsDurationBinding` from
`@inspr/aithema-plugin-elevenlabs/voice-host`. The factory retains startup
read-back, receipt-based ownership, retry/backoff, atomic availability and orphan
reconciliation. Supply `storage`, `resolveSecret`, `publicOrigin`,
`templateAgentId`, `agentName`, `facadeSecretName`, `spokenOpeners` (`de`/`en`,
including the mandatory AI notice), `costConfig` (an object or a function of
`values`), and `qualifyBinding` (the host's legal qualification function).
`accountRef` defaults to `agentName`; optional `apiBaseUrl`, `fetchImpl`, `log`,
`random` and `values` support host configuration and deterministic tests.
The costs contain `maxDurationSeconds`, `reservationSeconds`,
`minRunwaySeconds`, `upstreamMicroPerMinute` and optional `usdPerCredit`.
The returned host exposes `binding`, `runtime`, `disabledReason`, `transient`,
`presentation`, `onAvailable`, `closeOrphan`, and `close`. Qualify the legacy
binding in the callback, then normalize it before creating a duration binding.
`agentName` and `facadeSecretName` must be explicit host-specific identifiers;
`costConfig` and `qualifyBinding` are required. Missing or invalid arguments reject
before any provider access; there is no fallback to Aithema's agent.

At startup, `ensureAgent` GETs the receipt-owned agent and compares only the
configuration it manages. An unchanged agent receives exactly one agent GET and
no agent PATCH; a missing agent is created and its ownership receipt stored.
START's template is always GET-only. Every create or PATCH is followed by a GET
and verification before voice becomes available. Secret reconciliation (including
the facade-secret PATCH on restart) remains unchanged.

Managed fields are `name`; `conversation_config`'s `tts` (template voice/model,
stability, similarity boost, style, speaker boost, speed, streaming latency,
output format and nested voice settings when supplied), `asr` (template quality,
provider, input format and host keywords), `turn` (template mode and host turn
policy), `conversation` (duration and client events), `language_presets` (empty),
and `agent` (language, AI first message, empty prompt/tools/knowledge base,
custom LLM/model/callback/secret reference); and `platform_settings`'s template
privacy flags/retention, host auth/allowlist and override policy. Other provider
fields, including timestamps and version IDs, are ignored.

Object key order is irrelevant. Arrays retain order, empty maps are intentional
clears, and strings compare exactly: whitespace in prompts or first messages
counts as drift. Only omitted TTS `stability=0.5`, `speed=1` and
`similarity_boost=0.8` normalize to those defaults. Nulls and type differences
remain drift, as do missing identity/security fields and non-default values.
Extra explicitly false conversation-override flags equal disabled defaults;
unknown enabled flags or malformed leaves require repair.

The [agent PATCH API](https://elevenlabs.io/docs/api-reference/agents/update)
accepts optional top-level `name`, `conversation_config` and `platform_settings`.
Only changed top-level fields are sent; a changed configuration object contains
its full managed set because nested replacement/merge semantics are not
guaranteed. OPS receives a structured log with the existing `name`/`id` and
`message`: `elevenlabs agent ensured: unchanged`,
`elevenlabs agent ensured: patched (fields: a, b)` (dotted managed field names),
or `elevenlabs agent ensured: created`. Logs never include configuration values,
prompts or secret references.

The demo's thin wrapper supplies its own START qualification, costs and openers;
undefined options preserve those defaults.

`@inspr/aithema-server/dev/local-voice` exports `createLocalVoiceProvider`,
`localVoiceBinding` and `isLocalVoice` for **development and tests**. Construction
refuses `NODE_ENV === 'production'` unless the host explicitly passes
`allowProductionSimulator: true` to `createLocalVoiceProvider`. This opt-in is only
for a deliberately simulated production-hosted demo; it does not provide real
voice or a production provider. It needs durable storage but no credentials
or external provider. Its implementation and manifest ship inside the server
package; the existing fake-voice fixtures forward to that single implementation.

Budget, host handlers, image binding, memory consent, operator sessions and spend
cap helpers already come from `@inspr/aithema-server`'s root export. No separate
subpaths are needed. Icons, JSON requests, reason formatting and release metadata
remain internal: hosts can supply their own small UI/transport helpers and build
metadata. The demo's operator page is internal for this release.

The demo browser currently resolves source URLs without an import map. Its
`host.js`, `consent-page.js`, shared `admin-view.js` and test-only `fake-voice.js`
retain those browser paths; every other non-test demo module uses package
specifiers. The unified [module boundary policy](architecture.md#allowed-edges) defines
and checks those exceptions with the packages/plugins rules. Existing static routes continue to serve package component dependencies.
The packed consumer imports every runtime subpath and also attempts each
types-only subpath, asserting Node's expected rejection and its installed type
file. It checks recursive German/English key parity on every install/reinstall
and rollback, outside the workspace.

The symbol audit of the original MISS rows is:

| Module | Decision and symbol-level reason |
| --- | --- |
| server/budget | Existing public root: `SQLiteBudgetLedger` is already re-exported. |
| server/host-handlers | Existing public root: `privacyDocumentConfigured` is already re-exported. |
| server/image-binding | Existing public root: `imagePluginBinding` is already re-exported. |
| server/local-voice | New public dev/test subpath: START needs a credential-free funnel; never production. |
| server/memory-consent | Existing public root: `createMemoryConsentLedger` is already re-exported. |
| server/operator-session | Existing public root: `createOperatorSessions` and `createSQLiteOperatorStore` are already re-exported; the demo operator page stays internal. |
| server/release-info | Internal: the demo reads its own reservation/runtime build metadata. |
| server/spend-cap | Existing public root: `usdMicro` is already re-exported. |
| ui/i18n/admin | Internal: copy moved to `demo/admin-copy.js` with its page and HTTP owner; visitor bundles no longer carry it. |
| ui/i18n/de | New public locale subpath: START is German-first; `de` was unreachable through exports. |
| ui/icons | Internal: the demo owns six small Lucide utility glyphs. |
| ui/post-json | Internal: a small host-side JSON POST helper suffices. |
| ui/settings-dialog | Internal: the demo owns its small reason formatter, without exposing the dialog implementation. |
| elevenlabs/config | Public through `./voice-host`: `normalizeElevenLabsDurationBinding` is needed at the host's adapter boundary. |
| elevenlabs/ensure-agent | Internal implementation behind public `createElevenLabsVoiceHost`; ownership/read-back and retries stay in one implementation. |
| plugins/fake-voice/client | Internal test-only fixture: retained browser simulator path, no public plugin package. |

Round 5 integration keeps consent coverage on the existing core root export:
`plugins/elevenlabs/src/components.js` and
`plugins/composed-voice/src/configuration.js` import `consentCoverage` directly from
`@inspr/aithema-core`, whose index already re-exports it; no `./consent` subpath or new public symbol is added.
The composed-voice adapter, server composed coordinator, Voxtral adapters and
ElevenLabs `components.js` remain source-only prototypes, omitted from module
tarballs. The installed ElevenLabs live-voice provider is unchanged. The generic
component contract and helpers below are supported and included in core tarballs.
`@inspr/aithema-server/composed-voice` remains unexported; a third-party pipeline
implements the public live-voice/session ports using its own coordinator.

### Supported STT/TTS component API (AIT-316)

```js
import {
  assertSTTComponent, assertTTSComponent, voiceCompositionCapabilities,
  componentInvocation, assertComponentUsage, boundedEvents, audioQueue,
  TTS_SPEAK_BYTES, TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS,
} from '@inspr/aithema-core/voice-components';
```

These runtime symbols are also available from `@inspr/aithema-core`. Types live
beside `plugin-contract.d.ts` in `voice-components.d.ts` and resolve through the
`@inspr/aithema-core/voice-components` subpath. `STTComponent`, `TTSComponent`,
`ComponentOperationOptions`, `ComponentTerminal` and `ComponentUsage` remain
available from the types-only `@inspr/aithema-core/plugin-contract` subpath too.
No additional server export is needed.

| Port | Signature and semantics |
| --- | --- |
| Both | `negotiateAudioFormat(offered, { signal, deadlineAt }): Promise<AudioFormat>` selects an offered encoding, sample rate and channel count, or rejects with `unavailable`. Negotiation performs no billable provider work. Request `format` is that selected encoding; the bound component retains the full selected format. |
| STT | `transcribe({ audio: Uint8Array, format, language }, options): Promise<{ text }>` transcribes one utterance. |
| STT streaming | `stream({ audio: AsyncIterable<Uint8Array>, format, language? }, options): AsyncIterable<{ text, final }>` emits replacement hypotheses, then exactly one final. No event follows final; transport exhaustion alone is never finality. |
| TTS | `speak({ text, voice, format, language? }, options): AsyncIterable<Uint8Array>` yields audio in the negotiated format. Even a nonstreaming provider uses this iterator, yielding its completed payload. Exhaustion includes terminal settlement. |
| Aligned TTS | Optional `speakAligned(request, options): AsyncIterable<{ audio, textEnd }>` replaces `speak` for that invocation. `textEnd` is a nondecreasing UTF-16 offset into the exact request text, never inside a surrogate pair. After the entire chunk is confirmed played, `text.slice(0, textEnd)` is a conservative heard prefix. A chunk may advance no text. |

STT declares `capabilities: { streaming, partialTranscripts, languages }`;
`streaming: true` requires `stream`, and partial transcripts require streaming.
TTS declares `{ streaming, languages, heardPrefix: 'unavailable' | 'aligned' }`;
`aligned` requires `speakAligned`. Languages are explicit case-insensitive tags
such as `de` and `de-AT`, with no wildcards, duplicates or automatic regional
fallback. Empty languages promise no language support. Validators check port
shape and declaration consistency; they do not establish provider qualification.
`voiceCompositionCapabilities(stt, tts)` returns their language intersection,
separate STT/TTS streaming flags, partial transcript support and the TTS
heard-prefix ceiling. It makes no claim about transport or playback behaviour.

A composed pipeline binds these ports through `VoicePorts.components`, delegates
reasoning through `VoiceReplyExecutor`, and implements the existing `LiveVoice`
and `VoiceSession` contract. It publishes all live-voice command capabilities in
its `LiveVoiceDeclaration`: unsupported commands reject with `unavailable`.
It must declare `heard: 'unavailable'` when alignment or trusted playback receipts
are missing, and must never turn generated or merely delivered audio into a
`heard` event. The prototype's `sendText` and `heard` remain unavailable. Losses
such as no partial transcripts, buffered TTS or fewer languages must be reflected
in the pipeline's model/host declarations; component support is an upper bound.
Only trusted server transcript finality may authorize delegated reasoning;
browser transcript receipts carry no admission authority.

Every transcription, synthesis fragment and retry receives a fresh
`ComponentOperationOptions` with `{ signal, deadlineAt, attempt, report }`.
`attempt` contains nonempty `attemptId` and `claimId`, a nonnegative safe-integer
`maxMicro`, and `consume()`. Claims and whole USD micro-dollar charges are
separate from the aggregate duration claim and from reasoning token accounting.
A host admits each request against its own budget and current consent, then
`componentInvocation(options, { role, unit, model })` awaits `consume()` before
returning permission to `dispatch()` exactly once immediately before outbound
provider work. The host's consume callback checks fresh ownership/consent;
this helper does not grant consent or reserve money itself. Retries cannot reuse
an attempt. A composed call must not charge the same component spend again as
an aggregate duration cost.

Call `usage(quantity, upstreamMicro, source, estimated = true)` only after
dispatch, with finite nonnegative quantity and safe-integer nonnegative cost.
`assertComponentUsage` also validates attempt identity, role (`stt`, `reasoning`,
`tts`), unit (`seconds`, `tokens`, `characters`, `bytes`, `credits`), source and
estimate flag. `finish(true)` reports completed usage at that cost; all other
after-dispatch outcomes, including missing completion evidence, cancellation,
timeout and invalid usage, report `uncertain` with `chargedMicro` at least
`attempt.maxMicro` (and at least any observed valid higher cost). Over-ceiling
usage throws `limit` and retains uncertainty. Never replace unknown cost with
zero. Before dispatch, finish/abort/failed consume reports cancelled zero usage.
Only `rejectWithoutUsage(status)` for a transport-observed 4xx rejection with no
usage, excluding 408 and 499, releases a dispatched reservation. A provider error
payload alone is insufficient evidence. A host must retain the admitted maximum
for missing/uncertain terminals until trusted reconciliation; report errors do
not authorize re-dispatch or another terminal.

`finish(completed)` is idempotent and returns the same promise; first settlement
wins, including abort/deadline and synchronous report callbacks. Signals and
absolute deadlines bound consume and iterator reads even when injected ports
ignore cancellation. Providers must close their transports in `finally` and
finish accounting when consumers return early. `boundedEvents(source, options)`
bounds each read and attempts iterator cleanup under a separate one-second
lease; it cannot force an uncooperative upstream to close.
`audioQueue(limit = 960_000)` is a single-consumer byte-bounded producer queue:
`push(entry)` transfers ownership of bytes or a host-owned playback envelope
with a positive safe-integer `byteLength`; the caller declares the full retained
audio size. The generic `AudioQueue<T>` preserves envelope metadata.
`end()` drains pending bytes,
`clear()`/iterator return discard them, and overflow throws `limit`. It does not
resample, frame audio or pace playback. `TTS_MESSAGE_BYTES` (1 MiB decoded),
`TTS_WIRE_CHARACTERS` (base64 plus metadata) and `TTS_SPEAK_BYTES` (16,000,000)
are independent ceilings that adapters enforce. Hosts enforce smaller transport
and playback bounds where needed.

AIT-319 adds reusable conformance kits separately. This API's fake-only unit
coverage is not provider qualification or evidence of a second released pipeline.


### Core subpath decisions (AIT-202)

The #173 release candidate already exposes the subpaths below. Each is retained
because an actual production module consumes it; none is added speculatively.
These are explicit public contracts, not permission to import arbitrary `src/`
files. The root remains the normal host entrypoint. AIT-202 adds no core or
server package subpath. The public server `/local-voice-identity` retains only
`isLocalVoice`; AIT-218's always-throwing `markLocalVoice` compatibility export is
removed in this release. Hosts cannot enroll providers as the simulator.

| Core subpath | Keep reason and actual consumer |
| --- | --- |
| `./understanding` | UI session understanding model. |
| `./readiness` | UI session readiness model. |
| `./live-voice` | Server voice handlers and composed provider lifecycle. |
| `./extractor` | Server upload admission and extraction adapters. |
| `./extractor-process` | OOXML/PDF/text subprocess adapters. |
| `./extractor-zip` | OOXML child ZIP safety checks. |
| `./invocation` | Server coordinator, UI reply audio and provider admission errors. |
| `./session` | UI session-element and email session state. |
| `./ui-html` | Host HTML setup and UI HTML rendering contract. |
| `./reply` | UI session and ElevenLabs facade reply delivery. |
| `./prompts` | UI session prompt construction. |
| `./document-context` | UI session document context. |
| `./text-origin` | UI session and ElevenLabs facade origin tracking. |
| `./presets` | UI session and composed/ElevenLabs feature configuration. |
| `./settings` | Server handlers and UI settings/consent controls. |
| `./ai-notice` | UI locales and ElevenLabs host notice/options. |
| `./voice-lifecycle` | Server composed coordinator and UI session lifecycle. |
| `./reply-replay` | UI page replay and ElevenLabs/fake-voice clients. |
| `./voice-lifecycle-controller` | UI audio rail and provider clients. |
| `./cost` | Server budget and ElevenLabs speech/server costing. |
| `./plugins` | Provider manifests and server coordinator deepFreeze. |
| `./plugin-contract` | Codex-imagegen declaration contract (types only). |
| `./safeguards` | ElevenLabs facade safeguards. |
| `./reasoning` | Device adapter and ElevenLabs facade operation scopes. |
| `./reply-opener` | ElevenLabs facade opener delivery. |
| `./chat-completions` | Device adapter chat protocol. |

## Actor role choice (AIT-281)

The host owns the role labels and the optional `account` slot content. The module
owns only the four `ACTOR_ROLES` ids (`private`, `company`, `representative`,
`agency`), the authenticated command and the presentation mechanics. There are
no default or example role labels in the product.

Enable the server capability with `host.identity.chooseRole = true`. In the
component's `configure` options, supply `host.actorRole.labels`, a map from locale
(`de` / `en`) to a complete map from those four ids to host-owned label strings.
All four current-language labels and the server capability are required; when
either is missing, there is no role control. Labels are inserted as text. The
footer reserves the widest supplied label in the current language, including
the inferred marker, across all command states.

Use the existing light-DOM `slot="account"` for the host's account content. When
the role control is available, that slot appears only in the desktop popover;
when absent, no account line appears. The phone role sheet has no account line.
No address, verification claim or account label is invented by the module. The
phone gear opens the role section and an entry to the existing AI processing
settings. On desktop, the role trigger follows the AI notice in the left footer
group. Missing capability hides the role section; the phone sheet retains its
AI processing entry.

`GET /api/sessions/:id/identity` returns an owner-only `roleChoice` projection:
`{ available, roles, role, source, reasoning, revision }`. `source` is `chosen`
or `inferred`; `role` may be null before a usable inference or choice exists.
The session snapshot includes the same projection when the capability is enabled.
`revision` is the current durable session sequence; unrelated durable events can
also make a previously displayed list stale. Account content and role labels
are never accepted in this command or exposed through a new public endpoint.

Send `POST /api/sessions/:id/identity/role` with
`{ role, baseRevision, clientEventId }`, using the existing owner cookie or
`x-aithema-session-token`. `role` must be one of the offered ids;
`baseRevision` must be the nonnegative integer from the projection;
`clientEventId` must contain 1–128 ASCII letters, digits, `_` or `-`. The server
checks ownership before capability, parsing or state changes. It atomically
persists the choice, its private receipt and its identity event. A successful
response is `{ roleChoice, replayed }`. Repeating the same id and role returns
the current projection without another event, including after a process restart.
Reusing an id for another role returns HTTP 409 `role-event-conflict`.

A stale base returns HTTP 409 `role-conflict` with the refreshed `roleChoice`;
it makes no role change. Missing capability returns HTTP 503 `role-unavailable`;
invalid bodies return HTTP 400. A conversation accepts up to 500 unique role
commands, then returns HTTP 409 `role-command-limit`. A choice has no paid or
external effect and does not require address collection. It wins over later AI
inference. Withdrawal, consent reset, erasure and conversation reset forget the
choice; stored role content uses the existing erasable actor-content class,
separately from verification facts. Private role receipts clear with that content.

The UI keeps the acknowledged footer value during saving, restores the previous
checked role after an error, and refreshes the list after a stale response. A
network retry retains its client event id. Arrow keys move focus without writing;
Space, Enter or a pointer selection commits, including confirmation of the checked
inferred role. Escape returns focus to the trigger; outside clicks and Tab-out
close the desktop popover. A phone save keeps the sheet open with its saved notice.
