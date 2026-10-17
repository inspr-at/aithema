import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { evidenceBrowserArgs, evidenceCommit } from './start2-display-helpers.js';

export async function firstPaintCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-first-paint-'));
  const demo = await startChild(new URL('../../demo/server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const browser = await browserForFile(process.env.AITHEMA_EVIDENCE_DIR ? { args: evidenceBrowserArgs } : {});
  let textDemo;
  t.after(async () => { await browser.close(); await demo.kill(); await textDemo?.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, results = [], checks = [];
  const fitWidths = [600, 640, 680, 720, 760, 767, 768];
  if (evidence) await mkdir(join(evidence, 'first-paint'), { recursive: true });
  let failureMode = null;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/demo/host.js' && !url.search && failureMode) {
      const body = failureMode === 'undefined' ? '' : `
        import { AithemaSession } from '/packages/ui/src/session-element.js';
        AithemaSession.prototype.configure = () => { throw new Error('AIT-210 forced mount failure'); };
        await import('/demo/host.js?forced-mount-failure');`;
      void request.respond({ status: 200, contentType: 'application/javascript', body });
    }
    else if (url.pathname === '/demo/host.js' && !url.search) void request.respond({ status: 200, contentType: 'application/javascript',
      body: "window.releaseAithema = () => import('/demo/host.js?ait-210-upgrade');" });
    else void request.continue();
  });
  // Defer the real host import until after a painted frame. A pending module
  // network request can itself defer Chrome paint, so a tiny bootstrap owns it.
  // Reuse one page/browser; boundary widths add only the default DE/light state.
  await page.evaluateOnNewDocument(() => {
    const state = new URLSearchParams(location.search);
    localStorage.clear();
    localStorage.setItem('aithema-demo-locale', state.get('locale'));
    localStorage.setItem('aithema-theme', state.get('theme'));
    // Exercise the real definition deadline without adding 15 seconds to CI.
    if (state.get('failure') === 'undefined') {
      const schedule = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 15_000) { window.fireDefinitionDeadline = callback; return 0; }
        return schedule(callback, delay, ...args);
      };
    }
    window.paintFrames = [];
    window.paintGeometry = () => {
      const component = document.querySelector('aithema-session');
      const mounted = component?.shadowRoot?.querySelector('.band');
      const root = mounted ? component.shadowRoot : document;
      const names = mounted ? ['.band', '.audio-rail', '.voice-output', '.voice-cell--pause', '.voice-input', '.voice-close']
        : ['.aithema-first-paint', '.aithema-first-paint .audio-rail', '[data-placeholder="output"]', '[data-placeholder="pause"]', '[data-placeholder="input"]', '[data-placeholder="close"]'];
      return names.map(selector => {
        const node = root.querySelector(selector), box = node?.getBoundingClientRect();
        return box ? [box.x, box.y, box.width, box.height] : null;
      });
    };
    const sample = () => {
      if (document.querySelector('aithema-session')) window.paintFrames.push(window.paintGeometry());
      window.paintRequest = requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const settle = async () => {
    await page.mouse.move(-1, -1);
    await page.evaluate(async () => {
      document.activeElement?.blur();
      document.querySelector('aithema-session')?.shadowRoot?.activeElement?.blur();
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  const cases = [1440, 1024, 390].flatMap(width => ['light', 'dark'].flatMap(theme => ['de', 'en'].map(locale => ({ width, theme, locale }))));
  cases.push(...fitWidths.map(width => ({ width, theme: 'light', locale: 'de' })));
  for (const { width, theme, locale } of cases) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    await page.goto(`${demo.url}?theme=${theme}&locale=${locale}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.paintFrames?.length >= 2);
    const initial = await page.evaluate(() => ({ defined: Boolean(customElements.get('aithema-session')), boxes: window.paintGeometry(),
      titleVisible: (() => {
        const n = document.querySelector('.wordmark'), r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return s.visibility === 'visible' && r.width > 1 && r.height > 1;
      })() }));
    assert.equal(initial.defined, false, 'first paint precedes the custom-element upgrade');
    const name = `${width}-${theme}-${locale}`;
    await settle();
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-first-paint.png`), fullPage: false, captureBeyondViewport: false });
    await page.evaluate(() => { void window.releaseAithema(); });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready'));
    await settle();
    const loaded = await page.evaluate(() => {
      cancelAnimationFrame(window.paintRequest);
      return { boxes: window.paintGeometry(), frames: window.paintFrames, locale: document.querySelector('aithema-session').session.locale };
    });
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-loaded.png`), fullPage: false, captureBeyondViewport: false });
    results.push({ name, initial, loaded });
    if (evidence) await writeFile(join(evidence, 'first-paint-geometry.json'), JSON.stringify(results, null, 2) + '\n');
    assert.equal(initial.titleVisible, false, `${name}: no unstyled host wordmark at first paint`);
    assert.ok(initial.boxes.every(Boolean), `${name}: header, rail and four control boxes reserved before upgrade`);
    assert.equal(loaded.locale, locale);
    assert.deepEqual(initial.boxes, loaded.boxes, `${name}: first paint → loaded geometry moves 0 px`);
    for (const frame of loaded.frames) assert.deepEqual(frame, loaded.boxes, `${name}: every startup frame moves 0 px`);
    // Hosts can detach/reinsert the element (the question-card fixture does so
    // during keyboard recovery). Readiness must survive a new sibling order.
    await page.evaluate(() => { const c = document.querySelector('aithema-session'); c.parentElement.append(c); });
    await settle();
    assert.deepEqual(await page.evaluate(() => window.paintGeometry()), loaded.boxes, `${name}: reattachment never restores the loading shell`);
    checks.push({ pass: true, name, voice: true, shiftPx: 0, everyFrameStable: true, initial: initial.boxes, mounted: loaded.boxes });
    console.log(`AIT-210 ${name}: header, rail and controls 0 px; no unstyled title; reattachment stable`);
  }
  // AIT-260: a voice-off host must not paint voice placeholders or shrink a
  // phone header on upgrade. Reuse this page/browser for the binding check.
  textDemo = await startChild(new URL('../../demo/server.js', import.meta.url), join(directory, 'text-sessions.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_ADMIN_SOCKET: join(directory, 'off') });
  for (const width of [1440, 1024, 390, ...fitWidths]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${textDemo.url}?theme=light&locale=de`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.paintFrames?.length >= 2);
    const initial = await page.evaluate(() => window.paintGeometry());
    assert.equal(initial[0][3], width < 600 ? 68 : 90);
    assert.ok(initial.slice(1).every(box => box === null), 'no voice placeholders before upgrade');
    await page.evaluate(() => { void window.releaseAithema(); });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready'));
    await settle();
    const loaded = await page.evaluate(() => { cancelAnimationFrame(window.paintRequest); return { boxes: window.paintGeometry(), frames: window.paintFrames }; });
    assert.deepEqual(loaded.boxes, initial, `${width}/voice-off: first paint → mounted moves 0 px`);
    for (const frame of loaded.frames) assert.deepEqual(frame, initial, `${width}/voice-off: every startup frame moves 0 px`);
    checks.push({ pass: true, name: `${width}-light-de-voice-off`, voice: false, shiftPx: 0, everyFrameStable: true, initial, mounted: loaded.boxes });
    console.log(`AIT-260 ${width}/voice-off: no placeholders; header upgrade 0 px`);
  }
  if (evidence) await writeFile(join(evidence, 'first-paint', 'checks.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true, blurredControls: true, passLines: ['PASS: voice and no-voice first paint/mounted geometry 0 px at 600/640/680/720/760/767/768; every startup frame stable', 'PASS: desktop/phone DE/EN light/dark startup geometry retained'], checks }, null, 2) + '\n');
  // Reuse this page and browser; failures add no browser process or test file.
  for (const failure of ['mount', 'undefined']) for (const locale of ['de', 'en']) {
    failureMode = failure;
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(`${demo.url}?theme=light&locale=${locale}&failure=${failure}`, { waitUntil: 'domcontentloaded' });
    if (failure === 'undefined') await page.evaluate(() => window.fireDefinitionDeadline());
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-unavailable'));
    const fallback = await page.evaluate(() => {
      const title = document.querySelector('h1'), error = document.querySelector('#error'), button = error.querySelector('button');
      return { title: title.textContent, titleVisible: title.checkVisibility(),
        skeleton: Boolean(document.querySelector('.aithema-first-paint')),
        alert: error.getAttribute('role'), message: error.querySelector('span')?.textContent,
        button: button?.textContent, buttonVisible: button?.checkVisibility(), type: button?.type,
        defined: Boolean(customElements.get('aithema-session')) };
    });
    assert.deepEqual(fallback, { title: 'Aithema', titleVisible: true, skeleton: false, alert: 'alert',
      message: locale === 'de' ? 'Die Seite konnte nicht geladen werden.' : 'The page could not be loaded.',
      button: locale === 'de' ? 'Seite neu laden' : 'Reload page', buttonVisible: true, type: 'button', defined: failure === 'mount' });
    await settle();
    if (evidence && failure === 'mount' && locale === 'de') await page.screenshot({
      path: join(evidence, 'mount-failure-390-de-light.png'), fullPage: false, captureBeyondViewport: false });
    // The native fallback changes language without depending on the failed graph.
    await page.select('#locale', locale === 'de' ? 'en' : 'de');
    assert.equal(await page.$eval('#error button', n => n.textContent), locale === 'de' ? 'Reload page' : 'Seite neu laden');
    // A real button reload must navigate and allow a working host to mount.
    failureMode = null;
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#error button')]);
    await page.evaluate(() => { void window.releaseAithema(); });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready'));
    assert.equal(await page.$eval('#error', n => n.textContent), '');
    assert.equal(await page.$eval('h1', n => n.parentElement.localName), 'aithema-session');
    console.log(`AIT-210 ${failure} ${locale}: visible title, no skeleton, localized alert, reload recovers`);
  }
}
