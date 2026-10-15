import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';
import { chargedMicro, consentItem, reply, summary, usage } from '../fixtures/external-plugin/index.js';

test('AIT-200: an external package supplies replies, overview, cost receipts and its own consent item through host configuration', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-external-browser-'));
  let browser;
  const host = await startChild(new URL('../fixtures/external-plugin-server.js', import.meta.url), join(directory, 'session.sqlite'));
  t.after(async () => { try { await browser?.close(); } finally { await host.kill(); await rm(directory, { recursive: true, force: true }); } });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    env: { PATH: process.env.PATH, HOME: homedir() }, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), problems = [], externalRequests = [];
  page.setDefaultTimeout(30_000); await page.setViewport({ width: 1440, height: 1100 });
  page.on('pageerror', e => problems.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).origin !== host.url && !request.url().startsWith('data:')) {
      externalRequests.push(request.url()); void request.abort();
    } else void request.continue();
  });
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  assert.equal(await page.$eval('aithema-session', c => c.session.featureMatrix.best.text.available), false);
  const selector = `#items input[value="${consentItem.id}"]`;
  assert.equal(await page.$eval(selector, el => el.checked), false);
  assert.equal(await page.$eval('#items', el => el.textContent), `${consentItem.title} ${consentItem.recipients} ${consentItem.text}`);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'ait-200-external-consent.png'), fullPage: false });
  }
  await page.click(selector); await page.click('#grant');
  await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.text.available &&
    document.querySelector('#consent-status').textContent === 'External model processing allowed');
  await page.click('aithema-session >>> .chooser__continue');
  await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').disabled);
  await page.$eval('aithema-session', c => {
    c.shadowRoot.querySelector('textarea').value = 'We need a project planning application.';
    c.shadowRoot.querySelector('form.composer').requestSubmit();
  });
  await page.waitForFunction(({ reply, summary }) => {
    const c = document.querySelector('aithema-session');
    return c.session.transcript.some(t => t.role === 'assistant' && t.content === reply) &&
      c.session.understanding.summary === summary && c.shadowRoot.querySelector('.analysis-content').textContent.includes(summary);
  }, {}, { reply, summary });
  // Wait for the reference UI's opening transition, not an arbitrary delay.
  await page.waitForFunction(() => {
    const root = document.querySelector('aithema-session').shadowRoot, workspace = root.querySelector('.workspace');
    const text = root.querySelector('.summary-text').getBoundingClientRect(), pane = root.querySelector('.understanding').getBoundingClientRect();
    return !workspace.hasAttribute('data-reveal') && text.width > 0 && text.left >= pane.left && text.right <= pane.right && text.bottom <= innerHeight;
  });
  const current = await page.$eval('aithema-session', c => ({ model: c.session.transcript.at(-1).model,
    provider: c.session.transcript.at(-1).provider, assessed: c.session.understanding.readinessAssessed,
    replyVisible: c.shadowRoot.querySelector('.transcript-shell').textContent }));
  assert.equal(current.model, 'external/proof-v1'); assert.equal(current.provider, 'external-model');
  assert.equal(current.assessed, true); assert.ok(current.replyVisible.includes(reply));
  const rows = await page.evaluate(() => fetch('/proof').then(r => r.json()));
  assert.equal(rows.length, 2); assert.deepEqual(new Set(rows.map(r => r.lane)), new Set(['reaction', 'understanding']));
  for (const row of rows) {
    assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'completed'); assert.equal(row.settled_micro, chargedMicro);
    assert.deepEqual(JSON.parse(row.usage), usage);
  }
  assert.deepEqual(externalRequests, []); assert.deepEqual(problems, []);
  if (evidence) {
    await page.screenshot({ path: join(evidence, 'ait-200-external-overview.png'), fullPage: false });
    await writeFile(join(evidence, 'ait-200-receipts.json'), JSON.stringify(rows, null, 2) + '\n');
  }
});
