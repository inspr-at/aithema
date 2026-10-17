# Aithema 2026.10

Version **261017100846.0.0**. Licensed under **AGPL-3.0-only**.

Second October release: host integration, enforced conversation limits, clearer settings and privacy evidence, role selection, and “Jetzt klären” build on the first October release.

## What START notices

- **Host chrome (AIT-260):** host branding and legal links stay visible; hosts
  without a bound voice client get a text-only header and footer.
- **Conversation limits (AIT-261/268/291):** the one-hour deadline survives pauses,
  reconnects and restarts. Budget denials stop fresh work while admitted work
  settles; pause controls keep their reserved space. Limit messages name the
  actual reason, and host limits offer an email upgrade when a next tier exists.
- **Settings gauges (AIT-262/291):** quality and privacy indicators reflect current
  host binding evidence rather than model-name assumptions, with “Checked” and
  “Set” wording and concise provider regions.
- **Model and host details (AIT-265/267):** the footer uses the host's model label
  and served version metadata, with the host coordinate below Aithema's version.
- **Privacy and EU processing (AIT-270/271):** provider seats and processing
  locations are distinguished. EU choices require both EU-only seats and an
  EU-only processing guarantee; the privacy detail can link to the host policy.
- **Consent editor (AIT-231):** Settings reads the host's validated consent
  document; invalid or unavailable documents keep saving disabled.
- **Consent on phones (AIT-290):** narrow phones use a short consent line with
  a clear review action.
- **Jetzt klären / Clarify now (AIT-263/274/288/290):** choose an open point for the
  next reply, with selected, pending, stale and retry states. Empty overview
  sections collapse, the redundant overview label is removed, and the overview
  opens at its natural scroll position.
- **Concept backdrop (AIT-282):** image concepts appear behind the transcript,
  with one access button and stable generating, ready and failure states.
- **Actor role (AIT-281):** visitors can choose a role using host-owned labels.
  Explicit choices survive restart and take precedence over inference; a new
  conversation shows that its role is not set.
- **Footer status (AIT-283/285):** connection labels, dot and timer keep their
  positions through status changes, notices and toasts.
- **Host polish (AIT-266/280/286):** clearer saved feedback, accessible controls
  and consistent send/concept failure actions, including touch targets.
- **First paint (AIT-276):** reserved scrollbar space prevents a width jump
  when the conversation mounts.
- **Voice recovery (AIT-226/279):** repeated facade authentication failures can
  repair a changed secret in process, with bounded retries and cooldown.

## Breaking for hosts

- **Removed `markLocalVoice` (AIT-202):** remove imports from
  `@inspr/aithema-server/local-voice-identity`. The subpath retains `isLocalVoice`;
  only the simulator factory creates private frozen identity pairings. Hosts
  cannot enroll providers as the simulator.
- **Role and account contracts (AIT-281):** enable
  `host.identity.chooseRole = true` on the server and supply complete localized
  `host.actorRole.labels` for `private`, `company`, `representative` and `agency`
  in the component. Missing capability or labels hides the role control. Put
  host-owned account content in `slot="account"`; it appears only in the desktop
  role popover. The module supplies no account claims or default role labels.
- **EU bindings and consent:** hosts using `eu` must supply qualified
  `legal.processingCountries` alongside `legal.countries`. Editable consent
  requires the authoritative port's `describe(sessionId)` contract. See the
  [embedding guide](https://github.com/inspr-at/aithema/blob/v261017100846.0.0/docs/embedding.md)
  for these contracts and the `data-aithema-privacy` legal-link marker.

Composed voice and its generic core component helpers remain source-only proof
code, without public package subpaths or admission to module tarballs.

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

Download the assets for `v261017100846.0.0` into a clean directory:

```sh
gh release download v261017100846.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261017100846.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261017100846.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
