# Aithema 2026.10

Version **261021060306.0.0**. Licensed under **AGPL-3.0-only**.

Fifteenth October release: a tidier phone footer.

## What START and visitors notice

- **A tidier phone footer (AIT-439):** the model flag sits in the centre of its
  box, with more room before Legal. The credits label stays centred when
  credit updates are shown.

## For hosts

**Footer CSS (AIT-439).** Below 600 px, the model flag is centred in its 44 px
box, leaving at least 12 px before the Legal control. The credits label is
vertically centred with reconciling text enabled (`host.credits.reconcilingVisible`,
O4); review custom CSS that overrides these alignments.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release. START integrates and
pins this release separately.

Two changes are test-only: atomic image-generation trace writes (AIT-438) and
deterministic HTML-preview readiness (AIT-440).

## Breaking for hosts

**None relative to RC14 (`v261021043938.0.0`).** This follow-up changes footer
alignment and tests; host APIs and configuration requirements stay the same.

## Availability and verification

The sixteen-module release closure is unchanged. Voxtral and the second Grok
voice pipeline (AIT-317/342) remain parked, private and outside this release.
Grok Voice is **not yet qualified in live use**. No provider credentials are
bundled.

Release assets include module tarballs, the workspace archive, dependency locks,
an SPDX SBOM and `release-set.json`. Verify the published attestations and
`SHA256SUMS` before installation, following
[RC14's verification and installation instructions](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#verify-and-install)
with tag `v261021060306.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261021060306.0.0/docs/embedding.md)
for host integration.
