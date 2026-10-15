import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { evidenceCommit } from './start2-display-helpers.js';

// The production font stack is deliberately unchanged. Evidence uses reduced
// motion and viewport captures, including the held first header frame.
test('AIT-206: fresh en-US → DE, fresh de-AT → DE, and stored en/de choices never paint the wrong language; header moves 0 px', { timeout: 180_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-first-language-'));
  const demo = await startChild(new URL('../../demo/server.js', import.meta.url), join(dir, 'sessions.sqlite'));
  t.after(async () => { await demo.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, passes = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  // Fresh visits follow the host rule (no preference => DE), even on en-US.
  // Stored EN also needs coverage; otherwise a permanently DE label could pass.
  for (const preference of [null, 'en', 'de']) for (const browserLanguage of ['en-US', 'de-AT']) {
    const browser = await browserForFile();
    try {
      for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
        await page.evaluateOnNewDocument(({ preference, browserLanguage }) => {
          Object.defineProperty(navigator, 'language', { get: () => browserLanguage });
          Object.defineProperty(navigator, 'languages', { get: () => [browserLanguage] });
          localStorage.clear();
          if (preference) localStorage.setItem('aithema-demo-locale', preference);
          window.headerFrames = [];
          // Pause the host's awaited locale reconciliation after configure mounts
          // the header, before paintPage resolves the blank label. This exposes
          // that real startup boundary for a viewport capture without missing it.
          const define = customElements.define.bind(customElements);
          customElements.define = (name, constructor, options) => {
            if (name === 'aithema-session') {
              const changeLocale = constructor.prototype.changeLocale;
              constructor.prototype.changeLocale = async function (...args) {
                await changeLocale.apply(this, args);
                if (!window.releaseLanguagePaint) await new Promise(resolve => { window.releaseLanguagePaint = resolve; });
              };
            }
            return define(name, constructor, options);
          };
          window.controlBoxes = () => {
            const root = document.querySelector('aithema-session')?.shadowRoot;
            const nodes = {
              language: document.querySelector('.utility-language'),
              label: document.querySelector('#language-value'),
              chevron: document.querySelector('.utility-language .utility-chevron'),
              globe: document.querySelector('#language-icon'),
              theme: document.querySelector('.utility-theme'),
              settings: root?.querySelector('.header-actions > .settings-open'),
            };
            return Object.fromEntries(Object.entries(nodes).map(([name, node]) => {
              const r = node.getBoundingClientRect();
              return [name, [r.x, r.y, r.width, r.height]];
            }));
          };
          const sample = () => {
            const c = document.querySelector('aithema-session'), label = document.querySelector('#language-value');
            if (c?.shadowRoot?.querySelector('.toolbar')) {
              window.headerFrames.push({ label: label.textContent, language: document.documentElement.lang,
                boxes: window.controlBoxes() });
            } else if (label?.textContent) window.earlyWrongLabel = label.textContent;
            window.headerFrameRequest = requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { preference, browserLanguage });
        await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.headerFrames.length > 0 && window.releaseLanguagePaint);
        const initial = await page.evaluate(() => window.headerFrames[0]);
        assert.equal(initial.label, '', 'first header frame has the reserved blank label');
        for (const [control, box] of Object.entries(initial.boxes)) {
          assert.ok(box[2] > 0 && box[3] > 0, `${control} exists in the first header frame`);
        }
        const name = `${browserLanguage}-browser-${preference ? `stored-${preference}` : 'fresh'}-screen-${preference ?? 'de'}-${theme}-${width}`;
        // The blank state is held unchanged from headerFrames[0]; reduced motion
        // and the production system font stack keep this viewport reproducible.
        await page.evaluate(async () => { await document.fonts.ready; });
        assert.deepEqual(await page.evaluate(() => window.controlBoxes()), initial.boxes, 'shot is the first header frame geometry');
        if (evidence && browserLanguage === 'en-US' && preference === null && ((width === 390 && theme === 'light') || (width === 1440 && theme === 'dark'))) {
          await page.screenshot({ path: join(evidence, `${name}-first-header-frame-blank.png`), fullPage: false, captureBeyondViewport: false });
        }
        await page.evaluate(() => window.releaseLanguagePaint());
        await page.waitForFunction(() => document.querySelector('aithema-session')?.session && document.querySelector('#language-value').textContent);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const c = document.querySelector('aithema-session');
          await Promise.all([...document.getAnimations(), ...c.shadowRoot.getAnimations({ subtree: true })]
            .filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
        });
        const result = await page.evaluate(() => {
          cancelAnimationFrame(window.headerFrameRequest);
          return { frames: window.headerFrames, early: window.earlyWrongLabel, language: document.documentElement.lang,
            label: document.querySelector('#language-value').textContent, locale: document.querySelector('#locale').value,
            boxes: window.controlBoxes(), session: document.querySelector('aithema-session').session.locale };
        });
        assert.equal(result.early, undefined);
        assert.equal(result.language, preference ?? 'de');
        assert.equal(result.label, result.language.toUpperCase());
        assert.equal(result.locale, result.session);
        assert.ok(result.frames.length > 0);
        assert.deepEqual(initial.boxes, result.boxes, 'first header frame and loaded boxes are identical (0 px)');
        for (const frame of result.frames) {
          assert.ok(frame.label === '' || frame.label === frame.language.toUpperCase(), 'every rendered frame names the screen or stays blank');
          assert.deepEqual(frame.boxes, result.boxes, 'visible header controls move exactly 0 px from their first frame');
        }
        if (evidence) await page.screenshot({ path: join(evidence, `${name}-loaded.png`), fullPage: false, captureBeyondViewport: false });
        const pass = `AIT-206 PASS head=${evidenceCommit} ${name}: first paint blank/reserved; loaded ${result.label}=${result.session}; first-header-to-loaded displacement 0 px; boxes=${JSON.stringify(result.boxes)}`;
        passes.push(pass); console.log(pass);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  const browser = await browserForFile();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/demo/host.js') void request.abort('failed');
      else void request.continue();
    });
    await page.goto(demo.url, { waitUntil: 'networkidle0' });
    for (const selector of ['.utility-language', '.utility-theme', '#language-icon svg', '.utility-language .utility-chevron svg']) {
      assert.equal(await page.$eval(selector, n => {
        const r = n.getBoundingClientRect(), style = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility === 'visible' && style.display !== 'none';
      }), true, `${selector} remains visible with host.js blocked`);
    }
    // Keyboard focus and native selection work without the host module.
    await page.focus('#locale');
    await page.keyboard.press('e');
    await page.keyboard.press('Enter');
    await page.select('#locale', 'en');
    assert.equal(await page.$eval('#locale', n => n.value), 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('aithema-demo-locale')), 'en');
    await page.select('#theme', 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('aithema-theme')), 'dark');
    await page.select('#theme', 'light');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await page.$eval('#language-value', n => n.textContent), '');
    const pass = `AIT-206 PASS head=${evidenceCommit} host.js BLOCKED: language/globe/chevron/theme visible; native selects usable; EN preference stored; dark/light applied; label stays blank`;
    passes.push(pass); console.log(pass);
    await page.close();
  } finally { await browser.close(); }
  if (evidence) await writeFile(join(evidence, 'pass-lines.txt'), passes.join('\n') + '\n');
});
