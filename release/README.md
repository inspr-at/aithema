# Candidate operation and registry recommendation

The sole version authority is `release/version.json`; package manifests and the
lockfile mirror its exact coordinate. An owner-authorized candidate reservation
does not authorize a tag or publication. All commands below run on mbp2606 or CI,
never on mbp2607. Commit first: the packer reads committed Git blobs only and
excludes env files without opening them.

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
`consumer-package-lock.json`, and their manifest digest in durable owner storage.
The remote evidence copy is placed under ignored `dist/ait105/`; the committed
`release/evidence.json` records the source commit and digest table. Reproduce
the recorded source commit, not a subsequent evidence-only commit. BSD and GNU
tar encode different bytes: remote evidence records its exact toolchain;
the tag workflow requires Node 24 and GNU tar, so its artifact set needs its own
retained manifest. Never label a rebuilt tag archive as the retained BSD candidate.

## Recommendation for Markus's separate publish go

Recommend **public npm packages under `@inspr`**, subject to Markus choosing the
registry and confirming scope ownership. This fits the existing public package
names, public AGPL source and ordinary npm consumers such as START, and supports
npm's provenance/trusted publishing path. GitHub Packages remains an alternative
if the owner prefers repository-scoped distribution; it adds consumer registry
configuration/authentication. Its scope must match the package owner: distribution
from `inspr-at` would require `@inspr-at` names (or an owner arrangement for
`@inspr`), so it cannot silently substitute for the proposed npm namespace.
No registry URL is hardwired into `publishConfig`, and no publishing command or
credential is added to the workflow.

For this step, registry-neutral GitHub artifact attestations cover the manifest
and every tarball in the **tag-only** job. `id-token: write` and
`attestations: write` are scoped to that job; the action is pinned to a full
commit. PR/manual execution cannot enter the tag build. A later authorized tag
must match the reserved version and belong to main. Its upload retention is 90
days; move the exact archive/manifest/bundle to durable owner storage before it
expires. Candidate digests alone are not a cryptographic attestation.

After the separate go, verify downloaded tagged bytes using
`gh attestation verify ARCHIVE --repo inspr-at/aithema` and
`gh attestation verify release-set.json --repo inspr-at/aithema`, then compare the
retained manifest digest. If npm is selected, configure trusted publishing and
provenance for every package as a separate publication change; publish these
already-built tarballs, never repack on publication.

References: [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
