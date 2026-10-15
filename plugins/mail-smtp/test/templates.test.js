import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// SHA-256 of subject + NUL + text + NUL + HTML from the pre-AIT-220 template
// (main 5a880683), covering both privacy links/tier values and their fallbacks.
const demoMailDigests = {
  de: ['be7d9074689f5f1a8791784d7a06271fef0356d4fe5849a5b163eccfdb064c24', '995188382773d77a966b74f6471b8ca940e2a5fa5ba36ae849feab5fee3a011b'],
  en: ['6f8d4d87c0cc8511d0c4f7261fe8439d329848f8de903e86b2256f55863961e1', '6bbd6253dd295604b73f7e69ccbb9cd514146de0b7cd68e94be5432d7477bc88'],
};
for (const locale of ['de', 'en']) for (const privacy of [false, true]) {
  test(`AIT-220 ${locale} demo mail stays byte-identical (privacy/tier=${privacy})`, () => {
    const message = confirmationMessage({ locale, link: `https://host.example.test/confirm-email?token=opaque&lang=${locale}`,
      privacyUrl: privacy ? `https://host.example.test/privacy?locale=${locale}` : undefined,
      tierAfter: privacy ? (locale === 'de' ? '2.000' : '2,000') : undefined, expiresAt: 1_801_000, now: 1_000 });
    const digest = createHash('sha256').update([message.subject, message.text, message.html].join('\0')).digest('hex');
    assert.equal(digest, demoMailDigests[locale][Number(privacy)]);
  });
}

function capturedMail(options = {}) {
  const sent = [];
  const plugin = createSmtpMail({ config: smtpConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'sender@example.test' }),
    publicOrigin: 'https://host.example.test',
    createTransport: () => ({ async sendMail(message) { sent.push(message); }, close() {} }), ...options });
  return { plugin, sent };
}
const verification = { address: 'visitor@example.test', token: 'opaque', expiresAt: Date.now() + 1_800_000 };

test('AIT-220 both mail parts use host copy and a locale privacy URL, with and without a tier', async t => {
  const copy = {
    en: { brand: 'Augmentoring Start', privacy: 'We delete your sign-in address after 24 hours.',
      retention: 'Delete this sign-in message within 24 hours.', explanation: 'Sign in to your workspace.',
      explanationFallback: 'Sign in to your workspace.', host: 'Sent by {brand} at {host}.' },
    de: { brand: 'Augmentoring Start', privacy: 'Wir löschen Ihre Anmeldeadresse nach 24 Stunden.',
      retention: 'Löschen Sie diese Anmeldenachricht innerhalb von 24 Stunden.', explanation: 'Melden Sie sich an.',
      explanationFallback: 'Melden Sie sich an.', host: 'Gesendet von {brand} auf {host}.' },
  };
  const locales = [];
  const { plugin, sent } = capturedMail({ copy, privacyUrl: locale => {
    locales.push(locale); return `https://start.example.test/privacy?lang=${locale}`;
  } });
  t.after(() => plugin.close());
  assert.deepEqual(locales, ['de', 'en'], 'resolve every supported locale at construction');
  for (const locale of ['en', 'de']) for (const confirmedAllowanceMicro of [undefined, 23_456_789]) {
    await plugin.requestVerification({ ...verification, locale, confirmedAllowanceMicro });
    const message = sent.at(-1);
    for (const part of [message.text, message.html]) {
      for (const field of ['brand', 'privacy', 'retention', 'explanation']) assert.ok(part.includes(copy[locale][field]), field);
      assert.ok(part.includes(copy[locale].host.replace('{brand}', copy[locale].brand).replace('{host}', 'host.example.test')));
      assert.ok(part.includes(`https://start.example.test/privacy?lang=${locale}`));
      assert.doesNotMatch(part, /Aithema|90 (?:days|Tagen)|Credits|\{brand\}/u);
    }
  }
  assert.deepEqual(locales, ['de', 'en'], 'delivery uses the validated URL snapshot');
});

