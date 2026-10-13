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
      await click(other, '.pause'); await until(other, resume => document.querySelector('aithema-session').shadowRoot.querySelector('.pause').textContent.trim() === resume, { de, en }[locale].resume);
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('.audio-rail').dataset.state), 'waiting', 'takeover has no automatic capture');
      await state(page, 'waiting'); await page.bringToFront(); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), { de, en }[locale].voiceMoved);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').disabled), true);
      sameBoxes(before, await layoutBoxes(page, selectors), `${label}: old-tab notice`);
      const shot = async (target, name) => {
        const scrollBefore = await target.evaluate(() => scrollY);
        // The rail helper only waits for the band; also settle the workspace entrance.
        await shadow(target, async c => {
          await document.fonts.ready;
          await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true })
            .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        // Phones retain their scrollable conversation. Include the composer below the sticky band.
        if (width < 960) await shadow(target, c => {
          const root = c.shadowRoot, form = root.querySelector('.composer').getBoundingClientRect();
          const footer = root.querySelector('.display-foot').getBoundingClientRect();
          window.scrollBy(0, Math.max(0, form.bottom - footer.top + 16));
        });
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
            workspaceReveal: root.querySelector('.workspace').hasAttribute('data-reveal'), scrollY };
        });
        const presentation = await shadow(target, c => {
          const root = c.shadowRoot, rail = root.querySelector('.audio-rail'), label = root.querySelector('.voice-state');
          const signalBox = root.querySelector('.voice-signal').getBoundingClientRect(), labelBox = label.getBoundingClientRect();
          const railBox = rail.getBoundingClientRect(), railStyle = getComputedStyle(rail), labelStyle = getComputedStyle(label);
          const pause = root.querySelector('.pause'), pauseStyle = getComputedStyle(pause);
          const footer = root.querySelector('.display-foot').getBoundingClientRect(), status = root.querySelector('.status__label');
          const statusStyle = getComputedStyle(status), statusBox = status.getBoundingClientRect();
          const text = document.createRange(); text.selectNodeContents(status); const textBox = text.getBoundingClientRect();
          const footerBoxes = ['.ai-notice', '.host-credits', '.footer-right'].map(s => root.querySelector(s).getBoundingClientRect());
          const compactFooter = statusStyle.display === 'none';
          return {
            label: label.textContent, railState: rail.dataset.state,
            labelInRailCentre: Math.abs(labelBox.left + labelBox.width / 2 - signalBox.left - signalBox.width / 2) <= 1 &&
              labelBox.top >= railBox.top && labelBox.bottom <= railBox.bottom && labelStyle.opacity === '1',
            noPopover: !rail.hasAttribute('data-message') && labelStyle.position !== 'absolute' && labelStyle.boxShadow === 'none',
            noRailRing: (railStyle.outlineStyle === 'none' || parseFloat(railStyle.outlineWidth) === 0) && railStyle.boxShadow === 'none' &&
              ['Top', 'Right', 'Bottom', 'Left'].every(side => parseFloat(railStyle[`border${side}Width`]) === 0),
            enabledResumeStyle: pauseStyle.opacity === '1' && pauseStyle.backgroundColor === getComputedStyle(root.querySelector('.voice-pause')).backgroundColor &&
              pauseStyle.color === getComputedStyle(root.querySelector('.voice-pause')).color,
            resumeLabel: pause.textContent.trim(), resumeTooltip: pause.title, resumeDisabled: pause.disabled,
            footerUntruncated: footerBoxes.every(box => box.left >= 0 && box.right <= innerWidth && box.top >= footer.top && box.bottom <= footer.bottom) &&
              (compactFooter || textBox.width <= statusBox.width + .5 && status.scrollWidth <= status.clientWidth && statusBox.right <= innerWidth),
            footerLabel: status.textContent, compactFooter,
          };
        });
        for (const key of ['labelInRailCentre', 'noPopover', 'noRailRing', 'enabledResumeStyle', 'footerUntruncated']) {
          assert.ok(presentation[key], `${label}/${name}: ${key}: ${JSON.stringify(presentation)}`);
        }
        assert.ok(composer.fullyVisible, `${label}/${name}: settled composer must be fully visible: ${JSON.stringify(composer)}`);
        if (name === 'old-tab') {
          const copy = { de, en }[locale];
          assert.equal(presentation.label, copy.voiceMoved); assert.equal(presentation.resumeLabel, copy.voiceTakeover);
          assert.equal(presentation.resumeTooltip, copy.voiceTakeover); assert.equal(presentation.footerLabel, copy.voiceInAnotherTab);
          const oldTab = await shadow(target, c => ({
            composerHint: c.shadowRoot.querySelector('.composer-reason').textContent,
            panelStatus: c.shadowRoot.querySelector('.notice').textContent,
            mic: c.shadowRoot.querySelector('.voice-input').title, speaker: c.shadowRoot.querySelector('.voice-output').title,
          }));
          assert.deepEqual(oldTab, { composerHint: copy.voiceInAnotherTab, panelStatus: copy.voiceInAnotherTab,
            mic: copy.voiceResumeHereFirst, speaker: copy.voiceResumeHereFirst });
        }
        checks.push({ width, theme, locale, state: name, ...presentation, composerFullyVisible: composer.fullyVisible,
          composer, pass: true });
        const file = `ait-138-d-${name}-${label}.png`; files.push(file);
        if (evidence) {
          await target.screenshot({ path: join(evidence, file), fullPage: false });
          await writeFile(join(evidence, `${file}.json`), JSON.stringify({ name, width, theme, locale, composer, presentation }, null, 2));
          if (evidence.includes('paint-probe') && locale === 'de' && theme === 'light' && width >= 960) {
            const paint = await shadow(target, c => {
              const nodes = []; for (let n = c.shadowRoot.querySelector('.composer'); n; n = n.parentElement) {
                const s = getComputedStyle(n); nodes.push({ class: n.className, opacity: s.opacity, visibility: s.visibility,
                  transform: s.transform, clipPath: s.clipPath, maskImage: s.maskImage, overflow: s.overflow,
                  backdropFilter: s.backdropFilter, filter: s.filter });
              }
              return { nodes, animations: c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true }).map(a => ({
                target: a.effect.target.className, state: a.playState, timing: a.effect.getComputedTiming() })) };
            });
            await writeFile(join(evidence, `${file}.paint.json`), JSON.stringify(paint, null, 2));
            await target.screenshot({ path: join(evidence, `surface-false-${file}`), fullPage: false, fromSurface: false });
            await new Promise(resolve => setTimeout(resolve, 1200));
            await target.screenshot({ path: join(evidence, `delayed-${file}`), fullPage: false });
          }
        }
        // Compare state transitions at the same scroll offset; sticky offsets follow capture scrolling.
        await target.evaluate(top => { window.scrollTo(0, top); }, scrollBefore);
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
      await shot(other, 'restart-before-resume');
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('.audio-rail').dataset.state), 'waiting', 'restart waits for explicit Resume');
      assert.equal(await shadow(other, c => c.shadowRoot.querySelector('.voice-input').disabled), true);
      st?.diagnostic('Captured restart before Resume');
      await click(other, '.pause'); await state(other, 'listening');
      await until(other, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-notice--recovered').textContent);
      const restored = await other.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
      assert.equal(restored.callId, restarted.callId); assert.notEqual(restored.providerSessionId, restarted.providerSessionId);
      await settle(); sameBoxes(heldBefore, await layoutBoxes(other, selectors), `${label}: restart recovered`); await shot(other, 'restart-recovered');
      st?.diagnostic('Captured recovery after SIGKILL/reload');
      for (const check of checks.filter(check => check.width === width && check.theme === theme && check.locale === locale)) {
        Object.assign(check, { callIdPreserved: true, epochAdvanced: true, captureRequiresResume: true,
          restart: 'SIGKILL and durable SQLite reload', layoutShiftPx: 0 });
      }
      await click(other, '.voice-close'); await state(other, 'idle'); complete = true;
    });
    if (!complete) throw new Error(`Continuity matrix stopped at ${width}/${theme}/${locale}; see the failing step`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait-138-d-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138 d', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', provider: 'local fake; actual server and browser controller', files, checks }, null, 2));
});
