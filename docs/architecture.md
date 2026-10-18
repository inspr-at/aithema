# Architecture and enforced module boundaries

Aithema is an identity-free embeddable module: core owns domain state and contracts,
server owns Fetch handlers and persistence, UI owns presentation, and plugins own
provider adapters. Hosts supply identity, consent policy, copy, branding and binding
configuration through ports. This follows PPM AIT's approved
`guideline/aithema-vision-architecture` (AIT-141, 2026-10-12) and
`guideline/aithema-reset-concept` (AIT-95, decisions D2–D5).

AIT-229: the UI's shared conversation fold and canvas loader both gate the drafts
surface on the selected visual capability. Hosts/presets without drafts retain the
transcript and the AIT-246 `draftsOff` host-unavailable sentence; they never expose
the empty-canvas promise. Capability removal while folded restores the transcript.
A configured host can fold without a price quote, and existing drafts remain
readable through temporary generation restrictions. The fold retains its edge slot
and keyboard focus target (`aria-disabled`) without moving composer controls.
The unit regressions cover HTML/image capability state, cached drafts and late
canvas responses. Browser CI checks actual transcript/canvas visibility and
zero-shift fold attempts at phone and desktop sizes in DE/EN, switching host
configuration in the same page. Evidence runs separately with the complete
1440/1024/390 × light/dark × DE/EN matrix; CI artifact paths do not enable captures.
The question-card browser sweep retains all width-specific geometry and native
keyboard/voice checks, with representative visual-viewport heights around the
620px compact breakpoint; evidence keeps the exhaustive 8px height sweep.

## Privacy-safe voice correlation (AIT-139 Part 1)

The provider-neutral executor (`packages/server/src/voice-turns.js`) and server
lifecycle emit through the existing diagnostic sink for both composed voice and
ElevenLabs. The closed schema is in `packages/server/src/voice-observability.js`:
`event`, opaque SHA-256 `callHash`, `generationHash`, `turnHash`, `attemptHash`;
allowlisted stage fields are `admissionMs`, `firstTokenMs`, `totalMs`, bounded
`cause`, `outcome`, `closureConfirmed`, `costEstimated`, `reconciliationAgeMs`.
Reconciliation retains the existing `providerHash`, `chargedMicro` and bounded
`code` fields. Turn IDs derive from the first random operation-attempt ID, never
from content or its digest; replacement attempts keep the turn ID and change the
attempt ID. Reconnects change generation ID while preserving call correlation.

Stage durations never decrease within a writer, even on wall-clock correction.
One confirmed closure follows each settled attempt once confirmation is known;
unknown closure remains pending. Later usage updates use reconciliation records.
Reconciliation age is measured from segment end (start for open segments).
Records contain no speech, prompts, transcripts, references, token counts, keys,
credentials, provider secrets, raw IDs, URLs, headers or exception text. Fixed
fields, bounded enums, finite nonnegative safe integers and fixed-size hashes keep
each record below 1 KiB; closure caches each retain at most 4096 entries. Closure
deduplication is in-process and bounded: eviction or restart can repeat a record.
Thrown or rejected sinks cannot change publication, consent checks or accounting.

The independent synthetic `test/fixtures/voice-observability-*.json` oracles cite
vendor wire-shape documentation and label local extensions. ElevenLabs replay and
composed coordinator integration share them via `test/voice-observability-fixtures.js`.
Unit/integration tests cover privacy, record size, every ordering of two concurrent
completions and closure confirmation, retries, partial streams, delayed usage,
consent revocation and exactly-once paid settlement. Part 2's live soak is separate.
No environment reads or new layer exceptions are introduced.

## Allowed edges

The table below is rendered from `layers` in `scripts/check-boundaries.mjs`.
`test/module-boundaries.test.js` compares the rendered table with this document,
so changing policy requires updating both together.

| Layer | Sources | Allowed cross-module edges (public exports only) | Responsibility |
| --- | --- | --- | --- |
| core | `packages/core` | none | Headless domain, contracts and shared engine primitives |
| ui | `packages/ui` | core | Web components and browser presentation |
| server | `packages/server` | core | Fetch handlers and persistence; #173 pins the legacy bridge |
| host | `demo` | core, ui, server, plugin | Reference host; package imports except named browser sources |
| plugin | `plugins/*` | core, ui, server, plugin | Exchangeable provider adapters |

