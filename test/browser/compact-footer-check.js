import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceBrowserArgs, evidenceCommit, settleEvidenceFrame } from './start2-display-helpers.js';

export async function compactFooterCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const browser = await browserForFile(evidence ? { args: evidenceBrowserArgs } : {});
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== demo.url) return void request.abort();
    if (url.pathname !== '/ait299') return void request.continue();
    void request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
      <link rel="stylesheet" href="/demo/host.css"><style>body { margin:0; }
      aithema-session { --aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
        --aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif; }</style></head><body><main></main></body></html>` });
  });
  await page.goto(`${demo.url}/ait299`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const now = Date.now(); Date.now = () => now;
    window.footerSession = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) }).then(r => r.json());
    await import('/packages/ui/src/session-element.js');
    window.footerBoxes = () => {
      const root = document.querySelector('aithema-session').shadowRoot;
      const selectors = ['.display-foot', '.band', '.composer-dock', '.engine-info', '.status__dot'];
      return selectors.map(selector => { const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
    const name = `ait299-footer-${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(async ({ theme, locale }) => {
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      document.querySelector('main').innerHTML = `<aithema-session theme="${theme}" motion="off"></aithema-session>`;
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.footerSession); session.locale = locale;
      document.querySelector('aithema-session').configure({ copy, session, voiceClient: {}, host: { library: true } });
      window.footerConnected = copy.connected;
    }, { theme, locale });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.status__label').textContent === window.footerConnected);
    await settleEvidenceFrame(page);
    await page.evaluate(width => {
      const root = document.querySelector('aithema-session').shadowRoot;
      window.footerLabel = root.querySelector(width >= 1100 ? '.ai-notice__label' : '.connection-timer');
      window.footerShortText = window.footerLabel.textContent;
      window.footerLabel.textContent = 'A deliberately long host label '.repeat(20);
    }, width);
    await settleEvidenceFrame(page);
    const before = await page.evaluate(() => {
      const footer = document.querySelector('aithema-session').shadowRoot.querySelector('.display-foot');
      return { fit: footer.dataset.fit, labelHidden: !window.footerLabel.getClientRects().length, boxes: window.footerBoxes() };
    });
    if (width >= 600) {
      assert.notEqual(before.fit, 'full', `${name}: long copy requires compact mode`);
      assert.equal(before.labelHidden, true, `${name}: the changed label is hidden by compact fit`);
    }
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-before.png`), fullPage: false, captureBeyondViewport: false });
    // Hold the preset control under a real stationary pointer during the mutation.
    const [x, y, w, h] = before.boxes[3]; await page.mouse.move(x + w / 2, y + h / 2);
    await page.evaluate(() => { window.footerLabel.textContent = window.footerShortText; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const held = await page.evaluate(() => ({ boxes: window.footerBoxes(), hit: document.querySelector('aithema-session').shadowRoot.elementFromPoint(...(() => {
      const b = document.querySelector('aithema-session').shadowRoot.querySelector('.engine-info').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2];
    })())?.closest('.engine-info') !== null }));
    assert.deepEqual(held.boxes, before.boxes, `${name}: controls move 0px while the pointer rests on the footer`);
    assert.equal(held.hit, true);
    await settleEvidenceFrame(page); // Blurs controls and moves the pointer out before the after shot.
    const after = await page.evaluate(() => ({ fit: document.querySelector('aithema-session').shadowRoot.querySelector('.display-foot').dataset.fit, boxes: window.footerBoxes() }));
    assert.equal(after.fit, 'full', `${name}: shorter hidden copy restores the full fit`);
    assert.deepEqual(after.boxes.slice(0, 3), before.boxes.slice(0, 3), `${name}: footer, band and composer shift 0px`);
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-after.png`), fullPage: false, captureBeyondViewport: false });
    checks.push({ head: evidenceCommit, width, theme, locale, before, held, after, pass: true });
    console.log(`${name}: PASS compact refit; pointer controls and outer layout shift 0px`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait299-footer-checks.json'), JSON.stringify({ head: evidenceCommit,
    capture: 'viewport', reducedMotion: true, blurredControls: true, fonts: 'Chrome baseline', checks }, null, 2) + '\n');
}
