# Aithema 2026.10

Version **261019093518.0.0**. Licensed under **AGPL-3.0-only**.

Eighth October release: a second voice, Grok Voice by xAI (not yet qualified in live use), and a privacy fix for HTML drafts.

## What START and visitors notice

- **Withdrawing one consent item clears its content (AIT-364 / START-550):**
  withdrawing only “HTML drafts” removes displayed drafts within one consent
  refresh, in every tab that receives the change. Withdrawing only “Images” does
  the same for images. This also applies while another consent item remains
  granted. When the component cannot confirm current consent, it hides the
  affected content rather than leaving it visible.
  **Deutsch:** Wird nur die Zustimmung zu „HTML-Entwürfen“ oder „Bildern“
  zurückgezogen, verschwinden die jeweiligen Inhalte innerhalb einer
  Aktualisierung des Zustimmungsstands in jedem Tab, der die Änderung erhält.
- **A second, selectable voice (AIT-317, packages 1–8):** Grok Voice by xAI is
  **not yet qualified in live use**. Settings lets visitors switch providers and
  shows the recipient and processing detail. Switching can end the current call;
  it never starts a new paid call automatically. Typed turns and call lifecycle
  stay attached to the current call. Interrupted replies keep their complete
  text and show **Unterbrochen** / **Interrupted** (AIT-348/349/350).
- **Reload for HTML drafts (AIT-358):** when a preview fails, its failure message
  now offers Reload. Each attempt requests a fresh preview capability.

## For hosts

### Optional second voice: Grok Voice — not yet qualified in live use

The new `@inspr/aithema-plugin-grok-voice` package joins the release closure with
exact core/server dependencies, supported component and client exports, and the
server's coordinator, accounting, relay, browser helpers and capture worklet
(AIT-351). It remains **not yet qualified in live use**. The pipeline is
**xAI STT → Aithema's admitted reasoning → xAI TTS**; Aithema owns the answer.

Register `createGrokVoiceProvider` and the separate reasoning plugin with the
runtime, configure the parent and both speech component bindings, and mount the
authenticated relay and voice controls. Start requires current ownership, consent,
account and budget admission. Use **`voice-xai` v1**, with the manifest's exact
DE/EN text, plus separate reasoning consent. The recipient is **SpaceXAI LLC
(“SpaceXSI”)**, US seat. Processing is international with **no guaranteed region**;
the US recipient seat is not a processing-location promise.

