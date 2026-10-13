// Local-only Zitadel-shaped issuer. Never contacts an external identity provider.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { listen } from '../../packages/server/src/http.js';

export async function stubOperatorIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const codes = new Map(), exchanges = [];
  let issuer, keysRead = 0, counter = 0;
  const authorize = (url, claims = {}, header = {}) => {
    const u = new URL(url), code = `code-${++counter}`;
    codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'),
      clientId: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri'), claims, header });
    return new URL(`${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`);
  };
  const running = await listen(async request => {
    const u = new URL(request.url);
    if (u.pathname === '/oauth/v2/authorize') return new Response(null, { status: 303, headers: { location: authorize(u.href).href } });
    if (u.pathname === '/oauth/v2/keys') { keysRead++; return Response.json({ keys: [key] }); }
    if (u.pathname !== '/oauth/v2/token') return new Response(null, { status: 404 });
    const body = new URLSearchParams(await request.text()); exchanges.push(Object.fromEntries(body));
    const pending = codes.get(body.get('code')); codes.delete(body.get('code'));
    if (!pending) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('client_id'), pending.clientId);
    assert.equal(body.get('redirect_uri'), pending.redirect); assert.equal(body.has('client_secret'), false);
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), pending.challenge);
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = { iss: issuer, aud: pending.clientId, sub: 'allowed-operator', name: 'Ada',
      exp: now + 600, iat: now, nonce: pending.nonce, ...pending.claims };
    const input = `${encode({ alg: 'RS256', kid: key.kid, ...pending.header })}.${encode(payload)}`;
    return Response.json({ id_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}` });
  });
  issuer = running.url;
  return { issuer, authorize, exchanges, keysRead: () => keysRead,
    async close() { running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); } };
}
