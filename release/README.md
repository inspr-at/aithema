# Candidate operation and GitHub release route

The sole version authority is `release/version.json`; package manifests and the
lockfile mirror its exact coordinate. An owner-authorized candidate reservation
does not authorize a tag or publication. All commands below run on mbp2606 or CI,
never on mbp2607. Commit first: the packer reads committed Git blobs only and
excludes env files without opening them. The remote lane transfers `git archive`;
its tracked `export-subst` marker carries the original commit and epoch, and
archive packing is checked against Git packing byte for byte. Only use archives
from the trusted Git transport; the marker is source metadata, not a signature.

```sh
npm run release:candidate -- /retained/ait356
# Equivalent pack/verify entrypoints (use new output directories):
npm run release:pack -- /retained/ait356/first --candidate SOURCE_COMMIT
npm run release:verify -- /retained/ait356/first
npm run release:consumer -- /retained/ait356/first
```

`release:candidate` packs twice through `release:pack`, verifies both through
`release:verify`, compares every archive and the manifest, then installs all
fifteen tarballs in a scratch directory outside the repo. It checks all guide
symbols and runtime exports, HTTP create/read/export and owner isolation, mounts
both web components in happy-dom, performs a lockfile reinstall, replaces a
legacy dependency declaration, and restores a damaged deployment from separately
retained candidate tarballs. No live provider or external host is contacted.
Runtime dependencies must be in npm's cache (the remote `npm ci` primes it).
Use the consumer script's explicit `--online` only on an authorized build runner
when the cache is unavailable. The legacy monolith cannot be upgraded in place;
see the notes for the API/storage migration limit.

Retain `first/`, `candidate-evidence.json`, `deployment-pin.json`,
`consumer-package-lock.json`, `first/consumer-deployment/`, and their manifest digest in durable owner storage.
The consumer deployment contains relative `file:artifacts/` pins, tarballs,
package/lock and the executable smoke script: run `npm ci` then `node smoke.mjs`
in that directory on the build runner. It contains no workspace links.
PR CI also retains a `reset-candidate` artifact for 90 days, with canonical GNU
archives and the same consumer proof; this is artifact storage, not registry or
forge publication.
Round 6 retains the remote evidence copy under ignored
`dist/ait105-r6-final/candidate/`. Its `candidate-evidence.json` and
`first/release-set.json` bind the exact final branch head. The committed
`release/evidence.json` records the preceding implementation checkpoint: evidence
cannot contain the SHA of the commit that contains itself. After that evidence
commit, run the candidate command again and retain the final-head evidence
without another evidence-only commit. Hand OPS that exact head and final manifest
digest together. The committed and final BSD candidates are preparation evidence,
not shipped bytes.
BSD and GNU tar encode different bytes. PR CI's Linux candidate is qualification
and retention evidence for that CI source commit, not a promise that a later tag
build has the same digests.

## Seventh October candidate (AIT-360 / START-550)

The reserved coordinate is `261019003029.0.0` (UTC reservation time), stable sequence
18, with status `reserved`. AEON-LEAD authorizes RC7 = START-550 first, cut right
after #307/#309 and before further Grok package merges; Grok voice ships later
in RC8. Tick passed AIT-353's UI at 2026-10-19 02:05 Europe/Vienna. This follows
the AIT-356 route: candidate, coordinator release gate, then **one Desk question
for Markus**. The builder prepares only and invokes no review gates. OPS
publishes only on Markus's separate Desk go. This reservation and PR authorize
no tag, tag push, GitHub release or publication. The marketing name remains
**Aithema 2026.10**, with the exact coordinate below the notes title.
The sixth October release `v261018162546.0.0` (sequence 17, AIT-356), published
by OPS on 2026-10-18, is recorded in `history.json` at source
`5a2ae05862a3dd5dfe66d9a4273f9fd7a623e3d9`.

Both prerequisites are on main at base
`4b44d61dd5e0015a0a3dffe573367e03f83583a9`: #307 (AIT-353) and #309
(AIT-354). The full first-parent range since `v261018162546.0.0` contains #301
(AIT-344), #303 (AIT-352), #305 (AIT-355), #304 (AIT-345), #306 (AIT-357),
#308 (AIT-346), #311 (AIT-359), #307 and #309. It also contains #302, the merge
of the already published AIT-356 preparation head. No Grok PR beyond
AIT-344/345/346 is included. Their source-only provider groundwork remains
unselectable and outside the release package closure.

