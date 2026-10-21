# Aithema 2026.10

Version **261021043938.0.0**. Licensed under **AGPL-3.0-only**.

Fourteenth October release: credits display options for hosts, one clock for every deadline, and steadier conversations when an address changes mid-reply.

## What START and visitors notice

- **Clearer credits and choices (AIT-411/422/434/435):** START can choose which
  credit offers, reset times and conversation actions to show. Credit amounts
  stay with their labels, the email offer explains that the conversation stays
  saved, and the phone footer keeps legal links behind a labelled Legal control.
- **A steady conversation (AIT-410/400/412/432):** changing credits, starting a
  call or receiving a reply keeps the page still. Every reply keeps its own
  read-aloud control, disabled in place during calls. The withdrawal notice no
  longer covers the first message; Latest keeps its space when returning.
- **Changing an email address during a reply (AIT-418):** submit waits in place
  with “Available once the reply has finished.” If a change races with delivery,
  the existing reply-failed message and Retry explain what happened. A reply the
  visitor never saw does not use visitor credits.
- **Replies and calls recover more reliably (AIT-416/417/391/399/384):** an
  activity-recording failure no longer leaves a message without a reply. After
  reconnecting, the overview, clarification and pause state catch up; a
  clarification is spoken once. A refused resume or interruption leaves the
  call safe. Voice shows failure messages next to the control they concern;
  Retry waits for the stated delay.
- **Readable drafts stay available (AIT-374/424/428):** when consent no longer
  covers one draft, other readable drafts remain available. The unavailable
  draft keeps a neutral, keyboard-reachable placeholder and can still be
  dismissed; its contents, downloads, votes and regeneration remain closed.
- **Calmer messages and usable handover (AIT-387/429/426/433):** unavailable
  features use neutral wording. German defaults address visitors impersonally.
  On phones, the handover heading, full demo notice, action and status stack
  without clipping or moving the page as the status changes.

## For hosts

**Eight opt-in credit changes (AIT-411).** Each changed presentation or policy
requires host opt-in; hosts that set none keep RC13's credit-options DOM. The
existing low-credit ask stays enabled until explicitly suppressed.

| Option | Host opt-in and result |
| --- | --- |
| O1 | `host.usedUp.newConversation.enabled: true` adds the new-conversation action in the used-up panel; default false. |
| O2 | `host.usedUp.dailyCapActions: 'none'` removes the daily-cap action while retaining its space; default `'export'`. |
| O3 | Supply `copy.hostSurface.credits.afterConfirm` for a separate “After confirmation: {n} credits” offer; absent by default, with the existing copy fallback. |
| O4 | `host.credits.reconcilingVisible: true` shows reconciling text; default false. |
| O5 | `host.credits.dailyCapReset: true` shows the reset time supplied through `dailyCapResetAt`; default false. |
| O6 | `host.emailAsk.lowCredits: false` on client and server suppresses the inline/automatic low-credit ask; the suppression is off by default (the setting defaults to true). |
| O7 | Return `{ ok: false, reason: 'session' }` from the wallet to identify session end; absent by default, with precedence dailyCap > session > host-limit. |
| O8 | Report `visitorEmail: { canSave, canDelete }` in the same object; deletion is enabled only for explicit `canDelete: true` from a complete visitor-email port. |

