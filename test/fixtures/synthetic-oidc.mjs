/**
 * Local synthetic OpenID Provider for protocol tests. Not a production IdP
 * and not a mock of the client library.
 */
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';

export async function startSyntheticOidcIssuer(options = {}) {
  const clientId = options.clientId ?? 'aithema-workspace';
  const clientSecret = options.clientSecret === undefined ? 'synthetic-client-secret' : options.clientSecret;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'synthetic-rsa';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const behavior = {
    subject: options.subject ?? 'user-alice',
    failDiscovery: false,
    failAuthorize: false,
    failToken: false,
    skipPkce: false,
    alg: 'RS256',
    iss: undefined,
    aud: undefined,
    azp: undefined,
    extraAud: undefined,
    omitNonce: false,
    expOffsetSeconds: 120,
    claims: {},
    endSession: true,
  };

  /** @type {Map<string, object>} */
  const codes = new Map();

  const server = createServer((req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const issuer = `http://127.0.0.1:${port}`;

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      if (behavior.failDiscovery) {
        json(res, 503, { error: 'temporarily_unavailable' });
        return;
      }
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: behavior.endSession ? `${issuer}/end-session` : undefined,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: clientSecret ? ['client_secret_post', 'client_secret_basic'] : ['none'],
        scopes_supported: ['openid'],
        subject_types_supported: ['public'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      json(res, 200, { keys: [jwk] });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/authorize') {
      if (behavior.failAuthorize) {
        const redirectUri = url.searchParams.get('redirect_uri');
        if (!redirectUri) {
          res.writeHead(400).end();
          return;
        }
        const denied = new URL(redirectUri);
        denied.searchParams.set('error', 'access_denied');
        denied.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: denied.href }).end();
        return;
      }
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const nonce = url.searchParams.get('nonce');
      const challenge = url.searchParams.get('code_challenge');
      const method = url.searchParams.get('code_challenge_method');
      const responseType = url.searchParams.get('response_type');
      const requestClient = url.searchParams.get('client_id');
      if (!redirectUri || !state || responseType !== 'code' || requestClient !== clientId) {
        res.writeHead(400).end('invalid_request');
        return;
      }
      if (method !== 'S256' || !challenge || !nonce) {
        res.writeHead(400).end('invalid_request');
        return;
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        nonce,
        state,
        redirectUri,
        codeChallenge: challenge,
        clientId: requestClient,
        subject: behavior.subject,
      });
      const next = new URL(redirectUri);
      next.searchParams.set('code', code);
      next.searchParams.set('state', state);
      res.writeHead(302, { location: next.href }).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      readBody(req).then((raw) => {
        if (behavior.failToken) {
          json(res, 503, { error: 'temporarily_unavailable' });
          return;
        }
        const body = new URLSearchParams(raw);
        const auth = parseBasic(req.headers.authorization);
        const postedClient = body.get('client_id') ?? auth.clientId;
        const postedSecret = body.get('client_secret') ?? auth.clientSecret;
        if (postedClient !== clientId) {
          json(res, 401, { error: 'invalid_client' });
          return;
        }
        if (clientSecret && postedSecret !== clientSecret) {
          json(res, 401, { error: 'invalid_client' });
          return;
        }
        if (body.get('grant_type') !== 'authorization_code') {
          json(res, 400, { error: 'unsupported_grant_type' });
          return;
        }
        const code = body.get('code');
        const record = code ? codes.get(code) : null;
        if (!record) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(code);
        if (body.get('redirect_uri') !== record.redirectUri) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        if (!behavior.skipPkce) {
          const verifier = body.get('code_verifier') ?? '';
          const expected = createHash('sha256').update(verifier).digest('base64url');
          const left = Buffer.from(expected);
          const right = Buffer.from(record.codeChallenge);
          if (left.length !== right.length || !timingSafeEqual(left, right)) {
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
        }
        const now = Math.floor(Date.now() / 1000);
        const audience = behavior.aud ?? clientId;
        const payload = {
          iss: behavior.iss ?? issuer,
          aud: behavior.extraAud ? [audience, behavior.extraAud] : audience,
          sub: record.subject,
          exp: now + behavior.expOffsetSeconds,
          iat: now,
          auth_time: now,
          ...behavior.claims,
        };
        if (behavior.azp !== undefined) payload.azp = behavior.azp;
        if (!behavior.omitNonce) payload.nonce = record.nonce;
        const access = randomBytes(16).toString('hex');
        json(res, 200, {
          token_type: 'Bearer',
          expires_in: 60,
          access_token: access,
          id_token: signIdToken(pair.privateKey, payload, behavior.alg),
        });
      }).catch(() => {
        json(res, 400, { error: 'invalid_request' });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/end-session') {
      const post = url.searchParams.get('post_logout_redirect_uri') || '/';
      res.writeHead(302, { location: post }).end();
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    jwks: { keys: [jwk] },
    behavior,
    get subject() {
      return behavior.subject;
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    signGatewayJwt(subject, audience = 'aithema') {
      const now = Math.floor(Date.now() / 1000);
      return signIdToken(pair.privateKey, {
        iss: issuer,
        aud: audience,
        sub: subject,
        exp: now + 120,
        iat: now,
      }, 'RS256');
    },
  };
}

function signIdToken(privateKey, payload, alg) {
  if (alg === 'none') {
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${head}.${body}.`;
  }
  const header = { alg: 'RS256', kid: 'synthetic-rsa', typ: 'JWT' };
  const head = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBasic(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return {};
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return {};
    return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
  } catch {
    return {};
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
