import { randomBytes } from 'node:crypto';
import { privacyDocumentConfigured } from '../packages/server/src/host-handlers.js';
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const confirmationCopy = Object.freeze({
  de: { title: 'E-Mail-Adresse bestätigen', button: 'E-Mail-Adresse bestätigen', return: 'Zurück zum Gespräch',
    valid: 'Bestätigen Sie Ihre E-Mail-Adresse, um das höhere Gesprächsguthaben zu erhalten.', confirmed: 'Ihre E-Mail-Adresse ist bestätigt. Ihr höheres Guthaben steht im Gespräch bereit.',
    alreadyUsed: 'Dieser Link wurde bereits verwendet.', expired: 'Dieser Link ist abgelaufen. Fordern Sie in den Einstellungen unter E-Mail einen neuen Link an.',
    invalid: 'Dieser Bestätigungslink ist ungültig. Fordern Sie in den Einstellungen unter E-Mail einen neuen Link an.',
    tooManyAttempts: 'Zu viele Bestätigungsversuche. Fordern Sie in den Einstellungen unter E-Mail einen neuen Link an.' },
  en: { title: 'Confirm email address', button: 'Confirm email address', return: 'Return to conversation',
    valid: 'Confirm your email address to receive the higher conversation credit allowance.', confirmed: 'Your email address is confirmed. Your higher credit allowance is ready in the conversation.',
    alreadyUsed: 'This link has already been used.', expired: 'This link has expired. Request a new link under Email in Settings.',
    invalid: 'This confirmation link is invalid. Request a new link under Email in Settings.',
    tooManyAttempts: 'Too many confirmation attempts. Request a new link under Email in Settings.' },
});
const statusFor = state => ({ valid: 200, confirmed: 200, alreadyUsed: 409, expired: 410, invalid: 400, tooManyAttempts: 429 })[state];

/** C1 plain host page; C2 owns the designed landing page. No GET writes evidence. */
export function createConfirmationPage({ host, publicOrigin }) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin) throw new TypeError('Invalid confirmation public origin');
  const secure = origin.protocol === 'https:', cookieName = secure ? '__Host-aithema-confirm-csrf' : 'aithema-confirm-csrf';
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
  const refused = status => new Response(null, { status, headers });
  function render({ state, locale = 'en', token = '', cookie = '' }, post = false) {
    const c = confirmationCopy[locale === 'de' ? 'de' : 'en'];
    const csrf = host.confirmation.csrf(cookie, token);
    const form = state === 'valid' ? `<form method="post" action="/confirm-email"><input type="hidden" name="token" value="${escape(token)}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="lang" value="${locale}"><button type="submit">${c.button}</button></form>` : '';
    return new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${c.title}</title><link rel="stylesheet" href="/demo/host.css"><script src="/demo/theme-init.js"></script></head><body><main class="privacy-page"><h1>${c.title}</h1><p data-confirmation-state="${state}">${c[state]}</p>${form}<p><a href="/">${c.return}</a></p></main></body></html>`,
      { status: post ? statusFor(state) : 200, headers: { ...headers, ...(cookie ? { 'set-cookie': `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${secure ? '; Secure' : ''}` } : {}) } });
  }
  return { async handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/confirm-email') return null;
    if (!host.identity.deliversVerification) return refused(404);
    if (host.demo !== true && !privacyDocumentConfigured(host)) return refused(403);
    if (request.method === 'GET') {
      const token = url.searchParams.get('token') ?? '';
      if (token.length > 2048) return refused(400);
      const result = host.confirmation.inspect(token), locale = result.locale ?? (url.searchParams.get('lang') === 'de' ? 'de' : 'en');
      return render({ ...result, locale, token, cookie: randomBytes(24).toString('hex') });
    }
    if (request.method !== 'POST') return refused(405);
    if (request.headers.get('origin') !== publicOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return refused(403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return refused(415);
    const reader = request.body?.getReader(); let size = 0, bytes = [];
    if (!reader) return refused(400);
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); return refused(413); } bytes.push(value); }
    const form = new URLSearchParams(Buffer.concat(bytes).toString('utf8'));
    if ([...form.keys()].some(k => !['token', 'csrf', 'lang'].includes(k)) || ['token', 'csrf', 'lang'].some(k => form.getAll(k).length !== 1)) return refused(400);
    const token = form.get('token');
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('='));
    const matches = cookies.filter(([name]) => name === cookieName), cookie = matches.length === 1 ? matches[0][1] : '';
    if (!host.confirmation.checkCsrf(cookie, token, form.get('csrf'))) return refused(403);
    const result = host.confirmation.redeem(token);
    return render({ ...result, locale: result.locale ?? (form.get('lang') === 'de' ? 'de' : 'en') }, true);
  } };
}
