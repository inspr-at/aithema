// AIT-266: one no-provider server and page, reused for the pointer/locale/viewport hold.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fullMatrix } from './matrix-coverage.js';
import { shadow, until, boxes, evidenceCommit, evidenceBrowserArgs } from './start2-display-helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';

export async function hostPolishCheck(t, { evidenceDirectory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-host-polish-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const evidence = evidenceDirectory && join(evidenceDirectory, 'ait-286-composer');
  const browser = await browserForFile({ defaultViewport: null, args: [...(evidence ? evidenceBrowserArgs : []), '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'] }), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const cdp = await page.createCDPSession(), checks = [], failure294Checks = [], shots = [], passLines = [], problems = [];
  // CI already requests light artifacts; preserve its cost while remote evidence adds dark.
  const themes = evidence && fullMatrix ? ['light', 'dark'] : ['light'];
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
      if (/\/api\/sessions\/[^/]+$/u.test(path)) {
        const session = c.session;
        if (window.polish280Verdict) session.featureMatrix.best.text = window.polish280Verdict;
        return Response.json(session);
      }
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (path.endsWith('/turns') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (window.polish280State === 'failure') return Response.json({}, { status: 503 });
        if (window.polish280State === 'pause') c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
        return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
      }
      if (window.ait294Settings && path.endsWith('/settings') && init.method === 'POST') {
        const body = JSON.parse(init.body), settings = { ...c.session.settings, ...body, revision: c.session.settings.revision + 1, origin: 'chosen' };
        return Response.json({ processingPreset: 'best', settings, engine: c.session.engine, unchanged: false,
          event: { seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings } },
          featureMatrix: c.session.featureMatrix, consent: { required: false, features: [] } });
      }
      if (path.endsWith('/settings') && (init.method ?? 'GET') === 'GET') {
        const result = await original(url, init), catalog = await result.json();
        Object.assign(catalog, { processingPreset: 'best', settings: c.session.settings, engine: c.session.engine });
        if (window.ait294Settings) {
          const base = catalog.presets.best.models[0];
          catalog.presets.best.models = [
            { ...base, id: 'mock', label: 'Mock reasoning', efforts: ['none'], effort: 'none' },
            { ...base, id: 'mock/deep', label: 'Deep (mock)', efforts: ['low', 'medium', 'high'], effort: 'medium' },
          ];
        }
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
        '.composer-reason .warning', '.composer-reason .warning svg', '.composer-reason .consent-action',
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
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, uploads: { available: true },
        html: { available: visuals, reason: visuals ? null : 'not configured' }, images: { available: false, reason: 'not configured' } },
        eu: { text: { available: false, reason: 'not configured' } }, custom: { text: { available: false, reason: 'not configured' } } };
      c.querySelectorAll('[slot="legal"], [slot="footer"]').forEach(n => n.remove());
      const legal = document.createElement('nav'); legal.slot = 'legal'; legal.style.cssText = 'display:flex;gap:0';
      for (const [href, text] of [['/imprint', locale === 'de' ? 'Impressum' : 'Imprint'], ['/privacy', locale === 'de' ? 'Datenschutz' : 'Privacy']]) {
        const a = document.createElement('a'); a.href = href; a.textContent = text;
        a.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:inherit;text-decoration:underline;text-underline-offset:3px'; legal.append(a);
      }
      c.append(legal);
      window.polish280State = ''; window.polish280Verdict = null; window.polish280Observer?.disconnect();
      c.setAttribute('motion', 'off'); c.configure({ copy, session });
      window.polish280Announcements = [];
      const live = c.shadowRoot.querySelector('.composer-saved-announcement');
      window.polish280Observer = new MutationObserver(() => { if (live.textContent) window.polish280Announcements.push(live.textContent); });
      window.polish280Observer.observe(live, { childList: true, subtree: true, characterData: true });
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; window.scrollTo(0, 0);
    }, { locale, stage, visuals });
    await settle();
  };
  // AIT-294 r2: one live page for both model types, translations and palettes.
  const settings294Checks = [];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width: 390, height: 844 }); await page.select('#theme', theme);
    await configure(locale, 'live');
    await shadow(page, async (c, locale) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      window.ait294Settings = true;
      const session = c.session; session.settings = { ...session.settings, model: 'mock', effort: 'none', origin: 'chosen' };
      c.configure({ session, copy }); c.openSettings();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('[data-select="model"] [role="option"]').length === 2);
    let baseline;
    for (const model of ['fixed', 'adjustable', 'fixed']) {
      await shadow(page, (c, model) => {
        const r = c.shadowRoot;
        r.querySelector('[data-select="model"] .select__button').click();
        r.querySelector(`[data-select="model"] [data-value="${model === 'fixed' ? 'mock' : 'mock/deep'}"]`).click();
      }, model);
      await settle();
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-1, -1); await settle();
      const metric = await shadow(page, c => {
        const r = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; };
        const model = r.querySelector('[data-text="model"]'), info = r.querySelector('.context-message');
        const from = model.getBoundingClientRect().top, to = info.getBoundingClientRect().top, intervals = [];
        const walker = document.createTreeWalker(r.querySelector('[data-panel="model"]'), NodeFilter.SHOW_TEXT);
        for (let text; (text = walker.nextNode());) {
          if (!text.textContent.trim() || !text.parentElement.checkVisibility({ visibilityProperty:true, opacityProperty:true })) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          for (const b of range.getClientRects()) if (b.bottom > from && b.top < to) intervals.push([Math.max(from,b.top),Math.min(to,b.bottom)]);
        }
        // Painted controls occupy space too: the slider is content, not an empty text run.
        for (const control of r.querySelectorAll('[data-panel="model"] :is(button,input)')) {
          if (!control.checkVisibility({ visibilityProperty:true, opacityProperty:true })) continue;
          const b = control.getBoundingClientRect();
          if (b.bottom > from && b.top < to) intervals.push([Math.max(from,b.top),Math.min(to,b.bottom)]);
        }
        intervals.sort((a,b) => a[0]-b[0]); let end = from, maxEmptyPx = 0;
        for (const [top,bottom] of intervals) { maxEmptyPx = Math.max(maxEmptyPx,top-end); end = Math.max(end,bottom); }
        maxEmptyPx = Math.max(maxEmptyPx,to-end);
        return { info: box(info), maxEmptyPx, intervals,
          gauges: r.querySelector('.settings-overview').getBoundingClientRect().height,
          slot: box(r.querySelector('.effort-area')), slider: box(r.querySelector('.effort')),
          note: box(r.querySelector('.effort-note')),
          areas: ['.settings__body','.settings-panel','.notice-area','.settings-overview','.settings-context','.context-text'].map(s => [s,box(r.querySelector(s))]) };
      });
      baseline ??= metric.info;
      settings294Checks.push({ locale, theme, model, ...metric });
      assert.equal(metric.gauges, 0, 'AIT-294: below 600px the entire gauge column has no footprint');
      assert.ok(metric.maxEmptyPx <= 24, `AIT-294: no empty run taller than 24px: ${JSON.stringify(metric)}`);
      assert.deepEqual(metric.info, baseline, 'AIT-294: info line moves exactly 0px between model types');
      assert.equal(metric.slot[3], metric.slider[3], 'AIT-294: reservation is exactly the real slider height');
      if (evidence && locale === 'de' && theme === 'dark') await shot('ait294-de-dark-390', theme, `settings-${model}`);
    }
    for (const width of [599, 600, 1024]) {
      await page.setViewport({ width, height: 900 }); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.settings-overview').checkVisibility()), width >= 600,
        `AIT-294: gauges follow the exact 600px breakpoint at ${width}`);
    }
    await shadow(page, c => { c.shadowRoot.querySelector('dialog.settings .done').click(); window.ait294Settings = false; });
  }
  assert.equal(settings294Checks.length, 12, 'AIT-294: both model directions in each locale and palette');
  passLines.push('AIT-294 r2 PASS: Settings 390 DE/EN light/dark; empty runs <=24px; info line/model switch 0px; slider slot exact; gauges absent below 600px, retained at 600/1024.');
  // CI keeps its single light functional matrix. A second theme and PNGs are remote evidence only.
  // Keep native mouse emulation first: disabling touch resets hover on Linux.
  for (const touch of [false, true]) for (const theme of themes) {
    await page.select('#theme', theme);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    for (const locale of ['de', 'en']) for (const [width, height] of [[1440, 1000], [1280, 860], [390, 844]]) {
      const label = `${locale}-${width}x${height}-${touch ? 'touch' : 'mouse'}-${theme}`, copy = { de, en }[locale];
      // Match pause-phone's native desktop fixture: Puppeteer's viewport helper resets hover on Linux.
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      if (touch) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
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
      const legal = await shadow(page, c => {
        const links = [...c.querySelectorAll('[slot="legal"] a')], rects = links.map(a => a.getBoundingClientRect());
        return { oneLine: rects.length === 2 && rects[0].top === rects[1].top && links.every(a => a.getClientRects().length === 1),
          withinViewport: rects.every(r => r.left >= 0 && r.right <= innerWidth) };
      });
      assert.equal(legal.oneLine, true, `${label}: short legal links stay on one line`);
      assert.equal(legal.withinViewport, true);
      await shot(label, theme, 'entrance');
      // Hold the unmeasured CSS state: initial invalidates the custom property until the first measurement.
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24 } });
      await shadow(page, c => {
        const hold = document.createElement('style'); hold.id = 'pre-measure-hold';
        hold.textContent = '.workspace { --phone-footer:initial !important; }'; c.shadowRoot.append(hold);
      });
      await settle();
      const preMeasure = await shadow(page, c => {
        const style = getComputedStyle(c.shadowRoot.querySelector('.workspace'));
        return { footerVariable: style.getPropertyValue('--phone-footer').trim(), reserved: parseFloat(style.paddingBottom) };
      });
      assert.equal(preMeasure.footerVariable, '', 'the fallback, rather than the measured value, is active');
      assert.equal(preMeasure.reserved, 81, 'pre-measure fallback includes the 24px safe area exactly once');
      await shot(label, theme, 'entrance-pre-measure-24px');
      await shadow(page, c => {
        c.shadowRoot.querySelector('#pre-measure-hold').remove();
        // CDP inset changes alone do not emit a viewport resize; schedule the real first measurement.
        window.dispatchEvent(new Event('resize'));
      });
      await settle();
      const measured = await shadow(page, c => {
        const r = c.shadowRoot;
        return [parseFloat(getComputedStyle(r.querySelector('.workspace')).paddingBottom), r.querySelector('.display-foot').getBoundingClientRect().height];
      });
      assert.equal(measured[0], measured[1], 'measured reservation already contains the inset');
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0 } }); await settle();
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
      const announcement = await shadow(page, c => {
        const live = c.shadowRoot.querySelector('.composer-saved-announcement');
        return { role: live.getAttribute('role'), politeness: live.getAttribute('aria-live'), atomic: live.getAttribute('aria-atomic'),
          exposed: !live.hasAttribute('aria-hidden'), text: live.textContent, count: window.polish280Announcements.length };
      });
      assert.deepEqual(announcement, { role: 'status', politeness: 'polite', atomic: 'true', exposed: true, text: copy.saved, count: 1 });
      // Another successful send in the same burst must leave the live region quiet.
      await shadow(page, async c => {
        const r = c.shadowRoot, input = r.querySelector('textarea'); input.value = 'Another';
        input.dispatchEvent(new Event('input', { bubbles: true })); r.querySelector('form').requestSubmit();
        while (input.value) await new Promise(resolve => setTimeout(resolve, 10));
      });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer-saved-announcement').textContent), '');
      assert.equal(await page.evaluate(() => window.polish280Announcements.length), 1);

      // Timer duration is covered in units; observe a real expiry once per pointer mode.
      const expiryChecked = locale === 'de' && width === 1440;
      if (expiryChecked) {
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback').hasAttribute('data-saved'));
        assert.deepEqual(await boxes(page, selectors), before, `${label}: expiry shifts 0 px`);
      }
      const stateChecks = [];
      for (const state of ['upload-notice', 'retry', 'pause', 'failure']) {
        await configure(locale, 'live');
        const geometry = await boxes(page, ['.composer', '.send']);
        if (state === 'upload-notice' || state === 'failure') {
          await shadow(page, c => {
            const transfer = new DataTransfer(); transfer.items.add(new File(['x'], 'blocked.exe'));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          });
          await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-shortcut'));
        }
        if (state === 'retry') {
          // Retained retry storage only; the real three-attempt path is covered by units.
          const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("aithema-session")' });
          const { privateProperties } = await cdp.send('Runtime.getProperties', { objectId: result.objectId });
          await cdp.send('Runtime.callFunctionOn', { objectId: privateProperties.find(p => p.name === '#retryFiles').value.objectId,
            functionDeclaration: 'function() { this.push(new File(["x"], "retained.txt")); }' });
          await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
        }
        await settle();
        assert.deepEqual(await boxes(page, ['.composer', '.send']), geometry, `${label}: entering ${state} shifts composer/Send 0 px`);
        const noticeBefore = await shadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent);
        const result = await shadow(page, async (c, state) => {
          window.polish280State = state;
          const r = c.shadowRoot, input = r.querySelector('textarea'); input.value = 'Hello';
          r.querySelector('form').requestSubmit();
          while (r.querySelector('.send').disabled) await new Promise(resolve => setTimeout(resolve, 10));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { visibleSaved: r.querySelector('.composer-feedback').hasAttribute('data-saved'), savedText: r.querySelector('.composer-saved span').textContent,
            announcement: r.querySelector('.composer-saved-announcement').textContent, announcementCount: window.polish280Announcements.length,
            notice: r.querySelector('.composer-reason').textContent, paused: !r.querySelector('.composer-paused').hidden,
            warning: Boolean(r.querySelector('.composer-reason .question-status.warning svg')),
            failureVisible: r.querySelector('.composer-reason').checkVisibility({ opacityProperty: true, visibilityProperty: true }) };
        }, state);
        assert.equal(result.visibleSaved, false); assert.equal(result.savedText, '');
        assert.equal(result.announcement, state === 'failure' ? '' : copy.saved);
        assert.equal(result.announcementCount, state === 'failure' ? 0 : 1);
        if (state === 'pause') assert.equal(result.paused, true);
        else if (state === 'failure') { assert.equal(result.notice, copy.failed); assert.equal(result.failureVisible, true); assert.equal(result.warning, true); }
        else assert.equal(result.notice, noticeBefore);
        assert.deepEqual(await boxes(page, ['.composer', '.send']), geometry, `${label}: ${state} shifts composer/Send 0 px`);
        await shot(label, theme, state === 'failure' ? 'send-failure' : `saved-${state}`);
        if (state === 'failure') {
          const { result: component } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("aithema-session")' });
          const { privateProperties } = await cdp.send('Runtime.getProperties', { objectId: component.objectId });
          await cdp.send('Runtime.callFunctionOn', { objectId: privateProperties.find(p => p.name === '#retryFiles').value.objectId,
            functionDeclaration: 'function() { this.push(new File(["x"], "retained.txt")); }' });
          await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations })); await settle();
          const retained = await shadow(page, c => {
            const r = c.shadowRoot, line = r.querySelector('.composer-reason');
            return { text: line.textContent, actions: ['.upload-retry', '.upload-discard'].map(selector => {
              const n = line.querySelector(selector), b = n.getBoundingClientRect();
              return n.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && r.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === n;
            }), visibleSaved: r.querySelector('.composer-feedback').hasAttribute('data-saved') };
          });
          assert.equal(retained.text, `${copy.failed}${copy.uploads.tryAgain}\u00a0· ${copy.uploads.discard}`);
          assert.deepEqual(retained.actions, [true, true]); assert.equal(retained.visibleSaved, false);
          assert.deepEqual(await boxes(page, ['.composer', '.send']), geometry, `${label}: failure with retained upload shifts 0 px`);
          await shot(label, theme, 'failure-retained-upload');
          if (!touch && width === 390 && theme === 'light') {
            for (const failureTheme of ['light', 'dark']) for (const failureWidth of [320, 360, 390, 1440]) {
              await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: failureTheme }]);
              await cdp.send('Emulation.setDeviceMetricsOverride', { width: failureWidth, height: 900, deviceScaleFactor: 1, mobile: false }); await settle();
              const fit = await shadow(page, c => {
                const line = c.shadowRoot.querySelector('.composer-reason'), copy = line.querySelector('.upload-retry-copy'), actions = line.querySelector('.upload-retry-actions');
                const textRects = n => {
                  const range = document.createRange(); range.selectNodeContents(n);
                  return [...range.getClientRects()].filter(b => b.width > 1 && b.height > 1).map(b => [b.left,b.top,b.right,b.bottom]);
                };
                const detail = line.querySelector('.send-failure-detail'), hiddenDetail = getComputedStyle(detail).clipPath === 'inset(50%)';
                const sentenceRects = textRects(line.querySelector('.question-why')).concat(hiddenDetail ? [] : textRects(detail));
                const actionRects = textRects(actions);
                return { height: line.clientHeight, scrollHeight: line.scrollHeight, width: line.clientWidth, scrollWidth: line.scrollWidth,
                  copyHeight: copy.clientHeight, copyScrollHeight: copy.scrollHeight, hiddenDetail,
                  short: line.querySelector('.question-why').textContent, full: copy.textContent,
                  separate: sentenceRects.every(a => actionRects.every(b => a[3] <= b[1])),
                  actionsOneLine: actionRects.every(b => b[1] === actionRects[0][1]),
                  noTrailingSeparator: !copy.textContent.trimEnd().endsWith('·') && !actions.textContent.trimEnd().endsWith('·') };
              });
              const failureLabel = `ait294-${locale}-${failureTheme}-${failureWidth}-send-failure`;
              assert.ok(fit.scrollHeight <= fit.height && fit.copyScrollHeight <= fit.copyHeight, `${failureLabel}: no clipping ${JSON.stringify(fit)}`);
              assert.ok(fit.scrollWidth <= fit.width, `${failureLabel}: no horizontal clipping ${JSON.stringify(fit)}`);
              assert.equal(fit.separate, true, `${failureLabel}: no overlapping line boxes ${JSON.stringify(fit)}`);
              assert.equal(fit.actionsOneLine, true); assert.equal(fit.noTrailingSeparator, true);
              assert.equal(fit.hiddenDetail, failureWidth < 600); assert.equal(fit.short, copy.failedShort); assert.equal(fit.full, copy.failed);
              failure294Checks.push({ pass: true, label: failureLabel, ...fit });
              if (locale === 'de' && failureTheme === 'light' && [390,1440].includes(failureWidth)) await shot(failureLabel, failureTheme, 'retained-upload');
            }
            await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
            await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await settle();
          }

          await shadow(page, c => {
            window.polish280Verdict = { available: false, reason: 'current processing consent required' };
            c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
          });
          await until(page, () => Boolean(document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason .consent-action')));
          await settle();
          const blockedActions = await shadow(page, c => {
            const r = c.shadowRoot, line = r.querySelector('.composer-reason');
            return ['.upload-retry-copy .consent-action', '.upload-retry', '.upload-discard'].map(selector => {
              const n = line.querySelector(selector), b = n.getBoundingClientRect();
              return r.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === n;
            });
          });
          assert.deepEqual(blockedActions, [true, true, true], 'consent opener and retained upload actions stay reachable together');
          assert.deepEqual(await boxes(page, ['.composer', '.send']), geometry, `${label}: consent with retained upload shifts 0 px`);
          await shadow(page, c => c.shadowRoot.querySelector('.upload-discard').click()); await settle();
          const consent = await shadow(page, c => {
            const r = c.shadowRoot, n = r.querySelector('.composer-reason .consent-action'), b = n.getBoundingClientRect();
            return { text: r.querySelector('.composer-reason').innerText, sendDisabled: r.querySelector('.send').disabled,
              actionHit: r.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button') === n,
              visibleSaved: r.querySelector('.composer-feedback').hasAttribute('data-saved'),
              button: n.tagName, underline: getComputedStyle(n).textDecorationLine, hitHeight: parseFloat(getComputedStyle(n, '::after').height) };
          });
          assert.equal(consent.button, 'BUTTON'); assert.equal(consent.underline, 'underline');
          if (touch) assert.ok(consent.hitHeight >= 44);
          assert.equal(consent.text, `${copy.featureConsent.text}\u00a0· ${copy.featureConsent.action}`);
          assert.equal(consent.sendDisabled, true); assert.equal(consent.actionHit, true); assert.equal(consent.visibleSaved, false);
          assert.deepEqual(await boxes(page, ['.composer', '.send']), geometry, `${label}: failure then consent shifts 0 px`);
          await shot(label, theme, 'failure-then-consent');
          await shadow(page, c => {
            window.polish280Verdict = { available: true };
            c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
          });
          await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.send').disabled);
          assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), copy.failed);
          result.retained = retained; result.blockedActions = blockedActions; result.consent = consent; result.recovered = true;
        }
        stateChecks.push({ state, ...result, shiftPx: 0 });
      }
      await configure(locale, 'live', true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').checkVisibility()), true);
      await shot(label, theme, 'visuals-on');
      checks.push({ label, theme, pass: true, clearance, legal, saved, announcement, stateChecks, expiryChecked, preMeasure, measured, shiftPx: 0, visualsOffOn: true, platformKeys: ['MacIntel', 'Win32'], keyboardSkip: ['entrance', 'settings'] });
    }
    if (touch) {
      // Height-only changes use the same page and do not add screenshot or server cost.
      for (const width of [1280, 390]) for (const height of [600, 720, 900]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24 } }); await configure('de', 'entrance');
        assert.equal(await page.evaluate(() => scrollY), 0);
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await settle();
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.chooser__continue').getBoundingClientRect().bottom <= c.shadowRoot.querySelector('.display-foot').getBoundingClientRect().top), true);
        const safeArea = await shadow(page, c => {
          const r = c.shadowRoot, foot = r.querySelector('.display-foot');
          return { footerPadding: parseFloat(getComputedStyle(foot).paddingBottom), height: foot.getBoundingClientRect().height,
            reserved: parseFloat(getComputedStyle(r.querySelector('.workspace')).paddingBottom) };
        });
        assert.equal(safeArea.footerPadding, 30, '24px safe area is in the measured footer');
        assert.equal(safeArea.reserved, safeArea.height, 'safe area is reserved exactly once');
        checks.push({ label: `de-${width}x${height}-${theme}`, theme, pass: true, footerClear: true, safeArea });
      }
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0 } });
      passLines.push(`AIT-280 PASS: ${theme}; 12 locale/viewport/pointer cases; 3 footer heights at 390/1280 with 24px safe area; ${evidence ? 144 : 0} viewport captures.`);
    }
  }
  assert.deepEqual(problems, []); assert.equal(checks.length, 18 * themes.length);
  assert.equal(failure294Checks.length, 16, 'AIT-294: every phone/desktop failure width, locale and palette');
  if (evidence) assert.equal(shots.filter(s => !s.file.startsWith('ait294-')).length, 144 * themes.length);
  passLines.push('AIT-266 PASS: visuals absent/present; DE/EN, 1440/1280x860/390, touch/mouse.',
    'AIT-266 PASS: Mac/other keycaps; touch hint hidden; inline Saved 1600ms; composer/Send 0 px; 44 px Send.',
    'AIT-266 PASS: Custom and EU unavailable at entrance/Settings; arrow keys skip; Continue clears footer at all tested heights.');
  passLines.push('AIT-280 r2 PASS: blocking consent supersedes failure; Send recovers without stale failure; retained retry/discard stay visible; all transitions 0 px.',
    'AIT-280 r2 PASS: pre-measure fallback 81px at 24px inset; measured reservation equals footer height with no second inset.');
  passLines.push('AIT-280 PASS: polite live-region reads count 1 for two saves within 10s; no typing announcements; text clears on hide.',
    'AIT-280 PASS: upload notice, retry and pause win visually; saved confirmation remains assistive-only; failure replaces hint/notice.',
    'AIT-280 PASS: composer/Send shift 0 px in every new state; short host legal links stay on one line at 390px.');
  passLines.push('AIT-294 PASS: 320/360/390/1440 DE/EN light/dark send failure; short phone copy, full polite sentence, separate actions, no trailing separator, clipping or overlapping line boxes.');
  passLines.push('AIT-286 PASS: send failure and retained-upload failure share warning glyph/ink; consent opener underlined, native button, 44px coarse hit area; all transitions 0 px.');
  for (const line of passLines) console.log(line);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true,
    blurredControls: true, fonts: 'Chrome baseline UI/display stacks pinned', themes, passLines, checks: [...checks, ...failure294Checks, ...settings294Checks], shots }, null, 2) + '\n');
}
