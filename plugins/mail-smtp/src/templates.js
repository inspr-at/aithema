const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const mailCopy = Object.freeze({
  de: { subject: 'E-Mail-Adresse bestätigen', action: 'E-Mail-Adresse bestätigen',
    explanation: 'Mit der Bestätigung erhalten Sie das höhere Gesprächsguthaben.',
    validity: 'Der Link gilt 30 Minuten und kann einmal verwendet werden. Auf der geöffneten Seite bestätigen Sie Ihre E-Mail-Adresse mit einem Klick.',
    unsolicited: 'Wenn Sie diesen Link nicht angefordert haben, können Sie diese Nachricht ignorieren.',
    privacy: 'Wir nutzen Ihre E-Mail-Adresse für Ihr Guthaben und die Bestätigungsmail. Nie für Werbung. Nach 90 Tagen ohne Nutzung löschen wir sie automatisch.',
    retention: 'Bitte löschen Sie diese automatisch erzeugte Produktnachricht spätestens 90 Tage nach Abschluss des Vorgangs, sofern keine eigenständige Aufbewahrungspflicht besteht.' },
  en: { subject: 'Confirm your email address', action: 'Confirm email address',
    explanation: 'Confirming gives you the higher conversation credit allowance.',
    validity: 'The link is valid for 30 minutes and can be used once. On the page that opens, confirm your email address with one click.',
    unsolicited: 'If you did not request this link, you can ignore this message.',
    privacy: 'We use your email address for your credits and the confirmation email. Never for advertising. After 90 days without use, we delete it automatically.',
    retention: 'Please delete this automatically generated product message no later than 90 days after the matter is closed, unless a separate retention requirement applies.' },
});

/** C2 design seam: replace this template while retaining the plain-text alternative.
 * All content is inline; the only URL is the host confirmation link. */
export function confirmationHtml({ locale, link, copy }) {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body style="font-family:Arial,sans-serif;line-height:1.6;margin:24px"><h1>${escape(copy.subject)}</h1><p>${escape(copy.explanation)}</p><p><a href="${escape(link)}">${escape(copy.action)}</a></p><p>${escape(copy.validity)}</p><p>${escape(link)}</p><p>${escape(copy.unsolicited)}</p><p>${escape(copy.privacy)}</p><p>${escape(copy.retention)}</p></body></html>`;
}
export function confirmationMessage({ locale = 'en', link, expiresAt, now = Date.now(), htmlTemplate = confirmationHtml }) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new TypeError('Expired confirmation link');
  locale = locale === 'de' ? 'de' : 'en';
  const copy = mailCopy[locale];
  return { subject: copy.subject, text: [copy.action, link, copy.explanation, copy.validity, copy.unsolicited, copy.privacy, copy.retention].join('\n\n'),
    html: htmlTemplate({ locale, link, copy }) };
}
