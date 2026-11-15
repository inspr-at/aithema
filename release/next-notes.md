# Next release — unreleased

## Host notes

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
