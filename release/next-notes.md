# Next release — unreleased

## Host notes

- AIT-537 / AIT-538 supersede RC25's voice-opener rules: a prior call requires a durable `voice:` receipt, not a credential mint or lifecycle row. First contact uses one authorized snapshot, an empty or host-opener-only transcript and no active visitor/document input. Accepted/unreadable documents and withdrawn history keep their existing boundaries: withdrawal erases assistant origin/content, so the remaining erased host turn is not eligible canonical host-only history. An unheard first call can re-greet under both policies; no second host turn is inserted. This reverses B5 for empty connected calls, including switching from a locale without an opener. Explicit Resume keeps continuation copy; automatic repair stays silent.
- AIT-538: additive `voice.presentation(locale, ctx)` field `ctx.hostOpener`, omitted outside eligible first contact or when disclosure fails. Return it verbatim as `{ agent: { language: locale, firstMessage: ctx.hostOpener } }` to select it. Exact text and locale are required; trims/wraps/language changes do not claim it. The reference `createElevenLabsVoiceHost` presentation does this automatically, so first-contact speech for hosts with an opener switches from voice-host `spokenOpeners` to handlers' `opener`. Custom presentations that ignore the field retain their speech.
- AIT-538: presentations gate opener disclosure per locale at startup and revalidate the exact offered string per call. A failing locale falls back to the presentation's own disclosing greeting, with value-free `{ event: 'voice.host-opener-fallback', locale }` logs; startup continues, the undisclosed opener is never spoken and the greeting is never suppressed by this fallback. Without a presentation, invalid disclosure still fails closed at startup.
- AIT-538: reference-wiring hosts selecting the opener now record `host:opener`, `origin: 'host'` in transcripts/exports instead of a browser-asserted greeting; mapped greeting finals no longer trigger `onTurn`. Mapping requires normalized text equality and no facade completion. Uploads completing during preparation share the same once-only canonical opener. A custom greeting plus an upload can still produce `[host:opener, custom greeting]`. Render-only-row stability is claimed only when an opener is actually persisted; custom presentations ignoring the field and failed-disclosure locales retain the existing limitation.
- AIT-537: under credits a retry after refused admission, failed startup or an unheard first call is an opening call and can speak the opener. **Credits hosts without an opener** also receive opening context/copy instead of continuation copy after those attempts; `ctx.hasPriorCalls: true` is now audible-only. Without an opener, time-policy output stays byte-identical to RC25. Admission, ledger, the one-unreconciled-call guard, reservations and spend are unchanged.
- AIT-537: every first-party manifest now declares optional `liveVoice.capabilities.opener`. ElevenLabs and dev-local/fake-voice declare `true`; Grok, Voxtral and both composed providers declare `false`, so the latter persist the text-only opener at first-contact connect. Undeclared third-party providers are text-only with `{ event: 'voice.opener-undeclared', plugin: <id> }` once per ID per handler instance when selected for first contact; speaking providers must declare `true`. No public schema requirement is added.
- AIT-537 lifecycle: configuration-refused recovery or explicit Resume before a provider starts retains RC25's terminal close, aborts logical authority and publishes `voice.state` with `state: 'ended'` to peer tabs, allowing a fresh start from another tab. A fresh start refused by configuration before a provider call exists publishes `ended` directly: it skips `onClose` (and its concept `conversation-ended` event), `stopReplyReplay`, and the `closing` publication.
- AIT-537 hardening: failed fresh startup before a call exists ends and publishes its lifecycle (`voice.state`, `state: 'ended'`, `reason: 'start-failed'`, or the existing configuration-refusal reason), with starting `epoch` and `controllingTabId`, guarded by that epoch so takeover survives. Storage adds `hasAudibleVoiceCall(sessionId)` and removes unused `hasConnectedVoiceCall`; reserved `voice:` typed event IDs and `host:` voice turn IDs are rejected. No new copy keys or UI surfaces.

