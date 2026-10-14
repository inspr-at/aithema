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
import { browserPath, shadow, until, settle, layoutBoxes, sameBoxes, finishRevealEntry, finishWorkspaceEntry, evidenceCommit } from './start2-display-helpers.js';

test('AIT-138 d: tab takeover, wake waiting and actual restart recovery viewport evidence', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-continuity-'));
  const db = join(directory, 'session.sqlite');
  const settings = { AITHEMA_VOICE_MODE: 'fake', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit };
  let demo = await startChild(new URL('../fixtures/continuity-server.js', import.meta.url), db, settings);
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [], errors = [], takebacks = [];
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
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').disabled), false, 'old-tab Resume explicitly takes the call back');
      sameBoxes(before, await layoutBoxes(page, selectors), `${label}: old-tab notice`);
      let oldHintSignature;
      const shot = async (target, name) => {
        // Background tabs suspend requestAnimationFrame. Activate the captured
        // tab before settling; the owner's normal visibility hold still applies.
        await target.bringToFront();
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
            resumeLabel: pause.textContent.trim(), resumeTooltip: pause.title, resumeDisabled: pause.disabled, resumeCursor: pauseStyle.cursor,
            moved: rail.hasAttribute('data-moved'), composerHint: root.querySelector('.composer-reason').textContent,
            panelStatus: root.querySelector('.notice').textContent,
            footerUntruncated: footerBoxes.every(box => box.left >= 0 && box.right <= innerWidth && box.top >= footer.top && box.bottom <= footer.bottom) &&
              (compactFooter || textBox.width <= statusBox.width + .5 && status.scrollWidth <= status.clientWidth && statusBox.right <= innerWidth),
            footerLabel: status.textContent, compactFooter,
          };
        });
        for (const key of ['labelInRailCentre', 'noPopover', 'noRailRing', 'enabledResumeStyle', 'footerUntruncated']) {
          assert.ok(presentation[key], `${label}/${name}: ${key}: ${JSON.stringify(presentation)}`);
        }
        assert.ok(composer.fullyVisible, `${label}/${name}: settled composer must be fully visible: ${JSON.stringify(composer)}`);
        if (name === 'takeback-here') {
          assert.equal(presentation.moved, false);
          assert.notEqual(presentation.composerHint, { de, en }[locale].voiceInAnotherTab, 'the controlling tab clears its old composer hint');
          assert.notEqual(presentation.panelStatus, { de, en }[locale].voiceInAnotherTab, 'the controlling tab clears its old panel status');
        }
        if (['old-tab', 'takeback-other-tab'].includes(name)) {
          const copy = { de, en }[locale];
          assert.equal(presentation.label, copy.voiceMoved); assert.equal(presentation.resumeLabel, copy.voiceTakeover);
          assert.equal(presentation.resumeTooltip, copy.voiceTakeover); assert.equal(presentation.footerLabel, copy.voiceInAnotherTab);
          assert.equal(presentation.resumeDisabled, false); assert.equal(presentation.resumeCursor, 'pointer');
          const oldTab = await shadow(target, c => ({
            composerHint: c.shadowRoot.querySelector('.composer-reason').textContent,
            panelStatus: c.shadowRoot.querySelector('.notice').textContent,
            mic: c.shadowRoot.querySelector('.voice-input').title, speaker: c.shadowRoot.querySelector('.voice-output').title,
          }));
          assert.deepEqual(oldTab, { composerHint: copy.voiceInAnotherTab, panelStatus: copy.voiceInAnotherTab,
            mic: copy.voiceResumeHereFirst, speaker: copy.voiceResumeHereFirst });
        }
        const file = `ait-138-d-${name}-${label}.png`; files.push(file);
        const paintTargets = await shadow(target, c => ['.attach', '.send', '.composer-reason'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
          const inset = selector === '.composer-reason' ? 0 : 5;
          return { selector, x: Math.ceil(r.left + inset), y: Math.ceil(r.top + inset), width: Math.floor(r.width - inset * 2), height: Math.floor(r.height - inset * 2) };
        }));
        const readPaint = png => target.evaluate(async ({ encoded, targets }) => {
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
          return targets.map(({ selector, x, y, width, height }) => {
            const pixels = ctx.getImageData(x, y, width, height).data, min = [255, 255, 255], max = [0, 0, 0]; let signature = 2166136261;
            for (let i = 0; i < pixels.length; i += 4) for (let channel = 0; channel < 3; channel++) {
              min[channel] = Math.min(min[channel], pixels[i + channel]); max[channel] = Math.max(max[channel], pixels[i + channel]);
              signature = Math.imul(signature ^ pixels[i + channel], 16777619) >>> 0;
            }
            return { selector, contrast: Math.max(...max.map((v, i) => v - min[i])), signature };
          });
        }, { encoded: Buffer.from(png).toString('base64'), targets: paintTargets });
        // Chromium can return stale backdrop-filter layers after the entrance has finished.
        // Wait for actual pixels on both sides of the composer, not just DOM/hit-test geometry.
        const paintStarted = Date.now(); let png, composerPainted, attempts = 0;
        do {
          if (attempts) await settle();
          png = await target.screenshot({ fullPage: false }); attempts++;
          composer.paint = await readPaint(png);
          composerPainted = composer.paint.every(p => p.contrast >= 24);
          // Backdrop layers may retain the old hint even after DOM text changed.
          // The controlling tab's saved PNG must paint its new composer hint.
          composer.hintPaintChanged = name !== 'takeback-here' || composer.paint.at(-1).signature !== oldHintSignature;
        } while ((!composerPainted || !composer.hintPaintChanged) && Date.now() - paintStarted < 3000);
        if (name === 'old-tab') oldHintSignature = composer.paint.at(-1).signature;
        composer.captureAttempts = attempts; composer.paintWaitMs = Date.now() - paintStarted;
        if (evidence) {
          await writeFile(join(evidence, file), png);
          await writeFile(join(evidence, `${file}.json`), JSON.stringify({ name, width, theme, locale, composer, presentation, composerPainted }, null, 2));
        }
        assert.ok(composerPainted, `${label}/${name}: composer controls must be painted in the viewport PNG: ${JSON.stringify(composer.paint)}`);
        assert.ok(composer.hintPaintChanged, `${label}/${name}: the PNG must not retain the retired-tab composer hint`);
        checks.push({ width, theme, locale, state: name, ...presentation, composerFullyVisible: composer.fullyVisible && composerPainted,
          composer, composerPainted, pass: true });
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
      let dialogs = 0;
      for (const target of [page, other]) target.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
      const takeback = async (winner, loser, epoch) => {
        const response = winner.waitForResponse(r => r.url().endsWith(`/${call.callId}/takeover`) && r.request().method() === 'POST');
        await winner.bringToFront();
        const point = await shadow(winner, c => { const r = c.shadowRoot.querySelector('.pause').getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await winner.mouse.click(point.x, point.y);
        const receipt = await response; assert.equal(receipt.status(), 200); const held = await receipt.json();
        assert.equal(held.epoch, epoch + 1); assert.equal(held.callId, call.callId);
        await state(winner, 'listening'); await state(loser, 'waiting'); await settle();
        const controlling = await winner.evaluate(() => JSON.parse(sessionStorage.getItem(`aithema-voice-call:${document.querySelector('aithema-session').session.id}`)));
        assert.equal(controlling.epoch, held.epoch); assert.equal(controlling.tabId, held.controllingTabId);
        assert.equal(await shadow(loser, c => c.shadowRoot.querySelector('.voice-state').textContent), { de, en }[locale].voiceMoved);
        const states = [await shadow(winner, c => c.shadowRoot.querySelector('.audio-rail').dataset.state),
          await shadow(loser, c => c.shadowRoot.querySelector('.audio-rail').dataset.state)];
        assert.equal(states.filter(s => ['listening', 'speaking'].includes(s)).length, 1);
        assert.equal(dialogs, 0, 'the old-tab click requires no second confirmation');
        takebacks.push({ width, theme, locale, epoch: held.epoch, controllingTabId: held.controllingTabId,
          oneClick: true, controllingTabs: 1, otherTabHeldAndLabelled: true, confirmations: dialogs, pass: true });
        return held.epoch;
      };
      let epoch = await takeback(page, other, next.epoch);
      await shot(page, 'takeback-here'); await shot(other, 'takeback-other-tab');
      for (let i = 0; i < 3; i++) epoch = i % 2 === 0 ? await takeback(other, page, epoch) : await takeback(page, other, epoch);
      st.diagnostic(`PASS ${evidenceCommit} ${label}: old-tab ▶ enabled, pointer and ink; one click takeover + Resume; A→B→A→B ping-pong; one controlling tab, other held and labelled; no double confirm`);
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
    createdAt: new Date().toISOString(), capture: 'viewport', provider: 'local fake; actual server and browser controller', files, checks, takebacks }, null, 2));
});

