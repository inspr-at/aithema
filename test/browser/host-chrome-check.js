// AIT-260: one page, in-place states; screenshots only in the remote evidence matrix.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fullMatrix } from './matrix-coverage.js';
import { captureEvidence, evidenceBrowserArgs, evidenceCommit, shadow, until } from './start2-display-helpers.js';

export async function hostChromeCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-host-chrome-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile(fullMatrix ? { args: evidenceBrowserArgs } : {}), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const accessibility = await page.createCDPSession();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const footerResponses = { catalog: 0, features: 0 };
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith('/settings')) footerResponses.catalog++;
    if (path.endsWith('/features')) footerResponses.features++;
  });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.chromeSeed = c.session; });
  const evidence = fullMatrix && join(process.env.AITHEMA_EVIDENCE_DIR, 'ait260-round4');
  if (evidence) await mkdir(evidence, { recursive: true });
  const checks = [];
  const settle = () => shadow(page, async c => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  });
  const shot = async label => {
    if (!evidence) return;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle();
    const { png } = await captureEvidence(page);
    await writeFile(join(evidence, `${label}.png`), png);
  };
  // No provider calls: paused snapshots, ack and refreshed verdicts stay in-page.
  await shadow(page, c => {
    const nativeFetch = window.fetch;
    window.fetch = (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path.endsWith('/events') && window.footerConnectionGate) {
        return window.footerConnectionGate.then(() => nativeFetch(url, init));
      }
      if (path.endsWith('/pause')) {
        window.resumeBody = JSON.parse(init.body);
        return new Promise(resolve => { window.ackResume = () => resolve(Response.json({ event: {
          seq: c.session.seq + 1, type: 'session.paused', data: { paused: false },
        } })); });
      }
      if (/\/api\/sessions\/[^/]+$/u.test(path)) {
        const session = c.session;
        if (!session.paused) session.featureMatrix.best.text = { available: true };
        return Promise.resolve(Response.json(session));
      }
      return nativeFetch(url, init);
    };
  });
  const scene = async ({ locale = 'de', voice = false, brandMode = 'start', paused = false } = {}) => {
    await shadow(page, async (c, { locale, voice, brandMode, paused }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.chromeSeed);
      session.locale = locale; session.paused = paused; session.pauseReason = null;
      session.settings.origin = 'chosen'; session.processingPreset = 'best';
      session.transcript = [{ id: 'r3-user', role: 'user', content: locale === 'de' ? 'Wir möchten unsere Abläufe verbessern.' : 'We want to improve our workflow.' },
        { id: 'r3-reply', role: 'assistant', content: locale === 'de' ? 'Welcher Ablauf kostet heute am meisten Zeit?' : 'Which workflow takes the most time today?' }];
      session.featureMatrix.best = { text: paused ? { available: false, reason: 'session paused', unpaused: { available: true } } : { available: true }, voice: { available: false }, analysis: { available: true } };
      c.querySelectorAll('[slot="brand"]').forEach(n => n.remove());
      const brand = document.createElement('h1'); brand.slot = 'brand';
      brand.textContent = brandMode === 'long' ? 'START · Augmentoring — a deliberately very long host brand for truncation' : 'START'; c.append(brand);
      // Match the existing host matrix's legal slot rather than the demo's long license footer.
      c.querySelectorAll('[slot="legal"], [slot="footer"]').forEach(n => n.remove());
      const legal = document.createElement('nav'); legal.slot = 'legal'; legal.style.cssText = 'display:flex;gap:0';
      for (const [href, text] of [['/imprint', locale === 'de' ? 'Impressum' : 'Imprint'], ['/privacy', locale === 'de' ? 'Datenschutz' : 'Privacy']]) {
        const a = document.createElement('a'); a.href = href; a.textContent = text;
        a.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:inherit;text-decoration:underline;text-underline-offset:3px'; legal.append(a);
      }
      c.append(legal);
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.setAttribute('motion', 'off'); c.configure({ copy, session, voiceClient: voice ? {} : undefined, host: { library: true } });
      document.documentElement.lang = locale; scrollTo(0, 0);
    }, { locale, voice, brandMode, paused });
    await settle();
  };
  // Keep content in-page: assertion diagnostics contain only geometry, lengths and booleans.
  const footerSnapshot = async (baseline = false) => ({ ...await shadow(page, (c, baseline) => {
    const r = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
    const content = Object.fromEntries(['.engine__value', '.engine__detail', '.features', '.status__label'].map(selector => [selector, r.querySelector(selector).textContent]));
    if (baseline) window.footerBefore = content;
    const changed = selector => content[selector] !== window.footerBefore[selector];
    const describe = n => ({ name: n.className, box: box(n), textLength: n.textContent.length, hidden: n.hidden });
    return {
      children: [...r.querySelector('.footer-right').children].map(n => ({ ...describe(n), children: [...n.children].map(describe) })),
      catalogOrServedLabelChanged: changed('.engine__value') || changed('.engine__detail'),
      servedLabelResolved: !window.footerBefore['.engine__detail'] && Boolean(content['.engine__detail']),
      featuresChanged: changed('.features'), featuresResolved: !window.footerBefore['.features'] && Boolean(content['.features']),
      statusChanged: changed('.status__label'), statusLabel: describe(r.querySelector('.status__label')),
    };
  }, baseline), responses: { ...footerResponses } });
  const composerBoxes = () => shadow(page, c => ['.composer', 'textarea', '.send'].map(selector => {
    const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
  }));
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.select('#theme', theme);
    await scene({ locale });
    const baseline = await composerBoxes(), resume = locale === 'de' ? 'Fortsetzen' : 'Resume';
    for (const cause of ['restore', 'blur', 'limits']) for (const control of ['.composer-resume', '.send']) {
      if (cause === 'restore') await scene({ locale, paused: true });
      else await shadow(page, (c, reason) => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason } }), cause);
      await settle();
      const label = `${locale}-${theme}-${width}-${cause}-${control.slice(1)}`;
      const state = await shadow(page, c => {
        const r = c.shadowRoot, button = r.querySelector('.composer-resume'), send = r.querySelector('.send');
        // Resolve Send's base colour token without its pointer-dependent hover tint.
        const primary = document.createElement('span'); primary.style.color = 'var(--aithema-accent)'; r.append(primary);
        const primaryColor = getComputedStyle(primary).color; primary.remove();
        r.querySelector('textarea').value = 'Unsent draft';
        return { disabled: r.querySelector('textarea').disabled, line: r.querySelector('.composer-paused span').textContent,
          visible: r.querySelector('.composer-paused').checkVisibility(), resume: button.textContent, label: send.getAttribute('aria-label'), title: send.title,
          targets: [button, send].map(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]),
          resumeColor: getComputedStyle(button).color, primaryColor,
          resumeWeight: getComputedStyle(button).fontWeight, pausedColor: getComputedStyle(r.querySelector('.composer-paused span')).color,
          restoreFocus: r.activeElement === button, active: r.activeElement?.className ?? null, documentActive: document.activeElement?.tagName, inert: r.querySelector('form').inert, resumeDisabled: button.disabled };
      });
      assert.equal(state.disabled, true); assert.equal(state.visible, true);
      assert.equal(state.resumeColor, state.primaryColor, `${label}: primary teal`);
      assert.equal(state.resumeWeight, '500', `${label}: medium weight`);
      assert.notEqual(state.pausedColor, state.resumeColor, `${label}: paused copy stays muted`);
      assert.equal(state.line, locale === 'de' ? 'Gespräch pausiert.' : 'Conversation paused.');
      assert.equal(state.resume, resume); assert.equal(state.label, resume); assert.equal(state.title, resume);
      assert.ok(state.targets.every(([w, h]) => w >= 44 && h >= 44), `${label}: 44 px controls`);
      if (cause === 'restore') assert.equal(state.restoreFocus, true, `${label}: ${JSON.stringify(state)}`);
      assert.deepEqual(await composerBoxes(), baseline, `${label}: paused composer/field/Send 0 px`);
      if (cause === 'restore' && control === '.composer-resume') await shot(`${locale}-${theme}-${width}-paused`);
      await page.click(`aithema-session >>> ${control}`);
      assert.equal(await shadow(page, c => c.session.paused), true, 'wait for acknowledgement');
      assert.deepEqual(await page.evaluate(() => window.resumeBody), { paused: false });
      await page.evaluate(() => window.ackResume());
      await until(page, () => {
        const c = document.querySelector('aithema-session'), r = c.shadowRoot;
        return !c.session.paused && !r.querySelector('textarea').disabled && r.activeElement === r.querySelector('textarea');
      });
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('textarea').value), 'Unsent draft');
      assert.deepEqual(await composerBoxes(), baseline, `${label}: resumed composer/field/Send 0 px`);
      checks.push({ pass: true, label, composerShiftPx: 0, sendShiftPx: 0, acknowledgedResume: true, fieldFocused: true, resumeColor: state.resumeColor, primaryColor: state.primaryColor, resumeWeight: state.resumeWeight, pausedColor: state.pausedColor });
    }
    // Pre-live status is outside the popup and remains an exposed live region.
    await scene({ locale });
    await shadow(page, async c => {
      const session = c.session; session.transcript = []; session.settings.origin = null;
      const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ copy, session, host: { library: true } });
    });
    await settle();
    const { result } = await accessibility.send('Runtime.evaluate', { expression: 'document.querySelector("aithema-session").shadowRoot.querySelector(".status")' });
    const { node } = await accessibility.send('DOM.describeNode', { objectId: result.objectId });
    const { nodes } = await accessibility.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId });
    await accessibility.send('Runtime.releaseObject', { objectId: result.objectId });
    const liveRegion = nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
    assert.equal(liveRegion?.ignored, false); assert.equal(liveRegion?.role?.value, 'status');
    const a11y = await shadow(page, c => {
      const r = c.shadowRoot, status = r.querySelector('.status');
      return { display: getComputedStyle(status).display, visibility: getComputedStyle(status).visibility,
        role: status.getAttribute('role'), name: r.querySelector('.ai-notice').getAttribute('aria-label') };
    });
    assert.notEqual(a11y.display, 'none'); assert.equal(a11y.visibility, 'visible'); assert.equal(a11y.role, 'status');
    assert.ok(a11y.name.includes(locale === 'de' ? 'KI' : 'AI'));
    checks.push({ pass: true, label: `${locale}-${theme}-${width}-a11y`, liveRegionExposed: !liveRegion.ignored, ...a11y });
  }
  for (const brandMode of ['start', 'long']) {
    await page.setViewport({ width: 1440, height: 1000 }); await page.select('#theme', 'light');
    await scene({ voice: true, brandMode });
    for (let width = 320; width <= 1440; width += 40) {
      await page.setViewport({ width, height: 1000 }); await settle();
      const fit = await shadow(page, c => {
        const r = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
        const rail = box(r.querySelector('.audio-rail'));
        const others = [r.querySelector('.band-identity'), ...r.querySelectorAll('.header-actions, .header-actions button, .host-account')].map(box);
        const pageOverflowPx = Math.max(0, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth);
        const overflowElements = pageOverflowPx ? [...document.querySelectorAll('*'), ...r.querySelectorAll('*')]
          .filter(n => n.getBoundingClientRect().right > innerWidth && n.checkVisibility())
          .map(n => ({ name: n.className || n.localName, parent: n.parentElement?.className, ...box(n), overflowX: getComputedStyle(n).overflowX, text: n.textContent.trim().slice(0, 60) })) : [];
        return { rail, others, row: r.querySelector('.band').hasAttribute('data-rail-row'), pageOverflowPx, overflowElements,
          railOverflowPx: Math.max(0, rail.right - innerWidth, -rail.left) };
      });
      assert.ok(fit.rail.width >= 208, `${brandMode}/${width}: rail minimum 208 px`);
      assert.equal(fit.pageOverflowPx, 0, `${brandMode}/${width}: no page-wide horizontal overflow ${JSON.stringify(fit)}`);
      assert.equal(fit.railOverflowPx, 0, `${brandMode}/${width}: no rail overflow`);
      assert.ok(fit.rail.left >= 0 && fit.rail.right <= width, `${brandMode}/${width}: rail stays in viewport ${JSON.stringify(fit)}`);
      for (const b of fit.others) assert.ok(fit.rail.right <= b.left || fit.rail.left >= b.right || fit.rail.bottom <= b.top || fit.rail.top >= b.bottom,
        `${brandMode}/${width}: rail intersects brand/action ${JSON.stringify(fit)}`);
      checks.push({ pass: true, label: `${brandMode}-${width}-rail-fit`, ...fit });
      if ([320, 360].includes(width) && brandMode === 'start') {
        await page.click('aithema-session >>> .band-orb [role="button"]'); await settle();
        const reveal = await shadow(page, c => {
          const r = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
          const overflowPx = Math.max(0, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth);
          return { open: r.querySelector('.band').dataset.aithemaRevealState === 'open', overflowPx,
            overflowElements: overflowPx ? [...document.querySelectorAll('*'), ...r.querySelectorAll('*')]
              .filter(n => n.getBoundingClientRect().right > innerWidth && n.checkVisibility())
              .map(n => ({ name: n.className || n.localName, box: box(n), opacity: getComputedStyle(n).opacity, transform: getComputedStyle(n).transform })) : [],
            targets: [...r.querySelectorAll('.aithema-reveal__link')].map(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]),
            titles: [...r.querySelectorAll('.aithema-reveal__title')].map(box),
            parts: [...r.querySelectorAll('.aithema-reveal__wordmark, .aithema-reveal__version, .aithema-reveal__link')].map(box) };
        });
        assert.equal(reveal.open, true, `${width}px reveal opens by activation`); assert.equal(reveal.overflowPx, 0, `${width}px open reveal: ${JSON.stringify(reveal)}`);
        assert.ok(reveal.targets.every(([w, h]) => w >= 44 && h >= 44), `${width}px reveal keeps 44px link targets`);
        const links = reveal.parts.slice(1, -1);
        assert.ok(links.every(b => b[1] === links[0][1] && b[1] > reveal.parts[0][3]), `${width}px reveal links retain one row below the wordmark: ${JSON.stringify(reveal)}`);
        for (const [i, title] of reveal.titles.entries()) assert.ok(title[0] >= links[i][0] && title[2] <= links[i][2] && title[2] <= width,
          `${width}px reveal title fits its target without clipping: ${JSON.stringify(reveal)}`);
        for (const [i, a] of reveal.parts.entries()) for (const b of reveal.parts.slice(i + 1))
          assert.ok(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3], `${width}px reveal items intersect: ${JSON.stringify(reveal)}`);
        checks.push({ pass: true, label: `${width}-open-reveal`, ...reveal });
        await page.keyboard.press('Escape'); await settle();
      }
    }
    await page.setViewport({ width: 700, height: 1000 }); await settle(); await shot(`de-light-700-voice-${brandMode}`);
  }
  console.log('AIT-260 PASS: 48 paused composer cases (restore/blur/limits, both controls, DE/EN, light/dark, 1440/390), acknowledged resume and focus, composer/Send 0 px; 58 rail-fit cases 320–1440; phone status and KI/AI accessible name.');
  for (const locale of ['de', 'en']) for (const width of fullMatrix ? [1440, 1024, 390] : [1440, 390]) {
    await page.setViewport({ width, height: width < 600 ? 844 : 1000 });
    for (const theme of fullMatrix ? ['light', 'dark'] : ['light']) {
      await page.select('#theme', theme);
      const heights = [];
      for (const brandMode of fullMatrix ? ['start', 'none', 'long'] : ['start']) {
      for (const voice of [false, true]) {
        await shadow(page, async (c, { locale, voice, brandMode }) => {
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
          // Hold a real transport response until interaction: a visitor can open
          // the notice while connecting, independently of catalog/feature paint.
          window.footerConnectionGate = new Promise(resolve => { window.connectFooter = resolve; });
          const session = structuredClone(window.chromeSeed); session.locale = locale; session.transcript = []; session.uploads = [];
          session.settings.voice = voice ? 'offered' : 'off';
          session.engine.voice = { id: voice ? 'offered' : 'off', offered: voice, label: 'Local evidence' };
          session.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: voice, reason: voice ? null : 'not configured' } };
          c.querySelectorAll('[slot="legal"], [slot="brand"], [slot="footer"]').forEach(n => n.remove());
          const brand = document.createElement('h1'); brand.slot = 'brand'; brand.textContent = brandMode === 'long' ? 'START · Augmentoring — a deliberately very long host brand for truncation' : '  START\n  ';
          const legal = document.createElement('nav'); legal.slot = 'legal'; legal.style.cssText = 'display:flex;gap:0';
          for (const [href, text] of [['/imprint', locale === 'de' ? 'Impressum' : 'Imprint'], ['/privacy', locale === 'de' ? 'Datenschutz' : 'Privacy']]) {
            const a = document.createElement('a'); a.href = href; a.textContent = text; a.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:inherit;text-decoration:underline;text-underline-offset:3px'; legal.append(a);
          }
          if (brandMode !== 'none') c.append(brand);
          c.append(legal);
          c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
          c.setAttribute('motion', 'off');
          c.configure({ copy, session, voiceClients: voice ? { offered: { manifest } } : {}, host: { library: true, version: { version: '261017010000.0.0', version_scheme: 'inspr-calver-3', commit: 'abcdef1234' } } });
          document.documentElement.lang = locale; scrollTo(0, 0);
        }, { locale, voice, brandMode });
        await settle();
        const label = `${locale}-${theme}-${width}-${voice ? 'voice' : 'no-voice'}-${brandMode}`;
        for (const stage of ['entrance', 'ready', 'conversation']) {
          if (stage === 'ready') await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...c.session.settings, origin: 'chosen', revision: 1 } } }));
          if (stage === 'conversation') await shadow(page, c => {
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'u', role: 'user', content: c.session.locale === 'de' ? 'Wir verlieren jede Woche Stunden beim Abgleich von Eingangsrechnungen.' : 'We lose hours every week reconciling incoming invoices.' } });
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: c.session.locale === 'de' ? 'Eine Freigabe, die oft eine Woche dauert, ist ein guter Ansatzpunkt. Wer gibt heute frei, und woran hängt es meistens?' : 'An approval that often takes a week is a good starting point. Who approves it today, and what usually holds it up?', inputRevision: 1 } });
          });
          await settle();
          const metrics = await shadow(page, (c, voice) => {
            const r = c.shadowRoot, brand = c.querySelector('[slot="brand"]'), legal = c.querySelector('[slot="legal"]');
            const visible = n => n.checkVisibility({ checkVisibilityCSS: true });
            const footer = r.querySelector('.display-foot').getBoundingClientRect(), links = [...legal.querySelectorAll('a')];
            const absent = '.audio-rail, .pause, .voice-start, .voice-input, .voice-output, .ai-notice__voice, .ready__mode[data-mode="voice"], [data-ready="microphone"], [data-ready="speaker"], .voice-repeat, .voice-read-text, .voice-reply-actions';
            const content = r.querySelector('.workspace');
            const timer = r.querySelector('.connection-timer');
            return { height: r.querySelector('.band').getBoundingClientRect().height, h1: document.querySelectorAll('h1').length + r.querySelectorAll('h1').length,
              brand: Boolean(brand && visible(brand)), brandHeight: brand?.getBoundingClientRect().height ?? 0, brandLabel: r.querySelector('.host-version__label').textContent,
              product: r.querySelector('.display-version').textContent, noVoice: !r.querySelector(absent),
              voice: Boolean(r.querySelector('.voice-start') && r.querySelector('.pause')),
              claim: /synthetische Stimme|synthetic voice|Text lesen|Read text/u.test(content.textContent),
              legal: links.every(n => { const b = n.getBoundingClientRect(); return visible(n) && b.left >= 0 && b.right <= innerWidth && b.top >= footer.top && b.bottom <= footer.bottom; }),
              timerPopup: Boolean(timer.closest('.footer-info .footer-popup')),
              footerOverflow: r.querySelector('.display-foot__row').scrollWidth > r.querySelector('.display-foot__row').clientWidth,
              overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
              brandFont: getComputedStyle(r.querySelector('.wordmark')).fontSize,
              brandWeight: getComputedStyle(r.querySelector('.wordmark')).fontWeight,
            };
          }, voice);
          heights.push(metrics.height);
          assert.equal(metrics.height, width < 600 ? voice ? 124 : 68 : 90, `${label}/${stage}: approved header height`);
          assert.equal(metrics.h1, brandMode === 'none' ? 0 : 1, `${label}/${stage}: only the host page h1`); assert.equal(metrics.brand, brandMode !== 'none'); assert.ok(metrics.brandHeight <= 44, `${label}/${stage}: brand uses existing wordmark typography`);
          assert.equal(metrics.brandLabel, brandMode === 'none' ? 'Host' : brandMode === 'start' ? 'START' : 'START · Augmentoring — a deliberately very long host brand for truncation');
          assert.equal(metrics.brandFont, width < 600 ? '16.5px' : '18px'); assert.equal(metrics.brandWeight, '400');
          assert.equal(metrics.overflowPx, 0, `${label}/${stage}: horizontal overflow 0 px`); assert.equal(metrics.product, 'Aithema 2026.10');
          assert.equal(metrics.legal, true, `${label}/${stage}: legal links visible in bar`);
          assert.equal(metrics.footerOverflow, false, `${label}/${stage}: footer fits`);
          assert.equal(metrics.timerPopup, width < 600);
          if (voice) assert.equal(metrics.voice, true); else { assert.equal(metrics.noVoice, true); assert.equal(metrics.claim, false); }
          // One activation/tab from the conversation or entrance; no popup prerequisite.
          await shadow(page, c => c.querySelector('[slot="legal"] a').focus());
          assert.equal(await shadow(page, c => document.activeElement === c.querySelector('[slot="legal"] a')), true);
          await page.keyboard.press('Tab');
          assert.equal(await shadow(page, c => document.activeElement === c.querySelectorAll('[slot="legal"] a')[1]), true);
          await page.evaluate(() => {
            window.legalClicked = null;
            document.querySelector('[slot="legal"]').addEventListener('click', e => { e.preventDefault(); window.legalClicked = e.target.getAttribute('href'); }, { once: true });
          });
          await page.click('[slot="legal"] a');
          assert.equal(await page.evaluate(() => window.legalClicked), '/imprint');
          checks.push({ label, stage, ...metrics });
          if (stage !== 'ready') await shot(`${label}-${stage}`);
        }
        // Opening either overlay must preserve all host-frame/content boxes.
        const frame = () => shadow(page, c => ['.band', '.band-identity', '.header-actions', '.conversation', '.display-foot', '.footer-right'].map(selector => {
          const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        }));
        const baseline = await frame(), footerBefore = await footerSnapshot(true);
        await page.click('aithema-session >>> .ai-notice');
        await page.evaluate(() => window.connectFooter());
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
        await settle();
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-version').checkVisibility({ checkVisibilityCSS: true })), true);
        if (width < 600) assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.phone-status').checkVisibility({ checkVisibilityCSS: true })), true);
        assert.deepEqual(await frame(), baseline, `${label}: popup opens with 0 px movement ${JSON.stringify({ before: footerBefore, after: await footerSnapshot() })}`);
        await shot(`${label}-popup`);
        await page.keyboard.press('Escape');
        await page.click('aithema-session >>> .conversations-toggle'); await settle();
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), false);
        assert.deepEqual(await frame(), baseline, `${label}: menu opens with 0 px movement ${JSON.stringify({ before: footerBefore, after: await footerSnapshot() })}`);
        assert.equal(await shadow(page, c => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0);
        await shot(`${label}-menu`);
        checks.push({ label, popupShiftPx: 0, menuShiftPx: 0 });
        await page.keyboard.press('Escape');
      }
      }
      if (width >= 600) assert.equal(new Set(heights).size, 1, `${locale}/${theme}/${width}: header difference 0 px across voice and stages`);
      checks.push({ locale, theme, width, headerHeights: [...new Set(heights)], voiceHeightDifferencePx: Math.max(...heights) - Math.min(...heights) });
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, designSha256: '9f5f9df4cf67d3ef4a89f0fa246d76e93a86613837346afc1cd397d8c78d1109', capture: 'viewport', reducedMotion: true, blurredControls: true, passLines: ['PASS: 48 paused composer cases; acknowledged resume, draft preserved, field focused; composer/Send 0 px', 'PASS: Tick resume uses primary teal and medium weight; paused copy stays muted; 44 px controls', 'PASS: 58 rail-fit cases; 320–1440 px in 40 px steps; normal/long brand; no intersections or page-wide horizontal overflow', 'PASS: DE/EN light/dark 1440/390 live status exposed to accessibility; KI/AI in accessible name', 'PASS: existing host chrome matrix; popup/menu displacement 0 px'], checks: checks.map(check => ({ pass: true, ...check })) }, null, 2));
}