The notes lead with strict-host HTML drafts and plain failure messages, then
steady footer credits. Host notes include exact page CSP and preview headers,
owner-minted single-use capabilities, re-minting, HEAD 405, full-registry 503 with
Retry-After, restart/instance affinity, the Caddy handler, and the honest guarantee
**no network; a self-reload is refused**. They also name the supported coordinator
export and the composed relay move with retained shims. **Breaking for hosts**
is included because existing srcdoc embedders must add the route and exact
frame-src and remove the legacy denying head meta before executable previews
work. `next-notes.md` was already empty and stays at its empty stub.

The approved presentation source remains
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`; presentation pins and the AIT-32
migration anchor stay fixed. This continues `inspr-calver-3`. Preparation
candidates are digest-verified evidence; only the authorized tag workflow makes
and attests the shipped bytes. Keep both the implementation checkpoint and final
head evidence; retain the final directory in durable owner storage before OPS
publishes. CI's GNU tar bytes remain separate from mbp2606's BSD tar bytes.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main`; verify #307 and #309 are present. Never merge further
   Grok package work into RC7; report an out-of-scope advance to the coordinator
   instead of extending this cut. Commit the reservation,
   manifest/lock mirrors, history, notes and runbook with `--signoff` before
   any remote run. Reset `next-notes.md` to its empty stub.
2. From this worktree on mbp2607, invoke the remote lane below. The candidate
   test runs `npm run release:candidate -- <retained dir>` on mbp2606: two packs,
   verification, isolated consumer smoke, locked reinstall, update and rollback.
   The CalVer tests run `release/gate.mjs tag` against the reserved coordinate
   without creating a tag. On WAIT, wait and retry per remote policy; on
   LOCAL-FALLBACK, stop with tests pending. Never run the candidate on mbp2607.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait360-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js
   ```

3. Commit `dist/ait360-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat that command on the final committed head with
   `EVIDENCE_OUT="$PWD/dist/ait360-final"`. Retain the complete
   `dist/ait360-final/candidate/` without another evidence-only commit. Its
   `candidate-evidence.json` and `first/release-set.json` must bind the handed-over
   head. Hand OPS that head and final manifest SHA-256 together.
5. Push only `release/ait-360-seventh-release`, open the PR to main and wait for
   green PR CI: seven browser shards, all four required browser aliases, units,
   preview-security and DCO. CI retains `reset-candidate` for 90 days. The
   coordinator runs review gates after builder handoff; copy the complete final directory to durable
   owner storage before OPS uses the publish route below.

## Sixth October candidate (AIT-356 / START-550)

The reserved coordinate is `261018162546.0.0` (UTC reservation time), stable sequence
17, with status `reserved`. AEON-LEAD, 2026-10-18 ~18:15 Europe/Vienna,
option (b), authorizes cutting now for the merged value and to exercise the
publish route, following AIT-325: candidate, coordinator release gate, then
**one Desk question for Markus**. The builder prepares only and invokes no
review gates. OPS publishes only on Markus's separate Desk go. This reservation
and PR authorize no tag, tag push, GitHub release or publication. START pins this
candidate only in its START-550 branch to test the timeout fix early, never on
start3. The marketing name remains **Aithema 2026.10**, with the exact coordinate
below the notes title. The fifth October release, `v261018142833.0.0` (sequence
16, AIT-325), published by OPS on 2026-10-18, is recorded in `history.json` at
source `7edaf634f4e4afb47dab5faebb127113344cf375`. The AIT-32 migration anchor
and published bytes stay fixed.

Both prerequisites are on main at base `acb8f9a17548a3f75a68ac63cb685659f2851789`:
#298 (AIT-328) and #300 (AIT-343, branch/commit labels AIT-341). The full
first-parent range since `v261018142833.0.0` contains #294 (AIT-323), #296
(AIT-326), #297 (AIT-327), #299 (AIT-340), #298 (AIT-328) and #300 (AIT-343).
It also contains #295, the merge of the already published AIT-325 preparation
head; there are no additional feature merges at this base.

