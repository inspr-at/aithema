# Aithema workspace runbook

This package prepares public GitHub-source candidate `0.10.1` (explicit `legacy-semver-public`). Releases `0.1.0` through `0.10.0` are already published at [inspr-at/aithema](https://github.com/inspr-at/aithema) (`v0.1.0` through `v0.10.0`). The commands below are for local operator/developer use. They do not publish to npm, create a tag, deploy, or prove a live provider or OIDC integration.

## Tests (deterministic, no live credentials)

Prerequisites:

- Node.js 24 and npm 10+ (workspace Flow host consumes `@inspr/flow-shell` 0.2.1, which requires Node 24)
- `trash` CLI on PATH (packaging and source-export cleanup tests; on macOS this is typically preinstalled)
- Pinned font/PDF dependencies arrive through ordinary `npm ci` (`pdfkit`, `fontkit`, `@fontsource/noto-sans`, `unpdf`)
- Optional production browser login uses pinned `openid-client` 6.8.8 (Authorization Code + S256 PKCE). Do not enable it with incomplete client/issuer values.
- Offline tarball consumer proof uses a named online packument prime, not a warm operator cache: `AITHEMA_NPM_CACHE` + `AITHEMA_PRIME_OUT` (never `dist/`) then `node release/prime-consumer-cache.mjs --build`. `npm ci` alone is not enough. The packaging test also proves `--offline` fails on an empty cache before that prime. npm `--offline` cannot replay GitHub Release HTTP tarball fetches; the test replays the primed Flow 0.2.1 integrity blob as a file: override after checking SHA256 `26d77999…`.

```bash
npm ci
npm test
npm run test:packaging
npm run test:source-export
npm run example
```

`npm test` includes the approved AIT-4 core suite plus runtime, JWT/JWKS, optional OIDC browser login against a local synthetic issuer, SQLite persistence, configured OpenAI-compatible HTTP against a local fixture, workspace HTML behaviour, reviewed JSON/CSV/HTML/PDF export, document intake, parser-process cancellation, AIT-10 runtime packaging, and AIT-11 public source export. Source tests are not a substitute for later live provider/OIDC evidence. Fixtures use a labelled mock provider and deterministic local HTTP only.

Generated printable fixtures for coordinator QA (outside the repo): write reviewed JSON/CSV/HTML/PDF exports to an operator-owned temporary directory.

## Test loop

Workers and gates run `npm run test:fast` plus targeted tests for their changes. The fast runner discovers every `test/*.test.js` except packaging and source-export, with explicit concurrency from `os.availableParallelism()`. `npm test` still selects the full suite; `npm run test:release` selects the two slow release proofs.

Run `node scripts/needs-release-proof.mjs origin/main` to compare the branch from its merge base, including staged, unstaged, and untracked changes. It prints `release-proof: required` or `release-proof: not-required` and exits 0; an invalid ref exits 2. Release tooling/allowlists, package metadata/lockfile, executables, export/packaging scripts, and release proof tests/fixtures require the slow proofs. Run them on the final commit when required. CI is the source of truth: independent `fast`, `packaging`, and `source-export` jobs always run in parallel on pull requests and pushes to main.

The source-export proof compares the complete extracted file inventory and SHA256 hashes with the exported commit's source allowlist. Only generated `release/source-provenance.json` is excluded from commit-byte equality because the exporter rewrites it; its provenance fields and the full extracted tree digest remain bound to the source manifest. After an offline install, the extraction runs four smoke files: baseline, contracts, runtime transcript, and workspace. `AITHEMA_FULL_EXPORT_PROOF=1 npm test` retains the full recursive extracted suite (with the existing recursion guard). `.github/workflows/nightly.yml` runs that command daily at 02:00 UTC and on manual dispatch.

Release proofs need dependencies and consumer packuments primed online before offline execution. `npm run cache:prime` aliases the existing consumer prime; set `AITHEMA_NPM_CACHE` and `AITHEMA_PRIME_OUT` to explicit temporary paths outside `dist/`, then run it. Use the same cache as `npm_config_cache` for the proofs. CI installs dependencies and primes the cache in both slow jobs and nightly. If a worker cannot prime the cache without network, report that limitation; nobody rewrites the harness to work around missing network.

## Public source candidate review (local, no publish)

```bash
npm run source:export
mkdir -p /tmp/aithema-source-review
tar -xzf dist/inspr-aithema-core-source-0.10.1/inspr-aithema-core-source-0.10.1.tgz -C /tmp/aithema-source-review
cd /tmp/aithema-source-review
npm ci
npm test
npm run release:build
```

The extracted tree has no private Git metadata. Runtime release builds inside the extracted tree bind `release/source-provenance.json` to the runtime tree and lock digests, then stamp frozen `source.commit` with `current_source_commit` (the Git commit actually exported). They do not require private history and do not put private lineage into the runtime manifest. `private_source_commit` stays the original lineage (`2ba95dad…`) and `current_source_commit` is the public commit; git-mode and tree-mode runtime manifests then agree. Canonical publication toolchain is CI `ubuntu-latest` + Node 24 + GNU tar; timestamp input is the committer epoch recorded as `export_mtime_epoch`. Tag-gated `release/retain-forge-assets.mjs` retains admitted GitHub Release assets only when the ref is `refs/tags/{version}` or `refs/tags/v{version}`; a syntactically valid tag for another coordinate is refused before any forge I/O. `upload-artifact` is ephemeral transfer only. The release workflow sets `AITHEMA_CANONICAL_RELEASE=1` so admission and builders require the declared Node 24 + GNU tar toolchain; local BSD tar builds stay valid and are not claimed to match CI bytes. Coordinator-only gates after this candidate: published `0.1.0` through `0.10.0` at `inspr-at/aithema` remain immutable; run the release workflow on a matching `0.10.1` tag, download consumer proof, and pin START separately. npm registry publication is not authorized and this tree does not claim the `@inspr` npm namespace. NIX-501 identity configuration and API activation, and AIT-14 configured request-count/provider execution, have separate evidence; those checks do not establish a complete production browser OIDC login journey, which remains an explicit acceptance gate. Measured provider billing remains unavailable while estimates are unset. This candidate carries optional `--speech-config` without changing legacy protected inline speech behavior or implicitly enabling production speech, Flow Shell 0.2.1, and an exact `$CREDENTIALS_DIRECTORY=/run/credentials/aithema-workspace.service` systemd `LoadCredential=` Paimos credential mount reader; generic credential files remain owner-only. OpenRouter speech compatibility is proven separately on v0.8.0; production speech activation and controller-owned browser/microphone QA remain required. Paimos credential enrollment remains a separate gate.

## Labelled demo workspace (loopback only)

```bash
npm run workspace -- examples/demo-config.json
```

Open the printed `http://127.0.0.1:<port>/` URL.

Expected local browser QA (coordinator, after this commit):

1. Start a **new** loopback process on a free port (do not reuse an existing native QA server). `npm run workspace -- examples/demo-config.json`
2. The page shows a short **Demo / mock** notice and states that the mock is not live AI. Compact Flow header/footer wrap the existing workspace content and use the package SVG/style. Demo identity is labelled as labelled loopback demo, not live identity.
3. Continue with labelled demo identity `demo-reviewer` (human). Roles cannot be typed in the browser. The Flow header shows the current project/actor labels without raw subject, email, or roles.
4. Create a project with more than one project kind checked (product and iteration may overlap).
5. On the project screen, the focused next question and message input appear first. Conversation history, understanding detail, project list, identity, and revision identifiers are under secondary details.
6. Send a requirements message. The reply asks one focused next question, updates understanding, and creates **unapproved** proposals with explicit Approve/Reject. The mock reply is visibly labelled.
7. At a 390px-wide viewport, the next question and message input are visible on the first screen before conversation history. Long digest and project id strings wrap without horizontal clipping.
8. Confirm there is no control that starts delivery, that pending proposals are not an approved baseline, and that Flow stage/start review does not claim Paimos, Pharos, or Janus succeeded. Explicit Flow start reports the missing downstream integration; review routes back to the existing approve/handover controls.
9. Approve selected proposals as the human reviewer. In **Reviewed baseline**, download JSON, CSV, HTML, and PDF for that explicit `baseline_ref` and `revision`. All four must show the same digest and seal. Unapproved proposals must not appear in those files. HTML has no script tags or external fetches; PDF is a real `%PDF` file whose footer stays on the same content page with an accurate page count, wrapped long IDs, and readable Latin/Latin-Ext/Greek/Cyrillic (for example Straße). Unsupported scripts (including CJK) must refuse PDF and offer HTML/JSON rather than omit glyphs.
10. Open **Document intake** (folded). Upload the JSON export as own-format: it becomes unapproved add/update proposals and still needs Approve. Upload a `.txt` or `.xml` file: it is listed with extraction status and does **not** mint proposals until **Interpret into proposals**. Interpret cannot be used to send a provider endpoint, system prompt, or roles from the browser.
11. Repeat with `demo-agent`: the agent may create its own project and propose, but cannot approve. `demo-outsider` cannot open another actor's project or download its exports (including older revisions).
12. A message containing `<script>` appears as escaped text, not HTML. The same string in a reviewed HTML export is escaped text.

Stop the process when finished. Demo identity is rejected off loopback. Demo cookies do not survive restart unless `identity.demoHmacSecret` is set in a **private** operator config (not the committed demo file). Restart durability of project data still uses the SQLite directory; sign in again after an ephemeral-key restart.

This `npm run workspace` route is an example convenience, not the supported service command. It intentionally defaults to the committed labelled demo configuration; the installed service executable never does.

## Membership and SQLite schema

Access is decided on every request from:

1. a **creator grant** in `members` keyed by verified `subject`, written only when that subject creates the project; and
2. the current operator membership `projects[]` mapping for that same subject.

Removing a `project_ref` from a subject's `projects[]` revokes mapped access to that project for every path (page, handover, review, cancel). It does **not** revoke access to projects that subject created independently — creator grants persist until the subject is removed from `memberships` entirely. Sharing `party_ref` does not share access. Human approval still requires a mapped human with `requirements_approver`; creator grant is access, not approval.

An optional membership `can_create_projects: false` disables project creation
in both the browser and store API; omitted or `true` preserves existing behavior.
The field must be a boolean and comes only from operator membership mapping,
never token claims or form input. Existing project membership remains unchanged.
For a dedicated sandbox reviewer, first deploy the AIT-31-capable package
(`0.10.1` or later) and confirm that exact package is running **before** adding
its membership. Earlier binaries silently ignore `can_create_projects` and
would allow project creation. Only after that confirmation add the subject with
`actor_kind: "human"`, only `roles: ["requirements_approver"]`, exactly one
`projects` reference and `can_create_projects: false`. Keep the workspace
stopped while adding this restricted mapping and provisioning its project.

To provision that initial empty project without temporarily broadening access,
back up the existing database and stop its workspace service. Run as the
workspace service account, with the same restricted access to its database and
protected config; running SQLite as root can leave root-owned WAL/SHM files.
The Nix package installs the operator script at
`$DEPLOYED_AITHEMA_PACKAGE/lib/node_modules/@inspr/aithema-core/bin/aithema-provision-project.js`.
Resolve `DEPLOYED_AITHEMA_PACKAGE` to the confirmed running package before
stopping it; this script is not a separate executable on PATH. Use its Node 24
runtime with `--config FILE --subject ID --project-ref REF --title "UXQA sandbox"`
for a read-only preflight, then repeat with `--apply`. Arrange service-account
access to the protected config without printing it; a systemd credential mount
may disappear when the service stops. The config stays in memory and output
is value-free.

The operator command requires an existing database/current membership schema,
inserts only the configured new project, creates no persistent creator grant,
and refuses an existing project or **any** older `members` row for the subject.
Both the preflight and write transaction check those constraints consistently;
the apply path rechecks under a write lock. A refusal needs explicit review,
not automatic removal of existing grants. The tool does not start a web server,
call a provider or migrate the schema. Restart the confirmed new package with
the same reviewed config afterward; normal browser login remains required.

Before rollback to a build older than AIT-31, stop the workspace and remove the
restricted subject from operator memberships **before** activating the older
binary. Do not retain that mapping and rely on the older reader to enforce the
new field. Preserve the sandbox database for a later reviewed re-enable.

Older databases that stored `members` as `(project_ref, party_ref)` are migrated by renaming that table to `members_legacy_party` and creating the subject-keyed table empty. Legacy party-keyed rows are **not** replayed as grants: they mixed creator rows with write-once mapped-access cache and cannot distinguish subjects who share a party name.

**Non-destructive recovery:** existing projects, transcripts, revisions, and sealed baselines are retained across migration. To restore access for a retained project, add its `project_ref` to the intended subject's `identity.memberships[].projects` in operator config and restart — do not delete or recreate the SQLite file. Re-binding preserves `content_digest`, `revision_seal`, transcript, and approved baseline intact. `members_legacy_party` is left in place for inspection and is not consulted for authorization.

## TLS reverse proxy, public origin, and optional public base path

When the workspace sits behind a TLS reverse proxy, set `publicOrigin` in operator config to the browser-visible origin (for example `https://workspace.example.invalid`). Same-origin CSRF checks compare `Origin` / `Referer` against this value. `publicOrigin` is scheme + host only; do not put a path there. The server does not trust arbitrary `X-Forwarded-*` request headers for origin validation, mount prefix, or identity; only the operator-configured `publicOrigin` overrides the loopback bind URL.

Optional `publicBasePath` defaults to empty and keeps today’s origin-root standalone behaviour. A canonical value is an ASCII absolute path of one or more `[A-Za-z0-9_-]` segments with no trailing slash (sample shared-origin vocabulary: `/aithema`). The edge must forward the same public path (prefix-preserving). The workspace serves only that mount, with an exact segment boundary: `/aithema` is not `/aithema-other`. Templates, static ES modules, Flow, login, logout, callback, and export links use the prefix; there is no HTML rewriter, iframe gateway, dual origin-root mount, or forwarded-user trust. OIDC `redirect_uri` is exactly `publicOrigin` + `publicBasePath` + `/oidc/callback`. Sessions stay `aithema_session` / `aithema_login` with `Path=/` (not a cookie-path isolation claim). Shared origin is a shared trust domain; this app still verifies its own membership and audience.

## Configured production-shaped run (still local)

Copy `examples/production-config.example.json` to an operator-owned file **outside git**. Fill:

- `identity.jwks_uri`, `issuer`, `audience`, and memberships (`actor_kind` and roles). Do not map `requirements_approver` onto `agent`.
- Optional `identity.browser_login` (`client_id`, and `client_secret` when the Zitadel application is confidential). Incomplete browser-login config refuses to start. Sessions are opaque, HttpOnly, SameSite=Lax, Secure when `publicOrigin` is https, and expire without refresh. Sign out clears the workspace session; it does not put tokens in the redirect. Register the callback as origin + `publicBasePath` + `/oidc/callback` (origin-root when `publicBasePath` is empty).
- `providers.<name>.baseUrl` / `allowedModels` for an OpenAI-compatible endpoint (self-hosted included). Credentials stay in that server-owned file.
- Optional `publicBasePath` (`""` standalone, or `/aithema` when sharing one customer origin). Leave empty unless the edge will preserve that prefix.

```bash
aithema-workspace --config /path/to/operator-config.json
```

The executable requires the explicit `--config FILE`; missing, unreadable, malformed, or invalid configuration exits nonzero before listening, and startup diagnostics never print the config body or underlying credential-bearing errors. Production continues to require `identity.kind: "jwt-jwks"` and a durable `dataDir`; demo/test configurations remain loopback-only. Browser requests cannot change the endpoint, API key, limits, policy, data class, epoch, or enable a model that is not in `allowedModels`. Additive `providerId` may name a registry id already allowed by operator policy.

`/health` (or `{publicBasePath}/health`) returns only `{ ok: true, ready: true }`; when mounted, the unprefixed route remains unavailable. This readiness signal covers local process startup, configuration validation, the opened SQLite store, and the listening socket only. It does not prove provider or IdP reachability. Operator `limits` in config are capped; they cannot be raised from the browser.

On the first `SIGTERM` or `SIGINT`, the executable stops accepting new connections and drains in-flight HTTP work for at most 10 seconds. At the deadline it force-closes lingering HTTP connections, closes SQLite exactly once, and exits. A repeated termination signal force-closes immediately. Override the bound when an operator needs a different drain window with `--shutdown-grace-ms MILLISECONDS` (0–300000); this changes shutdown timing only, never workspace or provider configuration.

## Provider policy and request ceilings

Omit `policy` to keep historical single-provider behaviour (`defaultProvider` only). When `policy` is present it is fail-closed:

- `execution` is `local`, `cloud`, or `mixed`. Each registry entry used in `allowedProviders` must declare `executionLocation` (`local` or `cloud`) and `allowedDataClasses`.
- `policy.projects.<project_ref>` may only narrow the organization values. Browsers cannot submit policy or data-class changes.
- Unknown location or class cannot satisfy a constrained policy. A confidential-labelled project cannot call a provider that only allows `public`.
- Default and explicit selections are pinned for both conversation calls (normally two outbound requests per turn) and document interpret. If that selection is disallowed, the request fails before any outbound call; another provider is never substituted.
- `maxOutboundCallsPerProject` counts outbound provider requests in SQLite per project and `policy.epoch`. It is **not currency** and remains the default when no estimate budget is configured. Bumping `epoch` in operator config starts a new count window; browsers cannot reset it. A reserved id is not refunded after a possibly-sent call or crash; retrying the same id fails honestly instead of sending again.
- Optional configured estimated spend uses `policy.estimatedSpend: { currency, maxMicroPerProject }`. Each allowed provider must declare the same `estimatedSpend.currency` and a `models` entry for every chat or speech model that its separate allowlists can select: `{ unit: "tokens", inputMicroPerMillion, outputMicroPerMillion, maxMicroPerCall }`. A pricing entry never authorizes model selection. All amounts and rates are non-negative integer micro-units supplied and reviewed by the operator; Aithema does not discover prices. A project override may lower `maxMicroPerProject` but cannot change currency, disable the budget, or raise it.
- Before any provider request, SQLite atomically reserves both the request-count slot (when configured) and `maxMicroPerCall`. Supported provider-reported token usage replaces that reservation with the calculated configured estimate after the call. A known result above the reservation is recorded upward, may exceed the project budget, and blocks later requests; it is never clamped. Missing, malformed, conflicting, non-token, interrupted, or crash-uncertain usage retains the conservative reservation, and an unsupported unit fails explicitly while budget mode is enabled. The workspace shows the configured estimate and provenance counts. It never labels them as billed totals or guarantees that `maxMicroPerCall` caps the provider invoice or currency exposure.

Live IdP and live model calls are **out of scope for AIT-6 worker evidence**. Wire them later and keep the proof separate from `npm test`.

## Optional speech input

Speech input is **disabled** unless operator config sets `speech` with a registry `providerId`, approved `model`, and — for the live adapter — an **exact** transcription URL (`kind: "openai-compatible-transcription"`). Chat Completions compatibility does not enable audio. There is no implicit `https://api.openai.com/...` default, no vendor SDK, and no SpeechRecognition implicit-cloud fallback.

```json
"speech": {
  "kind": "openai-compatible-transcription",
  "providerId": "local-openai",
  "model": "operator-approved-whisper",
  "endpoint": "http://127.0.0.1:8080/v1/audio/transcriptions",
  "acceptedMediaTypes": ["audio/webm", "audio/mp4"]
}
```

The browser may choose only that approved provider/model. It cannot set endpoint, credentials, location, data class, pricing, budget, or limits. Record → Stop → Transcribe fills the existing message box as an editable draft. Existing Send is unchanged and never automatic. Raw audio and unsent transcripts are not written to SQLite, logs, or temp files. When configured, transcription reserves one outbound request-count slot and the selected model's conservative estimate. Configured `local` / `cloud` labels are operator-declared, not measured network placement.

Labelled mock speech (`kind: "mock"`) is demo/test only. Native browser/microphone QA is coordinator work; `npm test` uses synthetic in-memory audio and a local HTTP fixture.

For a portable deployment, keep provider registry credentials, policy, and identity in the protected `--config` file, and pass a separate public speech object with `--speech-config /path/to/public-speech-config.json`. It may contain only `kind`, `providerId`, `model`, `allowedModels`, `endpoint`, `acceptedMediaTypes`, and `limits`; unknown or secret-bearing fields are refused. If protected config already owns `speech`, the sidecar collision is refused.

## Running Aithema for a commercial host

Run one dedicated Aithema instance per commercial host deployment. Give it its own qualified operator account per provider template and secrets restricted to that account (v5 ND9, R3-B2). Never share an instance, account, journal, budget ledger, audit store or evidence across hosts or trust contexts. Keep configuration, authorization records, exports and backups inside the same boundary. Across hosts, share reusable code only; nothing tenant-bound.

Attest the actual secret-to-account pairing when recording evidence; matching `account_ref` values cannot prove which account a resolved credential belongs to. Evidence for one account never qualifies another. In v1, tenants choose among operator-approved presets; **tenant-owned provider accounts are not supported** (post-v1 spike AIT-S06). Browser input cannot supply credentials or widen operator policy.

Keep a host-owned processor inventory with the protected settings and evidence documents, outside git. Cover the host itself and every configured provider **per lane**, including operator-local providers; identify inactive lanes and the processors selected for each session:

| Processing party / lane | Data and processing to inventory |
| --- | --- |
| Host itself | Participant/authorization references, captured text, normalized document text, generated working specs/screens, journal, audit and budget records; hosting/storage/backup locations |
| Provider for `reaction` | Bounded conversation context used to generate replies (`intake`) |
| Provider for `spec` | Bounded transcript/source context used to generate the working spec (`specification`) |
| Provider for `design` | Brief/spec context used to generate screen IR (`design`) |
| Optional provider for `stt` | Raw voice used for transcription only (`transcription`) |
| Optional provider for `tts` | Reply text used to synthesize speech (`intake`); no speaker identification |

For each provider entry, record the lane, purpose/data sent, template/model, qualified `account_ref`, `evidence_ref`, execution location (`operator` or `cloud`), and inference/storage/log country sets. Retain the account's evidence documents, secret-binding attestation, retention entitlement and exceptions, training opt-out evidence, and `verified_at` / `expires_at` (NM8, R3-B2). Inventory parsers as operator-trusted code: child-process limits are not OS-enforced isolation in v1 (ND14; AIT-S09).

Bind the inventory to `settings_sha256 = sha256Hex(canonicalJson(settings))` using `contracts/validate.js` (RFC 8785), not a hash of pretty-printed JSON. Before processing any session, including a local session or offering its microphone, retain a host-owned `aithema.authz/1` record (ND8). It carries `tid` / `pid` / `sid`, participants with roles and `notice_ref`, purposes, processors/evidence, `settings_sha256`, the host's `basis_label`, current `epoch`, `created_at` and `withdrawn_at`. Provider entries in `processors[]` use the template id as `processor_ref`, with matching `evidence_ref`, `location` and expanded `countries`; keep lane/account details in the inventory/settings, not extra authz fields. Refresh the inventory and session authorization when settings or selected processors change. Aithema checks the record and current authority; the host decides the basis.

Fill the host's DPIA record from these hooks; configuration validation does not decide whether a DPIA is required or approve its outcome:

| Facts supplied by Aithema | Host decision / record to complete |
| --- | --- |
| Settings digest, selected templates/lanes and processor references | Purposes, data/participant categories, controller/processor roles, lawful basis, notices, necessity/proportionality and approved processors |
| Account-bound residency evidence, explicit versioned country sets, retention exceptions, training opt-out and expiry (NM8) | Acceptability of locations/transfers and evidence, provider agreements, safeguards and evidence renewal |
| Host-owned stores, transient audio and withdrawal/purge behaviour below (NM2, NM3, NB3) | Retention periods per store, exports/backups, deletion duties, rights handling and provider-side retention/deletion arrangements |
| Interaction disclosure and actual marking/export evidence per modality (NM9, ND-A50) | Keep disclosure visible; record the bounded marking assessment, legal input and release-qualification decision, including any modality restriction |
| Operator-trusted parser limits (ND14) | Accepted residual risk, service privileges and deployment safeguards; overall DPIA need/outcome |

V1 residency is evidence-based country-set admission, not sovereignty or air-gap assurance; there is no `deny` egress mode or automatic failover. Recheck evidence at validation, session start and every authority check. Expiry disables **every** lane using that template, including STT/TTS; remaining admissible lanes and bounded text capture may continue (NM8). Art. 50 marking effectiveness for short text/HTML and streamed PCM remains an open release-qualification decision: provenance metadata/sidecars are not a compliance guarantee. V1 has no audio export; retain the per-modality assessment and ND-A50 decision before claiming a qualified release (NM9).

Keep evidence in the host-side stores (NB1, NM3, NB3):

- **Journal:** turns/transcripts, normalized immutable source text and segments, immutable design inputs, complete spec snapshots, confirmations, operation results, reactions/delivered-prefix certainty, authorization epochs, controls and session ends. These contain session content, not only digests.
- **Audit store:** host-retained audit records in the journal and any host audit exports. Critical records are acknowledged before their effects; `audit.restart` identifies a possibly lost best-effort tail. V1 does not guarantee a complete volatile audit trail.
- **Budget ledger:** authoritative attempts, holds, single-use claims bound to request digests/generation/epoch, settlements and recovery. Unknown claimed outcomes are charged conservatively at the maximum; journal copies do not replace the ledger or prove provider invoices.

Aithema does not persist raw voice or raw uploaded files and does not identify speakers. Submitted transcripts and extracted text are durable personal data. Credentials, bearer tokens and resolved secrets must never enter journal/audit/ledger records or exports; settings/evidence use secret references only. Aithema's cache is not the host's system of record.

On withdrawal, bump the host authorization epoch and notify the service: local capture/output stop and new claims are refused within the healthy bound (45 s from the epoch change) or outage bound (75 s from loss of authority availability to `CAPTURE_ONLY`). Already-committed dispatch claims may still send/finish and are charged; late output is discarded, not proof of provider-side cancellation (NM2, NB3). Purge starts with a host journal tombstone, drains at most 10 s, purges the service cache and returns an acknowledgement listing host-side artefacts. The host deletes those artefacts and handles its stores, exports/backups and provider obligations; an acknowledgement is not proof that a provider deleted its copy (§9.2).

Operator checklist:

1. Allocate the dedicated instance, accounts, protected secret references and host-side stores; check that no host or trust-context resources are reused (ND9).
2. Set `hosting.commercial: true`; review template/model/artifact licences, egress allowlists, residency evidence/expiry and spend caps. Attest each actual secret/account pairing.
3. Validate settings and authorization against `contracts/validate.js`, check `canExecute()`, and inspect the server-side capability matrix for every enabled lane. Structural validation alone does not establish evidence admissibility.
4. Retain the digest-bound processor inventory and session `aithema.authz/1`; complete the host's DPIA hooks and marking decision. Keep voice off until the selected speech processors are covered.
5. Verify withdrawal, evidence expiry, purge and backup/restore on a local fixture or isolated test deployment with synthetic data; record results inside this host's evidence boundary. Confirm the deployed release is qualified for the selected profile and modalities before serving real sessions.
