# Aithema 2026.10

Version **261121100916.0.0**. Licensed under **AGPL-3.0-only**.

The welcome stays in place when a host uses image concepts, the "Show more
notices" focus ring stays clear of nearby text, and the footer and English
credit copy are calmer. The combined entrance is a host opt-in and the default
entrance remains `'choice'`; upload notices appear only where the host enables
uploads.

## What visitors notice

- **Welcome stays in place (AIT-601, #494).** The welcome no longer overlaps the readiness panel when a host uses image concepts. Applies on desktop widths in the combined entrance (a host opt-in) with a host's image concept layout. When the readiness panel hands over to the live conversation, a conversation that fits stays where it is; a longer conversation still scrolls on to the visitor's message.
- **Clear focus ring (AIT-589, #488).** With the keyboard, the focus ring on "Show more notices" no longer covers nearby text or its own label, on phones and desktops. Where the host enables uploads.
- **Calmer footer and copy (AIT-587, #496).** The footer says "Connected" without a running number and shows when the connection started on hover or focus; English writes "credits" in lower case mid-sentence; the used-up message no longer promises an export.

## Was Besucher bemerken

- **Begrüßung bleibt stehen (AIT-601, #494).** Die Begrüßung überdeckt das Bereitschaftsfeld nicht mehr, wenn ein Host Bildkonzepte nutzt. Gilt auf Desktopbreiten im kombinierten Einstieg (vom Host aktiviert) mit dem Bildkonzept-Layout eines Hosts. Beim Übergang vom Bereitschaftsfeld ins laufende Gespräch bleibt ein Gespräch, das Platz hat, stehen; ein längeres Gespräch scrollt weiterhin bis zur Nachricht der Besucherin oder des Besuchers.
- **Klarer Fokusrahmen (AIT-589, #488).** Mit der Tastatur verdeckt der Fokusrahmen von „Weitere Meldungen anzeigen“ weder benachbarten Text noch die eigene Beschriftung, auf Smartphone und Desktop. Bei vom Host aktivierten Uploads.
- **Ruhigere Fußzeile und Texte (AIT-587, #496).** Die Fußzeile zeigt „Verbunden“ ohne laufende Zahl und nennt beim Zeigen oder Fokussieren den Beginn der Verbindung; die Meldung zu aufgebrauchten Credits verspricht keinen Export mehr.

## For hosts

- AIT-601 (combined entrance, desktop above 600 px, host image concept layout):
  before live, the opener thread contains only its inline axis, so the
  render-only welcome owns its height above readiness and no longer overlaps it;
  live keeps the size container and phones are unchanged. The transcript's
  40 px render-label reserve is now the shadow-internal custom property
  `--aithema-render-reserve`; before the first reply and before any visual wish
  that reserve is idle and no longer counts as content, so fitting content does
  not scroll at the readiness → live hand-off. Real overflow still scrolls: the
  transcript follows to the visitor's message at the hand-off. When a render
  label shows while follow is suspended (for example a resting pointer) and the
  reader is still at the latest position, the transcript moves by at most that
  reserve so the label does not cover the last item; an item that runs past the
  pane keeps the reading place. Fix only; no flag or option. Both the combined
  entrance and the image concept layout are host opt-ins; the default
  `'choice'` entrance is unchanged.
- AIT-589: the "Show N more notices" control keeps a constant 6 px inline
  padding and draws its keyboard focus ring inside its 44 px box vertically,
  reaching sideways at most 4 px and never beyond the actions gap.
- AIT-587 footer: while plainly connected the status reads `connected`
  ("Connected" / "Verbunden") with no running timer (the timer cell keeps its
  reserved width, hidden). The new copy key `connectedSince` with the local
  clock time is the status's `title` and accessible description
  (`aria-describedby`), on desktop and on the phone status below 600 px.
- AIT-587 copy: English writes "credits" in lower case mid-sentence across the
  credit, email and used-up copy, in the shipped confirmation mail's English
  explanation line and on the demo host's confirmation page and admin unit; the
  credit unit legend `1 Credit = 1 US cent` is unchanged. The used-up body
  (EN/DE) no longer promises an export, because the export link is not always
  shown. Host overrides keep winning.
- AIT-587 polish inside the shadow DOM: the ready-card check stays beside the
  first line of a wrapped value, the fold icon meets 3:1 non-text contrast at
  rest, only a pressed Pause is filled (live and closing Pause stay outlined),
  the summary and signals toggles share one right edge, and the overview reserve
  applies in the same frame as a pane width change.
- AIT-587 uploads: an upload plans its images with the image capability read
  after the classification await, so a processing change during a pick decides
  that pick's plan. See the AIT-610 limitation below.

### Copy compatibility

One new leaf key between RC27 and this release (path relative to `copy`); no key
was removed.

| New copy key | EN default | DE default | Legacy fallback |
| --- | --- | --- | --- |
| `connectedSince` | Connected since {time} | Verbunden seit {time} | None |

`{time}` is the connection's start as a local clock time in the page language.
Shared resolver: `packages/ui/src/copy-resolve.js`. A nondefault host override
wins, then the active locale's default, then English.

### Changed defaults relative to RC27

The complete EN/DE bundle diff between RC27 (`99a33921`) and this release
changes 29 EN defaults and 1 DE default:

- `hostSurface.usedUp.body`: EN "Your conversation stays saved. You can read and
  export it." → "Your conversation stays saved."; DE "Ihr Gespräch bleibt
  gespeichert. Sie können es lesen und exportieren." → "Ihr Gespräch bleibt
  gespeichert."
- EN "Credits" → "credits" mid-sentence, wording otherwise unchanged, in 28
  keys: `layout.creditsUnit` (" Credits" → " credits");
  `hostSurface.emailAsk.` `balance`, `balanceLow`, `benefitCredits`,
  `benefitCreditsMail`, `saved`, `folded`, `lineGive`, `lineConfirm`,
  `lineNone`, `announceAsk`, `announceLow`; `hostSurface.email.` `leadSave`,
  `leadMail`, `leadEdit`, `leadReconfirm`, `tier`, `deleteDrop`, `deleteOver`,
  `deleted`, `pendingTier`, `confirmed`; `hostSurface.usedUp.` `give`,
  `confirm`, `hostConfirm`; `hostSurface.credits.` `low`, `balanceOut`,
  `anonymous`. For example `hostSurface.credits.low` "{available} Credits left"
  → "{available} credits left".
- Confirmation mail (`@inspr/aithema-plugin-mail-smtp`, EN `explanation`):
  "Once confirmed, your credit rises to {tier} Credits." → "Once confirmed, your
  credit rises to {tier} credits." The DE mail is unchanged.

### Behaviour changes without a key change

- AIT-587: the footer no longer shows a running connection timer.
- AIT-601: the pre-live welcome's height in the combined image concept layout on
  desktop; fitting content no longer scrolls at the readiness → live hand-off
  (real overflow still follows).
- AIT-589: the "Show more notices" focus ring and its constant inline padding.

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
- On phones (600 px and narrower) in the combined entrance with a host's image
  concept layout, the ready stage leaves little space (at 390×664 the welcome is
  cut off and readiness sits below the fold); planned (AIT-603).
- On a 320×568 phone, following real overflow at the readiness → live hand-off
  can stop 44 px short of the visitor's first message; planned (AIT-606).
- In the consent sheet, a failed save shows its error twice; planned (AIT-612).
- On the ready screen the disabled fold control is drawn faint; it is to be
  hidden until there is something to fold; planned (AIT-608).
- In English, “Connected since” shows the time with a leading zero (for example
  “09:04 PM” instead of “9:04 PM”); planned (AIT-609).
- Under a stale client verdict, an upload's image bytes can reach the server,
  which refuses them, so nothing is stored; planned (AIT-610).
- If a host page tears down its DOM environment (for example a test harness that
  removes `document`) while the assistant's late answers are still in flight,
  those answers can raise an error in that page. Normal browser pages are not
  affected; planned (AIT-615).

## Breaking for hosts

**No, relative to RC27 (`v261120065345.0.0`).** No existing public export,
configuration key, HTTP status code, event, slot or host requirement changes.
The one new copy key `connectedSince` is additive and host overrides keep
winning. The UI package's public `./display` module gains one additive export,
`clockTime` (a local clock time in the page language); no export is removed or
changed. Changed defaults are wording only (EN "credits" lower case, the shorter EN/DE used-up
body) and keep every placeholder; hosts that override these keys are unaffected.
The confirmation mail's EN explanation line changes one letter's case and keeps
`{tier}`; its structure, subject and DE text are unchanged. The footer's new
`title`/`aria-describedby` and hidden timer, the AIT-601 container and scroll
behaviour (including `--aithema-render-reserve`) and the AIT-589 focus ring live
inside the component's shadow DOM and keep reserved geometry; they are visual
behaviour changes, not host contract changes.

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
with tag `v261121100916.0.0` in download/installation URLs. Retain verified assets,
manifest and deployment pin for exact rollback. See the
[embedding guide](https://github.com/inspr-at/aithema/blob/v261121100916.0.0/docs/embedding.md).