The notes lead with HTML timeout holds protecting the cap, then the full-width
consent save note and second-provider voice groundwork. Host notes cover
408/499 and usage-without-cost holds, the image generation header with its
inferred-presence caveat, component declarations and the composition preflight
API with its stable error codes. **Breaking for hosts** is included because
AIT-340 changes runtime budget availability: a 408/499 that previously released
its reservation now retains it without a receipt, so a subsequent draft may be
refused. The API signature stays the same. AIT-323 and AIT-328 concern opt-in
source-only helper paths, not a newly qualified second live pipeline. Strict-host
preview coverage is tests only. `next-notes.md` remains its empty stub.

The approved shared presentation source remains
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`. `presentation.json`, the complete
offline bundle and approved Aithema overrides retain their pins. Candidate
packing verifies their closure and the version-presentation tests cover the
active adapter. This continues `inspr-calver-3`, rather than starting a migration.
The preparation candidate is digest-verified; GitHub attestations of the exact
published bytes are produced only by the authorized tag workflow below.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main`; if it advances, `git merge --signoff origin/main` and
   report the merge and any additional scope. Commit the reservation,
   manifest/lock mirrors, history, notes and runbook with `--signoff` before
   any remote run. Reset `next-notes.md` to its empty stub.
2. From this worktree on mbp2607, invoke the remote lane below. The candidate
   test runs `npm run release:candidate -- <retained dir>` on mbp2606: two packs,
   verification, isolated consumer smoke, locked reinstall, update and rollback.
   The CalVer tests run `release/gate.mjs tag` against the reserved coordinate
   without creating a tag. On WAIT, wait and retry per remote policy; on
   LOCAL-FALLBACK, stop with tests pending. Never run the candidate on mbp2607.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait356-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js
   ```

3. Commit `dist/ait356-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat that command on the final committed head with
   `EVIDENCE_OUT="$PWD/dist/ait356-final"`. Retain the complete
   `dist/ait356-final/candidate/` without another evidence-only commit. Its
   `candidate-evidence.json` and `first/release-set.json` must bind the handed-over
   head. Hand OPS that head and final manifest SHA-256 together.
5. Push only `release/ait-356-sixth-release`, open the PR to main and wait for
   green PR CI: seven browser shards, all four required browser aliases, units
   and DCO. CI retains `reset-candidate` for 90 days. The coordinator runs review
   gates after builder handoff; copy the complete final directory to durable
   owner storage before OPS uses the publish route below.

## Fifth October candidate (AIT-325 / START)

The reserved coordinate is `261018142833.0.0` (UTC reservation time), stable sequence
16, with status `reserved`. AEON-LEAD, 2026-10-18 ~15:45 Europe/Vienna,
authorizes the fifth candidate once AIT-321 and AIT-322 are merged, following
the AIT-315 route: candidate, coordinator release gate, then **one Desk question
for Markus**. The builder prepares only; the coordinator owns review gates.
OPS publishes only on Markus's separate Desk go. This reservation and PR
authorize no tag, tag push, GitHub release or publication. The marketing name
remains **Aithema 2026.10**, with the exact coordinate below the notes title.
The fourth October release, `v261018104037.0.0` (sequence 15, AIT-315), is
recorded in `history.json` at published source
`34f78c4174412a0e6766461dc2f4a7411deea6c7`. The AIT-32 migration anchor and
published bytes stay fixed.

All nine post-release changes are merged at base `87d4c000`: #284 (AIT-304),
#286 (AIT-314), #287 (AIT-318), #288 (AIT-316), #289 (AIT-320), #293 (AIT-324),
#292 (AIT-322), #291 (AIT-319) and #290 (AIT-321). The first-parent range from
`v261018104037.0.0` also includes #285, the merge of AIT-315's already published
preparation head; there are no additional feature merges at this base.
The notes lead with withdrawn consent staying withdrawn, deeper Claude Opus
HTML drafts within the cap, and demo legal labels that fit on phones.
The accumulated host lines from `next-notes.md` are incorporated into the notes;
`next-notes.md` is reset to its empty stub.

