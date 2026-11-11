# Aithema 2026.10

Version **261111070532.0.0**. Licensed under **AGPL-3.0-only**.

Hosts get fewer duplicate identity events, no console 404 after deleting a conversation, and a mail-parser security fix. This release adds no new visitor-facing behaviour.

## What visitors notice

No new visitor-facing behaviour or copy.

## For hosts

**Erased conversations (AIT-464, #417).** An erased (deleted or reset)
conversation no longer requests its feature snapshot, so there is no console
404 after deleting the open conversation. Existing copy and states are unchanged.

**Identity journal (AIT-485, #419).** An unchanged pending identity no longer
re-journals `identity.state` during the resend cooldown. That means fewer duplicate
events and fewer follow-up feature reads. Event shape, fields and status codes
are unchanged. This is not breaking: journals and transcript exports only lose
duplicates.

**Mail-parser security (AIT-487, #422).** The mail-smtp plugin updates nodemailer
to 10.1.7, which fixes three address-parser advisories (GHSA-m943-m63m-w62w,
GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8).

Visitor-typed recipients that nodemailer would parse ambiguously (quotes,
comments, escapes, groups, control characters) are refused before delivery with
the existing invalid-delivery error. Configured sender addresses are unchanged.
Character checks also refuse format characters; a round-trip through nodemailer's
own addressparser must yield exactly one plain address equal to the input.
The delivered address is the same mailbox as the stored string, though nodemailer
lowercases the domain and sends IDN domains as punycode.

Hosts that also depend on nodemailer directly should move to the same 10.1.x.
This is not breaking: configured from and reply-to keep RC21's rules; ambiguous
visitor input receives the existing invalid-delivery error.

**CI-only (AIT-480, AIT-483, AIT-474, AIT-477; #418, #420, #421, #423).**
Release and test fixtures find real git and bash on any host; the identity-unlock
browser test uses a deterministic settle barrier; preview-security runs on the
pinned Playwright's supported ubuntu-24.04 runner; measured browser weights
replace two bootstrap reservations, and every browser test goes through the
measured-weight check. No shipped runtime behaviour changes in these four items.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**None relative to RC21 (`v261110175455.0.0`).** Public export contracts,
configuration keys, HTTP status codes, event shapes and fields, and host
integration requirements are unchanged. #417 suppresses feature reads for erased
conversations; #419 removes duplicate identity events from journals and transcript
exports; #422 fixes the mail parser and rejects ambiguous visitor recipients with
the existing error while preserving configured sender syntax. #418, #420, #421
and #423 change only CI or tests; #416 prepared RC21.
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
with tag `v261111070532.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261111070532.0.0/docs/embedding.md)
for host integration.
