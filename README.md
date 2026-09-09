# Aithema Core

Reusable requirements assistant package extracted for AIT-4, with an AIT-6 conversation workspace above that core. Product, iteration, and integration streams can overlap; humans choose autonomy and delivery approval; incoming ideas stay proposals until an explicit baseline is confirmed.

This is a small standalone Node ESM package with built-in `node:test` — not a rewrite of the START agency application.

## Provenance

Selectively adapted from read-only inspection of START (`start-agm-com`) primitives:

| Aithema module | START source | Notes |
| --- | --- | --- |
| `lib/csv.js` | `src/lib/understanding-csv.ts` | `neutraliseSpreadsheetFormula`, semicolon CSV + BOM encoding pattern |
| Domain model naming | `delivery-stream.schema.json` | `requirement_ref`, `baseline_ref`, `content_digest`, `constraint_ref`, party roles |
| `runtime/transcript.js` | `src/lib/transcript-limits.ts`, dedupe in `src/lib/v2-transcript.ts` | Bounds `8000` / `80` / `96000`; incomplete streams are not durable; identical last role+content is not a new turn |
| `runtime/understanding.js` | `src/lib/guided-pass.ts` (algorithm only) | One focused next question; question merge/overlap; no agency slots or offer copy |
| `runtime/provider.js` | `src/lib/providers/types.ts` (LLM request/stream shape) | Generic `streamChat` contract; OpenAI-compatible HTTP adapter is original; mock is a labelled test double |
| `lib/extract-limits.js`, `runtime/extract.js`, `runtime/pdf-extract-child.js` | `src/lib/extract.ts`, `src/pages/api/upload.ts` | `unpdf` text-bearing PDF extract; page/output/deadline caps; honest empty/scanned/encrypted/unsupported results; extracted text only (no raw upload persistence). PDF parse runs in a child process that is killed on cancel. |

**Not copied:** agency prompts, branding/i18n, mail/handoff, credits, voice SDK, customer records, env/secret files, or START UI chrome.

START remains unchanged on its PMA business track. Public forge publication, START cutover, and live provider/OIDC proof remain later work.

## Design