Host notes describe the consent revision protocol and deprecated unversioned
decisions, Claude HTML effort and full token reservations, the supported
STT/TTS component API and conformance kits, and visitor-tier integration and
erasure duties. The explicit AIT-316 typing note warns that `capabilities`,
`attempt.maxMicro` and uncertain `chargedMicro` are now required through the
public `plugin-contract` types. Old implementations stop compiling until
updated. There is no new runtime requirement on existing host integrations:
unversioned consent decisions remain accepted, installed voice is unchanged,
and the visitor-tier reference is host-owned. Therefore the notes use a typing
note and do not add a **Breaking for hosts** section.

The approved shared presentation source remains
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`. `presentation.json`, the complete
offline bundle and approved Aithema overrides retain their pins. Candidate
packing verifies their closure and the version-presentation tests cover the
active adapter. This continues `inspr-calver-3`, rather than starting a migration.
The preparation candidate is digest-verified; GitHub attestations of the exact
published bytes are produced only by the authorized tag workflow below.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main`; if it advances, `git merge --signoff origin/main` and
   report the merge and any additional scope. Commit the reservation,
   manifest/lock mirrors, history, notes and runbook with `--signoff` before
   any remote run. Reset `next-notes.md` to its empty stub.
2. From this worktree on mbp2607, invoke the remote lane below. The candidate
   test runs `npm run release:candidate -- <retained dir>` on mbp2606: two packs,
   verification, isolated consumer smoke, locked reinstall, update and rollback.
   The CalVer tests run `release/gate.mjs tag` against the reserved coordinate
   without creating a tag. On WAIT, wait and retry per remote policy; on
   LOCAL-FALLBACK, stop with tests pending. Never run the candidate on mbp2607.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait325-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js
   ```

3. Commit `dist/ait325-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat that command on the final committed head with
   `EVIDENCE_OUT="$PWD/dist/ait325-final"`. Retain the complete
   `dist/ait325-final/candidate/` without another evidence-only commit. Its
   `candidate-evidence.json` and `first/release-set.json` must bind the handed-over
   head. Hand OPS that head and final manifest SHA-256 together.
5. Push only `release/ait-325-fifth-release`, open the PR to main and wait for
   green PR CI: seven browser shards, all four required browser aliases, units
   and DCO. CI retains `reset-candidate` for 90 days. The coordinator runs review
   gates after builder handoff; copy the complete final directory to durable
   owner storage before OPS uses the publish route below.

## Fourth October candidate (AIT-315 / START-549)

The reserved coordinate is `261018104037.0.0` (UTC reservation time), stable sequence
15, with status `reserved`. AEON-LEAD, 2026-10-18 ~12:35 Europe/Vienna,
authorizes preparation after AIT-308: build, verification and release notes in
plain words, with **concept images through the spending cap** as START-549's
unblocker. Preparation authorizes no tag, tag push, GitHub release or publication.
The coordinator owns the review gates; OPS publishes only on Markus's separate
Desk go. The marketing name remains **Aithema 2026.10**; notes print the exact
coordinate below it. The third October release, `v261017195050.0.0` (sequence 14,
AIT-303), is recorded in `history.json` at published source
`ad932884325ebb5696ec72202408aea6f4018735`. The AIT-32 migration anchor and
published bytes stay fixed.

All ten changes are merged at base `ee435d8f`: #276 (AIT-306), #274 (AIT-302),
#279 (AIT-311), #277 (AIT-307), #278 (AIT-309), #281 (AIT-312), #283 (AIT-313),
#280 (AIT-310), #275 (AIT-301) and #282 (AIT-308). No other change is a release
prerequisite; AIT-304 demo legal labels are outside this release's scope.
The notes lead with shared image reservations and provider-reported gateway
charges, then phone voice status, budget versus credits, one-mode readiness and
legal-host footer fit. The optional `spendCap` works in gateway and direct modes;
direct charges use admitted `imageCost` or the ceiling. README cap bookkeeping
and reasoning-only routing scope are documented in the host notes; no new
breaking host change was found in the README or `docs/embedding.md`.

The approved shared presentation source remains
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`. `presentation.json`, the complete
offline bundle and approved Aithema overrides retain their pins. Candidate
packing verifies their closure and the version-presentation tests cover the
active adapter. This continues `inspr-calver-3`, rather than starting a migration.
The preparation candidate is digest-verified; GitHub attestations of the exact
published bytes are produced only by the authorized tag workflow below.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main`; if it advances, `git merge --signoff origin/main` and
   report the merge, including any arrival of out-of-scope AIT-304. Commit the
   reservation, manifest/lock mirrors, history, notes and runbook with `--signoff`
   before any remote run. Reset `next-notes.md` to its empty stub.
