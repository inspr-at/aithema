# Aithema 2026.10

Version **261021073740.0.0**. Licensed under **AGPL-3.0-only**.

Sixteenth October release: no page-load error without email storage, and clearer credit messages.

## What START and visitors notice

- **A quieter page load (AIT-442):** opening a conversation no longer causes an
  error when the site does not offer saved email addresses.
- **Clearer credit messages (AIT-443):** reaching an email address's daily limit
  no longer promises that a conversation can continue tomorrow. The reset message
  says when that address gets a new daily limit. Confirming an email address
  raises this conversation's limit; the message now says that directly.

## For hosts

**Optional visitor-email port (AIT-442).** For an authenticated owner, an absent
optional visitor-email port now answers HTTP 404 instead of 503 on
`/api/visitor/email` and `/api/visitor/erase`, with the existing
`visitor-unavailable` error. When identity reports both `canSave: false` and
`canDelete: false`, the UI skips the visitor-email read. Conversation email
verification still works.

**Credit-copy overrides (AIT-443).** Check overrides of
`hostSurface.credits.dailyCap`, `hostSurface.credits.dailyCapReset` and
`hostSurface.credits.ended.sessionUpgrade` in English and German: the daily-cap
line drops the continuation promise, the reset line names the address's new daily
limit from `{time}`, and the session-upgrade line names this conversation's
raised limit of `{next}` credits.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC15 (`v261021060306.0.0`).** The status correction concerns
an optional capability the host does not provide; it removes a server-error
response without adding a host requirement. Hosts handling `visitor-unavailable`
by status should accept 404. START integrates and pins this release separately.

## Availability and verification

The sixteen-module release closure is unchanged. Voxtral and the second Grok
voice pipeline (AIT-317/342) remain parked, private and outside this release.
Grok Voice is **not yet qualified in live use**. No provider credentials are
bundled.

Release assets include module tarballs, the workspace archive, dependency locks,
an SPDX SBOM and `release-set.json`. Verify the published attestations and
`SHA256SUMS` before installation, following
[RC14's verification and installation instructions](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#verify-and-install)
with tag `v261021073740.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261021073740.0.0/docs/embedding.md)
for host integration.
