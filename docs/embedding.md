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
`GET /api/sessions/:id/events` supplies durable SSE replay; `/export` downloads
the provenance-preserving ZIP. See the root README's route tables for commands,
settings, uploads, withdrawal, concepts, and host routes.

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

## Host ports and presets

Hosts supply `identity`, `library(ownerToken)`, `handover(ownerToken)`,
`wallet(ownerToken)`, `credits`, and their authoritative `consent.coverage` port.
Identity verification must be delivered and checked by the host. Enabling
`policy.verificationRequired` requires `identity.deliversVerification === true`
and actual verification methods. Host collection requires a configured privacy
document. Pass the same consent port to handlers and plugin runtime. Consent,
budgets, ownership and pause are checked before every dispatch.

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
specifiers. `test/demo-package-imports.test.js` enforces that explicit exception
list. Existing static routes continue to serve package component dependencies.
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
The unexported ElevenLabs `components.js` also imports
`plugins/composed-voice/src/component.js`, which has no publishable package.
It stays in the workspace/source archive alongside the existing source-only
composed coordinator and Voxtral proof, and is omitted from the ElevenLabs
module tarball. No current package export or demo entrypoint imports it. This
keeps the proof and its tests while avoiding a public composed-component API
in this candidate. The packer still rejects any admitted runtime module that
tries to import an unpublished dependency.
