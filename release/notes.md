# Aithema 2026.10

Version **261018104037.0.0**. Licensed under **AGPL-3.0-only**.

Fourth October release: concept images now stay within your spending cap.

## What START notices

- **Concept images through the spending cap (AIT-306/308 / START-549):** image
  generation and edits reserve room in the host's shared OpenRouter cap before
  being sent, refuse when the cap is reached, and charge what the provider
  reports. This unblocks START-549. Direct OpenAI images can share the cap too,
  using the host's admitted image price or the reserved ceiling.
- **Phone voice status (AIT-302):** shorter status lines keep their meaning and
  leave room for the header controls.
- **Budget and credits (AIT-310):** phones distinguish the host's budget from
  your credits, including when the host offers no upgrade action.
- **Readiness (AIT-307):** when only text input is available, the card shows
  “Input: Text” instead of a half-empty switch.
- **Footer fit (AIT-309):** controls fit more reliably on sites with legal links.

## For hosts

- **Shared image spending cap:** pass the same `createSpendCap` instance as
  optional `spendCap` to `createOpenAIImages` and reasoning. It works in
  OpenRouter gateway and direct OpenAI modes, including after `bind()`.
  Each generate/edit request reserves `binding.maxMicro` before dispatch;
  exhaustion or a latched ceiling breach refuses with `not-admitted`.
- **Image charges:** OpenRouter settles reported `usage.cost`, rounded upward
  to microUSD. Direct mode uses the host's admitted per-call `imageCost` with
  response usage tokens; without that price, it charges `binding.maxMicro`.
  The server passes the private price from `createImageBinding` to generation
  and edits. Common `binding.rates`, including zero placeholders, never price
  capped images. Unknown dispatched outcomes retain uncertain holds; failures
  before dispatch release at zero. Omitting `spendCap` preserves existing behavior.
- **Cap bookkeeping:** the README now documents `dispatch`, `record` and
  `uncertain` on the existing `createSpendCap` port, attempt/provider metadata
  on `reserve`, and `uncertainMicro` in `snapshot()`. Separate instances may
  share the same account and database. The routing allow-lists and analysis
  exclusion documented for reasoning do not apply to image requests.
- **Public packages:** the fifteen package export maps and subpaths, and plugin
  protocol `apiVersion`, are unchanged since `v261017195050.0.0`.
- **Maintenance (AIT-301/311/312/313):** stronger regression checks and steadier CI.

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

Download the assets for `v261018104037.0.0` into a clean directory:

```sh
gh release download v261018104037.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261018104037.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261018104037.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
