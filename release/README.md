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
npm run release:candidate -- /retained/ait105
# Equivalent pack/verify entrypoints (use new output directories):
npm run release:pack -- /retained/ait105/first --candidate SOURCE_COMMIT
npm run release:verify -- /retained/ait105/first
npm run release:consumer -- /retained/ait105/first
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

## OPS publish route after Markus's Desk go

OPS owns the exact-SHA rehearsal, clean-clone `v*` tag push, release run,
attestation verification and publication after Markus's separate Desk go.
The builder only prepares the candidate, notes and reservation through the PR.
The route is **public GitHub release tarballs**, SHA256SUMS and GitHub artifact
attestations, using only the workflow's `GITHUB_TOKEN`. No npm registry account,
npm publication, GitHub Packages registry or consumer token is required.

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
