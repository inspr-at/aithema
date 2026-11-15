# Next release — unreleased

## Host notes

- AIT-507 adds opt-in server `host.emailOffer: { afterMessages: 1 | 2 }`
  (`{}` defaults to 2), published as `session.emailOffer`. The demo helper accepts
  the same `emailOffer` option in `createDemoHost`. Invalid thresholds
  fail at startup. Configure the existing UI verification and credit surfaces;
  email delivery, privacy capability and the daily visitor claim ports are
  required for an eligible offer.
- Before visitor input, the overview and empty Settings capture form are absent;
  saved-address Change/Delete remain reachable. The verification lock stays until
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
  composer or moving focus. Existing give/confirm/lock, Send/Resend, Sent and
  Unlocked copy keys preserve host overrides. Collection renders the existing
  privacy notice and sends its required `noticeVersion`; saved addresses use
  `Verification.resend()` and retain Settings management. The helper requests a
  first link for a saved guest, or resends a pending link under its cooldown,
  without saving or replacing the address.
- The demo's next-tier projection can offer a positive confirmation delta
  directly when saving provides no credit increase. There are no new copy keys
  or public package exports.
