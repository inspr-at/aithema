import { randomBytes } from 'node:crypto';
import { privacyDocumentConfigured } from '../packages/server/src/host-handlers.js';
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const confirmationCopy = Object.freeze({
  "de": {
    "ready": {
      "h1": "Fast geschafft",
      "lead": "Noch ein Klick, dann steigt Ihr Guthaben auf {tier} Credits.",
      "leadFallback": "Noch ein Klick, dann ist Ihre E-Mail-Adresse bestätigt.",
      "button": "E-Mail-Adresse bestätigen",
      "busy": "Wird bestätigt …"
    },
    "confirmed": {
      "h1": "E-Mail-Adresse bestätigt",
      "lead": "Ihr Guthaben beträgt jetzt {tier} Credits.",
      "leadFallback": "Ihr höheres Guthaben steht im Gespräch bereit.",
      "button": "Zurück zum Gespräch"
    },
    "usedConfirmed": {
      "h1": "Diese Adresse ist schon bestätigt",
      "lead": "Sie müssen nichts weiter tun.",
      "button": "Zum Gespräch"
    },
    "usedLink": {
      "h1": "Dieser Link wurde schon verwendet",
      "lead": "Jeder Link funktioniert nur einmal. Einen neuen fordern Sie in den Einstellungen unter „E-Mail“ an.",
      "button": "Zum Gespräch"
    },
    "expired": {
      "h1": "Dieser Link ist abgelaufen",
      "lead": "Links gelten 30 Minuten. Öffnen Sie im Gespräch die Einstellungen. Unter „E-Mail“ finden Sie „Link erneut senden“.",
      "button": "Zum Gespräch"
    },
    "invalid": {
      "h1": "Dieser Link funktioniert nicht",
      "lead": "Er ist unvollständig oder wurde durch einen neueren ersetzt. Nehmen Sie den Link aus der neuesten E-Mail oder fordern Sie in den Einstellungen unter „E-Mail“ einen neuen an.",
      "button": "Zum Gespräch"
    },
    "tooMany": {
      "h1": "Zu viele Versuche",
      "lead": "Dieser Link wurde zu oft versucht. In {wait} können Sie in den Einstellungen unter „E-Mail“ einen neuen anfordern.",
      "button": "Zum Gespräch"
    },
    "tooManyNow": {
      "h1": "Zu viele Versuche",
      "lead": "Dieser Link wurde zu oft versucht. Fordern Sie in den Einstellungen unter „E-Mail“ einen neuen an.",
      "button": "Zum Gespräch"
    },
    "privacy": "Datenschutzerklärung"
  },
  "en": {
    "ready": {
      "h1": "Almost there",
      "lead": "One more click and your credit rises to {tier} Credits.",
      "leadFallback": "One more click and your email address is confirmed.",
      "button": "Confirm email address",
      "busy": "Confirming …"
    },
    "confirmed": {
      "h1": "Email address confirmed",
      "lead": "Your credit is now {tier} Credits.",
      "leadFallback": "Your higher credit is ready in the conversation.",
      "button": "Back to the conversation"
    },
    "usedConfirmed": {
      "h1": "This address is already confirmed",
      "lead": "There’s nothing more to do.",
      "button": "Go to the conversation"
    },
    "usedLink": {
      "h1": "This link has already been used",
      "lead": "Each link works only once. Request a new one under “Email” in Settings.",
      "button": "Go to the conversation"
    },
    "expired": {
      "h1": "This link has expired",
      "lead": "Links are valid for 30 minutes. Open Settings in the conversation. Under “Email” you’ll find “Send link again”.",
      "button": "Go to the conversation"
    },
    "invalid": {
      "h1": "This link doesn’t work",
      "lead": "It’s incomplete or was replaced by a newer one. Use the link from the latest email, or request a new one under “Email” in Settings.",
      "button": "Go to the conversation"
    },
    "tooMany": {
      "h1": "Too many attempts",
      "lead": "This link was tried too often. In {wait}, you can request a new one under “Email” in Settings.",
      "button": "Go to the conversation"
    },
    "tooManyNow": {
      "h1": "Too many attempts",
      "lead": "This link was tried too often. Request a new one under “Email” in Settings.",
      "button": "Go to the conversation"
    },
    "privacy": "Privacy policy"
  }
});
const statusFor = state => ({ valid: 200, confirmed: 200, alreadyUsed: 409, expired: 410, invalid: 400, tooManyAttempts: 429 })[state];

