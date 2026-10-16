// AIT-131 evidence: the real reference page and component, with deterministic display snapshots and local voice.
// No provider calls, microphone, wallet writes or voice lifecycle work. Run only on the remote browser runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, fullMatrix, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { pixels, samePaint } from './png-pixels.js';
import { mockIdentityReads, shadow, until, boxes, layoutBoxes, statusGeometry, sameBoxes, finishRevealEntry, finishWorkspaceEntry, freezeRevealExit, seekReveal, evidenceCommit, evidenceBrowserArgs } from './start2-display-helpers.js';

// Observe completed rendering instead of paying a fixed 120ms after every
// state. Timed reveal checks still own their explicit animation clocks.
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
    .filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime))
    .map(a => a.finished.catch(() => {})));
});

// CI keeps every assertion, including paint samples. Evidence-only captures run
// separately on the remote runner (or nightly) without spending PR runner time.
const evidenceDirectory = fullMatrix ? process.env.AITHEMA_EVIDENCE_DIR : undefined;

test('AIT-265/AIT-267: curated option labels and generic unknown served routes, DE/EN', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-host-model-label-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(evidenceDirectory ? { args: evidenceBrowserArgs } : {}), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => {
    window.hostModelSeed = c.session;
    const fetch = window.fetch;
    window.fetch = async (url, init = {}) => {
      const response = await fetch(url, init);
      if ((init.method ?? 'GET') !== 'GET' || !new URL(url, location.href).pathname.endsWith('/settings')) return response;
      await window.hostModelCatalogGate;
      const catalog = await response.json();
      catalog.processingPreset = 'best'; catalog.settings = c.session.settings; catalog.engine = c.session.engine;
      catalog.presets.best.models = [{ ...catalog.presets.best.models[0], id: 'default', label: 'Anthropic via OpenRouter' }];
      return Response.json(catalog);
    };
  });
  const shot = async (locale, state, hover = false) => {
    if (!evidenceDirectory) return;
    await mkdir(evidenceDirectory, { recursive: true });
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1);
    if (hover) await page.hover('aithema-session >>> .engine-info');
    await settle(page);
    const selector = state === 'ready' ? '[data-ready="model"] dd > span:last-child'
      : hover ? '.engine__detail' : '[data-select="model"] .select__value';
    const target = await shadow(page, (c, selector) => {
      const text = c.shadowRoot.querySelector(selector), range = document.createRange(); range.selectNodeContents(text);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        ink: getComputedStyle(text).color.match(/\d+/gu).slice(0, 3).map(Number) };
    }, selector);
    // Reconfigured shadow trees can leave a stale compositor tile for one capture.
    let png, inkPixels = 0;
    for (let attempt = 0; attempt < 3 && inkPixels < 20; attempt++) {
      await settle(page);
      png = Buffer.from(await page.screenshot({ fullPage: false, captureBeyondViewport: false }));
      const paint = pixels(png); inkPixels = 0;
      for (let y = Math.max(0, Math.ceil(target.top)); y < Math.min(paint.height, target.bottom); y++) {
        for (let x = Math.max(0, Math.ceil(target.left)); x < Math.min(paint.width, target.right); x++) {
          const offset = (y * paint.width + x) * paint.channels;
          if (target.ink.every((value, channel) => Math.abs(paint.result[offset + channel] - value) <= 24)) inkPixels++;
        }
      }
    }
    assert.ok(inkPixels >= 20, `${locale}/${state}: captured model label glyphs (${inkPixels} ink pixels)`);
    await writeFile(join(evidenceDirectory, `ait267-${locale}-${state}.png`), png);
  };
  for (const [locale, copy] of [['de', de], ['en', en]]) {
    const expected = copy.catalogLabels['Anthropic via OpenRouter'];
    await shadow(page, async (c, locale) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      window.hostModelCatalogGate = new Promise(resolve => { window.releaseHostModelCatalog = resolve; });
      const session = structuredClone(window.hostModelSeed);
      session.locale = locale; session.transcript = []; session.concepts = [];
      session.settings = { ...session.settings, origin: 'chosen', model: 'default', effort: 'none', voice: 'off', visuals: 'off' };
      session.engine = { preset: 'best', model: { id: 'default', label: 'Anthropic via OpenRouter', reply: 'host/private-reply', understanding: 'host/private-understanding' }, effort: 'none', voice: 'off', visuals: 'off' };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ copy, session }); document.documentElement.lang = locale;
    }, locale);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('[data-ready="model"] dd > span:last-child').textContent), expected);
    await shot(locale, 'ready');
    await page.hover('aithema-session >>> .engine-info'); await settle(page);
    const footer = await shadow(page, c => {
      const detail = c.shadowRoot.querySelector('.engine__detail');
      return { visibility: getComputedStyle(detail).visibility, lines: detail.textContent.split('\n') };
    });
    assert.equal(footer.visibility, 'visible');
    // AIT-267: intended behaviour change per Tick; unknown served routes no longer inherit the option label.
    assert.equal(footer.lines[1], `${copy.display.reply}: ${copy.display.modelUnknown}`);
    assert.equal(footer.lines[2], `${copy.display.understanding}: ${copy.display.modelUnknown}`);
    await shot(locale, 'footer-hover', true);
    await page.click('aithema-session >>> .settings-open');
    await settle(page);
    assert.deepEqual(await shadow(page, c => {
      const select = c.shadowRoot.querySelector('[data-select="model"]');
      return [select.querySelector('.select__value').textContent, select.querySelector('.select__button').disabled,
        select.querySelectorAll('[role="option"]').length];
    }), [copy.settings.loadingOption, true, 0], `${locale}: no provisional model label before the catalog`);
    const controls = ['.settings__frame', '[data-select="model"] .select__button', '.effort-area', '.settings-context', '.done'];
    const loadingBoxes = await boxes(page, controls);
    await shadow(page, () => window.releaseHostModelCatalog());
    await until(page, expected => {
      const select = document.querySelector('aithema-session').shadowRoot.querySelector('[data-select="model"]');
      return select?.querySelector('.select__value').textContent === expected &&
        select.querySelector('[data-value="default"] strong')?.textContent === expected;
    }, expected);
    await settle(page);
    assert.deepEqual(await boxes(page, controls), loadingBoxes, `${locale}: catalog arrival causes 0px layout shift`);
    assert.deepEqual(await shadow(page, c => {
      const select = c.shadowRoot.querySelector('[data-select="model"]');
      return [select.querySelector('.select__value').textContent, select.querySelector('[data-value="default"] strong').textContent];
    }), [expected, expected]);
    await page.click('aithema-session >>> [data-select="model"] .select__button');
    await shot(locale, 'settings-select');
    await page.click('aithema-session >>> dialog.settings .done');
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  }
});

test('AIT-270: host-country wording and usable privacy-policy links, DE/EN', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-provider-seats-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(evidenceDirectory ? { args: evidenceBrowserArgs } : {}), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => {
    window.seatsSeed = c.session;
    const fetch = window.fetch;
    window.fetch = async (url, init = {}) => {
      if ((init.method ?? 'GET') === 'GET' && new URL(url, location.href).pathname.endsWith('/settings')) {
        const catalog = await (await fetch(url, init)).json();
        catalog.settings = c.session.settings; catalog.engine = c.session.engine;
        catalog.presets.best.models = [{ ...catalog.presets.best.models[0], id: 'default',
          facts: { ...catalog.presets.best.models[0].facts, hostCountries: window.seatsCountries, hostTraining: true } }];
        return Response.json(catalog);
      }
      return fetch(url, init);
    };
  });
  for (const [locale, copy] of [['de', de], ['en', en]]) for (const linked of [false, true]) {
    await page.setViewport({ width: 1440, height: 1000 });
    await shadow(page, async (c, locale, linked) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.seatsSeed);
      session.locale = locale; session.settings = { ...session.settings, model: 'default', voice: 'off', visuals: 'off' };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      window.seatsCountries = linked ? ['US', 'IE'] : ['US'];
      c.querySelectorAll('[slot="legal"]').forEach(node => node.remove());
      if (linked) c.insertAdjacentHTML('beforeend', '<nav slot="legal"><a data-aithema-privacy href="/host-privacy">Host document</a></nav>');
      c.configure({ copy, session }); document.documentElement.lang = locale; c.openSettings();
    }, locale, linked);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-gauge="privacy"]').dataset.state === 'hostCountries');
    const names = locale === 'de' ? linked ? 'USA und Irland' : 'USA' : linked ? 'the US and Ireland' : 'the US';
    const caption = copy.gauges.short.privacy.hostCountries.replace('{countries}', names);
    await page.focus('aithema-session >>> [data-gauge="privacy"]');
    const state = await shadow(page, c => {
      const root = c.shadowRoot, gauge = root.querySelector('[data-gauge="privacy"]'), help = root.querySelector('.context-message');
      return { caption: gauge.querySelector('.gauge__detail').textContent, help: help.textContent, href: help.querySelector('a')?.getAttribute('href') ?? null };
    });
    assert.equal(state.caption, caption);
    assert.ok(state.help.endsWith(copy.gauges.details.privacy.hostCountries.replace('{countries}', names)));
    assert.equal(state.href, linked ? `${demo.url}/host-privacy` : null);
    assert.doesNotMatch(state.help, /beschränkt auf|restricted to|limited to|ohne Training|no training/iu);
    if (linked) {
      await page.keyboard.press('Tab');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.textContent), copy.gauges.privacyPolicy);
      await shadow(page, c => c.shadowRoot.querySelector('.context-message a').addEventListener('click', event => { event.preventDefault(); window.seatsPolicyClicked = true; }));
      await page.hover('aithema-session >>> [data-gauge="privacy"]');
      await page.click('aithema-session >>> .context-message a');
      assert.equal(await page.evaluate(() => window.seatsPolicyClicked), true);
    }
    if (evidenceDirectory) for (const width of linked ? [1440, 390] : [1440]) {
      await mkdir(evidenceDirectory, { recursive: true });
      await page.setViewport({ width, height: 1000 });
      await page.mouse.move(-1, -1);
      await page.focus('aithema-session >>> [data-gauge="privacy"]');
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await settle(page);
      await page.screenshot({ path: join(evidenceDirectory, `ait270-${locale}-${linked ? 'linked-pair' : 'plain-us'}-${width}.png`), fullPage: false, captureBeyondViewport: false });
    }
    await page.click('aithema-session >>> dialog.settings .done');
  }
});

test('AIT-192: closing a fixture preserves Chrome and isolates cookies and page storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-reuse-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  t.after(() => demo.kill());
  const first = await browserForFile(); t.after(() => first.close());
  const pid = first.browser().process().pid, page = await first.newPage();
  await first.setCookie({ name: 'fixture-only', value: 'first', domain: 'example.test', path: '/' });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('fixture-only', 'first'); sessionStorage.setItem('fixture-only', 'first'); });
  await page.goto('about:blank'); // The origin must survive navigation in the reset ledger.
  await first.close();
  const second = await browserForFile(); t.after(() => second.close());
  assert.equal(second.browser().process().pid, pid, 'reuse the same Chrome process');
  assert.deepEqual(await second.cookies(), [], 'the next fixture has independent cookies');
  const next = await second.newPage(); await next.goto(demo.url, { waitUntil: 'domcontentloaded' });
  assert.deepEqual(await next.evaluate(() => [localStorage.getItem('fixture-only'), sessionStorage.getItem('fixture-only')]),
    [null, null], 'the next fixture has independent local and session storage');
});

test('AIT-192: a disconnected cached Chrome is relaunched for the next fixture', async t => {
  const first = await browserForFile();
  const pid = first.browser().process().pid;
  const disconnected = once(first.browser(), 'disconnected');
  first.browser().process().kill('SIGKILL');
  await disconnected;
  await first.close();
  const second = await browserForFile(); t.after(() => second.close());
  assert.equal(second.browser().connected, true);
  assert.notEqual(second.browser().process().pid, pid);
  const page = await second.newPage();
  assert.equal(await page.evaluate(() => 2 + 2), 4);
});

