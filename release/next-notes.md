# Next release — unreleased

## Host notes

- AIT-517 adds optional `sidebar-contact` and `contact-launcher` slots. Fill them
  before mount/configure. The pinned row is outside scrolling analysis and the
  E‑Mail ask pane; empty consumes zero height. It scrolls independently with a
  30% desktop cap / 14rem stacked cap. The desktop reading pane retains at least
  40% of the sidebar; contact scrolls within the remaining reserved space.
  Late insertion or growth is outside the
  reserved-geometry contract. The header launcher remains reachable before input,
  during the sidebar reveal, when folded, below 60rem, or without pinned content;
  while desktop pinned content is available it leaves Tab order but retains its 44 px reservation.
- **First-paint contract:** launcher hosts reserve 44 px more in
  `--aithema-header-actions-width` in render-blocking CSS on the placeholder and
  component (defaults 216 → 260 px desktop, 88 → 132 px below 600 px), with the
  matching `headerRailReservation({ actionsWidth: '260px' })` desktop threshold.
  Alternatively serve `firstPaintStyles` with
  `firstPaintMarkupFor({ contactLauncher: true })`, keeping its sibling placeholder
  through mount. `voice: false` still works; existing defaults and exports remain.
  Host CSS width overrides keep winning. The helper manages
  `--aithema-contact-launcher-width` (0 px by default, 44 px when declared);
  custom totals still use `--aithema-header-actions-width`.
- Contact content, click listeners, styling, accessible names, modal focus trap,
  Escape and focus return belong to the host. Besides the first-paint flag,
  there are no new configure options, event fields, contact events or exports.
  The library adds no contact form, handover request, AI processing or consent
  dependency. The mock demo keeps its CTA beside the neutral note in a compact
  row; its local dialog sends nothing. New EN/DE demo keys:
  `copy.host.slots.contact`, `copy.host.slots.contactNote`; its close button reuses
  `copy.host.outbox.close`. Host slot content and copy overrides retain ownership.

- AIT-537 / AIT-538 supersede RC25's voice-opener rules: a prior call requires a durable `voice:` receipt, not a credential mint or lifecycle row. First contact uses one authorized snapshot, an empty or host-opener-only transcript and no active visitor/document input. Accepted/unreadable documents and withdrawn history keep their existing boundaries: withdrawal erases assistant origin/content, so the remaining erased host turn is not eligible canonical host-only history. An unheard first call can re-greet under both policies; no second host turn is inserted. This reverses B5 for empty connected calls, including switching from a locale without an opener. Explicit Resume keeps continuation copy; automatic repair stays silent.
- AIT-538: additive `voice.presentation(locale, ctx)` field `ctx.hostOpener`, omitted outside eligible first contact or when disclosure fails. Return it verbatim as `{ agent: { language: locale, firstMessage: ctx.hostOpener } }` to select it. Exact text and locale are required; trims/wraps/language changes do not claim it. The reference `createElevenLabsVoiceHost` presentation does this automatically, so first-contact speech for hosts with an opener switches from voice-host `spokenOpeners` to handlers' `opener`. Custom presentations that ignore the field retain their speech.
- AIT-538: presentations gate opener disclosure per locale at startup and revalidate the exact offered string per call. A failing locale falls back to the presentation's own disclosing greeting, with value-free `{ event: 'voice.host-opener-fallback', locale }` logs; startup continues, the undisclosed opener is never spoken and the greeting is never suppressed by this fallback. Without a presentation, invalid disclosure still fails closed at startup.
- AIT-538: reference-wiring hosts selecting the opener now record `host:opener`, `origin: 'host'` in transcripts/exports instead of a browser-asserted greeting; mapped greeting finals no longer trigger `onTurn`. Mapping requires normalized text equality and no facade completion. Uploads completing during preparation share the same once-only canonical opener. A custom greeting plus an upload can still produce `[host:opener, custom greeting]`. Render-only-row stability is claimed only when an opener is actually persisted; custom presentations ignoring the field and failed-disclosure locales retain the existing limitation.
- AIT-537: under credits a retry after refused admission, failed startup or an unheard first call is an opening call and can speak the opener. **Credits hosts without an opener** also receive opening context/copy instead of continuation copy after those attempts; `ctx.hasPriorCalls: true` is now audible-only. Without an opener, time-policy output stays byte-identical to RC25. Admission, ledger, the one-unreconciled-call guard, reservations and spend are unchanged.
- AIT-537: every first-party manifest now declares optional `liveVoice.capabilities.opener`. ElevenLabs and dev-local/fake-voice declare `true`; Grok, Voxtral and both composed providers declare `false`, so the latter persist the text-only opener at first-contact connect. Undeclared third-party providers are text-only with `{ event: 'voice.opener-undeclared', plugin: <id> }` once per ID per handler instance when selected for first contact; speaking providers must declare `true`. No public schema requirement is added.
- AIT-537 lifecycle: configuration-refused recovery or explicit Resume before a provider starts retains RC25's terminal close, aborts logical authority and publishes `voice.state` with `state: 'ended'` to peer tabs, allowing a fresh start from another tab. A fresh start refused by configuration before a provider call exists publishes `ended` directly: it skips `onClose` (and its concept `conversation-ended` event), `stopReplyReplay`, and the `closing` publication.
- AIT-537 hardening: failed fresh startup before a call exists ends and publishes its lifecycle (`voice.state`, `state: 'ended'`, `reason: 'start-failed'`, or the existing configuration-refusal reason), with starting `epoch` and `controllingTabId`, guarded by that epoch so takeover survives. Storage adds `hasAudibleVoiceCall(sessionId)` and removes unused `hasConnectedVoiceCall`; reserved `voice:` typed event IDs and `host:` voice turn IDs are rejected. No new copy keys or UI surfaces.
