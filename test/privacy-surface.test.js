import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { createWorkspaceServer, resolveFlowStaticAsset } from '../workspace/index.js';

const demoConfig = {
  mode: 'demo',
  listenHost: '127.0.0.1',
  listenPort: 0,
  defaultProvider: 'mock',
  identity: {
    kind: 'demo',
    demoHmacSecret: 'privacy-test-demo-secret',
    defaultSubject: 'demo-reviewer',
    memberships: [{
      subject: 'demo-reviewer',
      party_ref: 'party:demo-reviewer',
      actor_kind: 'human',
      roles: ['requirements_approver'],
      projects: [],
    }],
  },
  providers: { mock: { kind: 'mock' } },
};

const productionConfig = {
  mode: 'production',
  listenHost: '127.0.0.1',
  listenPort: 0,
  dataDir: ':memory:',
  defaultProvider: 'local',
  defaultModel: 'fixture-model',
  identity: {
    kind: 'jwt-jwks',
    issuer: 'https://auth.test',
    audience: 'aithema',
    jwks_uri: 'http://127.0.0.1:1/jwks',
    jwks: { keys: [] },
    memberships: [{
      subject: 'production-reviewer',
      party_ref: 'party:production-reviewer',
      actor_kind: 'human',
      roles: ['requirements_approver'],
      projects: [],
    }],
  },
  providers: {
    local: {
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture-model',
      allowedModels: ['fixture-model'],
    },
  },
};

const flowAssetNames = [
  'inspr-flow-shell.js',
  'adapter.js',
  'forecast.js',
  'gates.js',
  'host-layout.js',
  'identity.js',
  'intents.js',
  'sanitize.js',
  'stages.js',
  'state.js',
  'flow-shell.css',
  'assets/inspr-logo.svg',
];
const hostAssetPaths = [
  '/workspace-flow-host.js',
  '/workspace-speech-input.js',
  '/workspace-preview-feedback.js',
  '/preview-adapter.js',
];

const forbiddenHost = /(?:googletagmanager|google-analytics|gstatic|fonts\.googleapis|youtube|doubleclick|facebook|hotjar|(?:^|[./])cdn\.)/i;
const resourceTag = /<([a-z][\w:-]*)\b[^>]*>/gi;
const resourceAttribute = /\b(src|srcset|poster|data-src|logo-src|data|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const cssResource = /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi;
const cssImport = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi;
const staticImport = /\bimport\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const absoluteUrl = /\bhttps?:\/\/[^\s"'`<>]+/gi;
const inlineScript = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const inlineStyle = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

const resourceAttributesByTag = new Map([
  ['link', new Set(['href'])],
  ['script', new Set(['src'])],
  ['img', new Set(['src', 'srcset'])],
  ['iframe', new Set(['src'])],
  ['embed', new Set(['src'])],
  ['object', new Set(['data'])],
  ['source', new Set(['src', 'srcset'])],
  ['video', new Set(['src', 'poster'])],
  ['audio', new Set(['src'])],
  ['inspr-flow-shell', new Set(['logo-src'])],
]);

function resourceValues(text, kind = 'html') {
  const values = [];
  for (const tagMatch of text.matchAll(resourceTag)) {
    const tagName = tagMatch[1].toLowerCase();
    const allowed = resourceAttributesByTag.get(tagName);
    if (!allowed) continue;
    for (const match of tagMatch[0].matchAll(resourceAttribute)) {
      if (!allowed.has(match[1].toLowerCase())) continue;
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      values.push(...value.split(',').map((item) => item.trim().split(/\s+/, 1)[0]));
    }
  }
  const cssTexts = kind === 'css' ? [text] : kind === 'html'
    ? [...text.matchAll(inlineStyle)].map((match) => match[1]) : [];
  for (const cssText of cssTexts) {
    for (const match of cssText.matchAll(cssResource)) values.push(match[1].trim());
    for (const match of cssText.matchAll(cssImport)) values.push(match[1].trim());
    for (const match of cssText.matchAll(absoluteUrl)) values.push(match[0]);
  }
  const jsTexts = kind === 'js' ? [text] : kind === 'html'
    ? [...text.matchAll(inlineScript)].map((match) => match[1]) : [];
  for (const jsText of jsTexts) {
    for (const match of jsText.matchAll(staticImport)) values.push(match[1]);
    for (const match of jsText.matchAll(dynamicImport)) values.push(match[1]);
    for (const match of jsText.matchAll(absoluteUrl)) values.push(match[0]);
  }
  return values;
}

function assertNoForbiddenResourceHosts(text, label, kind = 'html') {
  for (const value of resourceValues(text, kind)) {
    let host = value;
    try {
      host = new URL(value, 'https://aithema.invalid').hostname;
    } catch {
      // Malformed resource URLs are still reported by their raw value below.
    }
    assert.doesNotMatch(`${host} ${value}`, forbiddenHost, `${label}: ${value}`);
  }
}

async function servedShell(config) {
  const workspace = createWorkspaceServer(config);
  const { url } = await workspace.listen();
  try {
    const response = await fetch(url, config.requestHeaders ? { headers: config.requestHeaders } : undefined);
    return {
      status: response.status,
      html: await response.text(),
      url,
      csp: response.headers.get('content-security-policy') ?? '',
    };
  } finally {
    await workspace.close();
  }
}

function createProductionFixture() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'privacy-fixture';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.test',
    aud: 'aithema',
    sub: 'production-reviewer',
    exp: now + 120,
    iat: now,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), pair.privateKey).toString('base64url');
  return {
    jwks: { keys: [jwk] },
    requestHeaders: { authorization: `Bearer ${head}.${payload}.${signature}` },
  };
}

