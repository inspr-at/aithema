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

- AIT-505: additive `hasVisitorInput(session)` core export separates active visitor/document input from host or assistant text; `hasConversationInput` remains an alias. Existing workspace display triggers (withdrawn input, pending uploads and ordinary assistant greetings/streaming) remain visible without satisfying assessment/admission thresholds; a host-only opener does not reveal the overview. `conversationStarted` keeps its locale-locking meaning. UI `hostOpenerTurn(session)` and `openerTranscript(session, { visible = true })` project the entrance opener without changing the canonical transcript.

- AIT-505: optional server `opener: { en?: string, de?: string }` (plain text, ≤1000 characters per locale; blank/missing disables without fallback), published as snapshot `opener: { text, locale }`. Render-only after legacy Start or before input with `configure({ entrance: 'combined', ... })`; missing locale copy reserves no entrance transcript space; persisted once at first `/turns`, first terminal upload (accepted or unreadable, in the same transaction before document-driven reply dispatch), or voice connected; device mode keeps it local. Six-line clamp reuses the localized full-reply dialog, available in text/device mode without a voice provider; invalidation/erasure immediately closes and clears copied full text. Additive EN/DE `hostOpenerTitle` and `hostOpenerTextOnly` copy keys label the welcome-message full-text dialog; host overrides win.
- AIT-505: canonical ID `host:opener`; reserved visitor `clientEventId` namespace `host:`. For hosts with an opener configured, `/turns` adds `event` and ordered `events: [opener, turn]` or `[turn]`, retaining legacy event-shaped fields and replay ordering. SSE peers receive both in order. Hosts without an opener keep their exact legacy response and presentation context. Pending/refused/withdrawn uploads do not claim an opener. Existing histories are unchanged; persistence pins locale.
- AIT-505: host assistant provenance `origin: 'host'`, without producer/operation identity, survives core/storage/JSON export. Markdown labels it `assistant (host)`; AI-generated labels stay unchanged. Model context includes the delivered host turn and continuation guidance.
- AIT-505: opted-in ElevenLabs hosts without custom `voice.presentation` speak the opener only on fresh first contact; startup disclosure validation fails closed. Custom presentation wins. Text-first, later calls and automatic repair never repeat it; corrections record interruption metadata without changing host text, with heard length bounded by canonical text. Opted-in credits-policy sessions suppress opener speech and new voice persistence after any earlier logical call, including refused admission or failed startup that never connected. Automatic recovery never newly persists the opener. This reverses AIT-175's visual/spoken separation for those opted-in hosts. Grok remains text-only (`opener: false`); speech is follow-up work.

- AIT-505: opted-in public `session.locale-changed` events carry `data.opener: { text, locale } | null` so the requesting and peer tabs resolve pre-input copy immediately, without a full restore or journal persistence of host text. Current snapshots also refresh the render-only projection.
### Credit-only conversations (AIT-508, opt-in)

Set the server host option `conversationLimit: 'credits'` to keep funded
conversations open across bounded voice calls. The library default remains
`'time'`, with the existing one-hour conversation deadline and unchanged legacy
wire shapes. The demo server explicitly opts in. `createCredits` also accepts
`conversationLimit`; untimed guards persist `timed: false`, retain `endsAt: null`,
and publish `remainingMs: null`. Paid work still requires an active, unpaused
guard and all existing consent, wallet, ledger, session, visitor and deployment
checks. Text continues in the same conversation while credits permit it.

At startup, eligible `ready` and `active` timed guards migrate once, before
checking elapsed time. `credits.guard-migrated` carries
`{sessionId, conversationLimit: 'credits', timed: false}` and commits atomically
with the guard and its `credits.state` projection. The reducer's trusted
`guard-migrate` event accepts the same monotonic host `now` as other credit
events. `ending` and `ended` guards remain export-only. Switching the host back
to `'time'` retains already-pinned untimed guards; only fresh guards use time.
`conversationLimits.policy(sessionId)` reads this pinned admission policy.
The runtime’s synchronous `assertFreshVoice(sessionId)` checks fresh-call eligibility.

Every fresh voice call still gets a new identity, full admission, reservation,
and per-call duration bound. Opted-in browser receipts and trusted plugin start
options add `conversationLimit: 'credits'`. Only those start options may also
carry server host `voiceIdleSeconds` (integer 60–3600, default 120); the host
value overrides standalone composed `config.voiceIdleSeconds`. The latter is
also validated at factory creation. ElevenLabs retains its provider-owned
120-second silence timeout: the server cannot directly stop provider spend
between browser and provider. Mock qualification covers SDK `end_call`, native
tool and normal close-code shapes. Silence ends classify as `idle` without
paid transport recovery. Generic terminal signals allow a 10-second margin
for final-transcript delivery lag against the provider's 120-second silence
timeout; this qualifies an end signal and does not start a browser idle timer.
Other transport failures retain existing recovery.

Composed calls end server-side after the idle window without an accepted final
speech or typed turn. Pending assistant output postpones idle only while the
call is active. Natural assistant output completion starts a full idle window;
paused/waiting or interrupted output keeps the existing idle deadline, so holds
still release even if reasoning remains pending.
Heartbeats and media noise do not reset idle. Opted-in terminal snapshots and
stored calls retain the terminal `reason`, including `idle`; `voice.state`
may carry that additive end reason. Idle and `timeLimit: 'call'` ends keep the
conversation controls usable. Start/Retry starts another bounded call;
no new Continue control is introduced.

A fresh opted-in call waits with `budget reconciling` until the session's prior
voice claim is finally reconciled, including unknown or estimated receipts,
even when spare credit and duration remain. `SQLiteBudgetLedger.hasUnreconciledVoice`
uses ledger finality (including reconciliation), not stale provider-record
flags. Opted-in duration claims add trusted `voiceEstimate.callId`; ledger
admission checks the pinned guard and excludes other unresolved call IDs inside
its SQLite transaction, while allowing segments of the same logical call.
Same-logical-call recovery retains its admission path and original
spend bound. Snapshot verdicts exclude the session's current, not-ended logical
call from the single-call reconciliation check, retaining Resume, Take back
and native last-reply availability. Fresh starts still check all prior calls
and pass full admission. A confirmed ledger settlement refreshes post-call
availability even when text was already available and no allowance changed.
No new call can release or replace an earlier liability.

Fresh opted-in calls after a prior logical call have `presentation:
'continuation'`, even with an empty transcript. `prepareCallback` and host
`presentation(locale, context)` add `hasPriorCalls: true` for these calls and
retain `hasPriorTurns: true`. A host's `spokenContinuations[locale]` wins;
otherwise the default is a neutral AI-disclosing continuation. Legacy greeting
fallback and silent automatic repair remain unchanged.

Additive EN/DE copy keys are `voiceIdleEnded` and
`voiceMessagesNarrow.voiceIdleEnded`. Their legacy fallback keys are `voiceEnded`
and `voiceMessagesNarrow.voiceEnded`; explicit host overrides keep precedence.
The existing `voiceTimeLimit` text and Start/Retry anchors remain in use.

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