// The retry time is host data; round up so the copy never promises an early resend.
export function confirmationWait(retryAt, locale, now = Date.now()) {
  if (!Number.isFinite(retryAt) || retryAt <= now) return null;
  const minutes = Math.ceil((retryAt - now) / 60_000), hours = retryAt - now >= 3_600_000;
  const value = hours ? Math.ceil((retryAt - now) / 3_600_000) : minutes;
  const unit = locale === 'de' ? (hours ? (value === 1 ? 'Stunde' : 'Stunden') : (value === 1 ? 'Minute' : 'Minuten'))
    : (hours ? (value === 1 ? 'hour' : 'hours') : (value === 1 ? 'minute' : 'minutes'));
  return new Intl.NumberFormat(locale).format(value) + ' ' + unit;
}
const icons = {
  ready: '<rect x="3.25" y="5.25" width="17.5" height="13.5" rx="2.5"/><path d="m4 7.25 8 5.75 8-5.75"/>',
  confirmed: '<rect x="3.25" y="5.25" width="17.5" height="13.5" rx="2.5"/><path d="m4 7.25 8 5.75 8-5.75"/>',
  usedConfirmed: '<path d="M5.75 12.5l4.1 4.1 8.4-8.6"/>',
  usedLink: '<path d="M3.5 10.25 12 4.75l8.5 5.5v8a1.75 1.75 0 0 1-1.75 1.75H5.25A1.75 1.75 0 0 1 3.5 18.25Z"/><path d="m3.75 10.5 8.25 5.25 8.25-5.25"/>',
  expired: '<circle cx="12" cy="12" r="8.25"/><path d="M12 7.75V12l2.75 1.75"/>',
  invalid: '<path d="M9.5 14.5 14.5 9.5"/><path d="m11 6.5 1.4-1.4a4.1 4.1 0 0 1 5.8 5.8L16.8 12.3"/><path d="m13 17.5-1.4 1.4a4.1 4.1 0 0 1-5.8-5.8l1.4-1.4"/><path d="M4.5 4.5l15 15"/>',
  tooMany: '<path d="M6 3.75h12M6 20.25h12"/><path d="M7.5 3.75v2.4a4.5 4.5 0 0 0 1.9 3.67L12 11.6l2.6-1.78a4.5 4.5 0 0 0 1.9-3.67v-2.4"/><path d="M7.5 20.25v-2.4a4.5 4.5 0 0 1 1.9-3.67L12 12.4l2.6 1.78a4.5 4.5 0 0 1 1.9 3.67v2.4"/>',
};
icons.tooManyNow = icons.tooMany;
const icon = (key, active) => `<span class="confirm-icon${key === 'confirmed' ? ' confirm-icon--done' + (active ? ' confirm-icon--draw' : '') : ''}" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[key]}</svg></span>`;
const busy = text => `<span class="confirm-busy" aria-hidden="true"><svg class="confirm-spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"/></svg>${escape(text)}</span>`;

/** Designed host page. GET inspects only; the original CSRF/POST contract stays host-owned. */
export function createConfirmationPage({ host, publicOrigin, now = () => Date.now() }) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin) throw new TypeError('Invalid confirmation public origin');
  const secure = origin.protocol === 'https:', cookieName = secure ? '__Host-aithema-confirm-csrf' : 'aithema-confirm-csrf';
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
  const refused = status => new Response(null, { status, headers });
  function render({ state, locale = 'en', token = '', cookie = '', address, tier, addressConfirmed, retryAt }, post = false) {
    locale = locale === 'de' ? 'de' : 'en';
    const c = confirmationCopy[locale], wait = confirmationWait(retryAt, locale, now());
    const key = state === 'valid' ? 'ready' : state === 'alreadyUsed' ? (addressConfirmed ? 'usedConfirmed' : 'usedLink')
      : state === 'tooManyAttempts' ? (wait ? 'tooMany' : 'tooManyNow') : state;
    const csrf = host.confirmation.csrf(cookie, token);
    function view(viewKey, active) {
      const v = c[viewKey], heading = active ? `<h1 class="confirm-title" id="confirm-title">${escape(v.h1)}</h1>` : `<p class="confirm-title">${escape(v.h1)}</p>`;
      let lead = ['ready', 'confirmed'].includes(viewKey) && (tier === undefined || tier === null || tier === '') ? v.leadFallback : v.lead;
      lead = escape(lead).replace('{tier} Credits', () => `<b class="confirm-num">${escape(tier)} Credits</b>`).replace('{wait}', () => escape(wait));
      const label = `<span class="confirm-label">${escape(v.button)}</span>`;
      const action = !active ? `<span class="confirm-button">${label}</span>` : viewKey === 'ready'
        ? `<form class="confirm-form" method="post" action="/confirm-email" data-confirm><input type="hidden" name="token" value="${escape(token)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="lang" value="${locale}"><button type="submit" class="confirm-button">${label}${busy(v.busy)}</button></form>`
        : `<a class="confirm-button" href="/">${label}</a>`;
      const addressLine = address && ['ready', 'confirmed', 'usedConfirmed'].includes(viewKey) ? `<p class="confirm-address">${escape(address)}</p>` : '';
      return `<div class="confirm-view" data-view="${viewKey}"${active ? '' : ' aria-hidden="true" inert'}>${icon(viewKey, active)}${heading}${addressLine}<p class="confirm-lead">${lead}</p><div class="confirm-action">${action}</div></div>`;
    }
    const views = ['valid', 'confirmed'].includes(state) ? view('ready', state === 'valid') + view('confirmed', state === 'confirmed') : view(key, true);
    const title = state === 'valid' ? (locale === 'de' ? 'E-Mail-Adresse bestätigen' : 'Confirm your email address') : c[key].h1;
    const privacy = privacyDocumentConfigured(host) ? `<a class="confirm-privacy" href="/privacy?locale=${locale}">${escape(c.privacy)}</a>` : '';
    // Native form POSTs under no-referrer carry Origin:null. The document's
    // origin-only policy keeps the strict Origin check and never sends the token URL.
    // The C1 response headers remain the default outside this document.
    return new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin"><title>${escape(title)}</title><link rel="stylesheet" href="/demo/host.css"><script src="/demo/theme-init.js"></script><script src="/demo/confirm-email.js" defer></script></head><body class="confirm-page"><header class="confirm-band"><a class="confirm-wordmark" href="/"><span class="confirm-mark" aria-hidden="true"></span>Aithema</a></header><main class="confirm-main"><section class="confirm-card" data-confirmation-state="${escape(state)}" aria-labelledby="confirm-title"><div class="confirm-stack">${views}</div><p class="visually-hidden" role="status" aria-live="polite" data-confirm-status></p></section>${privacy}</main></body></html>`,
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
