const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const mailCopy = Object.freeze({
  de: { subject: 'E-Mail-Adresse bestätigen', lead: 'Bestätigen Sie Ihre E-Mail-Adresse', action: 'E-Mail-Adresse bestätigen',
    explanation: 'Mit der Bestätigung steigt Ihr Guthaben auf {tier} Credits.',
    explanationFallback: 'Mit der Bestätigung erhalten Sie das höhere Gesprächsguthaben.',
    linkLabel: 'Oder kopieren Sie diesen Link in Ihren Browser:',
    host: 'Gesendet von {host}, weil diese Adresse dort für ein höheres Gesprächsguthaben eingetragen wurde.',
    privacyLabel: 'Datenschutzerklärung',
    validity: 'Der Link gilt 30 Minuten und funktioniert einmal. Auf der Seite, die sich öffnet, bestätigen Sie mit einem Klick.',
    unsolicited: 'Sie haben das nicht angefordert? Dann ignorieren Sie diese E-Mail. Ohne Klick wird nichts bestätigt.',
    privacy: 'Wir nutzen Ihre E-Mail-Adresse für Ihr Guthaben und die Bestätigungsmail. Nie für Werbung. Nach 90 Tagen ohne Nutzung löschen wir sie automatisch.',
    retention: 'Bitte löschen Sie diese automatisch erzeugte Produktnachricht spätestens 90 Tage nach Abschluss des Vorgangs, sofern keine eigenständige Aufbewahrungspflicht besteht.' },
  en: { subject: 'Confirm your email address', lead: 'Confirm your email address', action: 'Confirm email address',
    explanation: 'Once confirmed, your credit rises to {tier} Credits.',
    explanationFallback: 'Confirming gives you the higher conversation credit allowance.',
    linkLabel: 'Or copy this link into your browser:',
    host: 'Sent by {host} because this address was entered there for a higher conversation credit.',
    privacyLabel: 'Privacy policy',
    validity: 'The link works for 30 minutes, and only once. On the page that opens, confirm with one click.',
    unsolicited: 'Didn’t ask for this? Then ignore this email. Nothing is confirmed without a click.',
    privacy: 'We use your email address for your credits and the confirmation email. Never for advertising. After 90 days without use, we delete it automatically.',
    retention: 'Please delete this automatically generated product message no later than 90 days after the matter is closed, unless a separate retention requirement applies.' },
});

const explanationFor = (copy, tierAfter) => tierAfter === undefined || tierAfter === null || tierAfter === ''
  ? copy.explanationFallback : copy.explanation.replace('{tier}', () => String(tierAfter));
const hostFor = (copy, host) => copy.host.replace('{host}', () => String(host));

