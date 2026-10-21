# Aithema 2026.10

Version **261021194038.0.0**. Licensed under **AGPL-3.0-only**.

Seventeenth October release: enough credit before a voice call starts, clearer address-limit messages, and more space for phone exports.

## What START and visitors notice

- **Credit checked before a call (AIT-447):** a voice call starts only when
  enough credit can be set aside for its maximum length.
- **Clearer drafts status (AIT-445):** while an email address has used up its
  daily limit, the drafts status says so, using the same words as the daily-limit
  message. German “E‑Mail” stays together on one line; the phone layout keeps
  its existing positions.
- **More room to export on phones (AIT-448):** when credits are used up, the
  export action has its own row with a 12 px gap. Desktop spacing stays the same.

## For hosts

**Voice admission (AIT-447).** “A call starts only when the full maximum call can
be reserved.” Every voice segment, initial and recovery, including rolling
bindings, reserves the full credential liability before facade provisioning or
credential issuance; admission fails closed when any ledger or owner limit
cannot fund that liability, or when the logical deadline is exhausted, and a
refused renewal still ends the call at the current funded segment's end.

**Credit-copy overrides (AIT-445).** The drafts status now uses
`hostSurface.credits.dailyCap` while the address day cap holds, in place of the
usual drafts status: “This email address has reached today's limit.” in English
and “Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.” in German.
Hosts that override this copy should check the same text in both locations.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC16 (`v261021073740.0.0`).** AIT-447 makes admission stricter:
previously admitted calls may now be refused when the full liability cannot be
reserved. The #402 diff changes no public exports, configuration keys or HTTP
status codes and adds no host integration requirement. START integrates and pins
this release separately.

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
with tag `v261021194038.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261021194038.0.0/docs/embedding.md)
for host integration.
