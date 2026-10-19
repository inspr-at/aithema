# Aithema 2026.10

Version **261019131804.0.0**. Licensed under **AGPL-3.0-only**.

Ninth October release: drafts stay private whatever the visuals setting, and clearer voice failures.

## What START and visitors notice

- **Draft privacy follows consent, whatever the visuals setting (AIT-369 / START-550 #2):**
  withdrawing only “HTML drafts” removes delivered HTML drafts even when visuals
  are Off or set to Images. Consent follows each delivered kind, never the
  visuals choice. Unknown or unresolved content provenance fails closed: the
  component hides content it cannot safely identify.
- **Scoped withdrawal takes effect immediately (AIT-365):** a known withdrawn
  kind disappears in the same moment the consent event arrives, in every tab
  that receives it. Privacy first when the change is unknown: affected content
  stays hidden until the change is confirmed. Other covered kinds remain usable.
- **Clearer voice failures (AIT-361):** ElevenLabs and Grok Voice show persistent
  failure messages for provider limits, lost connections and retry delays, with
  recovery controls that reflect what is available. Retry waits for the stated
  delay; visitors can continue typing. Grok Voice remains **not yet qualified
  in live use**.
- **Settings are easier to use (AIT-362):** a bottom fade shows when more content
  is below, menu labels use the full width, and the edge rule is gone. Menus
  preserve their keyboard and screen-reader behaviour.

## For hosts

The backward-compatible `consent.revised` event can include `changed`, the scope
names whose coverage changed, and `removed`, the scopes that lost coverage.
These contain scope names only, never selected item IDs or ledger values;
absent fields mean refresh through the existing path. Keep forwarding consent
events to every tab. Known withdrawals remove the affected kind immediately;
unknown changes keep content hidden until current consent is confirmed. See the
[consent event contract](https://github.com/inspr-at/aithema/blob/v261019131804.0.0/docs/embedding.md#consent-documents-in-settings)
for the revision-bound host ledger contract and fallback behaviour.

Releases are now admitted against an immutable candidate marker that binds the
exact source commit and content digest; later changes on main do not change
that candidate (AIT-363 B). Candidate evidence records the actual build host
(AIT-370); published checksums and attestations still identify the shipped bytes.

## Breaking for hosts

**None relative to RC8 (`v261019093518.0.0`).** Consent scopes are optional event
fields; existing consumers can ignore them and absent fields retain the refresh
path. The draft privacy, voice failure and Settings changes require no new host
API, and candidate admission changes the release process. Hosts upgrading from
before RC7 must still apply RC7's preview embedding requirements.

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

Download the assets for `v261019131804.0.0` into a clean directory:

```sh
gh release download v261019131804.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261019131804.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261019131804.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
