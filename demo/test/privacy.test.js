import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deploymentConfig } from '../deployment.js';
import { startChild, temporaryDb, post } from '../../test/helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/privacy.html', import.meta.url));
const server = new URL('../server.js', import.meta.url);
async function documentFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-privacy-'));
  const path = join(dir, 'privacy.html');
  await writeFile(path, content);
  return path;
}

test('AIT-151: absent privacy config exposes null and refuses all non-delivering identity mutations', async t => {
  const running = await startChild(server, await temporaryDb(), { AITHEMA_PROVIDER: 'mock' });
  t.after(() => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.equal(config.privacy, null);
  assert.equal((await fetch(running.url + '/privacy')).status, 404);
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  for (const [action, body] of [['request', { address: 'visitor@example.test' }], ['change', { address: 'other@example.test' }],
    ['resend', {}], ['confirm', { token: 'unused' }], ['unlock', {}]]) {
    const response = await post(running.url + `/api/sessions/${session.id}/identity/${action}`, body, headers);
    assert.equal(response.status, 403, action);
    assert.deepEqual(await response.json(), { error: 'privacy-document-required' });
  }
  const identity = await fetch(running.url + `/api/sessions/${session.id}/identity`, { headers }).then(r => r.json());
  assert.equal(identity.identity.address, null);
});

test('AIT-151: configured privacy is served in host styling with script-free CSP, GET and HEAD', async t => {
  const running = await startChild(server, await temporaryDb(), { AITHEMA_PROVIDER: 'mock', AITHEMA_PRIVACY_DOCUMENT: fixture });
  t.after(() => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.deepEqual(config.privacy, { url: '/privacy' });
  assert.ok(!JSON.stringify(config).includes(fixture), 'private deployment path is never public');
  const response = await fetch(running.url + config.privacy.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const csp = response.headers.get('content-security-policy');
  for (const directive of ["default-src 'none'", "script-src 'none'", "style-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), directive);
  const html = await response.text();
  assert.match(html, /Example privacy notice for tests/u);
  assert.match(html, /href="\/demo\/host\.css"/u);
  assert.doesNotMatch(html, /<script|\son[a-z]+\s*=|<iframe|<form/iu);
  const head = await fetch(running.url + '/privacy', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-security-policy'), csp);
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const request = await post(running.url + `/api/sessions/${session.id}/identity/request`, { address: 'visitor@example.test' }, headers);
  assert.equal(request.status, 200, 'a validated document releases the privacy guard');
});

test('AIT-151: locale variants and safe fallback are loaded once at startup', async t => {
  const de = await documentFile('<h1>Beispiel-Datenschutzhinweis für Tests</h1>');
  const en = await documentFile('<h1>Example localized privacy notice for tests</h1>');
  const running = await startChild(server, await temporaryDb(), { AITHEMA_PRIVACY_DOCUMENT: fixture,
    AITHEMA_PRIVACY_DOCUMENT_DE: de, AITHEMA_PRIVACY_DOCUMENT_EN: en });
  t.after(() => running.kill());
  assert.match(await fetch(running.url + '/privacy?locale=de').then(r => r.text()), /Beispiel-Datenschutzhinweis/u);
  assert.match(await fetch(running.url + '/privacy?locale=en').then(r => r.text()), /Example localized/u);
  await writeFile(en, '<script>throw new Error()</script>');
  assert.match(await fetch(running.url + '/privacy?locale=en').then(r => r.text()), /Example localized/u);
  for (const path of ['/privacy', '/privacy/', '/privacy?locale=unknown', '/privacy?locale=%22%3E%3Cscript%3E']) {
    const response = await fetch(running.url + path);
    assert.equal(response.status, 200); assert.match(await response.text(), /Example privacy notice for tests/u);
  }
});

test('AIT-151: startup rejects invalid documents before creating the database', async () => {
  const bad = await documentFile('<p onclick="alert(1)">Example privacy notice for tests</p>');
  const db = await temporaryDb();
  const result = spawnSync(process.execPath, [fileURLToPath(server)], {
    env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: db, AITHEMA_PRIVACY_DOCUMENT: bad }, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Invalid privacy document/u);
  await assert.rejects(access(db), { code: 'ENOENT' });
});

test('AIT-151: strict HTML allowlist rejects executable, malformed and fetching content', async t => {
  const { loadPrivacyDocuments } = await import('../privacy.js');
  for (const html of ['<script>alert(1)</script>', '<p onload="alert(1)">Example</p>', '<style>body { background: url(https://example.test) }</style>',
    '<iframe srcdoc="test"></iframe>', '<svg><a href="javascript:alert(1)">Example</a></svg>', '<form></form>',
    '<a href="javascript:alert(1)">Example</a>', '<a href="java&#x73;cript:alert(1)">Example</a>',
    '<a href="//example.test">Example</a>', '<img src="https://example.test/track">', '<meta http-equiv="refresh" content="0">',
    '<base href="https://example.test">', '<p style="color:red">Example</p>', '<p class="hidden">Example</p>',
    '<a href=/privacy>Example</a>', '<p>Example</div>', '<p>Example', '<p title="x" title="y">Example</p>',
    '<!doctype html><p>Example</p>', '<p>Example\u0000</p>', Buffer.from([0xff])]) {
    await t.test(String(html), async () => {
      const path = await documentFile(html);
      await assert.rejects(loadPrivacyDocuments(deploymentConfig({ AITHEMA_PRIVACY_DOCUMENT: path }).privacyDocuments), /Invalid privacy document/u);
    });
  }
  const path = await documentFile('<section lang="en"><h1 id="notice">Example privacy notice for tests</h1><p><strong>Example</strong> &amp; text.</p><ul><li>Item</li></ul><a href="https://example.test/privacy">Policy</a><a href="mailto:privacy@example.test">Contact</a><a href="#notice">Top</a></section>');
  const privacy = await loadPrivacyDocuments(deploymentConfig({ AITHEMA_PRIVACY_DOCUMENT: path }).privacyDocuments);
  assert.equal(privacy.privacyDocumentConfigured(), true);
});

test('AIT-151: missing, unreadable, non-file, empty and oversized documents fail closed', async () => {
  const { loadPrivacyDocuments, MAX_PRIVACY_BYTES } = await import('../privacy.js');
  const absent = await loadPrivacyDocuments(deploymentConfig({}).privacyDocuments);
  assert.equal(absent.privacyDocumentConfigured(), false); assert.equal(absent.config, null);
  const empty = await documentFile(''), large = await documentFile('x'.repeat(MAX_PRIVACY_BYTES + 1));
  const unreadable = await documentFile('<p>Example privacy notice for tests</p>');
  await chmod(unreadable, 0);
  try {
    for (const path of ['/nonexistent/aithema-privacy.html', tmpdir(), empty, large, unreadable, '']) {
      await assert.rejects(loadPrivacyDocuments(deploymentConfig({ AITHEMA_PRIVACY_DOCUMENT: path }).privacyDocuments), /Invalid privacy document/u);
    }
    const badLocale = await documentFile('<script>alert(1)</script>');
    await assert.rejects(loadPrivacyDocuments(deploymentConfig({ AITHEMA_PRIVACY_DOCUMENT: fixture, AITHEMA_PRIVACY_DOCUMENT_EN: badLocale }).privacyDocuments), /Invalid privacy document/u);
  } finally { await chmod(unreadable, 0o600); }
});