test('AIT-155: opaque scrolled band, approved scroll-zero paint and 0px layout shift, DE/EN light/dark 390/1024/1440', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-opaque-band-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = evidenceDirectory, passLines = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mockIdentityReads(page);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.opaqueBandSeed = c.session; });
  const approvedBackground = 'linear-gradient(to bottom,color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)),color-mix(in srgb,var(--aithema-accent) 4%,transparent) 70%,transparent)';
  const selectors = ['.band', '.band-orb', '.audio-rail', '.header-actions', '.conversation', '.composer-shell', '.display-foot'];
  const shot = async (label, state) => {
    const file = `ait155-band-${label}-${state}.png`;
    let png, paintAttempts = 0, firstLineInkPixels;
    const started = Date.now();
    do {
      if (paintAttempts) {
        // Chromium can return a stale masked pane after resize/entry even when
        // DOM geometry is ready. Repaint the fixture's scroll origin explicitly.
        await shadow(page, async c => { const pane = c.shadowRoot.querySelector('.transcript-shell');
          const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          pane.scrollTop = 1; await frame(); pane.scrollTop = 0; await frame(); });
        await settle(page);
      }
      png = Buffer.from(await page.screenshot({ fullPage: false })); paintAttempts++;
      if (state !== 'not-scrolled') break;
      const target = await shadow(page, c => {
        const text = c.shadowRoot.querySelector('.turn-text'), range = document.createRange(); range.selectNodeContents(text);
        const r = range.getClientRects()[0];
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          ink: getComputedStyle(text).color.match(/\d+/gu).slice(0, 3).map(Number) };
      });
      const paint = pixels(png); firstLineInkPixels = 0;
      for (let y = Math.max(0, Math.ceil(target.top)); y < Math.min(paint.height, target.bottom); y++) {
        for (let x = Math.max(0, Math.ceil(target.left)); x < Math.min(paint.width, target.right); x++) {
          const offset = (y * paint.width + x) * paint.channels;
          if (target.ink.every((value, channel) => Math.abs(paint.result[offset + channel] - value) <= 24)) firstLineInkPixels++;
        }
      }
    } while (firstLineInkPixels < 20 && Date.now() - started < 3000);
    if (evidence) await writeFile(join(evidence, file), png);
    if (state === 'not-scrolled') assert.ok(firstLineInkPixels >= 20, `${label}: captured actual transcript glyphs (${firstLineInkPixels})`);
    t.diagnostic(`display paint ${label}/${state}: ${paintAttempts} capture(s), first-line ink pixels=${firstLineInkPixels ?? 'covered by band'}`);
    return { file, paintAttempts, firstLineInkPixels };
  };
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 0, 'display-band')) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(window.opaqueBandSeed);
      session.locale = locale; session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
      session.transcript = Array.from({ length: 16 }, (_, i) => ({ id: `opaque-${i}`, role: 'assistant',
        content: (locale === 'de' ? 'Diese Nachricht muss vollständig hinter dem Band verschwinden. ' : 'This message must disappear completely behind the band. ').repeat(8) }));
      c.style.setProperty('--aithema-height', '1600px');
      c.configure({ copy, session, host: { library: true } });
      c.shadowRoot.activeElement?.blur();
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
      c.shadowRoot.querySelector('.transcript-shell').scrollTop = 0; scrollTo(0, 0);
    }, locale);
    // The first configured conversation still has an entrance/resize cycle.
    // Wait for its actual live paint, then reset the fixture's scroll anchor.
    await finishWorkspaceEntry(page);
    await shadow(page, c => { c.shadowRoot.querySelector('.transcript-shell').scrollTop = 0; scrollTo(0, 0); });
    await page.mouse.move(0, 500); await settle(page);
    assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', `${label}: stable paint through the real motion preference`);
    const baseline = await boxes(page, selectors);
    const bandBox = baseline[0], clip = { x: 0, y: bandBox[1], width, height: bandBox[3] };
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').hasAttribute('data-scrolled')), false);
    const originalPaint = Buffer.from(await page.screenshot({ clip }));
    await shadow(page, (c, background) => { c.shadowRoot.querySelector('.band').style.background = background; }, approvedBackground);
    assert.equal(samePaint(originalPaint, Buffer.from(await page.screenshot({ clip }))), true, `${label}: scroll-zero matches main's AIT-131 gradient`);
    assert.deepEqual(await boxes(page, selectors), baseline, `${label}: approved scroll-zero geometry`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').style.removeProperty('background'));
    passLines.push({ head: evidenceCommit, locale, theme, width, state: 'not-scrolled', displacementPx: 0, pass: true, ...await shot(label, 'not-scrolled') });
    await shadow(page, c => {
      const root = c.shadowRoot, band = root.querySelector('.band');
      root.querySelector('.transcript-shell').scrollTop = 0;
      const range = document.createRange(); range.selectNodeContents(root.querySelector('.turn-text'));
      const line = range.getClientRects()[0];
      scrollTo({ top: scrollY + line.top - (band.getBoundingClientRect().height - 24), behavior: 'instant' });
    });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.band').hasAttribute('data-scrolled'));
    const scrolled = await boxes(page, selectors);
    const metrics = await shadow(page, c => {
      const root = c.shadowRoot, band = root.querySelector('.band'), style = getComputedStyle(band), fade = getComputedStyle(band, '::before');
      const probe = document.createElement('span'); probe.style.color = 'color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper))'; root.append(probe);
      const rgb = getComputedStyle(probe).color; probe.remove();
      const ink = getComputedStyle(root.querySelector('.turn-text')).color;
      const range = document.createRange(); range.selectNodeContents(root.querySelector('.turn-text'));
      const line = range.getClientRects()[0], box = band.getBoundingClientRect();
      return { background: style.backgroundColor, backgroundImage: style.backgroundImage, rgb, ink, scrollY,
        orbRight: root.querySelector('.band-orb').getBoundingClientRect().right,
        band: { top: box.top, bottom: box.bottom, height: box.height },
        line: { left: line.left, right: line.right, top: line.top, bottom: line.bottom },
        fade: { position: fade.position, top: fade.top, height: fade.height, pointerEvents: fade.pointerEvents, content: fade.content } };
    });
    assert.ok(metrics.scrollY > 0 && metrics.band.top === 0, `${label}: genuinely scrolled sticky band`);
    assert.equal(metrics.backgroundImage, 'none'); assert.equal(metrics.background, metrics.rgb);
    assert.deepEqual(metrics.fade, { position: 'absolute', top: `${metrics.band.height}px`, height: '12px', pointerEvents: 'none', content: '""' });
    assert.equal(scrolled[0][3], baseline[0][3], `${label}: unchanged band height`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').removeAttribute('data-scrolled'));
    assert.deepEqual(await boxes(page, selectors), scrolled, `${label}: opaque surface and fade cause 0 px layout shift`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').setAttribute('data-scrolled', ''));
    const painted = pixels(Buffer.from(await page.screenshot()));
    await shadow(page, c => { c.shadowRoot.querySelector('.band').style.visibility = 'hidden'; });
    const exposed = pixels(Buffer.from(await page.screenshot()));
    await shadow(page, c => c.shadowRoot.querySelector('.band').style.removeProperty('visibility'));
    const expected = metrics.rgb.match(/[\d.]+/gu).slice(0, 3).map(value => Math.round(Number(value) * 255));
    const ink = metrics.ink.match(/\d+/gu).slice(0, 3).map(Number);
    const rgbAt = (png, x, y) => [...png.result.subarray((y * png.width + x) * png.channels, (y * png.width + x) * png.channels + 3)];
    let textPixels = 0;
    for (let y = Math.max(Math.ceil(metrics.line.top), metrics.band.bottom - 18); y < Math.min(metrics.line.bottom, metrics.band.bottom - 2); y++) {
      // Sample the surface clear of the orb's intentional foreground glass shadow.
      for (let x = Math.max(Math.ceil(metrics.line.left), Math.ceil(metrics.orbRight) + 24); x < Math.min(metrics.line.right, width); x++) {
        if (!rgbAt(exposed, x, y).every((channel, i) => Math.abs(channel - ink[i]) <= 24)) continue;
        textPixels++;
        assert.deepEqual(rgbAt(painted, x, y), expected, `${label}: band pixel ${x},${y} over bubble text equals the opaque band colour`);
      }
    }
    assert.ok(textPixels >= 20, `${label}: sampled actual bubble glyphs under the band (${textPixels})`);
    passLines.push({ head: evidenceCommit, locale, theme, width, state: 'scrolled', displacementPx: 0, pass: true, textPixels, expected, ...metrics, ...await shot(label, 'scrolled') });
    await page.evaluate(() => scrollTo(0, 0));
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.band').hasAttribute('data-scrolled'));
    assert.deepEqual(await boxes(page, selectors), baseline, `${label}: scrolling back restores every box`);
    const restoredPaint = Buffer.from(await page.screenshot({ clip }));
    if (!samePaint(originalPaint, restoredPaint)) {
      if (evidence) {
        await writeFile(join(evidence, `ait155-debug-${label}-original.png`), originalPaint);
        await writeFile(join(evidence, `ait155-debug-${label}-restored.png`), restoredPaint);
      }
    }
    assert.equal(samePaint(originalPaint, restoredPaint), true, `${label}: scrolling back restores main's paint`);
  }
  assertMatrixCaseCount('display-band', passLines.length);
  if (evidence) await writeFile(join(evidence, 'ait155-band-pass-lines.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', passLines }, null, 2));
  for (const row of passLines) t.diagnostic(`PASS head=${row.head} ${row.locale}-${row.theme}-${row.width}/${row.state} 0 px layout shift${row.textPixels ? `; ${row.textPixels} opaque pixels over text` : '; AIT-131 main paint preserved'}`);
});

test('AIT-246 visitor header has two icons for guest, pending and verified email identities', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-visitor-band-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  await mockIdentityReads(page);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.visitorHeaderSeed = structuredClone(c.session); });
  let cases = 0;
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 390, 320], theme, 1, 'display-account')) for (const folded of [false, true]) {
    await page.setViewport({ width, height: 900 }); await page.select('#theme', theme);
    for (const status of ['guest', 'pending', 'verified']) {
      await shadow(page, async (c, { locale, folded, status }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const s = structuredClone(window.visitorHeaderSeed); s.locale = locale; s.settings.origin = 'chosen';
        s.transcript = [{ id: 'visitor-header', role: 'user', content: 'A website for our bakery.' }];
        s.identity = { status, address: status === 'guest' ? null : 'visitor@example.test', verificationRequired: false, assessmentUnlocked: true };
        c.setAttribute('motion', 'off'); c.configure({ copy, session: s, host: { library: true, verification: true } });
        if (folded) c.shadowRoot.querySelector('.fold').click();
      }, { locale, folded, status });
      await finishWorkspaceEntry(page);
      const header = await shadow(page, c => {
        const root = c.shadowRoot, band = root.querySelector('.band');
        return { icons: [...band.querySelectorAll('.header-actions button')].filter(n => n.checkVisibility({ visibilityProperty: true })).map(n => n.className),
          accounts: root.querySelector('slot[name="account"]').assignedElements().length,
          emailInSettings: Boolean(root.querySelector('dialog.settings .host-verify')) };
      });
      assert.deepEqual(header.icons.sort(), ['conversations-toggle', 'settings-open'], `${width}/${locale}/${theme}/${status}/${folded}`);
      assert.equal(header.accounts, 0); assert.equal(header.emailInSettings, true);
      assert.equal(await page.$('[slot="account"]'), null);
    }
    cases++;
  }
  assertMatrixCaseCount('display-account', cases);
});