/** Tick's approved table template: no remote assets, one progressive style block. */
export function confirmationHtml({ locale, link, copy, host, privacyUrl, tierAfter }) {
  const explanation = explanationFor(copy, tierAfter);
  return `<!doctype html>
<html lang="${escape(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(copy.lead)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.ai-page{background-color:#0b1a26!important}
.ai-band{background-color:#0c2330!important;background-image:radial-gradient(ellipse 60% 140% at 90% 0%,rgba(18,144,140,.18),rgba(18,144,140,0) 70%),linear-gradient(#0c2330,#0b1a26)!important}
.ai-hair{background-color:#2a3d4b!important;background-image:linear-gradient(to right,#0b1a26,#33495a 18%,#33495a 82%,#0b1a26)!important}
.ai-card{background-color:#102433!important;border-color:#2a3d4b!important;box-shadow:0 24px 48px -30px rgba(0,0,0,.6)!important}
.ai-rule{border-color:#2a3d4b!important}
.ai-ink{color:#eaf1f6!important}
.ai-muted{color:#9db4c4!important}
.ai-link{color:#69c8c3!important}
.ai-btn{background-color:#107c78!important}
.ai-btn-a{color:#ffffff!important}
.ai-dot{background-color:#12908c!important;background-image:radial-gradient(circle at 35% 30%,#a5e3de,#12908c 70%)!important;border-color:#143b46!important}
}
@media (max-width:480px){
.ai-gut{padding-left:12px!important;padding-right:12px!important}
.ai-pad{padding-left:24px!important;padding-right:24px!important}
.ai-card{padding:30px 24px 28px!important}
.ai-h1{font-size:25px!important;line-height:31px!important}
.ai-btn-t{width:100%!important}
.ai-btn-a{display:block!important;padding-left:16px!important;padding-right:16px!important}
}
</style>
</head>
<body class="ai-page" style="margin:0;padding:0;width:100%;background-color:#fbf7ef;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#fbf7ef;">${escape(explanation)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="ai-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#fbf7ef;">
<tr>
<td class="ai-band" style="padding:0;background-color:#eaede6;background-image:radial-gradient(ellipse 60% 140% at 90% 0%,rgba(18,144,140,.14),rgba(18,144,140,0) 70%),radial-gradient(ellipse 45% 140% at 4% 40%,rgba(255,180,94,.16),rgba(255,180,94,0) 70%),linear-gradient(#eaede6,#fbf7ef);">
<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse;">
<tr>
<td class="ai-pad" style="padding:30px 40px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<tr>
<!--[if !mso]><!--><td style="padding:0 12px 0 0;vertical-align:middle;"><div class="ai-dot" style="width:10px;height:10px;border:4px solid #d6e6e2;border-radius:50%;background-color:#0e6f6c;background-image:radial-gradient(circle at 35% 30%,#7fd3cd,#0e6f6c 70%);font-size:1px;line-height:1px;">&nbsp;</div></td><!--<![endif]-->
<td class="ai-ink" style="vertical-align:middle;font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.5px;color:#102b42;">Aithema</td>
</tr>
</table>
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
<tr>
<td class="ai-hair" height="1" style="height:1px;padding:0;font-size:1px;line-height:1px;background-color:#d9dad6;background-image:linear-gradient(to right,#fbf7ef,#cfd3d2 18%,#cfd3d2 82%,#fbf7ef);">&nbsp;</td>
</tr>
<tr>
<td class="ai-gut" style="padding:32px 16px 0;">
<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:separate;">
<tr>
<td class="ai-card" style="padding:40px 40px 36px;background-color:#fffcf8;border:1px solid #e3e2dd;border-radius:18px;box-shadow:0 1px 2px rgba(16,43,66,.04),0 24px 48px -30px rgba(16,43,66,.3);">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td style="padding:0;">
<h1 class="ai-ink ai-h1" style="margin:0;font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif;font-size:28px;line-height:34px;font-weight:400;letter-spacing:-0.3px;color:#102b42;">${escape(copy.lead)}</h1>
</td>
</tr>
<tr>
<td style="padding:12px 0 0;">
<p class="ai-ink" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#102b42;">${escape(explanation)}</p>
</td>
</tr>
<tr>
<td style="padding:28px 0 0;">
<table role="presentation" class="ai-btn-t" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
<tr>
<td class="ai-btn" align="center" bgcolor="#0e6f6c" style="background-color:#0e6f6c;border-radius:12px;mso-padding-alt:14px 28px;">
<a class="ai-btn-a" href="${escape(link)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-align:center;text-decoration:none;border-radius:12px;">${escape(copy.action)}</a>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:16px 0 0;">
<p class="ai-muted" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#496477;">${escape(copy.validity)}</p>
</td>
</tr>
<tr>
<td style="padding:20px 0 0;">
<p class="ai-muted" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:#496477;">${escape(copy.linkLabel)}</p>
<p style="margin:4px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;word-break:break-all;overflow-wrap:anywhere;"><a class="ai-link" href="${escape(link)}" target="_blank" style="color:#0e6f6c;text-decoration:underline;word-break:break-all;">${escape(link)}</a></p>
</td>
</tr>
<tr>
<td style="padding:28px 0 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td class="ai-rule" height="1" style="height:1px;padding:0;border-top:1px solid #e3e2dd;font-size:1px;line-height:1px;">&nbsp;</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:20px 0 0;">
<p class="ai-muted" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#496477;">${escape(copy.unsolicited)}</p>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td class="ai-pad" style="padding:24px 40px 44px;">
<p class="ai-muted" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#496477;">${escape(hostFor(copy, host))}</p>
<p class="ai-muted" style="margin:10px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#496477;">${escape(copy.privacy)}${privacyUrl ? ` <a class="ai-link" href="${escape(privacyUrl)}" target="_blank" style="color:#0e6f6c;text-decoration:underline;">${escape(copy.privacyLabel)}</a>` : ''}</p>
<p class="ai-muted" style="margin:10px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#496477;">${escape(copy.retention)}</p>
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>`;
}
export function confirmationMessage({ locale = 'en', link, expiresAt, now = Date.now(), host = new URL(link).host,
  privacyUrl, tierAfter, htmlTemplate = confirmationHtml }) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new TypeError('Expired confirmation link');
  locale = locale === 'de' ? 'de' : 'en';
  const copy = mailCopy[locale], explanation = explanationFor(copy, tierAfter);
  return { subject: copy.subject,
    text: ['Aithema', copy.lead, explanation, copy.action + ':\n' + link, copy.validity, copy.unsolicited,
      '-- \n' + hostFor(copy, host), copy.privacy + (privacyUrl ? '\n' + copy.privacyLabel + ': ' + privacyUrl : ''), copy.retention].join('\n\n'),
    html: htmlTemplate({ locale, link, copy, host, privacyUrl, tierAfter }) };
}
