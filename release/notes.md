# Aithema 2026.10

Version **261019195810.0.0**. Licensed under **AGPL-3.0-only**.

Tenth October release: a smoother ElevenLabs voice and a privacy fix for HTML drafts.

## What START and visitors notice

- **HTML drafts stay private with visuals Off (AIT-386 / START-550):** an HTML
  draft's content is never sent to the server as an image request. Kept images
  retain their thumbnails and layout, and HTML draft consent keeps its own kind.
- **Faster, more reliable ElevenLabs calls (AIT-379, AIT-380, AIT-381, AIT-388):**
  the reply starts with validated spoken audio within five seconds, or one short
  holding line covers the wait. An off-topic reply redirects once; a retry
  continues after what was already said. The provider receives exactly the
  request that was approved for that attempt. When the agent ends the call,
  the call and microphone really close. Refusals use neutral wording.
- **Honest waits and recovery (AIT-377, AIT-378, AIT-383):** call-start waits are
  clear, microphone guidance points to the device, and the charge after an
  agent-ended call reflects the available accounting evidence. Voice shows
  failure messages next to the control they concern; Retry waits for the stated delay.
  A provider-confirmed interruption is marked. The silence watchdog stays off
  until the provider declares the signals it needs.
- **Consent never hangs on loading or saving (AIT-376):** stalled requests end
  with a way to recover, and a withdrawal always lands, even from a stale page.
- **Withdrawal leaves a clean layout (AIT-385):** removing a shown draft leaves
  no empty focused tile. On a 390-pixel phone view, the withdrawal notice sits
  clear of the transcript chevron.

## For hosts

Voice now requires a configured, qualified fast reaction (speech) route with
reaction effort `none`. In the OpenRouter demo, set `OPENROUTER_SPEECH_MODEL`
explicitly for every enabled voice option. Keep account evidence current and
matched to that route. The analysis model remains separate and is never a
silent fallback for speech. Missing or invalid speech configuration refuses
voice start with an operator configuration error in the server log; visitors
see neutral voice-unavailable wording. See the
[fast reaction route contract](https://github.com/inspr-at/aithema/blob/v261019195810.0.0/docs/embedding.md#required-fast-reaction-route-for-demo-voice-ait-380).

The spoken-turn callback default is **6.5 seconds** (`turnTimeoutMs` and the
ElevenLabs callback timeout). It bounds the whole response, including cleanup;
validated speech or the short holding line covers the five-second first-audio
wait. Retries preserve already spoken text, redirect at most once and require
fresh admission for the exact provider request.

The managed ElevenLabs agent's `conversation_config.conversation.client_events`
now includes `agent_tool_response`, needed for a native agent-initiated end.
Run the authorized host ensure to repair an agent missing it; ensure writes and
checks the complete event contract. The server-only `checkAgentHealth` export
at `@inspr/aithema-plugin-elevenlabs/agent-health` checks the configured agent
with a single GET and makes no changes. See the
[agent event and health contract](https://github.com/inspr-at/aithema/blob/v261019195810.0.0/plugins/elevenlabs/README.md#native-end-call-event-contract-and-get-only-agent-health-ait-379).

A provider's retry delay now reaches the browser as HTTP **429** with
`Retry-After`; preserve that status and header through host adapters so Retry
waits for the stated delay. Continue forwarding consent changes to every tab.

## Breaking for hosts

**Yes for voice relative to RC9 (`v261019131804.0.0`).** A host without a
configured fast reaction (speech) route now has voice refused with an operator
configuration error instead of silently using its analysis model. Set
`OPENROUTER_SPEECH_MODEL` in the OpenRouter demo, or an explicitly qualified
reaction binding with effort `none` in a custom host, with matching current
account evidence. Repair the managed agent event contract through host ensure
before enabling an older agent. Everything else in this release is backward
compatible. Hosts upgrading from before RC7 must still apply RC7's preview
embedding requirements.

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

Download the assets for `v261019195810.0.0` into a clean directory:

```sh
gh release download v261019195810.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261019195810.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261019195810.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
