# Candidate operation and GitHub release route

The sole version authority is `release/version.json`; package manifests and the
lockfile mirror its exact coordinate. An owner-authorized candidate reservation
does not authorize a tag or publication. Candidate and consumer commands below
run on mbp2606 or CI; §6 documents the bounded OPS pack/verify rehearsal exception
on mbp2607. Commit first: the packer reads committed Git blobs only and
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
sixteen tarballs in a scratch directory outside the repo. It checks all guide
symbols and runtime exports, HTTP create/read/export and owner isolation, mounts
both web components in happy-dom, runs a joined offline Grok PCM/STT/admitted
reasoning/TTS fixture with durable child claims and its installed capture worklet,
performs a lockfile reinstall, replaces a
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
and retention evidence for that CI source commit. A tag build from the same C
must have the same normalized member digest; exact archive hashes remain specific
to the candidate or published set.

## Thirteenth October candidate (AIT-415 / START-524)

The reserved coordinate is `261020161837.0.0` (UTC reservation time), stable sequence
24, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Authority is Markus's standing release go, Desk
**4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19, and LEAD's quick-release
decision, 2026-10-20 17:4x. The coordinator holds `release-lock/seq-24`, pushed at
base `48e9ec80f3e4cbf457cdc8c6618ee44b5fe0f251` before preparation.

This quick bug release is the **fifth release on the active fixed-candidate
route (AIT-363 B)**. Order: lock tag (done), prep, coordinator gates, true merge
preserving C, candidate marker, OPS cut, verification. There is **no merge
freeze**: main keeps moving; the final committed RC head C is the candidate.
Builders prepare only and invoke no review gates, tags, tag pushes, GitHub
releases or publication. The coordinator owns release gates and merge; OPS owns
the cut. This preparation has no UI change.

AIT-414/#361 is on main at the lock. The complete first-parent range since
`v261020150723.0.0` contains #360 (RC12 preparation merge) and #361 (AIT-414).
AIT-407 is absent at the lock and is **not in RC13**; it moves to the next release
with AIT-410 and AIT-411. Voxtral stays private and outside the release closure.
The previous release `v261020150723.0.0`, sequence 23, AIT-413, published by OPS on
2026-10-20, is recorded in `history.json` at source
`67e31155e0fbb01f06db0e1e200904a832e5941e`.

Notes lead with email confirmation and access to the higher credit tier on hosts
that keep identity per conversation (AIT-414 / START-524). For hosts, identity
responses add `visitorEmail: { canSave }`; without a visitor-email port the UI
goes straight to the identity request. **Breaking for hosts relative to RC12:
none**, because the capability is additive. Host integration is required; this
release does not deploy START. Grok Voice is **not yet qualified in live use**;
“Aithema recommends” is preserved.

RC12 carry: the old used-up-panel and voice failure/retry bullets are outside
this quick release's change range, so neither the duplicate host sentence nor
the unlabelled visitor bullet is carried. The sole visitor bullet has a bold
lead and ticket keys. START integration requirements appear under “For hosts”.
The old blanket claim that every throwing wallet returns a server error is
removed from the current notes; AIT-407's uniform 500 behavior is not claimed.
`next-notes.md` contained only its empty stub and remains reset to it.
All manifests, lock entries and internal dependency pins mirror the reservation,
including private source-only workspaces. Migration and presentation pins stay
fixed. `release/evidence.json` remains historical checkpoint evidence; the
retained final-head evidence below is authoritative for this preparation.

Preparation order (all execution on mbp2606; no tests/builds on mbp2607):

1. Fetch `origin --tags`; stop if AIT-414/#361 is absent from main. Commit the
   reservation, all mirrors/pins, history, notes and this runbook with `--signoff`.
   Worktree: `/Users/markus/Code/aithema-worktrees/ait-415`; branch:
   `release/ait-415-thirteenth-release`; recorded builder: `AIT-415-b1`.