Every cross-module edge must resolve to an explicit package export. Core cannot
import server, UI or plugins; UI cannot import server or plugins. Server source
cannot import provider plugins. The separate legacy ElevenLabs bridge preserves
#173's frozen compatibility exports; only its listed source and targets are permitted.

AIT-211: hosts configure and register HTML/image implementations (the demo uses
`demo/visual-plugins.js` from `demo/server.js`). HTML admission calls the selected
plugin's `estimateCost(request, operation)` port, preserving Claude's exact prompt
byte ceiling; without that port it reserves `binding.maxMicro`. Local deterministic
adapters own their manifests and retain their private implementation pairings and
zero-cost consent exemption. Core's explicit `ui-html-prompt`, `ui-html-artifact`
and `ui-image-artifact` subpaths provide shared request validation and artifact
construction, with provider repair, decoding, prices and watermark claims in plugins.
The browser-facing core root does not import these Node artifact constructors.

| Source | Exact exception | Owner / reason |
| --- | --- | --- |
| `packages/server/elevenlabs-compat.js` | `plugins/elevenlabs/src/provider.js`, `plugins/elevenlabs/src/callbacks.js` | #173: frozen legacy root exports |
| `plugins/composed-voice/ops/qualification-live-server.mjs` | `plugins/elevenlabs/src/components.js` | AIT-160: source-only live qualification components |
| `plugins/composed-voice/ops/qualification-live-server.mjs` | `plugins/elevenlabs/src/voice-settings.js` | AIT-249: source-only qualification voice settings validation |
| `plugins/composed-voice/src/live-qualification.js` | `plugins/elevenlabs/src/voice-settings.js` | AIT-249: source-only qualification voice settings validation |
| `plugins/composed-voice/ops/qualification-live-baseline.mjs` | `plugins/elevenlabs/src/options.js` | AIT-160: source-only baseline production overrides |
| `demo/server.js` | `plugins/composed-voice/ops/qualification-server.mjs` | AIT-160: explicitly flagged source-only qualification host |
| `plugins/composed-voice/src/server.js` | `packages/server/src/composed-voice.js` | #173: unpublished composition proof |
| `plugins/composed-voice/src/qualification.js` | `packages/server/src/composed-voice.js` | #173: unpublished composition proof |
| `plugins/composed-voice/src/configuration.js` | `plugins/elevenlabs/src/components.js` | #173: unpublished composition proof |
| `plugins/composed-voice/src/configuration.js` | `plugins/voxtral/src/index.js` | #173: unpublished composition proof |
| `demo/server.js` | Exact VOICE/IMAGE/COMPOSED_QUALIFICATION host-module expressions | #173 / AIT-160: injected host entrypoints |
| `demo/host.js` | Relative public source URLs | AIT-205: native browser loading |
| `demo/consent-page.js` | Relative public source URLs | AIT-205: native browser loading |
| `demo/admin-view.js` | Relative public source URLs | AIT-205: native browser loading |
| `demo/admin-copy.js` | Relative public source URLs | AIT-205: native browser loading |
| `demo/fake-voice.js` | Relative public source URLs | AIT-205: native browser loading |
| `packages/server/src/voice-provider.js` | `packages/server/src/dev/local-voice-manifest.js` | AIT-218: private simulator manifest |
| `plugins/fake-voice/src/manifest.js` | `packages/server/src/dev/local-voice-manifest.js` | Test-only manifest forwarder |
| `plugins/fake-voice/src/server.js` | `packages/server/src/dev/local-voice.js` | Test-only compatibility forwarder |
| `demo/fake-voice.js` | `plugins/fake-voice/src/client.js` | Test-only browser simulator forwarder |
| `demo/server.js` | `@inspr/aithema-server/dev/local-voice` | Explicit simulator factory with production guard |

AIT-202 and AIT-205 use one AST scan and this policy in
`scripts/check-boundaries.mjs`, exercised by `test/module-boundaries.test.js` and
negative host fixtures in `test/demo-package-imports.test.js`. The embedding guide
links here for the host policy. Browser exceptions must still resolve public
exports and must remain used; fake-voice is a test-only, unpublished dependency.

