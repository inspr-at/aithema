# Embedding Aithema

Aithema uses **INSPR-CalVer3**; `release/version.json` is the
single version authority. The root workspace is private. The release packer
emits independently installable core, server, UI and provider/integration
plugin tarballs, with exact dependency pins, plus a retained workspace archive.
Aithema is published as immutable [GitHub releases](https://github.com/inspr-at/aithema/releases)
with signed, attested tarballs. Hosts pin a release with `deployment-pin.json`
and `release-set.json`. Node.js 24 or newer is required.
See [release notes](../release/notes.md) and the [GitHub release route](../release/README.md).

## Consume Aithema as a module (START or another thin host)

[START’s `host/`](https://github.com/augmentoring-team/start-agm-com/tree/main/host)
is the living reference for a thin host consuming Aithema’s release tarballs.
Follow that host’s current integration when wiring storage, consent and runtime
lifecycle into a consuming application.

For candidate validation on the build runner, retain the candidate directory
and its manifest digest.
Run `npm run release:verify -- /path/to/candidate/first` before installing.
From a separate host directory, install the modules the host uses and their
complete transitive dependency closure in one invocation, so npm can resolve
their exact mutual dependencies without a registry publication. Unused leaf
plugins, such as `@inspr/aithema-plugin-grok-voice` for a host with no Grok voice,
may be omitted if no installed module depends on them. Every installed Aithema
module must come from the same release. Installing the full set is also valid:

```sh
npm install --save-exact /path/to/candidate/first/inspr-aithema-*.tgz
```

Commit the host's lockfile and retain the deployment pin, manifest and tarballs.
Use `npm ci` with those retained paths for subsequent deployments. A browser
bundler resolves the UI and its core dependency; an unbundled browser needs an
import map for each exported package subpath. Workspace source browser URLs
are converted to declared package subpaths by `release:pack`.

For a published release, install the selected modules and their dependency
closure by release URL in one invocation, rather than from a package registry.
The URL pattern is:

```sh
npm install --save-exact https://github.com/inspr-at/aithema/releases/download/<tag>/<pkg>.tgz
```

Use the exact `v<version>` tag and module filenames from `release-set.json`, and
pass the selected closure's module URLs together. First download and verify
SHA256SUMS, the manifest, selected tarballs and their attestations as described
in the [release route](../release/README.md). Check that `npm ls` is clean after
installation; omitting an unused plugin does not permit missing dependencies,
mixed releases or unverified artifacts.
Commit the host lockfile with the URL resolutions and **sha512 integrity**; use
`npm ci` for repeat deployments and retain the verified artifacts for rollback.
Public release downloads need no consumer token. The Linux tag build tests the
exact published tarballs; historical BSD candidate digests do not cover them.

For HTML and images, the embedding host installs and registers
`createClaudeHTML` (`@inspr/aithema-plugin-claude-html`) and/or
`createOpenAIImages` (`@inspr/aithema-plugin-openai-images`) itself. Add their IDs
and private bindings to the selected preset, mark HTML choices `kind: 'html'`,
and supply authoritative consent covering their exact processing scopes. Claude
provides `estimateCost` for exact admission pricing; other HTML adapters may
provide it or reserve the full binding ceiling. See `demo/visual-plugins.js` and
`demo/server.js` for host composition. The server does not load provider defaults.

The host supplies durable storage, authoritative identity/ownership and consent,
and budget policy. The server and UI are mounted independently; the demo is
an example host, not a dependency of START. A mock-only host can compose them as
follows (the `ports` object is trusted START server configuration):

```js
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { SQLiteBudgetLedger, createPluginRuntime, mockPresets, createHandlers } from '@inspr/aithema-server';
import { httpAdapter } from '@inspr/aithema-server/http';

export async function mountAithema(ports) {
  const storage = ports.storage; // e.g. SQLiteStorage; host owns its lifecycle
  const consent = ports.consent; // coverage, grant and withdraw; shared with runtime
  const reasoning = createMockReasoning();
  const registry = new PluginRegistry().register(reasoning);
  const budget = new SQLiteBudgetLedger(storage, ports.budgetPolicy);
  const pluginRuntime = createPluginRuntime({ storage, consent, reasoning, registry,
    budget, presets: mockPresets() });
  const handlers = createHandlers({ storage, consent, pluginRuntime,
    ownership: ports.ownership, host: {
      identity: ports.identity, library: ports.library, handover: ports.handover,
      wallet: ports.wallet, walletForSession: ports.walletForSession, credits: ports.credits,
      policy: ports.policy, privacyDocumentConfigured: ports.privacyDocumentConfigured,
    } });
  await handlers.resume();
  return { middleware: httpAdapter(handlers.handle), handle: handlers.handle,
    close: () => handlers.close() };
}
```

Mount `middleware` in the host HTTP server, or route Web `Request` objects to
`handle`. Pass the host's authenticated cookie/session token through
`ownership.token`; ensure the same token reaches the web component. The browser
example below creates and mounts `<aithema-session>`. Call `close()` before
closing the host storage on shutdown. `walletForSession` supplies runtime
owner admission; `wallet(ownerToken)` and `credits` supply the host account UI.
For paid models, register the chosen plugin factory and supply qualified private
bindings in the preset choices; mock presets alone never enable a paid route.

Both `SQLiteBudgetLedger` caps apply **per conversation**: `sessionCapMicro`
(`session`) bounds upstream usage, and `visitorCapMicro` (`voiceVisitor`) bounds
only that conversation's voice charge. `maxVisitorMicro` is the admission's
per-conversation voice maximum; reasoning admissions use `0`. Despite its name,
`visitorCapMicro` does not bound a visitor's or owner's total across conversations.
Enforce owner- or visitor-wide limits in the host's owner-wallet port
(`canAdmit` preview and atomic `admit`), supplied through `walletForSession`.
See the [README host ports section](../README.md#host-ports-ait-104-part-a)
for the wallet admission contract.

## Visitor tier settings and host administration (AIT-320)

A consuming host can implement visitor tiers through the existing public ports;
it does not import the demo's operator page, settings SQL or private module paths.
The complete executable reference is
[`test/host-fixtures/visitor-tier-host.js`](../test/host-fixtures/visitor-tier-host.js),
qualified by [`test/visitor-tier-host.test.js`](../test/visitor-tier-host.test.js).
Copy/adapt that **host-owned** file into your host. It is an example integration,
not a new package export. It imports only `node:crypto`,
`@inspr/aithema-core` and `@inspr/aithema-server`. Its SQL touches only its own
`host_tier_*` and `host_visitor_tiers` tables through `SQLiteStorage.db` and
`transaction`; module accounting is accessed through `SQLiteBudgetLedger` methods.
There is no dependency on demo storage layout or an internal operator page.

The reference combines these responsibilities:

| Host responsibility | Public module boundary |
| --- | --- |
| Durable settings, revisions and atomic old/new audit | `SQLiteStorage.db`, synchronous `storage.transaction(fn)` |
| Trusted operator login and revocable session | `createOperatorSessions`, `createSQLiteOperatorStore`; core `OperatorSessionPort` / `OperatorIdentityProvider` contracts |
| Current owner allowance and durable admission holds | core `OwnerWalletPort` behavior, checked by `ownerWalletConformance` |
| Per-conversation reservations, settlement and voice extension | `SQLiteBudgetLedger`, core `admitCredits` |
| Erasure of host visitor-tier records and admission holds | `host.erased`, `host.retired`, `host.eraseVisitorForOwnerHash`; privileged `handlers.eraseSession` |
| Visitor credit projection and runtime wallet binding | `createHandlers({ host, pluginRuntime })`, `host.wallet`, `host.walletForSession`, `host.creditTiers` |

### Settings, revisions and administrator identity

Store all three integer **micro-USD** allowances (`1_000_000` = USD 1) in one
revisioned record: `anonymous`, `emailGiven`, `emailConfirmed`. The reference
starts at USD 10/15/20 and revision 1; these are host defaults, not module policy.
`settings()` reads SQLite on each call, validates stored values, and never resets
them on restart. Saves require exactly `{ baseRevision, allowancesMicro }`.
Reject unknown/missing fields, fractions, negatives, unsafe integers, strings,
values above the host ceiling (`1_000_000_000`, USD 1,000 here), or descending
tiers. Equality and zero are allowed. A decimal USD presentation can use the
public server `usdMicro` converter before applying the same validation; it must
not use floating-point multiplication as its accounting parser.

The reference routes are host choices:

| Route | Authorized operation |
| --- | --- |
| `GET /host/admin/tiers` | Read current revision and allowances |
| `POST /host/admin/tiers` | Validate and save the complete allowance record |
| `GET /host/admin/tier-audit` | Read the latest 100 settings changes |

Every route first requires `operatorSessions.session(request)`. Missing, forged,
expired, revoked or no-longer-allowlisted sessions receive 401, including reads.
Mount `operatorSessions.handle(request)` for `/api/operator/login/`,
`/api/operator/callback/` and `/api/operator/logout/` before the host routes.
Create it with a trusted `OperatorIdentityProvider`, its SQLite store, a fixed
`publicOrigin` and host clock. A production host can supply `createZitadelOIDC`
from `@inspr/aithema-plugin-zitadel-oidc` with its own verified configuration and
exact subject allowlist. The tests substitute an entirely offline provider but
exercise real login state, callback, cookies, grant persistence and revocation.
Operator identity is separate from visitor email, visitor cookies and ownership.

The write route requires exact same-origin `Origin`, rejects cross-site fetches,
accepts only JSON, bounds input at 16 KiB, and rechecks the live operator session
after reading the asynchronous body. It rejects client `actor`, `subject` and
`source` fields. The audit actor is `{ namespace, subject, name }` from the
server-configured provider namespace and **current operator session**; the
subject and namespace identify authority, while name is display metadata.
The host must safely escape names in its own admin presentation.

A save uses one `BEGIN IMMEDIATE` transaction: read and compare `baseRevision`,
update the complete record with revision + 1, then insert immutable old/new
JSON, revision, host timestamp and trusted actor into the audit table. An audit
insert failure rolls back the settings update too. A competing or repeated old
revision returns 409 `{ error: 'stale-settings', current }` without another audit
entry. Invalid request JSON or settings return 400 `invalid-settings`; corrupt
stored records, revision overflow and storage/audit failures return 503
`settings-unavailable`, including failed reads. On 409, reload and let the administrator reconsider their edit. After an
uncertain response, read current settings/audit before retrying; replaying the
old revision cannot apply a second write. The initial default record has no
administrator change entry; subsequent changes have exactly one entry each.
The host owns audit retention/export and migration policy; this minimal reference
returns a bounded recent history and prevents audit UPDATE/DELETE.

For example, a host admin client with a live operator cookie can read and save:

```js
const current = await fetch('/host/admin/tiers', { credentials: 'same-origin' }).then(r => r.json());
const response = await fetch('/host/admin/tiers', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ baseRevision: current.revision,
    allowancesMicro: { anonymous: 10_000_000, emailGiven: 15_000_000, emailConfirmed: 20_000_000 } }),
});
if (response.status === 409) {
  const { current: latest } = await response.json();
  // Present latest to the administrator before issuing a new edit.
}
```

The browser supplies its same-origin `Origin` header. The host serves admin
responses with `Cache-Control: no-store` and `Vary: Cookie`. Host-owned HTML,
access policy and routing must preserve those authorization and CSRF checks.

### Visitor-tier erasure is a host duty (AIT-322)

Session erasure and visitor deletion have different scopes. The reference keys
visitor tiers by `owner_hash` (SHA-256 of the owner token, equal to
`session.ownerHash`) and holds by the session ID in each admission fingerprint.
Both active and released holds contain `attempt_id` keys and request/binding
fingerprints; these are visitor data, not anonymous audit counts.

| Trigger | Host rows deleted | Host visitor data retained |
| --- | --- | --- |
| Public session erase or `handlers.eraseSession({ sessionId })` → `host.erased({ sessionId, ownerToken })` | Only that session's holds | Visitor tier and other sessions' holds |
| Idle-session retirement, retirement after expiry, or sweep after direct `storage.erase` → `host.retired({ sessionId, ownerHash })` | Only that session's holds | Visitor tier and other sessions' holds, even when the last session retires |
| Visitor deletion → `host.eraseVisitorForOwnerHash(ownerHash)`, including `handlers.eraseSession({ sessionId, visitor: true })` | Visitor tier and all that owner's holds, active or released, across conversations | No tier or holds for that visitor; other owners' rows remain |
| `storage.expire` or `handlers.expire` alone | No tier or hold rows; only old turns/uploads are withdrawn | Tier and all holds until session erasure/retirement or visitor deletion |

The session hooks use `sessionId` without needing an owner token, which may be
omitted during privileged erasure. Deleting a sibling's active, unjournalled
hold would reduce `reservedMicro` and admit work beyond the owner's limit.
Visitor deletion removes the tier and all owner holds in one idempotent host
transaction. Neither scope changes the module's accounting.

The [host retention contract](#host-retention-contract) defines retirement per
session and leaves visitor identity/accounts under the host's visitor-retention
policy. It does not make retirement of the last session a visitor deletion.
The reference therefore retains the tier until explicit visitor deletion.
Direct storage erasure does not invoke host hooks itself; run the retirement
sweep to finish that session's host cleanup.

Keep global tier settings and the administrator settings-change audit, which
contain no visitor keys or tier evidence. After visitor deletion, only aggregated,
non-identifying visitor audit counts may remain: never retain owner/session/attempt
identifiers, tokens or fingerprints as aggregates. The module's permitted
accounting totals and deferred settlement follow the retention contract below;
host cleanup does not reset that ledger or confirm provider deletion. A new
visitor token starts with the anonymous allowance and no prior tier or holds.

### Current policy, owner admission and nextTier

The host must persist authoritative tier evidence keyed by the same owner hash
as `session.ownerHash` (SHA-256 of its owner token in this reference). Never use
an address as the accounting key. The fixture's `recordTrustedTier` is a trusted
server callback, **not an HTTP command**: it substitutes for the host's identity
store. The production host supplies optional email collection, privacy notice
and document capability, consent, address retention/erasure, qualified delivery
and server-confirmed verification evidence. A request body cannot select its
tier. Confirmation is disabled by default; enable `canConfirm` only with that
evidence and delivery capability. Without it, confirmed evidence projects as
`emailGiven` and cannot offer a confirmation upgrade.

Use the same current settings/evidence reader in the wallet and credit projection:

```js
const host = {
  wallet: ownerToken => walletForHash(hash(ownerToken)),
  walletForSession: session => walletForHash(session.ownerHash),
  creditTiers: (ownerToken, context) => creditTiers(ownerToken, context),
  credits: { ownerGuard: true },
  privacyDocumentConfigured: () => hostHasValidatedPrivacyDocument,
};
const pluginRuntime = createPluginRuntime({ storage, budget, consent, reasoning, registry, presets });
const handlers = createHandlers({ storage, pluginRuntime, consent, ownership, host });
```

Here `hash`, `walletForHash` and `creditTiers` are host functions implemented in
the reference file; the remaining configured ports come from the earlier mount
example. Supply the **same ledger** to runtime and wallet. `createHandlers` binds
`walletForSession` into runtime owner admission; `wallet(ownerToken)` serves
owned credit reads. During turn credit preflight, `wallet(ownerToken, context)`
and its `balance()` run inside the turn's database transaction. On the host
credit read path, `wallet()`, `balance()`, `canAdmit()` and `creditTiers()` must be
synchronous and side-effect free. `canAdmit()` and `creditTiers()` are not called
for initial turn admission.

- Allowed: synchronous read-only Aithema getters such as `storage.get(id)` and
  `storage.hostState(id)`, and SELECT-only statements on the host's own tables
  through the same SQLite handle.
- Forbidden: any write (INSERT/UPDATE/DELETE or DDL), any Aithema storage mutator,
  async or network work, and any `storage.transaction()`.
  `storage.transaction()` issues a plain `BEGIN IMMEDIATE` without savepoints;
  a nested transaction fails the turn with HTTP 500 and nothing saved.

In the reference, `balance()` and every `canAdmit`/atomic
`admit` read current SQLite settings, even on a previously obtained wallet.
There is no startup allowance cache. USD 10 changed to USD 5 changes the limit,
not the already committed amount. `committedMicro` includes ledger reservations,
confirmed and uncertain spend plus durable owner holds not yet in the ledger.
Never count a wallet hold and its ledger row twice. All conversations/tabs for
one owner share this balance; other owners remain independent.

The reference owner policy charges upstream `maxMicro` (including voice) and
therefore assumes visitor voice price equals upstream price. `maxVisitorMicro`
still bounds per-conversation voice in the ledger. Hosts with different visitor
pricing must implement that billing policy in their wallet, settlements and
extension checks; they must not silently reuse this upstream-cost policy.

The credits route and initial balance projection call
`wallet(ownerToken, { sessionId })` and `creditTiers(ownerToken, { sessionId })`
only after owner authorization. Existing one-argument callbacks may ignore the
context and retain their complete owner-wide receipt and copy. To project a
conversation allowance, return a wallet with `creditScope: 'session'`; the
receipt then includes `scope: 'session'`. The wallet's balance/displayBalance and
tiers must describe that requested conversation, while its admission methods
still enforce all applicable owner/address/day limits. This display contract
does not change `walletForSession`, runtime admission, or owner authorization.

A session-aware tier projection may return `dailyCapReached: true` when the
address's daily allowance prevents an upgrade. The receipt exposes that boolean,
suppresses `next`, `delta` and `canConfirm`, and the UI shows the dedicated daily
limit copy without an upgrade action. Hosts remain responsible for the cap's
policy, atomic enforcement and reset; the module does not infer it from a zero
balance. Session-aware demo receipts use the shorter no-top-up note in place of
the owner-wide demo slot. The UI remembers only this layout scope across sibling
switches while each new receipt loads. A host can also configure
`host: { credits: { scope: 'session' } }` to reserve it before the first receipt.

`creditTiers(ownerToken, { sessionId })` returns
`{ current, next, delta, canConfirm, allowancesMicro }` from those same live
settings. `next` is `emailGiven` for anonymous visitors only when it raises the
allowance, or `emailConfirmed` for email-given visitors only when qualified
confirmation is enabled and raises the allowance; otherwise it is `null` and
`delta` is 0. The owned `GET /api/sessions/:id/credits` exposes this as `tiers`.
With equal anonymous and `emailGiven` allowances, the payload for an anonymous
visitor keeps `next: null` and `delta: 0`; `creditTiers` does not skip directly to
`emailConfirmed` (`demo/visitor-credits.js:270-272`). The UI's `nextTier` is a
derived value, not another server field. Owner-wide receipts use `tiers.next`,
but session-scoped receipts can offer `emailConfirmed` while `current` is still
`anonymous` when the anonymous and `emailGiven` allowances are equal,
`canConfirm` is true and the confirmed allowance is higher, subject to the
verification, collection, end-reason and daily-cap gates
(`packages/ui/src/host-surface.js:106-116`). In that case, the UI shows the
confirmation action and confirmed-tier line, with no email-given upgrade line
(`packages/ui/test/host-credits.test.js:485-486`). After the visitor gives an
address, the payload's `current: 'emailGiven'` can offer
`next: 'emailConfirmed'` if qualified confirmation raises the allowance.
Set `privacyDocumentConfigured` only after validating the host's document, otherwise the server suppresses collection
and next-tier offers. Host identity/verification ports must also enable the
corresponding visitor actions before the UI can offer them.

Admission uses `admitCredits(budget, request, ownerWallet)` before provider claim
and dispatch. The owner wallet transaction atomically checks live policy plus
all conversations' committed costs and inserts a fingerprinted, durable hold.
It is idempotent per attempt ID and refuses mismatching session/lane/maxima/
request/binding fingerprints, even after release. The ledger then reserves under
the same ID. Definitive pre-dispatch refusal releases only that hold; uncertain
outcomes retain it for recovery. The fixture qualifies this contract with the
public conformance kit. The host must recover orphaned owner-only holds using
authoritative dispatch evidence; the reference conservatively retains them.

#### Address-derived daily spend guards (AIT-396)

The accounting-key prohibition above still applies: tier evidence and module
accounting remain bound to the owner hash. A host may separately enforce a
host-private address-derived spend guard, for example USD 30 per confirmed
address per day across owners. This is a host policy, not a built-in module cap
or a replacement owner identity. The reference tier fixture does not implement
it. This is design guidance, not a GDPR legal assessment.

Derive the guard key with a keyed HMAC over the host's consistently canonicalized,
server-confirmed address, using a secret host key and a distinct purpose domain
such as `daily-spend`. Plain SHA-256 or hashing with a public salt is insufficient:
addresses are guessable. Keep the key private, persist it securely, and ensure
rotation or restore cannot reset live buckets or strand their holds. Define
canonicalization explicitly; do not assume aliases are the same recipient or
treat an unconfirmed address as confirmed evidence.

Keep the guard counters separate from the owner ledger: retain only the HMAC,
day bucket, required amounts and expiry metadata there, without raw addresses,
tokens or visitor references. Any private attempt-to-bucket/hold mapping needed
for settlement is separate visitor-linked data with its own retention and
erasure duties. Never use the address or its HMAC as `session.ownerHash` or as
the module's accounting key.

Check and reserve the remaining address/day allowance atomically across **all
owners** sharing that guard, before dispatch, alongside the owner admission
contract. A read-only balance check followed by a later reservation can overspend
under concurrent tabs or owners. Use durable, idempotent attempt reservations;
enforce positive voice extensions too. Count confirmed spend, uncertain spend
and unresolved reservations once, without double-counting a host hold and its
ledger row. Release only with definitive evidence; recover orphaned holds from
authoritative dispatch/settlement evidence.

Define the calendar timezone (for example UTC), day boundaries and rollover
policy explicitly; a calendar day is not a rolling 24-hour window. Persist the
guard and day attribution at reservation, and define how dated extensions,
settlements and corrections affect buckets using the evidence described below.
Retries, restart, settlement after midnight and address changes must not silently
move or reset already attributed spend. New work uses the current confirmed
address; old work keeps its original attribution, and a changed address requires
fresh confirmation. Specify whether unresolved prior-day exposure also limits
new-day admission; rollover never releases a live hold.

Retain buckets and linkage only as long as needed for the declared daily guard
and unresolved settlement duties, then expire them with bounded cleanup that
also runs without new traffic. Define session, address and visitor erasure
handling explicitly, including the minimum evidence needed for unresolved holds.
Any guard retained after visitor erasure needs its own documented purpose and
expiry decision; the demo's separate 24-hour mail-abuse retention is not a spend
guard retention rule. HMACs are pseudonymous, not anonymous data.

#### Dated budget attribution (AIT-401, AIT-409)

For ongoing voice, the runtime calls
`budget.extendVoice(attemptId, totalMaxima, (extra, context) => wallet.canAdmit(extra, context))`.
The first argument remains `{ maxMicro, maxVisitorMicro }` with **additional**
maxima, and the return remains the cumulative `{ maxMicro, maxVisitorMicro }`.
Existing one-argument wallets keep the same calls and results, including a
zero-extra callback on duplicate or smaller cumulative maxima. The additive,
frozen second argument is `{ attemptId, sessionId, extraMicro, at }`:
`extraMicro` equals `extra.maxMicro` (upstream cost); visitor-priced wallets use
`extra.maxVisitorMicro`. All monetary values are integer micro-USD
(1 USD = 1,000,000 micro); `at` is Unix epoch **milliseconds**.

The callback is synchronous inside the ledger's `BEGIN IMMEDIATE` transaction.
Return `false` to refuse, or throw to abort: both roll back the extension and
any host writes on that same SQLite connection. Do not start a nested SQLite
transaction, await, or perform external side effects there. The reference uses
`db.isTransaction` to reuse that transaction. A zero-extra extension adds no
exposure and the reference wallet allows it even when over limit. Positive
extras require headroom. Policy changes can refuse or admit the next extension
while preserving existing reservations, exposure and settlement obligations.
Normal admissions recheck atomically after the preview, so concurrent
conversations cannot both spend the same room.

`budget.get(attemptId).voice_extensions_json` durably stores an ordered JSON
array of accepted increases, each
`{ maxMicro, maxVisitorMicro, extraMicro, extraVisitorMicro, at }`.
Maxima are cumulative; extras are the amounts added at that event, including
visitor-only increases. History and maxima commit together. Use the attempt ID
plus cumulative maxima as the event's idempotency key. Duplicate/smaller maxima
append nothing, pass zero extras, and reuse the latest committed extension's
`at`; without any prior increase, a zero-extra callback samples the clock but
records no event. Refusals leave no event. Only committed event times are stable;
a rolled-back admission may retry at a later time.

Every first settlement (`settle`, `settleVoice`, `settleComponent`, or `recover`)
atomically records `budget.get(attemptId).settled_at_ms` alongside the receipt.
Settlement methods also return this field. Exact terminal replays and repeated
recovery keep it unchanged across restart. Provider cost records' `settledAt`
use the same instant. Later reconciliation preserves the first settlement time;
its append-only correction records use the same clock. Replayed evidence adds
no correction. Migration adds an empty extension array and a nullable settlement
time to old rows: `null` means
unknown, and an empty array cannot reconstruct pre-upgrade extensions. Retain
host historical records for those rows; never assign them the migration day.

AIT-409 exposes two synchronous host reads on `SQLiteBudgetLedger` (also
`runtime.budget`): `budget.corrections(attemptId)` and
`budget.voiceExposures(attemptId)`. Both return an array of dated amount events:

```json
[
  {
    "id": 42,
    "attemptId": "attempt",
    "lane": "reaction",
    "atMs": 1792454460000,
    "oldMicro": 10000,
    "newMicro": 8000000,
    "oldVisitorMicro": 0,
    "newVisitorMicro": 0
  }
]
```

Like extension events, amounts use camelCase integer micro-USD fields and time
comes from the ledger clock. `atMs` is the posted epoch millisecond (the stored
`budget_corrections.at_ms`), not the admission or first settlement time.
Corrections include both reasoning/provider-cost and voice reconciliations;
`oldMicro`/`newMicro` are upstream settlement amounts, and
`oldVisitorMicro`/`newVisitorMicro` are visitor settlement amounts. The explicit
projection never returns `previous_json`, `evidence_json`, provider/session
details or secret references. Existing correction rows are readable immediately.
Correction `id` is the persisted row ID, and results follow posting order (`id`),
even for equal timestamps or a clock that moves backwards. Deduplicate by
`{attemptId, stream: 'corrections', id}`. Missing attempts and empty histories
return `[]`; reads change no ledger state.

`retainVoiceExposure` now atomically records each actual maximum increase with
the same shape in `budget.voiceExposures(attemptId)`. Here the old/new amounts
are the upstream and visitor maxima, `lane` is `voice`, and `id` is a durable
per-attempt sequence starting at 1. Deduplicate by
`{attemptId, stream: 'voiceExposures', id}`. Repeated calls with unchanged maxima
append nothing and preserve the original posting time, including after restart;
visitor-only raises also record an event. These are existing provider liabilities,
not admitted extensions: recording still occurs above the cap and adds no wallet
callback. The event, raised maxima and closing state commit or roll back together.
The backing `budget.get(attemptId).voice_exposures_json` defaults to `[]` for
pre-upgrade attempts; earlier exposure dates are unknown and are never assigned
the migration time. Preserve the host's historical accounting for those attempts.

These reads are provided by `SQLiteBudgetLedger`; a custom host-supplied
`budget` object does not gain `corrections()` or `voiceExposures()` automatically.
The host must supply equivalent dated records for its cap policy. Session
retirement purges `budget_corrections` rows and the attempt's exposure history.
Keep a host-owned copy of corrections and exposures needed for cap history
before retirement; rebuilding totals requires that retained copy, not just the
remaining core ledger rows.

Time comes from `host.now()` when supplied to `createHandlers`, including with
a prebuilt runtime. Otherwise the runtime-created ledger uses the runtime's
`now`; a separately supplied ledger uses its own `now` constructor option.
The default is `Date.now`. Clocks must return nonnegative safe integer epoch
milliseconds. There is no new settlement hook: durable receipt timestamps are
the smaller contract, avoid fallible host code during settlement, and let a
host rebuild totals after a crash. A settlement write failure rolls back its
time and receipt together; it leaves the reservation in place for retry.

`runtime.now` is a stable forwarding function. `createHandlers` installs
`host.now` through `runtime.setHostClock`; a constructor-supplied runtime `now`
retains precedence for policy decisions. Runtime-created render limits,
conversation limits and voice caps keep the forwarding function, so later clock
installation reaches both admission checks and atomic claim consumption. An
installed clock never clears durable usage or outstanding holds. A custom
`voiceCap` or `renderLimiter` must implement `setClock(clock)` before an explicit
runtime clock or host clock is installed; otherwise construction/installation
throws a named `TypeError` before changing the active clocks. Previously a
clockless custom cap was silently accepted; there is no documented exemption
for it. Wall-clock-only compositions without clock installation remain supported.

Independently created providers, consent ledgers, operator identity/session
ports, relays and coordinators are host-owned. When sharing absolute deadlines,
evidence or UTC-day limits, pass the same forwarding function into **every**
factory's `now` option (or the consent ledger's clock argument), including private
host modules. Do not capture `runtime.now()` as a fixed timestamp. For example,
after constructing the runtime and before registering/starting the provider:

```js
const provider = createVoiceProvider({ storage, binding, ...voicePorts, now: runtime.now });
registry.register(provider);
const coordinator = createComposedVoiceCoordinator({ ...coordinatorPorts, now: runtime.now });
```

The same rule applies to `createElevenLabsServer`, `createComposedVoice`,
`createGrokVoiceProvider`, `createVoxtralProviderAuthority`, `createCompletionsHandler`,
`createOperatorSessions` and `createZitadelOIDC`. The demo keeps a forwarding
getter during startup, passes it to independently composed server factories,
then links it to `pluginRuntime.now`. Admitted invocation `options.now` also
travels with its deadline into voice adapters, component budgets and visual
providers, including artifact provenance. Standalone callers must supply both
the deadline and its clock. Offline tests pin distinct wall/host clocks through
real handler wiring and the standalone ElevenLabs/coordinator/provider paths.

Accounting remains on `host.now` when an explicit runtime policy clock differs:
settlement time, reconciliation age, deferred receipt eligibility and retry dates
all use `budget.now`, the epoch that wrote `settledAt`. Storage event/content
evidence, retirement fences and provider-cap audits use the runtime forwarding
clock installed on storage, including when an explicit policy clock differs from
host accounting time. Local call reconciliation also measures duration on the
provider's clock; an elapsed receipt-lookup clock cannot change call age.
Storage's receipt-age check likewise uses the forwarding accounting clock
installed alongside its policy clock; a future policy epoch cannot prematurely
seal a fresh unsettled receipt. Its bounded retirement fence uses policy time.
Existing timestamps are never rewritten.

Elapsed transport budgets are separate: upload queue/parser CPU limits, receipt
polling, cleanup/drain timeouts, persistence throttles and audio pacing use a
local wall/monotonic duration clock, never a host calendar/day comparison.
Preview bearer TTLs use `performance.now` and expose durations only. Browser
transport/presentation clocks live in a separate realm; the server always
rechecks authoritative admission, consent, spend and browser-lease deadlines.
This server clock installation does not change UI labels or browser clocks.

For per-address **UTC-day** caps, keep the original hold on its admission day,
file each extension extra on `new Date(event.at).toISOString().slice(0, 10)`,
and file settlement above the reservation on the UTC day of `settled_at_ms`.
For example, a 1 USD hold yesterday extended by 9 USD today counts 9 USD toward
today's 30 USD address cap; it must not all be filed on yesterday's attempt.
A subsequent 11 USD settlement adds another 1 USD on the settlement day.
Derive dated holds from the host's original hold plus extension extras and
retained-exposure deltas (`newMicro - oldMicro`, and the visitor equivalents),
filing each exposure delta on the UTC day of `atMs`. Include exposure in the
reservation already accounted for when calculating settlement above that amount,
so a later settlement cannot double-charge the same liability. Allocate any refund
against the original dated holds rather than moving all spend to settlement day.
For each correction, file a positive `newMicro - oldMicro` (or
`newVisitorMicro - oldVisitorMicro`) on `new Date(event.atMs).toISOString().slice(0, 10)`.
Apply a negative delta against the earlier dated charges it refunds, not as new
headroom on the posting day. For example, a $10 uncertain attempt at 23:40 reduced
to the default $0.01 estimate at 23:45 can free $9.99 on that day. If the final
$8 receipt posts at 00:01, its correction charges $7.99 to the new day's $30 cap,
leaving $22.01 for new work. The old daily key may have expired; the correction
still carries its posted date and both amounts. The unchanged `settled_at_ms`
cannot date that later delta. Read these durable records in every admission transaction,
or reconcile a host projection idempotently before admitting more work: blindly
adding callback/receipt amounts to a separate wallet can double-file retries or
lose amounts on crash. Settled liability remains payable even above the cap;
the cap refuses subsequent admission rather than erasing provider costs.

No policy save changes owner tokens/hashes, ledger rows, attempt IDs, historical
spend, voice exposure or existing holds. Lowering below committed costs leaves
an overrun visible and refuses new admission; it does not refund spend or cancel
already dispatched work. Keep durable database files and operator state material
on the host's private persistent volume across restarts, close handlers before
storage, and run the normal `handlers.resume()` recovery at host startup before
accepting traffic. Recovery may conservatively settle unfinished module attempts;
it never resets settings or creates free allowance. The restart qualification
compares the persisted ledger before recovery and then exercises extension and
settlement explicitly, without contacting a provider.

The host fixture is an offline integration qualification, not proof that START
has deployed this policy. It deliberately provides no admin UI and performs no
live identity, mail, voice or paid calls. No shared server helper was extracted:
this host's small settings record/audit policy uses public storage directly and
does not copy the demo's identity, confirmation, mail-cap or settings schema.

## Server handlers

This complete local example starts a mock-only server. The memory ledger starts
with no consent; use the consent routes before any reasoning. SQLite is the
exclusive writer. Keep its database private and close handlers before storage.
No provider credentials or provider calls are involved.

```js
import { SQLiteStorage, createHandlers, createMemoryConsentLedger } from '@inspr/aithema-server';
import { listen, httpAdapter } from '@inspr/aithema-server/http';

const storage = new SQLiteStorage(':memory:');
const consent = createMemoryConsentLedger();
const handlers = createHandlers({ storage, consent });
await handlers.resume();
const { server, url } = await listen(handlers.handle, { port: 3000 });
console.log(url);
// A framework host can mount httpAdapter(handlers.handle) instead.
async function close() {
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close());
```

The default ownership adapter reads `x-aithema-session-token`. Supply an
unpredictable token when creating a session and retain it for every subsequent
request. A framework host should pass its own authenticated `ownership.token`
port (for example, its HttpOnly visitor cookie). A session ID alone is never
ownership. `POST /api/sessions` takes JSON and returns the public session.
The optional `ownership.created(response, ownerToken, request)` hook runs once
before returning a successful 201 from every session-creating route:
`POST /api/sessions`, `POST /api/library`, and `POST /api/library/:id/reset`.
Use it to set or renew the host's owner cookie; failed requests do not call it.
After upgrading to a release containing AIT-217, START can remove its
`compose.js` wrapper that calls `ownership.created` for the two library 201s.
`GET /api/sessions/:id/events` supplies durable SSE replay; `/export` downloads
the provenance-preserving ZIP. See the root README's route tables for commands,
settings, uploads, withdrawal, concepts, and host routes.

### Clarify now command (AIT-263)

`GET /api/sessions/:id` includes `openQuestionItems: [{id, question}]` for the
current final assessment. IDs belong to that assessment; replacements at the
same input revision also invalidate them. `inputRevision(session)` from core is
the client's revision token. SSE clients can derive items with core's
`openQuestionItems(session)`. Existing `understanding.openQuestions` stays an
array of strings.

Authenticated `POST /api/sessions/:id/focus-question` accepts
`{questionId, inputRevision}`. Success is HTTP 202
`{accepted: true, event}`. The durable event is the existing `question.focused`,
with `{question, questionId, requestId, chosenBy: 'user', inputRevision}`.
Focus changes neither the input revision nor the person transcript. The chosen
point is explicit host guidance for the next reaction prompt. Each attempt
uses ordinary reaction admission, including current consent, budget and host
conversation deadline checks. An already cached ordinary reply cannot suppress
this request. Automatic focus remains derived; user choice is erasable content.

Refusals are `{error: 'focus-refused', reason}`: `invalid-request` (400),
`stale-revision`, `stale-question`, `paused`, `reply-in-flight` (409), or
`consent-required`, `not-admitted` (403). Availability refusals also carry
`admissionReason` (including AIT-261's `one-hour` conversation deadline).
Wrong ownership uses the existing indistinguishable 404.
`stale-question` includes removed, clarified, draft/stale assessment and
withdrawn-source items. Only one reaction or focus availability request may be
in flight per session. Pending voice replies, speaking and unknown playback
state also refuse with `reply-in-flight`, including after availability checks.
Voice clients report speaking/listening through `control.reportActivity`;
these acknowledgements are private state, never transcript events.
Availability is rechecked transactionally before focus
publication; actual provider dispatch still belongs to reaction admission.

Completion is the usual assistant `turn.final` with `focusRequestId` matching
the focus event's `requestId`; normal `lane.status` / `lane.failed` describe
work and failures. After a failed attempt, `POST /api/sessions/:id/retry {}`
reuses the selected point with fresh admission. Reconnect retains recorded
failures and never retries them implicitly. New input or withdrawn evidence
invalidates the selection and prevents publication of its late reply.
An accepted selection survives a same-input assessment replacement when its
exact question text remains, including reordering. If the question disappears,
`lane.failed` carries `reason: 'focused-question-removed'` and `retryable: false`;
choose from the current assessment instead. Focus replies do not change purpose
classification, counters or direction history for unchanged input. Their host
instructions are covered by the private-guidance output check; the selected
public question text remains eligible for the reply.

The element exposes `openQuestionItems` and `focusQuestion(questionId)`. Each
current open point also has an always-visible “Clarify now” button in the overview.
This method resolves on 202, and throws the structured refusal on failure. Text replies follow normal SSE delivery. With
an active, audible ElevenLabs or local simulator call, focused assistant finals use the existing
call replay/speech path and its TTS admission, output mute, pause and lifetime
holds. Voice adapters expose the optional `VoiceSession.speakReply({turnId, text})`
port for already persisted replies. No synthetic SDK user message or transcript
turn triggers speech.

After a journal sequence gap, accepted snapshot recovery reconciles voice effects
from the previous local session: changed understanding, transcript or focused question
refreshes the active call's context; only a newly discovered, current selected
clarify completion is spoken. Repeated/concurrent snapshots and late journal
delivery do not speak known replies again. Muted, paused, withdrawn, erased,
superseded and stale replies stay silent. Server pause and lifecycle holds apply
before context or speech; an unpaused snapshot never creates a Resume command.
Skipped events are not re-emitted as `aithema-event` host notifications.

The overview controls follow these states:

- **Requesting:** start `focusQuestion(id)`; use reaction in `lane.status.running`
  to show the accepted request still working. Duplicate clicks get `reply-in-flight`.
- **Selected / asked:** `question.focused.chosenBy === 'user'` records the
  selection; matching `turn.final.focusRequestId` records the asked reply.
- **Stale item:** keep an old item ID, then replace the assessment, answer a
  question, or withdraw its input before submitting. Handle `stale-revision` or
  `stale-question`, refresh the snapshot and discard the old ID.
- **Retry:** fail or refuse reaction admission after focus was accepted; a
  current reaction `lane.failed` leaves the selection pending. Existing `/retry`
  attempts it again. A pre-acceptance consent or availability refusal needs that
  condition resolved before resubmitting the current item.

## Host retention contract

Use `await handlers.retire({ before, limit: 100 })` to erase **whole idle
sessions** and finish removing visitor-erased conversations, without possessing
visitor tokens. `before` is a nonnegative Unix millisecond timestamp; live-session
eligibility is strictly `lastActivity < before`. Erased sessions are eligible on
the next sweep after erase cancellation and the
`host.erased` hook finish, regardless of `before`. Visitor erase and library delete
queue retirement after that cleanup; direct storage erasure queues in the tombstone
transaction. A crash before queuing leaves a tombstone for startup backfill.
There is no additional idle window after erase or library delete. `limit`
is an integer from 1 to 1000 (default 100). The result is `{ retired, failed, more }`:
`retired` counts completed core erasures; `failed` counts sessions that failed
this call; `more` means another eligible, due retry or historical tombstone batch
exists. Repeated and overlapping calls are safe. An interrupted
retirement is durably queued and retried, including the host cleanup hook.
Hooks must therefore be idempotent. A failing session stays tombstoned and
pending with a durable attempt count and exponential backoff (1 second up to
1 hour); the batch continues. Deferred retries do not set `more`: call again
on the maintenance schedule even when `more` is false. Monitor `failed`;
host failures and pending reconciliation for erased sessions can delay deletion
beyond the intended retention window. AIT-421 applies the same bounded billing
wait and final accounting handoff to idle and visitor-erased sessions.

Last activity is the latest **server timestamp** of person- or host-initiated
activity: session creation, turns and other committed session changes, authorized
session and individual library requests (including reads and export), and the
completion of protected requests, streams and work the person started. Client
turn timestamps cannot backdate it. The rule lives in `SQLiteStorage.countsAsActivity`:
direct storage calls are host activity; `storage.systemWork(fn)` marks system work
and its asynchronous descendants as maintenance. System events, including
`expire` withdrawal events and the rebuild jobs they schedule, never renew the
idle clock. Hosts must wrap other system-originated work in `systemWork` too.
Failed ownership checks and read-only maintenance scans do not renew activity.
Expire and retire can use the same cutoff in either order without adding an
extra retention window. In-flight authorized requests, open SSE streams and running
text reasoning jobs exclude the session from retirement; active voice calls
and pending host deliveries also exclude it. An idle but connected page is therefore still active. Selection
and the final idle check run under the exclusive SQLite writer, before any
asynchronous cancellation or hook, so newly active sessions cannot be erased
from a stale candidate list. On migration, the latest stored event timestamp
initializes activity (unknown timestamps conservatively start at migration).

Retirement uses the erase route's `session.erased` invalidation: it broadcasts
and closes live streams and cancels lanes, concepts, uploads and voice. It then
seals billing, withdraws consent, awaits
`host.retired({ sessionId, ownerHash, attempts })`, and physically
deletes core rows in child-before-parent FK order, then the session. The owner
hash is captured inside the tombstone transaction. No owner token is invented;
the user erase route continues to use `host.erased({ sessionId, ownerToken })`.
The host hook runs after the tombstone commits and before the separate core
purge transaction; it may open its own transaction. The hook has a per-session deadline of 30 seconds (configure the positive integer
`retiredHookTimeoutMs` in `createHandlers`). A timeout or failure keeps core rows
pending for retry, counts as failed, and lets the batch continue. The timeout
cannot cancel host code; hooks must tolerate a late completion overlapping a retry.
Failures log only session ID and error class, never error content. Core purge and the final batch checkpoint truncate the WAL
for sessions already purged even if another session's hook fails.

| Data | After successful retirement |
| --- | --- |
| Session, settings, consent revision, owner hash | Deleted |
| Value-free event journal, receipts and content hashes | Deleted |
| Text, understanding, actor, focused question, identity and library projections | Deleted |
| Upload bytes, extracted text, concept blobs and feedback | Deleted |
| Host state, safeguards, voice calls, lifecycle and operation records | Deleted |
| Processing consent grants and history in the composed demo | Deleted |
| Per-session budget attempts, corrections, render claims, duration reservations | Deleted |
| Deployment spend, render and voice totals | Only value-free totals per account or UTC day remain; no session, owner, attempt or provider generation identifiers |
| Host-owned visitor accounts, mail, handover systems, backups and provider copies | Host controls their own retention; see below |

SQLite uses `secure_delete` and truncates its WAL before acknowledging the
full erase. Both idle and visitor-erased sessions defer while budget work or an
associated spend reservation is active, or while an uncertain/estimated receipt
can still reconcile. Deferral ends no later than one hour after the first
retirement check; settled receipts also stop waiting one hour after their first
settlement. Deadlines persist across retries and restart. Acknowledged estimates
without a scheduled retry may seal immediately; unknown legacy settlement dates
add no extra receipt window. Content remains erased while session/accounting
metadata await receipts. After the bound, retain the recorded uncertain liability,
seal it and proceed; never fabricate a final provider receipt or free capacity.
The existing spend/reserved/uncertain aggregation into `retired_spend` is unchanged.
A removed plugin clears its scheduled retry for erased sessions on its next due
reconciliation; live receipts remain retryable until retirement seals them.

The seal and `attempts` snapshot commit atomically before any async retirement
hook. SQLite rejects all subsequent budget-attempt inserts and updates with
`Retirement billing sealed`; rejected reconciliation also rolls back its correction.
A validated, seal-refused charge is recorded on the existing host spend reservation and counts in `retired_spend` when purged; attempts stay frozen.
The seal survives hook failure, timeout and restart. Budget recovery and reasoning
cost scans skip sealed attempts. Hosts must provide equivalent fencing for custom budget stores.
Each snapshot entry contains `attemptId`, `lane`, `state`, `outcome`, `settledAtMs`,
`settledMicro`, `settledVisitorMicro`, `maxMicro`, `maxVisitorMicro`, `final`,
`corrections`, and `voiceExposures`. The two histories use AIT-409's dated amount
shape and posting order; evidence, provider IDs and private usage are excluded.
`final: false` marks an unresolved liability, including an open attempt with null
settled amounts: keep the corresponding host cap closed under host policy until
that liability is resolved. Neither a lower estimate nor its reservation bounds a
possible late charge. Persist needed cap history idempotently before returning
from `retired`; the following purge removes attempts, histories and the seal.
`host.erased` remains the immediate resource-cleanup hook. A receipt committed
during it is included in the later `retired` snapshot, which is the final accounting
handoff for every erase path. No extra per-attempt records survive purge.

Retained totals
are deployment spend/reserved/uncertain amounts and breach flags per account,
render counts per UTC day, and spent/reserved voice milliseconds per UTC day.
On low-volume days, a daily total may reveal one session's usage. Daily buckets
remain necessary for daily cap enforcement; hosts should aggregate reports by
week and restrict access to raw daily accounting. This does not erase independent backups or remote provider copies.
Core removes only its own explicit table list. Hosts must clean their own SQLite
and external session rows in the idempotent `retired` hook, including in-memory
projections. Index host `session_id` columns to avoid a full scan per session.
Host FKs to `sessions(id)` or core child tables such as `content`, `uploads`
and `concept_artifacts` must be removed or detached before the hook returns;
a remaining FK blocks core purge and causes a retry. Host tables are never
automatically deleted merely because they have a `session_id` column. Hosts may
retain legally required records such as consent proof: that is their decision,
to document under their own policy, with a schema independent of the deleted
session (or a detached nullable FK). For example:

```js
const host = {
  async retired({ sessionId, ownerHash }) {
    storage.transaction(() => {
      storage.db.prepare('DELETE FROM host_consent_events WHERE session_id=?').run(sessionId);
      storage.db.prepare('DELETE FROM host_consent_grants WHERE session_id=?').run(sessionId);
    });
    await removeExternalSessionData({ sessionId, ownerHash }); // idempotent
  },
};
```

The demo deletes its own consent history, session mail outbox and wallet holds. Visitor identity, visitor credit
accounts and deployment abuse controls are separate host records, governed by
the host's visitor-retention policy. Shared owner credit guards are removed
when they refer to the retired session. Do not promise provider-side deletion
from this API.

For a 24-hour idle policy, run at startup and on the host's existing maintenance
schedule. Drain batches with a short yield between calls; serialize the loop:

```js
let retaining = false;
async function retainIdleSessions() {
  if (retaining) return;
  retaining = true;
  const before = Date.now() - 24 * 60 * 60 * 1000;
  try {
    while ((await handlers.retire({ before, limit: 100 })).more) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { retaining = false; }
}
await retainIdleSessions();
const retentionTimer = setInterval(() => void retainIdleSessions().catch(reportRetentionFailure), 15 * 60_000);
// Shutdown: clearInterval(retentionTimer), await any running maintenance, then close handlers/storage.
```

A 15-minute schedule normally deletes after 24 hours of inactivity **plus up to
15 minutes and backlog/maintenance delays**. Privacy copy must reflect that
window and distinguish idle retention from a fixed lifetime. The demo keeps its
existing one-minute schedule and 365-day cutoff for live sessions, retiring at
most 100 sessions per tick. Visitor erase and library delete clear content
immediately. After erase cleanup finishes, the next scheduled sweep attempts
complete removal (the demo ticks every minute; the example above every 15 minutes).
Actual removal waits for an eligible batch, any pending reconciliation described
above, successful host retirement cleanup and the core purge/checkpoint; backlog,
retry backoff and maintenance outages can delay it. Until successful retirement, the tombstoned
session, value-free journal, hashes and accounting links remain. Afterward all
core session rows are gone; only the deployment totals described above remain.
Host privacy copy must describe these conditions and delays together with
separate host/provider retention.

Existing databases need no manual data rewrite: an additive partial index finds
historical tombstones, and each `retire` call queues at most `limit` of them in ID
order. Reopening safely restarts this bounded pass without resetting pending
attempt counts or backoff. Run the sweep at startup and continue scheduled ticks
even when `more` is false. The older `expire(before)` only withdraws old
turns/uploads; it is not a full-erasure contract. Expiry and live retirement
candidates use the indexed live-session set; tombstone backfill uses its own
index and never hydrates the historical session set.

## Web components

A browser build needs an import map or bundler resolving workspace package
specifiers, plus module JSON support for the bundled display config. Serve JS
as JavaScript and JSON as `application/json`; Node's package exports do not
configure browser resolution. The UI does not install providers on import.

Serve the loading shell in the initial HTML, before fetching or importing the
browser module. On the host server, import the static helpers (they have no DOM
dependency) and append `firstPaintStyles` to the host's render-blocking CSS:

```js
import { firstPaintMarkup, firstPaintStyles } from '@inspr/aithema-ui/first-paint';
// GET /host.css: return hostPaletteCSS + firstPaintStyles as text/css.
// Initial HTML (link /host.css in <head>):
const shell = `<main class="aithema-shell"><aithema-session>
  <h1 slot="brand">Aithema</h1>
</aithema-session>${firstPaintMarkup}</main>`;
```

The `.aithema-shell` CSS hook hides unmounted host content and reserves the
same header, rail and 44px controls through definition, session fetch and
`configure()`. The component sets `data-aithema-mounted` after its synchronous
mount; the CSS then replaces the decorative, inert shell. Do not use `:defined`
as a readiness signal: definition can precede configuration. Keep the stylesheet
render-blocking so slotted titles never paint without their final styling.
This shell uses CSS `:has()` and targets evergreen browsers only; older browsers
without `:has()` support need a host-provided CSS fallback.
On startup failure, move the host title outside the hidden component, remove
`.aithema-first-paint`, and show an alert with a reload button there. The demo
also uses a 15-second deadline if `aithema-session` never defines; definition
cancels that deadline so session/network latency does not trigger it.

The default geometry uses a 1520px shell, responsive gutters and 216px desktop
/ 88px phone actions. The shell uses inline-size containment: its width must
come from its container, never shrink-to-fit its content. Keep `.aithema-shell`
and its band the same width; apply
`--aithema-shell-max`, `--aithema-gutter` and `--aithema-header-actions-width`
overrides to the shell and both direct children. First paint reserves voice rows
using shell content width (including classic scrollbars) and a 27vw brand bound.
For wider actions, append CSS from
`headerRailReservation({ actionsWidth: '280px' })` in
`@inspr/aithema-ui/first-paint` after `firstPaintStyles`; pass matching `gutter`
and `brandWidth` bounds when customized. Arguments must be literal CSS lengths
or expressions because queries cannot read custom properties. Stay within these
bounds so mount never adds an unreserved row. Supply `--paper`, `--surface`,
`--accent` and `--line` with the same theme selection before paint.

The browser configures the element already present in that shell:

```js
import { AithemaSession } from '@inspr/aithema-ui';
import { en } from '@inspr/aithema-ui/i18n/en';
import { createVoiceControl } from '@inspr/aithema-ui/voice-control';
import { AithemaHTMLPreview } from '@inspr/aithema-ui/html-preview';

const token = crypto.randomUUID();
const response = await fetch('/api/sessions', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token },
  body: JSON.stringify({ locale: 'en' })
});
if (!response.ok) throw new Error('Session creation failed');
const session = await response.json();
const element = document.querySelector('aithema-session');
element.configure({ copy: en, session, sessionToken: token, baseUrl: '' });
// Import registers <aithema-session> and <aithema-html-preview>.
// createVoiceControl handles neutral voice commands; supply adapter clients separately.
// Configure concepts.previewURL and enforce htmlPreviewHostPolicy(previewURL), as below.
```

AIT-352 and AIT-353 use an owner-minted route source for executable previews.
Configure the same canonical public URL on the server and component; there is no
raw `srcdoc` fallback:

```js
import { htmlPreviewHostPolicy } from '@inspr/aithema-core';
const previewURL = 'https://start.example.test/_aithema/html-preview';
const handlers = createHandlers({ /* storage, runtime, ownership, ... */
  concepts: { previewURL }
});
element.configure({ copy: en, session, sessionToken: token, concepts: { previewURL } });
const previewFramePolicy = htmlPreviewHostPolicy(previewURL);
// frame-src https://start.example.test/_aithema/html-preview; child-src 'none'
```

Merge those frame/child directives into the host's enforced response CSP while
retaining its strict script policy. Use the canonical exact URL without a query,
fragment, credentials or trailing slash. Do not keep another enforced
`frame-src 'none'` policy when switching to the route. Missing server configuration
disables minting; invalid configuration throws at startup.

For a host with a hash-approved import map, the **page response header** can be:

```http
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<base64-SHA256-of-exact-import-map-bytes>'; frame-src https://start.example.test/_aithema/html-preview; child-src 'none'; object-src 'none'; base-uri 'self'
```

Replace the hash with the digest of the exact inline import-map text and keep
startup code in external same-origin modules. Without an inline import map,
`script-src 'self'` suffices, as in the demo. The component verifies the enforced
frame policy with a scriptless `data:` frame probe; no head-meta declaration is
required. Remove any legacy head meta with `frame-src 'none'`: enforced policies
intersect, so an additional denial would still block the route. An overbroad
`frame-src 'self'` or a report-only policy fails the component's policy check.

The parent calls `POST /api/sessions/:id/concepts/:artifactId/preview` with its
normal owner authentication (header-token or host cookie adapter). No body is
required. A successful `200` JSON response is `{ url, expiresInMs: 60000 }` with
`Cache-Control: no-store`. Missing/wrong owners or artifacts return `404`;
publication/consent refusal returns `403`; methods other than POST return `405`.
A registry full of live tokens refuses minting with a plain `503`,
`Cache-Control: private, no-store` and `Retry-After: 60`; retry with a fresh mint.
The parent mounts that URL in an iframe with `sandbox="allow-scripts"` and
`referrerpolicy="no-referrer"`, retaining powerful-feature denials. Never add
`allow-same-origin`, top navigation, forms, popups or downloads.

`GET /_aithema/html-preview?cap=…` accepts only the capability, bypassing
owner cookies/headers and application session-auth middleware. A surrounding
reverse-proxy basic-auth gate still applies, as shown below. Tokens contain 256
CSPRNG bits, are stored only as hashes in a bounded process-local registry
(default 1024 entries), and expire in 60 seconds measured by a monotonic clock.
GET consumes the token before asynchronous checks. HEAD always returns `405`
with `Allow: GET` and `private, no-store`, without checking or consuming a token,
redirecting or setting cookies. Expired registry entries are purged first;
a full live registry refuses new mints instead of evicting live tokens.
Each session holds at most eight live tokens by default; exceeding that share
replaces only that session's oldest token. Ownership, consent revision, publication,
erasure and the artifact's digest/static policy are checked on redemption;
current ownership/consent/erasure/bytes are checked again after publication.
Restart, another instance, reuse, expiry or replacement at the session's own
quota requires a fresh mint.
The parent must re-mint on every retry/reload: **no network; a self-reload is refused**.
Already delivered bytes cannot be revoked, so lifecycle events must remove frames.

Successful preview responses carry exactly this policy contract (plus content
length and a digest of the served representation, including the trusted
`aithema-html-preview-ready` private-port bootstrap):

```http
Content-Type: text/html; charset=utf-8
Cache-Control: private, no-store
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https://start.example.test
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Denials are direct plain `403/404` responses with `private, no-store`,
`no-referrer`, `nosniff` and a script-disabled sandbox policy. No preview response
redirects or sets cookies. Keep the exact path ahead of login/SPA fallbacks;
strip cookies/owner headers and `Set-Cookie` at the reverse proxy, preserve the
application CSP, and redact `cap` from access logs/analytics. Do not append the
host page's script policy to preview responses or cache capability URLs.
For the OPS Caddy deployment, put the **exact-path** preview handler inside the
existing basic-auth gate, before the generic proxy. This example keeps that gate
on every path; supply the existing password hash through Caddy's environment and
retain the host's request-body limit. Set the host page CSP per page route,
never as a global header that also lands on the preview response.

```caddyfile
start.example.test {
    log {
        format filter {
            wrap json
            fields {
                request>uri query {
                    replace cap REDACTED
                }
                request>headers>X-Aithema-Session-Token delete
            }
        }
    }
    handle {
        basic_auth {
            operator {$BASIC_AUTH_HASH}
        }
        request_body {
            max_size 32MB
        }
        handle /_aithema/html-preview {
            reverse_proxy 127.0.0.1:8093 {
                header_up -Cookie
                header_up -Authorization
                header_up -X-Aithema-Session-Token
                header_down -Set-Cookie
                flush_interval -1
            }
        }
        handle {
            reverse_proxy 127.0.0.1:8093 {
                flush_interval -1
            }
        }
    }
}
```

Do not use `handle_path` (it strips the path), a wildcard path matcher, a login
redirect or an SPA fallback for this route. `Authorization` is checked at the
outer basic-auth gate and removed before proxying the preview; `Cookie` and the
owner token are removed too. The log filter redacts the `cap` query value in
`request.uri` and deletes the custom session-token header, which Caddy does not
redact by default. Apply equivalent redaction to any other access logs, traces or
analytics; never log the full capability URL. No new signing secret is needed.

The registry belongs to one server process. A restart invalidates outstanding
capabilities. Multiple instances must send mint and redemption to the same
process (for example with routing affinity); a capability minted elsewhere is
refused, and the parent must request a new mint on retry. Do not solve routing
misses or browser retries by making capabilities reusable. An already delivered
draft cannot have its bytes recalled: the host must propagate withdrawal,
consent revocation, erasure and session changes so the component removes it.
The security guarantee is **no network; a self-reload is refused**. The initial
capability redemption and an explicitly attempted self-reload reach the preview
route; the latter receives a plain `403`. The sandbox and page CSP block outbound
draft fetches, images, forms, popups, top navigation and other-page navigation.

The raw owner-only `/html` download remains an octet-stream attachment with
scripts disabled; standalone exports remain script-disabled too. Neither uses
the readiness bootstrap or the preview response's digest.

`configure({host})` enables selected library, verification, handover, credits,
locale and operator UI slots. It supplies presentation only; the server ports
still authorize every action. `voiceClients` maps allowed option IDs to browser
adapter clients; `voicePresentation` supplies that adapter's label and copy.
The Settings voice choice can also offer `grok-voice`, labelled “Grok Voice (xAI)”.
It remains **not yet qualified in live use**, including when account evidence is
current. ElevenLabs keeps its existing default. An unconfigured Grok option is
disabled with a short reason and a localized full tooltip. Selecting a configured
Grok option that lacks `voice-xai` v1 opens the existing consent editor before
saving the provider. Cancelling consent leaves the acknowledged choice in force.
A running call requires the inline **Switch and end call** action or **Cancel**;
its slot is always reserved. Closing media fences its old generation, and saving
a provider never starts another call. Success, cancellation and retry return
focus to the voice choice, with polite status announcements.

The runtime catalogue exposes `facts.providerProcessing`: `vendor`,
`recipientCountries`, `processingCountries` (null when no location is guaranteed),
and `verification` (`current` or `unverified`). This projection uses current
binding-specific admission evidence. Missing, expired or mismatched evidence
removes country guarantees; provider nationality and endpoint names never supply
processing countries. The existing provider disclosure renders recipient seat
separately from processing geography, without introducing legal entity names
for just one provider. For Grok with current account evidence, it says “Provider
based in the US (xAI)” and “Processed internationally; no guaranteed processing
location”. Its voice vial uses the existing neutral hatched Unverified style.

For the reference host, `AITHEMA_GROK_VOICE_HOST_MODULE` optionally names a
host-owned module exporting `createVoiceHost({ storage, publicOrigin,
resolveSecret, consent })`. It returns `{ plugin, binding, processingBindings,
handle, close }`: the fully bound Grok voice provider, its parent binding, both
STT/TTS processing bindings, and its authenticated relay handler/cleanup.
`consent.coverage` delegates to the same authoritative ledger as ElevenLabs.
The browser uses the normal voice control port and `/api/voice/grok/relay`;
the host must mount that same authenticated relay path. No private account
configuration enters `/demo/config`, the catalogue, or the browser. Without
this module an ElevenLabs host lists Grok as not configured. Qualification and
publication remain separate gates; this option does not qualify live use.

A host has bound voice when `voiceClient` is truthy or `voiceClients` contains
at least one truthy client under an option ID other than `off`. These clients represent the allowed catalog voice
options. An off-only/unconfigured host supplies neither (including an empty
`voiceClients` map); no rail, pause, microphone, synthetic-voice footer claim or
reply replay/text-reading action is mounted. This condition deliberately ignores
the currently selected voice, preset, consent and temporary availability verdicts:
a bound host retains its voice controls when voice is switched off or interrupted.
A catalog voice option without its browser client also mounts no voice chrome;
Settings continues to describe the server catalog. The demo maps an unbound
ElevenLabs runtime to `voiceMode: off`, so a setup `voiceDisabledReason` cannot
accidentally mount its browser adapter.
Hosts using the exported loading header can call
`firstPaintMarkupFor({ voice: false })` before serving an unbound host; the original
`firstPaintMarkup` export remains the bound-voice default. This keeps the phone
loading header at 68 px without painting voice placeholders.
The desktop header stays 90 px high through voice and conversation states;
the phone frame follows the approved voice-specific rows.

The host's `<h1 slot="brand">` is visible beside the orb and remains the page's
heading; without it the default brand keeps its previous hidden presentation.
At 600 px and above, legal links in `slot="legal"` stand at the right of the footer
bar on the entrance and in conversation. Below 600 px, an always-visible
**Rechtliches** / **Legal** button at the 12 px right gutter opens those links
directly in a non-modal popover above the footer. No legal anchor appears in the
phone footer row. `slot="footer"` stays in the info popup; the phone connection
timer also moves into that info popup.

The phone popover reads the assigned legal elements each time it opens and
creates shallow clones of their `a[href]` anchors, including anchors inside
wrappers, in host order. Each visible label uses the original anchor's
`textContent`; an `aria-label` is retained for accessibility without replacing
the visible text. The `href`, `target` and `rel` attribute values stay
byte-identical. Non-link slot content is omitted, and anchor child markup is
flattened to text. Host IDs, slot, class, style, `aria-labelledby` and
`aria-describedby` attributes are removed from the clones. JavaScript listeners
registered on the original anchors or their host wrappers are not transferred
to the shadow-root popover; hosts must provide working `href` navigation rather
than depend on those listeners. The original wide-screen slot remains in place.

The approved full AI label and connection status remain visible at 1024 px.
The connection label reserves the widest short label in the current language,
with the full description in its tooltip and a polite live region. The status dot
and timer stay in place when the connection changes. At 700–899 px only hosts
with visible credits hide the label; the named status dot stays visible.
Credit-enabled hosts retain compact balance details below 1100 px; phone footers
use the short AI label, retain its marker and omit the decorative credit track.
Use quiet underlined legal links. Slot anchors directly (`<a slot="legal" ...>`)
to receive the module's 44 px targets at 600 px and above. If you slot a wrapper
such as `<nav>`, its wide-screen nested anchors remain host-owned:
`::slotted(a)` cannot style descendants. The phone popover supplies full-width,
44 px link rows independently of those host styles.
Give each nested anchor at least a 24×24 CSS px target (WCAG 2.2, 2.5.8),
and 44×44 px on touch, matching the module. For example:

```css
nav[slot="legal"] a {
  display: inline-flex;
  align-items: center;
  min-width: 24px;
  min-height: 24px;
}
@media (pointer: coarse) {
  nav[slot="legal"] a { min-width: 44px; min-height: 44px; }
}
```

The visible product name stays **Aithema 2026.10**. `host.version` may carry
`version`, `version_scheme`, `commit` and `date` from the immutable manifest;
the exact coordinate appears in the existing hover/focus details only. A new
host-version row labels `host.version.version` with the brand slot's `textContent`
(whitespace collapsed and trimmed), or `Host` in DE/EN without a brand. Brand text
changes update that row in place; a host `product` value never replaces the
Aithema label. The popup orders the AI notice, Aithema version, brand-labelled
host coordinate and muted build details. Both coordinates use the existing Pretty
presentation; the host coordinate has no additional copy control. CalVer3
uses the pinned shared Pretty renderer there, with canonical copy, UTC tooltip,
keyboard/touch interaction and reduced motion. The popup shows the notice, then
`Version 26.10.14 · 08:00` on its own line, then the host row (for example
`START · 26.10.14 · 08:00`), followed by muted UTC build details.
Tick’s approved separators are passed to the shared renderer by the product
adapter, with weight 1 for hours/minutes and dark ink for segments/separators;
the upstream bundle and base config stay pinned. `release/presentation.json`
records these intended product overrides. Copy confirmation replaces the
version in a reserved slot for 1.2 seconds. Unknown schemes hide only the
version row and log once, leaving the session usable. Auto colors use the host branding;
`host.version.display: "semver"` selects the full reduced coordinate in that same
popup, with the same canonical-copy interaction. Legacy details remain plain.

To enable **Projekt erstellen / Create project** beside the conversation download
at the bottom right of the overview, pass both top-level component options:

```js
element.configure({ copy: en, session, sessionToken: token,
  paimosImportUrl: 'https://pm.augmentoring.com/import/project-draft',
  paimosImportVersion: 1 });
```

`paimosImportUrl` must be a full HTTP(S) URL without embedded credentials;
`paimosImportVersion` must be the number `1`. Missing, invalid or unsupported
configuration omits the action without reserving space. **START points at
pm.augmentoring.com**; the destination belongs to the host and is never hard-wired
in Aithema. The demo optionally reads `AITHEMA_PAIMOS_IMPORT_URL` and supplies
version `1`; it is unset by default.

Clicking submits a generated `<form method="post" target="_blank">` to that URL,
with exactly one hidden field, `payload`, containing JSON. This is top-level
navigation in a new tab, with no fetch/CORS exchange or Aithema credentials.
The v1 payload contains `version: 1`, `source: { product: "aithema", host,
session_id }` (the embedding page's host, including any port), `language`,
`title`, `summary`, `facts`, `open_points` and `transcript: [{ role, text, at }]`.
It uses the same current understanding and active, unerased/unwithdrawn turns
as the conversation ZIP: summary is the current assessment, facts are the
observed signals and open points are the open questions. The title uses the
first summary line (up to 200 code points), falling back to the overview heading;
turn timestamps retain their RFC3339 values. Artifacts and uploads are not part
of this contract.

Contract v1 (AEON-1441) limits the summary to **4,000 code points**, facts and open
points to **50 items each**, each item to **500 code points**, and the transcript
to **2,000 turns**. Overlong summary and item text ends with a counted `…`;
later items beyond the cap are dropped. The serialized JSON is capped at
**512 KiB in UTF-8**. Both transcript caps keep the newest whole turns, dropping
the oldest first. A localized omitted-turn note stays complete inside the summary
limit by shortening the summary body. Oversized metadata fails without submitting.
Paimos stores a single-use draft for 30 minutes,
then redirects to `/new-project?draft=<id>`; the person signs in normally to claim
it (AEON-1441 / r136).

The UI's optional `host.operator` configuration supplies `provider`,
`url: '/api/operator/login/'`, `logoutUrl: '/api/operator/logout/'`, and the
authenticated operator's `name`. Set `operator.adminUrl` only when the host
provides an admin destination, for example
`host: { operator: { provider: 'Zitadel', url: '/api/operator/login/', logoutUrl: '/api/operator/logout/', name: 'Ada', adminUrl: '/admin' } }`.
`adminUrl` accepts same-origin relative paths (such as `/admin` or `./admin`)
or absolute HTTP(S) URLs. Other schemes, protocol-relative URLs, backslashes,
whitespace and malformed URLs fail closed. Omit it when no admin page exists:
the name has no admin anchor, dot separators or reserved admin space; native
sign-out remains available. The complete operator line is built synchronously
before attachment. The demo host explicitly supplies `/admin`; admin pages
remain host-owned.

## Host ports and presets

Hosts supply `identity`, `library(ownerToken)`, `handover(ownerToken)`,
`wallet(ownerToken)`, `credits`, and their authoritative `consent.coverage` port.
Identity verification must be delivered and checked by the host. Enabling
`policy.verificationRequired` requires `identity.deliversVerification === true`
and actual verification methods. Host collection requires a configured privacy
document. Pass the same consent port to handlers and plugin runtime. Consent,
budgets, ownership and pause are checked before every dispatch.

`POST /api/sessions/:id/pause` checks privacy permission before unpausing an
address-bearing identity. A `privacy-document-required` refusal leaves the
session paused and its journal unchanged, and schedules no work.

### Consent documents in Settings

To let visitors edit consent in Settings, the same authoritative consent port
also implements `describe(sessionId)`. It returns the following JSON object,
either synchronously or through a promise. This is a current description of the
ledger, never a grant from the browser.

| Field | Type and requirement |
| --- | --- |
| `contract` | Required non-empty string identifying the exact current terms. Change it when those terms change; validate it again in `grant({ decision })`. |
| `items` | Required array of item objects, possibly empty if no processing is offered. Each has a unique non-empty string `id`, a `version` that is a positive safe integer or non-empty string, and non-empty strings `title`, `recipients` and `text` (purpose and data use). Strings render as text, never HTML. |
| `selected` | Required array of unique item IDs from `items`, including only currently valid grants for this session and contract. An empty array grants nothing. |
| `mock` | Optional boolean; absent and `false` mean a real document. `true` adds mock labelling. It never removes or replaces described items or changes their feature mapping. |
| `intro`, `withdrawal` | Optional non-empty strings for a host consent page's introduction and withdrawal terms. Settings uses the configured, localized `copy.processingConsent.intro`/`withdrawal`, or the mock host copy described below. |
| `optional` | Optional array of unique known item IDs, for host consent-page presentations. Settings displays all items. |
| `features` | Optional object (not null or an array). Every value must be an array of unique known item IDs; empty arrays are valid. The validator does not restrict its keys. Invalid supplied values fail closed, even though the server replaces a valid supplied map with its own derived map. |

For example, a host using the local processing scope can return:

```js
const currentConsentDocument = {
  contract: 'host-processing-v1',
  items: [{ id: 'mock-processing', version: 1, title: 'Conversation processing',
    recipients: 'Your host processor', text: 'Your messages are processed to answer and build understanding.' }],
  selected: [],
};
```

For provider bindings, an item's `id` matches the binding's processing-scope
`purpose`. The local `mock-conversation` scope also accepts the established
`mock-processing` item ID, for both real and mock documents. The server derives
`features` from the session's actual processing scopes and known item IDs;
a supplied `features` map must pass the validation above, then the server replaces
it with the derived map. Hosts cannot override this mapping. The
consent GET response adds `features: { [feature]: string[] }` for `text`,
`analysis`, `voice`, `transcription`, `images`, `html` and `uploads`. Empty arrays
mean no matching described processing. Settings requires a non-empty mapping
for the requested feature, focuses its first missing item and preserves the
other selections. Saving sends
`{ granted, processing: { contract, items, revision: consentRevision } }`;
the ledger must validate the contract, IDs and current revision authoritatively.

The existing one-item mock shorthand `{ mock: true, selected: [] }` remains
supported: `selected` may contain only `mock-processing`, and `contract` is
optional. Its item version is 1 and its visible item comes from the host copy.
For real documents, hosts **must** override the localized
`copy.processingConsent.intro` and `copy.processingConsent.withdrawal` with their
actual consent and withdrawal terms, including where consent is stored and how
long it applies. Settings reads these copy keys, not the optional `intro` and
`withdrawal` fields in `describe()`. The default intro describes the selection,
recipients and purposes; the default withdrawal explains how to withdraw and
that past transfers cannot be undone. Neither states where consent is stored
or how long it applies.

Consent decisions bind to the revision shown to the visitor (AIT-321). The
server adds `consentRevision` (a non-negative safe integer) to
`GET /api/sessions/:id/consent`. Send that value as `processing.revision` on
**every** decision, including withdrawal:

```js
const doc = await fetch(`/api/sessions/${id}/consent`).then(r => r.json());
await postJson(`/api/sessions/${id}/consent`, {
  granted: true,
  processing: { contract: doc.contract, items: selectedItems, revision: doc.consentRevision },
});
```

A mismatched revision returns HTTP **409**
`{ error: 'consent-stale', consentRevision: <current> }` before calling the host
ledger, revising consent, invalidating work or broadcasting. An explicitly
invalid revision returns HTTP **400** `{ error: 'invalid-consent-revision' }`.
Reload the consent document, show the current selection, and require a new
visitor action; never automatically retry the refused decision.

`consent.grant({ sessionId, consentRevision, decision, scopes })` receives the
expected revision in `decision.revision`; the outer `consentRevision` remains
the **next** revision being granted. An authoritative host ledger should also
compare the expected revision atomically before writing, including grants that
finish after a withdrawal. The server queues grants and document reads within
this handler instance, but HTTP and external withdrawals bypass that queue and
never wait on a pending host port. After each awaited port the server rechecks
the revision before calling another port; the final storage transaction compares
the captured revision before invalidation or append. A late grant returns 409
`consent-stale` and cannot restore the server's withdrawn consent. Shared host
ledgers must enforce their own atomic check; the server cannot undo host effects
that occurred inside an already running grant port.
The durable SSE event and POST acknowledgement share this additive shape:

```js
{ seq: 42, type: 'consent.revised', data: {
  granted: true, at: '2026-10-19T10:14:00.000Z',
  conversationUnchanged: true, // when the existing conversation is preserved
  changed: ['html-drafts'],
  removed: ['html-drafts'], // authoritative coverage losses, a subset of changed
} }
```

For grants, `changed` contains only scope names whose coverage differs between the previous
and accepted authoritative consent documents. Names are `text`, `analysis`,
`voice`, `transcription`, `images`, `html-drafts` (the `html` feature), and
`uploads`; unchanged coverage produces `[]`. It includes both additions and
removals, never selected item IDs, terms, recipients, contract strings or ledger
values. `removed` lists only the scopes that lost coverage; an empty list
confirms no coverage losses even if the client's document is stale. Both fields contain
only scope names, and caller-supplied values for either field are ignored. The server reads both
documents through the host port, rather than trusting the submitted selection.
For a revision-bound ledger, `describe(sessionId, { consentRevision, granted })`
accepts an optional context for reading the staged grant at the next revision,
before the journal commits it. `granted: true` indicates that accepted grant;
ordinary GET reads keep using the current committed revision. The reference
processing and mock ledgers support this context. Ledgers whose `describe`
already returns the accepted selection can ignore the second argument.

Both fields are optional for backward compatibility: hosts without `describe`,
legacy/unavailable documents and legacy events retain the previous shape. Optional
grant enrichment reads each have a 250 ms deadline; a timeout omits both fields
and retains the legacy refresh path. Full withdrawals through `POST /consent` include
every known scope in both fields as a revocation. The server-side `withdrawConsent(id)`
helper omits both fields, so the client takes the legacy (E2) refresh path. Both full
withdrawal paths bypass host document reads so host latency cannot delay them. Existing
consumers can ignore these optional fields. The UI removes a known withdrawn artifact kind
synchronously in the handler, then verifies through the normal refresh. A
revision-matched client document showing missing coverage identifies an addition.
With a stale client document, the server's `removed` list distinguishes grants
from withdrawals, preserving covered surfaces through grants while waiting for
the newer document. A stale document alone cannot delay scoped removal. Missing or unknown
scope names use the existing refresh path. The original two-second fail-closed
deadline and 2/4/8-second retry budget still apply; detach retains the unverified
state and reattach remains closed until a successful read.

A successful POST returns the committed `consentRevision`. The reference editor
confirms it against the current document and the exact selected item IDs, so
hosts may version their contract string on every grant or withdrawal. When the
confirmation document has no `consentRevision`, the editor retains the legacy
contract-plus-exact-items confirmation.

**Deprecated compatibility:** decisions that omit `processing.revision` retain
the previous unconditional behavior for existing hosts. They do not protect
against stale tabs. Migrate host decision writers to the document revision now;
removal of this compatibility path requires a separately announced breaking
host release. The reference Settings editor sends revisions whenever the server
supplies them.

A mock consent document uses `copy.host.*`; override it to match your ledger.
In particular, override `consentTitle`, `consentUse` (`off`, `html`, `images`)
and `consentPage.mockRecipients`, `mockConsequence`, `mockTerms`;
`consentPage.mockNotice` labels a full mock document. Defaults promise no ledger
duration or persistence. The demo overlays its existing twelve-month real
processing intro and memory-only/restart mock wording in `demo/consent-copy.js`,
used by both its host and consent page.

Invalid shapes fail closed before any editable items are exposed. The server
and UI share `validateConsentDocument` from
`@inspr/aithema-core/consent-document`. The host's log callback passed to
`createHandlers({ log })` receives `event: 'consent.document.invalid'` and a
field-specific `reason` beginning `Invalid consent.describe():`, without
document values. The HTTP response is a generic 500
`{ error: 'consent-document-unavailable' }`; visitors see the existing localized
consent failure state with saving disabled. Contract diagnostics stay in the
host log.

```js
import { PluginRegistry, createMockReasoning, PROCESSING_PRESETS, createBinding,
  createMemoryLibrary, assertLibraryPort, libraryConformance,
  assertHandoverPort, handoverConformance, assertOwnerWalletPort, ownerWalletConformance } from '@inspr/aithema-core';
import { createPluginRuntime, mockPresets } from '@inspr/aithema-server';

const reasoning = createMockReasoning();
const registry = new PluginRegistry().register(reasoning);
const presets = mockPresets();
// Given storage and the same host-owned consent ledger as the server:
function runtimeFor(storage, consent) {
  return createPluginRuntime({ storage, consent, reasoning, registry, presets });
}
// The reference library is memory-only. Production hosts persist owner-scoped records.
const library = assertLibraryPort(createMemoryLibrary());
```

`PROCESSING_PRESETS` contains `best`, `eu`, `device`, `custom`. The runtime's
`presets[preset].choices` contains `models` (separate `reaction`/`understanding`
bindings), `voices`, `visuals` (`images` or `html`) and defaults. Unbound options
stay unavailable. The `device` preset is a browser text-only carve-out; there
is no automatic server dispatch. `eu` needs qualified account-specific evidence
covering the exact route and current consent. A vendor's location alone never
admits processing. The mock presets do not qualify a paid provider.

Use `createBinding` for host-private text bindings. They contain plugin/model,
endpoint/routing, account and secret references, ceilings, prices and legal
qualification evidence. Secret resolution remains server-private; never
serialize bindings into plugin manifests, public sessions, docs or telemetry.
Voice, image and HTML bindings have their own validated contracts described in
the README. The host-port conformance helpers above test library, delivery,
wallet behavior and failure/recovery; they do not replace live qualification.

`legal.countries` lists the recipients' seat countries (ISO alpha-2); host
`policy.countries` filters those seats. Optional `legal.processingCountries`
lists the contractually guaranteed processing locations (ISO alpha-2, non-empty
when present). The `eu` preset requires both EU-only recipient seats in
`legal.countries` and EU-only guaranteed processing in `legal.processingCountries`,
with the existing no-training rule. Recipient seats alone do not establish
processing residency. A non-EU seat surfaces as `recipient seat outside eu`;
a missing processing guarantee as `processing countries missing`; a malformed
guarantee as `processing residency unverified`; and non-EU processing as
`processing residency denied`. The settings catalog exposes these reasons in
DE/EN and refuses the choice without switching presets. START hosts using `best`
need no change; `processingCountries` remains optional for non-eu presets
(explicit `undefined` is absent under every preset), and their country policy
filters keep their existing behavior.

For the plugin contract and the text, voice and image onboarding steps, see
[Adding a model](plugins.md#adding-a-model). The standalone external package proof
uses host configuration and public exports without core or server changes.

### Provider seats and the host privacy link

A private binding's `legal.countries` lists the **recipients' seat**, using ISO
3166-1 alpha-2 country codes (for example `['US', 'IE']`). It does not establish
or guarantee a processing location. For qualified bindings the public catalog
exposes these countries as `facts.hostCountries`; the host-countries privacy
gauge says “Providers based in …” and explains that processing may occur
elsewhere. The `eu` preset requires both EU-only seats and a separate EU-only
contractual guarantee in `legal.processingCountries`, as described above.
Existing enforced country policies retain their separate restriction wording.

The gauge localizes country names with `Intl.DisplayNames` and joins them with
`Intl.ListFormat` (long conjunction). The UI explicitly overrides the `US`
display name to **“USA” in German** and **“the US” in English**, so `['US', 'IE']`
reads “USA und Irland” / “the US and Ireland”.

Mark the host privacy-policy anchor with **`data-aithema-privacy`** in the
component's `legal` slot. The marker works on a directly slotted anchor or on
an anchor inside a slotted wrapper; text and URL names are never guessed:

```html
<aithema-session>
  <nav slot="legal">
    <a href="/legal/privacy" data-aithema-privacy>Privacy policy</a>
    <a href="/legal/imprint">Imprint</a>
  </nav>
</aithema-session>
```

For host countries, the help detail's “Datenschutzerklärung” / “privacy policy”
becomes a link to that anchor's web URL (relative URLs are resolved against the
host document). A host `target="_blank"` is preserved with `noopener noreferrer`.
Without a marked HTTP(S) link in the legal slot, the phrase stays plain text.
The privacy gauge accepts keyboard focus so the help link is reachable without
hovering. Host training metadata never implies “no training”; that wording
continues to belong to the existing enforced EU path. On subsequent catalog
reads, host qualification is recomputed at the runtime's `now()`; expired
binding evidence no longer qualifies the quality gauge.

## Shipped plugins

The following imports are checked against actual exports. They are factories,
not an instruction to contact these services. Production hosts provide their
own authorized binding, consent, budget and server-private secret resolver.

```js
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createMistralReasoning } from '@inspr/aithema-plugin-mistral';
import { createDeviceReasoning } from '@inspr/aithema-plugin-device';
import { createOpenAIImages } from '@inspr/aithema-plugin-openai-images';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { createCodexImagegen } from '@inspr/aithema-plugin-codex-imagegen';
import { createTextExtractor } from '@inspr/aithema-plugin-extract-text';
import { createPDFExtractor } from '@inspr/aithema-plugin-extract-pdf';
import { createOOXMLExtractor } from '@inspr/aithema-plugin-extract-ooxml';
import { createSmtpMail } from '@inspr/aithema-plugin-mail-smtp';
import { createZitadelOIDC } from '@inspr/aithema-plugin-zitadel-oidc';
import { manifest as elevenLabsManifest } from '@inspr/aithema-plugin-elevenlabs/manifest';
import { createGrokVoiceProvider } from '@inspr/aithema-plugin-grok-voice';
```

OpenRouter/Mistral are server reasoning adapters; device is browser-only.
ElevenLabs has separate server/client exports behind neutral live-voice ports;
the adapter owns STT, TTS and turn-taking, with delegated reasoning. The shipped
fake-voice sources are deterministic fixtures, not another qualified pipeline.
Grok uses xAI speech components with Aithema's separately admitted reasoning;
it remains **not yet qualified in live use**. See the
[Grok host setup](#grok-voice-host-setup-and-release-imports-ait-351).
OpenAI images, Claude HTML and Codex image generation preserve artifact
provenance and their distinct lifetime/cost contracts. Text/PDF/OOXML extractors
run bounded offline workers. SMTP and Zitadel implement host integration,
not conversation processing policy. Never infer legal qualification from a
technical plugin manifest. Plugin contract `apiVersion` ranges describe a
protocol, not the CalVer3 package compatibility promise.

### Required fast reaction route for voice (AIT-380, AIT-397)

The OpenRouter demo requires an explicit `OPENROUTER_SPEECH_MODEL` for every
configured voice option: ElevenLabs, Grok voice and composed voice. Select and qualify a fast reaction model that supports no
thinking; the demo explicitly configures its reaction effort as `none`. The
analysis model, effort and token ceiling remain separate. Analysis may continue
in the background and never gates the spoken reaction.

Missing or blank speech configuration, mismatched/expired account evidence, or a
reaction effort other than `none` refuses voice start. The operator receives:
`Voice configuration error: OPENROUTER_SPEECH_MODEL is required for voice and must name an explicitly qualified fast reaction route with effort none; voice start refused.`
This error is written only to the server log. Visitors receive the existing
voice-unavailable state; saved voice settings cannot bypass the refusal, including
after automatic voice-host recovery. Text-only
hosts can still use `OPENROUTER_MODEL`, but that text route never qualifies voice
implicitly. No model is silently substituted for the required voice route.

When a model option supplies separate `reaction` and `understanding` bindings,
a generic effort selection cannot raise reaction above its explicitly configured
effort. A host binding without an explicit effort keeps the offered selection.
The analysis lane retains the selected effort. The same ceiling applies to shared bindings when voice is selected. Shared
single-binding text-only options retain their existing effort-selection behavior.

Every host must configure a qualified `reaction` binding with effort `none`,
using a model distinct from its `understanding` (analysis) model, for every
configured voice option. This applies to ElevenLabs, Grok and composed voice,
with either `choices.models[].bindings` or legacy `bindings`. Allowlist the
reaction plugin and endpoint, and supply current matching account evidence;
the registered reasoning plugin must support streaming with effort `none`.
A generic effort selection cannot raise the reaction effort.

At runtime startup/voice registration, invalid combinations produce a server-only
`Voice configuration error` naming the preset, voice option and missing qualified
`reaction` binding, ending in `voice start refused`. The runtime refuses voice
admission and spoken reaction dispatch until the binding is corrected. Admission
rechecks the selected route, including saved settings, recovery and evidence expiry.
Visitors receive the existing neutral line, “Sprache ist derzeit nicht verfügbar” /
“Voice is currently unavailable”, and the call ends cleanly. The runtime never
answers on the analysis model by fallback. The canonical offline demo and local
voice simulator retain their existing behavior; text-only bindings are unchanged.

### Claude HTML bindings

`createClaudeHTML` accepts an `anthropic/claude-*` model (including
`anthropic/claude-opus-5.5`) or its supported `~anthropic/claude-*-latest` alias.
Its effort values are `none`, `low`, `medium`, `high`, `xhigh` and `max`, matching
our OpenRouter adapter's START 2026-09-13 `reasoning.supported_efforts` check.
The host allowlist must select an effort supported by the chosen model;
`require_parameters: true` prevents a silent provider fallback. See OpenRouter's
[per-model reasoning options](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options).
`none` keeps the existing `reasoning: { enabled: false }` request; other values
send `reasoning: { effort }`, for example `{ effort: 'high' }`.

The binding's `maxTokens` is sent unchanged as `max_tokens`: with reasoning on,
it is the **total reasoning plus visible output** allowance. Hosts must budget
for both; the adapter never raises that limit. Explicit positive `rates.inputUSD`
and `rates.outputUSD` are per-token USD prices. The preflight ceiling is
`ceil(serializedMessageUTF8Bytes * inputUSD * 1e6) + ceil(maxTokens * outputUSD * 1e6)`.
All reasoning and visible output tokens are reserved at the output rate in both
the spend ledger and the conversation admission estimate. Supply the same
`createSpendCap` instance through `spend` to share an account cap with other
plugins. A request exceeding the remaining shared cap fails with `not-admitted`
before fetch; a standalone ledger retains its `limit` refusal.

Settlement still uses the reported `usage.cost`, rounded up to micro-dollars.
OpenRouter's `completion_tokens` includes tokens itemized separately under
`completion_tokens_details.reasoning_tokens`; those tokens count once in output
usage and are billed at the output rate. A missing cost after dispatch retains
the full reservation as uncertain spend.

### OpenRouter image bindings

`createOpenAIImages` also accepts the `openai/gpt-image-2` model on
`https://openrouter.ai/api/v1`. The admitted binding selects the route: direct
OpenAI uses `gpt-image-2` on `https://api.openai.com/v1`. Mixed model/endpoint
pairs and other hosts are refused (loopback endpoints are for offline fixtures).
`baseUrl`, if supplied, must still match the binding endpoint.

The host can reuse its existing OpenRouter key through `secretRef`; keep its
resolver server-private. Attribution uses `routing.referer` and `routing.title`
as optional `http-referer` and `x-title` headers. Neither is a credential.

```js
const imageRoute = {
  plugin: 'openai-images', model: 'openai/gpt-image-2', effort: 'none',
  endpoint: 'https://openrouter.ai/api/v1',
  accountRef: host.openRouterAccountRef,
  secretRef: host.existingOpenRouterSecretRef,
  routing: { referer: 'https://start.example.test', title: 'START concept images' },
  maxMicro: host.imageCallCeilingMicro, maxTokens: host.imageTokenCeiling,
  rates: host.conservativeImageRates,
};
const imageBinding = {
  ...imageRoute,
  legal: {
    approved: host.imageLegalApproval,
    purpose: host.imageProcessingPurpose,
    recipient: 'OpenRouter, Inc.', processors: ['OpenAI'],
    countries: host.verifiedRecipientCountries,
    processingCountries: host.verifiedProcessingCountries,
    training: host.verifiedImageTrainingPolicy,
    retention: host.verifiedImageRetention,
    dataCategories: host.imageDataCategories,
    consentVersion: host.imageConsentVersion,
    evidence: {
      qualified: host.imageAccountQualified,
      accountRef: imageRoute.accountRef, secretRef: imageRoute.secretRef,
      endpoint: imageRoute.endpoint, model: imageRoute.model, routing: imageRoute.routing,
      verifiedAt: host.imageEvidenceVerifiedAt, expiresAt: host.imageEvidenceExpiresAt,
    },
  },
};
const images = createOpenAIImages({ binding: imageBinding, resolveSecret: host.resolveSecret });
```

These host fields require actual account evidence; the adapter supplies no legal
defaults. `countries` describes recipient seats, while `processingCountries`
describes guaranteed processing locations. Both recipient and upstream processor
must appear in consent: `processingScope(imageBinding, 'generate')` (and `'edit'`)
includes `recipients: ['OpenRouter, Inc.']` and `upstreamProcessors: ['OpenAI']`.
Prompt and reference-image transfers must be covered by the host's current grant.
The public model qualification remains `unverified`.

Gateway generate and edit send JSON to `/images`. References are private bytes
encoded as data URLs in `input_references`, at most nine images of at most 12 MiB
each, including the previous artifact first on edit. Output must be inline
`data[0].b64_json` containing PNG or WebP. Gateway URL-only results are refused:
START v1 used inline bytes, and supporting downloads would add another transfer
origin to that contract. Direct mode retains its multipart edits and private
download-origin allowlist.

OpenRouter `usage.cost` is authoritative USD spend, rounded up once to microUSD
and reported as `chargedMicro`, independent of token-rate estimates. Missing or
invalid cost settles as `uncertain`, retaining any known token usage and the
host's reservation rather than implying a free image. Provenance identifies
provider `openrouter`, model `openai/gpt-image-2`; the label identifies the route.
No paid qualification call is part of this adapter's offline tests.

For audit and reconciliation, the gateway adapter validates OpenRouter's
[`X-Generation-Id` response header](https://openrouter.ai/docs/api_reference/streaming#additional-information)
with the core `generationId()` helper and records it on the invocation and spend
reservation, alongside any `chargedMicro` receipt. OpenRouter documents this header
for all endpoints; its presence on `/images` responses is inferred from that
documentation and has not been live-verified. A valid header takes precedence
over the existing top-level JSON `id` fallback. The public
[image response model](https://github.com/OpenRouterTeam/typescript-sdk/blob/d937c4e63256004b2b4bc5a8de7753256ad4bb4f/src/models/imagegenerationresponse.ts)
defines `created`, `data` and optional `usage`, with no generation ID field.
If neither source supplies a valid ID, the reservation has no provider generation
ID; its `attemptId` and reservation id identify it locally. Settlement and
admission do not depend on a generation ID.

### Mail copy and privacy links

The SMTP plugin accepts `copy: { en: { ... }, de: { ... } }`. Each supplied
field overrides `mailCopy`; missing fields and locales retain the demo defaults.
The subject, plain text and HTML use the same merged copy. Unknown locales or
fields and non-string values fail at construction. `brand` defaults to
`Aithema`; the `host` signature supports `{brand}` and `{host}`. Override both
`explanation` (with an allowance) and `explanationFallback` (without one) when
the host uses a sign-in flow rather than the demo's credits.

```js
import { createSmtpMail, smtpConfig } from '@inspr/aithema-plugin-mail-smtp';

const mail = createSmtpMail({
  config: smtpConfig(hostSmtpSettings),
  publicOrigin: 'https://start.example.test',
  privacyUrl: locale => `https://start.example.test/privacy?lang=${locale}`,
  copy: {
    en: {
      brand: 'Augmentoring Start',
      explanation: 'Confirm your address to sign in.',
      explanationFallback: 'Confirm your address to sign in.',
      host: 'Sent by {brand} at {host} because you requested a sign-in link.',
      privacy: 'We use your address to sign you in and delete it after 24 hours.',
      retention: 'Please delete this sign-in message within 24 hours.',
    },
    de: {
      brand: 'Augmentoring Start',
      explanation: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      explanationFallback: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      host: 'Gesendet von {brand} auf {host}, weil Sie einen Anmeldelink angefordert haben.',
      privacy: 'Ihre Adresse wird zur Anmeldung verwendet und nach 24 Stunden gelöscht.',
      retention: 'Bitte löschen Sie diese Anmeldenachricht innerhalb von 24 Stunden.',
    },
  },
});
```

`privacyUrl` can also be an absolute HTTP(S) URL string. A function must return
a string synchronously; it is called and validated once for each supported
locale (`de`, `en`) at construction. The validated URL appears in both parts.
Without this option, `/privacy?locale=<locale>` appears only when
`privacyDocumentConfigured` is true, preserving the demo's behavior. Copy
changes wording, not the host's storage/deletion policy. HTML escapes copy and
URLs; custom `htmlTemplate` functions receive the same merged `copy` and should
render its wording. See the [plugin README](../plugins/mail-smtp/README.md) for
the full field list and fallback behavior.

## Document extraction limits

The offline text/PDF/OOXML extractor ceiling is **20 MiB (20,971,520 bytes)**.
An input of exactly that size can extract; a larger input returns
`unreadable` with reason `limit`. Other format, archive and worker bounds still
apply. Hosts can only lower extractor ceilings, including per-call overrides;
raising an override is clamped to the configured ceiling.

| Extractor bound | Ceiling |
| --- | --- |
| Source bytes | 20 MiB |
| Retained text | 60,000 characters, including segment separators |
| PDF pages / Office sheets or slides | 100 |
| Worker deadline | 10,000 ms |
| V8 old-space limit (`maxHeapMb`) | 128 MiB |
| Worker RSS watchdog | 384 MiB, sampled every 25 ms |
| OOXML ZIP entries | 512 |
| One uncompressed ZIP part | 16 MiB |
| Total uncompressed ZIP bytes | 48 MiB |
| ZIP compression ratio | 100:1 per part |
| Core `UPLOAD_LIMITS.maxRequestBytes` | 21 MiB |
| Server multipart request default/ceiling | 21 MiB (hosts may only lower it) |
| Server file default/ceiling | 20 MiB |
| Server files per request / documents per session | 8 / 8 |
| Server source-byte budget per session | 160 MiB |
| Upload request budget | 25,000 ms |

Uploads use literal `multipart/form-data` file bytes, without base64 encoding.
The core request budget allows one 20 MiB document plus 1 MiB of form framing;
the HTTP regression verifies the original bytes reach admission intact. The
server enforces the same 21 MiB request ceiling, which hosts may only lower.
At most three requests per server process reserve admission from before body
reads until all their files finish extraction. A full reservation returns a
retryable HTTP 429 busy (`upload-rate-limit`) before reading the body. The UI
plans sequential batches against the advertised limits (20 MiB/file and
21 MiB/request if the limits GET fails) and retries busy responses up to three
total attempts, waiting 5 then 10 seconds or the longer `Retry-After` delay.
Busy is shown only after the attempts fail. The conservative default payload
and worker allowance is **570 MiB**, plus fixed/service overhead, GC/allocator
slack and watchdog overshoot; see the [memory formula](extractor-limits.md#pending-jobs-and-resident-memory-round-2).
Only extracted
text survives completion; truncation remains explicit through `truncated: true`.
Image-only PDFs remain unreadable without OCR.

[AIT-219 measurements and reproduction](extractor-limits.md) record three runs
per format and size on mbp2606. The normal 20 MiB fixtures leave at least 30%
headroom for heap, RSS and elapsed time under the unchanged bounds. The
adversarial OOXML and PDF fixtures still trip safety bounds; a file's byte size
alone does not guarantee extractability.

## Version source, release mapping and rollback

`release/version.json` is the sole authority. The owner-authorized candidate reserves
one UTC second with `status: reserved`, an increasing `release_sequence` and
scheme `inspr-calver-3`.
`reserveVersion` accepts explicit candidate authorization separately from a
publish go. A candidate reservation authorizes no tag or registry publication.
The fixed `dry_run_version` remains test input only. Reuse the reserved
coordinate in every candidate/release output; build machines never choose their
own coordinate. The channel's next reservation must be strictly later; a same-second collision waits for the next
second. Retain the candidate source commit and manifest digest; rebuild that exact commit
with the same toolchain. The source-commit argument to `release:pack` allows that
reproduction after evidence-only commits. Changed product bytes require a new
candidate and a new coordinate before publication.

New reservations declare `inspr-calver-3` (**INSPR-CalVer3**),
`YYMMDDhhmmss.0.0`; npm accepts this syntax. MINOR/PATCH stay zero and caret/tilde
compatibility semantics do not apply. Workspace manifests and lock entries mirror
the reserved coordinate with exact internal dependency pins. The packer also
derives public plugin manifest versions from that source. External dependencies
retain their exact lock closure.

The historical release-order mapping is in `release/history.json`: the 11
legacy v0.x releases, ending `0.10.1`, followed by the first October release,
`261015164601.0.0` at ordinal 12. The migration anchor keeps that first calendar
coordinate fixed; subsequent releases extend the mapping by ordinal. Mixed-era
ordering requires the explicit anchor/channel/ordinal. The archived `legacy-semver-public` and `legacy-semver-private` declarations are explicitly accepted as legacy types and preserved verbatim; the new history mapping never rewrites their manifests. CalVer2 history remains readable as its own declared
identifier; v1 dates and legacy stable SemVer remain tagged types. No old tag,
release, artifact or signed attestation is renamed, rewritten or republished.

The PR unit job runs `release/dry-run.mjs`: pack twice, compare exact bytes and
manifest, and verify every member. It also runs the candidate and isolated
consumer checks; CI retains preparation artifacts for 90 days. `release.yml`
accepts only a pushed tag whose exact name matches the reservation and whose
commit belongs to `origin/main`. That tag job builds and tests the shipped
archives, attests them and publishes the immutable GitHub release. There is no
manual publication trigger or npm publication. The builder creates no tag;
OPS follows [the release runbook](../release/README.md) after Tick's QA and
Markus's Desk go.
Canonical release bytes use Node 24/GNU tar in CI. Byte reproducibility is
verified per runner; reproducibility across machines is out of scope. BSD tar
can prove two local packs identical but is not claimed to reproduce GNU bytes.
Rollback reuses the stored bytes.

The release set records source commit, source tree/lock digests, all member
digests, package coordinates, version scheme/channel/sequence and the packing
run. The commit checks page references real CI/merge-queue validation; packing
is not a validation run. Canonical runtime metadata is also generated inside
the server package, so it does not depend on the repository-level `release/`
directory when distributed separately. Preserve the tarball, manifest and signed
attestations together. Runtime metadata and exported ZIP generator provenance use the artifact's source commit,
not a caller-supplied replacement. AI notice, text producer identity,
AI-generated/manipulated disclosure and image/HTML sidecars stay intact.

Rollback takes a retained trusted release-set manifest and an exact
`(channel, version, artifact coordinate, sha256)` through `rollbackArtifact`.
It verifies retained bytes and records a new deployment event without rebuilding,
decrementing, reusing, or moving the release coordinate. A rollback fix is a new
later release. Dry-runs cannot serve as production rollback evidence. Existing
legacy rollback continues through the original immutable v0.x artifacts.

## Historical qualification checklist — first reset candidate

This checklist records the first candidate's preparation state. Unchecked items
describe that checkpoint, not the current publication status. For published
releases and their limits, see the [releases page](https://github.com/inspr-at/aithema/releases)
and [release notes](../release/notes.md).

Merged implementation and deterministic tests prove code delivery. They do not
prove measured provider performance, exchangeability, live deployment or adoption.
At that checkpoint, independent cross-family review remained pending and was
not run by the builder.
The value-free migration inventory is `release/inventory.json`, owned by AIT-32.

- [ ] Controller review of the version inventory, consumers, legacy anchor and compatibility window.
- [ ] Independent review of the exact shared presentation source/config/manifest pins in `release/presentation.json`; reproduce the closure with upstream `scripts/versioning-bundle.mjs <full-source-commit> <config-sha256> <new-directory>` on the build runner. The source repository is private: public PR CI verifies the pinned offline closure, and never obtains broader source access or new credentials. A build runner with that exact source checkout can use `node release/verify-upstream-presentation.mjs <source-checkout>` to regenerate and compare all bytes. That independent source re-export/pin review remains pending, and the payload is not adoption evidence.
- [x] Reserve the first candidate coordinate; build all package tarballs twice and verify identical digests (`release/candidate.mjs`).
- [x] External consumer imports every documented symbol and runtime export, mounts handlers and web components, locks dependencies, updates the dependency pin and rolls back retained candidate bytes (`release/consumer.mjs`). This is scratch-host evidence, not a START production deployment.
- [x] Wire tag-only GitHub artifact attestation (`.github/workflows/release.yml`); at that checkpoint, signed bundles awaited an authorized tag build.
- [x] AIT-139: **60-minute soak not measured** (Markus: “Kein Test”); explicitly stated in the release notes, not a release blocker.
- [x] AIT-160: **second voice pipeline not yet proven** (parked); explicitly stated in the release notes, not a release blocker.
- [ ] Independent presentation pin review stays with the cross-family gate.
- [ ] Markus's separate Desk publish go; candidate preparation itself performed no tag, GitHub release or registry publication.

Public code remains **AGPL-3.0-only** throughout core/server/UI/contract/plugins.
D3 revised (2026-10-09) retains INSPR's rights and allows the planned special
licence to Augmentoring to be formalised once real customers exist. DCO alone
is not a relicensing agreement. The superseded slice-10 legal check is dropped;
this preparation creates no licence grant. See README “Ported from START” and
its rights notes for source provenance.

## Consumer export surface (AIT-205)

German-first hosts import `de` from `@inspr/aithema-ui/i18n/de`; English hosts
import `en` from `@inspr/aithema-ui/i18n/en`. Both bundles have identical keys,
recursively. Operator copy belongs to `demo/admin-copy.js`, alongside the
internal operator page and HTTP handler; it is absent from these visitor bundles.

Live voice hosts import `createElevenLabsVoiceHost` and
`normalizeElevenLabsDurationBinding` from
`@inspr/aithema-plugin-elevenlabs/voice-host`. The factory retains startup
read-back, receipt-based ownership, retry/backoff, atomic availability and orphan
reconciliation. Supply `storage`, `resolveSecret`, `publicOrigin`,
`templateAgentId`, `agentName`, `facadeSecretName`, `spokenOpeners` (`de`/`en`,
including the mandatory AI notice), `costConfig` (an object or a function of
`values`), and `qualifyBinding` (the host's legal qualification function).
`accountRef` defaults to `agentName`; optional `apiBaseUrl`, `fetchImpl`, `log`,
`random` and `values` support host configuration and deterministic tests.
The costs contain `maxDurationSeconds`, `reservationSeconds`,
`minRunwaySeconds`, `upstreamMicroPerMinute` and optional `usdPerCredit`.
The returned host exposes `binding`, `runtime`, `disabledReason`, `transient`,
`presentation`, `onAvailable`, `closeOrphan`, and `close`. Qualify the legacy
binding in the callback, then normalize it before creating a duration binding.
`agentName` and `facadeSecretName` must be explicit host-specific identifiers;
`costConfig` and `qualifyBinding` are required. Missing or invalid arguments reject
before any provider access; there is no fallback to Aithema's agent.

At startup, `ensureAgent` GETs the receipt-owned agent and compares only the
configuration it manages. An unchanged agent receives exactly one agent GET and
no agent PATCH; a missing agent is created and its ownership receipt stored.
START's template is always GET-only. Every create or PATCH is followed by a GET
and verification before voice becomes available. Secret reconciliation (including
the facade-secret PATCH on restart) remains unchanged.

Managed fields are `name`; `conversation_config`'s `tts` (template voice/model,
stability, similarity boost, style, speaker boost, speed, streaming latency,
output format and nested voice settings when supplied), `asr` (template quality,
provider, input format and host keywords), `turn` (template mode and host turn
policy), `conversation` (duration and client events), `language_presets` (empty),
and `agent` (language, AI first message, empty prompt/tools/knowledge base,
custom LLM/model/callback/secret reference); and `platform_settings`'s template
privacy flags/retention, host auth/allowlist and override policy. Other provider
fields, including timestamps and version IDs, are ignored.

Object key order is irrelevant. Arrays retain order, empty maps are intentional
clears, and strings compare exactly: whitespace in prompts or first messages
counts as drift. Only omitted TTS `stability=0.5`, `speed=1` and
`similarity_boost=0.8` normalize to those defaults. Nulls and type differences
remain drift, as do missing identity/security fields and non-default values.
Extra explicitly false conversation-override flags equal disabled defaults;
unknown enabled flags or malformed leaves require repair.

The [agent PATCH API](https://elevenlabs.io/docs/api-reference/agents/update)
accepts optional top-level `name`, `conversation_config` and `platform_settings`.
Only changed top-level fields are sent; a changed configuration object contains
its full managed set because nested replacement/merge semantics are not
guaranteed. OPS receives a structured log with the existing `name`/`id` and
`message`: `elevenlabs agent ensured: unchanged`,
`elevenlabs agent ensured: patched (fields: a, b)` (dotted managed field names),
or `elevenlabs agent ensured: created`. Logs never include configuration values,
prompts or secret references.

The demo's thin wrapper supplies its own START qualification, costs and openers;
undefined options preserve those defaults.

`@inspr/aithema-server/dev/local-voice` exports `createLocalVoiceProvider`,
`localVoiceBinding` and `isLocalVoice` for **development and tests**. Construction
refuses `NODE_ENV === 'production'` unless the host explicitly passes
`allowProductionSimulator: true` to `createLocalVoiceProvider`. This opt-in is only
for a deliberately simulated production-hosted demo; it does not provide real
voice or a production provider. It needs durable storage but no credentials
or external provider. Its implementation and manifest ship inside the server
package; the existing fake-voice fixtures forward to that single implementation.

Budget, host handlers, image binding, memory consent, operator sessions and spend
cap helpers already come from `@inspr/aithema-server`'s root export. No separate
subpaths are needed. Icons, JSON requests, reason formatting and release metadata
remain internal: hosts can supply their own small UI/transport helpers and build
metadata. The demo's operator page is internal for this release; consuming hosts use the
[documented host settings/admin integration](#visitor-tier-settings-and-host-administration-ait-320).

The demo browser currently resolves source URLs without an import map. Its
`host.js`, `consent-page.js`, shared `admin-view.js` and test-only `fake-voice.js`
retain those browser paths; every other non-test demo module uses package
specifiers. The unified [module boundary policy](architecture.md#allowed-edges) defines
and checks those exceptions with the packages/plugins rules. Existing static routes continue to serve package component dependencies.
The packed consumer imports every runtime subpath and also attempts each
types-only subpath, asserting Node's expected rejection and its installed type
file. It checks recursive German/English key parity on every install/reinstall
and rollback, outside the workspace.

The symbol audit of the original MISS rows is:

| Module | Decision and symbol-level reason |
| --- | --- |
| server/budget | Existing public root: `SQLiteBudgetLedger` is already re-exported. |
| server/host-handlers | Existing public root: `privacyDocumentConfigured` is already re-exported. |
| server/image-binding | Existing public root: `imagePluginBinding` is already re-exported. |
| server/local-voice | New public dev/test subpath: START needs a credential-free funnel; never production. |
| server/memory-consent | Existing public root: `createMemoryConsentLedger` is already re-exported. |
| server/operator-session | Existing public root: `createOperatorSessions` and `createSQLiteOperatorStore` are already re-exported; the demo operator page stays internal; host administration uses the documented AIT-320 integration above. |
| server/release-info | Internal: the demo reads its own reservation/runtime build metadata. |
| server/spend-cap | Existing public root: `usdMicro` is already re-exported. |
| ui/i18n/admin | Internal: copy moved to `demo/admin-copy.js` with its page and HTTP owner; visitor bundles no longer carry it. |
| ui/i18n/de | New public locale subpath: START is German-first; `de` was unreachable through exports. |
| ui/icons | Internal: the demo owns six small Lucide utility glyphs. |
| ui/post-json | Internal: a small host-side JSON POST helper suffices. |
| ui/settings-dialog | Internal: the demo owns its small reason formatter, without exposing the dialog implementation. |
| elevenlabs/config | Public through `./voice-host`: `normalizeElevenLabsDurationBinding` is needed at the host's adapter boundary. |
| elevenlabs/ensure-agent | Internal implementation behind public `createElevenLabsVoiceHost`; ownership/read-back and retries stay in one implementation. |
| plugins/fake-voice/client | Internal test-only fixture: retained browser simulator path, no public plugin package. |

Round 5 integration keeps consent coverage on the existing core root export:
`plugins/elevenlabs/src/components.js` and
`plugins/composed-voice/src/configuration.js` import `consentCoverage` directly from
`@inspr/aithema-core`, whose index already re-exports it; no `./consent` subpath or new public symbol is added.
The composed-voice adapter, Voxtral adapters and ElevenLabs `components.js`
remain source-only prototypes, omitted from module tarballs. The installed
ElevenLabs live-voice provider is unchanged. The generic component contract and
helpers below are supported and included in core tarballs.

`@inspr/aithema-server/composed-voice` is a supported export included in the next
server release. It exports `createComposedVoiceCoordinator`, a building block for
composed pipelines that coordinates separately admitted STT, reasoning and TTS
with trusted server ports for authorization, utterance commits and relay playback.
`callDurationSeconds({ maxDurationSeconds })` validates the call-duration ceiling
in seconds (default 900, integer range 1–86400); hosts explicitly supply their own
ceiling, such as 3600 for a one-hour call. The coordinator caps the spend deadline
by this ceiling. AIT-351 includes Grok and these supported helpers in the next
release closure. The source-only composed prototype stays excluded. Grok is
**not yet qualified in live use**; fixture qualification does not change that
label. Inclusion does not authorize publication or live activation.

### Grok Voice host setup and release imports (AIT-351)

```js
import { createGrokVoiceProvider, createGrokComponents } from '@inspr/aithema-plugin-grok-voice/server';
import { createGrokVoiceClient } from '@inspr/aithema-plugin-grok-voice/client';
import { manifest as grokManifest } from '@inspr/aithema-plugin-grok-voice/manifest';
import { createComposedVoiceCoordinator, callDurationSeconds } from '@inspr/aithema-server/composed-voice';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { createComposedBrowserMedia } from '@inspr/aithema-server/composed-voice/client';
import { createComposedComponentAccounting } from '@inspr/aithema-server/composed-voice/accounting';
import { createComposedVoiceAuthority } from '@inspr/aithema-server/composed-voice/authority';
```

Install the module tarballs at the exact coordinate in `release/version.json`,
including Grok's exact core/server dependencies. In the source-hosted demo, Grok's
browser modules and composed client helpers use relative public source URLs and
load natively without an import map under `script-src 'self'`; startup stays in
external same-origin modules, as in the UI. Release packing rewrites cross-package
source URLs to declared package subpaths. A host using these installed package
subpaths needs a bundler or, when unbundled, an import map, as for the UI. An inline
import map needs the exact hash in the host's CSP as described above. Serve
`src/composed/pcm-capture-worklet.js` beside the installed server
browser-audio module so its relative `new URL()` resolves. The server's
`./composed-voice/browser-audio` export and that adjacent worklet ship together.
Never import workspace paths or `plugins/composed-voice/src/*` from an installed host.

Architecture (b) is **xAI STT → Aithema's admitted reasoning → xAI TTS**.
xAI never writes answers. Register `createGrokVoiceProvider` and Aithema's
separate reasoning plugin with the host runtime. Configure the parent and both
component bindings and current consent coverage. The provider uses the ordinary
Rule C reply executor and durable child accounting. Mount the authenticated relay
and normal voice controls described above; supply `createGrokVoiceClient` with
those control/network ports. Imports and construction are offline. Start requires
current ownership, consent, account and budget admission.

Owner use needs an xAI account with voice access and **Zero Data Retention
switched on**, plus a server-side secret reference in the private binding.
**Never ask for a key.** The host resolves that reference privately; no credential
or account evidence belongs in browser configuration. Supply the validated
`accountRef`, `secretRef` and dated, unexpired `accountEvidence` for ZDR, DPA,
retention, transfer, contract and approval; see the
[private configuration contract](../plugins/grok-voice/README.md#private-configuration-contract).
Bind the parent with `maxMicro: 0`, `upstreamMicroPerMinute: 0`, its separate
visitor tariff and a bounded call duration. Bind STT/TTS separately to the exact
model, endpoint, account, secret reference and current legal evidence. Account
evidence does not grant session consent or establish live-use qualification.

Markus approved xAI as a direct recipient (AIT-317, Desk dc3ec428).
Use **`voice-xai` v1**, with the exact DE/EN consent item from the public manifest;
retain separate reasoning consent. The recipient is **SpaceXAI LLC (“SpaceXSI”)**,
US seat, international processing, **no guaranteed region**. Settings shows the
US recipient seat separately from international/no-guaranteed-location processing;
neither the seat nor the endpoint is a processing guarantee.

Visitor charging is server-side **measured by Aithema**: active duration excludes
only acknowledged pauses and is confirmed at close. Upstream STT/TTS have fresh
child claims for every utterance, fragment and retry and remain **estimated**
until a billed-cost receipt. TTS counts the Unicode code points actually sent,
including spaces and emoji constituents. Cancel, timeout, abandonment or uncertain
recovery keeps consumed reservations; parent close cannot release unresolved
children. The measurement/confirmation section below gives the exact calculation.

Recovery uses fresh epochs, authorization and child admissions and never silently
replays old synthesis. Acknowledged pause holds capture until matching resume
acknowledgement. Playback-unlock retries dispatch no new speech work.
On interruption, stop playback, keep the full generated answer, display
**Unterbrochen** / **Interrupted**, and tell the model the heard length is unknown.
xAI reports no heard position. This is the approved difference from ElevenLabs's
existing heard-prefix correction; never infer a prefix from browser timing.

Evidence is limited to public docs read **2026-10-18** and synthetic offline
fixtures. Dated prices: REST STT **$0.10/hour**, streaming STT **$0.20/hour**,
TTS **$15/1M characters**. No billed-cost receipt, live acoustic qualification or
German speech quality is claimed. The
[plugin evidence table](../plugins/grok-voice/README.md#public-evidence) records
source links and limits. Keep the manifest and notes label exactly **not yet
qualified in live use** until Markus has used it. Tick's morning QA of packages
5–7 and LEAD's RC decision precede merge; a later RC needs Markus's Desk go to
publish. This package creates no tag, release or publication.

### Voice charge measurement and confirmation (AIT-347)

ElevenLabs owns the live call and reports its duration in the conversation
receipt (`metadata.call_duration_secs`). Aithema records only server-acknowledged
pause intervals and deducts those from visitor time. Its upstream charge remains
`costEstimated: true` with `costSource: 'duration-estimate'` until that receipt
contains a usable money total (USD or credits with the host conversion rate).
A duration alone does not confirm provider money. See the
[ElevenLabs accounting rules](../plugins/elevenlabs/README.md).

For the composed path, Aithema's server coordinator owns and measures the call.
At close, the visitor tariff is `ceil(activeSeconds / 60 * visitorMicroPerMinute)`:
server close time minus coordinator start time, excluding only acknowledged
pause intervals, including an acknowledged pause still open at close. Failed or
pending pause commands exclude nothing; an unacknowledged resume does not end
an acknowledged pause. Browser duration, timestamps, pause intervals and lifetime
configuration have no measurement authority. The coordinator accepts only request
identity and context, with timing configured by trusted server ports.

The composed parent confirms **Aithema's visitor tariff** at close
(`closureConfirmed: true`, `costEstimated: false`,
`visitorDurationSource: 'aithema-measured'`); no upstream provider owns or
confirms this duration. Parent upstream cost stays zero, with
`costSource: 'separate-component-claims'`. STT/TTS children retain their own
`estimated: true` provider-money receipts until independently reconciled;
confirming the parent neither confirms nor releases child spend.
Decision 3's “estimated until a receipt” applies to that upstream money.

The duration policy wording lives in the ElevenLabs manifest’s
`liveVoice.billing.visitor`; the composed manifest now states “Active call
duration measured by Aithema, excluding server-acknowledged pauses.”
The shared visitor charge status lives in `packages/ui/src/audio-rail.js`, using
`voiceClosureUncertain` / `voiceEnded` from the DE/EN bundles for the ElevenLabs
path. Composed provenance selects `voiceEndedAithemaMeasured` in that same status:
“Anruf beendet. Sprachgebühr von Aithema gemessen.” / “Call ended. Voice charge
measured by Aithema.” Its compact label also says “Von Aithema gemessen” /
“Measured by Aithema”; it never calls this charge provider-confirmed.

### Supported STT/TTS component API (AIT-316)

```js
import {
  assertSTTComponent, assertTTSComponent, voiceCompositionCapabilities,
  componentInvocation, assertComponentUsage, boundedEvents, audioQueue,
  TTS_SPEAK_BYTES, TTS_MESSAGE_BYTES, TTS_WIRE_CHARACTERS,
} from '@inspr/aithema-core/voice-components';
```

These runtime symbols are also available from `@inspr/aithema-core`. Types live
beside `plugin-contract.d.ts` in `voice-components.d.ts` and resolve through the
`@inspr/aithema-core/voice-components` subpath. `STTComponent`, `TTSComponent`,
`ComponentOperationOptions`, `ComponentTerminal` and `ComponentUsage` remain
available from the types-only `@inspr/aithema-core/plugin-contract` subpath too.
The server coordinator building block is documented above; these component contracts remain in core.

| Port | Signature and semantics |
| --- | --- |
| Both | `negotiateAudioFormat(offered, { signal, deadlineAt }): Promise<AudioFormat>` selects an offered encoding, sample rate and channel count, or rejects with `unavailable`. Negotiation performs no billable provider work. Request `format` is that selected encoding; the bound component retains the full selected format. |
| STT | `transcribe({ audio: Uint8Array, format, language }, options): Promise<{ text }>` transcribes one utterance. |
| STT streaming | `stream({ audio: AsyncIterable<Uint8Array>, format, language? }, options): AsyncIterable<{ text, final }>` emits replacement hypotheses, then exactly one final. No event follows final; transport exhaustion alone is never finality. |
| TTS | `speak({ text, voice, format, language? }, options): AsyncIterable<Uint8Array>` yields audio in the negotiated format. Even a nonstreaming provider uses this iterator, yielding its completed payload. Exhaustion includes terminal settlement. |
| Aligned TTS | Optional `speakAligned(request, options): AsyncIterable<{ audio, textEnd }>` replaces `speak` for that invocation. `textEnd` is a nondecreasing UTF-16 offset into the exact request text, never inside a surrogate pair. After the entire chunk is confirmed played, `text.slice(0, textEnd)` is a conservative heard prefix. A chunk may advance no text. |

STT declares `capabilities: { streaming, partialTranscripts, languages }`;
`streaming: true` requires `stream`, and partial transcripts require streaming.
TTS declares `{ streaming, languages, heardPrefix: 'unavailable' | 'aligned' }`;
`aligned` requires `speakAligned`. Languages are explicit case-insensitive tags
such as `de` and `de-AT`, with no wildcards, duplicates or automatic regional
fallback. Empty languages promise no language support. Validators check port
shape and declaration consistency; they do not establish provider qualification.
`voiceCompositionCapabilities(stt, tts)` returns their language intersection,
separate STT/TTS streaming flags, partial transcript support and the TTS
heard-prefix ceiling. It makes no claim about transport or playback behaviour.

A composed pipeline binds these ports through `VoicePorts.components`, delegates
reasoning through `VoiceReplyExecutor`, and implements the existing `LiveVoice`
and `VoiceSession` contract. It publishes all live-voice command capabilities in
its `LiveVoiceDeclaration`: unsupported commands reject with `unavailable`.
It must declare `heard: 'unavailable'` when alignment or trusted playback receipts
are missing, and must never turn generated or merely delivered audio into a
`heard` event. The prototype's `sendText` and `heard` remain unavailable. Losses
such as no partial transcripts, buffered TTS or fewer languages must be reflected
in the pipeline's model/host declarations; component support is an upper bound.
Only trusted server transcript finality may authorize delegated reasoning;
browser transcript receipts carry no admission authority.

Every transcription, synthesis fragment and retry receives a fresh
`ComponentOperationOptions` with `{ signal, deadlineAt, attempt, report }`.
`attempt` contains nonempty `attemptId` and `claimId`, a nonnegative safe-integer
`maxMicro`, and `consume()`. Claims and whole USD micro-dollar charges are
separate from the aggregate duration claim and from reasoning token accounting.
A host admits each request against its own budget and current consent, then
`componentInvocation(options, { role, unit, model })` awaits `consume()` before
returning permission to `dispatch()` exactly once immediately before outbound
provider work. The host's consume callback checks fresh ownership/consent;
this helper does not grant consent or reserve money itself. Retries cannot reuse
an attempt. A composed call must not charge the same component spend again as
an aggregate duration cost.

Call `usage(quantity, upstreamMicro, source, estimated = true)` only after
dispatch, with finite nonnegative quantity and safe-integer nonnegative cost.
`assertComponentUsage` also validates attempt identity, role (`stt`, `reasoning`,
`tts`), unit (`seconds`, `tokens`, `characters`, `bytes`, `credits`), source and
estimate flag. `finish(true)` reports completed usage at that cost; all other
after-dispatch outcomes, including missing completion evidence, cancellation,
timeout and invalid usage, report `uncertain` with `chargedMicro` at least
`attempt.maxMicro` (and at least any observed valid higher cost). Over-ceiling
usage throws `limit` and retains uncertainty. Never replace unknown cost with
zero. Before dispatch, finish/abort/failed consume reports cancelled zero usage.
Only `rejectWithoutUsage(status)` for a transport-observed 4xx rejection with no
usage, excluding 408 and 499, releases a dispatched reservation. A provider error
payload alone is insufficient evidence. A host must retain the admitted maximum
for missing/uncertain terminals until trusted reconciliation; report errors do
not authorize re-dispatch or another terminal.

`finish(completed)` is idempotent and returns the same promise; first settlement
wins, including abort/deadline and synchronous report callbacks. Signals and
absolute deadlines bound consume and iterator reads even when injected ports
ignore cancellation. Providers must close their transports in `finally` and
finish accounting when consumers return early. `boundedEvents(source, options)`
bounds each read and attempts iterator cleanup under a separate one-second
lease; it cannot force an uncooperative upstream to close.
`audioQueue(limit = 960_000)` is a single-consumer byte-bounded producer queue:
`push(entry)` transfers ownership of bytes or a host-owned playback envelope
with a positive safe-integer `byteLength`; the caller declares the full retained
audio size. The generic `AudioQueue<T>` preserves envelope metadata.
`end()` drains pending bytes,
`clear()`/iterator return discard them, and overflow throws `limit`. It does not
resample, frame audio or pace playback. `TTS_MESSAGE_BYTES` (1 MiB decoded),
`TTS_WIRE_CHARACTERS` (base64 plus metadata) and `TTS_SPEAK_BYTES` (16,000,000)
are independent ceilings that adapters enforce. Hosts enforce smaller transport
and playback bounds where needed.

Run the reusable offline kits from the same core root export as the other
conformance kits:

```js
import { sttConformance, ttsConformance } from '@inspr/aithema-core';
const result = await sttConformance(stt, {
  audio: new Uint8Array(3200), language: 'en',
}, {
  formats: [{ encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }],
  incompatibleFormats: [[{ encoding: 'unsupported-fixture', sampleRateHz: 1, channels: 99 }]],
  expectedText: 'Hello',
  expectedTranscripts: [{ text: 'Hullo', final: false }, { text: 'Hello', final: true }],
  prepare: ({ operation, mode, request }) => localFixture.select({ operation, mode, request }),
  requestCount: () => localFixture.dispatches,
  activeCount: () => localFixture.openResources,
  observedMicro: () => localFixture.observedUpstreamMicro,
});
if (!result.ok) throw new Error(result.failures.join('\n'));
// TTS uses the same fixture options, plus a synthesis request:
const speech = await ttsConformance(tts, {
  text: 'A😀 B', voice: 'fixture-voice', language: 'en',
}, ttsFixtures);
```

Both return `{ ok, failures }`, with operation/mode and the violated rule in
each failure. Inject only local fake transports: the kits do not provide a
network transport or provider credentials. `prepare` must configure the actual
component's injected transport before each invocation. Supply `formats` with a
supported offer and `incompatibleFormats` with nonempty arrays of offers known
to be unsupported by this provider (including rate/channel mismatches when
applicable); providers may legitimately support resampling. The kit also tests
an empty offer. Counters independently
observe outbound dispatch and open resources, including cancelled requests;
`observedMicro` returns the highest authoritative cost observed in that case,
not the component's reported charge. Preparation must reset this observation.
Do not wrap or repair the component's declarations, events or terminals.

Fixture modes are `completed`, `provider-error`, `retry`, `fragment` (TTS),
`cancelled`, `deadline`, `consume-refused`, `pending-consume`, `active-cancelled`,
`active-deadline`, `return` (iterators), `missing-final`, `overflow`,
`overflow-total` (TTS), `overflow-input` (STT), `overflow-input-total` (STT stream),
`over-ceiling` and `report-rejected`. Normal modes produce the expected text or
nonempty audio and authoritative completion evidence. `provider-error` fails
after dispatch without completion evidence; `retry` then repeats the request
with fresh authority. `fragment` synthesizes a shorter text with another claim.
Active fixtures leave a provider read pending and ignore its signal, so the
component must bound that read and close its resources. `missing-final` ends
transport without a final; `overflow` supplies oversized transcript/audio;
`overflow-total` sends individually valid audio chunks past the synthesis total;
input overflow cases exercise the STT chunk and cumulative byte limits.
`over-ceiling` supplies usage above a one-micro claim (or rejects before work).
The kit itself refuses consume or rejects report in the corresponding modes.
Every other mode uses the normal wire fixture. No mode invokes a live service.

Rules cover offered encoding/rate/channels and free negotiation, replacement
transcripts with exactly one final and no following event, UTF-16 alignment,
fresh retry/fragment claims, cancellation/source cleanup, consume before
outbound work, once-only settlement before exhaustion, deadlines, typed errors,
and uncertain charge at least `max(maxMicro, observed)`. Default bounds are
64,000 bytes per STT input chunk, 1,920,000 input bytes per utterance, 32,768 transcript characters, 1 MiB per decoded audio chunk and 16,000,000 audio
bytes per synthesis; configure `maxInputChunkBytes`, `maxInputBytes`,
`maxTranscriptCharacters`, `maxChunkBytes` and
`maxAudioBytes` to the provider's documented smaller limits. `timeoutMs`
(default 1000, minimum 100) bounds bad fixtures; `maxMicro` defaults to 1,000,000.
A harness timeout fails conformance and does not prove abandoned work stopped.
An opened STT source must be exhausted or receive `return()` when abandoned;
normal exhaustion through `for await` does not require a redundant `return()`.
Fresh-claim checks observe exactly one consume per supplied attempt, including
retries and fragments; generating unique fixture IDs alone proves nothing
about component claim reuse.

For `heardPrefix: 'aligned'`, supply a `playback` fixture with `reset(request)`,
`deliver(chunk)`, `confirm(cumulativePlayedBytes)` and `heardPrefix()` methods.
It observes the host playback adapter: delivery must retain the prior prefix,
a partial chunk confirmation must retain it too, and confirmation of the entire
chunk may advance to `request.text.slice(0, textEnd)`. Use text with a surrogate
pair and multiple chunks so the fixture exercises offset boundaries and partial
playback. Pure synthesis output never establishes heard evidence; a passing
provider kit alone cannot qualify a host's playback trust boundary.

The fake STT/TTS components pass; deliberately broken fixtures demonstrate each
rule failing. Source-only Voxtral and ElevenLabs helpers run diagnostically in
CI and currently fail the required capability declaration check; their full
failure lists appear in TAP diagnostics. These offline checks do not establish
provider qualification, live billing, latency or a second released pipeline.


### Core subpath decisions (AIT-202)

The #173 release candidate already exposes the subpaths below. Each is retained
because an actual production module consumes it; none is added speculatively.
These are explicit public contracts, not permission to import arbitrary `src/`
files. The root remains the normal host entrypoint. AIT-202 adds no core or
server package subpath. The public server `/local-voice-identity` retains only
`isLocalVoice`; AIT-218's always-throwing `markLocalVoice` compatibility export is
removed in this release. Hosts cannot enroll providers as the simulator.

| Core subpath | Keep reason and actual consumer |
| --- | --- |
| `./understanding` | UI session understanding model. |
| `./readiness` | UI session readiness model. |
| `./live-voice` | Server voice handlers and composed provider lifecycle. |
| `./extractor` | Server upload admission and extraction adapters. |
| `./extractor-process` | OOXML/PDF/text subprocess adapters. |
| `./extractor-zip` | OOXML child ZIP safety checks. |
| `./invocation` | Server coordinator, UI reply audio and provider admission errors. |
| `./session` | UI session-element and email session state. |
| `./ui-html` | Host HTML setup and UI HTML rendering contract. |
| `./reply` | UI session and ElevenLabs facade reply delivery. |
| `./prompts` | UI session prompt construction. |
| `./document-context` | UI session document context. |
| `./text-origin` | UI session and ElevenLabs facade origin tracking. |
| `./presets` | UI session and composed/ElevenLabs feature configuration. |
| `./settings` | Server handlers and UI settings/consent controls. |
| `./ai-notice` | UI locales and ElevenLabs host notice/options. |
| `./voice-lifecycle` | Server composed coordinator and UI session lifecycle. |
| `./reply-replay` | UI page replay and ElevenLabs/fake-voice clients. |
| `./voice-lifecycle-controller` | UI audio rail and provider clients. |
| `./cost` | Server budget and ElevenLabs speech/server costing. |
| `./plugins` | Provider manifests and server coordinator deepFreeze. |
| `./plugin-contract` | Codex-imagegen declaration contract (types only). |
| `./safeguards` | ElevenLabs facade safeguards. |
| `./reasoning` | Device adapter and ElevenLabs facade operation scopes. |
| `./reply-opener` | ElevenLabs facade opener delivery. |
| `./chat-completions` | Device adapter chat protocol. |

## Actor role choice (AIT-281)

The host owns the role labels and the optional `account` slot content. The module
owns only the four `ACTOR_ROLES` ids (`private`, `company`, `representative`,
`agency`), the authenticated command and the presentation mechanics. There are
no default or example role labels in the product.

Enable the server capability with `host.identity.chooseRole = true`. In the
component's `configure` options, supply `host.actorRole.labels`, a map from locale
(`de` / `en`) to a complete map from those four ids to host-owned label strings.
All four current-language labels and the server capability are required; when
either is missing, there is no role control. Labels are inserted as text. The
footer reserves the widest supplied label in the current language, including
the inferred marker, across all command states.

Use the existing light-DOM `slot="account"` for the host's account content. When
the role control is available, that slot appears only in the desktop popover;
when absent, no account line appears. The phone role sheet has no account line.
No address, verification claim or account label is invented by the module. The
phone gear opens the role section and an entry to the existing AI processing
settings. On desktop, the role trigger follows the AI notice in the left footer
group. Missing capability hides the role section; the phone sheet retains its
AI processing entry.

`GET /api/sessions/:id/identity` returns an owner-only `roleChoice` projection:
`{ available, roles, role, source, reasoning, revision }`. `source` is `chosen`
or `inferred`; `role` may be null before a usable inference or choice exists.
The session snapshot includes the same projection when the capability is enabled.
`revision` is the current durable session sequence; unrelated durable events can
also make a previously displayed list stale. Account content and role labels
are never accepted in this command or exposed through a new public endpoint.

Send `POST /api/sessions/:id/identity/role` with
`{ role, baseRevision, clientEventId }`, using the existing owner cookie or
`x-aithema-session-token`. `role` must be one of the offered ids;
`baseRevision` must be the nonnegative integer from the projection;
`clientEventId` must contain 1–128 ASCII letters, digits, `_` or `-`. The server
checks ownership before capability, parsing or state changes. It atomically
persists the choice, its private receipt and its identity event. A successful
response is `{ roleChoice, replayed }`. Repeating the same id and role returns
the current projection without another event, including after a process restart.
Reusing an id for another role returns HTTP 409 `role-event-conflict`.

A stale base returns HTTP 409 `role-conflict` with the refreshed `roleChoice`;
it makes no role change. Missing capability returns HTTP 503 `role-unavailable`;
invalid bodies return HTTP 400. A conversation accepts up to 500 unique role
commands, then returns HTTP 409 `role-command-limit`. A choice has no paid or
external effect and does not require address collection. It wins over later AI
inference. Withdrawal, consent reset, erasure and conversation reset forget the
choice; stored role content uses the existing erasable actor-content class,
separately from verification facts. Private role receipts clear with that content.

The UI keeps the acknowledged footer value during saving, restores the previous
checked role after an error, and refreshes the list after a stale response. A
network retry retains its client event id. Arrow keys move focus without writing;
Space, Enter or a pointer selection commits, including confirmation of the checked
inferred role. Escape returns focus to the trigger; outside clicks and Tab-out
close the desktop popover. A phone save keeps the sheet open with its saved notice.

### Credit host options (O1–O8, RC13)

The client settings below belong to `host` in `configure`. Omitted settings
preserve the default presentation; the built-in dictionaries preserve the
historic anonymous offer. Server settings belong to the trusted server host.

```js
sessionElement.configure({
  session, copy,
  host: {
    verification: true,
    credits: { reconcilingVisible: true, dailyCapReset: true },
    usedUp: { newConversation: { enabled: true }, dailyCapActions: 'none' },
    emailAsk: { lowCredits: false },
  },
});
```

- **O1:** `usedUp.newConversation.enabled` defaults to false. With no upgrade,
  the single primary action starts a conversation using the existing path;
  export remains a secondary link. The hint and action keep their slots.
- **O2:** `usedUp.dailyCapActions` accepts `'export'` (default) or `'none'`.
  The latter leaves an empty, reserved, `aria-hidden` row only for daily cap.
- **O3:** A host-supplied `copy.hostSurface.credits.afterConfirm` supplies the
  unconfirmed offer (`{n}` or legacy `{tier}`); `withConfirmed` remains the
  current confirmed tier. Without `afterConfirm`, the offer falls back to
  `withConfirmed`. Passing the unchanged built-in dictionary keeps RC13 copy.
- **O4:** `credits.reconcilingVisible` defaults to false. When true, the visible
  balance stack reserves both number and muted reconciling text. The text has
  one polite announcement per reconciliation; the tooltip remains available.
  Phone hosts with legal links reserve a separate standing legal row, so the
  visible status cannot overlap those links.
- **O5:** `credits.dailyCapReset` defaults to false. On the server,
  `creditTiers(ownerToken, { sessionId })` supplies `dailyCapReached` and
  `dailyCapResetAt` (safe-integer Unix milliseconds) for a session-scoped wallet.
  The daily-cap receipt carries the instant only while capped. Local formatting
  uses DE 24-hour time and the EN locale's time format. An acknowledged reset
  stays visible until the cap clears, even if a subsequent receipt omits it.
- **O6:** `emailAsk.lowCredits` defaults to true. Set false on both client and
  server to suppress the inline low-credit ask and automatic low ask. The
  server does not claim or await that ask. Confirmation from the tier and
  used-up panel still works; other email flows retain their existing policy.
- **O7:** Wallet `canAdmit(request)` keeps its boolean contract and may refuse
  with `{ ok: false, reason: 'session' }`; `admit(request)` may return that
  refusal too. Only boolean `true` authorizes a preview or voice extension;
  every other return value refuses. Unknown or absent reasons remain host-limit.
  Daily cap wins
  over session, and session wins over host-limit. Session end uses the
  number-free title and either confirmation at the higher tier, the O1 new
  conversation action, or export when O1 is off. O2 and O5 affect daily cap only.
- **O8:** `/identity` explicitly reports `visitorEmail.canDelete` beside
  `canSave`. Both reflect the complete `visitor`, `saveEmail`, `deleteEmail`,
  `eraseVisitor` port required by visitor routes. The client permits deletion
  only for explicit true. Otherwise the button has the existing disabled style,
  `aria-disabled`, and no tab stop. Its reserved reason points to the host's
  legal-slot privacy link, or uses plain text if none is configured. No delete
  request or credit-drop confirmation can be triggered without the capability.

All state rows reserve their geometry. Host copy uses German grouping (`1.000`)
and NBSP before `Credits`; copy is inserted as text, never HTML.
