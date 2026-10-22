# Aithema 2026.10

Version **261022020419.0.0**. Licensed under **AGPL-3.0-only**.

Nineteenth October release: the email dialog stays put while you edit your address.

## What START and visitors notice

- **Email address editing (AIT-454):** Your address edit stays open and the dialog
  no longer jumps when a reply finishes.

## For hosts

**Visitor behaviour (AIT-454).** Repeated verified-identity refreshes keep an
address edit open; a host that overrides the verification copy sees no change
to that copy.

**Test-only (AIT-455).** The consent cross-tab suite releases a headerless socket
and gives browser and HTTP teardown named 10-second deadlines so teardown cannot
hang a browser shard.

**CI-only (AIT-456).** Unit tests run in three shards balanced by measured duration
under the single required `test` check, with unchanged caps and support for new
test files and partial re-runs.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC18 (`v261021222022.0.0`).** The #408 diff changes visitor
behaviour only, with no new public export, configuration key, HTTP status code
or host integration requirement; #407 is test-only and #409 is CI-only.
START integrates and pins this release separately.

## Availability and verification

The sixteen-module release closure is unchanged. Voxtral (AIT-342) remains
parked, private and outside this release. Provider-side closure of a live call
(AIT-446's second part) remains parked until ElevenLabs monitoring is enabled.
Grok Voice is **not yet qualified in live use**. No provider credentials are
bundled.

Release assets include module tarballs, the workspace archive, dependency locks,
an SPDX SBOM and `release-set.json`. Verify the published attestations and
`SHA256SUMS` before installation, following
[RC14's verification and installation instructions](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#verify-and-install)
with tag `v261022020419.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261022020419.0.0/docs/embedding.md)
for host integration.
