// Ported from START v1 src/lib/operator-oidc.ts (AGPL-3.0-only).
// Public registration: authorization code + PKCE, never a client secret.
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const value = raw => typeof raw === 'string' ? raw.trim() : '';
function origin(raw, issuer = false) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      u.origin !== raw || u.protocol !== 'https:' && !(u.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new TypeError(`Invalid operator ${issuer ? 'issuer' : 'origin'}`);
  return u.origin;
}
export function zitadelOperatorConfig(values = process.env) {
  const issuer = value(values.AITHEMA_OPERATOR_ISSUER), clientId = value(values.AITHEMA_OPERATOR_CLIENT_ID);
  const subjects = value(values.AITHEMA_OPERATOR_SUBJECT).split(',').map(value).filter(Boolean);
  const publicOrigin = value(values.AITHEMA_PUBLIC_ORIGIN);
  if (!issuer || !clientId || !subjects.length || !publicOrigin) return null;
  if (clientId.length > 256 || subjects.some(s => s.length > 256)) throw new TypeError('Invalid operator allowlist or client');
  return { issuer: origin(issuer, true), clientId, subjects: [...new Set(subjects)], publicOrigin: origin(publicOrigin),
    redirectUri: new URL('/api/operator/callback/', publicOrigin).href };
}
export function createZitadelOIDC({ config, now = Date.now } = {}) {
  if (!config) return null;
  const { issuer, clientId, redirectUri, subjects } = config;
  // Revalidate explicit host configuration, including the exact callback URI.
  const normalized = zitadelOperatorConfig({ AITHEMA_OPERATOR_ISSUER: issuer, AITHEMA_OPERATOR_CLIENT_ID: clientId,
    AITHEMA_OPERATOR_SUBJECT: subjects?.join(','), AITHEMA_PUBLIC_ORIGIN: config.publicOrigin });
  if (!normalized || normalized.redirectUri !== redirectUri) throw new TypeError('Invalid operator callback');
  const allowed = new Set(subjects);
  const keys = createRemoteJWKSet(new URL('/oauth/v2/keys', issuer), {
    cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000,
  });
  return {
    label: 'Zitadel',
    sessionNamespace: createHash('sha256').update(JSON.stringify([issuer, clientId, [...allowed].sort()])).digest('hex'),
    allows: subject => allowed.has(subject),
    begin() {
      const random = bytes => randomBytes(bytes).toString('base64url');
      const pending = { state: random(32), nonce: random(32), verifier: random(48) };
      const url = new URL('/oauth/v2/authorize', issuer);
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid profile email', state: pending.state, nonce: pending.nonce,
        code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return { pending, url: url.href };
    },
    async complete(code, pending, signal) {
      const response = await fetch(new URL('/oauth/v2/token', issuer), { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          redirect_uri: redirectUri, code, code_verifier: pending.verifier }),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('operator-exchange-failed'); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if ((size += value.length) > 65_536) throw new Error('operator-response-limit');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const token = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof token.id_token !== 'string' || token.id_token.length > 16_384) throw new Error('operator-id-token-missing');
      const { payload } = await jwtVerify(token.id_token, keys, { issuer, audience: clientId, algorithms: ['RS256'],
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'], maxTokenAge: 600, currentDate: new Date(now()) });
      if (typeof payload.sub !== 'string' || !allowed.has(payload.sub) || payload.nonce !== pending.nonce ||
          payload.azp !== undefined && payload.azp !== clientId ||
          Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error('operator-not-authorized');
      const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : 'Operator';
      return { subject: payload.sub, name: name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 100) };
    },
  };
}
