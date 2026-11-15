# Aithema 2026.10

Version **261115062259.0.0**. Licensed under **AGPL-3.0-only**.

The overview now shows whether it is updating or up to date. Start continues after consent, the chat follows your answer, and call endings and email status give clearer, current information. Open questions recover honestly when Clarify cannot run, and their heading shows how many remain.

## What visitors notice

- **Overview stays current (AIT-504, #438, #439).** After every answer the overview shows whether it is updating or up to date, so it never looks stuck.
- **Start continues after consent (AIT-501, #440).** After giving consent from Start, the conversation continues where the visitor left off instead of asking for Start again.
- **Chat follows your answer (AIT-512, #440).** After picking an option or sending a message, the chat keeps the new turn in view, and a quick second click can't hit a control that just moved.
- **Honest call endings (AIT-502, #437).** When a call ends, the message says what actually happened: a failed connection, the call's maximum length, used-up credits, or simply that the call ended.
- **Current email status (AIT-518, #436).** After a reload or a return to the tab, the conversation shows the confirmed email address right away.
- **Accurate resend countdown (AIT-486, #434).** After the page reconnects, the resend countdown shows the wait the server actually enforces instead of a stale, longer one.
- **Clarify recovers honestly (AIT-503, #438, #441).** When asking about an open question can't happen right away, the row says why and offers Retry when it can work, without duplicate replies.
- **Counted open questions (AIT-516, #441).** The open-questions heading shows how many questions are still open, with correct singular and plural in English and German.

The original overview freeze report did not reproduce. This release makes the
status visible; it does not establish a scheduler bug or claim to fix one.

## For hosts

**Call endings (AIT-502, #437).** One voice-end classifier distinguishes connection
failures, a call's maximum length, the conversation time cap, credits and ordinary
ends. Optional `timeLimit: 'call' | 'conversation'` is additive on `voice.state`,
the start receipt and snapshot projections, and on a plugin's `ended` event.
A refused resumed call whose retained bound elapsed adds `reason: 'time-limit'`
and `timeLimit` to the existing 504 `deadline` receipt; the HTTP status is unchanged.
An ordinary fresh-start 504, timeout or expired media grant remains a connection
failure with Retry, without automatic retry. `voiceConnectionFailed` keeps its
text; `voiceDeadline` is deprecated but still exported. The close × appears only
in failed states, with none in the phone status row.

**Copy compatibility (#437, #438, #441).** The shared resolver
`packages/ui/src/copy-resolve.js` preserves legacy host overrides. A host's
new-key override differing from the shipped default wins; otherwise a legacy
override differing from the shipped default wins; otherwise the shipped new-key
default wins. A bundle that includes the shipped new-key default does not hide a
custom legacy value. For keys without a legacy fallback, use the host value,
then the active locale's shipped value, then English; no empty label is rendered.

| New copy key | Legacy fallback / default |
| --- | --- |
| `voiceConnectFailed` | `voiceConnectionFailed` |
| `voiceTimeLimit` | `voiceDeadline` (deprecated, still exported) |
| `voiceMessagesNarrow.voiceConnectFailed` | No legacy fallback; active locale, then English |
| `voiceMessagesNarrow.voiceTimeLimit` | No legacy fallback; active locale, then English |
| `voiceMessageClose` | No legacy fallback; active locale, then English |
| `overviewCurrent` | `final` |
| `staleIdle` | No legacy fallback; active locale, then English |
| `overviewStatusLabel` | No legacy fallback; active locale, then English |
| `clarifyFailed` | `reasoningFailed`; accepted rows also retain `clarify.failed` beneath explicit root failure overrides |
| `clarifyFailedShort` | Active locale, then English; accepted rows also retain `clarify.failedShort` |
| `clarifyUnavailable` | No legacy fallback; active locale, then English |
| `retryFailed` | `reasoningFailed` |
| `replyFailed` | `reasoningFailed` |
| `replyKeepTyping` | No legacy fallback; active locale, then English |
| `questionsCounted` (`zero`, `one`, `other`) | `questions` |
| `moreOne` | `more` (legacy overrides keep winning for both counts) |

The updated, still-exported `reasoningFailed` default is “That didn't work just
now. Your messages are saved.” / “Das hat gerade nicht funktioniert. Ihre
Nachrichten sind gespeichert.” Legacy overrides keep winning. The short “Not
now” label belongs to `clarifyFailedShort`; `clarifyFailed` is the long message.
Accepted-row `clarify.say.retry` overrides remain supported beneath explicit root
failure overrides. Updating still uses `stale`; `preparingOverview` and `draft`
retain their roles. `questionsCounted` replaces the German visitor heading
“Was noch offen ist” with counted forms, while a host's `questions` override
keeps showing. Existing `more` and `plural` exports remain supported.

**Overview and Clarify (AIT-503, AIT-504, AIT-516; #438, #439, #441).**
The overview status slot covers Up to date, Updating, preparing, stale idle and
failure, reserving 4.35em for the reachable three-line worst case plus its action.
The bounded snapshot read waits 18 seconds before one GET with a two-second
deadline; an ahead snapshot restores the complete projection, with a revision
fence and a finalized-turn fence. An action on its own row has no separator;
long consent overrides clamp the text and keep the action.

Clarify uses an internal, unexported Wait / Retryable / Actionable / Terminal
policy, with answered-question reconciliation and prompt rules addressing the
visitor. The question-row action is left-anchored in a fixed line. A diagnostic
`console.warn('Aithema: clarify refusal', fields)` reports backend refusals,
transport errors and accepted commands whose reply lane fails, with allowlisted
codes and no conversation content. The local reply-in-flight guard stays quiet.
Core has no public `./question-focus` subpath; its existing root focus functions
remain exported. Approved EN/DE processing text updates `reasoningFailed`,
`settings.fixedEffort`, `errors.delegated` and `host.loadingBinding`.

**Consent and keeping your place (AIT-501, AIT-512; #440).** The bubbling,
composed, noncancelable `aithema-consent` detail adds `intent`, `mode` and
`required`, keeping `reason: 'ready'` and the full `features`. Existing reason
values are `chooser`, `ready`, `manage` and `settings`. `intent` is `start`
for the ready card's Start action and `review` otherwise; `mode` is `type` or
`voice`, and `required` lists the blocked feature needed for that mode.
Start resumes after consent: text continues on its own; voice resumes only with
live user activation, otherwise Start call gets focus. After navigating to a
consent page, voice needs one click on “Start call”. A pick or send keeps the new
turn in view, and every interactive transcript/card control has a double-click
guard.

**Identity refresh (AIT-518, AIT-486; #436, #434).** While an email link is
pending, hosts see an earlier and slightly more frequent `POST S/identity/unlock`:
at connect, page-visible, window focus and when a gate first opens. Checks
coalesce within 250 ms, with one in flight; the host API is unchanged. After
resync, the resend countdown re-anchors on a fresh identity view and can only
shorten, never extend.

**CI-only and dev-only (AIT-488 part B, #435).** happy-dom updates to 21.0.4,
with orb finished-promise handling in a test helper. It is not shipped; the
sixteen-module release closure is unchanged.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
still apply, including its breaking changes; Aithema recommends checking those
requirements before upgrading from an earlier release. RC23's asynchronous
identity-delivery `identity.acceptsAddress` requirement also still applies.

## Breaking for hosts

**None relative to RC23 (`v261112091755.0.0`).** The actual diff adds optional
voice metadata, refusal metadata, consent-event fields and copy keys. It removes
no public configuration or export, changes no HTTP status or host requirement,
and preserves legacy copy overrides. The counted German heading is visitor copy;
a `questions` override keeps its existing text. `voiceDeadline` stays exported,
and the internal focus policy adds no public `./question-focus` subpath.

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
with tag `v261115062259.0.0` in every download and installation URL. Retain the
verified assets, manifest and deployment pin for rollback to those exact bytes.
See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261115062259.0.0/docs/embedding.md)
for host integration.