2. Run the remote lane on the **final committed C**. The candidate test invokes
   `npm run release:candidate -- <retained dir>`: two identical packs,
   verification, isolated consumer smoke from all sixteen shipped module
   tarballs, locked reinstall, dependency replacement and exact rollback.
   Release tests cover `release/gate.mjs` tag matching and synthetic candidate
   admission without creating any operational tag. WAIT means wait and retry
   (five minutes for OPS-300 policy refusal); LOCAL-FALLBACK means stop with tests
   pending, never run locally.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait415-final" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/release-candidate-gate.test.js test/release-publication.test.js \
     test/release-prep.test.js test/release-normalize.test.js \
     test/release-normalize-pack.test.js test/calver.test.js \
     test/calver-surgical.test.js test/version-presentation.test.js \
     test/consumer-isolation.test.js test/grok-release.test.js
   ```

3. Retain `/Users/markus/Code/aithema-worktrees/ait-415/dist/ait415-final/candidate/`,
   including `first/`, `candidate-evidence.json` and the isolated consumer
   deployment. Confirm `source_commit` equals C and that `manifest_sha256` and
   `normalized_digest` bind `first/`. Make **no evidence-only commit after this
   final build**. A subsequent source change requires a new final-head build.
4. Push only the assigned branch, open a PR to main and wait for green CI:
   seven browser shards, four browser aliases, test, preview-security and DCO.
   Hand the coordinator the PR, C, X, sequence 24 (previous: 23), retained absolute
   directory, manifest SHA-256 and normalized digest exactly as in the evidence.
   After gates and true merge, the coordinator records the candidate marker and
   hands it to OPS. Retain the directory in durable owner storage before
   publication; CI retains `reset-candidate` for 90 days.

## Twelfth October candidate (AIT-413 / START-524)

The reserved coordinate is `261020150723.0.0` (UTC reservation time), stable sequence
23, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Authority is Markus's standing release go, Desk
**4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19. The coordinator holds
`release-lock/seq-23`, pushed at base `ad1a16db` before preparation.

This is the **fourth release on the active fixed-candidate route (AIT-363 B)**.
RC11 is published, OPS's cut and the tag rulesets are live. The order is lock tag
(done), prep, coordinator gates, true merge preserving C, candidate marker, OPS
cut, verification. There is **no merge freeze**: main keeps moving, and the
final committed RC head C is the candidate. Builders prepare only, invoke no
review gates, and create no tags, tag pushes, GitHub releases or publication.
The coordinator owns the cross-family release gate and merge; OPS owns the cut
under the standing go. This preparation has no UI change.

Required AIT-404/#357, AIT-405/#354, AIT-409/#358 and AIT-406/#359 are all on main
at starting base `ad1a16db3be1b1e2e7b161662416f2190a9f91fa`, which is also the
lock's target. The complete first-parent range since `v261020105634.0.0` contains
#354 (AIT-405), #355 (RC11 preparation merge), #358 (AIT-409), #357 (AIT-404),
and #359 (AIT-406, tests only). AIT-410 and AIT-411 are outside this release.
Voxtral remains `private: true`, outside the sixteen-module release closure and
unavailable in this release. The previous release `v261020105634.0.0`, sequence
22, AIT-408, published by OPS on 2026-10-20 on the fixed-candidate route, is
recorded in `history.json` at source `9d5d0624212a3cf1bf6bc3b01634517f78999249`.

Notes lead with immediate “Listening” on takeback and paused-state restoration
on failure, a clean unsaved turn when a host wallet fails, then dated corrections
and exposures for exact host caps across midnight (START-524). Hosts read the
wallet inside the turn transaction before saving; a throwing wallet returns a
server error with no spend. Host notes specify both additive per-attempt reads,
their event shape and stable deduplication keys, correction posting-day attribution,
refund allocation and exposure accounting without double-counting settlement.
They require a host-owned copy of cap history before retirement purges core
records and explain that a custom `budget` object supplies its own equivalent
reads. Paused plus budget-denied shows the used-up panel. AIT-406 restores the
nightly evidence run without changing product behavior.
**Breaking for hosts relative to RC11: no new breaking change for documented
ports**. AIT-405 changes a throwing wallet from a stuck saved turn to an immediate
error; AIT-409 is additive. Daily-cap integration is host work and offline proof
does not establish a START deployment. RC11's production voice route requirements
continue with the local simulator/free canonical mock exemptions. Grok Voice is
**not yet qualified in live use**. Tick's wording is preserved: “Aithema recommends”;
failure messages next to the control they concern; Retry waits for the stated delay.
`next-notes.md` contained only its empty stub and stays reset to it.

Carried copy fixes: remove repeated retry/failure wording and visitor-facing
extension/settlement internals; use “license” and “formalization”; explain that
mail close discards a completed DNS result rather than aborting DNS; scope fast
voice requirements to production with both exemptions; scope daily-limit receipt
copy to session credits with `dailyCapReached: true`. The two AIT-409 retention
and custom-budget notes are applied in the notes, root README and embedding guide.
All manifests, lock entries and internal dependency pins mirror the reservation,
including private source-only workspaces. The AIT-32 migration anchor and
presentation pins stay fixed. BSD preparation archive hashes differ from CI's
GNU archive hashes; the normalized member digest binds the same C across the
candidate and tag builds.

Preparation order (all execution on mbp2606; no tests/builds on mbp2607):

1. Fetch `origin --tags`; stop if any required AIT-404, AIT-405, AIT-409 or AIT-406
   merge is missing from main. Commit the reservation, all mirrors/pins, history,
   notes and this runbook with `--signoff`. Worktree:
   `/Users/markus/Code/aithema-worktrees/ait-413`; branch:
   `release/ait-413-twelfth-release`; coordinator-recorded builder: `AIT-413-b1`.
2. Run the README remote lane below. The candidate test invokes
   `npm run release:candidate -- <retained dir>`: two identical packs, verification,
   isolated consumer smoke from all sixteen shipped module tarballs, locked
   reinstall, dependency replacement and exact rollback. Release tests cover
   `release/gate.mjs` tag matching and synthetic fixed-candidate admission without
   creating a release tag. WAIT means wait and retry (five minutes for OPS-300
   policy refusal); LOCAL-FALLBACK means stop with tests pending, never run locally.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait413-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/release-candidate-gate.test.js test/release-publication.test.js \
     test/release-prep.test.js test/release-normalize.test.js \
     test/release-normalize-pack.test.js test/calver.test.js \
     test/calver-surgical.test.js test/version-presentation.test.js \
     test/consumer-isolation.test.js test/grok-release.test.js
   ```

3. Commit the checkpoint's `candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff`. This binds the implementation
   checkpoint, not the final C that contains it.
4. Repeat the same remote command on the **final committed C** with
   `EVIDENCE_OUT="$PWD/dist/ait413-final"`. Retain the complete absolute directory
   `/Users/markus/Code/aithema-worktrees/ait-413/dist/ait413-final/candidate/`,
   including `first/release-set.json`, `candidate-evidence.json` and the isolated
   consumer deployment, without another evidence-only commit. Confirm the
   evidence source equals C and its manifest SHA-256 and normalized digest bind
   `first/`. Any subsequent source change requires a new final-head build.
5. Push only the assigned branch, open a PR to main and wait for green CI:
   seven browser shards, four browser aliases, test, preview-security and DCO.
   Hand the coordinator the PR, C, X, sequence 23 (previous release: sequence 22),
   retained absolute directory, manifest SHA-256 and normalized digest exactly as
   in the evidence. The coordinator copies those values into the immutable
   candidate marker after gates and true merge, then hands them to OPS; no OPS
   command is supplied by this builder. Retain the complete directory in durable
   owner storage before publication; CI also retains `reset-candidate` for 90 days.

## Eleventh October candidate (AIT-408 / START-524)

The reserved coordinate is `261020105634.0.0` (UTC reservation time), stable sequence
22, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Authority is Markus's standing release go, Desk
**4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19. The coordinator holds
`release-lock/seq-22`, pushed at base `05e13f3d` before preparation.

This is the **third release on the active fixed-candidate route (AIT-363 B)**:
RC10 is published, OPS's cut and the tag rulesets are live. The order is lock tag
(done), prep, coordinator gates, true merge preserving C, candidate marker, OPS
cut, verification. There is **no merge freeze**: main keeps moving, and the
final committed RC head C is the candidate. Builders prepare only, invoke no
review gates, and create no tags, tag pushes, GitHub releases or publication.
The coordinator owns the cross-family release gate and merge; OPS owns the cut
under the standing go. This preparation has no UI change.