test('AIT-147 Settings footer wraps without moving controls: verification off/unverified/pending/verified, DE/EN, 1440/390, light/dark', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-settings-footer-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  t.after(() => demo.kill());
  const browser = await browserForFile();
  t.after(() => browser.close());
  const page = await browser.newPage(), evidence = evidenceDirectory, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await mockIdentityReads(page); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.footerSeed = c.session; });
  const expected = {
    de: 'Allgemein\u00a0· Hier können Sie ein neues Gespräch beginnen, die Einwilligung und Ihre Voreinstellungen prüfen und Ihre E-Mail-Adresse bestätigen.',
    en: 'General\u00a0· Start a new conversation, review consent and your defaults, and confirm your email address.',
  };
  const general = {
    de: 'Allgemein\u00a0· Hier können Sie ein neues Gespräch beginnen sowie die Einwilligung und Ihre Voreinstellungen prüfen.',
    en: 'General\u00a0· Start a new conversation, review consent and your defaults.',
  };
  const controls = ['.settings__tabs', '.general-new', '.general-consent-manage', '.general-recommended', '.footer-links', '.save-state', '.done'];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 390], theme, 2, 'display-settings-footer')) {
    let baseline;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    for (const state of ['off', 'unverified', 'pending', 'verified']) await t.test(`${locale}/${theme}/${width}/verification-${state}`, async () => {
      const verification = state !== 'off', needsVerification = state === 'unverified' || state === 'pending';
      await page.evaluate(async ({ locale, verification, state }) => {
        const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
        const { paintUtilities } = await import('/demo/page-preferences.js');
        const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.footerSeed), copy = { de, en }[locale];
        session.locale = locale;
        session.identity = { status: { off: 'guest', unverified: 'guest', pending: 'verification-pending', verified: 'verified' }[state],
          address: state === 'pending' || state === 'verified' ? 'visitor@example.com' : null,
          verificationRequired: false, assessmentUnlocked: true, pollVerification: false };
        c.configure({ copy, session, host: { verification } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy); window.scrollTo(0, 0);
      }, { locale, verification, state });
      await page.click('aithema-session >>> .settings-open'); await page.click('aithema-session >>> [data-tab="general"]');
      await page.mouse.move(0, 0); await settle(page);
      const geometry = await shadow(page, c => {
        const root = c.shadowRoot, message = root.querySelector('.context-message'), box = message.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(message);
        const lines = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        const style = getComputedStyle(message), footer = root.querySelector('.settings__footer').getBoundingClientRect();
        return { text: message.textContent, emailShown: !root.querySelector('.host-verify').hidden,
          verifyButtonShown: !root.querySelector('.host-verify').hidden && !root.querySelector('.verify-entry').hidden,
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, lines, footerTop: footer.top,
          textOverflow: style.textOverflow, fontStyle: style.fontStyle, scrollWidth: message.scrollWidth, clientWidth: message.clientWidth };
      });
      const positions = await boxes(page, controls), context = `${locale}/${theme}/${width}/${state}: ${JSON.stringify(geometry)}`;
      if (!verification) baseline = positions;
      else sameBoxes(baseline, positions, `${context}: enabling verification moves no control`);
      const displacement = Math.max(...positions.flatMap((box, i) => box.map((value, n) => Math.abs(value - baseline[i][n]))));
      assert.equal(displacement, 0, `${context}: control displacement stays 0 px`);
      assert.equal(geometry.emailShown, verification, context);
      assert.equal(geometry.verifyButtonShown, needsVerification, context);
      assert.equal(geometry.text, state === 'verified' ? { de, en }[locale].help.generalEmailManage : needsVerification ? expected[locale] : general[locale], context);
      assert.equal(geometry.fontStyle, 'normal'); assert.notEqual(geometry.textOverflow, 'ellipsis');
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, context);
      for (const line of geometry.lines) {
        assert.ok(line.left >= geometry.box.left - 1 && line.right <= geometry.box.right + 1, context);
        assert.ok(line.top >= geometry.box.top - 1 && line.bottom <= geometry.box.bottom + 1, context);
      }
      assert.ok(geometry.box.bottom <= geometry.footerTop, context);
      if (width === 390 && needsVerification) assert.ok(geometry.lines.length > 1, 'the email hint wraps at phone width');
      for (const control of ['.general-consent-manage', '.general-recommended']) {
        await page.hover(`aithema-session >>> ${control}`);
        sameBoxes(positions, await boxes(page, controls), `${context}: help on hover moves no control`);
      }
      await page.mouse.move(0, 0); await settle(page);
      if (evidence) {
        const name = `ait-147-settings-general-verification-${state}-${locale}-${width}-${theme}.png`;
        await page.screenshot({ path: join(evidence, name) }); files.push(name);
      }
      checks.push({ locale, theme, width, verification, state, geometry, positions, maxControlDisplacementPx: displacement });
      await page.keyboard.press('Escape');
    });
  }
  assertMatrixCaseCount('display-settings-footer', checks.length);
  if (evidence) await writeFile(join(evidence, 'ait-147-settings-footer-evidence.json'), JSON.stringify({ ticket: 'AIT-147', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-131 r3 Settings email states and verification focus: DE/EN, 1440/390, light/dark', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-settings-email-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = evidenceDirectory, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await mockIdentityReads(page); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.emailSeed = c.session; });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 390], theme, 3, 'display-settings-email')) for (const state of ['unverified', 'pending', 'verified']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async ({ locale, state }) => {
      const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
      const c = document.querySelector('aithema-session'), s = structuredClone(globalThis.emailSeed);
      s.locale = locale; s.settings.origin = 'chosen';
      s.identity = { status: { unverified: 'guest', pending: 'verification-pending', verified: 'verified' }[state],
        address: state === 'unverified' ? null : 'visitor@example.com', verificationRequired: false, assessmentUnlocked: true,
        conceptsUnlocked: true, resendAfterMs: 0, delivery: state === 'unverified' ? 'idle' : 'sent', pollVerification: false };
      c.configure({ copy: { de, en }[locale], session: s, host: { verification: true, library: true } });
      document.documentElement.lang = locale; window.scrollTo(0, 0);
    }, { locale, state });
    await page.click('aithema-session >>> .settings-open'); await page.click('aithema-session >>> [data-tab="general"]');
    await shadow(page, c => c.shadowRoot.querySelector('.host-verify').scrollIntoView({ block: 'nearest' })); await settle(page);
    const entry = await shadow(page, c => {
      const root = c.shadowRoot, section = root.querySelector('.host-verify'), button = section.querySelector('.verify-entry');
      const rect = section.getBoundingClientRect(), hit = root.elementFromPoint(rect.x + 8, rect.y + 8);
      return { title: section.querySelector('h3').textContent, address: section.querySelector('.verify-entry-address').textContent,
        status: section.querySelector('.verify-entry-status').textContent, done: section.querySelector('.verify-done').textContent,
        verified: !section.querySelector('.verify-done').hidden, button: button.textContent, hasButton: !button.hidden,
        last: section.parentElement.lastElementChild === section, panel: section.closest('[data-panel]').dataset.panel,
        extras: Boolean(root.querySelector('.host-extras')), visible: section.contains(hit), lock: !root.querySelector('.verify-lock').hidden };
    });
    const words = { de, en }[locale].hostSurface.verify, context = `${width}/${theme}/${locale}/${state}: ${JSON.stringify(entry)}`;
    assert.equal(entry.title, locale === 'en' ? 'Email' : 'E-Mail'); assert.equal(entry.panel, 'general'); assert.equal(entry.last, true);
    assert.equal(entry.extras, false); assert.equal(entry.visible, true, context); assert.equal(entry.lock, false);
    assert.equal(entry.address, state === 'unverified' ? '' : 'visitor@example.com');
    assert.equal(entry.hasButton, state !== 'verified'); assert.equal(entry.verified, state === 'verified');
    if (state === 'verified') assert.equal(entry.done, words.verifiedShort);
    else { assert.equal(entry.status, state === 'pending' ? words.linkSent : words.unverified); assert.equal(entry.button, state === 'pending' ? words.resendOrChange : words.entry); }
    const shot = async name => { if (evidence) { await page.screenshot({ path: join(evidence, name) }); files.push(name); } };
    await shot(`r3-settings-email-${state}-${width}-${theme}-${locale}.png`);
    if (entry.hasButton) {
      await page.click('aithema-session >>> .verify-entry');
      const modal = await shadow(page, c => ({ settings: c.shadowRoot.querySelector('dialog.settings').open, verify: c.shadowRoot.querySelector('dialog.verify-dialog').open,
        focus: c.shadowRoot.activeElement?.className }));
      assert.equal(modal.settings, false); assert.equal(modal.verify, true); assert.equal(modal.focus, state === 'pending' ? 'verify-resend' : 'verify__input');
      await shot(`r3-verify-from-settings-${state}-${width}-${theme}-${locale}.png`);
      await page.keyboard.press('Escape');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('settings-open'));
    } else await page.keyboard.press('Escape');
    checks.push({ width, theme, locale, state, entry });
  }
  assertMatrixCaseCount('display-settings-email', checks.length);
  if (evidence) await writeFile(join(evidence, 'r3-settings-email-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-131 populated canvas regressions and the orb hit area', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-display-regressions-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const evidence = evidenceDirectory, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const draft = copy => `<!doctype html><html lang="${copy.display.locale}"><head><meta charset="utf-8"><title>${copy.layout.canvas}</title>
    <style>body{margin:0;padding:32px;background:#f7f5ef;color:#243b40;font:16px system-ui}h1{font:32px Georgia}input,button{font:inherit;padding:12px;border:1px solid #b4c9c1;border-radius:6px}button{background:#1d6e6a;color:white}p{line-height:1.5}</style></head>
    <body><h1>${copy === de ? 'Ihr Website-Entwurf' : 'Your website draft'}</h1><p>${copy === de ? 'Eine geschätzte Lieferzeit für handgestickte Polster.' : 'Estimated delivery times for hand-embroidered cushions.'}</p>
    <label>${copy === de ? 'Ihr Motiv' : 'Your design'} <input id="design" value="Blumen"></label>
    <p><button id="count">${copy === de ? 'Entwurf ausprobieren' : 'Try the draft'}</button> <output id="value">0</output></p>
    <script>document.querySelector('#count').addEventListener('click',()=>{document.querySelector('#value').textContent=String(Number(document.querySelector('#value').textContent)+1)});</script></body></html>`;
  let copy = de;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/concepts/canvas1/html')) return request.respond({ status: 200, contentType: 'application/octet-stream', body: draft(copy) });
    if (url.pathname === '/api/library' && request.method() === 'GET') return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: Array.from({ length: 5 }, (_, i) => ({ id: `menu-${i}`, title: `${copy.hostSurface.library.open} ${i + 1}`, updatedAt: '2026-10-12T09:00:00Z' })), total: 5 }) });
    if (url.pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
      best: Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }])) }) });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.regressionSeed = c.session; });
  async function scene(locale, theme, width) {
    copy = { en, de }[locale]; await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const c = document.querySelector('aithema-session'), s = structuredClone(globalThis.regressionSeed);
      s.locale = locale; s.settings.origin = 'chosen'; s.conceptVisualKind = 'html'; s.conceptCost = { maxMicro: 400_000 };
      s.transcript = [{ id: 'source', role: 'user', content: locale === 'de' ? 'Eine Website für meine handgestickten Polster.' : 'A website for my hand-embroidered cushions.' }];
      s.inputRevision = 1; s.concepts = [{ id: 'canvas1', mediaType: 'text/html', turnIds: ['source'], referenceIds: [], archived: false,
        feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } }];
      s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }]));
      c.configure({ copy: { en, de }[locale], session: s }); document.documentElement.lang = locale;
      c.shadowRoot.querySelector('.fold').click();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.canvas-html').state === 'ready');
    await page.mouse.move(0, 300);
  }
  async function shot(state, locale, theme, width) {
    const name = `${state}-${width}-${theme}-${locale}.png`;
    if (evidence) {
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-1, -1); await settle(page);
      // Reopen from the verified outer-ring click after clearing capture focus/hover.
      if (state === 'orb-hit-area-open') await shadow(page, c => c.shadowRoot.querySelector('.band-orb [role="button"]').click());
      await shadow(page, async c => {
        await document.fonts.ready;
        await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
          .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.screenshot({ path: join(evidence, name), fullPage: false }); files.push(name);
    }
  }
  const canvasFrame = async () => (await page.$('aithema-session >>> .canvas-html >>> iframe')).contentFrame();
  await t.test('populated canvas keeps interactive state and focus through durable events', async () => {
    await scene('de', 'light', 1440);
    const frame = await canvasFrame(); await frame.click('#count'); await frame.focus('#design'); await frame.type('#design', ' · geändert');
    const before = await frame.$eval('#design', n => n.value);
    await shadow(page, c => { globalThis.canvasFrameBefore = c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe');
      c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }); });
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe') === globalThis.canvasFrameBefore), true);
    assert.equal(await frame.$eval('#value', n => n.textContent), '1'); assert.equal(await frame.$eval('#design', n => n.value), before);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'design', 'typing focus stays in the same browsing context');
    await shot('folded-populated-state-preserved', 'de', 'light', 1440);
  });
  await t.test('unfold unloads the populated executable iframe', async () => {
    await scene('en', 'light', 1440); await canvasFrame();
    await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').artifact), null);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe'))), false);
  });
  await t.test('populated canvas and every modal frame are redacted on consent or source withdrawal', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 4, 'display-canvas')) {
      for (const cause of ['consent', 'source']) for (const folded of [true, false]) {
        await scene(locale, theme, width);
        await shot('folded-populated-canvas', locale, theme, width);
        if (!folded) await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
        await shadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-html').state === 'ready');
        await shadow(page, (c, cause) => c.receive({ seq: c.session.seq + 1,
          type: cause === 'consent' ? 'consent.revised' : 'turn.withdrawn', data: cause === 'consent' ? { granted: false } : { turnId: 'source' } }), cause);
        const surfaces = await shadow(page, c => ['.canvas-html', '.concept-html'].map(selector => {
          const n = c.shadowRoot.querySelector(selector); return { bytes: n.artifact, frame: Boolean(n.shadowRoot.querySelector('iframe')) };
        }));
        assert.deepEqual(surfaces, [{ bytes: null, frame: false }, { bytes: null, frame: false }], `${locale}/${theme}/${width}/${cause}/${folded}`);
        await shot(`revocation-${cause}-${folded ? 'folded' : 'unfolded'}`, locale, theme, width);
        checks.push({ locale, theme, width, cause, folded, surfaces });
      }
    }
  });
  assertMatrixCaseCount('display-canvas', checks.filter(check => 'cause' in check).length);
  await t.test('the reveal orb has a 44px hit area around its 40px visual', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 5, 'display-orb')) {
      await scene(locale, theme, width);
      const visual = (await boxes(page, ['.band-orb .orb__body']))[0];
      const target = await shadow(page, c => {
        const n = c.shadowRoot.querySelector('.band-orb [role="button"]'), r = n.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      });
      assert.equal(visual[2], 40); assert.equal(visual[3], 40); assert.equal(target[2], 44); assert.equal(target[3], 44);
      const bandBefore = await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']);
      // The point is in the target's outer ring, beyond the painted 40px orb.
      await page.mouse.click(target[0] + 1, target[1] + 22);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'open');
      await settle(page); sameBoxes(bandBefore, await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']), 'orb activation does not shift the band layout');
      await shot('orb-hit-area-open', locale, theme, width);
      checks.push({ locale, theme, width, visual, target });
    }
  });
  assertMatrixCaseCount('display-orb', checks.filter(check => 'target' in check).length);
  await t.test('conversations menu corners stay painted above the second band row at medium widths and fit all header widths', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) {
      // Keep this scene loaded while resizing; menu geometry does not need a new
      // executable canvas and session render for every width.
      await scene(locale, theme, 390);
      await shadow(page, async (c, locale) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        c.configure({ copy, session: c.session, host: { library: true } });
      }, locale);
      for (const width of [390, 600, 680, 768, 800, 900, 1000, 1024, 1440]) {
        const label = `${locale}/${theme}/${width}`;
        await page.setViewport({ width, height: width === 390 ? 844 : 900 });
        const selectors = ['.band', '.band-orb', '.audio-rail', '.header-actions', '.conversations-toggle', '.settings-open'];
        const before = await boxes(page, selectors);
        await page.click('aithema-session >>> .conversations-toggle');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 5);
        await settle(page);
        const menu = await shadow(page, c => {
          const root = c.shadowRoot, n = root.querySelector('.conversations-menu'), b = n.getBoundingClientRect();
          const anchor = root.querySelector('.conversations-toggle').getBoundingClientRect();
          const orb = root.querySelector('.band-orb [role="button"]'), target = orb.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
            anchor: { left: anchor.left, right: anchor.right, bottom: anchor.bottom },
            orbHit: orb.contains(root.elementFromPoint(target.left + 1, target.top + 22)),
            corners: [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]]
              .map(([x, y]) => { const hit = root.elementFromPoint(x, y); return { painted: n.contains(hit), hit: hit?.className }; }) };
        });
        assert.ok(menu.left >= 0 && menu.right <= width + .5 && menu.top >= 0 && menu.bottom <= (width === 390 ? 844 : 900), `${label}: menu fits ${JSON.stringify(menu)}`);
        assert.ok(menu.corners.every(n => n.painted), `${label}: ${JSON.stringify(menu)}`);
        assert.ok(Math.abs(menu.top - menu.anchor.bottom - 6) <= .5, `${label}: menu opens below its icon`);
        if (width >= 600) assert.ok(Math.abs(menu.right - menu.anchor.right) <= .5, `${label}: menu aligns with its icon's right edge`);
        else assert.ok(menu.left <= menu.anchor.left && menu.right >= menu.anchor.right, `${label}: phone menu spans its icon`);
        assert.equal(menu.orbHit, true, `${label}: menu preserves the orb's outer hit ring`);
        sameBoxes(before, await boxes(page, selectors), `${label}: opening the menu keeps the band fixed`);
        await shot('conversations-medium', locale, theme, width);
        checks.push({ locale, theme, width, menu });
        await shadow(page, c => c.shadowRoot.querySelector('.conversations-toggle').focus());
        await page.keyboard.press('Escape');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
      }
    }
  });
  if (evidence) await writeFile(join(evidence, 'display-regressions-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit,
    createdAt: new Date().toISOString(), files, checks }, null, 2));
});