// Hold the first greeting's persistence while the rail is already speaking.
// This reproduces the ordering that previously captured the full-width pane.
test('AIT-177: continuity baseline awaits the persisted greeting and workspace entry', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-continuity-entry-'));
  const demo = await startChild(new URL('../fixtures/continuity-server.js', import.meta.url), join(directory, 'session.sqlite'));
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    userDataDir: join(directory, 'chrome'), env: { PATH: process.env.PATH, HOME: homedir() },
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(); await page.setViewport({ width: 1024, height: 900 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercepted;
  const greeting = new Promise(resolve => { intercepted = resolve; });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (request.method() === 'POST' && /\/voice\/[^/]+\/events$/u.test(new URL(request.url()).pathname)
      && JSON.parse(request.postData()).event.type === 'final') {
      intercepted(); await held;
    }
    await request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await mockConsent(page);
  await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').click());
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'ready');
  await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.voice-start').disabled);
  await shadow(page, c => c.shadowRoot.querySelector('.ready__mode[data-mode="voice"]').click());
  await shadow(page, c => c.shadowRoot.querySelector('.ready__start').click());
  await greeting;
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent');
  // Release only after the old 120ms baseline wait could finish. The new wait
  // must observe the persisted final event before it can return.
  const timer = setTimeout(release, 500); t.after(() => { clearTimeout(timer); release(); });
  await finishWorkspaceEntry(page);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'present');
  assert.ok(await shadow(page, c => c.session.transcript.length > 0));
  const selectors = ['.voice-notices', '.concept-bar', '.transcript-shell', '.composer-dock'];
  const before = await layoutBoxes(page, selectors);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  sameBoxes(before, await layoutBoxes(page, selectors), 'first greeting workspace entry completed');
});