Required AIT-383/#342, AIT-397/#347, AIT-395/#348, AIT-401/#350,
AIT-392/#345 and AIT-393/#346 are all on main at starting base
`05e13f3d56ef37e74d7a7cb33a25e3a88d5d9f8a`. The complete first-parent range since
`v261019195810.0.0` contains #343 (AIT-390), #346 (AIT-393), #344 (the RC10
preparation merge), #345 (AIT-392), #347 (AIT-397), #351 and #352 (AIT-402),
#349 (AIT-398), #350 (AIT-401), #353 (AIT-394), #348 (AIT-395) and #342
(AIT-383). AIT-390, AIT-402, AIT-398 and AIT-394 change tests only.
AIT-405/#354 is open and absent from this starting main; credit preflight before
save is for RC12. Voxtral remains `private: true`, outside the sixteen-module
release closure and unavailable in this release. The previous release
`v261019195810.0.0`, sequence 21, AIT-389, published by OPS on 2026-10-19
on the fixed-candidate route, is recorded in `history.json` at source
`f89bd43fe43fe4c8ff6f5c32bb5498497ef9f435`.

Notes lead with truthful microphone/previous-call/retry/connection waits for
ElevenLabs and Grok, the microphone-granted 30-second connection deadline, the
15-second real-silence notice and immediate End cancellation. Next come the fast
voice route on every host and conversation-specific credits and confirmation
offers, with durable extension/settlement times for daily caps across midnight.
Host notes cover `wallet(ownerToken, { sessionId })`,
`creditTiers(ownerToken, { sessionId })`, session-scoped receipts, the additive
voice-extension context `{ attemptId, sessionId, extraMicro, at }`, durable
extension history and `settled_at_ms`, and identity-free resume. Host cap policy
must consume the durable records; offline qualification does not establish a
START deployment. Mail close cancels pending sends.
**Breaking for custom voice hosts relative to RC10: yes**: every voice option
requires a qualified fast `reaction` binding with effort `none`, separate from
`understanding`, allowlisted plugin/endpoint, streaming support and current
matching account evidence. The OpenRouter demo configuration already required
`OPENROUTER_SPEECH_MODEL` in RC10. Invalid custom-host configuration now refuses
voice with an operator configuration error instead of only capping effort.
AIT-395/401's new second arguments and durable fields are additive; callbacks
that ignore the context remain compatible. Grok Voice remains **not yet qualified
in live use**. Tick's wording is preserved: “Aithema recommends”; failure messages
next to the control they concern; Retry waits for the stated delay.
`next-notes.md` contained only its empty stub and stays reset to it.

All manifests, lock entries and internal dependency pins mirror the reservation,
including private source-only workspaces. The AIT-32 migration anchor and
presentation pins stay fixed. BSD preparation archive hashes differ from CI's
GNU archive hashes; the normalized member digest binds the same C across the
candidate and tag builds.

Preparation order (all execution on mbp2606; no tests/builds on mbp2607):

1. Fetch `origin --tags`; stop if any required AIT-383, AIT-397, AIT-395, AIT-401,
   AIT-392 or AIT-393 merge is missing from main, or if AIT-405 is on starting main.
   Commit the reservation, all mirrors/pins, history, notes and this runbook with
   `--signoff`. Worktree: `/Users/markus/Code/aithema-worktrees/ait-408`; branch:
   `release/ait-408-eleventh-release`; coordinator-recorded builder: `AIT-408-b1`.
