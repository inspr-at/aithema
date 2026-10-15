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
test('AIT-206: fresh en-US → DE, fresh de-AT → DE, and stored en/de choices never paint the wrong language; stored light/dark/system and all painted utility frames move 0 px', { timeout: 180_000 }, async t => {
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
      for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) for (const storedTheme of ['light', 'dark', 'system']) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
        // Hold the module request so the sampler necessarily observes pre-header
        // paint opportunities, rather than relying on a fast localhost race.
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/demo/host.js') setTimeout(() => void request.continue(), 120);
          else void request.continue();
        });
        await page.evaluateOnNewDocument(({ preference, browserLanguage, storedTheme }) => {
          Object.defineProperty(navigator, 'language', { get: () => browserLanguage });
          Object.defineProperty(navigator, 'languages', { get: () => [browserLanguage] });
          localStorage.clear();
          localStorage.setItem('aithema-theme', storedTheme);
          if (preference) localStorage.setItem('aithema-demo-locale', preference);
          window.headerFrames = [];
          window.preHeaderFrames = [];
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
              themeLabel: document.querySelector('#theme-value'),
              themeIcon: document.querySelector('#theme-icon'),
              settings: root?.querySelector('.header-actions > .settings-open'),
            };
            return Object.fromEntries(Object.entries(nodes).map(([name, node]) => {
              if (!node) return [name, null];
              const r = node.getBoundingClientRect();
              return [name, [r.x, r.y, r.width, r.height]];
            }));
          };
          const sample = () => {
            const c = document.querySelector('aithema-session'), label = document.querySelector('#language-value');
            if (c?.shadowRoot?.querySelector('.toolbar')) {
              window.headerFrames.push({ label: label.textContent, language: document.documentElement.lang,
                boxes: window.controlBoxes(), theme: document.querySelector('#theme').value,
                themeLabel: document.querySelector('#theme-value').textContent, themeIcon: document.querySelector('#theme-icon').innerHTML });
            } else {
              if (label?.textContent) window.earlyWrongLabel = label.textContent;
              const utilities = [...document.querySelectorAll('.host-actions .utility')];
              window.preHeaderFrames.push({ time: performance.now(), painted: utilities.some(node => {
                const r = node.getBoundingClientRect(), style = getComputedStyle(node);
                return r.width > 0 && r.height > 0 && style.visibility === 'visible' && style.display !== 'none';
              }), boxes: utilities.length ? window.controlBoxes() : null });
            }
            window.headerFrameRequest = requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { preference, browserLanguage, storedTheme });
        await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.headerFrames.length > 0 && window.releaseLanguagePaint);
        const initial = await page.evaluate(() => window.headerFrames[0]);
        assert.equal(initial.theme, storedTheme);
        assert.equal(initial.themeLabel, '', 'theme label is blank until the screen language resolves');
        assert.equal(initial.label, '', 'first header frame has the reserved blank label');
        for (const [control, box] of Object.entries(initial.boxes)) {
          assert.ok(box[2] > 0 && box[3] > 0, `${control} exists in the first header frame`);
        }
        const name = `${browserLanguage}-browser-${preference ? `stored-${preference}` : 'fresh'}-screen-${preference ?? 'de'}-os-${theme}-stored-theme-${storedTheme}-${width}`;
        // The blank state is held unchanged from headerFrames[0]; reduced motion
        // and the production system font stack keep this viewport reproducible.
        await page.evaluate(async () => { await document.fonts.ready; });
        assert.deepEqual(await page.evaluate(() => window.controlBoxes()), initial.boxes, 'shot is the first header frame geometry');
        if (evidence && browserLanguage === 'en-US' && theme === 'light' && ((preference === 'de' && width === 390 && storedTheme === 'dark') || (preference === 'en' && width === 1440 && storedTheme === 'light'))) {
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
          return { preHeaderFrames: window.preHeaderFrames, firstPaint: performance.getEntriesByName('first-paint')[0]?.startTime, theme: document.querySelector('#theme').value, themeLabel: document.querySelector('#theme-value').textContent, themeIcon: document.querySelector('#theme-icon').innerHTML, frames: window.headerFrames, early: window.earlyWrongLabel, language: document.documentElement.lang,
            label: document.querySelector('#language-value').textContent, locale: document.querySelector('#locale').value,
            boxes: window.controlBoxes(), session: document.querySelector('aithema-session').session.locale };
        });
        assert.equal(result.early, undefined);
        assert.equal(result.theme, storedTheme);
        const themeLabels = { de: { light: 'Hell', dark: 'Dunkel', system: 'System' }, en: { light: 'Light', dark: 'Dark', system: 'System' } };
        assert.equal(result.themeLabel, themeLabels[result.language][storedTheme]);
        assert.ok(result.preHeaderFrames.some(frame => frame.time >= result.firstPaint), 'sampled pre-header painted frames');
        assert.ok(result.preHeaderFrames.every(frame => !frame.painted), 'utilities never paint before the header exists');
        assert.equal(result.language, preference ?? 'de');
        assert.equal(result.label, result.language.toUpperCase());
        assert.equal(result.locale, result.session);
        assert.ok(result.frames.length > 0);
        assert.deepEqual(initial.boxes, result.boxes, 'first header frame and loaded boxes are identical (0 px)');
        for (const frame of result.frames) {
          assert.equal(frame.theme, storedTheme);
          assert.equal(frame.themeIcon, result.themeIcon, 'stored theme icon correct in every header frame');
          assert.ok(frame.themeLabel === '' || frame.themeLabel === result.themeLabel, 'theme label is blank or in screen language');
          assert.ok(frame.label === '' || frame.label === frame.language.toUpperCase(), 'every rendered frame names the screen or stays blank');
          assert.deepEqual(frame.boxes, result.boxes, 'visible header controls move exactly 0 px from their first frame');
        }
        if (evidence && theme === 'light' && ((preference === 'de' && width === 390 && storedTheme === 'dark') || (preference === 'en' && width === 1440 && storedTheme === 'light'))) await page.screenshot({ path: join(evidence, `${name}-loaded.png`), fullPage: false, captureBeyondViewport: false });
        const pass = `AIT-206 PASS head=${evidenceCommit} ${name}: first paint blank/reserved; loaded ${result.label}=${result.session}; pre-header frames=${result.preHeaderFrames.length} (utilities unpainted); first-header-to-loaded displacement 0 px; stored theme=${result.theme}/${result.themeLabel}, icon stable; boxes=${JSON.stringify(result.boxes)}`;
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
