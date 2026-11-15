# Next release — unreleased

## Host notes

- AIT-507 adds opt-in server `host.emailOffer: { afterMessages: 1 | 2 }`
  (`{}` defaults to 2), published as `session.emailOffer`. The demo helper accepts
  the same `emailOffer` option in `createDemoHost`. Invalid thresholds
  fail at startup. Configure the existing UI verification and credit surfaces;
  email delivery, privacy capability and the daily visitor claim ports are
  required for an eligible offer.
- Before visitor input, the overview and empty Settings capture form are absent;
  saved-address Change/Delete remain reachable. The credits popover hides its
  email action only for unsaved addresses while capture is deferred, reserving
  its existing slot only when a next tier exists. Used-up visitors retain
  Settings capture before input, including in a new conversation; deferral
  follows credit receipts and changes. Saved-address confirmation stays reachable.
  The verification lock stays until
  confirmation. The host opener, assistant turns, documents, partials and
  duplicate messages cannot advance the offer's accepted-message count.
- The existing email-ask route accepts `why: 'offer'` with `show` or `dismiss`.
  The credit receipt and response add a private `emailOffer` record with
  `offered`, `open`, `dismissed`, `at`, `nextTier`, `deltaMicro`, and `revision`.
  One rolling-day visitor claim plus the durable conversation latch bounds the
  offer. The policy replaces `turn5`; low-credit behavior and claims remain
  independent.
- The inline assistant-side offer stays outside transcript events, model context
  and exports. It works during calls and on phones without disabling the
  composer or moving focus. Saving uses `aria-disabled` to preserve capture
  focus, including after a refused save. The opted-in confirmation dialog
  reserves pending-state row spacing before saving to keep the field, actions
  and dialog stable on acknowledgement. Existing give/confirm/lock, Send/Resend, Sent and
  Unlocked copy keys preserve host overrides. Collection renders the existing
  privacy notice and sends its required `noticeVersion`; saved addresses use
  `Verification.resend()` and retain Settings management. The helper requests a
  first link for a saved guest, or resends a pending link under its cooldown,
  without saving or replacing the address.
- With `emailOffer` configured, the demo's next-tier projection can offer a
  positive confirmation delta directly when saving provides no credit increase.
  `createDemoHost` forwards the option to `createVisitorCredits({ emailOffer })`.
  Without the policy, its tier projection stays unchanged. Save refusals use
  `verify.invalid` and mark the field invalid; other save failures use
  `email.failed`, saving uses `email.saving`, and confirmation-link failures
  after saving use `verify.deliveryFailed`. There are no new copy keys.
- The additive `@inspr/aithema-core/email-offer` subpath exports shared
  `emailOfferPolicy`, `emailOfferEligibility`, `visitorMessageCount` and
  `hasOfferVisitorInput` helpers for the server and UI, including packed consumers.
