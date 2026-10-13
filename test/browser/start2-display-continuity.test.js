// AIT-138 d: real tab takeover, wake and durable restart recovery. Remote browser runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { mockConsent } from './consent-helpers.js';
import { browserPath, shadow, until, settle, layoutBoxes, sameBoxes, finishRevealEntry, evidenceCommit } from './start2-display-helpers.js';

test('AIT-138 d: tab takeover, wake waiting and actual restart recovery viewport evidence', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-continuity-'));
  const db = join(directory, 'session.sqlite');
  const settings = { AITHEMA_VOICE_MODE: 'fake', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit };
  let demo = await startChild(new URL('../fixtures/continuity-server.js', import.meta.url), db, settings);
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [], errors = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const state = (page, expected) => until(page, expected => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.audio-rail')?.dataset.state === expected, expected);
  const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
  const selectors = ['.band', '.audio-rail', '.voice-notices', '.concept-bar', '.transcript-shell', '.composer-dock'];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
    let complete = false;
    await t.test(`${width} ${theme} ${locale}`, async st => {
      const runBrowser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
        userDataDir: join(directory, `chrome-${width}-${theme}-${locale}`), env: { PATH: process.env.PATH, HOME: homedir() },
        args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
      browser = runBrowser;
      const context = runBrowser.defaultBrowserContext(), page = await context.newPage();
      let other;
      st.after(async () => {
        if (!complete) {
          const inspect = target => target?.evaluate(() => { const c = document.querySelector('aithema-session'); return {
            session: c?.session?.id, voice: c?.session?.voiceLifecycle, state: c?.shadowRoot?.querySelector('.audio-rail')?.dataset.state,
            message: c?.shadowRoot?.querySelector('.voice-state')?.textContent, resumeDisabled: c?.shadowRoot?.querySelector('.pause')?.disabled,
            journal: c?.session?.id && JSON.parse(sessionStorage.getItem(`aithema-voice-call:${c.session.id}`)),
            errors: document.querySelector('#error')?.textContent }; }).catch(() => null);
          st.diagnostic(JSON.stringify({ original: await inspect(page), newcomer: await inspect(other), errors }));
        }
        await runBrowser.close();
      });
      page.on('pageerror', error => errors.push(error.stack ?? error.message));
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.evaluateOnNewDocument(locale => {
        localStorage.setItem('aithema-locale', locale); localStorage.setItem('aithema-motion', 'off');
      }, locale);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      await page.select('#locale', locale); await page.select('#theme', theme); await mockConsent(page);
      st?.diagnostic('Loaded conversation and consent');
      await click(page, '.chooser__continue');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'ready');
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.voice-start').disabled);
      await click(page, '.ready__mode[data-mode="voice"]'); await click(page, '.ready__start');
      await until(page, () => ['speaking', 'listening'].includes(document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state));
      await until(page, () => { const w = document.querySelector('aithema-session').shadowRoot.querySelector('.workspace');
        return w.dataset.stage === 'live' && !w.hasAttribute('data-reveal'); });
      await finishRevealEntry(page);
      await page.evaluate(async () => { await document.fonts.ready; }); await settle();
      st?.diagnostic('Started original call');
      const label = `${width}-${theme}-${locale}`, before = await layoutBoxes(page, selectors);
      const call = await page.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
      other = await context.newPage(); other.on('pageerror', error => errors.push(error.stack ?? error.message));
      await other.setViewport({ width, height: width === 390 ? 844 : 900 });
      await other.goto(demo.url, { waitUntil: 'domcontentloaded' }); await state(other, 'waiting');
      st?.diagnostic('Newcomer offers takeover');
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('.pause').textContent.trim()), { de, en }[locale].voiceTakeover);
      await click(other, '.pause'); await until(other, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.pause').textContent.includes('übernehmen') &&
        !document.querySelector('aithema-session').shadowRoot.querySelector('.pause').textContent.includes('Take over'));
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('.audio-rail').dataset.state), 'waiting', 'takeover has no automatic capture');
      await state(page, 'waiting'); await page.bringToFront(); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), { de, en }[locale].voiceMoved);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').disabled), true);
      sameBoxes(before, await layoutBoxes(page, selectors), `${label}: old-tab notice`);
      const shot = async (target, name) => {
        // The rail helper only waits for the band; also settle the workspace entrance.
        await shadow(target, async c => {
          await document.fonts.ready;
          await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true })
            .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const composer = await shadow(target, c => {
          const root = c.shadowRoot, form = root.querySelector('.composer'), rect = form.getBoundingClientRect();
          const footer = root.querySelector('.display-foot').getBoundingClientRect();
          const points = [.1, .5, .9].flatMap(x => [.1, .5, .9].map(y => {
            const px = rect.left + rect.width * x, py = rect.top + rect.height * y;
            return { x: px, y: py, visible: form.contains(root.elementFromPoint(px, py)) };
          }));
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, footerTop: footer.top,
            fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth &&
              rect.top >= 0 && rect.bottom <= footer.top && points.every(point => point.visible), points,
            workspaceReveal: root.querySelector('.workspace').hasAttribute('data-reveal') };
        });
        const file = `ait-138-d-${name}-${label}.png`; files.push(file);
        if (evidence) {
          await target.screenshot({ path: join(evidence, file), fullPage: false });
          await writeFile(join(evidence, `${file}.json`), JSON.stringify({ name, width, theme, locale, composer }, null, 2));
        }
        st.diagnostic(`${name} composer: ${JSON.stringify(composer)}`);
        if (width >= 960) assert.ok(composer.fullyVisible, `${label}/${name}: settled composer must be fully visible`);
      };
      await shot(page, 'old-tab');
      st?.diagnostic('Captured old-tab notice');
      await other.bringToFront(); await click(other, '.pause'); await state(other, 'listening');
      await until(other, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').hasAttribute('data-reveal'));
      await finishRevealEntry(other);
      const next = await other.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
      assert.equal(next.callId, call.callId); assert.equal(next.epoch, call.epoch + 1);
      const heldBefore = await layoutBoxes(other, selectors);
      await other.evaluate(() => { document.dispatchEvent(new Event('freeze')); document.dispatchEvent(new Event('resume')); });
      await state(other, 'waiting'); await settle();
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('textarea').placeholder), { de, en }[locale].placeholder);
      sameBoxes(heldBefore, await layoutBoxes(other, selectors), `${label}: wake waiting`); await shot(other, 'wake-waiting');
      st?.diagnostic('Captured wake waiting');
      await click(other, '.pause'); await state(other, 'listening');
      const restarted = await other.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
      const port = new URL(demo.url).port;
      await demo.kill('SIGKILL'); demo = await startChild(new URL('../fixtures/continuity-server.js', import.meta.url), db, { ...settings, PORT: port });
      await state(other, 'waiting');
      await until(other, () => document.querySelector('aithema-session').session.featureMatrix.best.voice.available);
      await click(other, '.pause'); await state(other, 'listening');
      await until(other, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-notice--recovered').textContent);
      const restored = await other.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
      assert.equal(restored.callId, restarted.callId); assert.notEqual(restored.providerSessionId, restarted.providerSessionId);
      await settle(); sameBoxes(heldBefore, await layoutBoxes(other, selectors), `${label}: restart recovered`); await shot(other, 'restart-recovered');
      st?.diagnostic('Captured recovery after SIGKILL/reload');
      checks.push({ width, theme, locale, callIdPreserved: true, epochAdvanced: true, captureRequiresResume: true,
        restart: 'SIGKILL and durable SQLite reload', layoutShiftPx: 0, pass: true });
      await click(other, '.voice-close'); await state(other, 'idle'); complete = true;
    });
    if (!complete) throw new Error(`Continuity matrix stopped at ${width}/${theme}/${locale}; see the failing step`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait-138-d-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138 d', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', provider: 'local fake; actual server and browser controller', files, checks }, null, 2));
});