- **Pure domain APIs** — caller supplies `VerifiedAuthority` (`party_ref` + `roles`); no fake auth.
- **Stable requirement IDs** — `requirement_ref` and `constraint_ref` are opaque refs aligned with the delivery contract.
- **Immutable approved baselines** — `content_digest` hashes canonical requirement/constraint payload in UTF-16 code-unit order (locale-independent). `revision_seal` binds `baseline_ref` + `revision` + `content_digest`. `approved_by` is a recorded claim; digests do not authenticate actors.
- **Proposal boundary** — contribution and `requirements_approver` approval are separate; import creates proposals only. Source handover identity is retained as claims, never as imported approval. Duplicate or stale add proposals are rejected rather than silently overwriting.
- **Update proposals** — `update_requirement` and handover-reachable `update_constraint` bind to the baseline snapshot they were authored against (`against_baseline_ref`, `against_revision`, `against_content_digest`). A second pending update for the same ref is rejected. Approval rejects conflicting or stale updates instead of last-write-wins, and never records `approved` for overwritten content. Non-conflicting edits and imports stay human-approved proposals.
- **Consequential revision review** — pending changes receive a deterministic before/after comparison of statements, acceptance criteria, and constraint values against their exact bound baseline. Added, removed, changed, and unchanged values stay explicit; direct requirement references are counted separately from selection size, while downstream delivery, schedule, and cost impact remains labelled unknown. Approval records a digest identity for the displayed review, selected proposal payloads, and compared baseline revisions/digests. The existing project revision gate rejects concurrent stale consent and requires a refreshed human review; nothing executes automatically.
- **Explicit rejection** — `rejectProposals` records `outcome: 'rejected'` with the same approver gate and leaves baseline history unchanged.
- **Rehydration trust boundary** — streams reloaded from storage are untrusted. `approveBaselineFromProposals` calls `assertRehydratedBaseline` on inherited content and verifies digest/seal *before* returning any new snapshot or decision. `assertApprovedBaselineImmutable` is the freeze-and-seal check; it is not a substitute for rehydration validation.
- **Handover export** — `exportHandoverJson` and `exportHandoverCsv` identify the same revision, digest, and seal for the current stream (including pending proposals). Reviewed portable exports (`exportReviewedHandover`, CSV/HTML/PDF) bind one explicit approved `baseline_ref`/`revision` and omit unapproved notes, provider config, and identity maps.
- **Document intake** — own-format `aithema.handover/0.1` JSON validates the canonical `content_digest` and becomes unapproved add/update proposals. `approved_by` / `revision_seal` stay claims. Generic text/CSV/JSON/XML/PDF keep filename, media type, and extraction/uncertainty; Interpret uses only the server-configured provider/model.
- **Conversation runtime** — authenticated input → configured provider → evolving understanding → unapproved proposals. A provider stream is complete only after an explicit successful terminator (`[DONE]` or `finish_reason: stop`). Premature EOF, length/content-filter finishes, cancellation, timeout, and oversized responses are incomplete: they do not persist assistant turns or mint proposals.
- **Speech input** — optional and disabled until an operator configures a speech provider, model, and exact OpenAI-compatible transcription endpoint. Chat Completions compatibility does not imply audio support. Record → Stop → Transcribe fills the existing message textarea as an editable draft; existing Send is unchanged and never automatic. No TTS. Raw audio stays in memory, is membership- and policy-gated, and is not stored. Browser MediaRecorder only; the implicit-cloud SpeechRecognition API is not used.
- **Provider registry** — named operator-owned providers and allowed models. OpenAI-compatible endpoints (including self-hosted) are server-configured, with bounded duration and response size. The browser cannot supply endpoints, credentials, limits, or an unapproved model. The mock provider exists only in explicit labelled demo/test mode and never claims live AI. Speech uses an independent completed-file adapter and a labelled test double; it does not treat an arbitrary chat endpoint as a transcriber.
- **Execution and data policy** — optional operator `policy` on workspace config is the configured boundary (not organizational identity). Projects inherit and may only narrow via operator keys in `policy.projects`. Humans select among configured registry ids with additive `providerId` plus an approved model; the same pin is used for chat, understanding, and interpret. Speech may use a separately approved model on a named registry provider and still cannot change endpoint, location, data class, credentials, or limits. There is no fallback if the explicit or default selection is disallowed. Absent `policy` keeps the historical single-provider process. Operator-declared data-class and local/cloud labels are not automatic classification or measured network placement. `maxOutboundCallsPerProject` is a durable request count, not currency; billing usage is unavailable in this slice. Transcription is one outbound request when the ceiling is configured.
- **Identity** — production uses JWT/JWKS (issuer, audience, algorithm, time) plus a trusted membership/actor-kind map. Optional operator-owned OIDC Authorization Code + S256 PKCE browser login issues opaque HttpOnly sessions; ID-token claims never set actor-kind or roles. A signed subject is not automatically human. Unconfigured production identity fails closed, and incomplete browser-login config is refused. Demo auth is loopback-only, HMAC-bound, and visibly labelled. Demo signing keys are ephemeral per process unless the operator sets a private secret. Optional `publicBasePath` (empty default) serves the workspace under a configured prefix such as `/aithema` without changing `publicOrigin`, cookie names, or per-app membership; cookie `Path=/` is not a security boundary on a shared origin.
- **Flow host** — the workspace embeds the pinned public Flow Shell 0.1.4 as a normal dependency. Host-issued Flow context uses opaque host/project/principal/binding/revision refs from the current verified actor and project membership. Raw subjects, emails, roles, tokens, and invented organizations are not placed in that context. Local demo vs OIDC-backed kinds stay distinct. Context is display data: consequential Flow intents are revalidated against current membership, and Paimos/Pharos/Janus starts stay explicitly unsupported. Requirements review still uses the existing approve/handover path.
- **Durable store** — SQLite with atomic revision updates, idempotent turn ids, and membership isolation. Current verified subject membership is authoritative on each request; `members` stores creator grants keyed by subject, not shared `party_ref`. Mapped project access is re-checked from the operator map and is not cached as a permanent grant.

