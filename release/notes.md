# Aithema 2026.10

Version **261020161837.0.0**. Licensed under **AGPL-3.0-only**.

Thirteenth October release: email confirmation works on hosts that keep identity per conversation.

## What START and visitors notice

- **Confirm email and reach the higher credit tier (AIT-414 / START-524):**
  visitors can confirm their email address when the host keeps identity per
  conversation without a visitor-email storage port. The confirmation flow goes
  straight to the identity request, so a missing storage port no longer blocks it.

## For hosts

**Email storage capability is explicit (AIT-414).** Identity responses expose
`visitorEmail: { canSave }`. It is false when the host has no complete
visitor-email port. With credit tiers and an identity port, the UI then goes
straight to the identity request instead of trying to save a visitor email.
Hosts with the visitor-email port keep the existing save flow. See the
[email confirmation contract](https://github.com/inspr-at/aithema/blob/v261020161837.0.0/README.md#visitor-credit-and-ops-cli-ait-135-phase-a1).

START must integrate the host's identity and credit policy to use the higher
tier; this release does not deploy START. RC12's dated-cap integration and
host-owned history requirements still apply. Production voice hosts still need
a qualified fast `reaction` binding with effort `none`, separate from
`understanding`, with matching account evidence; the local simulator and free
canonical mock remain exempt. Aithema recommends checking each production voice
option before enabling it.

## Breaking for hosts

**No new breaking change relative to RC12 (`v261020150723.0.0`).**
`visitorEmail.canSave` is additive. Existing identity and visitor-email ports
remain valid; hosts without visitor-email storage can use the identity request
flow. Hosts upgrading from before RC7 must still apply RC7's preview embedding
requirements.

AIT-407, AIT-410 and AIT-411 are outside this release. Voxtral remains private
and outside the sixteen-module release closure.

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

Download the assets for `v261020161837.0.0` into a clean directory:

```sh
gh release download v261020161837.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261020161837.0.0/';
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
- Further legal formalization remains follow-up work; this release grants no
  rights beyond its included license and rights/provenance notices.

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261020161837.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