2. From this worktree on mbp2607, invoke the remote lane below. The candidate
   test runs `npm run release:candidate -- <retained dir>` on mbp2606: two packs,
   verification, isolated consumer smoke, locked reinstall, update and rollback.
   The CalVer tests run `release/gate.mjs tag` against the reserved coordinate
   without creating a tag. On WAIT, wait and retry per remote policy; on
   LOCAL-FALLBACK, stop with tests pending. Never run the candidate on mbp2607.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait315-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js
   ```

3. Commit `dist/ait315-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat that command on the final committed head with
   `EVIDENCE_OUT="$PWD/dist/ait315-final"`. Retain the complete
   `dist/ait315-final/candidate/` without another evidence-only commit. Its
   `candidate-evidence.json` and `first/release-set.json` must bind the handed-over
   head. Hand OPS that head and final manifest SHA-256 together.
5. Push only `release/ait-315-fourth-release`, open the PR to main and wait for
   green PR CI: seven browser shards, all four required browser aliases, units
   and DCO. CI retains `reset-candidate` for 90 days. The coordinator runs review
   gates after builder handoff; copy the complete final directory to durable
   owner storage before OPS uses the publish route below.

## Third October candidate (AIT-303 / START-548/549)

The reserved coordinate is `261017195050.0.0` (UTC reservation time), stable sequence
14, with status `reserved`. AEON-LEAD, 2026-10-17 21:45 Europe/Vienna, relaying
Markus, authorizes preparation tonight, checks and Tick's release QA. OPS
publishes only after Tick QA and Markus's separate Desk go. This reservation
and PR authorize no tag, tag push, GitHub release or publication. The marketing
name remains **Aithema 2026.10**; notes print the exact coordinate below it.
The second October release, `v261017133413.0.0` (sequence 13, AIT-278), is now
recorded in `history.json` at its published source commit. The AIT-32 migration
anchor and published bytes stay fixed.

All eight post-release PRs are merged at base `45cd6995`: #264 (AIT-292),
#267 (AIT-295), #266 (AIT-293), #269 (AIT-298), #268 (AIT-296), #272 (AIT-300),
#270 (AIT-297) and #271 (AIT-299). No other PR is a preparation prerequisite.
The approved shared presentation source is still
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`; upstream `main` was identical at
preparation. `presentation.json`, the complete offline bundle and approved
Aithema overrides retain their pins. Candidate packing verifies their closure;
the version-presentation tests cover the active UI adapter. This continues
`inspr-calver-3` adoption, rather than starting another migration.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main`; if it advances, `git merge --signoff origin/main` and
   report the merge. Commit the reservation, manifest/lock mirrors, history,
   notes and this runbook with `--signoff` before any remote run.
2. On mbp2607 invoke the assigned `remote-browser.sh` with
   `EVIDENCE_OUT="$PWD/dist/ait303-checkpoint"` and arguments
   `"$PWD" unit --test-concurrency=2 test/release-candidate.test.js test/release-workflow.test.js test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js`.
   The candidate test runs `npm run release:candidate -- <retained dir>` on
   mbp2606: two packs, verification, isolated consumer smoke, locked reinstall,
   update and rollback. The CalVer tests run `release/gate.mjs tag` against the
   exact reserved coordinate without creating a tag. Retain the copied evidence.
   On WAIT, wait and retry per the remote browser policy; on LOCAL-FALLBACK,
   stop with tests pending. Never run the candidate on mbp2607.
