# First reset release candidate — 261015164601.0.0

AIT-105, 2026-10-15. INSPR-CalVer3, stable channel, sequence 12 after legacy
0.10.1 (sequence 11). Candidate preparation only; no tag, forge release or
registry publication. The public licence remains AGPL-3.0-only.

## What the reset delivers

Aithema is an embeddable module set. Core owns conversation state, typed plugin
contracts, consent and invocation rules; server exposes Web Request handlers
and a Node HTTP adapter with SQLite persistence; UI provides
`<aithema-session>` and isolated HTML preview components. A thin host such as
START supplies storage, authenticated ownership, identity verification,
authoritative consent, owner-scoped library/handover/wallet ports, and budget
policy. The host mounts the handlers and components without adopting the demo.
This candidate proves a scratch consumer, not production adoption by START.

The packer emits fifteen installable module tarballs with exact internal pins,
licence and source-rights notes, source-commit runtime metadata and SHA-256
inventories, alongside a workspace archive, locked dependencies and SPDX SBOM.
Two builds from the same committed source and toolchain must match byte for
byte. Candidate install, locked reinstall and retained-digest rollback are
exercised outside the workspace. Tag-only attestation is wired for a later
authorized tag; the local candidate has digest evidence, not a Sigstore signature.

## Overnight changes included in this freeze

- **AIT-218 (security):** simulator identity is private and bound to frozen
  implementations. Copied or mutated providers cannot use mock consent to
  dispatch real processing.
- **AIT-212:** reconnect and restart preserve paid-lane failure state without
  silently rerunning work. Explicit Retry handles both failed lanes in order;
  the remaining failure stays visible, with distinct reply-pending and overview
  states in German and English.
- **AIT-201:** shipped server diagnostics count admitted lane starts and terminal
  outcomes from the existing budget ledger. The lane-race kit qualifies these
  paths in repository tests; it is not an installable runtime feature.
- **AIT-209 (qualification only):** the repository browser launcher has a bounded
  launch timeout and one launch-only retry. The test launcher is excluded from
  module and workspace tarballs; this does not change consumer runtime behavior.

Round 6 also rejects packed imports of source-only siblings and preserves START2
host defaults when options are explicitly null or undefined.

## Modules, host ports and presets

All packages use the version in the title. The publishable set is
`@inspr/aithema-core`, `@inspr/aithema-server`, `@inspr/aithema-ui`, and
`@inspr/aithema-plugin-{openrouter,mistral,device,elevenlabs,openai-images,claude-html,codex-imagegen,extract-text,extract-pdf,extract-ooxml,mail-smtp,zitadel-oidc}`.
The root workspace stays private; fake voice fixtures and parked
composed-voice/Voxtral sources have no publishable package and are retained only
in the source/workspace archive. The unexported ElevenLabs composed STT/TTS
proof (`components.js`) shares that source-only boundary because it imports
the unpublished composed helper; the existing ElevenLabs voice exports remain
the package API. No provider credentials are bundled.

OpenRouter and Mistral implement server text reasoning; device implements the
browser text route. ElevenLabs supplies server and browser voice adapters behind
neutral voice ports. OpenAI images, Claude HTML and Codex image generation
preserve output provenance and their individual lifetime/cost contracts.
Text/PDF/OOXML extraction runs in bounded offline workers. SMTP and Zitadel
provide optional host mail and identity integration.

Hosts configure `best`, `eu`, `device` and `custom` presets, with separate
reaction/understanding model bindings, voices, visuals and defaults. Unbound
choices stay unavailable. The device preset is browser text only. EU processing
requires account/route-specific qualification and current consent; a vendor's
location alone grants nothing. Budgets, consent, pause and ownership are checked
before dispatch. Public manifests contain technical capabilities, never secrets
or a legal qualification promise. The `apiVersion: ^1.0.0` plugin protocol is
separate from the CalVer3 product coordinate.

## Host exports (AIT-205)

German copy is available through `@inspr/aithema-ui/i18n/de`, with the same
recursive key set as English. `@inspr/aithema-plugin-elevenlabs/voice-host`
provides the live-voice host factory and binding normalizer; hosts inject naming,
openers, costs and their own legal qualification. The demo consumes that factory.
`@inspr/aithema-server/dev/local-voice` supplies the credential-free simulator
for development/tests only, never production. Operator copy stays with the demo
operator page; UI implementation helpers and release metadata stay internal.
The symbol decisions and exact browser URL exceptions are in the consumer
section of `docs/embedding.md`. The outside-workspace consumer exercises all
runtime exports and verifies types-only declarations and locale key parity.

## Migration and known limits

Legacy 0.10.1 was a private monolith with `lib`, `runtime` and `workspace` APIs.
The reset split modules are an API break. There is no automatic legacy database
or API conversion. Move host integration to the documented handlers/components,
replace the exact dependency pins, and retain the old deployment and database
backup separately. The evidence tests anchored legacy-to-calendar ordering and
dependency replacement; it does not claim a live legacy installation upgrade.
Rollback of the reset candidate reinstalls retained tarballs by manifest digest
and reruns the consumer smoke test. No release coordinate or mutable alias moves.

- **AIT-139: the 60-minute DE/EN live voice soak is not measured** (Markus:
  “Kein Test”). Offline tests are not a latency, disruption or reconciliation
  measurement. This is disclosed, not a release blocker.
- **AIT-160: a second independent voice pipeline is not yet proven**, and is
  parked. Fake transport conformance and composed pipeline sources are not live
  exchangeability evidence. This is disclosed, not a release blocker.
- **Legal formalisation is out of scope (D3).** Existing rights/provenance notes
  and AGPL-3.0-only remain; this candidate grants no additional licence.
- The shared presentation pin review passed in the controller-supplied AIT-105
  gate1 report. No review gate is run as part of this builder lane.
- A browser bundler/import map and module JSON support are required. Scratch DOM
  mounts do not prove real-browser layout, CSP enforcement or live provider quality.

See [embedding](../docs/embedding.md), [GitHub release route and reproduction](README.md)
and [migration inventory](inventory.json). Machine-readable evidence is retained
with the candidate and summarized in `release/evidence.json` after verification.
