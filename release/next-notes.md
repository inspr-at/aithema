# Next release — unreleased

## Host notes

- AIT-547: short desktop overviews with pinned contact content reserve the
  natural height of the longest resolved status for the current width, font
  and language. This keeps status text and actions readable without moving
  the summary between states, and recovers room for the first collapsed signal.
  Scrolling fades clear heading rows and their controls. Separate verification
  entrances retain their natural height.

- AIT-543 (RC26): hosts without a visitor email store now get working in-chat offers via the identity command.
  This is a bug fix with no new opt-in flag. Explicit `visitorEmail.canSave: false`
  uses the lock form's request/change rule and never PUTs visitor email. EN/DE
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
  plus native/capability refusal reasons. `uploads.limits` is restored to the
  existing documents-only text; the additive `uploads.limitsWithImages` supplies
  format/retention help for image-capable or image-consent-pending composers.
  An explicit host `limitsWithImages` override wins, followed by a host `limits`
  override, then the bundled image help. Both keys accept `{files}` and `{size}`.
  Refusals persist through typing in the bounded reason slot, below blocking
  failures and attach-time consent. README documents the additive host surfaces
  and attachment-help override precedence.

- Lower-level additions: storage turnReceipt/imageUpload/expireStagedUploads,
  postTurn guard.attachments, completeUpload image results, upload-handler now
  and cancelImages, runtime imageInputAvailability/normalizeImageUpload,
  exportSession images, reasoningRequest imageOnly, and dispatch-only
  createChatCompletions prepareDispatch/resolveImage/imageDispatchCurrent.
  Unsupported image filenames stay in the non-input refusal path even for
  direct multipart callers; the format help line lists the exact accepted types.
  Named documents retain byte-sniffed document admission despite false image
  MIME hints; actual image bytes always select image staging.

- Extensionless files labelled with an image MIME type and excluded HEIC/AVIF
  containers stay in the staged, non-input refusal path; they never fall through
  to document extraction or schedule model work. HEIC remains unsupported.

- Staged image states are excluded from the append-only voice callback fence;
  attaching, preparing, refusing or discarding an image cannot reject that reply.

- AIT-510 follow-up: image-only OpenRouter input omits blank text blocks. A switch
  to a text-only model or preset replaces earlier image references with text
  markers before estimation, reservation and dispatch, preserving text replies
  and understanding. Device mode refuses unsent staged images without dropping
  their files or caption. Mixed selections continue eligible document uploads when
  image input is unavailable. At attach time, unavailable normalizers and
  text-only bindings use the existing document type refusal for images, with
  existing upload-consent wording for document-only continuations. Paused
  image-capable composers keep `imageRefusals.paused` on image selection and
  paste; other files use the generic Attach refusal during a pause. Capability
  reads use the unpaused verdict; attachment admission still respects the pause.
- Image refusal feedback reserves the longest localized reason and shows it
  once. Remove targets stay outside thumbnails with filename-aware EN/DE names;
  short phones use one compact staging row around 44 px controls. Withheld-image copy `imageWithheld`
  reads “Image not sent” / “Bild nicht gesendet”; `imageRefusals.paused` is additive.
  Enabled Attach describes selection before consent. Unknown file refusals list
  accepted formats; image-limit copy resolves host overrides and locale fallbacks.
  Composer growth retains transcript follow and whole-item reading alignment;
  the combined short-phone transcript reserves eight pixels below its content.
  Successful document uploads preserve image refusals from the same selection.
  Retained-file retry messages keep their existing facts and action order.
  Image-feedback measurement keeps the same width across text-consent and
  shortcut states, including 320/340 px, preserving the composer after a grant.
  On document-only bindings, the same mixed selection retains its document type
  refusal across document consent;
  only eligible document handles and bounded refusal metadata continue.
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