test('AIT-138 UI: held-call copy, placeholders, calm lines and disabled controls without layout shift', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-waiting-ui-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], files = [], checks = [], evidence = evidenceDirectory;
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
    return request.continue();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  let heldCases = 0;
  const shot = async (state, width, theme, locale) => {
    heldCases++;
    if (!evidence || width === 1024) return;
    await shadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
    const name = `ait-138-${state}-${width}-${theme}-${locale}.png`;
    await page.screenshot({ path: join(evidence, name), fullPage: false }); files.push(name);
  };
  // Reinstall only the host's voice port after a real reload. The component restores the saved waiting snapshot.
  const configure = async (locale, reload = false) => page.evaluate(async ({ locale, reload }) => {
    const { voiceEvents } = await import('/packages/core/src/live-voice.js'), { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
    const c = document.querySelector('aithema-session'), copy = { de, en }[locale];
    const s = reload ? JSON.parse(sessionStorage.getItem('ait-138-waiting-ui')) : structuredClone(c.session);
    s.locale = locale; s.paused = false; s.settings.origin = 'chosen'; s.settings.voice = 'elevenlabs';
    s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
    s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true, reason: null }]));
    if (!reload) {
      delete s.voiceLifecycle;
      s.transcript = [{ id: 'ui-user', role: 'user', content: locale === 'de' ? 'Eine Website für Stickpolster.' : 'A website for embroidered cushions.' }];
    }
    globalThis.waitingUiStarts = 0;
    const voiceClient = { manifest, async start({ callId }) {
      globalThis.waitingUiStarts++; globalThis.waitingUiCallId = callId;
      const events = voiceEvents(); globalThis.waitingUiEvents = events;
      return { callId, providerSessionId: 'ui-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
        async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
        audioLevels: () => ({ input: .3, output: .65 }), async close() { events.end(); return { closureConfirmed: true }; } };
    } };
    localStorage.setItem('aithema-motion', 'on');
    c.configure({ copy, session: s, voiceClient }); document.documentElement.lang = locale;
    document.querySelector('#locale').value = locale;
    const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy); window.scrollTo(0, 0);
  }, { locale, reload });
  const settled = async state => {
    await until(page, (state) => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === state, state);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await settle(page);
  };
  const placeholder = () => shadow(page, c => c.shadowRoot.querySelector('textarea').placeholder);
  const controls = () => shadow(page, c => ['.voice-input', '.voice-output'].map(selector => {
    const n = c.shadowRoot.querySelector(selector), style = getComputedStyle(n);
    return { selector, disabled: n.disabled, tooltip: n.title, opacity: style.opacity, cursor: style.cursor };
  }));
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 390, 1024], theme, 7, 'display-held')) {
    const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await page.select('#theme', theme); await configure(locale); await settle(page);
    await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click()); await settled('listening');
    const placeholders = { listening: await placeholder() }; assert.equal(placeholders.listening, copy.placeholderVoice);
    const selectors = ['.band', '.audio-rail', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.composer'];
    const before = await layoutBoxes(page, selectors);
    await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settled('paused');
    placeholders.paused = await placeholder(); assert.equal(placeholders.paused, copy.placeholder);
    sameBoxes(before, await layoutBoxes(page, selectors), `${label}: paused keeps fixed cells`);
    await shot('voice-paused', width, theme, locale);
    await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settled('listening');
    // Force the previous amber paint, then stop motion before waiting: a timer cannot repair the colour for us.
    await page.evaluate(() => globalThis.waitingUiEvents.push({ type: 'speaking', callId: globalThis.waitingUiCallId }));
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle === '#b66a23');
    await shadow(page, c => c.shadowRoot.querySelector('.motion-toggle').click());
    assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off');
    await page.evaluate(() => globalThis.waitingUiEvents.push({ type: 'waiting', callId: globalThis.waitingUiCallId, reason: 'recovery-failed' }));
    await settled('waiting');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), copy.voiceStates.waiting);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').title), copy.resume);
    placeholders.waiting = await placeholder(); assert.equal(placeholders.waiting, copy.placeholder);
    const geometry = await statusGeometry(page);
    if (width >= 1024) { assert.equal(geometry.rendered.length, 1, `${label}: whole label on one line`); assert.equal(geometry.overflow, 'clip');
      assert.ok(geometry.textBox.x >= geometry.waveX && geometry.textBox.right <= geometry.waveX + geometry.waveWidth, `${label}: label fits inside waveform space`); }
    const lineColour = await shadow(page, c => c.shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle);
    assert.equal(lineColour, '#12908c', `${label}: calm user baseline, including motion off`);
    const disabledControls = await controls();
    for (const control of disabledControls) {
      assert.equal(control.disabled, true); assert.equal(control.opacity, '0.4'); assert.equal(control.cursor, 'default');
      assert.equal(control.tooltip, copy.voiceResumeFirst);
    }
    sameBoxes(before, await layoutBoxes(page, selectors), `${label}: waiting keeps fixed cells`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
    await shot('voice-waiting', width, theme, locale);
    await page.evaluate(() => {
      const snapshot = structuredClone(document.querySelector('aithema-session').session);
      snapshot.voiceLifecycle = { callId: globalThis.waitingUiCallId, providerSessionId: 'ui-evidence', state: 'waiting', attempts: 3, needsRecovery: true };
      sessionStorage.setItem('ait-138-waiting-ui', JSON.stringify(snapshot));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await configure(locale, true); await settled('waiting');
    placeholders.waitingAfterReload = await placeholder(); assert.equal(placeholders.waitingAfterReload, copy.placeholder);
    assert.equal(await page.evaluate(() => globalThis.waitingUiStarts), 0, `${label}: reload does not start listening`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle), '#12908c');
    for (const control of await controls()) { assert.equal(control.disabled, true); assert.equal(control.opacity, '0.4'); assert.ok(control.tooltip); }
    await shot('voice-waiting-reloaded', width, theme, locale);
    checks.push({ viewport: { width, height: width === 390 ? 844 : 900 }, theme, locale, waitingLabel: copy.voiceStates.waiting,
      waitingLabelLines: geometry.rendered.length, waitingLineColour: { token: 'COLOUR.user', value: lineColour }, placeholders,
      disabledControls, noLayoutShift: true, noHorizontalOverflow: true, pass: true });
  }
  assert.deepEqual(errors, []);
  assertMatrixCaseCount('display-held', heldCases);
  if (evidence) await writeFile(join(evidence, 'ait-138-ui-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', files, checks }, null, 2));
});

