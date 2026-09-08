import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  approveBaselineFromProposals,
  contentDigest,
  createStream,
  exportReviewedHandover,
  proposeRequirement,
} from '../lib/index.js';
import { MAX_FILE_BYTES } from '../lib/extract-limits.js';
import { MOCK_REPLY_MARK } from '../runtime/provider.js';
import { createWorkspaceServer } from '../workspace/index.js';
import { normalizeWorkspaceConfig } from '../workspace/config.js';

const demoConfig = {
  mode: 'test',
  listenHost: '127.0.0.1',
  listenPort: 0,
  defaultProvider: 'mock',
  identity: {
    kind: 'demo',
    demoHmacSecret: 'demo-hmac-secret-not-for-production',
    defaultSubject: 'demo-reviewer',
    memberships: [
      {
        subject: 'demo-reviewer',
        party_ref: 'party:demo-reviewer',
        actor_kind: 'human',
        roles: ['requirements_approver', 'delivery_party'],
        projects: [],
      },
      {
        subject: 'demo-agent',
        party_ref: 'party:demo-agent',
        actor_kind: 'agent',
        roles: ['delivery_party'],
        projects: [],
      },
      {
        subject: 'demo-outsider',
        party_ref: 'party:demo-outsider',
        actor_kind: 'human',
        roles: ['delivery_party'],
        projects: [],
      },
    ],
  },
  providers: { mock: { kind: 'mock' } },
};

async function start(config = demoConfig) {
  const workspace = createWorkspaceServer(config);
  const { url } = await workspace.listen();
  return { workspace, url };
}

function cookieFrom(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  const line = header.find((item) => item.startsWith('aithema_demo='));
  return line ? line.split(';')[0] : '';
}

