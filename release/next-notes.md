# Next release — unreleased

## Host notes

- AIT-506: optional UI `configure({ entrance: 'combined' })`; default `'choice'`
  retains mode selection and Start. Combined mode shows text, mic and Send with
  the selected processing details and AI/voice disclosure from first paint,
  without ready mic/speaker rows.
- Combined Send/mic consent events use `reason: 'ready'`, `intent: 'start'` and
  `mode: 'text'` / `'voice'`; legacy text mode stays `'type'`. `required` keeps the
  selected blocked feature and `features` the complete requested list. Text
  consent does not grant voice scopes. Send locks and snapshots its draft until
  consent settles, then sends it once for an in-place covering grant.
- Both modes store the draft inside the AIT-501 one-use intent with its existing
  3-minute text / 60-second voice TTL, settings revision and same-tab `tabId`
  proof. A navigation return restores without sending or starting voice; a voice
  return focuses the composer mic for a fresh click. Expiry, erasure, withdrawal
  and a new conversation clear the draft.
- The composer mic starts a call when idle and delegates capture mute/unmute to
  the rail during a call. Typing keeps capture running and typed turns use the
  same call/session/context. Consent precedes admission and permission. Reuses
  `voiceMessagesNarrow.voiceMicDenied` / `voiceMicDenied` and host overrides.
  No new copy keys or exports.