AIT-205 scans non-test demo modules; package/plugin tests still require literal
imports. Tests may inspect internals. The public simulator entrypoint forwards to
AIT-218's private implementation in `packages/server/src/voice-provider.js`.
Its frozen start/adapter pairings, refused local binding and private dispatch
snapshots remain intact. Other `dev/` sources are checked normally and cannot be
imported by production code. The fake-voice manifest and factory forwarders above
preserve the candidate layout. The public `local-voice-identity` subpath exposes
recognition only; no package subpath exports enrollment or implementation access.
The obsolete `packages/server/src/local-voice.js` shim is removed.

`@inspr/aithema-server/composed-voice` is a supported export included in the next
server release. `createComposedVoiceCoordinator` is a building block for composed
pipelines, coordinating separately admitted STT, reasoning and TTS through trusted
server authorization, utterance-commit and relay ports. `callDurationSeconds`
validates an explicit `maxDurationSeconds` ceiling (default 900 seconds, integer
range 1–86400), which caps the coordinator's spend deadline; hosts supply policy
such as 3600 seconds themselves. No composed or Grok pipeline is released or
qualified by this export: both are **not yet qualified in live use**, and Grok
publication is deferred to package 8. AIT-316 publishes the core
`/voice-components` contract and generic helpers. The composed-voice adapter,
Voxtral adapters and ElevenLabs `components.js` remain source-only prototypes
excluded from module tarballs.
The exact proof edges above permit their unpublished consumers without admitting
new consumers. Next-release migration notes are in `release/next-notes.md`.

The checker parses static imports, re-exports, dynamic imports, CommonJS require,
createRequire bindings (including aliases and namespace factories), TypeScript
import types and templates. Nonliteral specifiers fail even in package/plugin tests and the simulator,
except the exact injected host-module expressions listed above. AIT-160 adds only
the explicit qualification-module expression and the one source-only host edge;
the flag and loopback guards remain mandatory. SDK worklet
loaders use a finite literal import map. Comments and ordinary strings are ignored. Env/config files,
dependencies and symlinks are not read. Relative browser imports must reach an
exported target; Node hosts use package specifiers. Run checks on the designated
test worker; the complete suite belongs to PR CI.

To add a module, declare its layer and explicit exports, then add a negative
fixture for any new allowed edge. Both policy tables above are rendered from the
checker and tested for drift. Release packing retains #173's source admission
rule: no blanket top-level `dev/` inclusion. New exports or packed files invalidate
the candidate freeze; only the coordinator may arrange a replacement freeze.

## Deliberate ambient CI reads in tests

`scripts/ci-env-declarations.json` records each deliberate ambient CI read, its
occurrence count and reason. `scripts/check-ci-env.mjs` parses every test/helper
under packages, plugins, test and demo/test. New variables, new occurrences,
computed reads, process aliases, and whole-environment forwarding require an
explicit declaration; computed reads also pin the containing statement so a changed
forwarding key list fails. Removed reads must remove stale declarations. The rendered
inventory below is also compared by the unit test. Declarations describe intent,
not environment values. Tests must not silently change coverage because an
undeclared CI variable happens to exist.

`CI` deliberately selects Linux Chrome's sandbox arguments. AIT-185/192 uses it
to keep PR artifact directories from enabling the full evidence matrix; nightly
explicitly unsets CI. `GITHUB_SHA` and `GITHUB_RUN_ID` label evidence/provenance.
The soak wrappers forward CI to children deliberately. Whole-environment copies
in orchestration tests preserve or explicitly override CI while exercising child
commands. Manual OPS diagnostics outside the test tree also use CI as a refusal
guard (`scripts/{diagnose-reply-schema,understanding-diagnostic,eval-safeguards}`);
they are not test coverage switches.