test('AIT-138 c: recovery notices, explicit reply fallback and waiting tooltips in all viewports', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-recovery-notices-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], files = [], checks = [], evidence = evidenceDirectory;
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
    return request.continue();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  let noticeCases = 0;
  const shot = async (name, label) => {
    noticeCases++;
    const file = `ait-138-c-${name}-${label}.png`; files.push(file);
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
  };
  const push = event => page.evaluate(event => globalThis.noticeEvents.push({ callId: globalThis.noticeCallId, ...event }), event);
  const recovered = async recovery => {
    await push({ type: 'recovered', recovery });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-notice--recovered').textContent);
    await settle(page);
  };
  const selectors = ['.band', '.audio-rail', '.voice-notices', '.concept-bar', '.transcript-shell', '.composer-dock'];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 1024, 390], theme, 8, 'display-notices')) {
    await t.test(`${width} ${theme} ${locale}`, async () => {
      const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
      const wording = {
        de: { notice: 'Letzte Antwort vielleicht nicht ganz zu hören', button: 'Antwort wiederholen', title: 'Letzte Antwort',
          note: 'Der vollständige Text der letzten Antwort, Wort für Wort.', close: 'Schließen', tooltip: 'Erst fortsetzen' },
        en: { notice: 'Last reply may not have played in full', button: 'Replay reply', title: 'Last reply',
          note: 'The full text of the last reply, word for word.', close: 'Close', tooltip: 'Resume first' },
      }[locale];
      const layoutChecks = [];
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      await page.select('#theme', theme);
      await page.evaluate(async locale => {
        const { voiceEvents } = await import('/packages/core/src/live-voice.js');
        const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
        const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
        const c = document.querySelector('aithema-session'), s = structuredClone(c.session);
        s.locale = locale; s.paused = false; s.settings.origin = 'chosen'; s.settings.voice = 'elevenlabs';
        s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
        s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true, reason: null }]));
        delete s.voiceLifecycle;
        s.transcript = [{ id: 'notice-user', role: 'user', content: locale === 'de' ? 'Eine Website für Stickpolster.' : 'A website for embroidered cushions.' }];
        globalThis.noticeReply = locale === 'de' ? 'Die Website zeigt die Lieferzeit nach dem Backlog.\n\nSollen Kunden Motiv, Farbe und Größe selbst wählen können?'
          : 'The website shows delivery time based on the backlog.\n\nShould customers be able to choose the design, colour and size?';
        s.transcript.push({ id: 'notice-reply', role: 'assistant', content: globalThis.noticeReply });
        globalThis.noticeReplays = 0; globalThis.noticeAdmissions = 0; globalThis.noticeModelCalls = 0;
        const voiceClient = { manifest, async start({ callId }) {
          globalThis.noticeAdmissions++; globalThis.noticeCallId = callId;
          const events = voiceEvents(); globalThis.noticeEvents = events;
          return { callId, providerSessionId: 'notice-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
            async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
            async replayLastReply() { globalThis.noticeReplays++; return { kind: 'text', text: globalThis.noticeReply }; },
            async sendText() { globalThis.noticeModelCalls++; }, audioLevels: () => ({ input: .2, output: .3 }),
            async close() { events.end(); return { closureConfirmed: true }; } };
        } };
        localStorage.setItem('aithema-motion', 'off'); c.configure({ copy: { de, en }[locale], session: s, voiceClient });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities({ de, en }[locale]); window.scrollTo(0, 0);
      }, locale);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
      await page.evaluate(async () => { await document.fonts.ready; }); await settle(page);
      const before = await layoutBoxes(page, selectors);
      const sameNoticeBoxes = (after, context) => {
        if (width !== 390) { sameBoxes(before, after, context); return; }
        // AIT-188: the last phone item sizes to its current contents. The band,
        // stage, transcript viewport, dock and notice origin still move 0px.
        assert.deepEqual(after.filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), context);
        assert.deepEqual(after[2].slice(0, 3), before[2].slice(0, 3), `${context}: notice origin moves 0px`);
      };
      const noticeLayout = async state => {
        const after = await layoutBoxes(page, selectors);
        if (width === 390) {
          const heights = { 'lone-restored':24, unconfirmed:68, 'known-position':24, 'incomplete-button':112,
            'lone-incomplete':88, 'unacknowledged-reply':112, 'all-notices':156, cleared:0 };
          assert.equal(after[2][3], heights[state], `${label}: ${state} occupies exactly its visible rows`);
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.transcript-shell').lastElementChild.className), 'voice-notices');
        } else {
          assert.deepEqual(after[2], before[2], `${label}: ${state} preserves the notice reservation`);
          assert.equal(after[2][3], 108, `${label}: original reserved height`);
        }
        const belowShifts = after.slice(3).flatMap((box, i) => box.map((value, n) => value - before[i + 3][n]));
        assert.ok(belowShifts.every(shift => shift === 0), `${label}: ${state} shifts the content below by 0px`);
        const layout = await shadow(page, c => {
          const root = c.shadowRoot, rect = n => {
            const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
          };
          const rows = [...root.querySelectorAll('.voice-notice')].filter(n => getComputedStyle(n).display !== 'none');
          const text = root.querySelector('.voice-notice--reply > span'), range = document.createRange(); range.selectNodeContents(text);
          return { slot: rect(root.querySelector('.voice-notices')), rows: rows.map(rect), text: rect(text),
            textRight: Math.max(...[...range.getClientRects()].map(r => r.right)), button: rect(root.querySelector('.voice-repeat')) };
        });
        if (layout.rows.length) assert.equal(layout.rows[0].top, layout.slot.top, `${label}: ${state} first notice starts at slot top`);
        for (let i = 1; i < layout.rows.length; i++) {
          assert.equal(layout.rows[i].top, layout.rows[i - 1].bottom, `${label}: ${state} has no empty row between notices`);
        }
        layoutChecks.push({ state, ...layout, belowShiftPx: Math.max(...belowShifts.map(Math.abs)), pass: true });
        return layout;
      };
      const assertButtonPosition = layout => {
        if (width === 390) {
          assert.ok(layout.button.top >= layout.text.bottom, `${label}: button sits under the text`);
          assert.equal(layout.button.left, layout.text.left, `${label}: stacked button starts with its text`);
        } else {
          assert.ok(Math.abs(layout.button.left - layout.textRight - 12) <= 1, `${label}: button starts 12px after the notice text`);
          assert.ok(layout.button.top < layout.text.bottom && layout.button.bottom > layout.text.top, `${label}: button stays beside the text`);
        }
      };
      await recovered({});
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--recovered').textContent), copy.voiceRecovered);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: restored notice reserves its space`);
      const loneRestored = await noticeLayout('lone-restored');
      assert.equal(loneRestored.rows.length, 1, 'only the visible notice occupies a row');
      await shot('restored', label);
      await recovered({ userUnconfirmed: true });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--user').textContent), copy.voiceUserUnconfirmed);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: unconfirmed notice reserves its space`);
      await noticeLayout('unconfirmed');
      await shot('unconfirmed', label);
      const lastReplyText = await page.evaluate(() => globalThis.noticeReply);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: false, lastReplyText });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply > span').textContent), '');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice-live').textContent), copy.voiceRecovered);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: known position hides incomplete notice without layout shift`);
      await noticeLayout('known-position');
      await shot('known-position', label);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply > span').textContent), wording.notice);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').textContent), wording.button);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').getAttribute('aria-haspopup')), 'dialog');
      assert.equal(await page.evaluate(() => globalThis.noticeReplays), 0, 'no automatic replay');
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: reply notice and button reserve their space`);
      assertButtonPosition(await noticeLayout('incomplete-button'));
      await shot('incomplete-button', label);
      // Isolate the reply row to check CSS packing independently of recovery's restored announcement.
      await shadow(page, c => { c.shadowRoot.querySelector('.voice-notice--recovered').textContent = ''; });
      const loneReply = await noticeLayout('lone-incomplete');
      assert.equal(loneReply.rows.length, 1, 'a lone reply uses the first notice slot');
      assertButtonPosition(loneReply);
      await shot('lone-incomplete-button', label);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: null });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply span').textContent), wording.notice);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').disabled), true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').title), copy.voiceReplyUnavailable);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: unacknowledged reply reserves its space`);
      assertButtonPosition(await noticeLayout('unacknowledged-reply'));
      await shot('unacknowledged-reply', label);
      await recovered({ userUnconfirmed: true, deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText });
      const geometry = await shadow(page, c => {
        const root = c.shadowRoot, notice = root.querySelector('.voice-notices').getBoundingClientRect();
        return [...root.querySelectorAll('.voice-notice--recovered, .voice-notice--user, .voice-notice--reply > span, .voice-repeat')].map(n => {
          const b = n.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
          return { name: n.className || 'reply-text', width: b.width, height: b.height, visible: b.top >= 0 && b.bottom <= innerHeight,
            inside: b.left >= notice.left - .5 && b.right <= notice.right + .5 && b.top >= notice.top - .5 && b.bottom <= notice.bottom + .5,
            textFits: [...range.getClientRects()].every(r => r.left >= b.left - .5 && r.right <= b.right + .5 && r.top >= b.top - .5 && r.bottom <= b.bottom + .5) };
        });
      });
      for (const item of geometry) { assert.ok(item.inside && item.visible && item.textFits, `${label}: ${JSON.stringify(item)}`); }
      assert.ok(geometry.at(-1).width >= 44 && geometry.at(-1).height >= 44, '44px keyboard target');
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: all notices fit without layout shift`);
      assertButtonPosition(await noticeLayout('all-notices'));
      await shot('all-notices', label);
      await shadow(page, c => {
        const live = c.shadowRoot.querySelector('.voice-notice-live'); globalThis.noticeAnnouncements = [];
        globalThis.noticeObserver = new MutationObserver(records => globalThis.noticeAnnouncements.push(...records.map(r => r.type)));
        globalThis.noticeObserver.observe(live, { childList: true, subtree: true, characterData: true });
      });
      // Provider speaking/listening repaints the rail but never rewrites its notice live region.
      await push({ type: 'speaking' }); await push({ type: 'listening' }); await settle(page);
      assert.equal(await page.evaluate(() => { globalThis.noticeObserver.disconnect(); return globalThis.noticeAnnouncements.length; }), 0);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').focus()); await page.keyboard.press('Enter');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-text').textContent), lastReplyText);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#voice-reply-title').textContent), wording.title);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-note').textContent), wording.note);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-close').textContent), wording.close);
      assert.deepEqual(await page.evaluate(() => [globalThis.noticeReplays, globalThis.noticeAdmissions, globalThis.noticeModelCalls]), [1, 1, 0]);
      await shot('exact-text-fallback', label);
      await page.keyboard.press('Escape');
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.className), 'voice-repeat', 'Escape returns keyboard focus');
      await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').disabled), true);
      await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settle(page);
      await push({ type: 'waiting', reason: 'recovery-failed' });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'waiting');
      for (const [name, cell] of [['input', 'mic'], ['output', 'output']]) {
        const tooltip = await shadow(page, (c, name) => c.shadowRoot.querySelector(`.voice-${name}`).title, name);
        assert.equal(tooltip, wording.tooltip);
        await shadow(page, (c, cell) => c.shadowRoot.querySelector(`.voice-cell--${cell}`).focus(), cell); await settle(page);
        assert.equal(await shadow(page, (c, cell) => getComputedStyle(c.shadowRoot.querySelector(`.voice-cell--${cell} .voice-waiting-help`)).visibility, cell), 'visible');
        const tooltipBox = await shadow(page, (c, cell) => {
          const b = c.shadowRoot.querySelector(`.voice-cell--${cell} .voice-waiting-help`).getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        }, cell);
        assert.ok(tooltipBox.left >= 0 && tooltipBox.right <= width && tooltipBox.top >= 0 && tooltipBox.bottom <= (width === 390 ? 844 : 900),
          `${label}: ${name} tooltip fits the viewport: ${JSON.stringify(tooltipBox)}`);
        await shot(`waiting-${name}-tooltip`, label);
      }
      await push({ type: 'partial', role: 'user', turnId: 'next', text: 'Next utterance' }); await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice-live').textContent), '');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: clearing does not shift layout`);
      const cleared = await noticeLayout('cleared');
      assert.equal(cleared.rows.length, 0, 'cleared notices leave all reserved room below');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click()); await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-dialog').open), false);
      checks.push({ viewport: { width, height: width === 390 ? 844 : 900 }, locale, theme, geometry, layoutChecks, capture: 'viewport',
        restored: copy.voiceRecovered, unconfirmed: copy.voiceUserUnconfirmed, incomplete: wording.notice, repeat: wording.button,
        dialogTitle: wording.title, dialogExplanation: wording.note, dialogClose: wording.close, buttonHasPopup: 'dialog',
        reservedHeight: width === 390 ? null : 108, phoneLastItem: width === 390, belowShiftPx: 0, desktopButtonGapPx: width === 390 ? null : 12,
        mobileButtonUnderText: width === 390, waitingTooltips: wording.tooltip, noAutoReplay: true, exactLastReply: true, modelCalls: 0, replayAdmissions: 0,
        incrementalReplayMicro: 0, noLayoutShift: true, announcedOnce: true, clearsNextTurn: true, keyboardAndAria: true, pass: true });
    });
  }
  assert.deepEqual(errors, []);
  assertMatrixCaseCount('display-notices', noticeCases);
  if (evidence) await writeFile(join(evidence, 'ait-138-c-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138 c', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', files, checks }, null, 2));
});

test('AIT-149: reveal exit clock survives delayed browser round trips', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-reveal-clock-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_PROVIDER: 'mock',
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); });
  browser = await browserForFile();
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, async c => {
    const { de } = await import('/packages/ui/src/i18n/de.js'), session = c.session;
    session.settings.origin = 'chosen'; localStorage.setItem('aithema-motion', 'on');
    c.configure({ copy: de, session }); c.shadowRoot.querySelector('.band-orb .orb').focus();
  });
  await page.hover('aithema-session >>> .band-orb .orb');
  await finishRevealEntry(page);
  // Every browser-call response arrives after the brand's entire 300ms fade.
  // Capturing the exit in a later call must not silently lose that transition.
  const slowPage = { mouse: { async move(...args) {
    await page.mouse.move(...args);
    await new Promise(resolve => setTimeout(resolve, 400));
  } }, async $eval(...args) {
    const result = await page.$eval(...args);
    await new Promise(resolve => setTimeout(resolve, 400));
    return result;
  } };
  assert.deepEqual(await freezeRevealExit(slowPage), { phase: 'exiting', from: '1', to: '0', duration: 300 }, 'retain the brand fade despite browser round-trip latency');
  await seekReveal(page, 0);
  assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity), '1', 'the initial exit frame is still available');
  await seekReveal(page, 350);
  assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity), '0', 'the 350ms frame is past the completed brand fade');
  await seekReveal(page, 1600);
  await page.evaluate(() => { globalThis.displayRevealCleanup(); delete globalThis.displayRevealCleanup; });
});