test('AIT-220 partial copy falls back per field and locale and is snapshotted for both templates', async t => {
  const copy = { en: { brand: 'Host Brand', privacy: 'Host privacy', retention: '' } };
  let htmlCopy;
  const { plugin, sent } = capturedMail({ copy, privacyUrl: 'http://start.example.test/privacy?lang=en&mode=mail',
    htmlTemplate: options => { htmlCopy = options.copy; return confirmationHtml(options); } });
  t.after(() => plugin.close());
  copy.en.brand = 'Changed after construction';
  for (const locale of ['en', 'de', 'fr']) {
    await plugin.requestVerification({ ...verification, locale });
    const message = sent.at(-1), effectiveLocale = locale === 'de' ? 'de' : 'en';
    assert.deepEqual(htmlCopy, { ...mailCopy[effectiveLocale], ...(effectiveLocale === 'en'
      ? { brand: 'Host Brand', privacy: 'Host privacy', retention: '' } : {}) });
    assert.ok(Object.isFrozen(htmlCopy));
    assert.equal(message.subject, mailCopy[effectiveLocale].subject);
    for (const part of [message.text, message.html]) {
      assert.ok(part.includes(htmlCopy.brand)); assert.ok(part.includes(htmlCopy.privacy));
      assert.ok(part.includes(htmlCopy.explanationFallback)); assert.ok(part.includes(htmlCopy.validity));
    }
    assert.ok(message.text.includes('http://start.example.test/privacy?lang=en&mode=mail'));
    assert.ok(message.html.includes('http://start.example.test/privacy?lang=en&amp;mode=mail'));
    if (effectiveLocale === 'en') assert.doesNotMatch(message.text + message.html, /Aithema|Please delete/u);
  }
  assert.equal(mailCopy.en.brand, 'Aithema');
});

test('AIT-220 host fields, brand/signature and URLs retain HTML escaping', async t => {
  const input = '<script>&"\'$&';
  const copy = Object.fromEntries(Object.keys(mailCopy.en).map(key => [key, input]));
  copy.explanation = '{tier} ' + input; copy.host = '{brand} {host}';
  const { plugin, sent } = capturedMail({ copy: { en: copy }, privacyUrl: 'https://start.example.test/privacy?x="\'&lang=en' });
  t.after(() => plugin.close());
  await plugin.requestVerification({ ...verification, locale: 'en', confirmedAllowanceMicro: 23_456_789 });
  assert.ok(sent[0].text.startsWith(input + '\n\n'));
  assert.ok(sent[0].text.includes('-- \n' + input + ' host.example.test'));
  assert.doesNotMatch(sent[0].html, /<script>|\{brand\}|\{host\}|\{tier\}/u);
  assert.ok(sent[0].html.includes('&lt;script&gt;&amp;&quot;&#39;$&amp;'));
  assert.ok(sent[0].html.includes('privacy?x=&quot;&#39;&amp;lang=en'));
});

test('AIT-220 malformed copy and unknown locales/fields fail at construction before transport creation', () => {
  for (const copy of [null, [], 'brand', 7, { fr: {} }, { en: null }, { en: [] }, { en: 'brand' },
    { en: { typo: 'text' } }, { de: { brand: 42 } }, { en: { privacy: null } }, { en: { retention: undefined } },
    { en: { explanation: () => 'text' } }, { en: { [Symbol('field')]: 'text' } }, JSON.parse('{"en":{"__proto__":"text"}}')]) {
    assert.throws(() => capturedMail({ copy, createTransport() { assert.fail('transport must not be created'); } }), /Invalid SMTP copy/u);
  }
});

test('AIT-220 invalid privacy URLs and invalid function results fail at construction for every locale', () => {
  for (const privacyUrl of ['', '/privacy?lang=en', '//start.example.test/privacy', 'javascript:alert(1)', 'data:text/html,privacy',
    'mailto:privacy@example.test', 'ftp://start.example.test/privacy', 'https://', null, 42, {}, new URL('https://start.example.test'),
    () => undefined, () => Promise.resolve('https://start.example.test'), () => { throw new Error('host error'); },
    locale => locale === 'en' ? 'javascript:alert(1)' : 'https://start.example.test/privacy',
    locale => locale === 'de' ? '/privacy' : 'https://start.example.test/privacy']) {
    assert.throws(() => capturedMail({ privacyUrl, createTransport() { assert.fail('transport must not be created'); } }), /Invalid SMTP privacyUrl.*http\(s\)/u);
  }
});
