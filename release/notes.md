# Aithema 2026.10

Version **261118191311.0.0**. Licensed under **AGPL-3.0-only**.

A readable overview, more room for the conversation and a growing input field.
Image input and pinned contact are available where the host enables them.
AIT-505–AIT-508 remain independent host opt-ins; their defaults stay unchanged.

## What visitors notice

- **RC25 notes correction: AIT-540 scope and release trace.** The one consent
  line applies only in the combined entrance; revealing a new offer by scrolling
  into view additionally applies only on phones (≤600 px). The single email form
  and one-column offer apply only under `emailOffer`. The phone wording “am Handy”
  applies at ≤600 px. The RC25 pill “Calmer entrance layout” /
  “Ruhigere Startansicht” comes from AIT-540's stored ticket fields, read through
  the aeon CLI during the first preparation; the prior notes used an editorial
  “Clearer notices and phone offers” / “Klarere Hinweise und Angebote am Handy”
  heading instead. The scoped summary above replaces the broader RC25 summary.
  `ready.granted` is not an “Einwilligung” default: its DE default is “Erteilt”.
  RC25 C3 is `0106cae359bf95f3835e6a6e562dc1d85d00d5c6`; its ancestor is the
  amended `175276ec603cf663c2044416aa49bcafb48297f2`. Pre-amend
  `4df20e88e3ad7920f95f2ac19833fff5a8ecd2a4` is not an ancestor of C3; it shares
  tree `b380da40e69155edd1ab1fbcc2ccf944c238c511` with `175276ec`. Historical
  RC25 test references below retain their original commit IDs; the final C3
  candidate binds the amended chain.