async function demoSession(url, subject) {
  const response = await fetch(`${url}/session/demo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({ subject }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function createProject(url, cookie, title = 'Workspace project') {
  const response = await fetch(`${url}/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({
      title,
      project_kinds: 'new_product',
    }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return response.headers.get('location');
}

async function approveBaseline(url, cookie, projectUrl) {
  await fetch(`${projectUrl}/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({ message: 'Need a reviewed baseline before document intake' }),
    redirect: 'manual',
  });
  const page = await (await fetch(projectUrl, { headers: { cookie } })).text();
  const refs = [...page.matchAll(/name="proposal_refs" value="([^"]+)"/g)].map((match) => match[1]);
  const expected = page.match(/name="expected_revision" value="(\d+)"/)[1];
  await fetch(`${projectUrl}/review`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams([
      ['action', 'approve'],
      ['expected_revision', expected],
      ...refs.map((ref) => ['proposal_refs', ref]),
    ]),
    redirect: 'manual',
  });
  return (await fetch(projectUrl, { headers: { cookie } })).text();
}

function ownFormatHandoverBytes(mutate) {
  const encoder = new TextEncoder();
  let source = createStream('stream:foreign', ['iteration']);
  source = proposeRequirement(source, {
    party_ref: 'party:demo-reviewer',
    actor_kind: 'human',
    roles: ['requirements_approver', 'delivery_party'],
    subject: 'demo-reviewer',
    projects: [],
  }, {
    requirement_ref: 'req.foreign',
    statement: 'Foreign baseline statement',
    acceptance_criteria: ['Foreign check'],
    constraint_refs: [],
  });
  source = approveBaselineFromProposals(
    source,
    {
      party_ref: 'party:demo-reviewer',
      actor_kind: 'human',
      roles: ['requirements_approver', 'delivery_party'],
      subject: 'demo-reviewer',
      projects: [],
    },
    source.proposals.map((proposal) => proposal.proposal_ref),
    'baseline:foreign-v1',
    '2026-09-01T00:00:00.000Z',
  );
  const handover = exportReviewedHandover(source, {
    baseline_ref: 'baseline:foreign-v1',
    revision: 1,
  }, '2026-09-07T16:00:00.000Z');
  const next = mutate(handover);
  next.baseline.content_digest = contentDigest(
    next.baseline.requirements,
    next.baseline.constraints,
  );
  return encoder.encode(JSON.stringify(next));
}

function duplicateRequirementRefHandoverBytes(requirementRef) {
  return ownFormatHandoverBytes((handover) => ({
    ...handover,
    baseline: {
      ...handover.baseline,
      requirements: [
        ...handover.baseline.requirements,
        {
          requirement_ref: requirementRef,
          statement: 'Duplicate requirement A',
          acceptance_criteria: ['A'],
          constraint_refs: [],
        },
        {
          requirement_ref: requirementRef,
          statement: 'Duplicate requirement B',
          acceptance_criteria: ['B'],
          constraint_refs: [],
        },
      ],
    },
  }));
}

async function uploadDocuments(projectUrl, cookie, origin, form, accept = 'text/html,*/*') {
  return fetch(`${projectUrl}/documents`, {
    method: 'POST',
    headers: { cookie, origin, accept },
    body: form,
    redirect: 'manual',
  });
}

async function followHtmlNotice(url, cookie, response) {
  assert.equal(response.status, 303);
  const location = response.headers.get('location') ?? '';
  assert.match(location, /notice=/);
  assert.doesNotMatch(decodeURIComponent(location), /Document intake recorded\./);
  return (await fetch(new URL(location, url), { headers: { cookie } })).text();
}

describe('workspace UI and HTTP boundaries', () => {
  it('labels demo mode, escapes untrusted text, and keeps AI from approving', async () => {
    const { workspace, url } = await start();
    try {
      const home = await fetch(url);
      const homeHtml = await home.text();
      assert.match(homeHtml, /Demo \/ mock/i);
      assert.match(homeHtml, /not live AI/i);
      assert.match(homeHtml, /Continue with labelled demo identity/);

      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const signed = await fetch(projectUrl, { headers: { cookie } });
      const signedHtml = await signed.text();
      assert.match(signedHtml, /actor kind <strong>human<\/strong>/);
      assert.match(signedHtml, /new product/);
      assert.match(signedHtml, /iteration/);

      const payload = '<script>alert(1)</script> Users need a magic-link sign-in';
      await fetch(`${projectUrl}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: payload }),
        redirect: 'manual',
      });
      const after = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.equal(after.includes('<script>alert(1)</script>'), false);
      assert.match(after, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(after, new RegExp(MOCK_REPLY_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(after, /Focused next question/);
      assert.match(after, /Pending proposals/);
      assert.match(after, /Approve selected into a new baseline/);
      assert.doesNotMatch(after, /Start delivery/);
      assert.ok(after.indexOf('name="message"') < after.indexOf('Conversation history'));
      assert.match(after, /overflow-wrap: anywhere/);
      assert.doesNotMatch(after, /overflow-x:\s*hidden/);

      const agentCookie = await demoSession(url, 'demo-agent');
      const agentPage = await (await fetch(projectUrl, { headers: { cookie: agentCookie } })).text();
      assert.match(agentPage, /not a member|Sign in|error/i);

      const outsiderCookie = await demoSession(url, 'demo-outsider');
      const outsider = await fetch(projectUrl, { headers: { cookie: outsiderCookie } });
      const outsiderHtml = await outsider.text();
      assert.equal(outsider.status, 403);
      assert.match(outsiderHtml, /not a member/);
    } finally {
      await workspace.close();
    }
  });

  it('lets a mapped human approve selected proposals and export the reviewed revision', async () => {
    const { workspace, url } = await start();
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie, 'Review flow');
      const projectUrl = new URL(location, url);
      await fetch(`${projectUrl}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: 'Export must identify the reviewed revision' }),
        redirect: 'manual',
      });
      const page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const refs = [...page.matchAll(/name="proposal_refs" value="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(refs.length >= 1);
      const expected = page.match(/name="expected_revision" value="(\d+)"/)[1];
      await fetch(`${projectUrl}/review`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams([
          ['action', 'approve'],
          ['expected_revision', expected],
          ...refs.map((ref) => ['proposal_refs', ref]),
        ]),
        redirect: 'manual',
      });
      const json = await (await fetch(`${projectUrl}/handover.json`, { headers: { cookie } })).json();
      const csv = await (await fetch(`${projectUrl}/handover.csv`, { headers: { cookie } })).text();
      assert.equal(json.baseline.revision, 1);
      assert.ok(csv.includes(json.baseline.revision_seal));
      assert.ok(csv.includes(json.baseline.content_digest));
      const reviewed = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.match(reviewed, /Reviewed baseline/);
      assert.match(reviewed, new RegExp(json.baseline.baseline_ref));
    } finally {
      await workspace.close();
    }
  });

  it('rejects browser provider overrides over HTTP and refuses production without JWT/JWKS', async () => {
    const { workspace, url } = await start();
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const blocked = await fetch(`${projectUrl}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie,
          origin: new URL(url).origin,
        },
        body: JSON.stringify({
          message: 'hi',
          baseUrl: 'http://evil.example/v1',
          apiKey: 'sk-browser',
        }),
      });
      assert.equal(blocked.status, 400);
      const body = await blocked.json();
      assert.match(body.error, /must not supply provider endpoints/);
    } finally {
      await workspace.close();
    }

    assert.throws(
      () => normalizeWorkspaceConfig({
        mode: 'production',
        defaultProvider: 'mock',
        providers: { mock: { kind: 'mock' } },
      }),
      /production identity is unconfigured/,
    );
  });

  it('accepts a configured JWT on the workspace HTTP boundary', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    jwk.kid = 'ws';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'ws' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://auth.test',
      aud: 'aithema',
      sub: 'jwt-reviewer',
      exp: now + 120,
      iat: now,
    })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), pair.privateKey).toString('base64url');
    const token = `${head}.${payload}.${signature}`;

    const { workspace, url } = await start({
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
        jwks: { keys: [jwk] },
        memberships: [{
          subject: 'jwt-reviewer',
          party_ref: 'party:jwt-reviewer',
          actor_kind: 'human',
          roles: ['requirements_approver', 'delivery_party'],
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
    });
    try {
      const unauthorized = await fetch(url);
      assert.equal(unauthorized.status, 401);
      assert.match(await unauthorized.text(), /OIDC/);
      const authorized = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(authorized.status, 200);
      const html = await authorized.text();
      assert.doesNotMatch(html, /Demo \/ mock/i);
      assert.match(html, /party:jwt-reviewer/);
    } finally {
      await workspace.close();
    }
  });

  it('ships demo and production example configs used by the operator runbook', () => {
    const demo = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/demo-config.json', import.meta.url)), 'utf8'));
    const production = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/production-config.example.json', import.meta.url)), 'utf8'));
    assert.equal(demo.mode, 'demo');
    assert.equal(demo.providers.mock.kind, 'mock');
    assert.equal(demo.identity.demoHmacSecret, undefined);
    assert.equal(production.mode, 'production');
    assert.equal(production.identity.kind, 'jwt-jwks');
    assert.equal(production.providers['local-openai'].kind, 'openai-compatible');
    assert.equal(demo.policy, undefined);
    assert.equal(production.policy.execution, 'local');
    assert.equal(production.policy.maxOutboundCallsPerProject, 40);
    assert.equal(production.providers['local-openai'].executionLocation, 'local');
  });

  it('rejects cross-origin cookie mutations, advertises security headers, and keeps health basic', async () => {
    const { workspace, url } = await start();
    try {
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('content-security-policy')?.includes("frame-ancestors 'self'"), true);
      assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      const healthBody = await health.json();
      assert.deepEqual(healthBody, { ok: true, ready: true });
      assert.equal('mode' in healthBody, false);
      assert.equal('provider' in healthBody, false);
      assert.equal('identity' in healthBody, false);

      const cookie = await demoSession(url, 'demo-reviewer');
      const proto = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: '__proto__=polluted&constructor=y&title=Null+prototype&project_kinds=new_product',
        redirect: 'manual',
      });
      assert.equal(proto.status, 303);

      const forged = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: 'http://evil.example',
        },
        body: new URLSearchParams({ title: 'Forged', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(forged.status, 403);
      assert.match(await forged.text(), /request origin is not allowed/);

      const nullOrigin = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: 'null',
        },
        body: new URLSearchParams({ title: 'Null origin', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(nullOrigin.status, 403);
      assert.match(await nullOrigin.text(), /request origin is not allowed/);
    } finally {
      await workspace.close();
    }
  });

  it('accepts same-origin form posts via referer when origin is omitted', async () => {
    const { workspace, url } = await start();
    try {
      const home = await fetch(url);
      assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

      const cookie = await demoSession(url, 'demo-reviewer');
      const viaReferer = await fetch(`${url}/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          referer: `${url}/`,
        },
        body: new URLSearchParams({ title: 'Referer only', project_kinds: 'new_product' }),
        redirect: 'manual',
      });
      assert.equal(viaReferer.status, 303);
    } finally {
      await workspace.close();
    }
  });

  it('surfaces an incomplete-turn notice after HTML form submit', async () => {
    const { createServer } = await import('node:http');
    const { OpenAICompatibleProvider } = await import('../runtime/provider.js');
    const sseServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
    const { port } = sseServer.address();
    const config = {
      ...demoConfig,
      defaultProvider: 'fixture',
      providers: {
        fixture: {
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          modelId: 'fixture-model',
          allowedModels: ['fixture-model'],
        },
      },
    };
    const { workspace, url } = await start(config);
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie, 'Incomplete notice');
      const projectUrl = new URL(location, url);
      const turn = await fetch(`${projectUrl}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: 'Need a complete answer' }),
        redirect: 'manual',
      });
      assert.equal(turn.status, 303);
      assert.match(turn.headers.get('location') ?? '', /incomplete=truncated/);
      const page = await (await fetch(new URL(turn.headers.get('location'), url), { headers: { cookie } })).text();
      assert.match(page, /did not complete/);
      assert.match(page, /no proposals were created/i);
    } finally {
      await workspace.close();
      await new Promise((resolve) => sseServer.close(resolve));
    }
  });

  it('renders truthful HTML intake receipts with escaped rejections and bounded notices', async () => {
    const capConfig = {
      ...demoConfig,
      uploadLimits: { maxDocumentsPerProject: 2 },
    };
    const { workspace, url } = await start(capConfig);
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie, 'HTML intake receipts');
      const projectUrl = new URL(location, url);
      const origin = new URL(url).origin;
      let page = await approveBaseline(url, cookie, projectUrl);
      const expected = page.match(/name="expected_revision" value="(\d+)"/)[1];

      const oversize = new FormData();
      oversize.set('expected_revision', expected);
      oversize.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        'huge.txt',
      );
      const oversizePage = await followHtmlNotice(
        url,
        cookie,
        await uploadDocuments(projectUrl, cookie, origin, oversize),
      );
      assert.match(oversizePage, /huge\.txt: not retained \(file too large\)/);
      assert.doesNotMatch(oversizePage, /document retained|Document intake recorded/i);

      const mixed = new FormData();
      mixed.set('expected_revision', expected);
      mixed.append('files', new Blob(['kept'], { type: 'text/plain' }), 'kept.txt');
      mixed.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        'drop.txt',
      );
      const mixedPage = await followHtmlNotice(
        url,
        cookie,
        await uploadDocuments(projectUrl, cookie, origin, mixed),
      );
      assert.match(mixedPage, /1 document retained/);
      assert.match(mixedPage, /drop\.txt: not retained \(file too large\)/);

      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const emojiRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const emojiName = `${'😀'.repeat(800)}.txt`;
      const mixedEmoji = new FormData();
      mixedEmoji.set('expected_revision', emojiRevision);
      mixedEmoji.append('files', new Blob(['kept-A'], { type: 'text/plain' }), 'kept-A.txt');
      mixedEmoji.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        emojiName,
      );
      const mixedEmojiResponse = await uploadDocuments(projectUrl, cookie, origin, mixedEmoji);
      assert.equal(mixedEmojiResponse.status, 303);
      const mixedEmojiLocation = mixedEmojiResponse.headers.get('location') ?? '';
      assert.ok(Buffer.byteLength(mixedEmojiLocation, 'utf8') <= 4096);
      const mixedEmojiPage = await followHtmlNotice(url, cookie, mixedEmojiResponse);
      assert.match(mixedEmojiPage, /1 document retained/);
      assert.match(mixedEmojiPage, /not retained \(file too large\)/);
      assert.match(mixedEmojiPage, /kept-A\.txt/);

      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const hostileName = '<img onerror=alert(1)>.txt';
      const hostile = new FormData();
      hostile.set('expected_revision', page.match(/name="expected_revision" value="(\d+)"/)[1]);
      hostile.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        hostileName,
      );
      const hostilePage = await followHtmlNotice(
        url,
        cookie,
        await uploadDocuments(projectUrl, cookie, origin, hostile),
      );
      assert.equal(hostilePage.includes('<img onerror=alert(1)>'), false);
      assert.match(hostilePage, /&lt;img onerror=alert\(1\)&gt;\.txt: not retained \(file too large\)/);

      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const longRejectRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const longReject = new FormData();
      longReject.set('expected_revision', longRejectRevision);
      longReject.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        `${'b'.repeat(1550)}.txt`,
      );
      const longRejectResponse = await uploadDocuments(projectUrl, cookie, origin, longReject);
      assert.equal(longRejectResponse.status, 303);
      assert.ok(Buffer.byteLength(longRejectResponse.headers.get('location') ?? '', 'utf8') <= 4096);
      const longRejectPage = await followHtmlNotice(url, cookie, longRejectResponse);
      assert.match(longRejectPage, /No documents were retained\./);
      assert.match(longRejectPage, /not retained \(file too large\)/);
      assert.doesNotMatch(longRejectPage, /document retained|Document intake recorded/i);

      const astralReject = new FormData();
      astralReject.set('expected_revision', longRejectRevision);
      astralReject.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        `${'😀'.repeat(900)}.txt`,
      );
      const astralRejectResponse = await uploadDocuments(projectUrl, cookie, origin, astralReject);
      assert.equal(astralRejectResponse.status, 303);
      assert.ok(Buffer.byteLength(astralRejectResponse.headers.get('location') ?? '', 'utf8') <= 4096);
      const astralRejectPage = await followHtmlNotice(url, cookie, astralRejectResponse);
      assert.match(astralRejectPage, /No documents were retained\./);
      assert.match(astralRejectPage, /not retained \(file too large\)/);

      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const atCapRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const handoverBytes = ownFormatHandoverBytes((handover) => ({
        ...handover,
        baseline: {
          ...handover.baseline,
          requirements: [
            ...handover.baseline.requirements,
            {
              requirement_ref: 'req.imported',
              statement: 'Imported through own-format at cap',
              acceptance_criteria: ['Still a proposal'],
              constraint_refs: [],
            },
          ],
        },
      }));
      const atCap = new FormData();
      atCap.set('expected_revision', atCapRevision);
      atCap.append(
        'files',
        new Blob([handoverBytes], { type: 'application/json' }),
        'handover.json',
      );
      const atCapPage = await followHtmlNotice(
        url,
        cookie,
        await uploadDocuments(projectUrl, cookie, origin, atCap),
      );
      assert.match(atCapPage, /unapproved proposals/i);
      assert.match(atCapPage, /handover\.json: not retained \(project document limit reached\)/);
      assert.doesNotMatch(atCapPage, /document retained|Document intake recorded/i);

      const bounded = new FormData();
      bounded.set('expected_revision', atCapRevision);
      bounded.append(
        'files',
        new Blob([Buffer.alloc(MAX_FILE_BYTES + 1)], { type: 'text/plain' }),
        `${'x'.repeat(1550)}.txt`,
      );
      const boundedResponse = await uploadDocuments(projectUrl, cookie, origin, bounded);
      assert.equal(boundedResponse.status, 303);
      const boundedLocation = boundedResponse.headers.get('location') ?? '';
      assert.ok(Buffer.byteLength(boundedLocation, 'utf8') <= 4096);
      const boundedPage = await (await fetch(new URL(boundedLocation, url), {
        headers: { cookie },
      })).text();
      assert.match(boundedPage, /No documents were retained\./);
      assert.match(boundedPage, /not retained \(file too large\)/);
      assert.doesNotMatch(boundedPage, /document retained|Document intake recorded/i);
      assert.equal(boundedPage.includes('<script'), false);
    } finally {
      await workspace.close();
    }

    const { workspace: reasonWorkspace, url: reasonUrl } = await start(demoConfig);
    try {
      const cookie = await demoSession(reasonUrl, 'demo-reviewer');
      const location = await createProject(reasonUrl, cookie, 'Reason-channel intake receipts');
      const projectUrl = new URL(location, reasonUrl);
      const origin = new URL(reasonUrl).origin;
      await approveBaseline(reasonUrl, cookie, projectUrl);

      let page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const surrogateRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const surrogateRef = `req.${'\uD800'}`;
      const jsonOnlySurrogate = new FormData();
      jsonOnlySurrogate.set('expected_revision', surrogateRevision);
      jsonOnlySurrogate.append(
        'files',
        new Blob([duplicateRequirementRefHandoverBytes(surrogateRef)], { type: 'application/json' }),
        'handover-surrogate.json',
      );
      const jsonSurrogate = await uploadDocuments(
        projectUrl,
        cookie,
        origin,
        jsonOnlySurrogate,
        'application/json',
      );
      assert.equal(jsonSurrogate.status, 200);
      const jsonSurrogateBody = await jsonSurrogate.json();
      assert.match(
        jsonSurrogateBody.rejected?.[0]?.reason ?? '',
        /duplicate handover baseline requirements/,
      );
      assert.match(jsonSurrogateBody.rejected?.[0]?.reason ?? '', /\uD800/);

      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      const mixedSurrogateRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const mixedSurrogate = new FormData();
      mixedSurrogate.set('expected_revision', mixedSurrogateRevision);
      mixedSurrogate.append('files', new Blob(['kept-ok'], { type: 'text/plain' }), 'kept-ok.txt');
      mixedSurrogate.append(
        'files',
        new Blob([duplicateRequirementRefHandoverBytes(surrogateRef)], { type: 'application/json' }),
        'handover-surrogate.json',
      );
      const mixedSurrogateResponse = await uploadDocuments(projectUrl, cookie, origin, mixedSurrogate);
      assert.equal(mixedSurrogateResponse.status, 303);
      const mixedSurrogateLocation = mixedSurrogateResponse.headers.get('location') ?? '';
      assert.ok(Buffer.byteLength(mixedSurrogateLocation, 'utf8') <= 4096);
      const mixedSurrogatePage = await followHtmlNotice(reasonUrl, cookie, mixedSurrogateResponse);
      assert.match(mixedSurrogatePage, /1 document retained/);
      assert.match(mixedSurrogatePage, /not retained/);
      assert.match(mixedSurrogatePage, /kept-ok\.txt/);
      page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.match(page, /kept-ok\.txt/);

      const astralReasonRevision = page.match(/name="expected_revision" value="(\d+)"/)[1];
      const astralReasons = new FormData();
      astralReasons.set('expected_revision', astralReasonRevision);
      for (const label of ['alpha', 'beta', 'gamma', 'delta']) {
        const emojiRef = `${'😀'.repeat(300)}-${label}`;
        astralReasons.append(
          'files',
          new Blob([duplicateRequirementRefHandoverBytes(emojiRef)], { type: 'application/json' }),
          `${label}-handover.json`,
        );
      }
      const astralReasonsResponse = await uploadDocuments(projectUrl, cookie, origin, astralReasons);
      assert.equal(astralReasonsResponse.status, 303);
      const astralReasonsLocation = astralReasonsResponse.headers.get('location') ?? '';
      assert.ok(Buffer.byteLength(astralReasonsLocation, 'utf8') <= 4096);
      const astralReasonsPage = await followHtmlNotice(reasonUrl, cookie, astralReasonsResponse);
      assert.match(astralReasonsPage, /No documents were retained\./);
      assert.match(astralReasonsPage, /not retained/);
      assert.doesNotMatch(astralReasonsPage, /document retained|Document intake recorded/i);
    } finally {
      await reasonWorkspace.close();
    }
  });

  it('describes PDF subset limits with precise glyph capability wording', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    assert.match(readme, /some Latin Extended Additional codepoints such as U\+1EBF and U\+1EC7/);
    assert.doesNotMatch(readme, /including CJK and Latin Extended Additional\) are refused/);
  });
});
