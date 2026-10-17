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
npm run release:candidate -- /retained/ait278
# Equivalent pack/verify entrypoints (use new output directories):
npm run release:pack -- /retained/ait278/first --candidate SOURCE_COMMIT
npm run release:verify -- /retained/ait278/first
npm run release:consumer -- /retained/ait278/first
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

## Second October candidate (AIT-278 / START-545)

The reserved coordinate is `261017073156.0.0`, stable sequence 13. Markus's
Desk `74ae723c` (2026-10-17) authorizes preparation; OPS publishes only after
Tick's consolidated QA under Markus's Desk go. The marketing name remains
**Aithema 2026.10** (LEAD, 2026-10-17); the exact coordinate is printed below the
notes title. The first October release, `v261015164601.0.0` (sequence 12), is
recorded in `history.json`. Its migration anchor and published bytes stay fixed.
The approved shared presentation source is still
`bd0a13816f728ad91c36d849f88168bcac4fdc6e`; `presentation.json` and the complete
offline bundle retain their existing pins and Aithema overrides.

Run a candidate only after PRs #259 (AIT-286) and #260 (AIT-288) both report
`MERGED`, and after `git merge --signoff origin/main` and committing the work.
On mbp2607, use the assigned `remote-browser.sh` with
`EVIDENCE_OUT="$PWD/dist/ait278-checkpoint"` and arguments
`"$PWD" unit --test-concurrency=2 test/release-candidate.test.js test/release-workflow.test.js test/calver.test.js test/version-presentation.test.js`.
The candidate test runs `npm run release:candidate -- <retained dir>` on
mbp2606; the script copies the complete retained directory back. Commit that
run's `candidate/candidate-evidence.json` as `release/evidence.json`. Then repeat
the candidate test on the final committed head with
`EVIDENCE_OUT="$PWD/dist/ait278-final"`, retaining
`dist/ait278-final/candidate/` without another evidence-only commit. Its manifest
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
AIT-278 final directory above, and enable repository immutable releases before
the tag push. These commands are a handoff, not builder authorization to run them.

```sh
set -eu
export FINAL_CANDIDATE=/absolute/owner-storage/ait278-final/candidate
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
npm run release:candidate -- "$OPS_WORK/ait278-rehearsal"
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
