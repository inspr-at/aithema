import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as firstPaint from '../../packages/ui/src/first-paint.js';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceBrowserArgs, evidenceCommit, settleEvidenceFrame } from './start2-display-helpers.js';

export async function scrollbarFirstPaintCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-scrollbar-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  // Puppeteer's headless default otherwise suppresses even styled classic bars.
  const browser = await browserForFile({ ignoreDefaultArgs: ['--hide-scrollbars'], ...(evidence ? { args: evidenceBrowserArgs } : {}) });
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 760, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== demo.url) return void request.abort();
    if (url.pathname !== '/ait276') return void request.continue();
    void request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="de"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
      <link rel="stylesheet" href="/demo/host.css"><style>
      html { overflow-y:scroll; } ::-webkit-scrollbar { width:15px; height:15px; }
      body { margin:0; } .aithema-shell { width:100%; }
      .aithema-shell > * { --aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
        --aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif; }
      .wide > * { --aithema-header-actions-width:280px; }
      ${firstPaint.headerRailReservation?.({ selector: '.wide > :is(aithema-session,.aithema-first-paint)', actionsWidth: '280px' }) ?? ''}
      </style></head><body><main class="aithema-shell"></main></body></html>` });
  });
  await page.goto(`${demo.url}/ait276`, { waitUntil: 'domcontentloaded' });
  // One page and one local session; no host bootstrap, voice startup or provider dispatch.
  await page.evaluate(async () => {
    window.scrollbarSession = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'de' }) }).then(r => r.json());
    window.bandGeometry = () => {
      const c = document.querySelector('aithema-session'), mounted = c.hasAttribute('data-aithema-mounted');
      const band = mounted ? c.shadowRoot.querySelector('.band') : document.querySelector('.aithema-first-paint');
      const rail = band.querySelector('.audio-rail'), b = band.getBoundingClientRect(), r = rail.getBoundingClientRect();
      return { band: [b.x, b.y, b.width, b.height], rail: [r.x, r.y, r.width, r.height], row: getComputedStyle(rail).gridRowStart,
        scrollbar: innerWidth - document.documentElement.clientWidth,
        fit: mounted ? { tracks: getComputedStyle(band).gridTemplateColumns, padding: getComputedStyle(band).padding,
          brand: band.querySelector('.band-identity').getBoundingClientRect().width, actions: band.querySelector('.header-actions').getBoundingClientRect().width,
          reserved: getComputedStyle(band).getPropertyValue('--aithema-header-rail-row'), measuredRow: band.hasAttribute('data-rail-row') } : null };
    };
  });
  const cases = [216, 280].flatMap(actions => [760, 768, 780, 790, 800].map(width => ({ actions, width, locale: 'de', theme: 'light', classic: true })));
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    cases.push(...[1440, 1024, 390].flatMap(width => ['light', 'dark'].flatMap(theme => ['de', 'en'].map(locale => ({ actions: 216, width, theme, locale, classic: true })))));
  }
  // Preserve today's default host geometry without a classic scrollbar as well.
  cases.push(...[760, 768, 780, 790, 800, 1024, 1440, 390].map(width => ({ actions: 216, width, locale: 'de', theme: 'light', classic: false })));
  for (const scene of cases) {
    const { actions, width, locale, theme, classic } = scene;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(({ scene, markup }) => {
      const { actions, locale, theme, classic } = scene;
      document.documentElement.style.overflowY = classic ? 'scroll' : 'hidden';
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      const shell = document.querySelector('.aithema-shell'); shell.classList.toggle('wide', actions === 280);
      shell.innerHTML = `<aithema-session theme="${theme}" motion="off"><h1 slot="brand">START · Augmentoring — a deliberately very long host brand for truncation</h1></aithema-session>${markup}`;
      // Match the capped full-width brand before and after mount, independent of font loading.
      shell.querySelector('.aithema-first-paint .wordmark').textContent = shell.querySelector('h1').textContent;
      window.scrollbarFrames = [];
      const sample = () => { window.scrollbarFrames.push(window.bandGeometry()); window.scrollbarFrame = requestAnimationFrame(sample); };
      window.scrollbarFrame = requestAnimationFrame(sample);
    }, { scene, markup: firstPaint.firstPaintMarkup });
    await settleEvidenceFrame(page);
    const initial = await page.evaluate(() => ({ mounted: document.querySelector('aithema-session').hasAttribute('data-aithema-mounted'), ...window.bandGeometry() }));
    assert.equal(initial.mounted, false, 'reserved geometry is visible before configure');
    assert.equal(initial.scrollbar, classic ? 15 : 0, `host really reserves the requested scrollbar width: ${JSON.stringify(initial)}`);
    const name = `${width}-${actions}-${theme}-${locale}${classic ? '-classic' : '-overlay'}`;
    const capture = evidence && classic && ([768, 780, 790].includes(width) || width >= 1024 || width === 390);
    if (capture) await page.screenshot({ path: join(evidence, `${name}-first-paint.png`), fullPage: false, captureBeyondViewport: false });
    await page.evaluate(async locale => {
      await import('/packages/ui/src/session-element.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.scrollbarSession); session.locale = locale;
      document.querySelector('aithema-session').configure({ copy, session, voiceClient: {}, host: { library: true } });
    }, locale);
    await page.waitForFunction(() => document.querySelector('aithema-session').hasAttribute('data-aithema-mounted'));
    await settleEvidenceFrame(page);
    const mounted = await page.evaluate(() => { cancelAnimationFrame(window.scrollbarFrame); return { ...window.bandGeometry(), frames: window.scrollbarFrames }; });
    if (capture) await page.screenshot({ path: join(evidence, `${name}-mounted.png`), fullPage: false, captureBeyondViewport: false });
    assert.deepEqual(mounted.band, initial.band, `${name}: band box moves 0 px: ${JSON.stringify(mounted.fit)}`);
    assert.deepEqual(mounted.rail, initial.rail, `${name}: rail box moves 0 px`);
    assert.equal(mounted.row, initial.row, `${name}: rail row stays reserved`);
    assert.ok(mounted.rail[2] >= 208, `${name}: mounted rail keeps its 208px floor`);
    for (const frame of mounted.frames) {
      assert.deepEqual(frame.band, initial.band, `${name}: band stays stable through mount`);
      assert.deepEqual(frame.rail, initial.rail, `${name}: rail stays stable through mount`);
    }
    if (!classic) assert.equal(mounted.band[3], width < 600 ? 124 : width < 768 ? 150 : 90, `${name}: existing default host geometry`);
    checks.push({ head: evidenceCommit, ...scene, initial, mounted, pass: true, shiftPx: 0,
      shots: capture ? ['first-paint', 'mounted'].map(phase => ({ file: `${name}-${phase}.png`, phase, head: evidenceCommit, theme, locale })) : [] });
    console.log(`AIT-276 PASS ${name}: classic=${initial.scrollbar}px; band/rail boxes and row ${mounted.row}, every startup frame 0 px`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true, blurredControls: true,
    fonts: 'Chrome baseline: ui-sans-serif,-apple-system,Segoe UI Variable Text,Segoe UI,system-ui,sans-serif; Georgia,Iowan Old Style,Palatino Linotype,serif',
    passLines: ['PASS: classic scrollbar 15px; 760/768/780/790/800; default 216px and wide 280px actions; voice bound; band/rail boxes and rows 0px on every startup frame',
      'PASS: default hosts retain existing geometry', 'PASS: 1440/1024/390 light/dark DE/EN; settled viewport captures; pinned fonts; blurred controls'], checks }, null, 2) + '\n');
}
