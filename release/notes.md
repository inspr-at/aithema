# Aithema 2026.10

Version **261123053431.0.0**. Licensed under **AGPL-3.0-only**.

On a phone in the combined entrance, the welcome and readiness card fit when
the host uses image concepts, and typing leaves more room for the conversation.
The combined entrance is a host opt-in, and the default entrance remains
`'choice'`. Consent errors appear beside the action, and export controls explain
when a download is unavailable.

## What visitors notice

- **Steady phone typing (AIT-603, #499, #500).** On phones the welcome and the readiness card are visible without scrolling when a host uses image concepts. The combined entrance is a host opt-in, and the default entrance remains `'choice'`.
- **Calmer ready screen (AIT-608, #503).** Controls that cannot do anything yet are no longer shown.
- **Consent errors once (AIT-612, #505).** A failed consent save shows one clear message.
- **Natural clock times (AIT-609, #504).** Times read naturally in English and German.
- **More room while typing (AIT-618, #507).** Typing on a small phone leaves room for your message instead of hints you cannot use. The combined entrance is a host opt-in, and the default entrance remains `'choice'`.
- **Safer owner requests (AIT-625, #506).** Your conversation data is only ever sent to the site you are on, never to another address.
- **Clear export status (AIT-637, #509).** When export is not possible, the button says so instead of failing silently.

## Was Besucher bemerken

- **Ruhiges Tippen am Handy (AIT-603, #499, #500).** Auf dem Handy sind Begrüßung und Bereitschaftsfeld ohne Scrollen sichtbar, wenn ein Host Bildkonzepte nutzt. Der kombinierte Einstieg ist eine Host-Option und der Standardeinstieg bleibt `'choice'`.
- **Ruhigerer Startbildschirm (AIT-608, #503).** Bedienelemente, die noch nichts tun können, werden nicht mehr angezeigt.
- **Einwilligungsfehler einmal (AIT-612, #505).** Ein fehlgeschlagenes Speichern der Einwilligung zeigt eine klare Meldung.
- **Natürliche Uhrzeiten (AIT-609, #504).** Uhrzeiten lesen sich auf Englisch und Deutsch natürlich.
- **Mehr Platz beim Tippen (AIT-618, #507).** Beim Tippen auf kleinen Handys bleibt Platz für die Nachricht statt für Hinweise, die dort nicht nutzbar sind. Der kombinierte Einstieg ist eine Host-Option und der Standardeinstieg bleibt `'choice'`.
- **Sicherere Anfragen (AIT-625, #506).** Ihre Gesprächsdaten gehen nur an die Seite, auf der Sie sind, nie an eine andere Adresse.
- **Klarer Export-Status (AIT-637, #509).** Wenn der Export nicht geht, sagt es die Schaltfläche, statt still zu scheitern.

## For hosts

**Breaking for browser relay hosts (AIT-625).** A relay using the built-in
browser network client requires `network.ownerFetch`. Opening the relay
throws before any request is sent if the helper is missing. Import
`ownerFetch` from `@inspr/aithema-ui/owner-request` and inject it. For explicit
token authentication, pass the token as `network.sessionToken` in place of
the raw `x-aithema-session-token` header. The relay still maps that legacy
header to the token option if present. Cookie-authenticated hosts inject
`ownerFetch` and omit `sessionToken`.

Before (RC28):

```js
const grokVoice = createGrokVoiceClient({
  control: voiceControl,
  network: {
    url: '/api/voice/grok/relay',
    headers: { 'x-aithema-session-token': sessionToken },
  },
});
```

After (RC29):

```js
import { ownerFetch } from '@inspr/aithema-ui/owner-request';

const grokVoice = createGrokVoiceClient({
  control: voiceControl,
  network: { url: '/api/voice/grok/relay', ownerFetch, sessionToken },
});
```

The same migration applies to direct browser calls to `createNetworkRelayClient({ url, headers })`.

### Behaviour changes and host-visible DOM

- AIT-603 (#499, #500). On phones in the combined entrance with a host's
  image concept layout, the dock leaves room for the welcome and readiness
  panel. The combined entrance is a host opt-in, and the default entrance
  remains `'choice'`. The phone dock shows the short consent reason and
  action on one row while the keyboard is up. If feedback clears during
  typing, its held height can persist until the keyboard closes. This keeps
  Mic and Send steady. In RC28 the composer's consent action was named
  “Give consent…: messages need your consent” (DE “Einwilligen…: Nachrichten
  brauchen Ihre Einwilligung”). Its accessible name is now the visible action
  alone, with the full host sentence as its accessible description. The
  settings sheet reveals that sentence when opened. The shipped copy key
  `featureConsent.textActionReason` is unused, so overrides have no effect.
- AIT-608. The ready screen's unavailable fold control is now hidden and
  inert, including for keyboard and assistive technology. Its layout space
  is reserved until the control becomes available.
- AIT-612. The Settings consent sheet shows a failed save once next to the
  action. A load failure gives a specific message and a Close action so
  the visitor can close and reopen the sheet.
- AIT-609. The public `@inspr/aithema-ui/display` export `clockTime` now
  formats a single-digit hour without a leading zero. For example, English
  changes from “09:04 PM” to “9:04 PM” and German shows “21:04” for the same
  evening time. The additive `dateClock` export combines a medium date with
  the same time format for the conversation library. Host code that parses
  display strings needs to accept variable-width hours.
- AIT-618. The combined entrance is a host opt-in, and the default entrance
  remains `'choice'`. In the combined entrance, the touch ⌘+Enter hint is
  hidden and one keyboard-up state toggles `data-phone-keyboard` and
  `data-phone-keyboard-band` together. The compact voice band uses a 44 px
  row and the AI notice uses one line with a More target. If a host header
  control enters Pause's column, `data-keyboard-rail-row` allows the band
  to grow to 88 px and moves Pause alone to the second row. That height
  lasts until the keyboard closes. The component marks late header actions
  with `data-keyboard-late` and orders them at the start of the header during
  this state. See AIT-635 below for late insertion through host slots.
- AIT-625. `@inspr/aithema-ui/owner-request` adds `ownerURL` and `ownerFetch`.
  Session-owner requests use the page origin, reject redirects, and fail
  closed before sending if the page lacks a usable HTTP(S) origin or the
  target resolves off-origin. This restriction covers session-owner
  requests. ElevenLabs voice sends audio directly from the browser to
  ElevenLabs. A finite owner response is buffered within
  the deadline for headers and body, with a 64 MiB limit by default and
  256 MiB for the conversation ZIP. The successful event stream stays
  unbuffered. Both export controls are anchors with `role="link"` and
  `tabindex="0"` and carry no `href`. Use the existing control activation
  for a download or read the role when styling or scripting those controls.
  Keyboard activation and click both request the ZIP through the helper.
- AIT-637. When export is unavailable, visible export controls use
  `aria-disabled` and describe the reason. The footer shows the reason and
  exposes it as a tooltip. The composer announces it via the accessible
  description. Both recheck on activation. On-device conversations retain
  the separate `deviceExportUnavailable` explanation.

### Copy compatibility

Three new leaf keys relative to RC28, with paths relative to `copy`. A
nondefault host override wins, followed by the active locale's default and
then English.

| New copy key | EN default | DE default | Legacy fallback |
| --- | --- | --- | --- |
| `settings.close` | Close | Schließen | None |
| `host.consentPage.loadFailed` | Could not load consent. Close and open it again. | Die Einwilligung konnte nicht geladen werden. Schließen und erneut öffnen. | None |
| `exportUnavailable` | Export isn't available on this page. | Der Export ist auf dieser Seite nicht verfügbar. | None |

### Changed defaults relative to RC28

The complete EN/DE bundle diff at `780d5241..fb413b06` adds the three keys
above. It changes zero existing default strings and removes zero keys. The
shipped EN/DE confirmation mail template text also matches RC28. Consent,
export, layout and time-format behaviour changes are described above.

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
- On a 320×568 phone, following real overflow at the readiness → live hand-off
  can stop 44 px short of the visitor's first message; planned (AIT-606).
- Under a stale client verdict, an upload's image bytes can reach the server,
  which refuses them, so nothing is stored; planned (AIT-610).
- If a host page tears down its DOM environment (for example a test harness that
  removes `document`) while the assistant's late answers are still in flight,
  those answers can raise an error in that page. Normal browser pages are not
  affected; planned (AIT-615).
- On phones with the on-screen keyboard up and Aithema's compact layout active,
  a header control that a host inserts into `slot="account"` can overlap Pause.
  A control inserted into `slot="contact-launcher"` can overlap while the page
  is pinch-zoomed; planned (AIT-635).
- Operator login and `/admin` navigation and logout forms still bypass the
  guarded helper. The relative routes normally resolve to the page's origin.
  A foreign `<base>` can re-point those links and the logout form action.
  These native actions carry no session-owner token. This predates RC29.
  The fix is planned (AIT-633).

## Breaking for hosts

These changes are relative to RC28 (`v261121100916.0.0`).

- AIT-625. All component requests use `ownerFetch`. Cross-origin `baseUrl`
  values and opaque or non-HTTP(S) page origins (such as `about:srcdoc` or a
  sandboxed frame without `allow-same-origin`) fail before sending. A redirect
  response also fails before the browser sends a follow-up request. Serve the
  component in a page with a real HTTP(S) origin, use a same-origin `baseUrl`,
  and serve owner routes without redirects.
- AIT-625. Browser relay hosts must inject `network.ownerFetch` and use
  `network.sessionToken` for explicit token authentication, as shown above.
  Code that read an export control's `href` must use the new control behaviour.
- AIT-603. Update tests and scripts that locate composer consent by accessible name to use the visible action alone. Overrides of `featureConsent.textActionReason` are ignored.
- AIT-609. Code that expects fixed-width clock display strings must accept
  single-digit hours without a leading zero.

Host styles that depend on keyboard and export markup should account for the
DOM changes above.

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
with tag `v261123053431.0.0` in download/installation URLs. Retain verified assets,
manifest and deployment pin for exact rollback. See the
[embedding guide](https://github.com/inspr-at/aithema/blob/v261123053431.0.0/docs/embedding.md).
