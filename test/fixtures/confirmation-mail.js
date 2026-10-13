import assert from 'node:assert/strict';

// Binding C1 product/privacy text: intentionally independent of the implementation.
export const bindingMailText = {
  de: {
    privacy: 'Wir nutzen Ihre E-Mail-Adresse für Ihr Guthaben und die Bestätigungsmail. Nie für Werbung. Nach 90 Tagen ohne Nutzung löschen wir sie automatisch.',
    retention: 'Bitte löschen Sie diese automatisch erzeugte Produktnachricht spätestens 90 Tage nach Abschluss des Vorgangs, sofern keine eigenständige Aufbewahrungspflicht besteht.',
  },
  en: {
    privacy: 'We use your email address for your credits and the confirmation email. Never for advertising. After 90 days without use, we delete it automatically.',
    retention: 'Please delete this automatically generated product message no later than 90 days after the matter is closed, unless a separate retention requirement applies.',
  },
};

export function assertConfirmationMail(message, { locale, link, privacyUrl }) {
  const { html, text } = message;
  assert.ok(Buffer.byteLength(html) < 60 * 1024, 'mail stays below 60 KB');
  assert.equal((html.match(/<style\b/giu) ?? []).length, 1);
  assert.equal((html.match(/<\/style>/giu) ?? []).length, 1);
  assert.doesNotMatch(html, /<(?:img|script|link|iframe)\b|url\s*\(|@import/iu);
  const decode = value => value.replaceAll('&amp;', '&');
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/gu)].map(m => decode(m[1])), [link, link, ...(privacyUrl ? [privacyUrl] : [])]);
  assert.deepEqual([...html.matchAll(/https?:\/\/[^\s"<>]+/gu)].map(m => decode(m[0])), [link, link, link, ...(privacyUrl ? [privacyUrl] : [])], 'no extra URLs anywhere in the mail');
  for (const sentence of Object.values(bindingMailText[locale])) {
    assert.ok(html.includes(sentence), 'HTML keeps the binding sentence byte for byte');
    assert.ok(text.includes(sentence), 'text keeps the binding sentence byte for byte');
  }
  assert.ok(text.includes('\n' + link + '\n'));
  if (privacyUrl) assert.ok(text.includes(privacyUrl));
  return `size=${Buffer.byteLength(html)} bytes; one <style>; URL count=2 confirmation links${privacyUrl ? ' + 1 privacy link (2 destinations)' : ' (1 destination)'}; binding text verbatim; no remote resources`;
}
