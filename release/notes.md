# Aithema 2026.10

Version **261018162546.0.0**. Licensed under **AGPL-3.0-only**.

Sixth October release: interrupted HTML drafts keep their spending hold, and the groundwork for a second voice provider.

## What START and visitors notice

- **Timeouts keep the spending hold (AIT-340):** when a provider times out,
  an HTML draft keeps its reserved budget until the charge is known, so two
  drafts cannot use the same room and exceed the cap.
- **A clearer save note (AIT-327):** on wide screens, the consent editor's
  save note uses the full width and stays on one clear line.
- **Voice groundwork (AIT-323/328):** component declarations and an offline
  setup check prepare for a second voice provider; a second live pipeline
  remains unproven.
- **Regression coverage (AIT-343, PR #300):** tests now cover HTML previews under strict host security rules; this adds no runtime change.

## For hosts

- **Claude HTML settlement (AIT-340):** HTTP 408/499 without a cost receipt,
  and any 4xx response carrying usage but no cost, retain the dispatched
  reservation until a receipt resolves it, as reasoning and images do. A
  reported `usage.cost` settles the charge. Other fully received 4xx responses
  without usage still release the hold as unbilled; incomplete responses and
  5xx without a receipt retain it.
- **Image audit records (AIT-326):** the OpenRouter image adapter validates
  `X-Generation-Id` and records it on the invocation and spend reservation.
  A valid header takes precedence over the JSON `id` fallback. Header presence
  on `/images` is inferred from the provider documentation and has not been
  live-verified. Missing or invalid IDs do not affect admission or settlement;
  local attempt and reservation IDs remain available.
- **Component declarations (AIT-323):** ElevenLabs and Voxtral STT/TTS helpers
  declare streaming and languages, STT partial transcripts, and TTS heard-prefix
  support (`unavailable`). The helpers pass the offline conformance kits;
  admitted TTS tariff refusals now settle their claims before dispatch.
  These helper prototypes remain source-only and do not qualify live service.
- **Composition preflight (AIT-328):** import `preflightVoiceComposition` and
  `VoiceCompositionError` from `@inspr/aithema-core/voice-components` (also
  exported from core). Supply STT/TTS components, actual capture/playback
  formats, requested languages, a saved voice and optional capabilities.
  The promise returns checked formats, voice and effective capabilities. The
  check requires a shared requested language, validates offline voice policy,
  negotiates the exact runtime formats and refuses capabilities above the
  component ceiling. It consumes no claims, resolves no credentials and opens
  no transports. Negotiation has a one-second default deadline; callers may
  supply cancellation and an absolute deadline.
  Errors use `composition-stt-invalid`, `composition-tts-invalid`,
  `composition-capture-format`, `composition-playback-format`,
  `composition-languages-invalid`, `composition-languages-empty`,
  `composition-voice-invalid` or `composition-capabilities-exceeded`;
  cancellation and deadlines retain `cancelled` and `deadline`.
  The opt-in source-only composed-voice factory exposes a `preflight` promise;
  authorization, guarded operations and start await it before dispatch or
  parent admission. The installed live-voice factory stays unchanged.

## Breaking for hosts

**More conservative HTML timeout settlement (AIT-340):** hosts that relied on
HTTP 408/499 releasing an HTML draft's reservation can no longer reuse that
budget immediately. Keep the uncertain hold until a cost receipt resolves it;
allow for a later draft to be refused while the hold remains. This changes
runtime budget availability to protect the shared cap; no API signature changes.

## What is included

Aithema provides embeddable conversation modules: core state and plugin contracts,
server Web Request handlers and a Node HTTP adapter with SQLite persistence,
and UI components including `<aithema-session>` and isolated HTML previews.
Hosts supply authentication, ownership, storage, consent and budget policy.

The fifteen packages are `@inspr/aithema-core`, `@inspr/aithema-server`,
`@inspr/aithema-ui`, and
`@inspr/aithema-plugin-{openrouter,mistral,device,elevenlabs,openai-images,claude-html,codex-imagegen,extract-text,extract-pdf,extract-ooxml,mail-smtp,zitadel-oidc}`.
They cover text reasoning, voice, image and HTML generation, bounded offline
text/PDF/OOXML extraction, mail and identity integration. Provider credentials
are supplied by the host; none are bundled. The device preset supports browser
text only. EU processing requires qualification of the specific account and
route, plus current consent.

Release assets include module tarballs, a source/workspace archive, dependency
locks, an SPDX SBOM inside the workspace archive, and `release-set.json` with
source provenance and artifact digests. The workspace root is not installable.

## Verify and install

Download the assets for `v261018162546.0.0` into a clean directory:

```sh
gh release download v261018162546.0.0 --repo inspr-at/aithema
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

Install all fifteen module URLs together so their exact internal dependencies
resolve without registry publication. From the directory containing the verified
manifest, run this in your host project (adjust the manifest path as needed):

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('./release-set.json', 'utf8'));
const base = 'https://github.com/inspr-at/aithema/releases/download/v261018162546.0.0/';
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

- A 60-minute German/English live voice soak has not been measured. Offline
  qualification does not establish live latency or disruption recovery.
- A second independent voice pipeline remains unproven. The new component API and offline
  kits do not qualify a second live pipeline; provider prototypes remain source-only.
- Browser consumers need a bundler or import map and module JSON support.
  Consumer smoke checks do not establish host-specific layout, CSP enforcement
  or live provider quality.
- Further legal formalisation remains follow-up work; this release grants no
  rights beyond its included licence and rights/provenance notices.

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261018162546.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
