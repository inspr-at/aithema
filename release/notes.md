# Aithema 2026.10

Version **261110120839.0.0**. Licensed under **AGPL-3.0-only**.

Confirming your email moves understanding forward, keeps your answered reply in place, and leaves a failed reply ready to retry.

## What START and visitors notice

- **Email unlock (AIT-463):** Understanding starts without another message after
  you confirm your email. An answered reply keeps its question card or answer
  buttons, with no stray Retry.
- **Reply recovery (AIT-466):** If your reply failed before you confirmed your
  email, Retry stays on the reply line. It dims in place while unavailable or
  retrying, and your turn holds still when the retried reply arrives.

## For hosts

**Email unlock and reply continuity (AIT-463).** Email verification starts newly
unblocked understanding without another visitor input, on hosts with and without
a purpose policy. Hosts with an identity projection now also get the understanding
step on unlock. An answered reply is no longer generated or billed again after
an identity change; failures recorded before unlock remain on explicit Retry.
Assistant turns gain an additive, identity-independent `replyRevision` field in
snapshots, events, journal and receipt metadata, and transcript exports. The
additive `replyIsCurrent` core helper checks reply freshness; existing full
`inputRevision` stamps retain their fallback checks.

**Reply recovery UI (AIT-466).** A failed reply remains retryable on its reply
line before email confirmation. Retry dims in place instead of disappearing,
and the person's turn holds still when the reply lands. This is UI-only and
preserves existing copy, including host overrides.

**CI-only (AIT-461, #411).** Skipped duplicate pushes still warm main's npm cache;
CI test fixtures are independent of the ambient CI state.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC19 (`v261022020419.0.0`).** #412 adds the `replyRevision`
metadata field and `replyIsCurrent` core export without removing or changing an
existing export contract. It changes no configuration key, HTTP status code or
host integration requirement; #413 is UI-only, #411 is CI-only and #410 prepared
RC19. [RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply when upgrading from an earlier release.
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
with tag `v261110120839.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261110120839.0.0/docs/embedding.md)
for host integration.