3. Commit `dist/ait303-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat the same remote test command on the final committed head with
   `EVIDENCE_OUT="$PWD/dist/ait303-final"`. Retain the complete
   `dist/ait303-final/candidate/` without another evidence-only commit. Its
   `candidate-evidence.json` and `first/release-set.json` must both bind the
   handed-over head. Hand OPS that head and final manifest SHA-256 together.
5. Push only `release/ait-303-third-release`, open the PR to main and wait for
   green PR CI, including the retained `reset-candidate` artifact. The coordinator
   runs review gates; Tick owns release QA. Copy the complete final directory
   to durable owner storage before OPS uses the publish route below.

## Second October candidate (AIT-278 / START-545)

The round-4 reserved coordinate is `261017133413.0.0`, stable sequence 13. Markus's
Desk `74ae723c` (2026-10-17) authorizes preparation; OPS publishes only after
Tick's consolidated QA under Markus's Desk go. The marketing name remains
**Aithema 2026.10** (LEAD, 2026-10-17); the exact coordinate is printed below the
notes title. The first October release, `v261015164601.0.0` (sequence 12), is
recorded in `history.json`. Its migration anchor and published bytes stay fixed.
The approved shared presentation source is still
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`; `presentation.json` and the complete
offline bundle retain their existing pins and Aithema overrides.

Round 4 replaces the unpublished round-3 reservation `261017100846.0.0`: the
`reserveVersion` rule in `packages/server/src/release-version.js` requires a new
source reservation for changed outputs. The published history still ends at
sequence 12, so this candidate retains sequence 13 and the existing migration
anchor. The tag gate in `release/gate.mjs` requires the exact reserved coordinate;
the round-6 final-head evidence step below does not reserve again.

Run a candidate only after PR #265 (AIT-294), following merged PRs #263
(AIT-291) and #262 (AIT-290), reports `MERGED`, and after
`git merge --signoff origin/main` and committing the work.
On mbp2607, use the assigned `remote-browser.sh` with
`EVIDENCE_OUT="$PWD/dist/ait278-r4-checkpoint"` and arguments
`"$PWD" unit --test-concurrency=2 test/release-candidate.test.js test/release-workflow.test.js test/calver.test.js test/version-presentation.test.js`.
The candidate test runs `npm run release:candidate -- <retained dir>` on
mbp2606; the script copies the complete retained directory back. Commit that
run's `candidate/candidate-evidence.json` as `release/evidence.json`. Then repeat
the candidate test on the final committed head with
`EVIDENCE_OUT="$PWD/dist/ait278-r4-final"`, retaining
`dist/ait278-r4-final/candidate/` without another evidence-only commit. Its manifest
and evidence must both bind the handed-over head. Retain the complete directory
in owner storage; the PR's Linux artifacts remain separate qualification bytes.

## OPS publish route after Markus's Desk go

OPS owns the exact-SHA rehearsal, clean-clone `v*` tag push, release run,
attestation verification and publication after Markus's separate Desk go.
The builder only prepares the candidate, notes and reservation through the PR.
The route is **public GitHub release tarballs**, SHA256SUMS and GitHub artifact
attestations, using only the workflow's `GITHUB_TOKEN`. No npm registry account,
npm publication, GitHub Packages registry or consumer token is required.

After Tick's consolidated QA and Markus's Desk go, OPS runs the following on
mbp2606 or an authorized build runner. Set `FINAL_CANDIDATE` to the retained
AIT-360 final directory above, and enable repository immutable releases before
the tag push. These commands are a handoff, not builder authorization to run them.

```sh
set -eu
export FINAL_CANDIDATE=/absolute/owner-storage/ait360-final/candidate
RELEASE_HEAD=$(node -p 'require(process.env.FINAL_CANDIDATE + "/first/release-set.json").source.commit')
RELEASE_VERSION=$(node -p 'require(process.env.FINAL_CANDIDATE + "/first/release-set.json").version')
RELEASE_TAG="v$RELEASE_VERSION"
OPS_WORK=$(mktemp -d)
git clone https://github.com/inspr-at/aithema.git "$OPS_WORK/source"
cd "$OPS_WORK/source"
git checkout --detach "$RELEASE_HEAD"
git merge-base --is-ancestor "$RELEASE_HEAD" origin/main
node release/gate.mjs tag "refs/tags/$RELEASE_TAG"
npm ci --ignore-scripts --no-audit --no-fund
npm run release:candidate -- "$OPS_WORK/ait360-rehearsal"
git tag "$RELEASE_TAG" "$RELEASE_HEAD"
git push origin "refs/tags/$RELEASE_TAG"
# Once the tag-triggered release run appears:
gh run list --repo inspr-at/aithema --workflow release.yml --commit "$RELEASE_HEAD"
RELEASE_RUN_ID=$(gh run list --repo inspr-at/aithema --workflow release.yml --commit "$RELEASE_HEAD" --json databaseId --jq '.[0].databaseId')
gh run watch "$RELEASE_RUN_ID" --repo inspr-at/aithema --exit-status
gh release view "$RELEASE_TAG" --repo inspr-at/aithema --json isImmutable,url
mkdir "$OPS_WORK/published"
cd "$OPS_WORK/published"
gh release download "$RELEASE_TAG" --repo inspr-at/aithema
for asset in SHA256SUMS release-set.json consumer-evidence.json \
  consumer-package-lock.json deployment-pin.json *.tgz; do
  gh attestation verify "$asset" --repo inspr-at/aithema
done
# GNU/Linux; on macOS use: shasum -a 256 --check SHA256SUMS
sha256sum --check SHA256SUMS
```

