# Next release — unreleased

## Host notes

- AIT-505: additive `hasVisitorInput(session)` core export separates active visitor/document input from host or assistant text; `hasConversationInput` remains an alias. `conversationStarted` keeps its locale-locking meaning. UI `hostOpenerTurn(session)` and `openerTranscript(session, { visible = true })` project the entrance opener without changing the canonical transcript.

- AIT-505: optional server `opener: { en?: string, de?: string }` (plain text, ≤1000 characters per locale; blank/missing disables without fallback), published as snapshot `opener: { text, locale }`. Render-only after legacy Start or before input with `configure({ entrance: 'combined', ... })`; missing locale copy reserves no entrance transcript space; persisted once at first `/turns` or voice connected; device mode keeps it local. Six-line clamp reuses the localized full-reply dialog; no new copy key.
- AIT-505: canonical ID `host:opener`; reserved visitor `clientEventId` namespace `host:`. `/turns` adds `event` and ordered `events: [opener, turn]` or `[turn]`, retaining legacy event-shaped fields and replay ordering. SSE peers receive both in order. Existing histories are unchanged; persistence pins locale.
- AIT-505: host assistant provenance `origin: 'host'`, without producer/operation identity, survives core/storage/JSON export. Markdown labels it `assistant (host)`; AI-generated labels stay unchanged. Model context includes the delivered host turn and continuation guidance.
- AIT-505: opted-in ElevenLabs hosts without custom `voice.presentation` speak the opener only on fresh first contact; startup disclosure validation fails closed. Custom presentation wins. Text-first, later calls and automatic repair never repeat it; corrections record interruption metadata without changing host text. This reverses AIT-175's visual/spoken separation for those opted-in hosts. Grok remains text-only (`opener: false`); speech is follow-up work.

- AIT-505: opted-in public `session.locale-changed` events carry `data.opener: { text, locale } | null` so the requesting and peer tabs resolve pre-input copy immediately, without a full restore or journal persistence of host text. Current snapshots also refresh the render-only projection.
