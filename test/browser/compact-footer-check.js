import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceBrowserArgs, evidenceCommit, settleEvidenceFrame } from './start2-display-helpers.js';

export async function compactFooterCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const browser = await browserForFile(evidence ? { args: evidenceBrowserArgs } : {});
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== demo.url) return void request.abort();
    if (url.pathname !== '/ait299') return void request.continue();
    void request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
      <link rel="stylesheet" href="/demo/host.css"><style>body { margin:0; }
      aithema-session { --aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
        --aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif; }</style></head><body><main></main></body></html>` });
  });
  await page.goto(`${demo.url}/ait299`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const now = Date.now(); Date.now = () => now;
    window.footerSession = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) }).then(r => r.json());
    await import('/packages/ui/src/session-element.js');
    window.footerBoxes = () => {
      const root = document.querySelector('aithema-session').shadowRoot;
      const selectors = ['.display-foot', '.band', '.composer-dock', '.engine-info', '.status__dot'];
      return selectors.map(selector => { const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const heldShot = async name => {
    if (!evidence) return;
    // Focus/hover is the subject: retain it while settling all finite motion.
    await page.evaluate(async () => {
      await document.fonts.ready;
      const root = document.querySelector('aithema-session').shadowRoot;
      await Promise.all(root.querySelector('.display-foot').getAnimations({ subtree: true })
        .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
    });
    await frames();
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false, captureBeyondViewport: false });
  };
  for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
    const name = `ait299-footer-${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(async ({ theme, locale }) => {
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      document.querySelector('main').innerHTML = `<aithema-session theme="${theme}" motion="off"></aithema-session>`;
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.footerSession); session.locale = locale;
      document.querySelector('aithema-session').configure({ copy, session, voiceClient: {}, host: { library: true } });
      window.footerConnected = copy.connected;
    }, { theme, locale });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.status__label').textContent === window.footerConnected);
    await settleEvidenceFrame(page);
    await page.evaluate(width => {
      const root = document.querySelector('aithema-session').shadowRoot;
      window.footerLabel = root.querySelector(width >= 1100 ? '.ai-notice__label' : '.connection-timer');
      window.footerShortText = window.footerLabel.textContent;
      window.footerLabel.textContent = 'A deliberately long host label '.repeat(20);
    }, width);
    await settleEvidenceFrame(page);
    const before = await page.evaluate(() => {
      const footer = document.querySelector('aithema-session').shadowRoot.querySelector('.display-foot');
      return { fit: footer.dataset.fit, labelHidden: !window.footerLabel.getClientRects().length, boxes: window.footerBoxes() };
    });
    if (width >= 600) {
      assert.notEqual(before.fit, 'full', `${name}: long copy requires compact mode`);
      assert.equal(before.labelHidden, true, `${name}: the changed label is hidden by compact fit`);
    }
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-before.png`), fullPage: false, captureBeyondViewport: false });
    // Hold the preset control under a real stationary pointer during the mutation.
    const [x, y, w, h] = before.boxes[3]; await page.mouse.move(x + w / 2, y + h / 2);
    await page.evaluate(() => { window.footerLabel.textContent = window.footerShortText; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const held = await page.evaluate(point => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return { boxes: window.footerBoxes(), hit: Boolean(root.elementFromPoint(...point)?.closest('.engine-info')) };
    }, [x + w / 2, y + h / 2]);
    assert.deepEqual(held.boxes, before.boxes, `${name}: controls move 0px while the pointer rests on the footer`);
    assert.equal(held.hit, true);
    await settleEvidenceFrame(page); // Blurs controls and moves the pointer out before the after shot.
    const after = await page.evaluate(() => ({ fit: document.querySelector('aithema-session').shadowRoot.querySelector('.display-foot').dataset.fit, boxes: window.footerBoxes() }));
    assert.equal(after.fit, 'full', `${name}: shorter hidden copy restores the full fit`);
    assert.deepEqual(after.boxes.slice(0, 3), before.boxes.slice(0, 3), `${name}: footer, band and composer shift 0px`);
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-after.png`), fullPage: false, captureBeyondViewport: false });
    checks.push({ head: evidenceCommit, width, theme, locale, before, held, after, pass: true });
    console.log(`${name}: PASS compact refit; pointer controls and outer layout shift 0px`);

    // Keep a focus-held viewport for every size/theme/language, including phones.
    await page.evaluate(() => document.querySelector('aithema-session').shadowRoot.querySelector('.engine-info').focus());
    await heldShot(`${name}-focus-held`);
    await settleEvidenceFrame(page);
    // Below 1100px CSS hides the AI label even in full mode, making full and
    // identity equivalent. The partial-expansion case needs distinct modes.
    if (width < 1100) continue;
    await page.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot;
      window.partialAI = root.querySelector('.ai-notice__label');
      window.partialTimer = root.querySelector('.connection-timer');
      window.partialTimerText = window.partialTimer.textContent;
      // The timer can fit again without the full AI label fitting yet.
      window.partialAI.textContent = 'A deliberately long host label '.repeat(20);
      window.partialTimer.textContent = 'A deliberately long timer label '.repeat(20);
    });
    await settleEvidenceFrame(page);
    const partialState = () => page.evaluate(point => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return { fit: root.querySelector('.display-foot').dataset.fit, boxes: window.footerBoxes(),
        focused: root.activeElement === root.querySelector('.engine-info'),
        hit: point ? Boolean(root.elementFromPoint(...point)?.closest('.engine-info')) : null };
    }, windowPartialPoint);
    let windowPartialPoint;
    const compact = await partialState();
    assert.equal(compact.fit, 'timer', `${name}: long timer compacts beyond identity`);
    const [px, py, pw, ph] = compact.boxes[3]; windowPartialPoint = [px + pw / 2, py + ph / 2];
    await page.mouse.move(...windowPartialPoint);
    await page.evaluate(() => {
      document.querySelector('aithema-session').shadowRoot.querySelector('.engine-info').focus();
      window.partialTimer.textContent = window.partialTimerText;
    });
    await frames();
    const partialHeld = await partialState();
    assert.equal(partialHeld.fit, 'timer', `${name}: timer-to-identity expansion waits while pointer/focus are held`);
    assert.deepEqual(partialHeld.boxes, compact.boxes, `${name}: partial expansion moves controls 0px under the pointer`);
    assert.equal(partialHeld.hit, true); assert.equal(partialHeld.focused, true);
    await page.mouse.move(-20, -20); await frames();
    const focusOnly = await partialState();
    assert.equal(focusOnly.fit, 'timer', `${name}: focus alone defers the partial expansion`);
    assert.deepEqual(focusOnly.boxes, compact.boxes);
    await heldShot(`${name}-timer-identity-focus-held`);
    await page.mouse.move(...windowPartialPoint);
    await page.evaluate(() => document.querySelector('aithema-session').shadowRoot.activeElement?.blur()); await frames();
    const pointerOnly = await partialState();
    assert.equal(pointerOnly.fit, 'timer', `${name}: pointer alone defers the partial expansion`);
    assert.deepEqual(pointerOnly.boxes, compact.boxes, `${name}: controls still move 0px under the resting pointer`);
    assert.equal(pointerOnly.hit, true);
    await heldShot(`${name}-timer-identity-pointer-held`);
    await settleEvidenceFrame(page);
    const partialReleased = await partialState();
    assert.equal(partialReleased.fit, 'identity', `${name}: leaving applies identity while full still does not fit`);
    assert.deepEqual(partialReleased.boxes.slice(0, 3), compact.boxes.slice(0, 3));
    if (evidence) await page.screenshot({ path: join(evidence, `${name}-timer-identity-released.png`), fullPage: false, captureBeyondViewport: false });
    checks.push({ head: evidenceCommit, width, theme, locale, partialExpansion: true, compact, partialHeld, focusOnly, pointerOnly, partialReleased, pass: true });
    console.log(`${name}: PASS timer-to-identity; held focus/pointer shift 0px, identity applied on leave`);
  }
  // Keep Chrome focus on the footer button through resize, growing copy and Escape.
  await page.setViewport({ width: 1440, height: 1000 });
  await settleEvidenceFrame(page);
  await page.evaluate(() => {
    const root = document.querySelector('aithema-session').shadowRoot;
    window.focusButton = root.querySelector('.ai-notice');
    window.focusLabel = root.querySelector('.ai-notice__label');
    window.focusOriginal = window.focusLabel.textContent;
    window.focusLabel.textContent = 'W'.repeat(50);
  });
  const fitState = () => page.evaluate(() => {
    const root = document.querySelector('aithema-session').shadowRoot, footer = root.querySelector('.display-foot');
    const row = footer.querySelector('.display-foot__row'), bounds = row.getBoundingClientRect();
    const boxes = [...row.children].filter(n => !n.hidden && n.getClientRects().length).map(n => n.getBoundingClientRect());
    return { fit: footer.dataset.fit, focused: root.activeElement === window.focusButton,
      clear: boxes.every((b, i) => b.left >= bounds.left && b.right <= bounds.right && (!i || boxes[i - 1].right <= b.left)) };
  });
  await frames();
  assert.equal((await fitState()).fit, 'full', 'the widened label fits before narrowing');
  await page.evaluate(() => window.focusButton.focus());
  await page.setViewport({ width: 1100, height: 1000 }); await frames();
  const narrowed = await fitState();
  assert.equal(narrowed.focused, true);
  await page.setViewport({ width: 1440, height: 1000 }); await frames();
  await page.evaluate(() => { window.focusLabel.textContent = 'A deliberately long host label '.repeat(20); }); await frames();
  const overflow = await fitState();
  console.log(`AIT-299 focus-held states: ${JSON.stringify({ narrowed, overflow })}`);
  assert.notEqual(narrowed.fit, 'full'); assert.equal(narrowed.clear, true, 'held focus cannot defer a corrective resize refit');
  assert.equal(overflow.focused, true); assert.notEqual(overflow.fit, 'full');
  assert.equal(overflow.clear, true, 'growing copy compacts immediately with footer focus held');
  await page.keyboard.press('Escape'); await frames();
  if (evidence) {
    // Focus is the subject of this shot; retain it, with pointer outside and settled motion.
    await page.mouse.move(-20, -20); await frames();
    await page.screenshot({ path: join(evidence, 'ait299-footer-focus-held-overflow.png'), fullPage: false, captureBeyondViewport: false });
  }
  await page.evaluate(() => { window.focusLabel.textContent = window.focusOriginal; }); await frames();
  const deferred = await fitState();
  assert.equal(deferred.focused, true); assert.equal(deferred.fit, overflow.fit, 'same-width expansion still waits for focus to leave');
  await settleEvidenceFrame(page);
  const released = await fitState(); assert.equal(released.fit, 'full'); assert.equal(released.clear, true);
  checks.push({ head: evidenceCommit, focusHeld: true, narrowed, overflow, deferred, released, pass: true });
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait299-footer-checks.json'), JSON.stringify({ head: evidenceCommit,
    capture: 'viewport', reducedMotion: true, blurredControls: true, fonts: 'Chrome baseline', checks }, null, 2) + '\n');
}
