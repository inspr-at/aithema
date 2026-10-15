import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { evidenceCommit } from './start2-display-helpers.js';

// The production font stack is deliberately unchanged. Evidence uses reduced
// motion and viewport captures, including the network-delayed first paint.
test('AIT-206: fresh EN/DE browsers and stored choices never paint the wrong language; header moves 0 px', { timeout: 180_000 }, async t => {
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
          const sample = () => {
            const c = document.querySelector('aithema-session'), label = document.querySelector('#language-value');
            if (c?.shadowRoot?.querySelector('.toolbar')) {
              const controls = [...document.querySelectorAll('.host-actions label'), ...c.shadowRoot.querySelectorAll('.header-actions > .settings-open')];
              window.headerFrames.push({ label: label.textContent, language: document.documentElement.lang,
                boxes: controls.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }) });
            } else if (label?.textContent) window.earlyWrongLabel = label.textContent;
            window.headerFrameRequest = requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { preference, browserLanguage });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/demo/host.js') void held.then(() => request.continue());
          else void request.continue();
        });
        const navigation = page.goto(demo.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#language-value', { visible: false });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const initial = await page.$eval('#language-value', n => ({ label: n.textContent, width: n.getBoundingClientRect().width }));
        assert.equal(initial.label, '', 'unknown language is blank even while the host module is delayed');
        assert.ok(initial.width > 0, 'blank language box is reserved');
        const name = `${browserLanguage}-${preference ?? 'fresh'}-${theme}-${width}`;
        if (evidence) await page.screenshot({ path: join(evidence, `${name}-first-paint.png`), fullPage: false, captureBeyondViewport: false });
        release();
        await navigation;
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
            session: document.querySelector('aithema-session').session.locale };
        });
        assert.equal(result.early, undefined);
        assert.equal(result.language, preference ?? 'de');
        assert.equal(result.label, result.language.toUpperCase());
        assert.equal(result.locale, result.session);
        assert.ok(result.frames.length > 0);
        for (const frame of result.frames) {
          assert.ok(frame.label === '' || frame.label === frame.language.toUpperCase(), 'every rendered frame names the screen or stays blank');
          assert.deepEqual(frame.boxes, result.frames.at(-1).boxes, 'visible header controls move exactly 0 px from their first frame');
        }
        if (evidence) await page.screenshot({ path: join(evidence, `${name}-loaded.png`), fullPage: false, captureBeyondViewport: false });
        const pass = `AIT-206 PASS head=${evidenceCommit} ${name}: first paint blank/reserved; loaded ${result.label}=${result.session}; header utility row displacement 0 px`;
        passes.push(pass); console.log(pass);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  if (evidence) await writeFile(join(evidence, 'pass-lines.txt'), passes.join('\n') + '\n');
});