2. Run the README remote lane below. The candidate test invokes
   `npm run release:candidate -- <retained dir>`: two identical packs, verification,
   isolated consumer smoke from all sixteen shipped module tarballs, locked
   reinstall, dependency replacement and exact rollback. Release tests cover
   `release/gate.mjs` tag matching and synthetic fixed-candidate admission without
   creating a release tag. WAIT means wait and retry (five minutes for OPS-300
   policy refusal); LOCAL-FALLBACK means stop with tests pending, never run locally.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait408-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/release-candidate-gate.test.js test/release-publication.test.js \
     test/release-prep.test.js test/release-normalize.test.js \
     test/release-normalize-pack.test.js test/calver.test.js \
     test/calver-surgical.test.js test/version-presentation.test.js \
     test/consumer-isolation.test.js test/grok-release.test.js
   ```

3. Commit the checkpoint's `candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff`. This binds the implementation
   checkpoint, not the final C that contains it.
4. Repeat the same remote command on the **final committed C** with
   `EVIDENCE_OUT="$PWD/dist/ait408-final"`. Retain the complete absolute directory
   `/Users/markus/Code/aithema-worktrees/ait-408/dist/ait408-final/candidate/`,
   including `first/release-set.json`, `candidate-evidence.json` and the isolated
   consumer deployment, without another evidence-only commit. Confirm the
   evidence source equals C and its manifest SHA-256 and normalized digest bind
   `first/`. Any subsequent source change requires a new final-head build.
5. Push only the assigned branch, open a PR to main and wait for green CI:
   seven browser shards, four browser aliases, test, preview-security and DCO.
   Hand the coordinator the PR, C, X, sequence 22 (previous release: sequence 21),
   retained absolute directory, manifest SHA-256 and normalized digest exactly as
   in the evidence. The coordinator copies those values into the immutable
   candidate marker after gates and true merge, then hands them to OPS; no OPS
   command is supplied by this builder. Retain the complete directory in durable
   owner storage before publication; CI also retains `reset-candidate` for 90 days.

## Tenth October candidate (AIT-389 / START-523, START-550)

The reserved coordinate is `261019195810.0.0` (UTC reservation time), stable sequence
21, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Authority is Markus's standing release go, Desk
**4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19. The coordinator holds
`release-lock/seq-21`, created at base `f8f534c2` before preparation.

This is the **second release on the active fixed-candidate route (AIT-363 B)**:
RC9 is published, OPS's cut and the tag rulesets are live. The order is lock tag
(done), prep, coordinator gates, true merge preserving C, candidate marker, OPS
cut, verification. There is **no merge freeze**: main keeps moving, and the
final committed RC head C is the candidate. Builders prepare only, invoke no
review gates, and create no tags, tag pushes, GitHub releases or publication.
The coordinator owns the cross-family release gate and merge; OPS owns the cut
under the standing go. This preparation has no UI change.

Required AIT-379/#332, AIT-380/#333, AIT-381/#338 and #341,
AIT-378/#336, AIT-386/#337 and AIT-385/#339 are all on main at starting base
`f8f534c2337a1f7c4fea22ea4bcf0107e092254b`. The full first-parent range since
`v261019131804.0.0` contains #330 (the RC9 preparation merge), #331 (AIT-372,
tests only), #332, #336, #333, #334 (AIT-376), #337, #338, #339,
#335 (AIT-377, including AIT-383), #340 (AIT-382, tests only), and #341
(AIT-381 rounds 1–3 and AIT-388). Voxtral remains `private: true`, outside the
sixteen-module release closure and unavailable in this release. The previous
release `v261019131804.0.0`, sequence 20, AIT-373, published by OPS on
2026-10-19 on the fixed-candidate route, is recorded in `history.json` at source
`f6f9745fc9ac02d5c7410249705a5b2f1396db9b`.

Notes lead with the HTML-draft image-request privacy fix with visuals Off,
then faster, reliable ElevenLabs calls, consent loading/saving and withdrawal,
and the empty-tile/390-pixel withdrawal notice fix. Voice covers five-second
first validated audio or one short holding line, clean agent end, neutral
refusals, honest waits/charges and recovery, a single off-topic redirect,
continuation after spoken text, exact admitted provider requests, provider
Retry-After and confirmed interruptions. The silence watchdog remains gated
on provider signals. Host notes explain the qualified speech route required by
the OpenRouter demo host configuration, including start2
(`OPENROUTER_SPEECH_MODEL` or a qualified fast reaction binding with effort
`none`), the 6.5-second callback default, `agent_tool_response` and ensure repair,
the GET-only agent health check, and HTTP 429/Retry-After reaching the browser.
**Breaking for hosts using the OpenRouter demo host configuration, including
start2: yes for voice relative to RC9**: missing or invalid speech configuration
now refuses voice with an operator configuration error instead of using the
analysis model. Custom hosts are unchanged except that selecting voice caps the
reaction lane's effort at its configured value; a fast reaction binding with
effort `none` is recommended for voice. Everything else is backward compatible.
Grok Voice remains **not yet qualified
in live use**. Tick's wording is preserved: failure messages next to the control
they concern; Retry waits for the stated delay. `next-notes.md` contained only
its empty stub and stays reset to it.

All manifests, lock entries and internal dependency pins mirror the reservation,
including private source-only workspaces. The AIT-32 migration anchor and
presentation pins stay fixed. BSD preparation archive hashes are distinct from
CI's GNU archive hashes; the normalized member digest binds the same C across
the candidate and tag builds.

Preparation order (all execution on mbp2606; no tests/builds on mbp2607):

1. Fetch `origin --tags`; stop if any required AIT-379, AIT-380, AIT-381, AIT-378,
   AIT-386 or AIT-385 merge is missing from main. Commit the
   reservation, all mirrors/pins, history, notes and this runbook with `--signoff`.
   Worktree: `/Users/markus/Code/aithema-worktrees/ait-389`; branch:
   `release/ait-389-tenth-release`; coordinator-recorded builder: `AIT-389-b1`.
2. Run the README remote lane below. The candidate test invokes
   `npm run release:candidate -- <retained dir>`: two identical packs, verification,
   isolated consumer smoke from all sixteen shipped module tarballs, locked
   reinstall, dependency replacement and exact rollback. The release tests cover
   `release/gate.mjs` tag matching and synthetic fixed-candidate admission without
   creating any release tag. WAIT means wait and retry; LOCAL-FALLBACK means stop
   with tests pending, never run locally.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait389-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/release-candidate-gate.test.js test/release-publication.test.js \
     test/release-prep.test.js test/release-normalize.test.js \
     test/release-normalize-pack.test.js test/calver.test.js \
     test/calver-surgical.test.js test/version-presentation.test.js \
     test/consumer-isolation.test.js test/grok-release.test.js
   ```

3. Commit the checkpoint's `candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff`. This binds the implementation
   checkpoint, not the final C that contains it.
4. Repeat the same remote command on the **final committed C** with
   `EVIDENCE_OUT="$PWD/dist/ait389-final"`. Retain the complete absolute directory
   `/Users/markus/Code/aithema-worktrees/ait-389/dist/ait389-final/candidate/`,
   including `first/release-set.json`, `candidate-evidence.json` and the isolated
   consumer deployment, without another evidence-only commit. Confirm the
   evidence source equals C and its manifest SHA-256 and normalized digest bind
   `first/`. Any subsequent source change requires a new final-head build.
5. Push only the assigned branch, open a PR to main and wait for green CI:
   seven browser shards, four browser aliases, test, preview-security and DCO.
   Hand the coordinator the PR, C, X, sequence 21 (previous release: sequence 20),
   retained absolute directory,
   manifest SHA-256 and normalized digest exactly as in the evidence. The
   coordinator copies those values into the immutable candidate marker after
   gates and true merge, then hands them to OPS; no OPS command is supplied by
   this builder. Retain the complete directory in durable owner storage before
   publication; CI also retains `reset-candidate` for 90 days.

## Ninth October candidate (AIT-373 / START-550 #2)

The reserved coordinate is `261019131804.0.0` (UTC reservation time), stable sequence
20, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Authority is Markus's standing release go, Desk
**4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19. The coordinator holds
`release-lock/seq-20`, created at base `1159f6cb` before preparation.

This is the **first release on the active fixed-candidate route (AIT-363 B)**:
RC8 is published, OPS's cut and the tag rulesets are live. The order is lock tag
(done), prep, coordinator gates, true merge preserving C, candidate marker, OPS
cut, verification. There is **no merge freeze**: main keeps moving, and the
final committed RC head C is the candidate. Builders prepare only, invoke no
review gates, and create no tags, tag pushes, GitHub releases or publication.
The coordinator owns the cross-family release gate and merge; OPS owns the cut
under the standing go. This preparation has no UI change.

Required #325 (AIT-369, START-550 must-fix #2) is on main at starting base
`1159f6cb79a2e32483d76ae838ed83f608ba08df`. The full first-parent range since
`v261019093518.0.0` contains #323 (the RC8 preparation merge), #322 (AIT-367),
#321 (AIT-361), #326 (AIT-329), #319 (AIT-363 B), #324 (AIT-365), #320 (AIT-362),
#327 (AIT-331), #328 (AIT-370) and #325 (AIT-369). Settings polish and the real
candidate-host evidence fix are therefore included. Voxtral groundwork remains
`private: true`, outside the sixteen-module release closure and unavailable in
this release. The previous release `v261019093518.0.0`, sequence 19, AIT-366,
published by OPS on 2026-10-19, is recorded in `history.json` at source
`4309c3d162cdf5137e24fba05105708017b4706e`.

