import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationHtml, confirmationMessage, mailCopy } from '../src/templates.js';
import { createSmtpMail, smtpConfig } from '../src/index.js';
import { assertConfirmationMail, bindingMailText } from '../../../test/fixtures/confirmation-mail.js';

for (const locale of ['de', 'en']) {
  for (const privacy of [true, false]) test(`C2 ${locale} mail is complete, binding, small and contains only approved links (privacy=${privacy})`, () => {
    const c = mailCopy[locale], tierAfter = locale === 'de' ? '2.000' : '2,000';
    const link = `https://host.example.test/confirm-email?token=opaque&lang=${locale}`;
    const privacyUrl = privacy ? `https://host.example.test/privacy?locale=${locale}` : undefined;
    const message = confirmationMessage({ locale, link, privacyUrl, tierAfter, host: 'host.example.test', expiresAt: 1_801_000, now: 1_000 });
    assertConfirmationMail(message, { locale, link, privacyUrl });
    assert.equal(c.privacy, bindingMailText[locale].privacy); assert.equal(c.retention, bindingMailText[locale].retention);
    assert.equal(message.subject, c.subject);
    assert.equal(message.text, ['Aithema', c.lead, c.explanation.replace('{tier}', tierAfter), c.action + ':\n' + link, c.validity, c.unsolicited,
      '-- \n' + c.host.replace('{host}', 'host.example.test'), c.privacy + (privacyUrl ? '\n' + c.privacyLabel + ': ' + privacyUrl : ''), c.retention].join('\n\n'));
    assert.ok(message.html.includes(c.linkLabel));
    assert.ok(message.html.includes(tierAfter + ' Credits'));
    assert.doesNotMatch(message.html + message.text, /2[.,]400|lena\.gruber|12 (?:Minuten|minutes)|start2\.augmentoring/u);
  });
  test(`C2 ${locale} mail has the approved no-tier fallback`, () => {
    const message = confirmationMessage({ locale, link: 'https://host.example.test/confirm-email?token=opaque', expiresAt: 2, now: 1 });
    assert.ok(message.html.includes(mailCopy[locale].explanationFallback));
    assert.ok(message.text.includes(mailCopy[locale].explanationFallback));
    assert.doesNotMatch(message.html + message.text, /\{tier\}|undefined|null/u);
  });
  test(`C2 ${locale} SMTP effect formats the configured allowance and optional privacy URL without networking`, async () => {
    const sent = [];
    const plugin = createSmtpMail({ config: smtpConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'sender@example.test' }), publicOrigin: 'https://host.example.test',
      createTransport: () => ({ async sendMail(message) { sent.push(message); }, close() {} }) });
    try {
      for (const privacyDocumentConfigured of [true, false]) await plugin.requestVerification({ address: 'visitor@example.test', token: 'opaque', locale,
        expiresAt: Date.now() + 1_800_000, confirmedAllowanceMicro: 23_456_789, privacyDocumentConfigured });
      for (const [i, message] of sent.entries()) {
        const tier = locale === 'de' ? '2.345' : '2,345';
        assert.ok(message.html.includes(tier + ' Credits')); assert.ok(message.text.includes(tier + ' Credits'));
        assertConfirmationMail(message, { locale, link: `https://host.example.test/confirm-email?token=opaque&lang=${locale}`,
          privacyUrl: i === 0 ? `https://host.example.test/privacy?locale=${locale}` : undefined });
      }
    } finally { plugin.close(); }
  });
}

test('C2 every HTML placeholder is escaped, including values that look like template replacements', () => {
  const input = '<script>&"\'$&';
  const copy = Object.fromEntries(Object.entries(mailCopy.en).map(([key]) => [key, input]));
  copy.explanation = '{tier}'; copy.host = '{host}';
  const html = confirmationHtml({ locale: input, link: input, host: input, privacyUrl: input, tierAfter: input, copy });
  assert.doesNotMatch(html, /<script>|\{\{|\{tier\}|\{host\}/u);
  assert.ok(html.includes('&lt;script&gt;&amp;&quot;&#39;$&amp;'));
});
