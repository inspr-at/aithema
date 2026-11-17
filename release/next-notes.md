# Next release — unreleased

## Host notes

- AIT-511/AIT-513: the transcript uses the remaining height and voice recovery
  notices appear as interactive transcript end content at every width. A voice
  binding reserves no empty notice row. Image visuals retain their 44 px bar;
  unbound visuals reserve none. Short transcripts align at the top without a
  visible question card, and beside their question when a card is present. Transcript
  scrolling remains contained and suppresses native boundary rebound. A visible
  header voice message uses free room above short top-aligned conversations;
  the pane frame stays fixed. Notice growth clears obsolete retained space,
  and a deliberate transcript wheel gesture releases retained notice space.
- The composer grows upward with its draft, capped by 40% of the visual viewport
  and the reply/card budget; short phone viewports allow at most three lines.
  Short desktop viewports reduce outer spacing in both composer states; longer
  used-up copy scrolls in its body, keyboard-focusable only while overflowing.
  Attach, Send and the bottom edge stay fixed. Failed sends and answer-chip
  sends retain a separate draft and its size; accepted typed/device sends reset
  the matching draft. A next draft typed during a pending reply reserves its
  future question-card budget without resizing when that reply arrives.
  Follow mode re-pins; a resting transcript pointer wins
  and Latest exposes the occluded tail. Latest keeps its existing end-control
  slot without a question card and floats beside a visible card. Combined entrance
  shares this owner
  before and after input without treating an opener/draft as visitor input.
  Short desktop and keyboard layouts reserve compact scrollable disclosure/status
  slots; Send and mic stay pinned. The card margin is counted once outside the
  combined reading pane. Combined desktop retains the same fixed-footer clearance
  before and after entrance; short desktop feedback shares the reserved disclosure
  row.
- Additive measured CSS outputs on the workspace:
  `--aithema-composer-height` and `--aithema-composer-growth`. Added visitor content
  counts as growth; responsive viewport/keyboard/stage modes reset the empty
  baseline. Effective form changes re-pin following readers even if the field
  stays the same size. Hosts keep their
  existing height/theme/copy overrides. No new options, copy keys, events or
  package exports. Phone dock subtraction, card margin, notice end reservation
  and pointer slack remain distinct padding/clearance owners. A trailing phone
  conversation margin reserves only visitor growth to keep the stacked overview
  frame fixed.
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
  Accepted/unreadable documents do reveal the overview and Settings capture
  through core `hasVisitorInput`; they do not advance that message count.
  An opener alone cannot trigger low-credit forms, lines or confirmation actions.
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
  reserves pending-state row order, spacing and the localized hint slot before
  saving to keep the field, actions and dialog stable on acknowledgement. Existing give/confirm/lock, Send/Resend, Sent and
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
  `emailOfferPolicy`, `emailOfferEligibility` and `visitorMessageCount` helpers for the
  server and UI, including packed consumers.


- AIT-505: additive `hasVisitorInput(session)` core export separates active visitor/document input from host or assistant text; `hasConversationInput` remains an alias. Existing workspace display triggers (withdrawn input, pending uploads and ordinary assistant greetings/streaming) remain visible without satisfying assessment/admission thresholds; a host-only opener does not reveal the overview. `conversationStarted` keeps its locale-locking meaning. UI `hostOpenerTurn(session)` and `openerTranscript(session, { visible = true })` project the entrance opener without changing the canonical transcript.

- AIT-505: optional server `opener: { en?: string, de?: string }` (plain text, ≤1000 characters per locale; blank/missing disables without fallback), published as snapshot `opener: { text, locale }`. Render-only after legacy Start or before input with `configure({ entrance: 'combined', ... })`; missing locale copy reserves no entrance transcript space; persisted once at first `/turns`, first terminal upload (accepted or unreadable, in the same transaction before document-driven reply dispatch), or an eligible voice connection under the provider rules below; device mode keeps it local. Six-line clamp reuses the localized full-reply dialog, available in text/device mode without a voice provider; invalidation/erasure immediately closes and clears copied full text. Additive EN/DE `hostOpenerTitle` and `hostOpenerTextOnly` copy keys label the welcome-message full-text dialog; host overrides win.
- AIT-505: canonical ID `host:opener`; reserved visitor `clientEventId` namespace `host:`. For hosts with an opener configured, `/turns` adds `event` and ordered `events: [opener, turn]` or `[turn]`, retaining legacy event-shaped fields and replay ordering. SSE peers receive both in order. Hosts without an opener keep their exact legacy response and presentation context. Pending/refused/withdrawn uploads do not claim an opener. Existing histories are unchanged; persistence pins locale.
- AIT-505: host assistant provenance `origin: 'host'`, without producer/operation identity, survives core/storage/JSON export. Markdown labels it `assistant (host)`; AI-generated labels stay unchanged. Model context includes the delivered host turn and continuation guidance.
- AIT-505: opted-in ElevenLabs hosts without custom `voice.presentation` speak the opener only on fresh first contact; startup disclosure validation fails closed. Native connect persists it only when the callback selects it as this call's first spoken message. Custom presentation wins and its greeting persists normally; connect does not claim the unspoken host opener. Text-first, an earlier connected call (including an empty call in a missing locale), later logical credits calls and automatic repair suppress both opener speech and new voice persistence. Refused admission or failed startup consumes first contact under credits policy. Text/upload claims are unchanged. Greeting mapping also links an upload-claimed opener when upload completes between voice preparation and connection. Corrections retain canonical text with bounded heard length. This reverses AIT-175's visual/spoken separation for those opted-in hosts. Grok (`opener: false`) keeps its once-only text-only claim on a fresh first-contact connection and speaks no separate greeting; opener speech is follow-up work.

- AIT-505: opted-in public `session.locale-changed` events carry `data.opener: { text, locale } | null` so the requesting and peer tabs resolve pre-input copy immediately, without a full restore or journal persistence of host text. Current snapshots also refresh the render-only projection.
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
  Configured openers use the shared render-only `host:opener` row once; canonical
  persistence retains its row identity. The welcome stays above the composer and
  footer on short phones; processing details remain on the entrance scroll surface.
  The transcript height accounts for its sticky-header inset; native focus in an
  inline email offer preserves the offer and combined input positions.
  Saved addresses use a single line with visual ellipsis beside Resend; full
  address text remains available to assistive technology and in Settings.
  No new copy keys or exports.

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
