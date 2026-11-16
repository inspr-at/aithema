# Next release — unreleased

## Host notes — RC25 visual fixes (AIT-540 M1–M6)

- Combined entrance: top-anchored control frame with intrinsic notice below
  the field and feedback/status rows. The notice slot measures the actual
  processing-choice strings per width; its visible frame grows downward without
  moving those controls. Desktop layout reserves the fixed footer inside the
  configured host height, keeping the full notice above it. Desktop notice height
  follows its full content, including longer host copy; no 8.7em cap is promised. Phones show the first AI-disclosure
  sentence and a native-dialog disclosure. New additive copy key
  `copy.composerNoticeMore`: EN “More”, DE “Mehr”. Existing `aiNotice`,
  `copy.aiNotice` and `copy.settings.processingDetails` precedence is retained.
  Feedback and status reserve their longest real localized message per width.
- One consent line and link in the composer. The ready card shows status only;
  the voice bar asks nothing about consent before the mic gesture. A blocked
  microphone is named once in the composer, using existing
  `voiceMessagesNarrow.voiceMicDenied` / `voiceMicDenied` override precedence.
  Other voice failures remain in the voice bar; the composer retains call-ended
  status. German consent defaults use “Einwilligung”: `ready.missing`,
  `ready.granted`, `clarify.consent`, `clarify.say.consent`,
  `voiceReasonsNarrow.{consentWithdrawn,consentRevised}`,
  `processingConsent.{intro,withdrawal}` and `host.consentPage.intro`.
  The demo processing intro uses the same term while retaining its persistence
  terms. `ready.consent` defaults to “Status” in EN and DE, avoiding a repeated
  consent term. German call-authorization defaults remain distinct:
  `voiceReasonsNarrow.{permission,sessionRevoked}` and
  `reasons.{call-authorization-lost,session-revoked}` retain their prior “Freigabe”
  wording. Compact voice labels keep their 22-character bound.
  Existing host copy overrides keep winning.
- While an opt-in `emailOffer` is visible, the overview lock keeps its title
  and lead and hides its form; Settings remains governed by the existing
  before-input/used-up policy. One confirmation action and credit statement
  remain on screen. At ≤520 px the offer field and button are full-width
  separate rows (button ≥44 px). Lead/privacy use intrinsic height, message
  reservation uses the longest real state, dismiss uses the shared close icon.
- AIT-524's separator is centred in its existing 18 px status-to-action gap;
  control coordinates and native hit regions are retained.
- No new host option, event field or package export.

- The combined phone offer refreshes the sticky-band inset before scrolling the
  conversation pane to reveal the whole new offer (AIT-540 M6). Only an accepted
  `show` claim in the mounted page arms this one-use reveal; restored offers and
  credit refreshes retain the latest-turn position. Page scroll and keyboard focus
  are retained; no new host setting or event is needed.
