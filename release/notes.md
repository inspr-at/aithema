# Aithema 2026.10

Version **261110175455.0.0**. Licensed under **AGPL-3.0-only**.

After you confirm your email, the lock indicator clears without a reload, including in open Settings and on a paused draft line.

## What visitors notice

- **Email unlock (AIT-470):** After email confirmation, the lock indicator clears
  from the concept line and overview without reloading the page. An open Settings
  dialog refreshes its option statuses, and a paused draft line updates its lock
  wording. An open option menu keeps its rows until you close it.

## For hosts

**Email unlock UI (AIT-470).** The page repeats a dropped feature read when new
journal movement arrives, at most five times and without a timer, while the
server's verdicts differ from those on screen or the read was refused with 409.
The verification poll's unlock edge starts one feature read, plus one reconnect
if the page has fallen behind, including on a 409 response. Outside a pending
consent retry, a 409 no longer rolls back an acknowledged voice Resume. A paused
draft line updates its lock wording when the lock lifts; an open Settings dialog
refreshes its option statuses after unlock, preserving an open menu's rows until
it closes. This is UI-only: existing copy and states, including host copy
overrides, are preserved; no server behaviour changes.

**CI-only (AIT-470, #415).** A ninth browser shard keeps the 405 s target and
420 s ceiling. Shard checks are named `browser (n/9)`; the four required
`browser (1/4)`–`browser (4/4)` contexts are unchanged.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC20 (`v261110120839.0.0`).** #415 changes UI behaviour and
CI/test infrastructure without changing public export contracts, configuration
keys, HTTP status codes, events or host integration requirements. The server
implementation is unchanged; #414 prepared RC20.
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
with tag `v261110175455.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261110175455.0.0/docs/embedding.md)
for host integration.
