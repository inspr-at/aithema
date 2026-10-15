import { createTransport as nodemailerTransport } from 'nodemailer';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { formatCredits } from '@inspr/aithema-ui/display';
import { confirmationMessage, mergeMailCopy } from './templates.js';
export { confirmationHtml, confirmationMessage, mailCopy } from './templates.js';
const clean = value => typeof value === 'string' && value.length <= 254 && !/[\r\n\0]/u.test(value);
const address = value => clean(value) && /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/u.test(value);
const boolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  if (['true', '1'].includes(value)) return true;
  if (['false', '0'].includes(value)) return false;
  throw new TypeError('Invalid SMTP boolean setting');
};
const privateAddresses = new BlockList();
for (const [network, prefix, family] of [['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']]) privateAddresses.addSubnet(network, prefix, family);
privateAddresses.addAddress('::1', 'ipv6');
const privateIP = value => {
  const family = isIP(value);
  return family !== 0 && privateAddresses.check(value, family === 6 ? 'ipv6' : 'ipv4');
};

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
  if (allowPlaintextLocalRelay && (port !== 25 || secure)) throw new TypeError('Plaintext SMTP requires port 25 and a local/private relay');
  if (port === 465 && !secure) throw new TypeError('SMTP port 465 requires implicit TLS');
  return Object.freeze({ host, port, secure, allowPlaintextLocalRelay, from, fromName: values.SMTP_FROM_NAME,
    replyTo: values.SMTP_REPLY_TO, user: values.SMTP_USER, secretRef: values.SMTP_USER ? 'SMTP_PASS' : null, production });
}

/** Implements the existing requestVerification delivery port. Redemption remains host-owned. */
export function createSmtpMail({ config, publicOrigin, resolveSecret = ref => process.env[ref],
  createTransport = nodemailerTransport, lookup = dnsLookup, getSocket, htmlTemplate, copy, privacyUrl } = {}) {
  if (!config) return null;
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError('SMTP requires AITHEMA_PUBLIC_ORIGIN'); }
  if (origin.origin !== publicOrigin || origin.username || origin.password || origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new TypeError('Invalid mail public origin');
  const copies = mergeMailCopy(copy);
  const privacyUrls = Object.fromEntries(Object.keys(copies).map(locale => {
    if (privacyUrl === undefined) return [locale, new URL('/privacy?locale=' + locale, origin).href];
    let value, url;
    try {
      value = typeof privacyUrl === 'function' ? privacyUrl(locale) : privacyUrl;
      if (typeof value === 'string') url = new URL(value);
    } catch { /* Report the option and locale without retaining host values. */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw new TypeError('Invalid SMTP privacyUrl for ' + locale + ': expected an absolute http(s) URL string');
    }
    return [locale, value];
  }));
  let transport, connecting;
  async function connection() {
    if (connecting) return connecting;
    connecting = connect().catch(error => { connecting = undefined; throw error; });
    return connecting;
  }
  async function connect() {
    let host = config.host.replace(/^\[|\]$/gu, '');
    if (config.allowPlaintextLocalRelay) {
      const addresses = await lookup(host, { all: true, verbatim: true });
      if (!addresses.length || !addresses.every(row => privateIP(row.address))) throw new Error('Untrusted plaintext relay');
      // Nodemailer receives a literal IP, so reconnects/pooling cannot repeat
      // DNS resolution and move a checked hostname to a public destination.
      host = addresses[0].address;
    }
    const pass = config.secretRef ? resolveSecret(config.secretRef) : undefined;
    if (config.user && (typeof pass !== 'string' || !pass)) throw new Error('Confirmation delivery failed');
    transport = createTransport({ host, port: config.port, secure: config.secure,
      requireTLS: !config.allowPlaintextLocalRelay && !config.secure, ignoreTLS: config.allowPlaintextLocalRelay,
      tls: { rejectUnauthorized: true, ...(!isIP(host) ? { servername: host } : {}) },
      ...(config.user ? { auth: { user: config.user, pass } } : {}), pool: true, maxConnections: 3, maxRequeues: 0,
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, ...(getSocket ? { getSocket } : {}) });
    return transport;
  }
  return { id: 'smtp', deliversVerification: true,
    async requestVerification({ address: to, token, locale = 'en', expiresAt, confirmedAllowanceMicro, privacyDocumentConfigured = false }, { signal } = {}) {
      if (!address(to) || typeof token !== 'string' || !token || token.length > 2048) throw new TypeError('Invalid confirmation delivery');
      signal?.throwIfAborted();
      const link = new URL('/confirm-email', origin); link.searchParams.set('token', token); link.searchParams.set('lang', locale === 'de' ? 'de' : 'en');
      locale = locale === 'de' ? 'de' : 'en';
      const tierAfter = Number.isSafeInteger(confirmedAllowanceMicro) && confirmedAllowanceMicro >= 0
        ? formatCredits(confirmedAllowanceMicro, locale) : undefined;
      const message = confirmationMessage({ locale, link: link.href, expiresAt, host: origin.host,
        privacyUrl: privacyUrl !== undefined || privacyDocumentConfigured ? privacyUrls[locale] : undefined,
        tierAfter, copy: copies[locale], htmlTemplate });
      try {
        await (await connection()).sendMail({ from: config.fromName ? { name: config.fromName, address: config.from } : config.from,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}), to, ...message });
        return { status: 'sent' };
      } catch (error) {
        const temporary = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode < 500 ||
          error?.rejectedErrors?.some(rejected => Number.isInteger(rejected.responseCode) && rejected.responseCode >= 400 && rejected.responseCode < 500) === true;
        if (temporary) console.warn(JSON.stringify({ event: 'mail-delivery-failed', temporary: true }));
        // Never retain the SMTP reply, recipient, envelope or original cause.
        // The host maps this to its existing private failed-delivery state.
        throw Object.assign(new Error('Confirmation delivery failed'), temporary ? { temporary: true } : {});
      }
    },
    close() { transport?.close(); transport = undefined; connecting = undefined; },
  };
}
