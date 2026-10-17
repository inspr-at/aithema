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
      ${firstPaint.headerRailReservation?.({ selector: '.wide:not(.no-helper) > :is(aithema-session,.aithema-first-paint)', actionsWidth: '280px' }) ?? ''}
      </style></head><body><main class="aithema-shell"></main></body></html>` });
  });
  await page.goto(`${demo.url}/ait276`, { waitUntil: 'domcontentloaded' });
  // One page and one local session; no host bootstrap, voice startup or provider dispatch.
  await page.evaluate(async () => {
    // Pin elapsed connection copy; the fit measurement below still spans a
    // full animation frame, after the initial network status has settled.
    const footerNow = Date.now(); Date.now = () => footerNow;
    window.scrollbarSession = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'de' }) }).then(r => r.json());
    window.bandGeometry = () => {
      const c = document.querySelector('aithema-session'), mounted = c.hasAttribute('data-aithema-mounted');
      const band = mounted ? c.shadowRoot.querySelector('.band') : document.querySelector('.aithema-first-paint');
      const rail = band.querySelector('.audio-rail'), b = band.getBoundingClientRect(), r = rail.getBoundingClientRect();
      const a = band.querySelector('.header-actions').getBoundingClientRect();
      const intersection = Math.max(0, Math.min(r.right, a.right) - Math.max(r.left, a.left))
        * Math.max(0, Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top));
      return { intersection, actions: [a.x, a.y, a.width, a.height], band: [b.x, b.y, b.width, b.height], rail: [r.x, r.y, r.width, r.height], row: getComputedStyle(rail).gridRowStart,
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
  cases.push(...[false, true].flatMap(classic => [1250, 1251, 1272, 1273].flatMap(width => ['de', 'en'].map(locale =>
    ({ actions: 216, width, locale, theme: 'light', classic, boundary294: true, status294: true })))));
  // AIT-294 r3: reuse the same page for the full status/startup matrix.
  cases.push(...[600, 700, 768, 820, 1024, 1180].flatMap(width => ['de', 'en'].flatMap(locale =>
    ['light', 'dark'].map(theme => ({ actions: 216, width, locale, theme, classic: false, status294: true })))));
  // Preserve today's default host geometry without a classic scrollbar as well.
  cases.push(...[760, 768, 780, 790, 800, 1024, 1440, 390].map(width => ({ actions: 216, width, locale: 'de', theme: 'light', classic: false })));
  // Older hosts override the actions property without the new reservation helper.
  cases.push(...[true, false].flatMap(classic => [768, 780, 790].map(width =>
    ({ actions: 280, width, locale: 'de', theme: 'light', classic, noHelper: true }))));
  for (const scene of cases) {
    const { actions, width, locale, theme, classic, noHelper } = scene;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(({ scene, markup }) => {
      const { actions, locale, theme, classic, noHelper } = scene;
      document.documentElement.style.overflowY = classic ? 'scroll' : 'hidden';
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      const shell = document.querySelector('.aithema-shell'); shell.classList.toggle('wide', actions === 280);
      shell.classList.toggle('no-helper', Boolean(noHelper));
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
    const name = `${width}-${actions}-${theme}-${locale}${classic ? '-classic' : '-overlay'}${noHelper ? '-no-helper' : ''}`;
    const capture = evidence && (noHelper || classic && ([768, 780, 790].includes(width) || width >= 1024 || width === 390));
    if (capture) await page.screenshot({ path: join(evidence, `${name}-first-paint.png`), fullPage: false, captureBeyondViewport: false });
    await page.evaluate(async locale => {
      await import('/packages/ui/src/session-element.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.scrollbarSession); session.locale = locale;
      window.scrollbarConnected = copy.connected;
      document.querySelector('aithema-session').configure({ copy, session, voiceClient: {}, host: { library: true } });
    }, locale);
    await page.waitForFunction(() => document.querySelector('aithema-session').hasAttribute('data-aithema-mounted')
      && document.querySelector('aithema-session').shadowRoot.querySelector('.status__label').textContent === window.scrollbarConnected);
    await settleEvidenceFrame(page);
    const mounted = await page.evaluate(() => { cancelAnimationFrame(window.scrollbarFrame); return { ...window.bandGeometry(), frames: window.scrollbarFrames }; });
    if (capture) await page.screenshot({ path: join(evidence, `${name}-mounted.png`), fullPage: false, captureBeyondViewport: false });
    assert.equal(mounted.intersection, 0, `${name}: mounted rail/actions box intersection is 0`);
    assert.ok(mounted.rail[2] >= 208, `${name}: mounted rail keeps its 208px floor`);
    if (scene.status294) {
      const scrollFits = await page.evaluate(async () => {
        const footer = document.querySelector('aithema-session').shadowRoot.querySelector('.display-foot');
        const changes = []; const observer = new MutationObserver(records => changes.push(...records));
        observer.observe(footer, { attributes:true, attributeFilter:['data-fit'] });
        for (let i = 0; i < 5; i++) visualViewport.dispatchEvent(new Event('scroll'));
        await new Promise(resolve => requestAnimationFrame(resolve)); observer.disconnect();
        return changes.length;
      });
      assert.equal(scrollFits, 0, `${name}: visual viewport scrolling does not refit the footer`);
      const labels = await page.evaluate(async locale => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const root = document.querySelector('aithema-session').shadowRoot;
        const label = root.querySelector('.voice-state'), signal = root.querySelector('.voice-signal');
        const texts = [...new Set([copy.notConfigured, ...Object.values(copy.voiceStates), copy.voiceMoved, copy.voiceClosureUncertain])];
        return texts.map(text => {
          label.textContent = text;
          const range = document.createRange(); range.selectNodeContents(label);
          const rects = [...range.getClientRects()].filter(b => b.width > 0);
          const b = label.getBoundingClientRect(), s = signal.getBoundingClientRect();
          return { text, lines: new Set(rects.map(b => b.y)).size, whiteSpace: getComputedStyle(label).whiteSpace,
            width: b.width, textWidth: Math.max(...rects.map(b => b.width)), signalWidth: s.width,
            inside: rects.every(r => r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom),
            overflow: label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight };
        });
      }, locale);
      checks.push({ head: evidenceCommit, ...scene, labels });
      for (const label of labels) {
        assert.equal(label.whiteSpace, 'nowrap', `${name}: status is nowrap: ${JSON.stringify(label)}`);
        assert.equal(label.lines, 1, `${name}: one status line: ${JSON.stringify(label)}`);
        assert.equal(label.overflow, false, `${name}: status does not overflow: ${JSON.stringify(label)}`);
        assert.equal(label.inside, true, `${name}: status stays inside signal: ${JSON.stringify(label)}`);
      }
    }
    const resized = [];
    if (noHelper) {
      // Reuse this mounted element through both directions of the row boundary.
      for (const resizedWidth of [1024, width]) {
        await page.setViewport({ width: resizedWidth, height: 1000 });
        await settleEvidenceFrame(page);
        const geometry = await page.evaluate(() => window.bandGeometry());
        assert.equal(geometry.intersection, 0, `${name}: rail/actions box intersection is 0 after resize to ${resizedWidth}`);
        assert.ok(geometry.rail[2] >= 208, `${name}: resized rail keeps its 208px floor`);
        resized.push({ width: resizedWidth, ...geometry });
      }
    } else {
      assert.deepEqual(mounted.band, initial.band, `${name}: band box moves 0 px: ${JSON.stringify(mounted.fit)}`);
      assert.deepEqual(mounted.rail, initial.rail, `${name}: rail box moves 0 px`);
      assert.equal(mounted.row, initial.row, `${name}: rail row stays reserved`);
      for (const frame of mounted.frames) {
        assert.deepEqual(frame.band, initial.band, `${name}: band stays stable through mount`);
        assert.deepEqual(frame.rail, initial.rail, `${name}: rail stays stable through mount`);
      }
      if (!classic && !scene.boundary294) assert.equal(mounted.band[3], width < 600 ? 160 : width <= 1180 ? 150 : 90, `${name}: status-inclusive default host geometry`);
    }
    if (scene.boundary294) assert.equal(mounted.row, width < (classic ? 1273 : 1251) ? '2' : '1', `${name}: measured status reservation switches at the content boundary`);
    if (scene.status294 && width === 1180 && theme === 'light') {
      await page.evaluate(() => {
        const c = document.querySelector('aithema-session'), legal = document.createElement('span');
        legal.slot = 'legal'; legal.innerHTML = '<a href="#privacy">Privacy</a> · <a href="#legal">Legal</a>'; c.append(legal);
      });
      await settleEvidenceFrame(page);
      const footerWidths = await page.evaluate(async () => {
        const c = document.querySelector('aithema-session'), footer = c.shadowRoot.querySelector('.display-foot');
        const row = footer.querySelector('.display-foot__row'), links = c.querySelectorAll('[slot="legal"] a');
        const changes = [], observer = new MutationObserver(records => changes.push(...records));
        observer.observe(footer, { attributes:true, attributeFilter:['data-fit'] });
        const measure = () => {
          const bounds = row.getBoundingClientRect();
          return { windowWidth:innerWidth, width:footer.clientWidth, fit:footer.dataset.fit, refits:changes.length,
            legalInside:[...links].every(link => {
              const b = link.getBoundingClientRect(); return b.width > 0 && b.left >= bounds.left && b.right <= bounds.right;
            }) };
        };
        const states = [measure()];
        for (const width of ['600px', '']) {
          changes.length = 0; footer.style.width = width;
          // ResizeObserver delivers after layout; allow the resulting paint and mutation delivery to settle.
          for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
          states.push(measure());
        }
        observer.disconnect(); return states;
      });
      const [before, narrow, restored] = footerWidths;
      assert.ok(narrow.width < before.width, `${name}: footer container really narrows`);
      for (const state of [narrow, restored]) {
        assert.equal(state.windowWidth, before.windowWidth, `${name}: footer resize keeps innerWidth unchanged`);
        assert.ok(state.refits > 0, `${name}: changed footer width refits: ${JSON.stringify(footerWidths)}`);
        assert.equal(state.legalInside, true, `${name}: legal links stay inside the resized footer: ${JSON.stringify(state)}`);
      }
      assert.notEqual(narrow.fit, before.fit, `${name}: narrowing yields optional footer content`);
      assert.equal(restored.fit, before.fit, `${name}: widening restores optional footer content`);
      checks.push({ head:evidenceCommit, ...scene, footerWidths, pass:true });
      console.log(`AIT-294 PASS ${name}: footer shrinks/restores at fixed innerWidth, refits both ways, legal links inside: ${JSON.stringify(footerWidths)}`);
    }
    checks.push({ head: evidenceCommit, ...scene, initial, mounted, resized, pass: true,
      shiftPx: Math.max(...mounted.band.map((value, i) => Math.abs(value - initial.band[i])),
        ...mounted.rail.map((value, i) => Math.abs(value - initial.rail[i]))),
      shots: capture ? ['first-paint', 'mounted'].map(phase => ({ file: `${name}-${phase}.png`, phase, head: evidenceCommit, theme, locale })) : [] });
    if (noHelper) console.log(`AIT-276 PASS ${name}: mounted and resized rail/actions box intersection 0; 208px rail floor`);
    else console.log(`AIT-276 PASS ${name}: classic=${initial.scrollbar}px; band/rail boxes and row ${mounted.row}, every startup frame 0 px`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true, blurredControls: true,
    fonts: 'Chrome baseline: ui-sans-serif,-apple-system,Segoe UI Variable Text,Segoe UI,system-ui,sans-serif; Georgia,Iowan Old Style,Palatino Linotype,serif',
    passLines: ['PASS: classic scrollbar 15px; 760/768/780/790/800; default 216px and wide 280px actions; voice bound; band/rail boxes and rows 0px on every startup frame',
      'PASS: no-helper 280px actions; 768/780/790 classic and overlay; mounted and resized rail/actions box intersection 0',
      'PASS: default hosts retain existing geometry', 'PASS: 1440/1024/390 light/dark DE/EN; settled viewport captures; pinned fonts; blurred controls'], checks }, null, 2) + '\n');
}