Notes lead with delivered-kind consent coverage independent of visuals, then
instant scoped withdrawal with privacy first when the change is unknown,
clearer ElevenLabs/Grok voice failures and Settings polish. Host notes explain
the optional `consent.revised` `changed` and `removed` scopes, absent-field
refresh, and admission through the fixed candidate marker. **Breaking for hosts:
none relative to RC8**: the event fields are backward compatible and these UI
fixes need no new host API. Grok Voice is still **not yet qualified in live use**.
`next-notes.md` contained only its empty stub and stays reset to it.

All manifests, lock entries and internal dependency pins mirror the reservation,
including private source-only workspaces. The AIT-32 migration anchor and
presentation pins stay fixed. BSD preparation archive hashes are distinct from
CI's GNU archive hashes; the normalized member digest binds the same C across
the candidate and tag builds.

Preparation order (all execution on mbp2606; no tests/builds on mbp2607):

1. Fetch `origin --tags`; stop if AIT-369/#325 is missing from main. Commit the
   reservation, all mirrors/pins, history, notes and this runbook with `--signoff`.
   Worktree: `/Users/markus/Code/aithema-worktrees/ait-373`; branch:
   `release/ait-373-ninth-release`; coordinator-recorded builder: `AIT-373-b1`.
2. Run the README remote lane below. The candidate test invokes
   `npm run release:candidate -- <retained dir>`: two identical packs, verification,
   isolated consumer smoke from all sixteen shipped module tarballs, locked
   reinstall, dependency replacement and exact rollback. The release tests cover
   `release/gate.mjs` tag matching and synthetic fixed-candidate admission without
   creating any release tag. WAIT means wait and retry; LOCAL-FALLBACK means stop
   with tests pending, never run locally.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait373-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/release-candidate-gate.test.js test/release-publication.test.js \
     test/release-prep.test.js test/release-normalize.test.js \
     test/release-normalize-pack.test.js test/calver.test.js \
     test/calver-surgical.test.js test/version-presentation.test.js \
     test/consumer-isolation.test.js test/grok-release.test.js
   ```

3. Commit the checkpoint's `candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff`. This binds the implementation
   checkpoint, not the final C that contains it.
4. Repeat the same remote command on the **final committed C** with
   `EVIDENCE_OUT="$PWD/dist/ait373-final"`. Retain the complete absolute directory
   `/Users/markus/Code/aithema-worktrees/ait-373/dist/ait373-final/candidate/`,
   including `first/release-set.json`, `candidate-evidence.json` and the isolated
   consumer deployment, without another evidence-only commit. Confirm the
   evidence source equals C and its manifest SHA-256 and normalized digest bind
   `first/`. Any subsequent source change requires a new final-head build.
5. Push only the assigned branch, open a PR to main and wait for green CI:
   seven browser shards, four browser aliases, test, preview-security and DCO.
   Hand the coordinator the PR, C, X, sequence 20, retained absolute directory,
   manifest SHA-256 and normalized digest exactly as in the evidence. The
   coordinator copies those values into the immutable candidate marker after
   gates and true merge, then hands them to OPS; no OPS command is supplied by
   this builder. Retain the complete directory in durable owner storage before
   publication; CI also retains `reset-candidate` for 90 days.

## Eighth October candidate (AIT-366 / START-550)

The reserved coordinate is `261019093518.0.0` (UTC reservation time), stable sequence
19, status `reserved`. Marketing name: **Aithema 2026.10**, with the exact version
below the notes title. Release authority is Markus's standing release go,
Desk **4d867165-4eb5-4b69-8980-88d43a7ec64b**, 2026-10-19. There is **no new Desk
question**. After the coordinator's cross-family release gate, green CI,
signatures/checksums and Tick's UI look, OPS publishes on the coordinator's
handoff and Markus receives a report afterwards. The builder prepares only,
invokes no review gates and creates no tag, tag push, GitHub release or publication.

This follows the AIT-360 candidate/evidence route and **today's process**: the RC
PR waits unmerged, with a merge freeze until published. AIT-363 B (release from a
tagged candidate) is not live. The existing OPS command and release workflow
require the release head to be an ancestor of `origin/main`. That check will
refuse an unmerged RC head at this base. Coordinator/OPS must resolve that
publication prerequisite within the authorized process before running the tag
push; this preparation does not bypass it or change the release workflow.
The OPS route below is retained with that guard intact.

Prerequisites #318 (AIT-364, START-550 partial-consent fix) and #316 (AIT-351,
Grok Voice release inclusion, **not yet qualified in live use**) are both on main
at base `412d15cc4ca50a2611f0d4561904175634eb2eac`. The full first-parent range
since `v261019003029.0.0` contains #317 (already-published AIT-360 preparation),
#313 (AIT-358), #310 (AIT-347), #315 (AIT-350), #316 and #318. The second voice
pipeline's packages 1–8 are included through this merged closure. AIT-361 and
AIT-362 are absent at this base and are excluded; do not wait for them.
The previous release `v261019003029.0.0`, sequence 18, AIT-360, published by OPS
at 2026-10-19 06:06Z, is recorded in `history.json` at source
`94b360b1d5c9d9630d85fee4788faa956126e164`.

Notes lead with removing drafts/images immediately in every tab on partial
withdrawal, then optional Grok Voice (**not yet qualified in live use**) with
Settings and the truthful interruption marker, then Reload with a fresh mint.
Host notes explain `voice-xai` v1, SpaceXAI LLC (“SpaceXSI”), US recipient seat,
international processing without a guaranteed region, current private account
and ZDR evidence, server-side secret references, measured visitor duration,
estimated child claims, recovery and the approved absence of a heard position.
They distinguish native source-hosted browser modules under `script-src 'self'`
from installed package resolution. The sixteenth release package is
`@inspr/aithema-plugin-grok-voice` (**not yet qualified in live use**).
**Breaking for hosts: none relative to RC7**: the provider is opt-in, the consent
fix is component-internal and Reload uses the existing mint route. RC7's preview
embedding requirements still apply. Collected `next-notes.md` lines were used;
the file is reset to its empty stub.

The approved presentation source remains
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`; presentation pins and the AIT-32
migration anchor stay fixed. All manifests and the lock mirror the reservation,
including the new voice package. Preparation candidates are digest-verified
evidence; the authorized tag build alone makes and attests shipped bytes.
BSD preparation bytes and CI's GNU bytes remain distinct.

