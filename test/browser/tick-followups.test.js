// AIT-186: Tick's binding follow-ups. Viewport evidence only, remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, settle, boxes, evidenceCommit } from './start2-display-helpers.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-tick-followups-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.tickSeed = c.session; });
  return page;
}
async function scene(page, locale, theme, width) {
  await page.setViewport({ width, height: width < 600 ? 844 : 900 }); await page.select('#theme', theme);
  await page.evaluate(async locale => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale;
    c.configure({ copy, session, host: { library: true } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    scrollTo(0, 0);
  }, locale);
  await settle();
}
async function evidence(finding, page, label, values) {
  const root = process.env.AITHEMA_EVIDENCE_DIR;
  if (root) {
    const dir = join(root, finding); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(dir, `${label}.json`), JSON.stringify({ head: evidenceCommit, finding, label, ...values, pass: true }, null, 2));
  }
}

test('AIT-186 F1: phone header controls never overlap; DE/EN, L/D', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393, 400, 412, 430, 440, 460, 480, 500, 550, 1024, 1440]) {
    await scene(page, locale, theme, width);
    const selectors = ['.band', '.conversations-toggle', '.band-utilities', '.settings-open'];
    const before = await boxes(page, selectors);
    const metrics = await shadow(page, c => {
      const r = c.shadowRoot, button = r.querySelector('.conversations-toggle'), label = button.querySelector('span');
      const b = button.getBoundingClientRect(), u = r.querySelector('.band-utilities').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(label);
      const text = range.getBoundingClientRect(), chevron = button.lastElementChild.getBoundingClientRect();
      const labelShown = getComputedStyle(label).display !== 'none';
      return { overlapPx: Math.max(0, b.right - u.left, labelShown ? text.right - u.left : 0, labelShown ? chevron.right - u.left : 0),
        labelShown, labelWidth: text.width, availableWidth: b.width, requiredWidth: 16 + 10 + text.width + 6 + 6 };
    });
    const label = `${locale}-${theme}-${width}`;
    assert.equal(metrics.overlapPx, 0, `${label}: header overlap ${JSON.stringify(metrics)}`);
    await page.hover('aithema-session >>> .conversations-toggle');
    assert.deepEqual(await boxes(page, selectors), before, `${label}: hover shift 0 px`);
    const values = { ...metrics, shiftPx: 0 };
    await evidence('F1', page, label, values); t.diagnostic(`PASS F1 ${label}: ${JSON.stringify(values)}`);
  }
});
