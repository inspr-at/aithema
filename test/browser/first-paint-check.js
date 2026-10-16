import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';

export async function firstPaintCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-first-paint-'));
  const demo = await startChild(new URL('../../demo/server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, results = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.setRequestInterception(true);
  let releaseModule;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/demo/host.js') releaseModule = () => request.continue();
    else void request.continue();
  });
  // One page and browser for all twelve states; no artificial startup sleeps.
  await page.evaluateOnNewDocument(() => {
    const state = new URLSearchParams(location.search);
    localStorage.clear();
    localStorage.setItem('aithema-demo-locale', state.get('locale'));
    localStorage.setItem('aithema-theme', state.get('theme'));
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
  for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    releaseModule = undefined;
    const navigation = page.goto(`${demo.url}?theme=${theme}&locale=${locale}`, { waitUntil: 'domcontentloaded' });
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
    assert.ok(releaseModule, 'host module request held');
    await releaseModule();
    await navigation;
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
    console.log(`AIT-210 ${name}: header, rail and controls 0 px; no unstyled title`);
  }
}
