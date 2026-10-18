# Aithema 2026.10

Version **261018142833.0.0**. Licensed under **AGPL-3.0-only**.

Fifth October release: withdrawn consent stays withdrawn, and HTML drafts can think deeper.

## What START and visitors notice

- **Withdrawn consent stays withdrawn (AIT-321):** an old tab or an open
  editor cannot restore consent the visitor withdrew. The editor explains
  when a choice is out of date and loads the current state for a fresh decision.
- **Deeper HTML drafts (AIT-324):** hosts can use Claude Opus with deeper
  reasoning for HTML drafts, within the spending cap.
- **Legal links on phones (AIT-304):** the demo's shorter legal labels fit
  on small screens.

## For hosts

- **Consent revisions (AIT-321):** consent documents include `consentRevision`.
  Send it as the expected `processing.revision` on every decision, including
  withdrawal. An already stale decision returns HTTP 409 `consent-stale`
  without consent side effects; reload the document and require a new visitor
  action. Withdrawals bypass pending host ports, and the server's atomic
  revision check prevents a late grant from restoring withdrawn consent.
  `consent.grant({ sessionId, consentRevision, decision, scopes })` receives
  the expected revision in `decision.revision`; the outer `consentRevision`
  is the next revision being granted. Shared host ledgers must enforce that
  expected revision atomically too. Decisions without a revision remain
  compatible but are deprecated and lack stale-tab protection. Settings confirms
  successful choices by revision and exact items, allowing versioned contracts;
  older backends retain contract-and-items confirmation.
- **Claude HTML reasoning (AIT-324):** set `binding.effort` to a value supported
  by the selected model: `none`, `low`, `medium`, `high`, `xhigh` or `max`,
  including Opus 5.5 `high`. `none` preserves the existing request bytes.
  `binding.maxTokens` is sent unchanged as `max_tokens` and covers reasoning
  plus visible output together. The reservation includes the input-byte ceiling
  and the full token allowance at the output rate; the adapter never increases
  the limit for deeper reasoning. Pass the shared `createSpendCap` through
  `spend`; insufficient room refuses with `not-admitted` before dispatch.
  Reported `usage.cost` settles the charge; missing cost after dispatch retains
  the reservation as uncertain spend.
- **STT/TTS component API (AIT-316):** implement speech-to-text and
  text-to-speech through `@inspr/aithema-core/voice-components`, also exported
  from core. The supported contract covers format negotiation, capability
  declarations, bounded streams, cancellation and separate claim accounting.
  Each request, retry or speech fragment needs a fresh admitted claim;
  uncertain costs retain at least its admitted maximum. Aligned speech only
  establishes a heard prefix after trusted playback confirms the bytes.
  Installed ElevenLabs live voice is unchanged; provider prototypes remain
  source-only.
- **Typing note (AIT-316):** the public `plugin-contract` types re-export the
  stricter component shapes. STT/TTS `capabilities`,
  `ComponentOperationOptions.attempt.maxMicro`, and `chargedMicro` on an
  uncertain `ComponentTerminal` are now required. Code typed against the old
  shapes stops compiling until those fields are supplied. This is a source
  typing change; it does not change the existing installed voice runtime.
- **Offline voice checks (AIT-319):** run `sttConformance` and `ttsConformance`
  from `@inspr/aithema-core` against local provider fixtures. They check fresh
  claims, terminal accounting, cancellation, bounds and playback-confirmed
  aligned prefixes. Passing them does not qualify live billing or latency.
- **Visitor tiers and erasure (AIT-320/322):** the embedding guide now shows
  a host-owned integration using public ports for revisioned tier settings,
  trusted administrator identity, atomic audit and shared owner admission.
  The host must delete a session's admission holds on erasure or retirement;
  visitor deletion must atomically remove that visitor's tier and all their
  active or released holds across conversations. Session retirement alone
  retains the visitor tier, and expiry alone does not erase host tier data.
  Wire the host cleanup hooks and retirement sweep; direct storage erasure
  does not invoke them. Global settings and administrator audit remain, but
  retained visitor audit counts must contain no identifying data.
- **Maintenance (AIT-314/318):** refreshed CI timing floors and clearer release status.

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

Download the assets for `v261018142833.0.0` into a clean directory:

```sh
gh release download v261018142833.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261018142833.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261018142833.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
