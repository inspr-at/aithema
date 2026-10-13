import { createTransport as nodemailerTransport } from 'nodemailer';
import { confirmationMessage } from './templates.js';
export { confirmationHtml, confirmationMessage, mailCopy } from './templates.js';
const clean = value => typeof value === 'string' && value.length <= 254 && !/[\r\n\0]/u.test(value);
const address = value => clean(value) && /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/u.test(value);
const boolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  if (['true', '1'].includes(value)) return true;
  if (['false', '0'].includes(value)) return false;
  throw new TypeError('Invalid SMTP boolean setting');
};
const privateHost = host => ['localhost', '::1', '[::1]'].includes(host) || host.endsWith('.local') ||
  /^[a-z0-9-]+$/iu.test(host) || /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^172\.(1[6-9]|2\d|3[01])\./u.test(host);

/** START v1 env names. Passwords remain references until dispatch; never serialized. */
export function smtpConfig(values = process.env, { production = false } = {}) {
  const mode = values.AITHEMA_MAIL_TRANSPORT;
  if (mode && !['smtp', 'off'].includes(mode)) throw new TypeError('Production mail requires SMTP; mock/console transports are unavailable');
  if (mode === 'off') return null;
  if (!values.SMTP_HOST || !values.SMTP_FROM) return null;
  const host = values.SMTP_HOST, from = values.SMTP_FROM, port = Number(values.SMTP_PORT ?? 587);
  const allowPlaintextLocalRelay = boolean(values.SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY);
  const secure = boolean(values.SMTP_SECURE, port === 465);
  if (!clean(host) || !/^[a-z0-9.:[\]-]+$/iu.test(host) || !address(from) || !Number.isInteger(port) || port < 1 || port > 65535 ||
    values.SMTP_USER && !clean(values.SMTP_USER) || values.SMTP_FROM_NAME && !clean(values.SMTP_FROM_NAME) ||
    values.SMTP_REPLY_TO && !address(values.SMTP_REPLY_TO)) throw new TypeError('Invalid SMTP configuration');
  if (allowPlaintextLocalRelay && (port !== 25 || !privateHost(host) || secure)) throw new TypeError('Plaintext SMTP requires port 25 and a local/private relay');
  if (port === 465 && !secure) throw new TypeError('SMTP port 465 requires implicit TLS');
  return Object.freeze({ host, port, secure, allowPlaintextLocalRelay, from, fromName: values.SMTP_FROM_NAME,
    replyTo: values.SMTP_REPLY_TO, user: values.SMTP_USER, secretRef: values.SMTP_USER ? 'SMTP_PASS' : null, production });
}

/** Implements the existing requestVerification delivery port. Redemption remains host-owned. */
export function createSmtpMail({ config, publicOrigin, resolveSecret = ref => process.env[ref],
  createTransport = nodemailerTransport, getSocket, htmlTemplate } = {}) {
  if (!config) return null;
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError('SMTP requires AITHEMA_PUBLIC_ORIGIN'); }
  if (origin.origin !== publicOrigin || origin.username || origin.password || origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new TypeError('Invalid mail public origin');
  let transport;
  function connection() {
    if (transport) return transport;
    const pass = config.secretRef ? resolveSecret(config.secretRef) : undefined;
    if (config.user && (typeof pass !== 'string' || !pass)) throw new Error('Confirmation delivery failed');
    transport = createTransport({ host: config.host, port: config.port, secure: config.secure,
      requireTLS: !config.allowPlaintextLocalRelay && !config.secure, ignoreTLS: config.allowPlaintextLocalRelay,
      ...(config.user ? { auth: { user: config.user, pass } } : {}), pool: true, maxConnections: 3,
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, ...(getSocket ? { getSocket } : {}) });
    return transport;
  }
  return { id: 'smtp', deliversVerification: true,
    async requestVerification({ address: to, token, locale = 'en', expiresAt }, { signal } = {}) {
      if (!address(to) || typeof token !== 'string' || !token || token.length > 2048) throw new TypeError('Invalid confirmation delivery');
      signal?.throwIfAborted();
      const link = new URL('/confirm-email', origin); link.searchParams.set('token', token); link.searchParams.set('lang', locale === 'de' ? 'de' : 'en');
      const message = confirmationMessage({ locale, link: link.href, expiresAt, htmlTemplate });
      try {
        await connection().sendMail({ from: config.fromName ? { name: config.fromName, address: config.from } : config.from,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}), to, ...message });
        return { status: 'sent' };
      } catch { throw new Error('Confirmation delivery failed'); }
    },
    close() { transport?.close(); transport = undefined; },
  };
}