- AIT-509: visual consent text is now silent at idle for all hosts. The bound
  rail keeps its sizers; Settings keeps per-feature status and withdrawal.
- Combined desktop composers and overview panes retain the fixed footer inset,
  accounting for the configured component height and position, keeping controls above
  the footer throughout consent transitions.
- Validated visual requests blocked only by consent offer a just-in-time ask in
  the reserved rail slot. Its memory-only continuation expires within three
  minutes and needs a newer authoritative covering grant; cancellation, review,
  decline, navigation, superseding input and source/session/settings changes do
  not dispatch. Start's intent implementation and voice gesture rules stay as-is.
- `aithema-consent` adds `reason: 'use', intent: 'concept'`. Both fields are open
  enums; unknown values mean review. A host may grant the items mapped by
  the consent document's `features.images` in its own combined Start consent to avoid a later ask.
  No image-input consent item is added by this change.
- New component methods `openConsent(feature, opener?)` and `cancelConsent()` let
  hosts use the existing in-page editor or dismiss a pending concept. The demo
  uses the in-page editor; the navigating Start test host remains.
- Copy adds `conceptConsent`, `conceptDraftConsent` and `conceptConsentAction`
  in EN/DE. Image and HTML-draft asks are impersonal. Host overrides win, including
  legacy `featureConsent.images` / `featureConsent.html` / `featureConsent.action`.
- Wishes made before readiness keep their just-in-time ask when readiness arrives
  on a later turn. The continuation binds to the latest visitor turn and input
  revision when shown; waiting for readiness carries no consent action.
- `ConceptLane` adds optional `consentRequired(session, visualKind)` preflight.
  `concept.state.status.consentRequest: {id, sourceTurnId}` is additive metadata
  on `phase: 'waiting'`; it carries no durable grant or automatic retry.

- AIT-514: the existing `copy.summary` heading is visible with new EN/DE defaults,
  “Understood so far” / “Bisher verstanden”. Host overrides win.
- Additive `copy.summaryMore`: “Read more” / “Mehr anzeigen”; shared
  `copy.showLess`: “Show less” / “Weniger anzeigen”. Missing keys use locale
  fallbacks. Long summaries use a measured height-aware clamp and fade: nine
  lines in tall panes, otherwise three to nine whole lines based on the pane,
  heading row, first signal and 44 px bottom fade space whenever rendered content
  follows the first signal. The budget is independent of scrolling and is
  remeasured on resize, font and locale changes.
  If three lines still leave the first signal below the fold (1024×640), the
  clamp stays at three and the signal remains reachable by scrolling the pane.
  The accessible native expand/collapse button stays beside the heading in both
  states. Long host toggle labels are visually ellipsized within half the row;
  their complete accessible names remain available. Expansion survives rewrites within
  the mounted conversation and resets on a different conversation or erasure.
- Summary and signal prompt guidance now addresses the visitor with “you” / “Sie”
  while preserving quoted evidence. No schema, event, option or export change.

- AIT-511/AIT-513: the transcript uses the remaining height and voice recovery
  notices appear as interactive transcript end content at every width. A voice
  binding reserves no empty notice row. Without a visible question card, an
  active desktop call retains its existing 108 px recovery region inside the
  transcript. Beside a card, only visible recovery content takes room; call
  start leaves the reply and its controls in place. Image visuals retain their 44 px bar;
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
  Combined disclosure/status slots retain their intrinsic reservations and the
  top-anchored notice grows downward; Send and mic stay pinned. The card margin is counted once outside the
  combined reading pane. Combined desktop retains the same fixed-footer clearance
  before and after entrance. At desktop heights up to 700 px it yields spare
  outer grid gaps, starts the field at 44 px and retains the full footer row
  plus a 4 px gutter. Intrinsic notice, feedback and status rows stay readable
  within the shared reply/card budget.
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
