# SMTP confirmation mail

`createSmtpMail` implements the host's `requestVerification` delivery port.
The host owns redemption, SMTP configuration and its privacy policy. With no
`config`, the factory returns `null`. The transport connects only on delivery.

Pass `copy: { en: { ... }, de: { ... } }` to override individual `mailCopy`
fields. Missing fields and locales keep the demo defaults. One merged,
immutable copy supplies the subject, text and HTML (including a custom
`htmlTemplate`). Invalid copy objects, unknown locales/fields and non-string
field values throw a `TypeError` at construction. Subjects also reject control
characters.

Supported fields are `brand` (default `Aithema`), `subject`, `lead`, `action`,
`explanation`, `explanationFallback`, `linkLabel`, `host`, `privacyLabel`,
`validity`, `unsolicited`, `privacy` and `retention`. `explanation` interpolates
`{tier}` when a confirmed allowance is supplied; otherwise
`explanationFallback` is used. `host` is the signature and supports `{brand}`
and `{host}`. HTML escapes all copy and interpolated values. Text stays plain.

`privacyUrl` accepts an absolute HTTP(S) URL string or a synchronous
`(locale) => string`. The factory calls the function once for each supported
locale (`de`, `en`) and validates both results. It calls and validates the
function again when building each message; invalid results prevent delivery.
URLs reject control characters and whitespace and use their normalized `href`.
Invalid URLs, non-string results and thrown errors fail at construction too.
An explicit URL appears in both parts. Without this option, the link remains
`<publicOrigin>/privacy?locale=<locale>` and appears only when the delivery
effect has `privacyDocumentConfigured: true`, preserving demo behavior.
Other delivery locales fall back to English.

A START-like host can supply its own sign-in wording and 24-hour retention:

```js
import { createSmtpMail, smtpConfig } from '@inspr/aithema-plugin-mail-smtp';

const mail = createSmtpMail({
  config: smtpConfig(hostSmtpSettings),
  publicOrigin: 'https://start.example.test',
  privacyUrl: locale => `https://start.example.test/privacy?lang=${locale}`,
  copy: {
    en: {
      brand: 'Augmentoring Start',
      explanation: 'Confirm your address to sign in.',
      explanationFallback: 'Confirm your address to sign in.',
      host: 'Sent by {brand} at {host} because you requested a sign-in link.',
      privacy: 'We use your address to sign you in and delete it after 24 hours.',
      retention: 'Please delete this sign-in message within 24 hours.',
    },
    de: {
      brand: 'Augmentoring Start',
      explanation: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      explanationFallback: 'Bestätigen Sie Ihre Adresse, um sich anzumelden.',
      host: 'Gesendet von {brand} auf {host}, weil Sie einen Anmeldelink angefordert haben.',
      privacy: 'Wir nutzen Ihre Adresse zur Anmeldung und löschen sie nach 24 Stunden.',
      retention: 'Bitte löschen Sie diese Anmeldenachricht innerhalb von 24 Stunden.',
    },
  },
});
```

Copy describes the host's policy; it does not change storage or deletion.
Override both explanation fields when the host does not use the credit model.
Custom `htmlTemplate` functions receive the same merged `copy` as the text
renderer and should use it for all wording.
