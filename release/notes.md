# Aithema 2026.10

Version **261020105634.0.0**. Licensed under **AGPL-3.0-only**.

Eleventh October release: honest voice waits, the fast voice route for every host, and per-conversation credits.

## What START and visitors notice

- **Voice says what it is waiting for (AIT-383):** ElevenLabs and Grok calls
  distinguish the microphone prompt, ending the previous call, the visible retry
  countdown and connecting. The 30-second connection deadline starts only after
  microphone permission is granted. Each microphone failure has its own guidance
  next to the mic. “No reply yet” appears only after 15 seconds of real agent
  silence and clears when the reply arrives. End cancels startup immediately.
  These notices appear only when they are true. Voice shows failure messages next
  to the control they concern; Retry waits for the stated delay.
- **Every host's voice answers on the fast route (AIT-397):** voice requires the
  fast reaction route on custom hosts as well as the demo configuration. Calls
  never fall back to the slow analysis model.
- **Credits belong to each conversation (AIT-395, AIT-401 / START-524):** each
  conversation can show its own balance and confirmation offer, even when a
  visitor has several conversations. Daily-cap receipts show the daily limit
  without offering an unavailable upgrade. Voice extensions and settlement now
  retain the timing hosts need to enforce daily caps when a call crosses midnight.
- **Existing conversations survive confirmation changes (AIT-392):** hosts can
  turn email confirmation off or roll back without breaking conversation resume.
- **Closing mail stops pending sends (AIT-393):** closing the mail plugin also
  cancels sends still waiting for address lookup.

## For hosts

A qualified fast reaction (speech) route is now required for voice on **every
host**, including custom hosts (AIT-397). For each ElevenLabs, Grok or composed
voice option, configure a `reaction` binding with effort `none`, using a model
separate from `understanding` (analysis). Both `choices.models[].bindings` and
legacy `bindings` are supported. Allowlist the reaction plugin and endpoint,
supply current matching account evidence, and use a reasoning plugin that
supports streaming with effort `none`. The OpenRouter demo configuration,
including start2, requires `OPENROUTER_SPEECH_MODEL`. A generic effort selection
cannot raise the configured reaction effort. Missing or invalid configuration
refuses voice and logs an operator configuration error; visitors see neutral
voice-unavailable wording. Aithema recommends checking every voice option before
enabling it. See the
[fast reaction route contract](https://github.com/inspr-at/aithema/blob/v261020105634.0.0/docs/embedding.md#required-fast-reaction-route-for-voice-ait-380-ait-397).

The owner-authorized `wallet(ownerToken, context)` and
`creditTiers(ownerToken, context)` ports receive `{ sessionId }` (AIT-395).
For conversation balances, return `creditScope: 'session'` from the wallet and
project both wallet amounts and tiers for that conversation. Admission must
still enforce owner, address and daily limits. Return `dailyCapReached: true`
from the tier projection when the daily cap prevents confirmation; the UI then
suppresses the upgrade offer. Existing one-argument callbacks can ignore the
context and keep their owner-wide display and behavior.

Voice extension's `wallet.canAdmit(extra, context)` receives the additive frozen
context `{ attemptId, sessionId, extraMicro, at }` (AIT-401); `at` is epoch
milliseconds. The first argument and return value are unchanged. The callback
runs synchronously inside the ledger transaction: do not await, open a nested
transaction or make external side effects. Durable `voice_extensions_json`
records accepted increases and their times; the receipt for each attempt gains
`settled_at_ms`, also returned by settlement methods. Replays preserve those
times. There is no new settlement hook. Hosts enforcing UTC-day caps keep the
original hold on its admission day, attribute extension extras to their event
day and settlement above the reservation to its settlement day. Reconcile
idempotently before admission. Old rows have empty extension history and a
nullable settlement time; retain historical host records rather than guessing
a date. Existing callbacks that ignore the new context remain compatible, but
hosts must consume these records to enforce their midnight cap policy. See the
[credit and accounting contract](https://github.com/inspr-at/aithema/blob/v261020105634.0.0/docs/embedding.md#current-policy-owner-admission-and-nexttier).

Resume also works when a host has no identity port (AIT-392). Removing a
verification requirement lifts the saved lock without requiring a removed
identity or email-persistence port. Closing the mail plugin aborts pending sends
and address lookups (AIT-393).

## Breaking for hosts

**Yes for voice on custom hosts relative to RC10 (`v261019195810.0.0`).** RC10
only capped custom hosts' reaction effort; RC11 refuses voice unless every voice
option has a qualified fast `reaction` binding with effort `none`, separate from
the analysis model, plus the allowlist, streaming support and current matching
account evidence described above. Configure that route before enabling voice.
The OpenRouter demo configuration already required it in RC10; set
`OPENROUTER_SPEECH_MODEL` there.

**The AIT-395 and AIT-401 port additions are backward compatible:** JavaScript
callbacks may ignore the new second argument, and existing first arguments and
results remain valid. The durable accounting fields are additive; using them
for daily caps requires host integration. Text-only hosts and identity-free
resume need no new port. Hosts upgrading from before RC7 must still apply RC7's
preview embedding requirements.

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

Download the assets for `v261020105634.0.0` into a clean directory:

```sh
gh release download v261020105634.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261020105634.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261020105634.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
