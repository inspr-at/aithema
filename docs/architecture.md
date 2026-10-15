# Architecture and enforced module boundaries

Aithema is an identity-free embeddable module: core owns domain state and contracts,
server owns Fetch handlers and persistence, UI owns presentation, and plugins own
provider adapters. Hosts supply identity, consent policy, copy, branding and binding
configuration through ports. This follows PPM AIT's approved
`guideline/aithema-vision-architecture` (AIT-141, 2026-10-12) and
`guideline/aithema-reset-concept` (AIT-95, decisions D2–D5).

## Allowed edges

The table below is rendered from `layers` in `scripts/check-boundaries.mjs`.
`test/module-boundaries.test.js` compares the rendered table with this document,
so changing policy requires updating both together.

| Layer | Sources | Allowed cross-module edges (public exports only) | Responsibility |
| --- | --- | --- | --- |
| core | `packages/core` | none | Headless domain, contracts and shared engine primitives |
| ui | `packages/ui` | core | Web components and browser presentation |
| server | `packages/server` | core, plugin | Fetch handlers, persistence and public adapter compatibility |
| plugin | `plugins/*` | core, ui, server, plugin | Exchangeable provider adapters |

Every cross-module edge in this table must resolve to an explicit `package.json`
`exports` target, including cross-plugin edges and server compatibility adapters.
No core → server/UI/plugin or UI → server/plugin edge is allowed. Server does not
import UI. Relative browser imports remain supported when they reach exactly an
exported file; they preserve native browser loading. Node consumers should prefer
package specifiers. A deep specifier such as `@inspr/aithema-core/src/session.js`
is private even when that file exists. Exporting a target does not override the
layer table. Conditional exports are inspected; no wildcard export is implicit.

Production code cannot import `test/`, `tests/`, `dev/`, or test/spec files.
`plugins/fake-voice` is test-only and may be imported only from those development
entry points. Tests/dev can inspect internals and integrate layers deliberately;
the literal-import rule still applies there. The zero-cost simulator's function
identity registry belongs to server; runtime code does not load the simulator.
The old local voice shim is now explicitly `packages/server/dev/local-voice.js`.
The release source archive includes this dev entry because the reference host uses it.

The composed-voice coordinator stays in server, exported as `/composed-voice`.
Its generic bounded stream, audio queue and component admission helpers now live
in core's `/voice-components`. The composed plugin consumes both public surfaces;
its former component entry re-exports core for compatibility. Replay/audio and
credit formatting helpers used by plugins are explicit UI exports. Image/HTML
adapter helpers and legacy ElevenLabs factories are explicit plugin exports.
These moves preserve implementation and runtime behavior.

## Enforcement and adding a module

`npm test` runs `test/module-boundaries.test.js` in the existing CI unit job.
The guard parses JavaScript and TypeScript with the existing TypeScript dependency;
it visits static and side-effect imports, dynamic imports, re-exports, require,
TypeScript import types and literal templates. Expressions, concatenations and
interpolated templates fail closed, even if their runtime value appears safe.
Comments and strings containing example imports are not dependencies. Syntax
errors and undeclared package layers fail closed. Only source extensions are
opened; env/config files and dependency trees are never read.

To add a module, choose its layer, provide a package manifest with explicit public
exports, and keep implementation-local imports within it. Add a new layer to the
single policy table only when the architecture requires it; update this rendered
table and add a negative fixture for the new forbidden edge. Export shared building
blocks from their owning layer instead of reaching into another module's source.
Run the boundary tests on the designated test worker and let PR CI run the suite.

Scope is `packages/*` and `plugins/*`. AIT-205 (PR #173) separately guards `demo/`;
the policy table's AIT-205 hook is the integration point once that PR merges.
This change does not duplicate the demo import rule. The release packer's
public-export contract is enforced at source level; this base revision uses the
single archive packer and does not yet contain `release/lib/modules.mjs`.

## Deliberate ambient CI reads in tests

`scripts/ci-env-declarations.json` records each deliberate ambient CI read, its
occurrence count and reason. `scripts/check-ci-env.mjs` parses every test/helper
under packages, plugins, test and demo/test. New variables, new occurrences,
computed reads, process aliases, and whole-environment forwarding require an
explicit declaration; removed reads must remove stale declarations. The rendered
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
| `test/browser-matrix-coverage.test.js` | `process.env` ×2 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/browser/admin-pages.test.js` | `CI` ×3 | Linux headless Chrome sandbox selection; AIT-185/192 full evidence matrix disabled in CI |
| `test/browser/audio-replay.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/confirmation-design.test.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/browser/consent-lines.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/credit-hold.test.js` | `CI` ×3 | Linux headless Chrome sandbox selection; AIT-185/192 full evidence matrix disabled in CI |
| `test/browser/demo.test.js` | `CI` ×9 | Linux headless Chrome sandbox selection |
| `test/browser/footer-width-sweep.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/host-surface.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/html-preview.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/matrix-coverage.js` | `CI` ×1 | Linux headless Chrome sandbox selection; AIT-185/192 full evidence matrix disabled in CI |
| `test/browser/operator-login.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/orb-reveal.test.js` | `CI` ×4 | Linux headless Chrome sandbox selection |
| `test/browser/pause-phone.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/question-card.test.js` | `CI` ×1, `GITHUB_SHA` ×1 | Linux headless Chrome sandbox selection; Evidence/source provenance; release test matches the run identifier |
| `test/browser/safeguards.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/start-journey.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/start-look.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/start2-display-helpers.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/browser/tick-followups.test.js` | `CI` ×1 | Linux headless Chrome sandbox selection |
| `test/browser/visitor-credit-tiers-helpers.js` | `GITHUB_EVENT_PATH` ×2, `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/browser/voice-presentation.test.js` | `CI` ×2 | Linux headless Chrome sandbox selection |
| `test/ci-slot-sharing.test.js` | `process.env` ×1 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/live/soak.js` | `GITHUB_SHA` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/release-prep.test.js` | `GITHUB_RUN_ID` ×1 | Evidence/source provenance; release test matches the run identifier |
| `test/soak/unit-worker.test.js` | `process.env[key]` ×2 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/soak/uploads.test.js` | `process.env[key]` ×2 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
| `test/unit-timeout.test.js` | `process.env` ×1 | Intentional child-process environment forwarding or hermetic fixture setup; pinned expression/count |
