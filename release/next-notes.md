# Next release — unreleased

## Host notes

### Combined entrance (AIT-506)

- AIT-506: optional UI `configure({ entrance: 'combined' })`; default `'choice'`
  retains mode selection and Start. Combined mode shows text, mic and Send with
  the selected processing details and AI/voice disclosure from first paint,
  without ready mic/speaker rows. The attachment button is hidden. Chooser
  Continue confirms processing and focuses the field; Send/mic requests consent.
  The default choice entrance retains its Continue consent event.
- Combined Send/mic consent events use `reason: 'ready'`, `intent: 'start'` and
  `mode: 'text'` / `'voice'`; legacy text mode stays `'type'`. `required` keeps the
  selected blocked feature and `features` the complete requested list. Text
  consent does not grant voice scopes. Send locks and snapshots its draft until
  consent settles, then sends it once for an in-place covering grant.
- Both modes store the draft inside the AIT-501 one-use intent with its existing
  3-minute text / 60-second voice TTL, settings revision and same-tab `tabId`
  proof. A navigation return consumes the intent and restores the draft even
  without a grant, without sending or starting voice; a voice
  return focuses the composer mic for a fresh click. Expiry, erasure, withdrawal
  and a new conversation clear the intent and its pending draft. An ordinary
  unsent follow-up survives own, server and other-tab message withdrawals.
  A settings update cancels the old
  revision intent while preserving and unlocking the field draft.
- The composer mic starts a call when idle and delegates capture mute/unmute to
  the rail during a call. Typing keeps capture running and typed turns use the
  same call/session/context. Consent precedes admission and permission. Reuses
  `voiceMessagesNarrow.voiceMicDenied` / `voiceMicDenied` and host overrides.
  Separate text-feedback and mic-status space is reserved from first paint, so
  failures, consent actions and Saved announcements remain visible and exposed
  to assistive technology alongside microphone denial or call-end status.
  No new copy keys or exports.

### Browser CI capacity (AIT-532)

- AIT-532: CI and nightly browser capacity expands from nine to twelve shards.
  A parallel `browser` aggregate requires the complete matrix to succeed;
  docs-only and verified duplicate-main pushes report explicit worker success.
  Both browser summaries retain `!cancelled()` and accept skipped workers only
  for verified first-attempt duplicate main pushes; PRs and merge groups require
  successful workers.
  The four required `browser (n/4)` aliases remain during the transition.
  The new aggregate is initially optional; DEVOPS changes the ruleset only after
  owner approval, and aliases can be removed only after the coordinator confirms
  the switch. No GitHub settings change in this delivery. Timing/evidence artifact
  names use `N-of-12`, with historical timing imports retained. The 405 s planner
  target and 420 s hard ceiling are unchanged. There is no host API change.
  CI prepares the browser evidence directory before tests, and isolated evidence
  writers create their destination rather than depending on test order.
