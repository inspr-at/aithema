# Aithema 2026.10

Version **261017195050.0.0**. Licensed under **AGPL-3.0-only**.

Third October release: OpenRouter concept images, more accessible controls, complete retirement of erased conversations, and steadier limits and footer controls build on the second October release.

## What START notices

- **Concept images through OpenRouter (AIT-300 / START-549):** hosts can route
  image generation and edits through their existing OpenRouter account, with
  inline image results and provider-reported spend.
- **Accessibility (AIT-293):** consent labels now have accessible group names,
  following the WCAG 2.2 AA axe sweep. The sweep covers the component shell and
  isolated draft preview; generated content still needs its own checks.
- **Erased conversations (AIT-295/297):** erased and library-deleted conversations
  enter complete retirement without another idle window. Removal waits for
  pending accounting, host cleanup and successful maintenance; content stays erased.
- **Concept storage (AIT-296/299):** viewed-state storage is read only when visuals
  are bound and a concept appears or opens. Concept controls recover on re-attach.
- **Limits and settings (AIT-292):** the one-hour limit announces once, without a
  duplicate toast. Unrated quality and cost vials stay neutral with a “–”.
- **Stable footer and limit announcements (AIT-299):** safe label expansion waits
  while a control is hovered or focused, keeping it under the pointer. Resizes
  and growing labels refit immediately to avoid overlap. Late credit receipts
  no longer clear an active host limit or repeat its announcement.
- **Phone links (AIT-297):** host-limit actions fit at 390 px and reserve stacked
  targets on narrower phones. Demo legal links keep usable targets across
  languages and pointer modes.

## For hosts

- **OpenRouter image binding:** use `createOpenAIImages` with plugin
  `openai-images`, model `openai/gpt-image-2`, effort `none` and endpoint
  `https://openrouter.ai/api/v1`. Reuse the server-private key resolver via
  `secretRef`; optional `routing.referer` and `routing.title` supply attribution.
  Supply account-specific legal evidence and consent covering both OpenRouter
  and OpenAI. Gateway results must contain inline PNG/WebP bytes; URL-only
  results are refused. Provider `usage.cost` is authoritative; missing or invalid
  cost remains uncertain rather than free. Qualification remains unverified.
  See [OpenRouter image bindings](https://github.com/inspr-at/aithema/blob/v261017195050.0.0/docs/embedding.md#openrouter-image-bindings).
- **Retention:** keep `handlers.retire` on a maintenance schedule and run it at
  startup, including when `more` is false. Existing databases backfill erased
  tombstones in bounded batches. Cleanup hooks must be idempotent. Privacy copy
  must describe accounting deferrals, retries, host cleanup and separate
  host/provider retention; complete deletion has no unconditional time guarantee.
  See the [host retention contract](https://github.com/inspr-at/aithema/blob/v261017195050.0.0/docs/embedding.md#host-retention-contract).
- **Legal-slot targets (AIT-297):** direct `<a slot="legal">` anchors receive the
  module's 44 px targets. Nested anchors in a slotted wrapper remain host-owned:
  give each at least 24×24 CSS px, and 44×44 px on touch. The
  [embedding example](https://github.com/inspr-at/aithema/blob/v261017195050.0.0/docs/embedding.md#web-components)
  shows the required host CSS.
- **Public packages:** the fifteen package export maps and subpaths are unchanged
  since `v261017133413.0.0`. The shared `Terminal` type now permits optional
  token `usage` on an `uncertain` result, preserving known usage without claiming
  a settled cost. Plugin protocol `apiVersion` is unchanged.
- **Maintenance (AIT-298/299):** steadier CI cleanup and diagnostics, with detailed
  unit handle tracing available on request.

## Breaking for hosts

- **Image endpoint admission (AIT-300):** direct `gpt-image-2` bindings now accept
  only `https://api.openai.com/v1` on non-loopback hosts. Previously accepted
  custom proxy hosts are refused. Use the admitted direct endpoint or the OpenRouter
  binding above. An explicit `baseUrl` must match the binding; endpoint queries,
  fragments and credentials are refused. Loopback endpoints remain available
  for offline fixtures.

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

Download the assets for `v261017195050.0.0` into a clean directory:

```sh
gh release download v261017195050.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261017195050.0.0/';
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
- A second independent voice pipeline remains unproven. Source-only composed
  voice prototypes are not supported package APIs.
- Browser consumers need a bundler or import map and module JSON support.
  Consumer smoke checks do not establish host-specific layout, CSP enforcement
  or live provider quality.
- Further legal formalisation remains follow-up work; this release grants no
  rights beyond its included licence and rights/provenance notices.

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261017195050.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
