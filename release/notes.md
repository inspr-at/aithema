# Aithema 2026.10

Version **261120065345.0.0**. Licensed under **AGPL-3.0-only**.

Every added file now ends attached or with its own reason, upload notices stay
readable in one row each, and the combined entrance opens calmly. Uploads and
image input appear only where the host enables them; the combined entrance is a
host opt-in and the default entrance remains `'choice'`.

## What visitors notice

- **No lost uploads (AIT-559, #468).** Every added file is attached or says why not; eligible documents always go through. Where the host enables uploads.
- **Clear upload limits (AIT-561, #470).** When a pick is too large, the limit and its figure are shown, and images waiting for consent are kept. Where the host enables uploads; held images only with image input.
- **Held images stay visible (AIT-563, #474).** An image waiting for consent stays named with its consent action, even when newer files are refused. Only where the host enables image input.
- **No stray email reads (AIT-568, #476).** On sites that keep no visitor email, Aithema no longer reads it after the page reconfigures, so the no-storage promise holds in every state.
- **Steady consent line (AIT-572, #478).** After the workspace reloads, the drafts line no longer flashes a stale consent request, and an old approval can no longer hide consent that is now missing.
- **Steady start screen (AIT-569, #479).** After resizing from phone to desktop width, the start options stay exactly where they are under the pointer instead of jumping.
- **Clear upload notices (AIT-566, #480).** Upload and held-file notices show one per row with their action, and a sheet lists any extra notices; nothing in the composer moves. Where the host enables uploads.
- **Calm first screen (AIT-553, #483).** The combined entrance opens with one microphone, a neutral pause and readiness that fits on short screens; in the call band a long status fades instead of wrapping, so the band stays one row where it fits; keyboard users keep their place when a call ends. One microphone, readiness and the export link apply where the host enables the combined entrance; the neutral pause and the fading call-band status apply in both entrances.

When nothing else fits, the notice row shows one honest summary: “Can't upload ·
Details” only for real upload limits and “Consent needed · Details” for consent.
“Show N more notices” opens the notices sheet with the same actions. A long
call-band status now fades at its edge instead of ending in “…”; important
notices are never cut.

## Was Besucher bemerken

- **Keine verlorenen Uploads (AIT-559, #468).** Jede hinzugefügte Datei wird angehängt oder nennt den Grund; passende Dokumente werden immer angehängt. Bei vom Host aktivierten Uploads.
- **Klare Upload-Grenzen (AIT-561, #470).** Bei zu großer Auswahl werden Grenze und Zahl angezeigt; Bilder, die auf eine Einwilligung warten, bleiben erhalten. Bei vom Host aktivierten Uploads; wartende Bilder nur mit Bildeingabe.
- **Wartende Bilder sichtbar (AIT-563, #474).** Ein Bild, das auf eine Einwilligung wartet, bleibt mit seiner Einwilligungsaktion sichtbar, auch neben abgelehnten neueren Dateien. Nur bei vom Host aktivierter Bildeingabe.
- **Keine verirrten E-Mail-Abfragen (AIT-568, #476).** Auf Websites, die keine Besucher-E-Mail speichern, fragt Aithema sie nach einer Neukonfiguration der Seite nicht mehr ab, sodass das Versprechen ohne Speicherung in jedem Zustand gilt.
- **Stabile Einwilligungszeile (AIT-572, #478).** Nach dem Neuladen des Arbeitsbereichs zeigt die Entwurfszeile keine veraltete Einwilligungsanfrage mehr, und eine alte Zustimmung kann eine jetzt fehlende Einwilligung nicht mehr verdecken.
- **Stabiler Startbildschirm (AIT-569, #479).** Nach einer Größenänderung von Handy- auf Desktopbreite bleiben die Startoptionen genau unter dem Mauszeiger, statt zu springen.
- **Klare Upload-Hinweise (AIT-566, #480).** Upload- und Halte-Hinweise stehen je in einer Zeile mit ihrer Aktion, weitere Hinweise zeigt ein eigenes Blatt; im Eingabebereich verschiebt sich nichts. Bei vom Host aktivierten Uploads.
- **Ruhiger Startbildschirm (AIT-553, #483).** Der kombinierte Einstieg zeigt ein Mikrofon, eine neutrale Pause und eine Bereitschaftsanzeige, die auf kurze Bildschirme passt; in der Anrufleiste blendet ein langer Status aus, statt umzubrechen, sodass die Leiste einzeilig bleibt, wo sie Platz hat; Tastaturnutzer behalten nach einem Anruf ihren Platz. Ein Mikrofon, Bereitschaftsanzeige und Export-Link gelten bei vom Host aktiviertem kombiniertem Einstieg; die neutrale Pause und der ausblendende Status der Anrufleiste in beiden Einstiegen.

Passt sonst nichts, zeigt die Hinweiszeile eine ehrliche Zusammenfassung:
„Hochladen nicht möglich · Details“ nur bei echten Upload-Grenzen und
„Einwilligung nötig · Details“ bei fehlender Einwilligung. „N weitere Meldungen
anzeigen“ öffnet das Hinweisblatt mit denselben Aktionen. Ein langer Status in
der Anrufleiste blendet am Rand aus, statt mit „…“ zu enden; wichtige Hinweise
werden nie abgeschnitten.

## For hosts

- AIT-559: `POST /api/sessions/:id/uploads` refuses images **per file**. The
  additive `refused` array contains `{index, name, kind: 'image', reason}`, with
  `index` the zero-based file position in the request. Images that the current
  binding, normalizer or consent cannot take, and images beyond the session image
  quota, are omitted from `uploads` and `events`; their original bytes are never
  staged. Eligible documents in the same request still attach. An entirely
  refused image request also returns **202** with empty `uploads`/`events`
  arrays (previously 403 `uploads-unavailable` or 413; see Breaking for hosts).
  A receipt replays its refusals unchanged at 200; a later consent grant needs a
  new request ID for the retained images. Refusal receipts store positions and
  reasons, not plaintext filenames. Request framing, ownership, document
  admission and other capacity failures keep their existing HTTP errors. Direct
  `SQLiteStorage.postUploads` callers keep the image-limit `RangeError` unless they
  pass the additive opt-in `guard.partialImages`; its result adds `refused`.
- AIT-559 / AIT-561 client intake: classifiable selections keep the specific
  document-count and byte-capacity notices with their figures. Only selections
  with an uncertain document/image kind defer those checks to the server, so a
  disguised image cannot hold eligible documents. The client reads at most 16
  signature bytes per candidate document without decoding or retaining it.
  Excess images get the existing named image-limit refusal; images that fit and
  eligible documents continue. Final ownership, missing-session and conflict
  failures stop the selection with one notice giving the reason before all unsent
  filenames; several unsent files use the additive `uploads.failedMany`. Behaviour
  change: combined composers with document intake and no image input reserve
  three feedback lines (previously two). Feedback is its own grid row below the
  44 px control row, so its minimum grows from `2.6em` to `3.75em` (43.2 px at a
  16 px root font size, previously about 30 px) and the idle composer can be up
  to about 13 px taller than in RC26. With image input the existing 44 px image
  reserve applies unchanged.
- AIT-561 / AIT-563 held images: detected images awaiting consent reuse the
  existing image consent action and keep their files while document batches
  continue. A newer pick, drop or paste keeps consent-held images, even when the
  new selection is refused entirely; granting attaches the held images once and
  keeps newer file notices. Re-picks with the same name, size and last-modified
  time share one hold. Decline and expiry ask the visitor to choose again without
  removing earlier notices, and expired notices are not resurrected. Phones reuse
  the existing narrow consent wording with the full file-specific sentence in the
  action's accessible name.
- AIT-566: upload and held-file notices render one per row inside the existing
  reserved feedback cell, with the action beside the text when it fits.
  Overflow shows “Show N more notices”, opening a modal notices sheet (a native
  `dialog` in the component's shadow root) that holds the same action nodes; focus
  returns to a visible enabled control on close. When nothing fits, the row is an
  honest one-line summary: `uploads.summaryUnavailable` only for real upload
  limits, `uploads.summaryConsent` for consent, each followed by
  `uploads.detailsAction`. Idle composer geometry equals its immediate baseline,
  main before #480, which already includes the AIT-561 reserve above.
- AIT-568: on hosts that keep no visitor email (`visitorEmail.canSave: false`
  and `canDelete: false`), a reconfigure no longer starts a stray
  `/api/visitor/email` read from the torn-down verifier; AIT-543's no-store
  contract holds in every state. Fix only; no flag or option.
- AIT-572: feature and consent refreshes are fenced across `configure()`. An
  older refresh can no longer repaint the new view, neither as a stale “needs
  consent” nor, the safety case, as a stale “allowed”. Fix only; no flag.
- AIT-569: when a host's `headerRailReservation` CSS already reserves the second
  header row, the component no longer persists its own row flag; it records only
  a measured overflow beyond that contract at single-row widths. After a
  phone-to-desktop resize the start chooser no longer jumps. Reserved geometry
  is unchanged.
- AIT-553 (combined entrance): exactly one microphone before any call; the
  composer owns the first action and the band keeps its mic cell reserved without
  a second mic or an idle speech invitation. Readiness uses the
  conversation's full width, with a compact one-line consent form on desktops at
  most 860 px tall; the render-only opener ends at its text. Phone email
  confirmation stacks under its text. The used-up offer exposes the existing
  export link (short label `usedUpExportShort` on phones, full accessible name
  kept); host daily-cap action suppression still applies. The call band stays one
  row when the rail track has room (544 px by default, 384 px with
  `railMinWidth: voiceRailFlexMinWidth`); consent actions and important notices
  take the second row. Keyboard End keeps focus by handing it to the composer mic.
- AIT-553 (both entrances): the idle conversation Pause keeps its existing
  availability with a neutral, unpressed look instead of the live call's filled
  treatment. From 600 px an ordinary long band status clips and fades in its own
  track (no “…”) and hides when that track is narrower than 96 px; the controls
  and their 44 px cells never move. Consent actions and important notices
  (failure, credit, cooldown) keep their complete measured row and take the
  second row when they do not fit.
- **AIT-553 first-paint API — additive and opt-in.** `@inspr/aithema-ui/first-paint`
  exports `voiceRailFlexMinWidth` (`384`) and `voiceRailLineFloor` (`160`).
  `headerRailReservation({ railMinWidth })` accepts an optional **number** in px
  (not a CSS length), rounded to whole pixels. A value that `Number()` cannot read,
  or that rounds to 0 (for example `0`), uses the default 544; any other value
  below 384, including a negative one, is raised to 384. The default stays
  `voiceRailMinWidth` (`544`), so every existing host's geometry is unchanged.
  Hosts with wide header actions may pass
  `railMinWidth: voiceRailFlexMinWidth`: an ordinary voice status then clips and
  fades down to a 160 px line before the band takes a second row. Consent actions
  and important notices still take the second row when they do not fit whole. The
  emitted CSS adds `--aithema-header-rail-floor`. See
  [the embedding guide](https://github.com/inspr-at/aithema/blob/v261120065345.0.0/docs/embedding.md).

### Options and additive fields

| New surface | Default / fallback and host contract |
| --- | --- |
| `POST /uploads` response `refused` | Always present on new and replayed responses; `[]` when nothing is refused. Entries `{index, name, kind: 'image', reason}`. Image-only refusals return 202 (new) / 200 (replay). |
| `SQLiteStorage.postUploads(..., guard.partialImages)` | Absent/false keeps the existing atomic image-limit `RangeError`. True refuses images per file; the result and replay add `refused` (`{index, kind, reason}`). |
| `voiceRailFlexMinWidth`, `voiceRailLineFloor` | New exports of `@inspr/aithema-ui/first-paint`: `384` and `160`. Constants only; nothing changes unless a host passes them. |
| `headerRailReservation({ railMinWidth })` | Optional number in px; default `voiceRailMinWidth` (`544`); minimum 384. Other arguments remain literal CSS lengths. |
| `--aithema-header-rail-floor` | Emitted by `headerRailReservation`; the mounted fit reads it. Absent means the default 544 px floor. |

### Copy compatibility

All new leaf keys in the EN/DE bundles between RC26 and this release (paths are
relative to `copy`). `uploads.moreNotices` uses the one/other plural shape and
replaces `{count}`.

| New copy key | EN default | DE default | Legacy fallback |
| --- | --- | --- | --- |
| `uploads.moreNotices.one` | Show {count} more notice | {count} weitere Meldung anzeigen | None |
| `uploads.moreNotices.other` | Show {count} more notices | {count} weitere Meldungen anzeigen | None |
| `uploads.summaryUnavailable` | Can't upload | Hochladen nicht möglich | None |
| `uploads.summaryConsent` | Consent needed | Einwilligung nötig | None |
| `uploads.detailsAction` | Details | Details | None |
| `uploads.noticesTitle` | Upload notices | Meldungen zum Hochladen | None |
| `uploads.closeNotices` | Close | Schließen | None |
| `uploads.failedMany` | The files could not be added. | Die Dateien konnten nicht übernommen werden. | `uploads.failed` |
| `usedUpExportShort` | Export | Exportieren | None |

Shared resolver: `packages/ui/src/copy-resolve.js`. A nondefault host override
wins; for `uploads.failedMany` a nondefault legacy `uploads.failed` override wins
next; then the active locale's default, then English.

### Changed defaults relative to RC26

None. The complete EN/DE bundle diff between RC26 (`7de34739`) and this release
adds the nine leaf keys above and changes or removes no existing default.

### Behaviour changes without a key change

- AIT-566: the notices sheet and the compact one-line summary row.
- AIT-553: the call-band status fades instead of truncating; important notices
  take the band's second row; the readiness card's compact form on desktops at
  most 860 px tall.
- AIT-569: the header-row reservation now comes from CSS alone; the component
  flags only a measured overflow.
- AIT-561: combined composers with document intake and no image input reserve
  three feedback lines in their own feedback row (minimum `3.75em`, previously
  `2.6em`), so the idle composer can be up to about 13 px taller than in RC26.

German release prose is impersonal; quoted shipped defaults stay exact.

## Known limitations

- On hosts without a visitor email store, the low-credit/turn-5 email ask still
  offers a save that cannot succeed; planned (AIT-549).
- In DE with the default font at 1024–1366 px, the longest status reason takes
  three lines; planned (AIT-551).
- In the combined entrance at 1024×600, the fixed footer can cover the composer's
  disclosure edge at page scroll 0; planned (AIT-552).
- On a phone with the on-screen keyboard open, a long streamed reply can lose
  its beginning because the transcript follows its end; planned (AIT-571).
- On a compact phone composer (for example 390×568), an upload refusal has no
  visible notice; screen readers announce it; planned (AIT-580).
- At 400 px the start screen's hero orb sits half under the header; planned
  (AIT-576).
- At 360 px the German composer placeholder “Ihre Nachricht” is cut; planned
  (AIT-578).
- In the choice entrance at 1280×720, the fixed footer covers the option cards
  at page scroll 0 and Continue sits below the fold, so the page scrolls; planned
  (AIT-590).
- On a phone overview (390×844), the pinned demo/contact strip sits partly under
  the composer and the collapse chevron touches “Up to date”; planned (AIT-591).

## Breaking for hosts

**No for hosts that serve the shipped component with the shipped server,
relative to RC26 (`v261118191311.0.0`). Yes, narrowly, for custom HTTP clients
of `POST /api/sessions/:id/uploads` that send images.** Requests whose images
were refused for unavailable image input or missing consent previously returned
403 `uploads-unavailable`, and requests over the session image quota 413; those
images are now refused per file in a 202 (replay 200) response with the additive
`refused` array, and eligible documents in the same request attach. Such clients
must read `refused` and `uploads` instead of treating 2xx as “every file
attached”. Every other change is compatible: the first-paint exports and
`railMinWidth` are additive and opt-in with unchanged defaults; the nine copy
keys are additive and host overrides keep winning; `guard.partialImages` is
opt-in for direct storage callers; AIT-568 and AIT-572 are fixes with no flag;
the AIT-566 notices sheet and AIT-569 header-row change live inside the
component's shadow DOM and keep reserved geometry; AIT-561's taller document
feedback row is a visual behaviour change inside the shadow DOM, not a host
contract change. No configuration, event, slot or host requirement changes.

## Availability and verification

Seventeen public modules ship. Voxtral (AIT-342) remains parked, private and
outside the closure. Provider-side live-call closure (AIT-446's second part)
remains parked until ElevenLabs monitoring is enabled. Grok Voice is **not yet
qualified in live use**; its opener is text-only, with no separate spoken
greeting. No provider credentials are bundled.

[RC14's host requirements](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#for-hosts)
and RC23's asynchronous-delivery `identity.acceptsAddress` requirement still apply.
Release assets include module tarballs, workspace archive, dependency locks,
SPDX SBOM and `release-set.json`. Verify attestations and `SHA256SUMS` before
installation using [the verification instructions](https://github.com/inspr-at/aithema/blob/v261021043938.0.0/release/notes.md#verify-and-install)
with tag `v261120065345.0.0` in download/installation URLs. Retain verified assets,
manifest and deployment pin for exact rollback. See the
[embedding guide](https://github.com/inspr-at/aithema/blob/v261120065345.0.0/docs/embedding.md).
