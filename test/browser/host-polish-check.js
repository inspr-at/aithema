// AIT-266: one no-provider server and page, reused for the pointer/locale/viewport hold.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { shadow, until, boxes, evidenceCommit, evidenceBrowserArgs } from './start2-display-helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';

export async function hostPolishCheck(t, { evidenceDirectory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-host-polish-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const evidence = evidenceDirectory && join(evidenceDirectory, 'ait-266');
  const browser = await browserForFile({ defaultViewport: null, args: [...(evidence ? evidenceBrowserArgs : []), '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'] }), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const cdp = await page.createCDPSession(), checks = [], shots = [], passLines = [], problems = [];
  // CI already requests light artifacts; preserve its cost while remote evidence adds dark.
  const themes = evidence && !process.env.CI ? ['light', 'dark'] : ['light'];
  page.on('pageerror', error => problems.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => {
    window.polish266Seed = structuredClone(c.session);
    const original = window.fetch;
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path.endsWith('/features')) return Response.json({});
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (path.endsWith('/turns') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
      }
      if (path.endsWith('/settings') && (init.method ?? 'GET') === 'GET') {
        const result = await original(url, init), catalog = await result.json();
        Object.assign(catalog, { processingPreset: 'best', settings: c.session.settings, engine: c.session.engine });
        catalog.presets.eu = { offered: false, status: 'unavailable', reason: 'not configured' };
        catalog.presets.custom = { offered: false, status: 'unavailable', reason: 'not configured' };
        return Response.json(catalog);
      }
      return original(url, init);
    };
  });
  const settle = () => shadow(page, async c => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
      .filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {})));
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const shot = async (label, theme, state) => {
    if (!evidence) return;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle();
    const colors = await shadow(page, c => {
      const selectors = ['.composer-saved', '.composer-saved svg', '.composer-reason', '.composer-reason kbd',
        '.chooser-option[aria-disabled="true"] strong', '.chooser-option[aria-disabled="true"] .chooser-option__detail',
        '.chooser-option[aria-disabled="true"] .chooser-option__note',
        '.preset-option[aria-disabled="true"]', '.preset-option[aria-disabled="true"] .option-status',
        '.concept-activity-text', '.display-foot', '.ai-notice'];
      return selectors.flatMap(selector => [...c.shadowRoot.querySelectorAll(selector)].map(n => {
        const style = getComputedStyle(n), rect = n.getBoundingClientRect(), backgrounds = [];
        for (let a = n; a; a = a.parentElement ?? a.getRootNode().host) {
          const s = getComputedStyle(a);
          backgrounds.push({ node: a.className?.baseVal ?? a.className, color: s.backgroundColor, image: s.backgroundImage, opacity: s.opacity });
        }
        return { selector, text: n.textContent.trim(), visible: n.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          color: style.color, stroke: style.stroke, fontSize: style.fontSize, fontWeight: style.fontWeight,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, backgrounds };
      }));
    });
    const file = `${label}-${state}.png`;
    await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    shots.push({ file, head: evidenceCommit, theme, state, colors });
  };
  const configure = async (locale, stage, visuals = false) => {
    await shadow(page, async (c, { locale, stage, visuals }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.polish266Seed);
      session.visualsBound = visuals;
      session.locale = locale; session.paused = false; session.pauseReason = null;
      session.transcript = stage === 'live' ? [{ id: 'polish-person', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' }] : [];
      session.settings = { ...session.settings, origin: 'default', voice: 'off', visuals: 'off' };
      session.concepts = []; session.conceptStatus = { phase: 'idle' }; session.conceptVisualKind = 'html'; session.conceptCost = { maxMicro: 0 };
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true },
        html: { available: visuals, reason: visuals ? null : 'not configured' }, images: { available: false, reason: 'not configured' } },
        eu: { text: { available: false, reason: 'not configured' } }, custom: { text: { available: false, reason: 'not configured' } } };
      c.setAttribute('motion', 'off'); c.configure({ copy, session });
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; window.scrollTo(0, 0);
    }, { locale, stage, visuals });
    await settle();
  };
  // CI keeps its single light functional matrix. A second theme and PNGs are remote evidence only.
  for (const theme of themes) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    for (const touch of [false, true]) for (const locale of ['de', 'en']) for (const [width, height] of [[1440, 1000], [1280, 860], [390, 844]]) {
      const label = `${locale}-${width}x${height}-${touch ? 'touch' : 'mouse'}-${theme}`, copy = { de, en }[locale];
      // Match pause-phone's native desktop fixture: Puppeteer's viewport helper resets hover on Linux.
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 1 });
      await configure(locale, 'entrance');
      if (evidence) assert.equal(await shadow(page, c => getComputedStyle(c).colorScheme), theme);
      const disabled = await shadow(page, c => ['eu', 'custom'].map(preset => {
        const n = c.shadowRoot.querySelector(`.chooser-option[data-preset="${preset}"]`);
        return [n.getAttribute('aria-disabled'), n.getAttribute('aria-pressed'), n.tabIndex, n.querySelector('.chooser-option__note').textContent, n.checkVisibility()];
      }));
      for (const row of disabled) assert.deepEqual(row, ['true', 'false', -1, copy.chooser.unavailable, true]);
      // Check application scroll before the visitor's keyboard focus can scroll a card into view.
      assert.equal(await page.evaluate(() => scrollY), 0, `${label}: no automatic entrance scroll`);
      await shadow(page, c => c.shadowRoot.querySelector('.chooser-option[data-preset="best"]').focus());
      await page.keyboard.press('ArrowLeft');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement.dataset.preset), 'device');
      await page.keyboard.press('ArrowRight');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement.dataset.preset), 'best');
      // A visitor can scroll to Continue at short heights; the app never scrolls on their behalf.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await settle();
      const clearance = await shadow(page, c => {
        const r = c.shadowRoot, button = r.querySelector('.chooser__continue'), a = button.getBoundingClientRect(), footer = r.querySelector('.display-foot').getBoundingClientRect();
        return { clear: a.bottom <= footer.top, target: a.height >= 44, hit: Boolean(r.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2)?.closest('.chooser__continue')),
          bottom: a.bottom, footerTop: footer.top, padding: parseFloat(getComputedStyle(r.querySelector('.workspace')).paddingBottom), footerHeight: footer.height };
      });
      assert.equal(clearance.clear, true, `${label}: ${JSON.stringify(clearance)}`); assert.equal(clearance.target, true); assert.equal(clearance.hit, true);
      assert.ok(clearance.padding >= clearance.footerHeight);
      await shot(label, theme, 'entrance');
      await shadow(page, c => c.openSettings());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.preset-option[data-preset="custom"]').getAttribute('aria-disabled') === 'true');
      const settings = await shadow(page, c => ['eu', 'custom'].map(preset => {
        const n = c.shadowRoot.querySelector(`.preset-option[data-preset="${preset}"]`);
        return [n.getAttribute('aria-disabled'), n.querySelector('.option-status').textContent];
      }));
      for (const row of settings) assert.deepEqual(row, ['true', copy.chooser.unavailable]);
      // End focuses the last offered preset; avoid choosing it (which would POST real settings).
      await shadow(page, c => {
        const r = c.shadowRoot, device = r.querySelector('.preset-option[data-preset="device"]');
        device.addEventListener('click', event => event.stopImmediatePropagation(), { capture: true });
        r.querySelector('.preset-option[data-preset="best"]').focus();
      });
      await page.keyboard.press('ArrowLeft'); assert.equal(await shadow(page, c => c.shadowRoot.activeElement.dataset.preset), 'device');
      await shot(label, theme, 'settings');
      await shadow(page, c => c.shadowRoot.querySelector('dialog.settings .done').click());
      await configure(locale, 'live');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').checkVisibility()), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-bar').checkVisibility()), false);
      for (const [platform, key] of [['MacIntel', copy.shortcutKeys.mac], ['Win32', copy.shortcutKeys.other]]) {
        await page.evaluate(platform => Object.defineProperty(navigator, 'platform', { configurable: true, value: platform }), platform);
        await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
        const hint = await shadow(page, c => {
          const n = c.shadowRoot.querySelector('.composer-reason');
          return { text: n.textContent, keys: [...n.querySelectorAll('kbd')].map(k => k.textContent), visible: n.checkVisibility({ visibilityProperty: true }),
            coarse: matchMedia('(pointer:coarse)').matches, hoverNone: matchMedia('(hover:none)').matches };
        });
        assert.equal(hint.text, copy.shortcut.replace('{key}', key)); assert.deepEqual(hint.keys, [key, 'Enter']);
        assert.equal(hint.visible, !touch, `${label}: ${JSON.stringify(hint)}`); assert.equal(hint.coarse, touch); assert.equal(hint.hoverNone, touch);
      }
      if (touch) {
        const reservation = await shadow(page, c => { const r = c.shadowRoot; return [r.querySelector('.composer-feedback').getBoundingClientRect().width, r.querySelector('.composer-saved-sizer').getBoundingClientRect().width]; });
        assert.equal(reservation[0], reservation[1], `${label}: touch reserves only the confirmation width`);
      }
      await shot(label, theme, 'live-no-visuals');
      const selectors = ['.composer', '.composer-feedback', '.send', '.attach', '.display-foot'];
      const before = await boxes(page, selectors);
      // Send and inspect feedback in the same browser task, before its 1.6 s timer can expire.
      const saved = await shadow(page, async c => {
        const r = c.shadowRoot; r.querySelector('textarea').value = 'Hello';
        r.querySelector('form').requestSubmit();
        while (!r.querySelector('.composer-feedback').hasAttribute('data-saved')) await new Promise(resolve => setTimeout(resolve, 10));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const feedback = r.querySelector('.composer-feedback').getBoundingClientRect(), send = r.querySelector('.send').getBoundingClientRect();
        return { text: r.querySelector('.composer-saved span').textContent, opacity: getComputedStyle(r.querySelector('.composer-saved')).opacity,
          hintOpacity: getComputedStyle(r.querySelector('.composer-reason')).opacity, noToast: !r.querySelector('.composer-dock > .status__label'),
          disjoint: feedback.right <= send.left, target: send.width === 44 && send.height === 44 };
      });
      assert.deepEqual(saved, { text: copy.saved, opacity: '1', hintOpacity: '0', noToast: true, disjoint: true, target: true });
      assert.deepEqual(await boxes(page, selectors), before, `${label}: saved feedback shifts 0 px`);
      await shot(label, theme, 'saved');
      // Timer duration is covered in units; observe a real expiry once per pointer mode.
      const expiryChecked = locale === 'de' && width === 1440;
      if (expiryChecked) {
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback').hasAttribute('data-saved'));
        assert.deepEqual(await boxes(page, selectors), before, `${label}: expiry shifts 0 px`);
      }
      await configure(locale, 'live', true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').checkVisibility()), true);
      await shot(label, theme, 'visuals-on');
      checks.push({ label, theme, pass: true, clearance, saved, expiryChecked, shiftPx: 0, visualsOffOn: true, platformKeys: ['MacIntel', 'Win32'], keyboardSkip: ['entrance', 'settings'] });
    }
    // Height-only changes use the same page and do not add screenshot or server cost.
    for (const height of [600, 720, 900]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height, deviceScaleFactor: 1, mobile: false }); await configure('de', 'entrance');
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').getBoundingClientRect().bottom <= c.shadowRoot.querySelector('.display-foot').getBoundingClientRect().top), true);
      checks.push({ label: `de-1280x${height}-${theme}`, theme, pass: true, footerClear: true });
    }
    passLines.push(`AIT-266 PASS: ${theme}; 12 locale/viewport/pointer cases; 3 footer heights; ${evidence ? 60 : 0} viewport captures.`);
  }
  assert.deepEqual(problems, []); assert.equal(checks.length, 15 * themes.length);
  if (evidence) assert.equal(shots.length, 60 * themes.length);
  passLines.push('AIT-266 PASS: visuals absent/present; DE/EN, 1440/1280x860/390, touch/mouse.',
    'AIT-266 PASS: Mac/other keycaps; touch hint hidden; inline Saved 1600ms; composer/Send 0 px; 44 px Send.',
    'AIT-266 PASS: Custom and EU unavailable at entrance/Settings; arrow keys skip; Continue clears footer at all tested heights.');
  for (const line of passLines) console.log(line);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true,
    blurredControls: true, fonts: 'Chrome baseline UI/display stacks pinned', themes, passLines, checks, shots }, null, 2) + '\n');
}
