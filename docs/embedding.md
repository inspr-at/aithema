# Embedding Aithema

The first reset candidate uses **INSPR-CalVer3**; `release/version.json` is the
single version authority. The root workspace is private. The release packer
emits independently installable core, server, UI and twelve provider/integration
plugin tarballs, with exact dependency pins, plus a retained workspace archive.
No reset package has been published. Node.js 24 or newer is required.
See [candidate notes](../release/notes.md) and the [GitHub release route](../release/README.md).

## Consume Aithema as a module (START or another thin host)

On the build runner, retain the candidate directory and its manifest digest.
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

After OPS publishes the immutable GitHub release following Markus's Desk go,
install the same fifteen modules by release URL in one invocation, rather than
from a package registry. The URL pattern is:

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

## Host retention contract

Use `await handlers.retire({ before, limit: 100 })` to erase **whole idle
sessions**, without possessing visitor tokens. `before` is a nonnegative Unix
millisecond timestamp; eligibility is strictly `lastActivity < before`. `limit`
is an integer from 1 to 1000 (default 100). The result is `{ retired, failed, more }`:
`retired` counts completed core erasures; `failed` counts sessions that failed
this call; `more` means another eligible or due retry batch exists. Repeated and overlapping calls are safe. An interrupted
retirement is durably queued and retried, including the host cleanup hook.
Hooks must therefore be idempotent. A failing session stays tombstoned and
pending with a durable attempt count and exponential backoff (1 second up to
1 hour); the batch continues. Deferred retries do not set `more`: call again
on the maintenance schedule even when `more` is false. Monitor `failed`;
host failures can delay deletion beyond the intended retention window.

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
full erase. Unreconciled deployment holds remain conservatively charged in
aggregate; their deleted receipts can no longer be reconciled. Retained totals
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
existing one-minute schedule and 365-day cutoff, retiring at most 100 sessions
per tick. The older `expire(before)` only withdraws old turns/uploads; it is not
a full-erasure contract. Both sweeps query an indexed live-session set, excluding
tombstones and retired sessions without scanning historical session rows.

## Web components