Names align with `inspr.delivery-stream/0.1-draft` baseline shapes without implementing the full delivery protocol.

START voice SDK extraction and element-specific preview feedback remain later work. Public speech input is the optional completed-file path above, not a vendor voice SDK.

## Dependencies and fonts

Pinned in `package-lock.json` (package.json remains `private: true` as the npm publish guard; this is not an npm registry publication):

| Package | License | Use |
| --- | --- | --- |
| `unpdf` 1.8.0 | MIT | PDF text extraction (pdf.js). Same family START uses. |
| `@inspr/flow-shell` 0.1.4 | AGPL-3.0-only | Pinned public Flow Shell runtime tarball from GitHub Release `v0.1.4` (`sha256:b5e773ee…`). Compact branded header/footer around host-owned workspace content. Not a source fork and not an npm namespace claim. |
| `openid-client` 6.8.8 | MIT | Certified OpenID Connect client for optional production browser login (Authorization Code + S256 PKCE). |
| `pdfkit` 0.17.2 | MIT | Printable PDF generation. Transitive `crypto-js` / `jpeg-exif` are unused by our text-only export path. |
| `fontkit` 2.0.4 | MIT | Opens pinned Noto Sans WOFF subsets to verify glyph coverage before PDF export. |
| `@fontsource/noto-sans` 5.2.5 | SIL OFL 1.1 | Embedded Latin, Latin-Extended, Greek, and Cyrillic WOFF subsets in PDF. Standalone HTML uses the viewing device’s system font stack for broader Unicode. PDF export is not universal Unicode: characters those subset files cannot paint (for example CJK and some Latin Extended Additional codepoints such as U+1EBF and U+1EC7) are refused with an error that points at lossless HTML/JSON, never dropped as missing glyphs. CJK is not embedded (those files are large). |

No raw uploads or customer records are written. Tests use the labelled mock provider and labelled speech test double only.

## Usage

```bash
npm test
npm run test:packaging
npm run test:source-export
npm run verify:license
npm run release:build
npm run source:export
npm run example
npm run workspace -- examples/demo-config.json
aithema-workspace --config /path/to/operator-config.json
```

`aithema-workspace` is the supported service executable installed from the immutable GitHub runtime tgz. It never selects the committed demo config implicitly: `--config FILE` is required, and the file must be readable, valid JSON, and valid workspace configuration before a socket is opened. `npm run workspace` remains a labelled loopback demo convenience and defaults to `examples/demo-config.json` only on that example path.

The executable handles `SIGTERM` and `SIGINT` with a bounded drain: it stops accepting connections, waits up to 10 seconds by default, force-closes lingering HTTP connections at the deadline, and closes SQLite once. Operators may set a shorter or longer bound (maximum 300 seconds) with `--shutdown-grace-ms MILLISECONDS`. Readiness at `/health`, or `{publicBasePath}/health` when mounted, is the existing safe `{ "ok": true, "ready": true }` response. It attests only that the local process has validated configuration, opened its SQLite store, and started listening; it does not probe provider or identity-provider reachability. When `publicBasePath` is set, the unprefixed health path is not served.

`npm run release:build` publishes one immutable runtime release coordinate as a single directory, `dist/inspr-aithema-core-0.5.0/`, holding `inspr-aithema-core-0.5.0.tgz` and its sidecar manifest built from the closed allowlist in `release/allowlist.json`. The directory is staged and committed with one rename, so the pair is never half-written and an existing coordinate is never replaced: a byte-identical rebuild is accepted, different bytes are refused.