test('AIT-105: Tick hover/focus matrix and copied slot have opaque paint and 0 px shift', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-calver-hover-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], evidence = evidenceDirectory, passLines = [];
  page.on('pageerror', error => errors.push(error.message));
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('aithema-demo-locale', 'en');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.ait105Copied = value; } } });
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  const configure = async (locale, display) => page.evaluate(async ({ locale, display }) => {
    const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
    window.ait105Bundles = { de, en }; const copy = window.ait105Bundles[locale];
    const c = document.querySelector('aithema-session'); window.ait105Copy = copy;
    if (!await c.changeLocale(locale)) throw new Error(`Cannot change conversation to ${locale}`);
    c.configure({ copy, copyForLocale: language => window.ait105Bundles[language], session: c.session, host: { version: {
      product: 'Aithema 2026.10', version: '261014080000.0.0', version_scheme: 'inspr-calver-3',
      commit: 'abcdef1234567890', date: '2026-10-14T08:00:00.000Z', display,
    } } });
  }, { locale, display });
  const popupMetrics = () => shadow(page, c => {
    const root = c.shadowRoot, popup = root.querySelector('.footer-info .footer-popup'), build = root.querySelector('#build-info');
    const style = getComputedStyle(popup), row = build.querySelector('.version-row');
    const box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const coordinate = build.querySelector('.coordinate');
    const visibleVersion = coordinate && (coordinate.children.length ? [...coordinate.children].filter(n => n.getBoundingClientRect().width > 0).map(n => n.textContent).join('') : coordinate.textContent);
    const value = row?.querySelector('.version-value'), feedback = row?.querySelector('.version-feedback');
    const valueVisibility = value && getComputedStyle(value).visibility;
    const rgb = color => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = channels => channels.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
      .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const surface = luminance(rgb(style.backgroundColor));
    const text = n => {
      const colour = getComputedStyle(n).color, light = luminance(rgb(colour));
      return { colour, contrast: (Math.max(light, surface) + .05) / (Math.min(light, surface) + .05) };
    };
    const legal = c.querySelector('[slot="legal"]'), notes = c.querySelector('[slot="footer"]');
    const textLines = { notice: text(root.querySelector('#ai-notice')), version: text(value),
      build: text(build.querySelector('.build-label')), link: text(legal.querySelector('a')), notes: text(notes) };
    const versionColours = [...value.querySelectorAll('span')].filter(n => n.getBoundingClientRect().width > 0)
      .map(n => ({ ...text(n), opacity: getComputedStyle(n).opacity }));
    const gap = (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
    const rhythm = [gap(root.querySelector('#ai-notice'), build), gap(row, build.querySelector('.build-label')),
      gap(build, legal), gap(legal, notes)];
    const rowStyle = getComputedStyle(row);
    const ring = rowStyle.outlineStyle !== 'none' && parseFloat(rowStyle.outlineWidth) > 0;
    const rowBox = row.getBoundingClientRect();
    const ringExtent = Math.max(0, parseFloat(rowStyle.outlineWidth) + parseFloat(rowStyle.outlineOffset));
    const ringBox = { left: rowBox.left - ringExtent, top: rowBox.top - ringExtent,
      right: rowBox.right + ringExtent, bottom: rowBox.bottom + ringExtent };
    const buildRange = document.createRange(); buildRange.selectNodeContents(build.querySelector('.build-label'));
    const buildRect = buildRange.getBoundingClientRect();
    const buildTextBox = { left: buildRect.left, top: buildRect.top, right: buildRect.right, bottom: buildRect.bottom };
    const ringIntersectsBuild = ringBox.left < buildTextBox.right && ringBox.right > buildTextBox.left
      && ringBox.top < buildTextBox.bottom && ringBox.bottom > buildTextBox.top;
    const ringBuildGapPx = buildTextBox.top - ringBox.bottom;

    const visibleText = row && (valueVisibility === 'hidden' ? feedback?.innerText : 'Version ' + visibleVersion);
    return { background: style.backgroundColor, opacity: style.opacity, visibility: style.visibility,
      notice: box(root.querySelector('#ai-notice')), popup: box(popup), row: row && box(row),
      build: build.querySelector('.build-label')?.textContent, product: root.querySelector('.display-version').textContent,
      first: build.firstChild?.className, text: visibleText, valueVisibility,
      feedbackPosition: feedback && getComputedStyle(feedback).position, feedbackBox: feedback && !feedback.hidden ? box(feedback) : null,
      version: visibleVersion, title: build.title, textLines, versionColours, rhythm, ring,
      ringBox, buildTextBox, ringIntersectsBuild, ringBuildGapPx,
      cursor: rowStyle.cursor, rowTint: rowStyle.backgroundColor, legal: [...legal.querySelectorAll('a')].map(n => n.textContent), notes: notes.textContent };
  });
  const capture = async (locale, theme, width, state, metrics) => {
    if (state === 'copied') {
      assert.equal(metrics.ringIntersectsBuild, false, `${locale}/${theme}: ring box does not intersect build text box`);
      assert.ok(metrics.ringBuildGapPx >= 3, `${locale}/${theme}: ring/build text gap ${metrics.ringBuildGapPx} px >= 3 px`);
    }
    const file = `ait105-version-${locale}-${theme}-${width}-${state}.png`;
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
    passLines.push({ head: evidenceCommit, locale, theme, width, state, pass: true, displacementPx: 0, file, ...metrics });
    t.diagnostic(`PASS AIT-105 ${locale}/${theme}/${width}/${state}: opaque popup; ${Object.entries(metrics.textLines).map(([line, data]) => `${line} ${data.colour} ${data.contrast.toFixed(2)}:1`).join('; ')}; ring ${metrics.ring ? 'on' : 'off'}${state === 'copied' ? `; ring box does not intersect build text box; gap ${metrics.ringBuildGapPx} px >= 3 px` : ''}; 0 px shift`);
  };
  await t.test('round 3 EN slots on first load and after switching', async () => {
    const strings = () => page.evaluate(() => ['#demo-license', '#demo-legal-source', '#demo-footer'].map(selector => document.querySelector(selector).textContent));
    assert.deepEqual(await strings(), [en.host.slots.license, en.host.slots.legalSource, en.host.slots.footer], 'first EN load');
    await configure('de'); await configure('en');
    assert.deepEqual(await strings(), [en.host.slots.license, en.host.slots.legalSource, en.host.slots.footer]);
    await configure('de');
    assert.deepEqual(await strings(), [de.host.slots.license, de.host.slots.legalSource, de.host.slots.footer], 'switch to DE');
  });
  await configure('de');
  await page.setViewport({ width: 1440, height: 1000 });
  await page.select('#theme', 'dark');
  let notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
  await until(page, () => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.footer-info .footer-popup')).opacity === '1');
  await t.test('opaque approved dark tooltip surface', async () => {
    const metrics = await popupMetrics(); assert.equal(metrics.background, 'rgb(16, 43, 66)'); assert.equal(metrics.opacity, '1');
  });
  await t.test('version has its own line followed by muted UTC build', async () => {
    const metrics = await popupMetrics(); assert.equal(metrics.first, 'version-row');
    assert.equal(metrics.build, 'Build abcdef1\u00a0· 2026-10-14 08:00:00 UTC');
    assert.equal(metrics.version, '26.10.14\u00a0· 08:00');
    assert.ok(metrics.row[1] >= metrics.notice[1] + metrics.notice[3]);
  });
  await t.test('round 3 every text line reaches 4.5:1 in both themes', async () => {
    const failures = [];
    for (const theme of ['light', 'dark']) {
      await page.select('#theme', theme);
      const metrics = await popupMetrics();
      for (const [line, data] of Object.entries({ ...metrics.textLines, ...Object.fromEntries(metrics.versionColours.map((data, i) => [`version-${i}`, data])) })) {
        if (data.contrast < 4.5) failures.push(`${theme}/${line}: ${data.colour} ${data.contrast.toFixed(2)}:1`);
      }
    }
    assert.deepEqual(failures, []);
  });
  await t.test('round 3 build uses the notes muted colour', async () => {
    const { textLines } = await popupMetrics(); assert.equal(textLines.build.colour, textLines.notes.colour);
  });
  await t.test('round 3 primary version colour, pointer and subtle hover tint', async () => {
    const before = await popupMetrics();
    assert.ok(before.versionColours.every(n => n.colour === before.textLines.version.colour && n.opacity === '1'), JSON.stringify(before.versionColours));
    assert.equal(before.cursor, 'pointer');
    await page.hover('aithema-session >>> #build-info .version-row');
    assert.notEqual((await popupMetrics()).rowTint, before.rowTint);
    await notice.hover();
  });
  await t.test('round 3 four groups with 8 px gaps and version/build 2 px', async () => {
    assert.deepEqual((await popupMetrics()).rhythm, [8, 2, 8, 8]);
  });
  await t.test('round 3 copied ring only for keyboard focus', async () => {
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
    await page.click('aithema-session >>> #build-info .version-row');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
    assert.equal((await popupMetrics()).ring, false, 'mouse copy');
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
    assert.equal((await popupMetrics()).ring, true, 'keyboard copy');
    await page.click('aithema-session >>> #build-info .version-row');
    assert.equal((await popupMetrics()).ring, false, 'mouse copy after keyboard focus');
    await notice.click(); await page.keyboard.press('Tab');
    assert.equal((await popupMetrics()).ring, true, 'keyboard focus returns after clicking away from mouse copy');
    await page.keyboard.press('Tab');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal((await popupMetrics()).ring, true, 'keyboard Tab focus returns after mouse copy');
    await page.keyboard.press('Enter'); assert.equal((await popupMetrics()).ring, true, 'keyboard styling returns after mouse copy');
  });
  await t.test('round 3 failed clipboard and execCommand replace the value with 0 px shift', async () => {
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover(); const before = await popupMetrics();
    await page.evaluate(() => {
      window.ait105Clipboard = navigator.clipboard; window.ait105Exec = document.execCommand;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard denied'); } } });
      document.execCommand = () => false;
    });
    try {
      await page.click('aithema-session >>> #build-info .version-row');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="error"]'));
      const failed = await popupMetrics();
      assert.equal(failed.valueVisibility, 'hidden'); assert.deepEqual(failed.row, before.row); assert.deepEqual(failed.popup, before.popup);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.version-feedback input').value), '261014080000.0.0');
      assert.deepEqual(await shadow(page, c => {
        const field = c.shadowRoot.querySelector('.version-feedback input');
        return { focused: c.shadowRoot.activeElement === field, selected: field.value.slice(field.selectionStart, field.selectionEnd),
          description: field.getAttribute('aria-description') };
      }), { focused: true, selected: '261014080000.0.0',
        description: 'Kopieren nicht verfügbar. Die Version ist markiert: mit ⌘C oder Strg+C kopieren.' });
    } finally {
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.ait105Clipboard }); document.execCommand = window.ait105Exec; });
      await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
    }
  });
  await t.test('copy replaces version in the same slot for 1.2 s without an overlay', async () => {
    const before = await popupMetrics(), coordinate = await page.$('aithema-session >>> #build-info .coordinate');
    await coordinate.click();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#build-info [data-copy-state="copied"]'));
    const copied = await popupMetrics(); assert.equal(copied.text, 'Kopiert');
    assert.equal(copied.valueVisibility, 'hidden'); assert.equal(copied.feedbackPosition, 'static');
    assert.equal(copied.feedbackBox[1], copied.row[1]);
    assert.deepEqual(copied.popup, before.popup); assert.deepEqual(copied.row, before.row);
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal((await popupMetrics()).text, 'Version 26.10.14\u00a0· 08:00');
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.select('#theme', theme);
    await configure(locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    await page.mouse.move(0, 0); await settle(page);
    const notice = await page.$('aithema-session >>> .ai-notice');
    await notice.evaluate(n => n.scrollIntoView({ block: 'center' }));
    const footerBefore = await boxes(page, ['.display-foot', '.ai-notice', '.host-credits', '.footer-right']);
    for (const state of ['hover', 'focus']) {
      await shadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
      if (state === 'hover') await notice.hover();
      else { await notice.focus(); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await page.keyboard.press('Tab');
        assert.equal(await notice.evaluate(n => n.getRootNode().activeElement === n && n.matches(':focus-visible')), true); }
      await until(page, () => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.footer-info .footer-popup')).opacity === '1');
      const metrics = await popupMetrics();
      for (const data of Object.values(metrics.textLines)) assert.ok(data.contrast >= 4.5);
      assert.deepEqual(metrics.rhythm, [8, 2, 8, 8]);
      const copy = locale === 'de' ? de : en;
      assert.deepEqual(metrics.legal, [copy.host.slots.license, copy.host.slots.legalSource]); assert.equal(metrics.notes, copy.host.slots.footer);
      assert.equal(metrics.visibility, 'visible'); assert.equal(metrics.opacity, '1');
      assert.equal(metrics.background, 'rgb(16, 43, 66)');
      const viewportPaint = pixels(Buffer.from(await page.screenshot({ fullPage: false })));
      const surfaceOffset = ((Math.floor(metrics.popup[1]) + 4) * viewportPaint.width + Math.floor(metrics.popup[0]) + 14) * viewportPaint.channels;
      assert.deepEqual([...viewportPaint.result.subarray(surfaceOffset, surfaceOffset + 3)], [16, 43, 66], 'painted popup pixel is opaque approved dark surface');
      assert.equal(metrics.product, 'Aithema 2026.10'); assert.equal(metrics.first, 'version-row');
      assert.equal(metrics.version, '26.10.14\u00a0· 08:00');
      assert.equal(metrics.build, 'Build abcdef1\u00a0· 2026-10-14 08:00:00 UTC');
      assert.match(metrics.title, /261014080000\.0\.0.*2026-10-14 08:00:00 UTC/u);
      assert.deepEqual(await boxes(page, ['.display-foot', '.ai-notice', '.host-credits', '.footer-right']), footerBefore);
      await capture(locale, theme, width, state, metrics);
    }
    if (width === 1440) {
      const before = await popupMetrics(); await page.evaluate(() => { window.ait105Copied = null; });
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await until(page, () => window.ait105Copied === '261014080000.0.0');
      const copied = await popupMetrics(); assert.equal(copied.text, locale === 'de' ? 'Kopiert' : 'Copied');
      assert.equal(copied.valueVisibility, 'hidden'); assert.equal(copied.feedbackPosition, 'static');
      assert.equal(copied.feedbackBox[1], copied.row[1]);
      assert.deepEqual(copied.row, before.row); assert.deepEqual(copied.popup, before.popup);
      assert.equal(copied.ring, true);
      await capture(locale, theme, width, 'copied', copied);
      await new Promise(resolve => setTimeout(resolve, 1300));
      assert.equal((await popupMetrics()).text, 'Version 26.10.14\u00a0· 08:00');
    }
    if (locale === 'de' && theme === 'light' && width === 1440) {
      await shadow(page, c => c.shadowRoot.activeElement?.blur()); await notice.hover();
      const before = await popupMetrics(); await page.click('aithema-session >>> #build-info .version-row');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
      const copied = await popupMetrics(); assert.equal(copied.ring, false);
      assert.deepEqual(copied.row, before.row); assert.deepEqual(copied.popup, before.popup);
      await capture(locale, theme, width, 'copied-mouse', copied);
      await new Promise(resolve => setTimeout(resolve, 1300));
    }
    const originalColor = await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('#build-info .yy')).color);
    await shadow(page, c => { c.style.setProperty('--aithema-accent', '#a52233'); });
    await configure(locale);
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('#build-info .yy')).color), originalColor, 'popup primary version does not inherit host accent overrides');
    await shadow(page, c => c.style.removeProperty('--aithema-accent'));
    await configure(locale, 'semver');
    const reduced = await page.$('aithema-session >>> #build-info .coordinate');
    assert.equal(await reduced.evaluate(n => n.textContent), '261014080000.0.0');
    await shadow(page, c => c.shadowRoot.querySelector('.ai-notice').focus());
    await page.evaluate(() => { window.ait105Copied = null; }); await reduced.click();
    assert.equal(await page.evaluate(() => window.ait105Copied), '261014080000.0.0');
  }
  await page.evaluate(async () => {
    const c = document.querySelector('aithema-session');
    c.configure({ copy: window.ait105Copy, session: c.session, host: { version: { version: '261014080000.0.0', version_scheme: 'future-scheme' } } });
  });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#build-info .coordinate')), null);
  assert.equal(await shadow(page, c => Boolean(c.session.id && c.shadowRoot.querySelector('textarea'))), true);
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait105-version-pass-lines.json'), JSON.stringify(passLines, null, 2));
});