A browser build needs an import map or bundler resolving workspace package
specifiers, plus module JSON support for the bundled display config. Serve JS
as JavaScript and JSON as `application/json`; Node's package exports do not
configure browser resolution. The UI does not install providers on import.

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
const element = document.createElement('aithema-session');
element.configure({ copy: en, session, sessionToken: token, baseUrl: '' });
document.body.append(element);
// Import registers <aithema-session> and <aithema-html-preview>.
// createVoiceControl handles neutral voice commands; supply adapter clients separately.
// Use HTML_PREVIEW_HOST_CSP when serving pages that embed generated HTML previews.
```

`configure({host})` enables selected library, verification, handover, credits,
locale and operator UI slots. It supplies presentation only; the server ports
still authorize every action. `voiceClients` maps allowed option IDs to browser
adapter clients; `voicePresentation` supplies that adapter's label and copy.
The visible product name stays **Aithema 2026.10**. `host.version` may carry
`version`, `version_scheme`, `commit` and `date` from the immutable manifest;
the exact coordinate appears in the existing hover/focus details only. CalVer3
uses the pinned shared Pretty renderer there, with canonical copy, UTC tooltip,
keyboard/touch interaction and reduced motion. The popup shows the notice, then
`Version 26.10.14 · 08:00` on its own line, followed by muted UTC build details.
Tick’s approved separators are passed to the shared renderer by the product
adapter, with weight 1 for hours/minutes and dark ink for segments/separators;
the upstream bundle and base config stay pinned. `release/presentation.json`
records these intended product overrides. Copy confirmation replaces the
version in a reserved slot for 1.2 seconds. Unknown schemes hide only the
version row and log once, leaving the session usable. Auto colors use the host branding;
`host.version.display: "semver"` selects the full reduced coordinate in that same
popup, with the same canonical-copy interaction. Legacy details remain plain.

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

For the plugin contract and the text, voice and image onboarding steps, see
[Adding a model](plugins.md#adding-a-model). The standalone external package proof
uses host configuration and public exports without core or server changes.

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
one UTC second with `status: reserved`, sequence 12 and scheme `inspr-calver-3`.
`reserveVersion` accepts explicit candidate authorization separately from a
publish go. A candidate reservation authorizes no tag or registry publication.
The fixed `dry_run_version` remains test input only. Reuse it in every
output; build machines never choose their own coordinate. The channel's next
reservation must be strictly later; a same-second collision waits for the next
second. Retain the candidate source commit and manifest digest; rebuild that exact commit
with the same toolchain. The source-commit argument to `release:pack` allows that
reproduction after evidence-only commits. Changed product bytes require a new
candidate and a new coordinate before publication.

New reservations declare `inspr-calver-3` (**INSPR-CalVer3**),
`YYMMDDhhmmss.0.0`; npm accepts this syntax. MINOR/PATCH stay zero and caret/tilde
compatibility semantics do not apply. The packer derives package versions,
exact internal dependency pins, lock entries and public plugin manifest versions
without changing the development
workspace manifests. External dependencies retain their exact lock closure.

The historical release-order mapping is in `release/history.json` (the 11
existing v0.x releases, ending `0.10.1`). It establishes ordinal 11 as the legacy
anchor and ordinal 12 as the first reset release. The first calendar coordinate
remains unset until actual reservation. Mixed-era ordering requires the explicit
anchor/channel/ordinal. The archived `legacy-semver-public` and `legacy-semver-private` declarations are explicitly accepted as legacy types and preserved verbatim; the new history mapping never rewrites their manifests. CalVer2 history remains readable as its own declared
identifier; v1 dates and legacy stable SemVer remain tagged types. No old tag,
release, artifact or signed attestation is renamed, rewritten or republished.

The existing PR unit job also acts as the dry-run job, retaining the seven CI checks. It runs `release/dry-run.mjs`: pack twice, compare exact bytes and manifest,
verify every member, no upload. `release.yml` can build only on an already pushed
tag, requires its commit to be an ancestor of `origin/main`, and checks that its exact name matches the reserved version before building
one workspace tarball. Manual dispatch on a branch skips the pack job. The
workflow has no npm/forge publication or tag-creation step. Its upload is only
an ephemeral CI transfer after a future tag; it does not retain a forge release.
Canonical release bytes use Node 24/GNU tar in CI. Byte reproducibility is
verified per runner; reproducibility across machines is out of scope. BSD tar
can prove two local packs identical but is not claimed to reproduce GNU bytes.
Rollback reuses the stored bytes.

The release set records source commit, source tree/lock digests, all member
digests, package coordinates, version scheme/channel/sequence and the packing
run. The commit checks page references real CI/merge-queue validation; packing
is not a validation run. Canonical runtime metadata is also generated inside
the server package, so it does not depend on the repository-level `release/`
directory when distributed separately. Preserve the tarball, manifest and later signatures together. Runtime
metadata and exported ZIP generator provenance use the artifact's source commit,
not a caller-supplied replacement. AI notice, text producer identity,
AI-generated/manipulated disclosure and image/HTML sidecars stay intact.

Rollback takes a retained trusted release-set manifest and an exact
`(channel, version, artifact coordinate, sha256)` through `rollbackArtifact`.
It verifies retained bytes and records a new deployment event without rebuilding,
decrementing, reusing, or moving the release coordinate. A rollback fix is a new
later release. Dry-runs cannot serve as production rollback evidence. Existing
legacy rollback continues through the original immutable v0.x artifacts.

## Qualification checklist — pending release inputs

Merged implementation and deterministic tests prove code delivery. They do not
prove measured provider performance, exchangeability, live deployment or adoption.
The independent cross-family review remains pending and is not run by the builder.
The value-free migration inventory is `release/inventory.json`, owned by AIT-32.

- [ ] Controller review of the version inventory, consumers, legacy anchor and compatibility window.
- [ ] Independent review of the exact shared presentation source/config/manifest pins in `release/presentation.json`; reproduce the closure with upstream `scripts/versioning-bundle.mjs <full-source-commit> <config-sha256> <new-directory>` on the build runner. The source repository is private: public PR CI verifies the pinned offline closure, and never obtains broader source access or new credentials. A build runner with that exact source checkout can use `node release/verify-upstream-presentation.mjs <source-checkout>` to regenerate and compare all bytes. That independent source re-export/pin review remains pending, and the payload is not adoption evidence.
- [x] Reserve the first candidate coordinate; build all package tarballs twice and verify identical digests (`release/candidate.mjs`).
- [x] External consumer imports every documented symbol and runtime export, mounts handlers and web components, locks dependencies, updates the dependency pin and rolls back retained candidate bytes (`release/consumer.mjs`). This is scratch-host evidence, not a START production deployment.
- [x] Wire tag-only GitHub artifact attestation (`.github/workflows/release.yml`); signed bundles are produced only by a future authorized tag build.
- [x] AIT-139: **60-minute soak not measured** (Markus: “Kein Test”); explicitly stated in the release notes, not a release blocker.
- [x] AIT-160: **second voice pipeline not yet proven** (parked); explicitly stated in the release notes, not a release blocker.
- [ ] Independent presentation pin review stays with the cross-family gate.
- [ ] Markus's separate Desk publish go; no tag, GitHub release or registry publication is performed here.

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
The composed-voice adapter remains an internal proof without a package manifest.
The AIT-200 external-plugin fixture uses public core/server imports and its own
relative adapter import; it is served by a separate test host, outside the demo
module graph. The new ElevenLabs components are internal package implementation
files, and the demo does not import them directly. Neither needs a demo guard
exception or a new public export.
The unexported ElevenLabs `components.js`, server composed coordinator and core
component helpers remain in the workspace/source archive alongside the Voxtral
proof. They are omitted from module tarballs. Exact source-to-target proof edges
in the boundary checker retain their internal imports while avoiding a public
composed-component API. Neither `/composed-voice` nor `/voice-components` is
exported. The packer rejects admitted runtime modules that import unpublished
code. See [next-release notes](../release/next-notes.md) for the identity API change.


### Core subpath decisions (AIT-202)

The #173 release candidate already exposes the subpaths below. Each is retained
because an actual production module consumes it; none is added speculatively.
These are explicit public contracts, not permission to import arbitrary `src/`
files. The root remains the normal host entrypoint. AIT-202 adds no core or
server package subpath. The public server `/local-voice-identity` retains only
`isLocalVoice`; AIT-218's always-throwing `markLocalVoice` compatibility export is
removed in the next release. Hosts cannot enroll providers as the simulator.

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