`npm run source:export` publishes one immutable public GitHub-source candidate as `dist/inspr-aithema-core-source-0.5.0/`, holding `inspr-aithema-core-source-0.5.0.tgz` and its sidecar manifest built from the closed allowlist in `release/source-allowlist.json`. The export includes tests, release tooling, and CI workflows needed to reproduce runtime packaging, while excluding private worker files such as `AGENTS.md`, private Git history, and operator residue. The source manifest records `private_source_commit` as original lineage and `current_source_commit` as the Git commit actually exported; those are not interchangeable. Runtime artifact manifests keep frozen schema `aithema-release-manifest/0.1` and bind `source.commit` to that current exported commit so a public Git checkout and its extracted non-Git tree agree. Canonical published bytes are the CI GNU tar toolchain with Git committer-epoch timestamps; BSD tar may differ. Machine-readable publication inventory and coordinator handoff gates live in `release/publication-inventory.json`. Version scheme is an explicit `legacy-semver-public` discriminator and is not inferred from the `0.5.0` string.

First public coordinate `0.1.0` is published at [inspr-at/aithema](https://github.com/inspr-at/aithema) (`v0.1.0`, commit `1028b450`). Provider-policy coordinate `0.2.0` is also published (`v0.2.0`, commit `cff9eae`). Shared Flow host coordinate `0.3.0` is published (`v0.3.0`, commit `28c5576`). OIDC browser login coordinate `0.4.0` is published (`v0.4.0`, commit `54c3339`). This tree prepares legacy SemVer `0.5.0` as a GitHub-source and runtime-tgz coordinate. Preparation alone does not publish it: the matching tag and [GitHub Release assets](https://github.com/inspr-at/aithema/releases) are the authority for availability. This repository does not claim the `@inspr` npm namespace. `package.json` `private: true` remains the npm publish guard.

This candidate adds the installed workspace executable, optional native URL prefixes, and workspace speech input with cancellation on disconnect while preserving configured OIDC login, operator-controlled identity and project membership. The existing shared Flow header and delivery footer consume immutable Flow Shell 0.1.4 for bounded mobile layouts. They use current host identity and real baseline records; disconnected delivery stages remain gated. Node 24 or newer is required for consumers; canonical releases use Node 24 with GNU tar.

Package subpaths: `@inspr/aithema-core` (domain), `@inspr/aithema-core/runtime`, `@inspr/aithema-core/workspace`. Installed executable: `aithema-workspace`.

```js
import {
  createStream,
  proposeRequirement,
  approveBaselineFromProposals,
  rejectProposals,
  exportHandoverJson,
} from '@inspr/aithema-core';

const approver = { party_ref: 'party:owner', roles: ['requirements_approver'] };
let stream = createStream('stream:my-product', ['new_product']);
stream = proposeRequirement(stream, approver, {
  requirement_ref: 'req.login',
  statement: 'Users sign in with email',
  acceptance_criteria: ['Magic links expire'],
  constraint_refs: [],
});
stream = approveBaselineFromProposals(stream, approver, [stream.proposals[0].proposal_ref], 'baseline:v1');
console.log(exportHandoverJson(stream));
```

Operator setup for the workspace is in `RUNBOOK.md`. Local tests use a deterministic HTTP fixture, a synthetic OIDC issuer, a labelled speech test double, and labelled demo identity; they are not live provider, microphone, or OIDC proof.

## License

AGPL-3.0-only. First public GitHub source/runtime-tgz coordinate `0.1.0` is published at [inspr-at/aithema](https://github.com/inspr-at/aithema); `0.2.0`, `0.3.0` and `0.4.0` are also published and `0.5.0` is the prepared candidate in this increment. npm registry publication is not authorized.