Only boolean `true` from wallet `canAdmit` authorizes spend; truthy objects do
not. O1–O8 preserve their reserved space as state changes. See the
[credit host options](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/docs/embedding.md#credit-host-options-o1o8-rc13)
for the complete client/server contract. START must integrate its chosen options;
this release does not deploy START.

**Credit callback failures are server errors (AIT-407/420).** On the turn path,
a throwing host credit callback returns HTTP **500**, including `TypeError`
(previously 400) and `RangeError` (previously 413). During turn preflight,
`wallet(ownerToken, context)` and `balance()` execute inside the turn transaction.
Host credit reads must be synchronous and side-effect free: read-only Aithema
getters and SELECT on host-owned tables through the same SQLite handle are
allowed; writes, storage mutators, async/network work and nested
`storage.transaction()` calls are forbidden. `canAdmit()` and `creditTiers()`
share the read contract but are not called for initial turn admission.

**One clock for deadlines and admission (AIT-403/430).** Installing a host clock
with `createHandlers`/`setHostClock` reaches runtime admission, UTC-day buckets,
voice/render limits, budgets, storage, retention, receipts and evidence checks;
an explicit runtime constructor clock retains policy precedence. Pass the same
forwarding `runtime.now` function to independently constructed providers,
consent ledgers and other host ports. Custom voice caps and render limiters must
implement `setClock(clock)` when a clock is installed; otherwise installation
fails closed before changing clocks. Remaining wall-clock reads measure elapsed
work only. See the [clock contract](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/docs/embedding.md).

**Billing survives retirement (AIT-421/427).** Retirement waits within a bounded
window for outstanding billing, seals durable writes and commits the final
per-attempt projection before `host.retired({ sessionId, ownerHash, attempts })`
and purge. A validated late charge refused by the seal is recorded on the
existing host reservation and included in retired spend without reopening frozen
attempts; the seal error remains primary. The migration removes the unused
`wait_for_billing` column while preserving retries, deadlines and seals.

**Activity and voice callbacks (AIT-416/417/384).** Every `touchVisitor` call
uses the shared activity guard so a failing host callback cannot fail an
unrelated request. Voice correction, interruption marker and receipt commit
together; a refused barge-in marker leaves the call running. Voice support is
selected by capability rather than provider ID.

**Consent, identity and embedding (AIT-371/374/396/368/418/428).** Consent reads
are de-duplicated per request and limited to four concurrent reads, with ownership,
revision and scope checked per artifact. A full withdrawal through `POST /consent`
includes every known scope in its revocation fields; `withdrawConsent(id)` omits
those fields and uses the legacy refresh path. Both bypass host document reads.
Legacy/unknown consent evidence stays flagged over the pending window. The
identity request/change routes reject
mid-reply races explicitly; undelivered replies cost the host within caps, not
visitor credits. The guide covers minimal module installation, equal-tier
confirmation and the address-derived daily spend guard.

[RC12 host requirements](https://github.com/inspr-at/aithema/blob/v261020150723.0.0/release/notes.md#for-hosts)
and [RC13's email capability contract](https://github.com/inspr-at/aithema/blob/v261020161837.0.0/release/notes.md#for-hosts)
still apply, including voice binding, dated caps, history and mail shutdown;
Aithema recommends checking each production voice option before enabling it.
For retryable provider limits, preserve HTTP **429** and `Retry-After` through
host adapters; provider delay parsing accepts integer seconds or strict HTTP
dates and omits malformed values, with the existing 60-second lifecycle cap
(AIT-384).

## Breaking for hosts

**Yes, relative to RC13 (`v261020161837.0.0`).** AIT-407 changes the observable
error status of throwing turn credit callbacks from 400/413 to 500: these are
host integration failures, not malformed visitor input or oversized payloads.
Update adapters, monitoring and retry/error handling that depended on the old
status, and repair callbacks to the synchronous read contract above. AIT-403/430
also rejects custom caps/limiters without `setClock` when installing a clock;
add that method before opting into an injected clock. Wallet integrations must
honor the existing explicit-true admission contract. The eight credit options
are opt-in; they do not require enabling new UI.

Voxtral and the second Grok voice pipeline (AIT-317/342) remain parked, private
and outside this release's sixteen-module closure. AIT-419/423 change CI only
(eight browser shards); AIT-425/436 strengthen tests without changing behavior.

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

Download the assets for `v261021043938.0.0` into a clean directory:

```sh
gh release download v261021043938.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261021043938.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
