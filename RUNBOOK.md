# Aithema workspace runbook

This package is a reserved first public GitHub-source candidate (`0.1.0`, explicit `legacy-semver-public`). The commands below are for local operator/developer use. They do not publish to npm, create a remote or tag, deploy, or prove a live provider or OIDC integration.

## Tests (deterministic, no live credentials)

Prerequisites:

- Node.js 20+ and npm 10+
- `trash` CLI on PATH (packaging and source-export cleanup tests; on macOS this is typically preinstalled)
- Pinned font/PDF dependencies arrive through ordinary `npm ci` (`pdfkit`, `fontkit`, `@fontsource/noto-sans`, `unpdf`)
- Offline tarball consumer proof in `npm run test:packaging` requires a primed npm cache: run one ordinary `npm ci` in this repository before the offline case

```bash
npm ci
npm test
npm run test:packaging
npm run test:source-export
npm run example
```

`npm test` includes the approved AIT-4 core suite plus runtime, JWT/JWKS, SQLite persistence, configured OpenAI-compatible HTTP against a local fixture, workspace HTML behaviour, reviewed JSON/CSV/HTML/PDF export, document intake, parser-process cancellation, AIT-10 runtime packaging, and AIT-11 public source export. Source tests are not a substitute for later live provider/OIDC evidence. Fixtures use a labelled mock provider and deterministic local HTTP only.

Generated printable fixtures for coordinator QA (outside the repo): write reviewed JSON/CSV/HTML/PDF exports to an operator-owned temporary directory.

## Public source candidate review (local, no publish)

```bash
npm run source:export
mkdir -p /tmp/aithema-source-review
tar -xzf dist/inspr-aithema-core-source-0.1.0/inspr-aithema-core-source-0.1.0.tgz -C /tmp/aithema-source-review
cd /tmp/aithema-source-review
npm ci
npm test
npm run release:build
```

The extracted tree has no private Git metadata. Runtime release builds inside the extracted tree bind `release/source-provenance.json` to the runtime tree and lock digests, then stamp frozen `source.commit` with `current_source_commit` (the Git commit actually exported). They do not require private history and do not put private lineage into the runtime manifest. `private_source_commit` stays the original lineage (`2ba95dad…`) and `current_source_commit` is the public commit; git-mode and tree-mode runtime manifests then agree. Canonical publication toolchain is CI `ubuntu-latest` + Node 22 + GNU tar; timestamp input is the committer epoch recorded as `export_mtime_epoch`. Tag-gated `release/retain-forge-assets.mjs` retains admitted GitHub Release assets only when the ref is `refs/tags/{version}` or `refs/tags/v{version}`; a syntactically valid tag for another coordinate is refused before any forge I/O. `upload-artifact` is ephemeral transfer only. The release workflow sets `AITHEMA_CANONICAL_RELEASE=1` so admission and builders require the declared Node 22 + GNU tar toolchain; local BSD tar builds stay valid and are not claimed to match CI bytes. Coordinator-only gates after this candidate: create the `inspr-at/aithema` GitHub repository, run the release workflow on a matching tag, download consumer proof, and pin START separately. npm registry publication is not authorized and this tree does not claim the `@inspr` npm namespace. Configured production identity, live provider, and OIDC remain unproven.

## Labelled demo workspace (loopback only)

```bash
npm run workspace -- examples/demo-config.json
```

Open the printed `http://127.0.0.1:<port>/` URL.

Expected local browser QA (coordinator, after this commit):

1. Start a **new** loopback process on a free port (do not reuse an existing native QA server). `npm run workspace -- examples/demo-config.json`
2. The page shows a short **Demo / mock** notice and states that the mock is not live AI.
3. Continue with labelled demo identity `demo-reviewer` (human). Roles cannot be typed in the browser.
4. Create a project with more than one project kind checked (product and iteration may overlap).
5. On the project screen, the focused next question and message input appear first. Conversation history, understanding detail, project list, identity, and revision identifiers are under secondary details.
6. Send a requirements message. The reply asks one focused next question, updates understanding, and creates **unapproved** proposals with explicit Approve/Reject. The mock reply is visibly labelled.
7. At a 390px-wide viewport, the next question and message input are visible on the first screen before conversation history. Long digest and project id strings wrap without horizontal clipping.
8. Confirm there is no control that starts delivery, and that pending proposals are not an approved baseline.
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

## TLS reverse proxy and public origin

When the workspace sits behind a TLS reverse proxy, set `publicOrigin` in operator config to the browser-visible origin (for example `https://workspace.example.invalid`). Same-origin CSRF checks compare `Origin` / `Referer` against this value. The server does not trust arbitrary `X-Forwarded-*` request headers for origin validation; only the operator-configured `publicOrigin` overrides the loopback bind URL.

## Configured production-shaped run (still local)

Copy `examples/production-config.example.json` to an operator-owned file **outside git**. Fill:

- `identity.jwks_uri`, `issuer`, `audience`, and memberships (`actor_kind` and roles). Do not map `requirements_approver` onto `agent`.
- `providers.<name>.baseUrl` / `allowedModels` for an OpenAI-compatible endpoint (self-hosted included). Credentials stay in that server-owned file.

```bash
node examples/workspace.js /path/to/operator-config.json
```

Unconfigured production identity refuses to start. Browser requests cannot change the endpoint, API key, limits, or enable a model that is not in `allowedModels`. `/health` returns only `{ ok: true, ready: true }`. Operator `limits` in config are capped; they cannot be raised from the browser.

Live IdP and live model calls are **out of scope for AIT-6 worker evidence**. Wire them later and keep the proof separate from `npm test`.