| Test or helper | Ambient reads / forwarding (occurrences) | Deliberate purpose |
| --- | --- | --- |
| `test/browser-launch.test.js` | `process.env` ×1 | Hermetic fake-CDP executable child-process environment forwarding for launcher retry coverage |
| `test/browser-matrix-coverage.test.js` | `process.env` ×2 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/browser/admin-pages.test.js` | `CI` ×3 | Linux headless Chrome sandbox selection; AIT-185/192 full evidence matrix disabled in CI |
| `test/browser/audio-replay.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/compact-footer-check.js` | `GITHUB_EVENT_PATH` ×2 | AIT-301/309 footer evidence identifies the PR head from the GitHub event payload |
| `test/browser/composed-media.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/composed-qualification.test.js` | `CI` ×3 | Linux Chrome sandbox selection for actual command-line coverage and the hermetic qualification CLI child, including the pre-dispatch output-device probe |
| `test/browser/confirmation-design.test.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/browser/credit-hold.test.js` | `CI` ×3 | Linux headless Chrome sandbox selection; AIT-185/192 full evidence matrix disabled in CI |
| `test/browser/credits-first-receipt-check.js` | `GITHUB_EVENT_PATH` ×2 | AIT-357 receipt evidence identifies the PR head from the GitHub event payload |
| `test/browser/demo-legal-phone-check.js` | `GITHUB_EVENT_PATH` ×2 | AIT-304 footer evidence identifies the PR head from the GitHub event payload |
| `test/browser/demo.test.js` | `CI` ×9 | Linux headless Chrome sandbox selection |
| `test/browser/external-plugin.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/footer-width-sweep.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/host-surface.test.js` | `CI` ×2 | Linux headless Chrome sandbox selection |
| `test/browser/html-preview.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/matrix-coverage.js` | `CI` ×1, `GITHUB_ACTIONS` ×1 | AIT-185/192 full evidence matrix disabled in CI; nightly explicitly unsets CI; AIT-293 manual axe evidence also excludes GITHUB_ACTIONS so PR and nightly CI never run axe |
| `test/browser/operator-login.test.js` | `CI` ×2 | Linux headless Chrome sandbox selection |
| `test/browser/question-card.test.js` | `CI` ×1, `GITHUB_SHA` ×1 | Linux headless Chrome sandbox selection; Evidence/source provenance; release test matches the run identifier |
| `test/browser/safeguards.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/start-journey.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/start-look.test.js` | `CI` ×1, `GITHUB_EVENT_PATH` ×2 | Linux headless Chrome sandbox selection; evidence binds PR branch head from the GitHub event payload |
| `test/browser/start2-display-helpers.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/browser/tick-followups.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/visitor-credit-tiers-helpers.js` | `GITHUB_EVENT_PATH` ×2, `GITHUB_SHA` ×1 | Evidence labels bind merge-run SHA and PR branch head from the GitHub event payload |
| `test/browser/voice-presentation.test.js` | `CI` ×3, `GITHUB_EVENT_PATH` ×2 | Linux headless Chrome sandbox selection and PR-head evidence provenance |
| `test/ci-slot-sharing.test.js` | `process.env` ×1 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/fixtures/lane-race-ait197-proof.js` | `process.env` ×1 | AIT-201 legacy-lane red proof forwards the child environment after removing NODE_TEST_CONTEXT |
| `test/fixtures/lane-race-proof.js` | `process.env` ×1 | AIT-201 lane-race red proof forwards the child environment after removing NODE_TEST_CONTEXT |
| `test/fixtures/lane-race-validation.js` | `process.env` ×1 | AIT-201 lane-race validation forwards the child environment after removing NODE_TEST_CONTEXT |
| `test/fixtures/launch-browser.mjs` | `destructure { AIT_LAUNCH_RECORD: record, AIT_LAUNCH_HANGS: hangs, AIT_LAUNCH_ERROR: error }` ×1 | Pinned fake-CDP fixture controls; exact destructured keys and aliases required |
| `test/live/soak.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/measurements/browser-comparison.js` | `process.env` ×1 | Intentional browser measurement child-process environment forwarding; exact occurrence pinned |
| `test/release-prep.test.js` | `GITHUB_RUN_ID` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/release-workflow.test.js` | `process.env` ×1 | Hermetic release-workflow child-process setup; exact occurrence pinned |
| `test/soak/unit-worker.test.js` | `process.env[key]` ×2 | Intentional soak child-process forwarding of CI; containing key-list declaration and occurrence count pinned |
| `test/soak/uploads.test.js` | `process.env[key]` ×2 | Intentional soak child-process forwarding of CI; containing key-list declaration and occurrence count pinned |
| `test/test-browser-setup.test.js` | `process.env` ×1 | Isolated browser-path installer child process; exact occurrence pinned |
| `test/unit-timeout.test.js` | `process.env` ×1 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
