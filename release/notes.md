# Aithema 2026.10

Version **261021222022.0.0**. Licensed under **AGPL-3.0-only**.

Eighteenth October release: voice minute limits hold across reconnects, and call lengths between whole minutes work.

## What START and visitors notice

- **Minute limits across reconnects (AIT-450):** voice calls keep to the site's
  minute limit when they reconnect.
- **More call lengths work (AIT-451):** calls whose maximum length is between
  whole minutes can now start.

## For hosts

**Voice minute caps (AIT-450).** “The total and UTC-day minute caps likewise
reserve `maxDurationSeconds` for every credential, initial and recovery,
including rolling bindings.” Admission refuses before provisioning when either
cap cannot hold the full credential, even when less time remains in the call;
settlement and reconciliation use actual provider seconds, including paused
provider time.

**Per-minute rounding (AIT-451).** Per-minute voice amounts now use one integer
ceiling formula, `ceil(seconds * microPerMinute / 60)`: “These amounts use the
shared integer ceiling helper, including non-whole-minute durations.” Call
lengths between whole minutes can now boot without “Invalid duration binding”.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC17 (`v261021194038.0.0`).** The #405 diff adds one public
export, `perMinuteCostMicro`, to `@inspr/aithema-core` (also at
`@inspr/aithema-core/cost`); it is additive. It changes no configuration keys or
HTTP status codes and adds no host integration requirement. Minute admission is
stricter: a call or recovery may now be refused when either minute cap cannot
reserve the full maximum call.
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
with tag `v261021222022.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261021222022.0.0/docs/embedding.md)
for host integration.
