# Aithema 2026.10

Version **261020150723.0.0**. Licensed under **AGPL-3.0-only**.

Twelfth October release: steadier takeback, safer credits for hosts, and dated cost corrections.

## What START and visitors notice

- **Taking a conversation back shows “Listening” at once (AIT-404):** the
  composer no longer flashes “Conversation paused” while the server confirms.
  If takeback fails, the paused state returns. A paused conversation whose budget
  is denied shows the used-up panel.
- **A host credit failure cannot leave a message waiting without a reply
  (AIT-405):** the turn fails cleanly before the message is saved, without spend.
- **Daily caps can stay exact across midnight (AIT-409 / START-524):** hosts can
  read dated cost corrections and voice exposures for each attempt, so a final
  cost arriving tomorrow counts on the right day. Hosts must integrate these
  records into their cap policy; this release alone does not deploy that policy
  to START.
- Voice keeps failure messages next to the control they concern.
  Retry waits for the stated delay.

## For hosts

**Credits are read before saving a turn (AIT-405).** The owner-authorized wallet
projection is read inside the turn's storage transaction, before the visitor's
message is persisted. If the wallet callback throws, that transaction rolls back
and the request returns a server error, with no saved turn or spend. The separate
credit-tier projection remains on owned credits reads; it is not a turn preflight
callback. This replaces a stuck turn with an immediate failure.

**Read dated corrections and exposures (AIT-409).** `SQLiteBudgetLedger` exposes
`corrections(attemptId)` and `voiceExposures(attemptId)`, also available through
`runtime.budget` when it uses that ledger. Both synchronous reads return arrays
in posting order with this event shape:

```js
{ id, attemptId, lane, atMs, oldMicro, newMicro, oldVisitorMicro, newVisitorMicro }
```

Amounts are integer micro-USD (1 USD = 1,000,000 micro). `atMs` is the posted epoch
millisecond. For corrections it is `budget_corrections.at_ms`, not the admission
or first settlement time. Corrections include reasoning/provider-cost and voice
reconciliations; their old/new amounts are settlements. For voice exposures,
`lane` is `voice` and old/new amounts are the retained maxima. Exposure increases
record existing provider liability even above a cap; they are separate from
admitted extensions and invoke no wallet callback. Missing attempts and empty
histories return `[]`. Reads expose no internal evidence JSON or secret references.

Deduplicate by `{ attemptId, stream, id }`, where `stream` is `corrections` or
`voiceExposures`. Corrections use persisted row IDs; voice exposures use a durable
per-attempt sequence starting at 1. Replayed receipts and unchanged maxima add
nothing. Date a positive correction delta (`newMicro - oldMicro`, or its visitor
equivalent) on the UTC day of `atMs`. For example, a $10 uncertain settlement
reduced to $0.01 before midnight, then corrected to $8 after midnight, adds $7.99
to the new day's cap. Allocate refunds against the earlier dated charges they
refund; an old-day refund must not reopen today's headroom.

Keep original holds on admission day, extension extras on their recorded event
day, and exposure deltas on the UTC day of `atMs`. Count settlement above those
reservations on its `settled_at_ms` day without counting the same liability twice.
Reconcile the host projection idempotently before admission. Earlier rows have
no reconstructed exposure dates; preserve host history rather than inventing
them. Session retirement purges `budget_corrections` and the attempt's exposure
history: **keep a host-owned copy of corrections and exposures needed for cap
history before retirement**. Rebuilding a projection requires that retained copy.
A custom host-supplied `budget` object does not gain these reads automatically;
its host must implement or supply equivalent dated records. See the
[dated accounting contract](https://github.com/inspr-at/aithema/blob/v261020150723.0.0/docs/embedding.md#dated-budget-attribution-ait-401-ait-409).

**Paused and budget-denied (AIT-404)** now displays the used-up panel, so the
composer reflects the actual credit state while another tab holds the conversation.

Continuing host requirements from RC11:

- Production voice hosts require a qualified fast `reaction` binding with effort
  `none`, separate from `understanding`, with the allowlist, streaming support and
  current matching account evidence. The local voice simulator and free canonical
  mock are exempt. The OpenRouter demo configuration requires
  `OPENROUTER_SPEECH_MODEL`. Aithema recommends checking each production voice
  option before enabling it.
- Daily-limit receipt wording requires session-scoped credits
  (`creditScope: 'session'`) and a tier projection returning
  `dailyCapReached: true`; the upgrade offer is then suppressed.
- Mail `close()` closes the transport and cancels pending sends. A running DNS
  lookup finishes and its result is discarded; the lookup itself is not aborted.

AIT-406 repairs the nightly full-browser evidence run. It changes test coverage
and harness selection only, with no product behavior change.

## Breaking for hosts

**No new breaking change relative to RC11 (`v261020105634.0.0`) for hosts that
follow the documented port.** AIT-405 changes when a throwing wallet surfaces:
an immediate server error replaces a saved, stuck turn. AIT-409's dated reads
are additive; existing wallet arguments and results remain valid. Daily-cap
accuracy still requires the host integration and retained history described
above. A custom `budget` implementation must supply its own equivalent reads.

RC11's production voice route requirement still applies, with the simulator and
free canonical mock exemptions above. Hosts upgrading from before RC7 must still
apply RC7's preview embedding requirements.

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

Download the assets for `v261020150723.0.0` into a clean directory:

```sh
gh release download v261020150723.0.0 --repo inspr-at/aithema
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
const base = 'https://github.com/inspr-at/aithema/releases/download/v261020150723.0.0/';
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

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261020150723.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