test('AIT-246 Tick follow-ups: DE/EN copy, stable controls, narrow footer, export, pointer hints and appearance', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-ui-polish-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(), page = await browser.newPage();
  const emulation = await page.createCDPSession();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const evidence = evidenceDirectory, checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mockIdentityReads(page);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => {
    window.polishSeed = structuredClone(c.session);
    const fetch = window.fetch;
    window.fetch = async (url, init = {}) => {
      const response = await fetch(url, init);
      if ((init.method ?? 'GET') === 'GET' && new URL(url, location.href).pathname.endsWith('/settings')) {
        // Keep the real catalog, with the scene's acknowledged selection.
        const catalog = await response.json();
        return Response.json({ ...catalog, processingPreset: c.session.processingPreset, settings: c.session.settings, engine: c.session.engine });
      }
      return response;
    };
  });
  const stable = ['.band', '.audio-rail', '.concept-bar', '.composer-shell', '.display-foot', '.understanding > .foot'];
  const record = (label, state, detail = {}) => {
    checks.push({ head: evidenceCommit, label, state, ...detail });
  };
  const states = [
    ['option-unoffered', 'visuals not offered', 'draftsUnoffered'],
    ['preset-unconfigured', 'preset not configured', 'draftsPreset', 'draftsChoose'],
    ['device', 'unavailable on device', 'draftsDevice', 'draftsChoose'],
    ['quote-missing', null, 'draftsQuote', 'draftsRetry'],
    ['admission-timeout', 'admission deadline', 'draftsTimeout', 'draftsRetry'],
  ];
  // One loaded page, reused across widths/locales; iterate every state in-page.
  // Theme-independent behavior uses DE light and EN dark; appearance checks select all themes.
  for (const locale of ['de', 'en']) for (const width of [1440, 390, 320]) {
    const theme = locale === 'de' ? 'light' : 'dark';
    const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, hasTouch: false });
    await page.select('#theme', theme);
    const configure = (state, reason) => shadow(page, async (c, { locale, state, reason }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { inputRevision } = await import('/packages/core/src/session.js');
      const s = structuredClone(window.polishSeed);
      s.locale = locale; s.processingPreset = state === 'device' ? 'device' : 'best';
      s.settings = { ...s.settings, origin: 'chosen' }; s.paused = false; s.pauseReason = null;
      s.transcript = [{ id: 'polish-user', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' },
        { id: 'polish-reply', role: 'assistant', content: locale === 'de' ? 'Wie sollen Kunden bestellen?' : 'How should customers order?' }];
      s.transcript[1].inputRevision = inputRevision(s);
      s.understanding = { ...s.understanding, inputRevision: inputRevision(s), summary: s.transcript[0].content, readinessAssessed: true };
      s.featureMatrix = { [s.processingPreset]: Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'html', 'images'].map(key => [key,
        ['html', 'images'].includes(key) ? { available: !reason, reason } : { available: true, reason: null }])) };
      s.conceptVisualKind = 'html'; s.conceptCost = state.includes('quote-missing') ? null : { maxMicro: 400_000 };
      s.concepts = state === 'draft-ready-quote-missing' ? [{ id: 'polish-ready', mediaType: 'text/html', turnIds: ['polish-user'], referenceIds: [], archived: false }] : []; s.conceptStatus = { phase: 'idle' };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ copy, session: s, paimosImportUrl: 'https://paimos.example.test/import/project-draft', paimosImportVersion: 1,
        host: { library: true } });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
      const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      window.scrollTo(0, 0);
    }, { locale, state, reason });
    let baseline;
    for (const [state, reason, message, action] of states) {
      await configure(state, reason); await finishWorkspaceEntry(page);
      const text = await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent);
      assert.equal(text, copy.display[message] + (action ? `\u00a0· ${copy.display[action]}` : ''), `${label}/${state}: exact mirrored copy and NBSP`);
      const current = await boxes(page, stable);
      if (baseline) assert.deepEqual(current, baseline, `${label}/${state}: 0 px layout shift across refusals`);
      else baseline = current;
      const actionNode = 'aithema-session >>> .drafts-settings-action';
      if (action) {
        const actionBox = await boxes(page, ['.drafts-settings-action']);
        await page.hover(actionNode);
        assert.deepEqual(await boxes(page, stable), current, `${label}/${state}: 0 px hover shift`);
        assert.deepEqual(await boxes(page, ['.drafts-settings-action']), actionBox, `${label}/${state}: action stays under pointer`);
      }
      record(label, state, { text, displacementPx: 0 });
      if (action === 'draftsChoose' && width === 1440) {
        await page.click(actionNode);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), true);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('[data-tab="model"]').getAttribute('aria-selected')), 'true');
        if (state === 'device') {
          assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.matches('.preset-option[data-preset="device"]')), true);
          const presetView = await shadow(page, c => {
            const root = c.shadowRoot, field = root.querySelector('.presets').closest('fieldset').getBoundingClientRect();
            const body = root.querySelector('.settings__body').getBoundingClientRect();
            return field.top >= body.top && field.bottom <= body.bottom;
          });
          assert.equal(presetView, true, `${label}: processing heading and all preset choices are in view`);
          record(label, 'device-preset-settings');
        }
        await shadow(page, c => c.shadowRoot.querySelector('dialog.settings .done').click());
      } else if (action === 'draftsRetry' && width === 1440) {
        // Retry reads a snapshot; it must never request or charge for a draft.
        let reads = 0, paidRequests = 0;
        const interceptor = async request => {
          if (request.url() === `${demo.url}/api/sessions/${windowSeedId}` && request.method() === 'GET') {
            reads++; await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(retrySnapshot) });
          } else { if (request.method() === 'POST' && request.url().endsWith('/concepts')) paidRequests++; await request.continue(); }
        };
        const retrySnapshot = await shadow(page, c => c.session), windowSeedId = retrySnapshot.id;
        await page.setRequestInterception(true); page.on('request', interceptor);
        await page.click(actionNode); await until(page, () => true); await settle(page);
        page.off('request', interceptor); await page.setRequestInterception(false);
        assert.equal(reads, 1); assert.equal(paidRequests, 0);
      }
      if (state === 'device' || state === 'option-unoffered') {
        await shadow(page, c => c.shadowRoot.querySelector('.understanding > .foot').scrollIntoView({ block: 'center' }));
        const footer = await shadow(page, c => {
          const root = c.shadowRoot, link = root.querySelector('.export'), create = root.querySelector('.create-project');
          const a = link.getBoundingClientRect(), b = create.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(link.querySelector('[data-copy]'));
          const other = document.createRange(); other.selectNodeContents(create.querySelector('span'));
          const reason = root.querySelector('.export-reason');
          return { disabled: link.getAttribute('aria-disabled'), href: link.getAttribute('href'), why: link.title,
            reason: reason?.textContent, reasonVisible: Boolean(reason?.checkVisibility() && getComputedStyle(reason).visibility === 'visible'),
            described: link.getAttribute('aria-describedby') === reason?.id, tabIndex: link.tabIndex, role: link.getAttribute('role'),
            underline: getComputedStyle(link).textDecorationLine, lines: range.getClientRects().length, projectLines: other.getClientRects().length,
            stacked: b.top >= a.bottom, right: Math.max(a.right, b.right) };
        });
        if (width < 480) { assert.equal(footer.lines, 1); assert.equal(footer.projectLines, 1); }
        else { assert.ok(footer.lines <= 2); assert.ok(footer.projectLines <= 2); }
        assert.equal(footer.stacked, width < 480); assert.ok(footer.right <= width);
        if (state === 'device') { assert.equal(footer.disabled, 'true'); assert.equal(footer.href, null); assert.equal(footer.underline, 'none'); assert.equal(footer.why, copy.deviceExportUnavailable);
          assert.equal(footer.reason, copy.deviceExportUnavailable); assert.equal(footer.reasonVisible, true);
          assert.equal(footer.described, true); assert.equal(footer.tabIndex, 0); assert.equal(footer.role, 'link'); }
        else { assert.ok(footer.href); assert.equal(footer.underline, 'underline'); assert.equal(footer.reasonVisible, false); }
        record(label, `${state}-footer`, footer);
      }
    }
    await configure('draft-ready-quote-missing', null); await finishWorkspaceEntry(page);
    const ready = await shadow(page, c => ({ text: c.shadowRoot.querySelector('.concept-activity-text').textContent,
      recovery: Boolean(c.shadowRoot.querySelector('.concept-activity-text .drafts-settings-action')) }));
    assert.deepEqual(ready, { text: copy.conceptDraftReady.replace('{number}', '1'), recovery: false });
    record(label, 'draft-ready-quote-missing', ready);
    // Pointer/platform behavior is independent of width; cover both platforms
    // and touch once per locale, alongside the narrow footer checks.
    if (width === 390) {
      await configure('option-unoffered', 'visuals not offered'); await finishWorkspaceEntry(page);
      for (const [platform, key] of [['MacIntel', copy.shortcutKeys.mac], ['Win32', copy.shortcutKeys.other]]) {
        await page.evaluate(platform => Object.defineProperty(navigator, 'platform', { configurable: true, value: platform }), platform);
        await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), copy.shortcut.replace('{key}', key));
        record(label, `fine-${platform}`);
      }
      const fineBoxes = await boxes(page, stable.concat('.send', '.attach'));
      await emulation.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), true);
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-reason')).visibility), 'hidden');
      assert.deepEqual(await boxes(page, stable.concat('.send', '.attach')), fineBoxes, `${label}: touch hint hides with 0 px shift`);
      record(label, 'coarse');
      await emulation.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await shadow(page, c => c.openSettings());
    let utilityBaseline;
    for (const choice of ['light', 'dark', 'system']) {
      await page.select('#theme', choice);
      const metrics = await page.evaluate(() => {
        const root = document.querySelector('aithema-session').shadowRoot, value = document.querySelector('#theme-value'), chevron = document.querySelector('.utility-theme .utility-chevron');
        const box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        return { gap: chevron.getBoundingClientRect().left - value.getBoundingClientRect().right,
          boxes: [box(document.querySelector('.utility-theme')), box(document.querySelector('.utility-language')), box(root.querySelector('.done'))] };
      });
      assert.equal(metrics.gap, 4, `${label}/${choice}: appearance chevron hugs actual text`);
      if (utilityBaseline) assert.deepEqual(metrics.boxes, utilityBaseline, `${label}/${choice}: 0 px preference and Done shift`);
      else utilityBaseline = metrics.boxes;
      record(label, `appearance-${choice}`, metrics);
    }
    await shadow(page, c => c.shadowRoot.querySelector('dialog.settings .done').click());
  }
  assert.equal(checks.length, 74, 'all states at desktop/390/320 in DE/EN, pointer/platform cases and desktop recovery actions');
  if (evidence) await writeFile(join(evidence, 'ait246-evidence.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', fonts: 'Chrome baseline UI/display stacks pinned', checks }, null, 2));
});

