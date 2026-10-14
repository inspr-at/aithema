# Embedding Aithema

The reset generation is **release preparation only** (AIT-105/AIT-32).
No reset package has been published. Development packages remain private at
`0.0.0`; examples resolve the current workspace exports on Node.js 24 or newer.
The future workspace tarball contains core, server, UI, all shipped plugin
sources, the demo host, the dependency lock, rights notes and release provenance.
It is one workspace artifact, rather than independently published npm packages.
Extract a verified artifact, enter `package/`, and use `npm ci --omit=dev` to
install its locked runtime dependencies. A consumer installing from npm will
need the separately authorized publication and package-layout decision first.

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
keyboard/touch interaction and reduced motion. Auto colors use the host branding;
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

`release/version.json` is the sole authority. It stays `legacy`, `0.0.0`,
`status: unreserved` during preparation. The fixed `dry_run_version` is test
input and never reserves a release. After Markus's separate publish go, reserve
one actual UTC second through the pure `reserveVersion` planner and persist its
returned record in that source before committing/tagging. Reuse it in every
output; build machines never choose their own coordinate. The channel's next
reservation must be strictly later; a same-second collision waits for the next
second. A reserved source cannot be edited to replace the artifact set.

New reservations declare `inspr-calver-3` (**INSPR-CalVer3**),
`YYMMDDhhmmss.0.0`; npm accepts this syntax. MINOR/PATCH stay zero and caret/tilde
compatibility semantics do not apply. The packer derives package versions,
exact internal dependency pins and lock entries without changing the development
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
tag, and checks that its exact name matches the reserved version before building
one workspace tarball. Manual dispatch on a branch skips the pack job. The
workflow has no npm/forge publication or tag-creation step. Its upload is only
an ephemeral CI transfer after a future tag; it does not retain a forge release.
Canonical release bytes use Node 24/GNU tar in CI. BSD tar can prove two local
packs identical but is not claimed to reproduce GNU bytes.

The release set records source commit, source tree/lock digests, all member
digests, package coordinates, version scheme/channel/sequence and validation
run. Preserve the tarball, manifest and later signatures together. Runtime
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
`node release/gate.mjs qualification` intentionally fails during this prep.
The value-free migration inventory is `release/inventory.json`, owned by AIT-32.

- [ ] Controller review of the version inventory, consumers, legacy anchor and compatibility window.
- [ ] Independent review of the exact shared presentation source/config/manifest pins in `release/presentation.json`; reproduce the closure with upstream `scripts/versioning-bundle.mjs <full-source-commit> <config-sha256> <new-directory>` on the build runner. The source repository is private: public PR CI verifies the pinned offline closure, and never obtains broader source access or new credentials. A build runner with that exact source checkout can use `node release/verify-upstream-presentation.mjs <source-checkout>` to regenerate and compare all bytes. That independent source re-export/pin review remains pending, and the payload is not adoption evidence.
- [ ] Reserve once after Markus's separate publish go; complete immutable candidate publication, signatures/attestation and digest retention then.
- [ ] Verify candidate package install, public representation, update path, exact deployment pin and exact-artifact rollback against that candidate.
- [ ] [AIT-139 soak report](https://aeon.barta.cm/p/AIT/AIT-139): German and English 60-minute live runs, barge-in, disruption, latency/deadline/retry/recovery measurements and final wallet reconciliation — **pending**. Offline merged part 1 is not the report.
- [ ] [AIT-160 second-pipeline qualification](https://aeon.barta.cm/p/AIT/AIT-160): independent live exchangeability proof — **pending**. Fake transport conformance is not qualification.
- [ ] Record evidence in AIT-32 before declaring CalVer3 authoritative; retain legacy readers until a separately approved compatibility change.

Public code remains **AGPL-3.0-only** throughout core/server/UI/contract/plugins.
D3 revised (2026-10-09) retains INSPR's rights and allows the planned special
licence to Augmentoring to be formalised once real customers exist. DCO alone
is not a relicensing agreement. The superseded slice-10 legal check is dropped;
this preparation creates no licence grant. See README “Ported from START” and
its rights notes for source provenance.
