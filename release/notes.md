# Aithema 2026.10

Version **261015164601.0.0** is the first public release of the Aithema module
packages, licensed under **AGPL-3.0-only**.

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

Download the assets for `v261015164601.0.0` into a clean directory:

```sh
gh release download v261015164601.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261015164601.0.0/';
const urls = manifest.artifacts.filter(a => a.kind === 'module').map(a => base + a.path);
execFileSync('npm', ['install', '--save-exact', ...urls], { stdio: 'inherit' });
NODE
```

Commit the host's `package-lock.json`: its release URLs and `sha512` integrity
values pin the downloaded tarball bytes. The verified
`consumer-package-lock.json` records the release consumer's tarball integrity
values for comparison. Use `npm ci` for subsequent installs. Retain the verified
assets, manifest and deployment pin for rollback to those exact bytes.

## Fixes included

- **Security (AIT-218):** development simulator identity and dispatch are
  hardened to keep simulated consent separate from real processing.
- **Reconnect and restart (AIT-212/213):** paid-lane failures survive reconnects
  and server restarts without silently rerunning failed work. Explicit Retry
  handles both failed lanes in order and keeps any remaining failure visible.
  Reply-pending and overview states are distinguished in German and English.
- **Diagnostics (AIT-201):** server diagnostics count admitted lane starts and
  terminal outcomes using the existing budget ledger.
- **Test reliability (AIT-209):** the repository browser launcher has a bounded
  launch timeout and one launch-only retry. It is excluded from release tarballs
  and does not change consumer runtime behavior.
- Package validation rejects imports of excluded source-only siblings.

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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261015164601.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