test('AIT-246 round 2 regressions: visible export reason, device preset destination and existing drafts without a quote', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-polish-round2-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mockIdentityReads(page);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.round2Seed = structuredClone(c.session); });
  const configure = (device, items = []) => shadow(page, async (c, { device, items }) => {
    const { en } = await import('/packages/ui/src/i18n/en.js');
    const { inputRevision } = await import('/packages/core/src/session.js');
    const s = structuredClone(window.round2Seed);
    s.paused = false; s.pauseReason = null;
    s.transcript = [{ id: 'round2-user', role: 'user', content: 'A bakery website.' }, { id: 'round2-reply', role: 'assistant', content: 'How should customers order?' }];
    s.transcript[1].inputRevision = inputRevision(s);
    s.understanding = { ...s.understanding, inputRevision: inputRevision(s), summary: s.transcript[0].content, readinessAssessed: true };
    s.settings.origin = 'chosen'; s.processingPreset = device ? 'device' : 'best';
    s.conceptVisualKind = 'html'; s.conceptCost = null; s.concepts = items;
    s.conceptStatus = { phase: 'idle' };
    s.featureMatrix = { [s.processingPreset]: { html: { available: !device, reason: device ? 'unavailable on device' : null } } };
    c.setAttribute('motion', 'off'); c.configure({ copy: en, session: s });
  }, { device, items });
  await t.test('disabled export has a visible, associated reason and remains keyboard focusable', async () => {
    await configure(true); await finishWorkspaceEntry(page);
    const result = await shadow(page, c => {
      const link = c.shadowRoot.querySelector('.export'), reason = c.shadowRoot.getElementById(link.getAttribute('aria-describedby'));
      link.focus();
      return { focused: c.shadowRoot.activeElement === link, role: link.getAttribute('role'),
        reason: reason?.textContent, visible: Boolean(reason && reason.checkVisibility() && getComputedStyle(reason).visibility === 'visible') };
    });
    assert.deepEqual(result, { focused: true, role: 'link', reason: en.deviceExportUnavailable, visible: true });
  });
  await t.test('device recovery opens and focuses the selected processing preset', async () => {
    await configure(true); await finishWorkspaceEntry(page);
    await page.click('aithema-session >>> .drafts-settings-action');
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.matches('.preset-option[data-preset="device"]')), true);
    await shadow(page, c => c.shadowRoot.querySelector('dialog.settings .done').click());
  });
  await t.test('a missing quote preserves the ready sentence for existing drafts', async () => {
    await configure(false, [{ id: 'ready-round2', mediaType: 'text/html', turnIds: [], referenceIds: [], archived: false }]);
    await finishWorkspaceEntry(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), en.conceptDraftReady.replace('{number}', '1'));
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.concept-activity-text .drafts-settings-action'))), false);
  });
});

test('AIT-246 round 3: person-facing visual options and provider description, DE/EN light/dark desktop/phone', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-polish-round3-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_COMMIT: evidenceCommit });
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const evidence = evidenceDirectory, checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mockIdentityReads(page);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.select('#theme', theme);
    await shadow(page, async (c, locale) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ copy, session: c.session });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
      const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      c.shadowRoot.querySelector('.settings-open').click();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-select="visuals"] [data-value="claude-html"]'));
    await shadow(page, c => {
      const select = c.shadowRoot.querySelector('[data-select="visuals"]');
      select.scrollIntoView({ block: 'center' });
      select.querySelector('.select__button').click();
    });
    const actual = await shadow(page, c => [...c.shadowRoot.querySelectorAll('[data-select="visuals"] [role="option"]')].map(node => ({
      id: node.dataset.value, label: node.querySelector('strong').textContent, description: node.querySelector('.option-label small')?.textContent ?? '',
    })));
    assert.deepEqual(actual.map(o => o.id), ['off', 'fake-html', 'claude-html', 'fake-images', 'openai-images']);
    assert.deepEqual(actual.find(o => o.id === 'claude-html'), { id: 'claude-html', label: locale === 'de' ? 'Klickbarer Entwurf' : 'Clickable draft', description: locale === 'de' ? 'über Claude' : 'via Claude' });
    assert.doesNotMatch(actual.map(o => `${o.label} ${o.description}`).join(' '), /dummy|\bfake\b|\bmock\b|\bHTML\b|\bPNG\b|\bagent\b|deterministi/iu);
    await shadow(page, async c => {
      c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.mouse.move(-1, -1);
    const visible = await shadow(page, c => {
      const root = c.shadowRoot, option = root.querySelector('[data-select="visuals"] [data-value="claude-html"]');
      const description = option.querySelector('.option-label small'), body = root.querySelector('.settings__body');
      const r = description.getBoundingClientRect(), b = body.getBoundingClientRect();
      return { menuOpen: !option.closest('[role="listbox"]').hidden, descriptionVisible: r.top >= b.top && r.bottom <= b.bottom && r.left >= 0 && r.right <= innerWidth,
        focused: Boolean(root.activeElement), font: getComputedStyle(description).fontFamily };
    });
    assert.equal(visible.menuOpen, true); assert.equal(visible.descriptionVisible, true, `${locale}/${theme}/${width}: description in viewport`);
    assert.equal(visible.focused, false, 'blur before viewport evidence');
    const file = `ait246-${width}-${theme}-${locale}-visual-options.png`;
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    checks.push({ head: evidenceCommit, locale, theme, width, file, options: actual, ...visible });
    await shadow(page, c => c.shadowRoot.querySelector('dialog.settings .done').click());
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  }
  assert.equal(checks.length, 8);
  if (evidence) await writeFile(join(evidence, 'ait246-round3-evidence.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', reducedMotion: true, checks }, null, 2));
});

test('AIT-246 round 4: narrow draft rail has disjoint boxes and zero shift in DE/EN at 390/320', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-narrow-draft-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'fake', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const evidence = evidenceDirectory, checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await mockIdentityReads(page);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.narrowDraftSeed = structuredClone(c.session); });
  const states = [
    ['option-unoffered', 'visuals not offered'], ['preset-unconfigured', 'preset not configured'],
    ['device', 'unavailable on device'], ['quote-missing', null], ['admission-timeout', 'admission deadline'],
    ['not-configured', 'not configured'], ['off', 'visuals off'], ['low', 'budget'],
    ['unavailable', 'unavailable'], ['request', null], ['draft-ready', null], ['draft-ready-quote-missing', null],
  ];
  const capture = async (file, cropBand = true) => {
    if (!evidence) return;
    await shadow(page, async c => {
      c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.mouse.move(-1, -1);
    const clip = cropBand ? await shadow(page, c => {
      const root = c.shadowRoot, a = root.querySelector('.band').getBoundingClientRect(), b = root.querySelector('.concept-bar').getBoundingClientRect();
      return { x: 0, y: Math.max(0, a.top), width: innerWidth, height: Math.min(innerHeight, b.bottom) - Math.max(0, a.top) };
    }) : undefined;
    await page.screenshot({ path: join(evidence, file), clip, captureBeyondViewport: false });
  };
  for (const locale of ['de', 'en']) for (const width of [390, 320]) {
    const theme = locale === 'de' ? 'light' : 'dark';
    await page.setViewport({ width, height: 844 }); await page.select('#theme', theme);
    let baseline;
    for (const [state, reason] of states) {
      await shadow(page, async (c, { locale, state, reason }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const { inputRevision } = await import('/packages/core/src/session.js');
        const s = structuredClone(window.narrowDraftSeed);
        s.locale = locale; s.processingPreset = state === 'device' ? 'device' : 'best';
        s.settings = { ...s.settings, origin: 'chosen' }; s.paused = false; s.pauseReason = null;
        s.transcript = [{ id: 'narrow-user', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' },
          { id: 'narrow-reply', role: 'assistant', content: locale === 'de' ? 'Wie sollen Kunden bestellen?' : 'How should customers order?' }];
        s.transcript[1].inputRevision = inputRevision(s);
        s.understanding = { ...s.understanding, inputRevision: inputRevision(s), summary: s.transcript[0].content, readinessAssessed: true };
        s.featureMatrix = { [s.processingPreset]: Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'html', 'images'].map(key => [key,
          ['html', 'images'].includes(key) ? { available: !reason, reason } : { available: true, reason: null }])) };
        s.conceptVisualKind = 'html'; s.conceptCost = state.includes('quote-missing') ? null : { maxMicro: 400_000 };
        s.concepts = state.startsWith('draft-ready') ? [{ id: 'narrow-ready', mediaType: 'text/html', turnIds: ['narrow-user'], referenceIds: [], archived: false }] : [];
        s.conceptStatus = { phase: 'idle' };
        c.setAttribute('motion', 'off');
        c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
        c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
        c.configure({ copy, session: s, host: { library: true } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
        window.scrollTo(0, 0);
      }, { locale, state, reason });
      await finishWorkspaceEntry(page);
      const geometry = await shadow(page, c => {
        const root = c.shadowRoot, rail = root.querySelector('.concept-bar');
        const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        const visible = n => n.checkVisibility({ visibilityProperty: true });
        const parts = [];
        // Compare independent painted primitives, never an ancestor with its descendants.
        const seen = new Set();
        for (const selector of ['.concept-scene', '.concept-request', '.drafts-settings-action', '.consent-action', '.concept-preview-glyph svg', '.concept-preview img', '.concept-progress']) {
          const n = rail.querySelector(selector);
          if (n && visible(n) && !seen.has(n)) { seen.add(n); parts.push({ name: selector, ...box(n.getBoundingClientRect()) }); }
        }
        for (const selector of ['.concept-activity-text', '.concept-countdown', '.concept-preview-label']) {
          const n = rail.querySelector(selector); if (!n || !visible(n)) continue;
          const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode;
            if (!text.textContent.trim() || text.parentElement.closest('button') && selector !== '.concept-preview-label') continue;
            const range = document.createRange(); range.selectNodeContents(text);
            for (const r of range.getClientRects()) if (r.width && r.height) parts.push({ name: `${selector}: ${text.textContent}`, ...box(r) });
          }
        }
        const controls = [...root.querySelectorAll('.motion-toggle, .band button, .band-orb [role="button"]')]
          .filter(n => visible(n) && !n.matches('.fold')).map(n => ({ name: n.className, ...box(n.getBoundingClientRect()) }));
        return { bounds: box(rail.getBoundingClientRect()), parts, controls, fold: { name: '.fold', ...box(root.querySelector('.fold').getBoundingClientRect()) } };
      });
      const context = `${width}/${locale}/${state}: ${JSON.stringify(geometry)}`;
      assert.ok(geometry.parts.length >= 2, context);
      for (const control of geometry.controls) {
        const fold = geometry.fold;
        assert.ok(Math.min(control.right, fold.right) <= Math.max(control.left, fold.left) + .1 || Math.min(control.bottom, fold.bottom) <= Math.max(control.top, fold.top) + .1, `fold intersects ${control.name}; ${context}`);
      }
      const sceneBox = geometry.parts.find(p => p.name === '.concept-scene');
      assert.ok(sceneBox.left >= geometry.fold.right + 8 || sceneBox.top >= geometry.fold.bottom + 8, `scene clears fold control by 8 px; ${context}`);
      for (const [i, a] of geometry.parts.entries()) {
        assert.ok(a.left >= geometry.bounds.left && a.right <= geometry.bounds.right + .5 && a.top >= geometry.bounds.top && a.bottom <= geometry.bounds.bottom + .5, context);
        for (const b of [...geometry.parts.slice(i + 1), geometry.fold]) assert.ok(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + .1 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + .1, `intersecting ${a.name} / ${b.name}; ${context}`);
      }
      const current = await boxes(page, ['.concept-bar', '.composer-shell', '.display-foot']);
      if (baseline) assert.deepEqual(current, baseline, `${context}: 0 px between all draft-line states`); else baseline = current;
      if (state === 'draft-ready-quote-missing') {
        const status = geometry.parts.filter(p => p.name.startsWith('.concept-activity-text:'));
        const label = geometry.parts.filter(p => p.name.startsWith('.concept-preview-label:'));
        const scene = geometry.parts.find(p => p.name === '.concept-scene'), glyph = geometry.parts.find(p => p.name === '.concept-preview-glyph svg');
        assert.equal(status.length, 1, context); assert.equal(label.length, 1, context);
        assert.equal(status[0].name, `.concept-activity-text: ${{ de, en }[locale].conceptDraftReady.replace('{number}', '1')}`);
        assert.ok(scene.top < status[0].bottom && status[0].top < scene.bottom, context);
        assert.ok(label[0].top >= status[0].bottom && glyph.top >= scene.bottom, context);
        assert.equal(scene.left, glyph.left, context); assert.equal(status[0].left, label[0].left, context);
        if (width === 390) await capture(`ait246-r5-${width}-${theme}-${locale}-draft-ready.png`);
      }
      checks.push({ head: evidenceCommit, width, locale, theme, state, displacementPx: 0, ...geometry });
    }
  }
  assert.equal(checks.length, 48);
  // Show the actual demo header's copy, in a settled desktop viewport.
  await page.setViewport({ width: 1440, height: 1000 }); await page.select('#theme', 'light');
  await page.evaluate(() => localStorage.setItem('aithema-demo-locale', 'de'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id && document.documentElement.lang === 'de');
  await shadow(page, c => {
    c.setAttribute('motion', 'off');
    c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
    c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
  });
  await page.$eval('.demo-strip', n => n.scrollIntoView({ block: 'end' }));
  assert.doesNotMatch(await page.$eval('.demo-strip', n => n.textContent), /Klick-Dummy|click-dummy|\bfake\b|\bmock\b/iu);
  await capture('ait246-r4-1440-light-de-demo-header.png', false);
  if (evidence) await writeFile(join(evidence, 'ait246-r4-geometry.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', checks }, null, 2));
});
