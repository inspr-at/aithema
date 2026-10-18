import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceBrowserArgs, evidenceCommit, settleEvidenceFrame, shadow } from './start2-display-helpers.js';
import { measureFooterGeometry, assertFits } from './footer-geometry.js';

async function footerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const browser = await browserForFile(evidence ? { args: evidenceBrowserArgs } : {});
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), errors = [];
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
    // A frozen clock still lets paint() overwrite injected host timer copy.
    // Use the exported timer's teardown seam after its initial connected paint,
    // for every mount/reconnect in both the AIT-299/301 and legal-fit paths.
    const { ConnectionTimer } = await import('/packages/ui/src/layout.js');
    const setConnected = ConnectionTimer.prototype.setConnected;
    ConnectionTimer.prototype.setConnected = function (on) {
      setConnected.call(this, on);
      this.destroy();
    };
    window.footerSession = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) }).then(r => r.json());
    await import('/packages/ui/src/session-element.js');
    window.footerBoxes = () => {
      const root = document.querySelector('aithema-session').shadowRoot;
      const selectors = ['.display-foot', '.band', '.composer-dock', '.engine-info', '.status__dot'];
      return selectors.map(selector => { const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  return { page, errors, evidence };
}

export async function compactFooterCheck(t) {
  const { page, errors, evidence } = await footerFixture(t), checks = [];
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

// AIT-309: exercise the real fit loop with host copy, never a forced data-fit.
// Reuse AIT-299's no-provider page and AIT-164's painted/text-range geometry.
export async function legalFooterFitCheck(t) {
  const { page, errors, evidence } = await footerFixture(t), checks = [], qaShots = [];
  const fullFonts = new Map();
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const head = event?.pull_request?.head.sha ?? evidenceCommit;
  const fonts = 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; Georgia,"Iowan Old Style","Palatino Linotype",serif';
  // Retain completed full-fit baselines even in the expected red-before run.
  t.after(async () => {
    if (evidence) await writeFile(join(evidence, 'ait309-footer-checks.json'), JSON.stringify({
      head, capture: 'viewport', reducedMotion: true, blurredControls: true, fonts, checks, qaShots,
      passLines: checks.map(check => check.line),
    }, null, 2) + '\n');
  });
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, init) => new URL(url, location.href).pathname.endsWith('/identity')
      ? Promise.resolve(Response.json({ roleChoice: window.footerRoleChoice })) : original(url, init);
  });
  // Full goes first so the red run records every original full-fit viewport.
  for (const fit of ['full', 'identity', 'timer', 'role']) {
    for (const width of [900, 1024, 1180, 1440]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
      const name = `ait309-footer-${width}-${theme}-${locale}-${fit}`;
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(async ({ theme, locale, fit }) => {
        document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
        document.querySelector('main').innerHTML = `<aithema-session theme="${theme}" motion="off"></aithema-session>`;
        const c = document.querySelector('aithema-session');
        c.innerHTML = locale === 'de'
          ? '<a slot="legal" href="#impressum">Impressum</a><a slot="legal" href="#datenschutz">Datenschutz</a>'
          : '<a slot="legal" href="#imprint">Imprint</a><a slot="legal" href="#privacy">Privacy</a>';
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = structuredClone(window.footerSession); session.locale = locale;
        const labels = { de: { private: 'Privat', company: 'Firma', representative: 'Vertretung', agency: 'Agentur' },
          en: { private: 'Private', company: 'Company', representative: 'Representative', agency: 'Agency' } };
        window.footerRoleChoice = { available: true, roles: Object.keys(labels.en), role: 'company', source: 'chosen', revision: session.seq };
        if (fit === 'role') session.roleChoice = window.footerRoleChoice;
        c.configure({ copy, session, voiceClient: {}, host: { library: true,
          ...(fit === 'role' ? { actorRole: { labels } } : {}) } });
        window.footerConnected = copy.connected;
      }, { theme, locale, fit });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.status__label').textContent === window.footerConnected);
      await settleEvidenceFrame(page);
      await shadow(page, (c, fit) => {
        const root = c.shadowRoot;
        const selectors = fit === 'full' ? [] : ['.ai-notice__label', '.ai-notice__voice',
          ...(['timer', 'role'].includes(fit) ? ['.connection-timer'] : []),
          ...(fit === 'role' ? ['.actor-role .actor-value'] : [])];
        window.footerOriginalCopy = [];
        for (const selector of selectors) for (const node of root.querySelectorAll(selector)) {
          window.footerOriginalCopy.push([node, node.textContent]);
          node.textContent = 'Deliberately long translated host footer copy '.repeat(20);
        }
      }, fit);
      await settleEvidenceFrame(page);
      const measurement = await shadow(page, measureFooterGeometry, { visibleZonesOnly: true,
        zoneSelectors: ['.footer-left', '.host-credits', '.footer-right'],
        extraGroups: [['.footer-left', '.host-credits', '.footer-right'], ['.preset-panel', '.status', '.host-legal'], ['.footer-info', '.actor-role']] });
      const state = await shadow(page, c => {
        const root = c.shadowRoot, footer = root.querySelector('.display-foot');
        const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
        const row = box(root.querySelector('.display-foot__row')), viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const inside = (b, outer) => b.left >= outer.left && b.right <= outer.right && b.top >= outer.top && b.bottom <= outer.bottom;
        const links = [...root.querySelector('slot[name="legal"]').assignedElements()].map(link => {
          const rect = box(link), hidden = [], clipping = [];
          for (let node = link; node; node = node.assignedSlot ?? node.parentElement ?? node.getRootNode().host) {
            const style = getComputedStyle(node), bounds = box(node);
            if (node.hidden || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) hidden.push(node.localName);
            if (style.display === 'contents') continue;
            if ((/hidden|clip|scroll|auto/u.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)) ||
                (/hidden|clip|scroll|auto/u.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)) || style.clipPath !== 'none') clipping.push(node.localName);
          }
          const points = [[rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
            [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
          return { text: link.textContent, rect, visible: link.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
            hidden, clipping, insideRow: inside(rect, row), insideViewport: inside(rect, viewport),
            unobscured: points.every(([x, y]) => link.contains(document.elementFromPoint(x, y))) };
        });
        const shown = selector => { const node = root.querySelector(selector); return Boolean(node?.checkVisibility({ visibilityProperty: true, opacityProperty: true })); };
        const zones = [...root.querySelector('.display-foot__row').children].filter(n => !n.hidden && n.getClientRects().length).map(box);
        const status = getComputedStyle(root.querySelector('.status'));
        const aiFont = getComputedStyle(root.querySelector('.ai-notice')).fontSize;
        return { fit: footer.dataset.fit, creditsHidden: root.querySelector('.host-credits').hidden, row, zones, links,
          label: shown('.ai-notice__label'), voice: shown('.ai-notice__voice'), timer: shown('.status .connection-timer'),
          role: shown('.actor-role'), flag: shown('.engine__flag'), dot: shown('.status__dot'),
          statusColumns: status.gridTemplateColumns.split(' ').length, statusFont: status.fontSize, aiFont,
          boxes: window.footerBoxes(), legalBoxes: links.map(link => link.rect),
          zonesClear: zones.every((b, i) => inside(b, row) && (!i || zones[i - 1].right <= b.left)) };
      });
      // Capture only settled, blurred viewports, including the failing red state.
      if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false, captureBeyondViewport: false });
      assert.equal(state.fit, fit, `${name}: real long-copy fit loop reaches ${fit}; ${JSON.stringify(state)}`);
      assert.equal(state.creditsHidden, true, `${name}: host has no credits`);
      assert.equal(state.label, fit === 'full', `${name}: AI label yields in every compact fit`);
      assert.equal(state.voice, fit === 'full' && width >= 1100, `${name}: voice keeps its full-fit breakpoint and yields in every compact fit`);
      assert.equal(state.timer, ['full', 'identity'].includes(fit), `${name}: timer yields in timer/role`);
      assert.equal(state.statusColumns, ['full', 'identity'].includes(fit) ? 3 : 2, `${name}: status grid follows the fit`);
      assert.equal(state.statusFont, '12.5px', `${name}: approved legal-host type size`);
      assert.equal(state.aiFont, '12.5px', `${name}: AI notice keeps approved legal-host type size in every fit`);
      const fontKey = `${width}-${theme}-${locale}`, typeSizes = [state.aiFont, state.statusFont];
      if (fit === 'full') fullFonts.set(fontKey, typeSizes);
      assert.deepEqual(typeSizes, fullFonts.get(fontKey), `${name}: AI/status font sizes equal full fit`);
      console.log(`${name}: PASS AI/status font sizes 12.5px, identical to full fit`);
      if (fit === 'full' && [900, 1024, 1440].includes(width)) {
        const baseline = await shadow(page, c => {
          const root = c.shadowRoot;
          const snapshot = () => {
            const selectors = ['.ai-notice', '.ai-notice__label', '.ai-notice__voice', '.status',
              '.status__group', '.status__sizer', '.status__label', '.status__placeholder', '.connection-timer'];
            const styles = Object.fromEntries(selectors.map(selector => {
              const style = getComputedStyle(root.querySelector(selector));
              return [selector, Object.fromEntries(['font-size', 'display', 'grid-template-columns', 'grid-column', 'gap']
                .map(property => [property, style.getPropertyValue(property)]))];
            }));
            const zones = ['.display-foot__row', '.footer-left', '.footer-right', '.host-legal', '.engine-info', '.status__dot']
              .map(selector => { const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
            return { styles, zones };
          };
          const actual = snapshot(), reference = document.createElement('style');
          // Exact legal-host declarations from base 1530d90e, before fit scoping.
          // Compare synchronously: the observer never gets a temporary fit state.
          // Extra specificity makes the reference independent of current fit scoping.
          const host = '.display-foot.display-foot.display-foot:has(.host-legal:not([hidden])):has(.host-credits[hidden])';
          reference.textContent = `
            ${host} :is(.ai-notice,.status) { font-size:12.5px; }
            ${host} .ai-notice__label { display:inline; }
            ${host} .status { grid-template-columns:6px auto minmax(8ch,max-content); gap:6px; }
            ${host} .status__group { grid-column:1/3; }
            ${host} .status__sizer, ${host} :is(.status__label,.status__placeholder) { display:grid; }
            ${host} .connection-timer { grid-column:3; }`;
          root.append(reference);
          try { return { actual, base: snapshot() }; } finally { reference.remove(); }
        });
        assert.deepEqual(baseline.actual.styles, baseline.base.styles, `${name}: full-fit computed font/display/grid styles match base 1530d90e`);
        assert.deepEqual(baseline.actual.zones, baseline.base.zones, `${name}: full-fit zone boxes match base 1530d90e exactly`);
        state.fullFitBaseline = baseline;
        console.log(`${name}: PASS full-fit computed styles and zone boxes match base 1530d90e`);
      }
      assert.equal(state.role, false, `${name}: optional long role yields`);
      assert.equal(state.flag, true, `${name}: flag stays visible`);
      assert.equal(state.dot, true, `${name}: dot stays visible`);
      assert.equal(state.zonesClear, true, `${name}: adjacent visible zones do not intersect and stay inside the row`);
      assertFits(measurement, name);
      assert.deepEqual(state.links.map(link => link.text), locale === 'de' ? ['Impressum', 'Datenschutz'] : ['Imprint', 'Privacy'], `${name}: both slotted legal anchors`);
      for (const link of state.links) {
        const context = `${name}: ${link.text} ${JSON.stringify(link)}`;
        assert.equal(link.visible, true, `${context}: checkVisibility()`);
        assert.deepEqual(link.hidden, [], `${context}: composed ancestors visible`);
        assert.ok(link.rect.width > 0 && link.rect.height >= 44, `${context}: target >=44px high`);
        assert.equal(link.insideRow, true, `${context}: inside row`);
        assert.equal(link.insideViewport, true, `${context}: inside viewport`);
        assert.deepEqual(link.clipping, [], `${context}: unclipped`);
        assert.equal(link.unobscured, true, `${context}: corners and centre unobscured`);
      }
      if (fit !== 'full') {
        // Restoring hidden copy must defer expansion until the pointer leaves.
        const [x, y, w, h] = state.boxes[3], point = [x + w / 2, y + h / 2];
        await page.mouse.move(...point);
        await page.evaluate(() => { for (const [node, text] of window.footerOriginalCopy) node.textContent = text; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const held = await shadow(page, (c, point) => ({ boxes: window.footerBoxes(),
          legalBoxes: [...c.querySelectorAll('[slot="legal"]')].map(node => { const b = node.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; }),
          hit: Boolean(c.shadowRoot.elementFromPoint(...point)?.closest('.engine-info')) }), point);
        assert.deepEqual(held.boxes, state.boxes, `${name}: controls and outer layout move exactly 0px under the pointer`);
        assert.deepEqual(held.legalBoxes, state.legalBoxes, `${name}: legal targets move exactly 0px under the pointer`);
        assert.equal(held.hit, true, `${name}: flag control remains under the pointer`);
        await settleEvidenceFrame(page);
      }
      const line = `${name}: PASS zones clear; legal visible/unclipped/unobscured >=44px; flag/dot visible; held movement 0px`;
      checks.push({ head, width, theme, locale, fit, ...state, measurement, pass: true, line });
      console.log(line);
      if (evidence && fit === 'full' && width === 1024 && theme === 'light' && locale === 'de') {
        // Tick's long-copy QA pair, using the real fit loop in both viewports.
        await shadow(page, c => { c.shadowRoot.querySelector('.ai-notice__label').textContent += ' – ausführliche Hinweise zur KI'; });
        for (const qaFit of ['full', 'timer']) {
          if (qaFit === 'timer') await shadow(page, c => {
            c.shadowRoot.querySelector('.connection-timer').textContent = 'Lange Verbindungsdauer '.repeat(20);
          });
          await settleEvidenceFrame(page);
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.display-foot').dataset.fit), qaFit,
            `Tick 1024 light DE long copy: real ${qaFit} fit`);
          assertFits(await shadow(page, measureFooterGeometry, { visibleZonesOnly: true }), `Tick long-copy ${qaFit}`);
          const shot = `ait309-tick-1024-light-de-long-copy-${qaFit}.png`;
          await page.screenshot({ path: join(evidence, shot), fullPage: false, captureBeyondViewport: false });
          qaShots.push({ head, fit: qaFit, shot, longCopy: true });
          console.log(`Tick 1024 light DE long copy: PASS ${qaFit} viewport ${shot}`);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(checks.length, 64, 'complete four-fit/four-width/two-theme/two-locale matrix');
}
