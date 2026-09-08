# Aithema workspace runbook

This package prepares public GitHub-source candidate `0.4.0` (explicit `legacy-semver-public`). Releases `0.1.0`, `0.2.0` and `0.3.0` are already published at [inspr-at/aithema](https://github.com/inspr-at/aithema) (`v0.1.0`, `v0.2.0`, `v0.3.0`). The commands below are for local operator/developer use. They do not publish to npm, create a tag, deploy, or prove a live provider or OIDC integration.

## Tests (deterministic, no live credentials)

Prerequisites:

- Node.js 24 and npm 10+ (workspace Flow host consumes `@inspr/flow-shell` 0.1.4, which requires Node 24)
- `trash` CLI on PATH (packaging and source-export cleanup tests; on macOS this is typically preinstalled)
- Pinned font/PDF dependencies arrive through ordinary `npm ci` (`pdfkit`, `fontkit`, `@fontsource/noto-sans`, `unpdf`)
- Optional production browser login uses pinned `openid-client` 6.8.8 (Authorization Code + S256 PKCE). Do not enable it with incomplete client/issuer values.
- Offline tarball consumer proof uses a named online packument prime, not a warm operator cache: `AITHEMA_NPM_CACHE` + `AITHEMA_PRIME_OUT` (never `dist/`) then `node release/prime-consumer-cache.mjs --build`. `npm ci` alone is not enough. The packaging test also proves `--offline` fails on an empty cache before that prime. npm `--offline` cannot replay GitHub Release HTTP tarball fetches; the test replays the primed Flow 0.1.4 integrity blob as a file: override after checking SHA256 `b5e773ee…`.

```bash
npm ci
npm test
npm run test:packaging
npm run test:source-export
npm run example
```

`npm test` includes the approved AIT-4 core suite plus runtime, JWT/JWKS, optional OIDC browser login against a local synthetic issuer, SQLite persistence, configured OpenAI-compatible HTTP against a local fixture, workspace HTML behaviour, reviewed JSON/CSV/HTML/PDF export, document intake, parser-process cancellation, AIT-10 runtime packaging, and AIT-11 public source export. Source tests are not a substitute for later live provider/OIDC evidence. Fixtures use a labelled mock provider and deterministic local HTTP only.

Generated printable fixtures for coordinator QA (outside the repo): write reviewed JSON/CSV/HTML/PDF exports to an operator-owned temporary directory.

## Public source candidate review (local, no publish)

```bash
npm run source:export
mkdir -p /tmp/aithema-source-review
tar -xzf dist/inspr-aithema-core-source-0.4.0/inspr-aithema-core-source-0.4.0.tgz -C /tmp/aithema-source-review
cd /tmp/aithema-source-review
npm ci
npm test
npm run release:build
```

The extracted tree has no private Git metadata. Runtime release builds inside the extracted tree bind `release/source-provenance.json` to the runtime tree and lock digests, then stamp frozen `source.commit` with `current_source_commit` (the Git commit actually exported). They do not require private history and do not put private lineage into the runtime manifest. `private_source_commit` stays the original lineage (`2ba95dad…`) and `current_source_commit` is the public commit; git-mode and tree-mode runtime manifests then agree. Canonical publication toolchain is CI `ubuntu-latest` + Node 24 + GNU tar; timestamp input is the committer epoch recorded as `export_mtime_epoch`. Tag-gated `release/retain-forge-assets.mjs` retains admitted GitHub Release assets only when the ref is `refs/tags/{version}` or `refs/tags/v{version}`; a syntactically valid tag for another coordinate is refused before any forge I/O. `upload-artifact` is ephemeral transfer only. The release workflow sets `AITHEMA_CANONICAL_RELEASE=1` so admission and builders require the declared Node 24 + GNU tar toolchain; local BSD tar builds stay valid and are not claimed to match CI bytes. Coordinator-only gates after this candidate: published `0.1.0`, `0.2.0` and `0.3.0` at `inspr-at/aithema` remain immutable; run the release workflow on a matching `0.4.0` tag, download consumer proof, and pin START separately. npm registry publication is not authorized and this tree does not claim the `@inspr` npm namespace. Configured production identity, live provider, and OIDC remain unproven.

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

## Membership and SQLite schema

Access is decided on every request from:

1. a **creator grant** in `members` keyed by verified `subject`, written only when that subject creates the project; and
2. the current operator membership `projects[]` mapping for that same subject.

Removing a `project_ref` from a subject's `projects[]` revokes mapped access to that project for every path (page, handover, review, cancel). It does **not** revoke access to projects that subject created independently — creator grants persist until the subject is removed from `memberships` entirely. Sharing `party_ref` does not share access. Human approval still requires a mapped human with `requirements_approver`; creator grant is access, not approval.

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
node examples/workspace.js /path/to/operator-config.json
```

Unconfigured production identity refuses to start. Browser requests cannot change the endpoint, API key, limits, policy, data class, epoch, or enable a model that is not in `allowedModels`. Additive `providerId` may name a registry id already allowed by operator policy. `/health` (or `{publicBasePath}/health`) returns only `{ ok: true, ready: true }`. Operator `limits` in config are capped; they cannot be raised from the browser.

## Provider policy and request ceilings

Omit `policy` to keep historical single-provider behaviour (`defaultProvider` only). When `policy` is present it is fail-closed:

- `execution` is `local`, `cloud`, or `mixed`. Each registry entry used in `allowedProviders` must declare `executionLocation` (`local` or `cloud`) and `allowedDataClasses`.
- `policy.projects.<project_ref>` may only narrow the organization values. Browsers cannot submit policy or data-class changes.
- Unknown location or class cannot satisfy a constrained policy. A confidential-labelled project cannot call a provider that only allows `public`.
- Default and explicit selections are pinned for both conversation calls (normally two outbound requests per turn) and document interpret. If that selection is disallowed, the request fails before any outbound call; another provider is never substituted.
- `maxOutboundCallsPerProject` counts outbound provider requests in SQLite per project and `policy.epoch`. It is **not currency** and is not a billing estimate. This slice reports billing usage as unavailable. Bumping `epoch` in operator config starts a new count window; browsers cannot reset it. A reserved id is not refunded after a possibly-sent call or crash; retrying the same id fails honestly instead of sending again.

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

The browser may choose only that approved provider/model. It cannot set endpoint, credentials, location, data class, or limits. Record → Stop → Transcribe fills the existing message box as an editable draft. Existing Send is unchanged and never automatic. Raw audio and unsent transcripts are not written to SQLite, logs, or temp files. When `policy.maxOutboundCallsPerProject` is set, transcription reserves one outbound request-count slot; that count is not currency. Configured `local` / `cloud` labels are operator-declared, not measured network placement.

Labelled mock speech (`kind: "mock"`) is demo/test only. Native browser/microphone QA is coordinator work; `npm test` uses synthetic in-memory audio and a local HTTP fixture.