The tag push starts the existing release workflow, which creates and publishes
the release. OPS does not run a second manual `gh release create` command.
Retain the verified published set, its manifest digest and the portable consumer
deployment from the release run in durable owner storage for START's re-pin.

Before pushing the authorized tag, OPS must enable **immutable releases** in the
repository settings. It was disabled at the round-2 read-only check. This is an
owner setting, not a permission added to the release job. GitHub CLI stages the
assets in a draft and publishes the completed set; the workflow then requires
`isImmutable` to be true. A failed run must be investigated, never fixed by
replacing published assets or reusing the coordinate for changed bytes.

The **tag build is the single source of shipped bytes**. Only a pushed `v*` tag
can enter `.github/workflows/release.yml`; there is no manual publication path.
The tag must exactly match the reservation and its commit must belong to main.
On Ubuntu with Node 24 and GNU tar, the job:

1. Caches the source lock's dependencies with `npm ci`, packs once into
   `dist/release`, and verifies every archive against `release-set.json`.
2. Runs `release/consumer.mjs dist/release` against those exact archives before
   attestation or release creation. The scratch install, locked reinstall,
   dependency replacement and exact rollback must all pass.
3. Generates SHA256SUMS from the manifest's artifact digest table, rechecks the
   actual archive hashes and exact archive set, and rejects consumer evidence
   whose source, manifest digest or package digest table differs. It also hashes
   the manifest, consumer evidence, portable lock and deployment pin.
4. Attests every tarball, SHA256SUMS, manifest and the three evidence files with
   the SHA-pinned `actions/attest-build-provenance`. Only this job has
   `contents: write`, `id-token: write` and `attestations: write`.
5. Uses `gh release create --verify-tag --notes-file release/notes.md` to attach
   those same files without repacking, then verifies the release is immutable.
   The complete portable consumer deployment is also retained for 90 days.

The signed SHA256SUMS and manifest therefore name the files tested in that same
Linux tag run and attached to the release. `consumer-evidence.json` binds the
manifest SHA-256, source commit and all fifteen package digests;
`consumer-package-lock.json` records sha512 integrity for those tarball bytes.
No earlier BSD or PR candidate digest is presented as the shipped digest.

Download all release assets into a clean directory on the build runner. Verify
`gh attestation verify SHA256SUMS --repo inspr-at/aithema` and the manifest,
evidence and every tarball with the same command, then run
`sha256sum --check SHA256SUMS`. Retain this exact set and its manifest digest in
durable owner storage. Consumers install the fifteen module tarballs by release
URL in one invocation (one URL per module), for example:

```sh
npm install --save-exact https://github.com/inspr-at/aithema/releases/download/<tag>/<pkg>.tgz
```

Here `<tag>` is `v` followed by the reserved version, and `<pkg>` is a module
archive filename without the `.tgz` suffix from `release-set.json`. Pass all
fifteen URLs together so their mutual dependencies resolve without a registry
publication. Commit the host's lockfile: its URL resolutions and sha512 integrity
pin the downloaded bytes. Use `npm ci` for subsequent installations; retain the
verified archives and deployment pin for an exact-artifact rollback. The
workspace archive is retained source, not an installable root package.

References: [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
[GitHub CLI release creation and immutability](https://cli.github.com/manual/gh_release_create),
[repository immutability setting](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository).