Owner-use setup requires an xAI account with voice access and **Zero Data
Retention switched on**, plus a **server-side secret reference** in the private
binding. Supply opaque `accountRef` and `secretRef` references and dated,
unexpired account evidence for ZDR, DPA, retention, transfers, contract and
approval. Resolve the reference only on the server after admission. Never put a
key or account evidence in browser configuration or documentation. Public policy
and synthetic fixtures do not prove a particular account is ready for real speech.
See the [host setup](https://github.com/inspr-at/aithema/blob/v261019093518.0.0/docs/embedding.md#grok-voice-host-setup-and-release-imports-ait-351)
and [private configuration contract](https://github.com/inspr-at/aithema/blob/v261019093518.0.0/plugins/grok-voice/README.md#private-configuration-contract).

### Charging, recovery and interruption

For the optional Grok Voice pipeline (**not yet qualified in live use**), bind
the parent with `maxMicro: 0` and `upstreamMicroPerMinute: 0`, its own visitor
tariff and a bounded call duration. Bind STT/TTS separately to the admitted
model, endpoint, account, secret reference and legal evidence. Visitor charging
uses active duration **measured by Aithema**, excludes acknowledged pauses and is
confirmed at close. Upstream STT/TTS are separate, fresh child claims for every
utterance, fragment and retry. They remain **estimated** until a billed-cost
receipt. TTS counts the Unicode code points actually sent, including spaces and
emoji constituents.

Cancel, timeout, abandonment and uncertain recovery retain consumed reservations;
closing the parent cannot release unresolved children. Recovery needs fresh
authorization, epochs and child claims and never replays old synthesis. Pause
holds capture until the matching resume acknowledgement; retrying playback unlock
does not dispatch new speech work.

The approved interruption difference is deliberate: xAI reports **no heard
position**. Keep the full generated reply, mark it **Unterbrochen** / **Interrupted**,
and tell the model that heard length is unknown. Never infer a heard prefix from
browser timing. ElevenLabs keeps its existing heard-prefix correction.

### Browser modules and displayed content

Grok Voice (**not yet qualified in live use**) and composed browser helpers in
the source-hosted demo load natively from relative same-origin module URLs under
`script-src 'self'`, without an import map; startup uses external modules.
Packing rewrites cross-package URLs to declared package subpaths. Installed
package consumers still need a bundler or, when unbundled, an import map; an
inline map needs its exact CSP hash. Serve the shipped `pcm-capture-worklet.js`
beside the server's browser-audio module.

The partial-consent fix is inside the component. Keep propagating consent,
erasure and session changes so every tab can remove affected content. Reload
uses the existing owner-authenticated preview mint route and requests a fresh,
single-use capability every time. The RC7 canonical preview route and strict
frame policy remain required; see the embedding guide for the complete policy.
The preview guarantee remains **no network; a self-reload is refused**.

## Breaking for hosts

**None relative to RC7 (`v261019003029.0.0`).** Grok Voice (**not yet qualified
in live use**) is opt-in; existing providers keep their integration. The consent
fix is component-internal and Reload uses the existing mint API. Hosts choosing
the new provider must supply its bindings, account evidence and consent. Hosts
upgrading from before RC7 must still apply RC7's preview embedding changes.

## What is included

Aithema provides embeddable conversation modules: core state and plugin contracts,
server Web Request handlers and a Node HTTP adapter with SQLite persistence,
and UI components including `<aithema-session>` and isolated HTML previews.
Hosts supply authentication, ownership, storage, consent and budget policy.

The sixteen packages are `@inspr/aithema-core`, `@inspr/aithema-server`,
`@inspr/aithema-ui`, and
`@inspr/aithema-plugin-{openrouter,mistral,device,elevenlabs,grok-voice,openai-images,claude-html,codex-imagegen,extract-text,extract-pdf,extract-ooxml,mail-smtp,zitadel-oidc}`.
Grok Voice is **not yet qualified in live use**. Provider credentials are supplied
by the host; none are bundled. The device preset supports browser text only.
EU processing requires qualification of the specific account and route, plus
current consent.

Release assets include module tarballs, a source/workspace archive, dependency
locks, an SPDX SBOM inside the workspace archive, and `release-set.json` with
source provenance and artifact digests. The workspace root is not installable.

## Verify and install

Download the assets for `v261019093518.0.0` into a clean directory:

```sh
gh release download v261019093518.0.0 --repo inspr-at/aithema
for asset in SHA256SUMS release-set.json consumer-evidence.json \
  consumer-package-lock.json deployment-pin.json *.tgz; do
  gh attestation verify "$asset" --repo inspr-at/aithema
done
sha256sum --check SHA256SUMS
```

Require every verification command to succeed before installing. On macOS, use
`shasum -a 256 --check SHA256SUMS` for the checksum step. These checks apply to
**the published assets**. `consumer-evidence.json` binds the tested package
digests to the published manifest and source commit; earlier preparation
artifacts are not release checksums.

Install all sixteen module URLs together so their exact internal dependencies
resolve without registry publication. From the directory containing the verified
manifest, run this in your host project (adjust the manifest path as needed):

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('./release-set.json', 'utf8'));
const base = 'https://github.com/inspr-at/aithema/releases/download/v261019093518.0.0/';
const urls = manifest.artifacts.filter(a => a.kind === 'module').map(a => base + a.path);
execFileSync('npm', ['install', '--save-exact', ...urls], { stdio: 'inherit' });
NODE
```

Commit the host's `package-lock.json`: its release URLs and `sha512` integrity
values pin the downloaded tarball bytes. The verified
`consumer-package-lock.json` records the release consumer's tarball integrity
values for comparison. Use `npm ci` for subsequent installs. Retain the verified
assets, manifest and deployment pin for rollback to those exact bytes.

## Compatibility and known follow-ups

The split modules replace the private 0.10.1 monolith and break its API. There is
no automatic legacy API or database conversion. Adapt host integrations to the
module handlers and components, and retain the previous deployment and database
backup separately. The plugin protocol `apiVersion: ^1.0.0` is independent of
the product version.

- Grok Voice is **not yet qualified in live use**. Evidence is synthetic and
  offline; it does not establish live acoustic quality, German speech quality,
  latency, disruption recovery, billed upstream costs or real account readiness.
  The plugin README records the dated public evidence and its limits.
- A 60-minute German/English live voice soak has not been measured.
- Browser consumers need a bundler or import map and module JSON support.
  Consumer smoke checks do not establish host-specific layout or CSP enforcement.
- Further legal formalisation remains follow-up work; this release grants no
  rights beyond its included licence and rights/provenance notices.

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261019093518.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