function assertDefaultCsp(csp, label) {
  const directives = new Map();
  for (const clause of csp.split(';').map((part) => part.trim()).filter(Boolean)) {
    const [name, ...tokens] = clause.split(/\s+/);
    assert.equal(directives.has(name), false, `${label} CSP has no duplicate ${name}`);
    directives.set(name, tokens);
  }
  const expected = {
    'default-src': ['\'none\''],
    'script-src': ['\'self\''],
    'style-src': ['\'self\'', '\'unsafe-inline\''],
    'img-src': ['\'self\''],
    'connect-src': ['\'self\''],
    'form-action': ['\'self\''],
    'base-uri': ['\'self\''],
    'frame-ancestors': ['\'self\''],
  };
  const normalize = (tokens) => [...new Set(tokens)].sort();
  for (const [name, tokens] of Object.entries(expected)) {
    assert.ok(directives.has(name), `${label} CSP includes ${name}`);
    assert.deepEqual(normalize(directives.get(name)), normalize(tokens), `${label} CSP ${name}`);
  }
  const allowedDirectiveNames = new Set([...Object.keys(expected), 'frame-src']);
  for (const name of directives.keys()) {
    assert.ok(allowedDirectiveNames.has(name), `${label} CSP directive is allowlisted: ${name}`);
  }
  if (directives.has('frame-src')) {
    assert.deepEqual(normalize(directives.get('frame-src')), ['\'none\''], `${label} CSP frame-src`);
  }
  for (const tokens of directives.values()) {
    assertNoForbiddenResourceHosts(tokens.join(' '), `${label} CSP source list`, 'js');
  }
}

describe('Tier-0 web resource surface', () => {
  it('checks the real default demo and production shells plus pinned local Flow assets', async () => {
    const productionFixture = createProductionFixture();
    const authenticatedProduction = {
      ...productionConfig,
      identity: { ...productionConfig.identity, jwks: productionFixture.jwks },
      requestHeaders: productionFixture.requestHeaders,
    };
    for (const [name, config, status] of [
      ['demo', demoConfig, 200],
      ['production', authenticatedProduction, 200],
    ]) {
      const served = await servedShell(config);
      assert.equal(served.status, status, `${name} shell status`);
      assert.match(served.html, /<!DOCTYPE html>/i, `${name} shell is HTML`);
      assertDefaultCsp(served.csp, name);
      assertNoForbiddenResourceHosts(served.html, `${name} shell`);
    }

    const workspace = createWorkspaceServer(demoConfig);
    const { url } = await workspace.listen();
    try {
      for (const assetName of flowAssetNames) {
        const asset = resolveFlowStaticAsset(`/flow-shell/${assetName}`);
        assert.ok(asset, `pinned Flow asset is allowlisted: ${assetName}`);
        const response = await fetch(`${url}/flow-shell/${assetName}`);
        assert.equal(response.status, 200, `served Flow asset: ${assetName}`);
        const kind = assetName.endsWith('.css') ? 'css' : assetName.endsWith('.js') ? 'js' : 'asset';
        assertNoForbiddenResourceHosts(await response.text(), `Flow asset ${assetName}`, kind);
      }
      for (const assetPath of hostAssetPaths) {
        const response = await fetch(`${url}${assetPath}`);
        assert.equal(response.status, 200, `served host asset: ${assetPath}`);
        assertNoForbiddenResourceHosts(await response.text(), `host asset ${assetPath}`, 'js');
      }
    } finally {
      await workspace.close();
    }
  });

  it('rejects a tracker resource while allowing a link-only host', () => {
    const baselineCsp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
    assertDefaultCsp(baselineCsp, 'baseline CSP fixture');
    assert.throws(
      () => assertDefaultCsp(baselineCsp.replace("script-src 'self'", "script-src 'self' https://tracker.invalid"), 'script CSP fixture'),
      /script-src/,
    );
    assert.throws(
      () => assertDefaultCsp(baselineCsp.replace("connect-src 'self'", "connect-src 'self' https://tracker.invalid"), 'connect CSP fixture'),
      /connect-src/,
    );
    assert.throws(
      () => assertDefaultCsp(`${baselineCsp}; font-src https://fonts.bunny.net`, 'unknown CSP directive fixture'),
      /font-src/,
    );
    assert.throws(
      () => assertNoForbiddenResourceHosts(
        '<script src="https://www.googletagmanager.com/gtm.js"></script>',
        'tracker fixture',
      ),
      /googletagmanager/,
    );
    assert.throws(
      () => assertNoForbiddenResourceHosts(
        '<img src=https://fonts.googleapis.com/css2?family=Inter>',
        'unquoted tracker fixture',
      ),
      /fonts\.googleapis/,
    );
    assert.throws(
      () => assertNoForbiddenResourceHosts(
        '<style>@import url("https://cdn.example.invalid/tracker.css");</style>',
        'CSS import fixture',
      ),
      /cdn\.example\.invalid/,
    );
    assert.throws(
      () => assertNoForbiddenResourceHosts(
        '<script>import("https://hotjar.com/track.js")</script>',
        'JavaScript import fixture',
      ),
      /hotjar/,
    );
    assert.throws(
      () => assertNoForbiddenResourceHosts(
        '<script>import tracker from "https://www.google-analytics.com/analytics.js";</script>',
        'JavaScript static import fixture',
      ),
      /google-analytics/,
    );
    assert.doesNotThrow(() => assertNoForbiddenResourceHosts(
      '<a href="https://www.youtube.com/watch?v=demo">Documentation</a>',
      'link fixture',
    ));
  });
});