Run order (the round-6 evidence rule above applies):

1. Fetch `origin/main` and tags; stop if #318 or #316 is missing. Commit the
   reservation, all manifest/lock mirrors, history, notes and runbook with
   `--signoff` before the remote run. Branch: `release/ait-366-eighth-release`;
   builder marker: session `AIT-366-b1`. Never push main, amend or force-push.
2. From this worktree on mbp2607, use the command below. It runs
   `npm run release:candidate -- <retained dir>` on mbp2606: two packs,
   verification, isolated installed consumer smoke (including the new voice
   package imported from shipped bytes), locked reinstall, update and rollback.
   CalVer tests exercise `release/gate.mjs tag` without creating a tag.
   On WAIT, wait and retry per remote policy; on LOCAL-FALLBACK, stop with tests
   pending. Never run tests, builds, browsers or the candidate on mbp2607.

   ```sh
   EVIDENCE_OUT="$PWD/dist/ait366-checkpoint" \
     /private/tmp/claude-501/-Users-markus-Code-aithema/c3acf551-65c1-4283-a0f5-bea8a7cfc6f7/scratchpad/remote-browser.sh \
     "$PWD" unit --test-concurrency=2 \
     test/release-candidate.test.js test/release-workflow.test.js \
     test/calver.test.js test/version-presentation.test.js test/consumer-isolation.test.js
   ```

3. Commit `dist/ait366-checkpoint/candidate/candidate-evidence.json` as
   `release/evidence.json` with `--signoff` for the implementation checkpoint.
4. Repeat the command on the final committed head using
   `EVIDENCE_OUT="$PWD/dist/ait366-final"`. Retain the complete
   `dist/ait366-final/candidate/` without another evidence-only commit. Both
   `candidate-evidence.json` and `first/release-set.json` must bind the handed-over
   head. Hand OPS that exact head and final manifest SHA-256 together; copy the
   full directory to durable owner storage before publication.
5. Push only `release/ait-366-eighth-release`, open a PR to main, leave it unmerged
   and wait for green CI: seven browser shards, four required browser aliases,
   units, preview-security and DCO. CI retains `reset-candidate` for 90 days.
   The coordinator runs the release gate after handoff; OPS owns publication
   under the standing go and reports to Markus afterwards.

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

## RC8 OPS publish route under the standing release go

This is the pre-activation RC8 route; the fixed-candidate route follows.

OPS owns the exact-SHA rehearsal, clean-clone `v*` tag push, release run,
attestation verification and publication on the coordinator's handoff under
Markus's standing release go (Desk 4d867165, 2026-10-19). No new Desk question.
The builder only prepares the candidate, notes and reservation through the PR.
The route is **public GitHub release tarballs**, SHA256SUMS and GitHub artifact
attestations, using only the workflow's `GITHUB_TOKEN`. No npm registry account,
npm publication, GitHub Packages registry or consumer token is required.

After the coordinator's cross-family release gate, green CI and Tick's UI look,
OPS runs the following under the standing release go on
mbp2606 or an authorized build runner. Set `FINAL_CANDIDATE` to the retained
AIT-366 final directory above, and enable repository immutable releases before
the tag push. These commands are a handoff, not builder authorization to run them.

