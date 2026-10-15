import { readAdminSettings, readAdminMailCap, readProviderCap } from './admin-read.js';
import { renderAdmin, adminModel, esc } from './admin-view.js';
import { adminCopy } from './admin-copy.js';

const headers = { 'cache-control': 'no-store', vary: 'Cookie', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const json = (value, status = 200) => Response.json(value, { status, headers });
const actorFor = session => {
  const name = session.name.replace(/[#\x00-\x1f\x7f-\x9f]/gu, '').trim().slice(0, 120) || 'Operator';
  return `operator:${name}#${session.subject}`;
};
async function input(request) {
  let size = 0; const chunks = [], reader = request.body?.getReader();
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw Object.assign(new Error('body-too-large'), { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid settings');
  // Identity is entirely session-owned, including when a client supplies a subject.
  const { subject: ignored, ...settings } = value;
  return settings;
}

export function createAdminHTTP({ host, spendCap, operatorSessions, publicOrigin }) {
  const state = operator => ({ settings: readAdminSettings(host), deliveryEnabled: host.identity.deliversVerification === true,
    operator: { name: operator.name }, mailUsage: readAdminMailCap(host),
    busiestConnection: host.confirmation.busiestConnection(), providerCap: readProviderCap(spendCap, { details: true }) });
  const page = (model, locale, status = 200) => new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin"><title>${locale === 'en' ? 'Admin' : 'Verwaltung'} · Aithema</title><link rel="stylesheet" href="/demo/host.css"><script src="/demo/theme-init.js"></script><script type="module" src="/demo/admin-page.js"></script></head><body class="admin-page">${renderAdmin(model, locale)}</body></html>`,
    { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  return { async handle(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path !== '/admin' && !/^\/api\/operator\/admin(?:\/|$)/u.test(path)) return null;
    if (!operatorSessions) return json({ error: 'not-found' }, 404);
    const operator = operatorSessions.session(request), locale = url.searchParams.get('lang') === 'en' ? 'en' : 'de';
    try {
      if (!operator) {
        if (path === '/admin' && request.method === 'GET') return page({ signed: /(?:^|;)\s*aithema-operator=/u.test(request.headers.get('cookie') ?? '') ? 'expired' : 'out' }, locale, 401);
        return json({ error: 'operator-session' }, 401);
      }
      const method = path === '/api/operator/admin/settings' ? 'POST' : 'GET';
      if (request.method !== method) { const r = json({ error: 'method-not-allowed' }, 405); r.headers.set('allow', method); return r; }
      if (path === '/admin') return page(adminModel(state(operator), host.visitorCredits.adminAudit()), locale);
      if (path === '/api/operator/admin/state') return json(state(operator));
      if (path === '/api/operator/admin/audit') {
        if ([...url.searchParams.keys()].some(k => k !== 'before') || url.searchParams.getAll('before').length > 1 ||
          url.searchParams.has('before') && !/^[1-9]\d*$/u.test(url.searchParams.get('before'))) throw new TypeError('Invalid audit cursor');
        return json(host.visitorCredits.adminAudit(url.searchParams.has('before') ? { before: Number(url.searchParams.get('before')) } : {}));
      }
      if (path === '/api/operator/admin/settings') {
        if (request.headers.get('origin') !== publicOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'cross-origin' }, 403);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'content-type' }, 415);
        return json(host.visitorCredits.saveSettings(await input(request), { source: 'operator', actor: actorFor(operator) }));
      }
      return json({ error: 'not-found' }, 404);
    } catch (error) {
      if (path === '/admin') return new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${locale === 'en' ? 'Admin' : 'Verwaltung'} · Aithema</title></head><body><p>${esc(adminCopy[locale].failed)}</p></body></html>`,
        { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
      if (error.status === 409) return json({ error: 'stale-credit-settings', current: error.current }, 409);
      if (error.status === 413) return json({ error: 'body-too-large' }, 413);
      if (error instanceof TypeError || error instanceof SyntaxError) return json({ error: 'invalid-admin-command' }, 400);
      return json({ error: 'host-settings-unavailable' }, 503);
    }
  } };
}
