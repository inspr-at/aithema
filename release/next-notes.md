# Next release — unreleased

## Host notes — RC25 visual fixes (AIT-540 M1–M6)

- Combined entrance: top-anchored control frame with intrinsic notice below
  the field and feedback/status rows. The notice slot measures the actual
  processing-choice strings per width; its visible frame grows downward without
  moving those controls. Desktop layout reserves the fixed footer inside the
  configured host height, keeping the full notice above it. Phones show the first AI-disclosure
  sentence and a native-dialog disclosure. New additive copy key
  `copy.composerNoticeMore`: EN “More”, DE “Mehr”. Existing `aiNotice`,
  `copy.aiNotice` and `copy.settings.processingDetails` precedence is retained.
  Feedback and status reserve their longest real localized message per width.
- One consent line and link in the composer. The ready card shows status only;
  the voice bar asks nothing about consent before the mic gesture. A blocked
  microphone is named once in the composer, using existing
  `voiceMessagesNarrow.voiceMicDenied` / `voiceMicDenied` override precedence.
  Other voice failures remain in the voice bar; the composer retains call-ended
  status. German defaults use “Einwilligung” consistently: `ready.consent`,
  `ready.missing` (“Einwilligung nötig”), `ready.granted` (“Erteilt”), `clarify.consent`, `clarify.say.consent`,
  `voiceReasonsNarrow.{permission,consentWithdrawn,consentRevised,sessionRevoked}`,
  `reasons.{call-authorization-lost,session-revoked}` and
  `processingConsent.withdrawal`. Compact voice labels keep the 22-character
  bound: “Einwilligung ungültig”, “Einwilligung entzogen”, “Einwilligung geändert”.
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
  conversation pane to reveal the whole new offer (AIT-540 M6). Page scroll and
  keyboard focus are retained; no new host setting or event is needed.