```sh
set -eu
export FINAL_CANDIDATE=/absolute/owner-storage/ait366-final/candidate
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
npm run release:candidate -- "$OPS_WORK/ait366-rehearsal"
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
manifest SHA-256, source commit and all sixteen package digests;
`consumer-package-lock.json` records sha512 integrity for those tarball bytes.
No earlier BSD or PR candidate digest is presented as the shipped digest.

## Fixed-candidate RC route (AIT-363)

Activation boundary: this route starts only after RC8 is published on the old
process, OPS's cut rewrite and tag rulesets are ready, and the coordinator's
release gates pass. Until then the RC PR waits unmerged and main is frozen.
The candidate under this route is the fixed RC head commit C; later main
commits do not change it. The older candidate sections above are historical
preparation records, including their then-required Desk questions.

**Standing release go: Markus, Desk 4d867165-4eb5-4b69-8980-88d43a7ec64b
(2026-10-19).** Publish after the cross-family release gate, green CI,
signatures/checksums and, for UI changes, Tick's look. Report the published
version, C, digests and verification to Markus afterwards. start2/start3 deploys
keep their own go. Builders prepare and open PRs; OPS owns cuts and re-runs.

The order is **lock tag → prep → gates → true merge → marker → cut → verify**:

1. Before any preparation, the coordinator takes the shared exclusive lock
   `~/.aeon/lead/aeon/AITHEMA-RELEASE.lock` on mbp2607 and pushes an annotated
   `release-lock/seq-N` at origin/main, where N is the last published sequence
   plus one. Creation is atomic and an existing lock refuses a second prep.
   Every re-cut for N reuses this lock; N+1 waits until N is published.
2. The RC builder reserves X once, repairs the source, every package/lock mirror
   and internal dependency pin, writes notes and retains candidate evidence for
   the final committed C. Do not put an evidence-only commit after that final
   build. `candidate-evidence.json` binds `source_commit`, `manifest_sha256` and
   `normalized_digest` to the retained `first/` directory.
3. The coordinator obtains the cross-family release gate, green CI and Tick's
   look when there is UI. The standing go applies after these gates. Re-cut
   changes require new evidence and gates; re-ask any already-answered candidate
   question when the approved candidate changes.
4. Merge the RC through the queue as a **true merge**, preserving C. The
   coordinator checks the queue's merge method is `merge` before each RC and
   hard-aborts unless `git merge-base --is-ancestor C origin/main` succeeds.
5. Under the same exclusive lock as OPS, with RELEASE-WINDOW closed and every
   existing `v*` of N terminal, the coordinator pushes the immutable annotated
   `candidate/vX` tag directly at C. Its complete message is JSON:

   ```json
   {
     "version": "261019120000.0.0",
     "release_sequence": 19,
     "source_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
     "manifest_sha256": "sha256:<64 lowercase hex digits from candidate evidence>",
     "normalized_digest": "sha256:<64 lowercase hex digits from candidate evidence>"
   }
   ```

   Values here are illustrative. The real marker copies the retained evidence's
   values exactly. Before pushing, the coordinator's helper calls the exported
   `parseCandidateMarker(tagName, annotatedTagObject)` from `release/gate.mjs`
   with the `candidate/vX` name and the complete `git cat-file -p` tag object;
   this validates the JSON fields and direct commit binding. Keep the marker
   name, C and both digests in the release ticket
   and the report/handoff. Of all `candidate/v*` markers for N, the latest valid
   CalVer3 version is active. Older markers remain immutable, superseded history.
6. OPS owns the entire cut or re-run under that shared exclusive lock, through
   verification. It opens `RELEASE-WINDOW` with `open X C` **before** checking
   ancestry, the active marker, absence of `vX`, absence of a published sequence
   ≥ N, and agreement with the report's C and both digests. It checks out C,
   rehearses on mbp2606 first (OPS-393 guard); if mbp2606 refuses or is unreachable, once on mbp2607 under the shared lock while mbp2607 is GREEN; or on an authorized CI runner.
   On mbp2607 only `npm ci --ignore-scripts` + pack + verify; no tests, no browsers; one serialized run (Markus's rule, AEON-LEAD 2026-10-19 13:14).
   It recomputes the normalized digest and checks the marker before pushing `vX` at C. Only OPS's cut creates
   `v*`. The tag starts the existing release workflow; no separate manual release
   creation or registry publication is involved.
7. OPS waits for the release run, verifies the immutable published set with
   `verify-release.sh <tag> <commit>`, signatures/attestations and SHA256SUMS,
   retains the exact published assets and consumer deployment in durable owner
   storage, then closes RELEASE-WINDOW and reports to Markus.

**Nothing built from main is installable as X.** After C merges, main can move
on while it still carries reserved X. PR/main packs from later commits are never
handed out under X. Before publication, START may pin only C's retained evidence
on its own branch: recompute its manifest SHA-256 and normalized digest and check
both, plus C and X, against the marker and handoff before installation. The
coordinator's chain refuses every other pack. After publication, production pins
the exact verified published artifact set; start2/start3 still require their own
deploy go. A changed artifact set always receives a new coordinate.

### Exact normalized-byte contract (§ 6)

`AITHEMA_CANONICAL_RELEASE=1` requires Node 24 and GNU tar, enforced by
`assertCanonicalReleaseToolchain` in `release/lib/tarball.mjs`. The Macs have
bsdtar, so candidate evidence built there is non-canonical. That is fine: the
normalized digest is member-level and excludes tarball digests. OPS's cut rehearses
canonically with pinned Node 24.21.0 + GNU tar 1.35 (nixpkgs).

`node release/normalize.mjs <release-directory>` verifies the full archive set,
including module/source bindings and provenance recomputation, then hashes a
canonical JSON containing the release-set and each archive's sorted
`[member path, sha256]` list. Object keys are sorted recursively. Each ordinary
member is hashed as its exact bytes. Only these leaves are removed:

- `mode` in exactly the workspace's `release/runtime.json` and
  `packages/server/src/release-runtime.json`, and each module's
  `release-runtime.json`. The server module also projects the named workspace
  server copy as `src/release-runtime.json`; only that exact server artifact/path
  is treated as a runtime copy. Modes must be candidate or release.
- `runtime_tree_digest` in exactly workspace
  `release/source-provenance.json`. The original leaf is required and must match
  the tree digest recomputed from all other unnormalized workspace files.
- In the release-set: `mode`, `packing.run`, `artifacts[].sha256`, and only
  `sha256`/`size` in `files[]` and module `artifacts[].files[]` for those exact
  runtime/provenance paths.

Every removed leaf is required and validated before removal. All other keys,
including added or missing keys and other nested mode/digest fields, remain
bound. Every other tarball member must be byte-identical. Candidate and tag
packs of C have equal normalized digests even though mode, run, provenance and
archive container hashes differ. BSD/GNU tar header differences are outside the
member-level digest; the published artifact's exact hash remains authoritative
for installation, signatures and rollback.

### Publication admission, authority and serialization (§ 7 / § 7a)

Immediately after building and verifying `dist/release`, a separate step runs
`node release/gate.mjs candidate "$GITHUB_REF"` with the workflow's own
`GITHUB_TOKEN` for read-only admission. It precedes attestation and creation:
**verify → gate → attest → create**. The gate requires an annotated marker
pointing directly to the tagged C, valid version/N/C/manifest/normalized-digest
fields, the active marker for N, no published sequence ≥ N, no
`release-failed/vX`, no other unpublished `v*` of N without a failed-terminal
marker, and the built set's matching normalized digest. Other in-flight `v*`
sequences are read from `release/version.json` at their tagged commits; an
unreadable sequence refuses admission. Releases are
read through paginated GETs with the workflow's own token. Inside the gate,
`candidate/*`, `release-failed/*` and `v*` tags are fetched again from origin
before deciding, even though checkout uses complete Git history
(`fetch-depth: 0`). A failed refresh refuses admission. One fixed `release` concurrency group
serializes all release refs, with no cancellation of an in-progress run.
Published legacy coordinates use the explicit commit-bound history ledger;
later coordinates use the version source at their tag. Unknown or unreadable
published metadata refuses admission. A malformed own marker, or another
malformed marker claiming N, also refuses. Malformed unrelated or unreadable
markers emit a warning without blocking other sequences. No refused candidate
gets an attestation or a retained release artifact.

OPS makes `v*`, `candidate/*`, `release-lock/*` and `release-failed/*` immutable
with tag rulesets. A ruleset limits creating `v*` to the **admin role**, but
cannot separate the coordinator and OPS: both sessions use the same admin
account, `markus-barta`. No distinct identity, new key or scope is claimed.
Tooling supplies the narrower role rule: only OPS's cut creates `v*`; the
coordinator's helper refuses `refs/tags/v*` and pushes only markers and lock tags.
Their separation is **procedural**, not enforced by operator identity. Both take
`~/.aeon/lead/aeon/AITHEMA-RELEASE.lock` on mbp2607: OPS for the whole cut or
re-run, from opening RELEASE-WINDOW through verification, and the coordinator
for every marker or lock-tag push. The coordinator never pushes a marker while
RELEASE-WINDOW is open; OPS opens it before re-checking admission and closes it
only after verification or a recorded failure.

A separate **no-bypass deny ruleset**, with no bypass actors (including admins),
denies creation of historical reserved-but-unpublished tags
`v261017073156.0.0` and `v261017100846.0.0`. These were the only such coordinates
in the 2026-10-19 09:31 inventory of reserved versions on main's ancestry versus
published tags. OPS repeats the inventory immediately before go-live and adds
any new entry. The first B candidate reserves a fresh coordinate. From B on,
every superseded coordinate is added to this deny ruleset when superseded,
in addition to the candidate gate refusing non-active markers.

**Residual admin risk:** with the no-bypass deny ruleset in place, a manual push
of a denied historical coordinate cannot publish it. Publishing it would first
require an admin to deliberately change or disable the ruleset. Coordinates
off the deny list are either already published (immutable, so a new tag fails)
or post-B (the workflow gate refuses a non-active marker). The remaining risk
is a deliberate admin action against the rulesets, accepted as procedural and
visible through immutable releases and `verify-release`. The admin-role limit,
helper refusal, shared lock and RELEASE-WINDOW protocol mitigate accidental
pushes under the shared account; they do not distinguish OPS's identity.

OPS also repeats the legacy-run audit immediately before activation: all
historical release tags must have published releases, with no drafts or
outstanding failed/re-runnable coordinates. Otherwise activation waits.
Historical re-runs then fail at creation because their immutable release already
exists. This audit complements the reserved-but-unpublished deny inventory.

### Terminal states and failed-cut recovery (§ 7b)

Every pushed `vX` is **in publication** until one of these terminal states:

- **Published:** its immutable release exists and verification passed.
- **Failed:** OPS pushed an annotated immutable `release-failed/vX` tag with the
  recorded reason. Its tag and coordinate are never reused for changed bytes.

While any `v*` of N is nonterminal, the coordinator cannot activate a new marker
for N, a new cut for N refuses, and `slots.sh` holds RELEASE-WINDOW. A re-run
belongs only to the release operator under the cut's shared exclusive lock; it
continues that same publication. This also closes the race between an old
re-run passing admission and a replacement marker becoming active.

If OPS aborts before pushing `vX`, close the window as `failed X: reason` and
record the failure on the release ticket. Another cut for N can then run.
If the tag is pushed and the workflow fails, retain the tag. The cleanup trap is
armed before creation, so even partial asset-upload failures delete the
non-immutable release. OPS reconciles any leftover **draft** before retrying,
never deletes a published release, and closes the window only after verification
or a recorded failure.

A retry of unchanged X can succeed only while X is active, N is unpublished and
X has no failed-terminal marker. Otherwise the gate refuses. If a fix is needed,
OPS first makes X failed-terminal; the coordinator can then activate a new X′
under N. Any later re-run of X refuses because of the failed tag, supersession or
the published sequence. Re-cuts always reserve a new second and never move or
reuse `vX`.

### Re-cuts and surgical integration (§ 9)

Default: land the fix on main, prep a later X′ under the same sequence lock N,
retain new evidence, repeat gates and true merge, then mark and cut the new C.
The published sequence ledger still ends at N−1, so the new reservation keeps N.

Surgical (only on coordinator + LEAD decision when main has work that must not
ship): branch from C, apply the fix and reserve X′ to form **C′**. Never merge
main into C′ or modify it afterwards. Construct a separate integration PR whose
head is a signed true merge commit **M**, with parents C′ and current main. On M,
repair **every** version mirror and internal dependency pin to X′: the root
manifest, package/plugin manifests, root and workspace lock entries, and internal
`dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`.
This includes packages added on main **and existing packages gaining new internal
edges since C**. Keep external ranges unchanged.

Validate C′ separately with CalVer and candidate evidence; validate M separately
with CalVer and full CI. After M merges, check C′ is an ancestor of origin/main;
the marker and cut point to C′, never M. `test/calver-surgical.test.js` exercises
this two-parent fixture, the main-only package and new edges, all mirrors/pins,
and the untouched C′ tree. The coordinator owns producing and signing M; this
builder does not sign or create a release commit.

### Tag workflow and retained shipped bytes

The public route remains GitHub tarballs, SHA256SUMS and GitHub artifact
attestations, using only the workflow's `GITHUB_TOKEN`. No npm registry account,
publication or consumer token is required. The tag build is the source of shipped
bytes; its tag must exactly match the reservation and C must belong to main.
The Ubuntu/Node 24/GNU tar job keeps every existing check:

1. Require ancestry and the exact reserved tag, install the locked closure,
   pack once into `dist/release` and verify every archive. Immediately admit the
   active candidate against refreshed tags and published sequences.
2. Test consumers against those exact archives: scratch install, locked
   reinstall, dependency replacement and exact rollback.
3. Bind consumer evidence to the source, manifest and all module hashes; generate
   SHA256SUMS and reject an unexpected or missing archive.
4. Attest every tarball, checksum, manifest and evidence file with the pinned
   provenance action, after candidate admission has succeeded.
5. Arm cleanup, create the draft with its exact tested assets, publish it, then
   require immutability. Retain the full portable consumer deployment for 90 days.

`consumer-evidence.json` binds the manifest SHA-256, source commit and all sixteen
package digests; `consumer-package-lock.json` records sha512 integrity for those
same tested tarball bytes. No earlier BSD or PR digest is the shipped digest.

Download all release assets into a clean directory on the build runner. Verify
`gh attestation verify SHA256SUMS --repo inspr-at/aithema` and the manifest,
evidence and every tarball with the same command, then run
`sha256sum --check SHA256SUMS`. Retain this exact set and its manifest digest in
durable owner storage. Consumers install the sixteen module tarballs by release
URL in one invocation (one URL per module), for example:

```sh
npm install --save-exact https://github.com/inspr-at/aithema/releases/download/<tag>/<pkg>.tgz
```

Here `<tag>` is `v` followed by the reserved version, and `<pkg>` is a module
archive filename without the `.tgz` suffix from `release-set.json`. Pass all
sixteen URLs together so their mutual dependencies resolve without a registry
publication. Commit the host's lockfile: its URL resolutions and sha512 integrity
pin the downloaded bytes. Use `npm ci` for subsequent installations; retain the
verified archives and deployment pin for an exact-artifact rollback. The
workspace archive is retained source, not an installable root package.

References: [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
[GitHub CLI release creation and immutability](https://cli.github.com/manual/gh_release_create),
[repository immutability setting](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository).
