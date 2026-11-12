# Aithema 2026.10

Version **261112091755.0.0**. Licensed under **AGPL-3.0-only**.

Deleted conversations now show a clear end state and stop their requests. An email address our mail service would refuse is rejected on entry, and Settings no longer claims a link was sent after a refused resend. Hosts using asynchronous identity delivery must add `identity.acceptsAddress`; the new `aithema-erased` event lets hosts stop their own per-session requests.

## What visitors notice

- **Deleted chats end clearly (AIT-484, #428).** If a conversation is deleted elsewhere, the open page says it is no longer available and offers a new conversation, instead of continuing to make requests in the background.
- **Honest delivery status (AIT-494, #431).** An email address our mail service would refuse (for example one with brackets or quotes) is now rejected as you enter it, and Settings no longer says a link was sent when it was not.

This checks mail-service syntax, not whether a mailbox exists: a well-formed
address that does not exist still shows `sent`. Quota, IP or global suppression,
relay refusal and OPS `confirmationEnabled=false` can also still report `sent`
without mail.

## For hosts

**Erased conversations (AIT-484, #428).** A journal `session.erased`, or a snapshot
404 with exactly `{error: 'session-not-found'}`, enters one terminal state:
“This conversation is no longer available.” / “Dieses Gespräch ist nicht mehr verfügbar.”
The element stops all its requests and timers for that conversation and keeps
the existing new-conversation action. The new copy key is `conversationUnavailable`;
other German visitor copy is unchanged.

The public `aithema-erased` event bubbles, is composed and is not cancelable.
Its detail is `{sessionId, via: 'journal' | 'not-found'}`; each erased id is
announced once per element instance, at the moment of erasure. Hosts should stop
their own per-session requests (for example consent, locale, handover) on
`aithema-erased`, `aithema-open-conversation` with reason `deleted`, or
`aithema-new-conversation`. The event is additive.

**Address acceptance (AIT-490, AIT-494; #430, #431).** Breaking for hosts using
`identity.asynchronousDelivery`: add a synchronous, pure `identity.acceptsAddress`
hook before upgrading (for example the mail plugin's exported `acceptsRecipient`,
with the same normalization as delivery). `createHostHandlers` now throws at
startup if it is missing. Only `true` accepts; a throw counts as refusal.
Syntax refusals return 400 `invalid-request` on identity request/change and
`POST|PUT /api/visitor/email`; forms show their existing invalid message.
Resends to a refused stored address record delivery `failed` without mail,
slots or tokens. Synchronous hosts may omit the hook for compatibility.

The mail-smtp plugin exports `acceptsRecipient(value, parseAddress = addressparser)`,
the exact pre-send check. Refused visitor syntax includes quotes, comments,
brackets, escapes, groups, control and format characters, plus lone surrogates
(`Cs`), private-use (`Co`) and unassigned (`Cn`) code points next to AIT-487's
classes. Unicode ZWJ/ZWNJ domains stay refused; Chromium sends their punycode
form, and that form is delivered. Delivery reaches the same mailbox, not
necessarily byte-identical text: nodemailer may lowercase domains and encode
IDN as punycode. Configured sender addresses are unchanged.

The demo now refuses addresses that its mail pre-send check refuses in every
mode, including SMTP off; email-ask and Settings show the existing invalid
message, and Settings no longer says a link was sent after a refused resend.
The hook is syntax-only: it must do no I/O and consult no stored state, quotas
or facts about other visitors. A well-formed nonexistent mailbox still shows
`sent`; quota, IP or global suppression, relay refusal and OPS
`confirmationEnabled=false` remain by-design cases of `sent` without mail.
Older refused stored addresses keep email-given credit until changed or removed
by 90-day retention; no migration is needed. RC22 rows already marked `sent`
retain that state until resend, address change, confirmation within the 30-minute
verification window, deletion/erasure, or the 24-hour pending cleanup.

**CI-only (AIT-492, AIT-488 part A, AIT-497; #427, #429, #432).** Release tooling
and scripts use bounded subprocess output with explicit maxBuffer and timeout,
failing closed; the AIT-491 gate Lows are addressed. Dev dependencies update
yaml to 2.8.3 and zod to 4.6.6 through `overrides.chromium-bidi.zod`.
A browser check proves the Settings row and its controls stay within ±0.5 px
across sent/failed for wrapping addresses; README and embedding caveats are
clarified. These items change no shipped runtime behaviour or release closure.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release.

## Breaking for hosts

**One requirement relative to RC22 (`v261111083713.0.0`): AIT-494 requires
`identity.acceptsAddress` when `identity.asynchronousDelivery === true`.**
`createHostHandlers` throws at startup without it, so affected hosts must add
the hook before upgrading. Use the mail plugin's exported `acceptsRecipient`
with the same normalization as delivery. Only `true` accepts; a throw refuses.
The new 400 refusals use the existing `invalid-request` error; `aithema-erased`
and `acceptsRecipient` are additive. #426 prepared RC22; #427, #429 and #432
change only tooling, dev dependencies, tests and docs.

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
with tag `v261112091755.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261112091755.0.0/docs/embedding.md)
for host integration.