- **Opener after retries (AIT-537, #449).** Visitors whose first call failed still hear the host's welcome. Where the host enables an opener and compatible voice presentation.
- **Opener with own copy (AIT-538, #449).** Hosts get their opener spoken first and keep their own welcome-back copy. Where the host enables an opener and compatible voice presentation.
- **No extra image prompt (AIT-509, #451).** Images no longer need a separate consent line above the chat; one consent covers them, or you are asked once when you actually use them.
- **Readable summary (AIT-514, #455).** The overview summary has a clear heading and a short first view, with Read more for the rest.
- **Contact always in reach (AIT-517, #456).** The host's contact option stays at the bottom of the sidebar instead of at the end of a long list. Only where the host supplies contact content.
- **Newest signals first (AIT-515, #453).** The overview shows the five newest signals first, highlights new ones briefly, and lets you show all of them.
- **Cancel returns control (AIT-542, #460).** Where the host enables the combined entrance, cancelling frees the field and keeps the draft only when the host calls `detail.cancel()` on dismissal or the visitor returns from a separate consent page without a grant. The default entrance remains `'choice'`.
- **Email offer always works (AIT-543, #461).** The email offer in the chat also works on sites that don't keep a visitor email store.
- **Attach images (AIT-510, #457).** You can attach images and screenshots by dropping, picking or pasting them, and the assistant takes their content into account. Only where the host enables image input: PNG, JPEG, WebP and GIF; HEIC is refused.
- **Full-height transcript (AIT-511, #459).** The conversation uses the whole available height, and the latest message is always fully visible above the input field. Follow reveals reply failures and Retry; resting readers retain their position.
- **Growing input field (AIT-513, #459).** The input field grows as you write longer messages and returns to its normal size after sending.
- **Signals stay readable (AIT-547, #462).** On laptop screens the overview's signals stay readable next to the contact button.
- **Visual polish (AIT-541, #463).** Small layout and wording details on the start and call screens are cleaned up. Findings 7–13 only.

The summary has a heading, a measured nine-line first view in tall panes and
three–nine lines in shorter panes, with Read more. Signals show the newest five
and briefly mark new exact-text identities; rewordings are new identities, not
semantic “updated” marks. The input grows up to about 40% of the viewport,
subject to room for the reply/card and a three-line cap on short phones.

## Was Besucher bemerken

- **Korrektur der RC25-Hinweise: AIT-540, Umfang und Release-Verweise.** Eine
  Einwilligungszeile gilt nur im kombinierten Einstieg; das Scrollen neuer Angebote
  ins Sichtfeld zusätzlich nur am Handy (≤600 px). Ein einzelnes E-Mail-Formular
  und einspaltige Angebote gelten nur unter `emailOffer`. „am Handy“ bezeichnet
  ≤600 px. Der RC25-Pill „Calmer entrance layout“ / „Ruhigere Startansicht“ stammt
  aus den gespeicherten AIT-540-Ticketfeldern, während der ersten Vorbereitung über
  die aeon CLI gelesen; die früheren Hinweise verwendeten stattdessen die
  redaktionelle Überschrift „Clearer notices and phone offers“ / „Klarere Hinweise
  und Angebote am Handy“. Diese eingegrenzte Zusammenfassung ersetzt die breitere
  RC25-Zusammenfassung. `ready.granted` ist kein „Einwilligung“-Standardtext:
  der DE-Standard lautet „Erteilt“. RC25 C3 ist
  `0106cae359bf95f3835e6a6e562dc1d85d00d5c6`; Vorfahr ist der angepasste Commit
  `175276ec603cf663c2044416aa49bcafb48297f2`. Der vorherige Commit
  `4df20e88e3ad7920f95f2ac19833fff5a8ecd2a4` ist kein Vorfahr von C3; er teilt
  Baum `b380da40e69155edd1ab1fbcc2ccf944c238c511` mit `175276ec`. Historische
  RC25-Testverweise behalten ihre ursprünglichen Commit-IDs; der endgültige
  C3-Kandidat bindet die angepasste Kette.
- **Begrüßung nach Neuversuch (AIT-537, #449).** Wer beim ersten Anruf scheiterte, hört trotzdem die Begrüßung. Bei aktivierter Host-Begrüßung und passender Sprachpräsentation.
- **Begrüßung mit eigenem Text (AIT-538, #449).** Hosts behalten ihre Begrüßung zuerst und ihren eigenen Wiederkehr-Text. Bei aktivierter Host-Begrüßung und passender Sprachpräsentation.
- **Keine Extra-Bildabfrage (AIT-509, #451).** Bilder brauchen keinen eigenen Zustimmungshinweis über dem Chat mehr; eine Zustimmung deckt sie ab, oder es wird einmal beim tatsächlichen Gebrauch gefragt.
- **Lesbare Zusammenfassung (AIT-514, #455).** Die Zusammenfassung im Überblick hat eine klare Überschrift und eine kurze erste Ansicht, mit „Mehr anzeigen“ für den Rest.
- **Kontakt immer erreichbar (AIT-517, #456).** Die Kontaktmöglichkeit des Anbieters bleibt unten in der Seitenleiste statt am Ende einer langen Liste. Nur bei vom Host bereitgestelltem Kontaktinhalt.
- **Neueste Hinweise zuerst (AIT-515, #453).** Der Überblick zeigt die fünf neuesten Hinweise zuerst, hebt neue kurz hervor und lässt alle anzeigen.
- **Abbruch gibt frei (AIT-542, #460).** Nur bei vom Host aktiviertem kombiniertem Einstieg wird nach einem Abbruch das Feld freigegeben und der Entwurf erhalten, sofern der Host `detail.cancel()` beim Abbruch aufruft oder die Rückkehr von einer separaten Einwilligungsseite ohne Freigabe erfolgt. Der Standard-Einstieg bleibt `'choice'`.
- **E-Mail-Angebot funktioniert (AIT-543, #461).** Das E-Mail-Angebot im Chat funktioniert auch auf Seiten ohne eigenen E-Mail-Speicher.
- **Bilder anhängen (AIT-510, #457).** Bilder und Screenshots lassen sich per Ziehen, Auswählen oder Einfügen anhängen, und der Assistent berücksichtigt ihren Inhalt. Nur bei vom Host aktivierter Bildeingabe: PNG, JPEG, WebP und GIF; HEIC wird abgewiesen.
- **Verlauf in voller Höhe (AIT-511, #459).** Das Gespräch nutzt die ganze verfügbare Höhe, und die neueste Nachricht ist immer vollständig über dem Eingabefeld sichtbar. Beim Folgen werden Antwortfehler und „Erneut versuchen“ sichtbar; beim Lesen bleibt die Position erhalten.
- **Mitwachsendes Eingabefeld (AIT-513, #459).** Das Eingabefeld wächst mit längeren Nachrichten mit und kehrt nach dem Senden zur normalen Größe zurück.
- **Signale bleiben lesbar (AIT-547, #462).** Auf Laptop-Bildschirmen bleiben die Signale neben dem Kontakt-Button lesbar.
- **Optischer Feinschliff (AIT-541, #463).** Kleine Layout- und Textdetails in Start- und Anrufansicht sind bereinigt. Nur Punkte 7–13.

Die Zusammenfassung zeigt eine Überschrift und zunächst neun Zeilen in hohen,
drei bis neun Zeilen in kürzeren Bereichen, mit „Mehr anzeigen“. Hinweise
erscheinen mit den neuesten fünf zuerst; neue Textidentitäten werden kurz
hervorgehoben. Das Eingabefeld wächst bis etwa 40% der Fensterhöhe, begrenzt
durch den Platz für Antwort und Fragekarte; auf kurzen Handys höchstens drei
Zeilen. Bildeingabe, Kontaktinhalt und AIT-505–AIT-508 erscheinen nur bei
entsprechender Host-Aktivierung.

## For hosts

- AIT-547: short desktop overviews with pinned contact content reserve the
  natural height of the longest resolved status for the current width, font
  and language. This keeps status text and actions readable without moving
  the summary between states, and recovers room for the first collapsed signal.
  Scrolling fades clear heading rows and their controls. Separate verification
  entrances retain their natural height.

- AIT-543 (RC26): hosts without a visitor email store now get working in-chat offers via the identity command.
  This is a bug fix with no new opt-in flag. Explicit `visitorEmail.canSave: false`
  uses the lock form's request/change rule and never PUTs visitor email for
  in-chat offers; low-credit/turn-5 asks still PUT (planned (AIT-549)). EN/DE
  copy promises additional credit only at confirmation, with identity send,
  failure, resend and 429 behavior. Hosts with a store retain save-before-confirm.
  The fallback is scoped to in-chat offers; low-credit and turn-5 asks keep their
  existing save behavior.

- AIT-542: additive `aithema-consent` detail fields `requestId` (unique per
  request) and idempotent `cancel()` let a host settle a dismissed `start`
  consent request. For other intents `cancel()` is a no-op for intent state;
  concepts keep their existing TTL and later grant continuation. In the
  combined entrance, cancellation returns the field, Send
  and mic to idle within one animation frame and keeps the visitor's draft.
  It does nothing after a grant, TTL expiry, a superseding request or a prior
  cancellation. Never call it after granting: the component's fence is receipt
  of `consent.revised`, which can follow the host's grant action. Hosts ignoring
  the new fields retain the existing TTL behavior.
  Returning from a separate consent page without a grant consumes the intent
  as cancellation and restores the draft without sending or starting voice;
  cached-page returns now use the restore check even if the feature read fails.
  This clarifies RC25's “deleted on use or cancellation”: explicit host dismissal
  is settled by `detail.cancel()`; expiry still discards the pending draft.

- AIT-517 adds optional `sidebar-contact` and `contact-launcher` slots. Fill them
  before mount/configure. The pinned row is outside scrolling analysis and the
  E‑Mail ask pane; empty consumes zero height. It scrolls independently with a
  30% desktop cap / 14rem stacked cap. The desktop reading pane retains at least
  40% of the sidebar; contact scrolls within the remaining reserved space.
  Late insertion or growth is outside the
  reserved-geometry contract. The header launcher remains reachable before input,
  during the sidebar reveal, when folded, below 60rem, or without pinned content;
  while desktop pinned content is available in windows at least 48rem tall it
  leaves Tab order but retains its 44 px reservation. Short desktop windows keep
  the launcher visible and remove the pinned row from layout and Tab order
  only when the launcher slot is filled; one condition switches both controls.
  Row-only hosts retain the pinned contact through short desktop windows and
  the sidebar entrance. Compact short-window spacing and sidebar chrome keep
  the foot inside the frame.
  The launcher fades and becomes inert during the About reveal, like Settings;
  the phone contact row and personal-conversation action clear the fold chevron
  with a 44 px left inset.
- **First-paint contract:** launcher hosts reserve 44 px more in
  `--aithema-header-actions-width` in render-blocking CSS on the placeholder and
  component (defaults 216 → 260 px desktop, 88 → 132 px below 600 px), with the
  matching `headerRailReservation({ actionsWidth: '260px' })` desktop threshold.
  Alternatively serve `firstPaintStyles` with
  `firstPaintMarkupFor({ contactLauncher: true })`, keeping its sibling placeholder
  through mount. `voice: false` still works; existing defaults and exports remain.
  Host CSS width overrides keep winning. The helper manages
  `--aithema-contact-launcher-width` (0 px by default, 44 px when declared);
  custom totals still use `--aithema-header-actions-width`. Both library rail defaults
  have zero specificity so host `headerRailReservation` overrides win.
- Contact content, click listeners, styling, accessible names, modal focus trap,
  Escape and focus return belong to the host. Besides the first-paint flag,
  there are no new configure options, event fields, contact events or exports.
  The library adds no contact form, handover request, AI processing or consent
  dependency. The mock demo keeps its CTA beside the neutral note in a compact
  row; its header launcher is a plain icon with an EN/DE accessible name and its
  local dialog sends nothing. The dialog shares the Settings top anchor; README
  documents the recommended responsive offsets for host-owned dialogs. New EN/DE demo keys:
  `copy.host.slots.contact`, `copy.host.slots.contactNote`; its close button reuses
  `copy.host.outbox.close`. Host slot content and copy overrides retain ownership.

- AIT-537 / AIT-538 supersede RC25's voice-opener rules: a prior call requires a durable `voice:` receipt, not a credential mint or lifecycle row. First contact uses one authorized snapshot, an empty or host-opener-only transcript and no active visitor/document input. Accepted/unreadable documents and withdrawn history keep their existing boundaries: withdrawal erases assistant origin/content, so the remaining erased host turn is not eligible canonical host-only history. An unheard first call can re-greet under both policies; no second host turn is inserted. This reverses B5 for empty connected calls, including switching from a locale without an opener. Explicit Resume keeps continuation copy; automatic repair stays silent.
- AIT-538: additive `voice.presentation(locale, ctx)` field `ctx.hostOpener`, omitted outside eligible first contact or when disclosure fails. Return it verbatim as `{ agent: { language: locale, firstMessage: ctx.hostOpener } }` to select it. Exact text and locale are required; trims/wraps/language changes do not claim it. The reference `createElevenLabsVoiceHost` presentation does this automatically, so first-contact speech for hosts with an opener switches from voice-host `spokenOpeners` to handlers' `opener`. Custom presentations that ignore the field retain their speech.
- AIT-538: presentations gate opener disclosure per locale at startup and revalidate the exact offered string per call. A failing locale falls back to the presentation's own disclosing greeting, with value-free `{ event: 'voice.host-opener-fallback', locale }` logs; startup continues, the undisclosed opener is never spoken and the greeting is never suppressed by this fallback. Without a presentation, invalid disclosure still fails closed at startup.
- AIT-538: reference-wiring hosts selecting the opener now record `host:opener`, `origin: 'host'` in transcripts/exports instead of a browser-asserted greeting; mapped greeting finals no longer trigger `onTurn`. Mapping requires normalized text equality and no facade completion. Uploads completing during preparation share the same once-only canonical opener. A custom greeting plus an upload can still produce `[host:opener, custom greeting]`. Render-only-row stability is claimed only when an opener is actually persisted; custom presentations ignoring the field and failed-disclosure locales retain the existing limitation.
- AIT-537: under credits a retry after refused admission, failed startup or an unheard first call is an opening call and can speak the opener. **Credits hosts without an opener** also receive opening context/copy instead of continuation copy after those attempts; `ctx.hasPriorCalls: true` is now audible-only. Without an opener, time-policy output stays byte-identical to RC25. Admission, ledger, the one-unreconciled-call guard, reservations and spend are unchanged.
- AIT-537: every first-party manifest now declares optional `liveVoice.capabilities.opener`. ElevenLabs and dev-local/fake-voice declare `true`; Grok, Voxtral and both composed providers declare `false`, so the latter persist the text-only opener at first-contact connect. Undeclared third-party providers are text-only with `{ event: 'voice.opener-undeclared', plugin: <id> }` once per ID per handler instance when selected for first contact; speaking providers must declare `true`. No public schema requirement is added.
- AIT-537 lifecycle: configuration-refused recovery or explicit Resume before a provider starts retains RC25's terminal close, aborts logical authority and publishes `voice.state` with `state: 'ended'` to peer tabs, allowing a fresh start from another tab. A fresh start refused by configuration before a provider call exists publishes `ended` directly: it skips `onClose` (and its concept `conversation-ended` event), `stopReplyReplay`, and the `closing` publication.
- AIT-537 hardening: failed fresh startup before a call exists ends and publishes its lifecycle (`voice.state`, `state: 'ended'`, `reason: 'start-failed'`, or the existing configuration-refusal reason), with starting `epoch` and `controllingTabId`, guarded by that epoch so takeover survives. The exported `SQLiteStorage` adds `hasAudibleVoiceCall(sessionId)` and removes its undocumented public method `hasConnectedVoiceCall`; this is a host-visible API removal; reserved `voice:` typed event IDs and `host:` voice turn IDs are rejected. No new copy keys or UI surfaces.

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

- New public module `@inspr/aithema-plugin-image-input` (17 modules total), with
  pinned sharp 0.35.5 and platform-specific native/libvips dependencies. Install
  optional binaries in production. Docker and CI run the production-only fixture
  qualifier; see NOTICES.json for Apache-2.0/LGPL and transitive declarations.
- PNG/JPEG/WebP/GIF first frame only; no HEIC. Per-preset
  `imageInput: { plugin: 'image-input' }` selects the local normalizer. Each
  reasoning lane binding separately declares
  `imageInput: { maxImages, maxTokensPerImage, perImageMicro? }`; missing
  capability refuses image dispatch. Demo environment:
  `AITHEMA_OPENROUTER_IMAGE_INPUT` (model-keyed JSON). Fees enter reservations and
  OpenRouter's per-image provider price cap.
- New optional consent item `image-input`, feature `imageInput`, and demo contract
  string. Existing model item stays version 1. Granting/withdrawing image input
  preserves replies; withdrawing it erases pixels. Granting both `images` and
  `image-input` in a host's start consent avoids any later consent line or ask.
  Explicit host feature mappings and copy overrides keep precedence.
- Additive `aithema-consent` values `reason: 'use'`, `intent: 'attach'` and
  `features: ['imageInput', ...]`; file selection waits in memory for at most
  three minutes. Reason and intent are open enums.
- Upload states `staged-pending`, `staged-ready`, `staged-refused`, and
  `staged-discarded` are non-input. Thirty-minute orphan expiry/removal/session
  switch discard without cascade or model work. Sent images use withdrawal.
  Metadata adds kind/digest/w/h/expiresAt; turn events add attachments.
- `/turns` accepts up to four owned ready `attachments` IDs and blank text with
  attachments; atomic send and retry receipts include the IDs. Live-call image
  sends return `image-live-call`. Image-only purpose classification is neutral.
  `maxImagesPerSession`/`AITHEMA_UPLOAD_MAX_IMAGES` default to eight, independently
  of documents; byte ceilings remain shared.
- New owner-authenticated no-store `GET /uploads/:id/image`, fixed staging tiles
  and reserved transcript thumbnail boxes, revocable blob URLs, and normalized
  image files in ZIP export under images/. Bytes stay outside JSON/events/logs.
  In both entrance modes, staging grows above the bottom-anchored controls;
  asynchronous preparation and refusals retain the reserved layout. Combined
  image-capable composers reserve the bounded refusal feedback row while the
  disclosure keeps its natural height.
- Image requests retain references until dispatch, use at most four images from
  the last two user turns, and leave draft understanding text-only. One shared
  text-plus-image token helper serves all three admission/settlement/pricing sites.
  The text-only Reasoning contract remains unchanged. Additive image types,
  image-input core subpath/helpers, manifest kind and normalize operation are
  listed in README.md.
- New EN/DE copy: imageConsentJit, imageInputFeature, imagePreparing, imageRemove,
  imageLiveCall, imageUnsupportedModel, imageWithheld, uploadsSupported,
  uploadsReselect (plural), imageRefusals and their per-reason entries (including batch limits),
  features.imageInput, featureConsent.imageInput, processingConsent.items.image-input,
  plus native/capability refusal reasons. `uploads.limits` keeps RC25's
  documents-only wording; additive `uploads.limitsWithImages` supplies format
  and retention help only for image-capable composers, including pending consent.
  A nondefault host `uploads.limitsWithImages` override wins, followed by a
  nondefault host `uploads.limits` override, then the active locale's bundled
  image help (English fallback). Both keys accept `{files}` and `{size}`.
  Document-only composers use their existing `uploads.limits` override directly.
  Refusals persist through typing in the bounded reason slot, below blocking
  failures and attach-time consent. README documents every additive host surface.

- Lower-level additions: storage turnReceipt/imageUpload/expireStagedUploads,
  postTurn guard.attachments, completeUpload image results, upload-handler now
  and cancelImages, runtime imageInputAvailability/normalizeImageUpload,
  exportSession images, reasoningRequest imageOnly, and dispatch-only
  createChatCompletions prepareDispatch/resolveImage/imageDispatchCurrent.
  Unsupported image filenames stay in the non-input refusal path even for
  direct multipart callers; the format help line lists the exact accepted types.
  Named documents retain byte-sniffed document admission despite false image
  MIME hints; actual image bytes always select image staging.

- On image-capable hosts, extensionless files labelled with an image MIME type
  and excluded HEIC/AVIF containers stay in the staged, non-input refusal path;
  they never fall through to document extraction or schedule model work. On
  document-only hosts, server-classified images instead refuse the whole upload
  POST before staging, including eligible documents in that POST; planned
  (AIT-559). HEIC remains unsupported.

- Staged image states are excluded from the append-only voice callback fence;
  attaching, preparing, refusing or discarding an image cannot reject that reply.

- AIT-510 follow-up: image-only OpenRouter input omits blank text blocks. A switch
  to a text-only model or preset replaces earlier image references with text
  markers before estimation, reservation and dispatch, preserving text replies
  and understanding. Device mode refuses unsent staged images without dropping
  their files or caption. Mixed selections continue eligible document uploads,
  except when an extensionless image or a file typed `image/*` is classified as
  an image by the server: on document-only hosts this refuses the whole upload
  POST, including eligible documents in that POST; planned (AIT-559).
  These composers use the existing
  document type refusal for every non-document file, including PNG, JPEG and
  HEIC, with no image-format help or image-retention wording. Existing document
  upload-consent wording remains. Image-capable composers retain distinct
  admission refusals; while paused, images are refused with “Images cannot be
  attached while the conversation is paused.” Selection and paste retain
  `imageRefusals.paused`; other files use the generic Attach refusal during a
  pause. Capability reads use the unpaused verdict, while attachment admission
  still respects the pause. Server snapshots whose outer `imageInput.reason`
  is `session paused` include `imageInput.unpaused` with the ordinary
  `available` and `reason` fields for presentation.
- Image refusal feedback reserves the longest localized reason and shows it
  once. Remove targets stay outside thumbnails with filename-aware EN/DE names;
  short phones use one compact staging row around 44 px controls. Withheld-image copy `imageWithheld`
  reads “Image not sent” / “Bild nicht gesendet”; `imageRefusals.paused` is additive.
  Image-capable Attach describes selection before consent. Only image-capable
  composers add image-format help to unknown file refusals. Composers whose
  current binding cannot take images retain RC25's documents-only Attach title
  and description, picker accept list and type refusal, including after a binding
  switch; no image-format help or image-retention wording appears. Attachment
  help uses the copy precedence documented above.
  Composer growth retains transcript follow and whole-item reading alignment;
  the combined short-phone transcript reserves eight pixels below its content.
  Successful document uploads preserve image refusals from the same selection.
  Retained-file retry messages keep their existing facts and action order.
  Image-feedback measurement keeps the same width across text-consent and
  shortcut states, including 320/340 px, preserving the composer after a grant.
  On document-only bindings, the same mixed selection retains its document
  type refusal across document consent; only eligible document handles and
  bounded refusal metadata continue.
  Successful intake clears only feedback from earlier selections. Decoder
  failures from the current selection survive event/receipt ordering and batches.
  The hidden feedback measurement node is mounted only for active image input;
  hosts without it retain their existing composer DOM and geometry.
  Repeated inactive paints skip feedback DOM writes.
  In image-capable composers, full document-type notices and accepted formats
  share the measured image feedback reserve and wrap without the two-line cap
  or a trailing separator. The format sentence ends with a full stop in EN/DE.
  Composers without image input keep the existing document refusal, without
  image-format help, including after an image refusal or a switch to a binding
  without image input while the reserved layout remains mounted. Combined
  composers with document intake reserve the existing two-line feedback capacity before intake and retain it through pause/consent
  changes. This keeps wrapped document-only refusals stable while composers
  without uploads retain their natural feedback height.
  Only upload notices lift the reason cap; long host image-
  consent overrides still scroll inside their 44 px cap.
  `imageRefusals.malformed` now follows the filename with “is not a readable
  image.” / “ist kein lesbares Bild.”; host overrides keep precedence.
  This also covers native `unsupported` bytes behind an accepted extension;
  only UI wording changes, and native refusal codes remain unchanged.
  Multiple refused names keep a keyboard-scrollable two-line area; the full
  accepted-format sentence stays outside that area in the reserved slot.
- AIT-515: `understanding.signals` remains `string[]` and is now newest-first by
  first-seen server sequence, with stable provider-order ties. Current finals
  hide omitted texts; rewordings are new keys, without replacement IDs or an
  updated mark. Current lists retain the 24-item cap. First-N consumers and the
  import payload now receive newest signals first.
- Additive final-event/snapshot/export `understanding.signalItems` contains
  `{key,text,firstSeen,basis?}`; draft/reset items may contain only text/basis
  before final identity assignment. Model signals accept strict `{text,basis}` objects
  (`visitor | assistant | document`) and compatible untagged plain strings.
  Only assistant attribution shows an unconfirmed tag; it never confirms slots.
  `signalKey(text)` is an additive core root/understanding export for exact NFKC,
  lowercase, whitespace-collapsed identity.
- The server-owned snapshot `signalLedger` lives outside `understanding`, includes
  conservative `turnIds` / `uploadIds` dependencies and retains omitted identities.
  It survives upload, correction, locale and grant-only resets; source erasure,
  withdrawal and relevant consent withdrawal prune it. It uses erasable content
  references in storage; raw ledger text is excluded from journal metadata.
  Legacy snapshots seed identities from their current final. The historical
  ledger is not exported; current signalItems and ordered strings are.
- The signal overview starts at five, with a native total-count toggle and
  conversation-local expansion. The toggle stays right-aligned in the heading
  row with a stable box for both labels and an inset focus ring. The 32 px
  action extends evenly around the natural heading row, including when a sixth
  signal reveals it; compact list spacing also preserves clearance beside the
  combined composer footer. The first signal stays clear of the summary pane
  fade. The existing `signals` copy key uses “Signals” / “Signale” (DE previously “Was konkret
  erkennbar war”); host overrides still win. Assistant basis uses a muted
  “ · unconfirmed” / “ · unbestätigt” suffix with the shared nonbreaking
  separator; arrival marks use tint alone.
  Pointer/focus defer asynchronous list changes;
  source removal redacts immediately. One to three new keys get a two-second
  highlight (static with reduced motion); first/whole lists and reconnects stay
  quiet. New host-overridable EN/DE keys: `signalsAll` = `Show all ({n})` /
  `Alle anzeigen ({n})`, shared `showLess` = `Show less` / `Weniger anzeigen`,
  `signalUnconfirmed` = `unconfirmed` / `unbestätigt`. Missing keys fall back to
  the active locale. Summary/signal prompts use direct “you” / formal “Sie”,
  avoid provenance prose and preserve quoted evidence.

- AIT-511/AIT-513: the transcript uses the remaining height and voice recovery
  notices appear as interactive transcript end content at every width. A voice
  binding reserves no empty notice row. Without a visible question card, an
  active desktop call retains its existing 108 px recovery region inside the
  transcript. Beside a card, only visible recovery content takes room; call
  start leaves the reply and its controls in place. Image visuals retain their 44 px bar;
  unbound visuals reserve none. Short transcripts align at the top without a
  visible question card, and beside their question when a card is present. Explicit
  follow keeps otherwise-fitting short content at scroll zero even when hidden end
  reservations overflow; overflowing content retains the original Latest slot.
  Reply-failure rows retain their full wrapped text height, and follow includes
  their Retry. Transcript scrolling remains contained and suppresses native boundary rebound. A visible
  header voice message uses free room above short top-aligned conversations;
  the pane frame stays fixed. Notice growth clears obsolete retained space,
  and a deliberate transcript wheel gesture releases retained notice space.
- The composer grows upward with its draft, capped by 40% of the visual viewport
  and the reply/card budget; short phone viewports allow at most three lines.
  Short desktop viewports reduce outer spacing in both composer states; longer
  used-up copy scrolls in its body, keyboard-focusable only while overflowing.
  Attach, Send and the bottom edge stay fixed. Failed sends and answer-chip
  sends retain a separate draft and its size; accepted typed/device sends reset
  the matching draft. Discarded pending combined drafts refit immediately; CSS-only
  call/card transitions refresh the stored notice height before later changes.
  Wrapped recovery notices align their final text baseline with replay controls.
  A next draft typed during a pending reply reserves its
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

### Options, slots and additive fields

| New surface | Default / fallback and host contract |
| --- | --- |
| `voice.presentation(locale, ctx)` context field `ctx.hostOpener` | Absent outside eligible first contact or failed disclosure. Return the exact text as `{agent: {language: locale, firstMessage: ctx.hostOpener}}`. The reference ElevenLabs presentation selects it automatically; custom presentations retain speech control. Existing `opener`, `spokenOpeners` and `spokenContinuations` options retain their defaults. |
| `liveVoice.capabilities.opener` | Optional; undeclared means text-only, with one `voice.opener-undeclared` diagnostic per provider ID per handler. ElevenLabs and local/fake voice declare `true`; Grok, Voxtral and both composed providers declare `false`. |
| `sidebar-contact` | Empty, zero height; host-owned light-DOM content mounted before configure. Independent scrolling, at most 30% of the desktop sidebar / 14rem below 60rem, preserving at least 40% desktop reading room. |
| `contact-launcher` | Empty, no library action or fallback contact form. Host supplies a 44 × 44 px button and accessible name. With both slots, desktop windows below 48rem height use the launcher and remove the row from layout/Tab order; row-only hosts keep their row, including through entrance. |
| `firstPaintMarkupFor({contactLauncher: true})` | Opt-in; omitted/false retains the existing markup. With `firstPaintStyles`, reserve 44 px extra before mount: 216 → 260 px desktop, 88 → 132 px below 600 px. Keep the placeholder sibling through mount. Alternative: render-blocking `--aithema-header-actions-width` plus the matching `headerRailReservation({actionsWidth: '260px'})`. `voice: false` remains supported. |
| `--aithema-contact-launcher-width` | 0 px; 44 px when declared. Custom total header widths keep precedence over the zero-specificity library defaults. |
| `ConceptLane({consentRequired(session, visualKind)})` | Optional preflight; absence retains the prior lane path. Consent-only refusal publishes `concept.state.status.consentRequest: {id, sourceTurnId}` on `phase: 'waiting'`, without a durable grant or automatic retry. |
| Component `openConsent(feature, opener?)`, `cancelConsent()` | Open the existing editor (unknown feature → text), or discard a pending concept continuation. A host-initiated review cancels first. Separate from `detail.cancel()` for Start. |
| `aithema-consent.detail.requestId`, `.cancel()` | Unique request ID and idempotent callback. Settles `intent: 'start'` only; no-op for other intent state. No-op after grant receipt, expiry, supersession or cancellation. Ignore both fields to retain existing TTL behavior; never cancel after issuing a grant, since its receipt can arrive later. |
| `aithema-consent` enum additions | `reason: 'use'`, `intent: 'concept'` or `'attach'`; attach `features` includes `imageInput` and any missing base purposes. Existing `sessionId`, `mode`, `required` and feature-list contracts remain. Unknown reason/intent means review. |
| Preset `imageInput: {plugin: 'image-input'}` | Absent disables the normalizer. Register `createImageInput()` from the new public plugin; it has no required configuration. Production installs include optional native binaries. |
| Each reasoning binding `imageInput: {maxImages, maxTokensPerImage, perImageMicro?}` | Absent refuses image dispatch. Both selected reaction and understanding bindings require explicit capability and an image-capable adapter: `maxImages` 1–4, positive safe-integer token ceiling; optional nonnegative microdollar fee defaults to 0. No capability or price inferred from model names. |
| `AITHEMA_OPENROUTER_IMAGE_INPUT` | Unset means no demo capability declarations; model-keyed JSON declares the bindings above. |
| Upload limit `maxImagesPerSession` / `AITHEMA_UPLOAD_MAX_IMAGES` | 8, independent of eight documents; hosts may lower the ceiling. Existing defaults: 20 MiB/file, 21 MiB/request including framing, 8 files/request and 160 MiB/session shared source-byte maximum. Up to 4 images per sent turn, or a lower binding maximum. |
| Snapshot `featureMatrix.<preset>.imageInput.unpaused` | Present when the outer reason is `session paused`; contains the ordinary `{available, reason}` verdict for capability presentation. The outer verdict and attachment admission remain paused. Absent otherwise. |
| Consent feature `imageInput`, item `image-input` | Optional, item version 1. Exact binding/operation scope must be covered separately from text; `models-international` stays version 1. Explicit host feature mappings win. |
| Image upload metadata and states | `kind: 'image'`, `digest`, `w`, `h`, `expiresAt`; `staged-pending`, `staged-ready`, `staged-refused`, `staged-discarded` are non-input. Orphans expire after 30 minutes; sent images use source withdrawal. Bytes never enter snapshots/events/logs. |
| `/turns` body and turn receipts | Optional `attachments: string[]`, at most 4 unique owned ready IDs; blank text permitted with attachments. Atomic retry receipts bind both text and IDs. Live-call image sends refuse with `image-live-call`; lower binding counts use `image-input-limit`. Existing text-only statuses stay intact. |
| `GET /uploads/:id/image` | New owner-authenticated, current-consent-checked normalized-image route under the session API; `Cache-Control: no-store`; clients use revocable blob URLs. |
| `understanding.signalItems` | Additive final event/snapshot/export list `{key,text,firstSeen,basis?}`; draft/reset items can have just text/basis. Legacy strings still work. `firstSeen` is server sequence, with provider-order ties. Model objects require basis `visitor`, `assistant` or `document`; only assistant basis gets the unconfirmed suffix. |
| Snapshot `signalLedger` | Server-owned identities plus conservative `turnIds`/`uploadIds`; legacy sessions seed from their current final. Not exported; current items and ordered strings are exported. Withdrawal and erasure prune relevant entries. |
| `--aithema-composer-height`, `--aithema-composer-growth` | Measured CSS outputs, with empty baseline reset on responsive viewport/keyboard/stage changes; existing host height/theme overrides remain. |

The contact launcher stays available before input, during sidebar reveal, when
folded, below 60rem or without pinned content. While desktop pinned content is
available it leaves pointer/Tab order but retains its 44 px reservation; About
makes it inert. The host owns content, styling, dialog, delivery/privacy policy,
focus trap, Escape and focus return. Opening contact sends no turn or handover
and needs no AI consent. Late slot insertion/growth is outside the reserved
geometry contract. No new contact event or package export is needed.

### Image limits, consent and exports

Only hosts enabling the local normalizer **and** image-capable reasoning bindings
accept PNG, JPEG, WebP and GIF, first frame only. HEIC is refused, as are HEIF,
AVIF, SVG, TIFF and BMP. Image-capable composers support picking, dropping and
pasting; paste asks for no clipboard-read permission and dragged URLs are ignored.
Composers whose current binding cannot take images retain RC25's documents-only
Attach title and description, document-only picker accept list, and type refusal
for every non-document file, including PNG, JPEG and HEIC. No image-format help
or image-retention wording appears, including after a text-only binding switch.
Image-capable composers keep the paused image refusal; pausing holds admission
without removing their capability.

Attach-time consent keeps files in browser memory for at most three minutes,
then asks for reselection. Granting both mapped `images` (generation) and
`image-input` (reading) purposes in Start consent avoids later asks; text consent
alone grants neither. Normalization auto-orients and strips metadata, accepts at
most 40 MP / 16,384 px per edge, and emits JPEG or alpha-preserving PNG at most
1,568 px on the long edge / 1.15 MP, within a ten-second child deadline.
The source-byte/count ceilings are in the table above. Removing staged images,
switching session or 30-minute expiry erases unsent pixels without model work.

ZIP export includes sent normalized images under `images/`, metadata in
`uploads.json`, and exact file hashes in the export manifest. JSON and events
contain references only. Withdrawing image-input consent erases pixels and uses
`[image withheld]` for later prompts; delivered replies remain. Full withdrawal
and erasure remove retained pixels too. At most four images from the last two
user turns reach image-capable dispatch; draft understanding stays text-only.
Text-only model switches use `[image: "filename", sent earlier]` markers, while
device mode refuses unsent images and retains the files and caption for removal
or a capable-model switch.

### Package and lower-level additions

The release closure grows from sixteen to **seventeen public modules** with
`@inspr/aithema-plugin-image-input` (`createImageInput`, `manifest`), pinned
`sharp` 0.35.5 and its platform/libvips dependencies; optional production binaries
are required. The production fixture qualifier is
`scripts/qualify-image-input.js`; rights are in `NOTICES.json`.
Core root and `@inspr/aithema-core/image-input` add `IMAGE_INPUT_MEDIA_TYPES`,
`stagedImage`, `imageReferences`, `validateImageInput`, `reasoningInputBound`,
`imageInputFee`, `imageInputScope`. Core root/understanding add `signalKey(text)`.
`@inspr/aithema-core/plugin-contract` adds `ImageReasoningRequest`,
`ImageReasoning`, `ImageReference`, `ImageInputCapability`, `ImageOperationOptions`
and `ImageInput`; the existing text-only `Reasoning` type remains. Plugin kind
`image-input` and operation `normalize` are additive.

Storage adds `turnReceipt`, `imageUpload`, `expireStagedUploads`; `postTurn` accepts
`guard.attachments`; `completeUpload` accepts staged-ready normalized bytes or a
staged-refused reason. Upload handlers accept `now` (default `Date.now`) and expose
`cancelImages`; runtime exposes `imageInputAvailability`, `normalizeImageUpload`.
`exportSession` accepts optional owner-authorized normalized `images` records;
`reasoningRequest` adds `imageOnly`. `createChatCompletions.prepareDispatch`
resolves bytes after admission; `resolveImage` and optional `imageDispatchCurrent`
are in-process authority callbacks. Existing synchronous `prepareBody` still
estimates text; absent callbacks retain that path. The exported `SQLiteStorage`
removes its undocumented public method `hasConnectedVoiceCall` and adds
`hasAudibleVoiceCall(sessionId)`. Hosts calling the removed method must migrate;
the new method counts admitted, audibly connected calls and changes the semantics.

### Visual polish (AIT-541, #463; findings 7–13 only)

Phone opener bubbles clear the fold target. The legacy entrance still renders
the opener after Start; the combined entrance renders it before input. Refused
in-chat offers gain warning colour/icon and invalid-field treatment where
appropriate. The best-models notice states where processing may occur. At
≥600 px the combined ready card hides `chooser.summary.*`; below 600 px it
remains visible. Send failures share text sizing/baselines; desktop question
rows reserve the longest resolved failure copy (long host `clarifyFailed` makes
them taller at rest). Desktop Retry message width is min(480 px, available
width). At desktop heights of 700 px or less, the message uses the full rail
width at the top. Idle/time-ended
compact labels now offer text continuation, and non-Retry desktop voice
messages stay within the conversation column beside the overview. These DOM,
CSS and default-copy changes can affect host selectors and geometry. Findings
14/15 are excluded; the listed remaining limitations apply.

### Copy compatibility

All new leaf keys in the EN/DE bundles are listed below (paths are relative to
`copy`). Object `uploadsReselect` supports the legacy one/other plural shape;
`imageRefusals` and `processingConsent.items.image-input` are structured objects.

| New copy key | EN default | DE default | Legacy fallback |
| --- | --- | --- | --- |
| `conceptConsent` | Images need consent to be created. | Zum Erstellen von Bildern ist eine Einwilligung nötig. | `featureConsent.images` |
| `conceptDraftConsent` | Drafts need consent to be created. | Entwürfe: Einwilligung nötig. | `featureConsent.html` |
| `conceptConsentAction` | Give consent | Einwilligung geben | `featureConsent.action` |
| `features.imageInput` | Image input | Bildeingabe | `imageInputFeature` |
| `signalsAll` | Show all ({n}) | Alle anzeigen ({n}) | None |
| `signalUnconfirmed` | unconfirmed | unbestätigt | None |
| `summaryMore` | Read more | Mehr anzeigen | None |
| `showLess` | Show less | Weniger anzeigen | None |
| `imageConsentJit` | Images need consent to be read. | Zum Lesen von Bildern ist eine Einwilligung nötig. | None |
| `imageInputFeature` | Image input | Bildeingabe | None |
| `imagePreparing` | Preparing… | Wird vorbereitet … | None |
| `imageRemove` | Remove {name} | {name} entfernen | None |
| `imageLiveCall` | Images can be sent in text mode. | Bilder lassen sich im Textmodus senden. | None |
| `imageUnsupportedModel` | This assistant can't read images. | Bilder werden von diesem Assistenten nicht gelesen. | None |
| `imageWithheld` | Image not sent | Bild nicht gesendet | None |
| `uploads.limitsWithImages` | Up to {files} files, {size} each: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON, XML, PNG, JPEG, WebP or GIF. Original documents are not stored; normalized images are kept until withdrawn or erased. | Bis zu {files} Dateien, je höchstens {size}: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON, XML, PNG, JPEG, WebP oder GIF. Originaldokumente werden nicht aufbewahrt; normalisierte Bilder bleiben bis zum Zurückziehen oder Löschen gespeichert. | `uploads.limits` |
| `uploadsSupported` | Supported: PDF, Word, Excel, PowerPoint, text, and PNG, JPEG, WebP or GIF images. | Unterstützt: PDF, Word, Excel, PowerPoint, Text sowie Bilder als PNG, JPEG, WebP oder GIF. | None |
| `uploadsReselect.one` | Please choose the file again. | Datei bitte erneut auswählen. | None |
| `uploadsReselect.other` | Please choose the files again. | Dateien bitte erneut auswählen. | None |
| `imageRefusals.paused` | Images cannot be attached while the conversation is paused. | Während der Gesprächspause können keine Bilder angehängt werden. | None |
| `imageRefusals.batch` | Up to four images can be sent together. | Bis zu vier Bilder lassen sich zusammen senden. | None |
| `imageRefusals.unsupported` | File type not accepted. Use PNG, JPEG, WebP or GIF. | Dateityp wird nicht angenommen. PNG, JPEG, WebP oder GIF verwenden. | None |
| `imageRefusals.size` | Image too large for this upload. | Das Bild ist für diesen Upload zu groß. | None |
| `imageRefusals.limit` | No more images fit in this conversation. | In diesem Gespräch können keine weiteren Bilder hinzugefügt werden. | None |
| `imageRefusals.empty` | The image is empty. | Das Bild ist leer. | None |
| `imageRefusals.malformed` | is not a readable image. | ist kein lesbares Bild. | None |
| `imageRefusals.dimensions` | The image dimensions are too large. | Die Bildabmessungen sind zu groß. | None |
| `imageRefusals.deadline` | Preparing the image took too long. | Die Bildvorbereitung hat zu lange gedauert. | None |
| `imageRefusals.cancelled` | Preparing the image was cancelled. | Die Bildvorbereitung wurde abgebrochen. | None |
| `imageRefusals.unavailable` | Images cannot be prepared right now. | Bilder können gerade nicht vorbereitet werden. | None |
| `imageRefusals.session` | The images exceed this conversation's total file size. | Die Bilder überschreiten die gesamte Dateigröße dieses Gesprächs. | None |
| `imageRefusals.model` | This assistant can't read images. | Bilder werden von diesem Assistenten nicht gelesen. | `imageUnsupportedModel` |
| `imageRefusals.live-call` | Images can be sent in text mode. | Bilder lassen sich im Textmodus senden. | `imageLiveCall` |
| `reasons.image input not supported` | This assistant can't read images. | Bilder werden von diesem Assistenten nicht gelesen. | None |
| `reasons.image normalizer not configured` | Image preparation not configured | Bildvorbereitung nicht eingerichtet | None |
| `reasons.image normalizer unavailable` | Images cannot be prepared right now. | Bilder können gerade nicht vorbereitet werden. | None |
| `reasons.image normalizer must be local and free` | Image preparation unavailable | Bildvorbereitung nicht verfügbar | None |
| `featureConsent.imageInput` | Images need consent to be read. | Zum Lesen von Bildern ist eine Einwilligung nötig. | None |
| `processingConsent.items.image-input.version` | 1 | 1 | None |
| `processingConsent.items.image-input.title` | Image input | Bildeingabe | None |
| `processingConsent.items.image-input.recipients` | OpenRouter, Inc. and the selected model provider. Processing can take place outside Europe, including in the United States. | OpenRouter, Inc. und der ausgewählte Modellanbieter. Die Verarbeitung kann außerhalb Europas stattfinden, auch in den Vereinigten Staaten. | None |
| `processingConsent.items.image-input.text` | Selected images and screenshots, the conversation and assessment are sent to read images and answer questions about them. Normalized images are retained with the conversation until withdrawn or erased. Processing without retention is not guaranteed. | Ausgewählte Bilder und Screenshots, das Gespräch und die Auswertung werden übermittelt, um Bilder zu lesen und Fragen dazu zu beantworten. Normalisierte Bilder bleiben bis zum Zurückziehen oder Löschen beim Gespräch gespeichert. Eine Verarbeitung ohne Aufbewahrung ist nicht garantiert. | None |
| `host.slots.contact` | Contact | Kontakt | None |
| `host.slots.contactNote` | Demo only: this overlay sends no data. No contact request is created. | Nur Demo: Dieser Dialog sendet keine Daten. Es wird keine Kontaktanfrage erstellt. | None |

Shared resolver: `packages/ui/src/copy-resolve.js`. A nondefault host new-key
override wins, then a nondefault legacy-key override, then the shipped new-key
default. A shipped new-key default in an older customized bundle does not hide
its legacy override. Without a legacy fallback, host text wins, then the active
locale, then English. `imageRefusals` uses the unavailable reason for unknown
refusal codes. Demo `host.slots.*` keys are demo content, not library slot
fallbacks. Host consent mappings and host slot content remain authoritative.

### Changed defaults relative to RC25

The complete EN/DE bundle diff at L′ has no removed leaf key.
`uploads.limits` is unchanged from RC25 in both EN and DE;
`uploads.limitsWithImages` is new and appears in the additive table above. Host overrides keep
winning. The compact idle label below supersedes RC25's copy table. The dot
separator has a nonbreaking space before it in the actual strings.

| Key | EN old → new | DE old → new |
| --- | --- | --- |
| `voiceMessagesNarrow.voiceIdleEnded` | Ended after silence → Ended after silence · continue by text | Nach Stille beendet → Nach Stille beendet · weiter per Text |
| `voiceMessagesNarrow.voiceTimeLimit` | Time limit reached → Call time up · continue by text | Zeitlimit erreicht → Anrufzeit abgelaufen · weiter per Text |
| `settings.processingDetails.best` | Processing by the providers this host selected for Best models. Locations follow each plugin’s declared facts. → Your conversation may be processed outside the EU by the providers selected for this site. | Verarbeitung durch die Anbieter, die dieser Host für „Beste Modelle“ gewählt hat. Die Orte folgen den Angaben des jeweiligen Plugins. → Die für diese Website gewählten Anbieter können Ihr Gespräch auch außerhalb der EU verarbeiten. |
| `summary` | Summary → Understood so far | Zusammenfassung → Bisher verstanden |
| `signals` | Signals → Signals (unchanged) | Was konkret erkennbar war → Signale |

German release prose uses impersonal wording. The table quotes shipped defaults
verbatim, including address forms retained by existing copy keys.

### CI-only

14 browser shards (AIT-511, AIT-557); this is CI capacity only; no limits are raised. The existing required aliases
and duplicate-push policy remain. The release PR's browser CI must be fully green.

## Known limitations

- On document-only hosts, an extensionless image or a file typed `image/*` that
  the server classifies as an image refuses the whole upload POST, including
  eligible documents in that POST; planned (AIT-559).
- On hosts without a visitor email store, low-credit/turn-5 email asks still
  offer a save that cannot succeed; planned (AIT-549). The in-chat offer fix
  does not cover these older asks.
- In the combined entrance at 1024×600, the fixed footer can cover the composer's
  disclosure edge at page scroll 0; planned (AIT-552).
- In DE with the default font at 1024–1366 px, the longest status reason takes
  three lines, leaving extra space above idle status; planned (AIT-551).
- “export it” copy can appear without an export control, two mic buttons remain,
  and the pause button is pre-filled before any call; planned (AIT-553).

## Breaking for hosts

**Yes for callers of the undocumented public
`SQLiteStorage.hasConnectedVoiceCall` method, relative to RC25
(`v261116143738.0.0`).** It was available on the exported class and is removed;
being undocumented does not make its removal compatible. Migrate callers to
`hasAudibleVoiceCall(sessionId)` after accounting for its admitted/audible-call
semantics. Other additions are compatible: optional configuration, event fields,
slots, image types/routes, exports and copy keys. Image input and
`uploads.limitsWithImages` are new in RC26 and opt-in, so neither is a breaking
change relative to RC25. Document-only composers keep RC25's Attach help, picker,
type refusal and existing copy overrides. AIT-542 cancellation is additive;
AIT-543's identity-command in-chat offer is a fix with no new flag. AIT-541 changes
presentation, and signals now arrive newest-first. The new normalizer's optional
native binaries are required only when installing/using that plugin.

## Availability and verification

Seventeen public modules ship, including the image-input normalizer. Voxtral
(AIT-342) remains parked, private and outside the closure. Provider-side live-call
closure (AIT-446's second part) remains parked until ElevenLabs monitoring is
enabled. Grok Voice is **not yet qualified in live use**; its opener is text-only,
with no separate spoken greeting. No provider credentials are bundled.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
and RC23's asynchronous-delivery `identity.acceptsAddress` requirement still apply.
Release assets include module tarballs, workspace archive, dependency locks,
SPDX SBOM and `release-set.json`. Verify attestations and `SHA256SUMS` before
installation using [the verification instructions](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#verify-and-install)
with tag `v261118191311.0.0` in download/installation URLs. Retain verified assets,
manifest and deployment pin for exact rollback. See the
[embedding guide](https://github.com/inspr-at/aithema/blob/v261118191311.0.0/docs/embedding.md).
