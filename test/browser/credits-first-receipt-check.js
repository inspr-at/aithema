import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceCommit, shadow, until } from './start2-display-helpers.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  for (const root of [document, c.shadowRoot]) for (const animation of root.getAnimations()) {
    if (animation.effect?.getTiming().iterations !== Infinity) await animation.finished.catch(() => {});
  }
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
});
const measure = page => shadow(page, c => {
  const root = c.shadowRoot, amount = root.querySelector('.host-credits__amount');
  const box = n => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const selectors = ['.display-foot', '.display-foot__row', '.footer-info', '.ai-notice',
    '.host-credits', '.host-credits__button', '.host-credits__amount', '.host-credits__value',
    '.host-credits__track', '.footer-right', '.preset-panel', '.host-legal', '.engine__flag', '.status__dot'];
  return { rects: Object.fromEntries(selectors.map(s => [s, box(root.querySelector(s))])),
    legal: [...c.querySelectorAll('#demo-legal a')].map(box),
    legalLabels: [...c.querySelectorAll('#demo-legal a')].map(link => link.textContent),
    value: amount.textContent, reserved: amount.dataset.creditMeasure,
    numeric: getComputedStyle(amount).fontVariantNumeric, align: getComputedStyle(amount.firstElementChild).textAlign,
    gap: getComputedStyle(root.querySelector('.display-foot__row')).columnGap,
    fit: root.querySelector('.display-foot').dataset.fit };
});

export async function creditsFirstReceiptCheck(t) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const head = event?.pull_request?.head.sha ?? evidenceCommit;
  const directory = await mkdtemp(join(tmpdir(), 'aithema-first-receipt-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: head,
  });
  const browser = await browserForFile(), page = await browser.newPage(), errors = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('aithema-demo-locale', 'de');
    const original = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      if (new URL(url, location.href).pathname.endsWith('/credits')) {
        const fixture = window.ait357;
        if (!fixture) return new Promise(() => {});
        fixture.requested = true;
        await new Promise(resolve => { fixture.release = resolve; });
        const limitMicro = fixture.limitMicro;
        return Response.json({ exhausted: false, limitSlot: null,
          tiers: { current: 'emailConfirmed', next: null, delta: 0, allowancesMicro: { emailConfirmed: limitMicro } },
          balance: { owner: { limitMicro, availableMicro: limitMicro, committedMicro: 0, reservedMicro: 0 } } });
      }
      return original(url, init);
    };
  });
  await page.setViewport({ width: 320, height: 844 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.documentElement.hasAttribute('data-host-ready'));
  await shadow(page, c => { window.ait357Base = structuredClone(c.session); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], shots = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (width, state) => {
    const file = `ait357-${width}-light-de-${state}.png`;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle(page);
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    shots.push({ file, head, viewport: true, reducedMotion: true, blurred: true });
  };
  for (const width of [320, 390, 1024, 1440]) for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const limitMicro of [100_000_000, 24_000_000, 980_000]) {
    await page.setViewport({ width, height: 844 });
    await shadow(page, async (c, { width, locale, theme, limitMicro }) => {
      const { [locale]: baseCopy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { withDemoConsentCopy } = await import('/demo/consent-copy.js');
      const copy = withDemoConsentCopy(baseCopy);
      const session = structuredClone(window.ait357Base); session.locale = locale;
      window.ait357 = { limitMicro };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy, host: { credits: true, library: true } });
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme; c.setAttribute('theme', theme);
      document.querySelector('#locale').value = locale; document.querySelector('#theme').value = theme;
      const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      const { paintLicenseLabel } = await import('/demo/license-label.js');
      // The fixture changes locale without the demo's new-session flow. Paint
      // its host-owned legal labels with the same full/short copy as the demo.
      for (const [id, full, short] of [['demo-license', copy.host.slots.license, copy.host.slots.licenseShort],
        ['demo-legal-source', copy.host.slots.legalSource, copy.host.slots.legalSourceShort]]) {
        const link = document.getElementById(id); link.setAttribute('aria-label', full); link.title = full;
        if (width < 600) {
          const label = document.createElement('span'); label.className = 'demo-legal-short'; label.textContent = short; link.replaceChildren(label);
        } else if (id === 'demo-license') paintLicenseLabel(link, full); else link.textContent = full;
      }
    }, { width, locale, theme, limitMicro });
    await until(page, () => window.ait357.requested);
    await settle(page);
    const before = await measure(page), label = `${width}/${locale}/${theme}/${limitMicro / 10_000}`;
    assert.equal(before.value, '…', `${label}: receipt held pending`);
    if (width < 600) assert.deepEqual(before.legalLabels, ['AGPL-3.0', locale === 'de' ? 'Quellcode' : 'Source'], `${label}: real demo legal labels are present`);
    if (locale === 'de' && theme === 'light' && width < 400 && limitMicro === 24_000_000) await capture(width, 'before');
    const target = before.rects['.host-credits__button'];
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await settle(page);
    await page.evaluate(() => window.ait357.release());
    await until(page, ({ locale, limitMicro }) => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent === new Intl.NumberFormat(locale).format(limitMicro / 10_000), { locale, limitMicro });
    await settle(page);
    const after = await measure(page);
    if (locale === 'de' && theme === 'light' && width < 400 && limitMicro === 24_000_000) await capture(width, 'after');
    checks.push({ width, locale, theme, limitMicro, before, after, maxMovementPx: Math.max(...Object.keys(before.rects).flatMap(s => Object.keys(before.rects[s]).map(k => Math.abs(after.rects[s][k] - before.rects[s][k])))) });
    // Exact rectangles, including width/height: no tolerance can hide a refit.
    assert.deepEqual(after.rects, before.rects, `${label}: first receipt moves credits or neighbours (0px required)`);
    assert.deepEqual(after.legalLabels, before.legalLabels, `${label}: legal labels remain present`);
    assert.deepEqual(after.legal, before.legal, `${label}: first receipt moves legal neighbours`);
    assert.equal(after.fit, before.fit, `${label}: first receipt must not refit`);
    assert.equal(before.numeric, 'tabular-nums'); assert.equal(before.align, 'end');
    assert.equal(before.reserved, new Intl.NumberFormat(locale).format(10_000));
    if (width === 320) assert.equal(before.gap, '0px', '320px exercises gap:0');
    t.diagnostic(`AIT-357 ${label}: credits and all footer neighbours move exactly 0px`);
  }
  // Above the envelope, the slot must grow naturally so the existing footer
  // fitter can respond; fixed width, clipping and ellipsis are not substitutes.
  const prior = await measure(page);
  await shadow(page, c => {
    window.ait357 = { limitMicro: 10_000_000_000 };
    c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
  });
  await until(page, () => window.ait357.requested);
  await page.evaluate(() => window.ait357.release());
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent === '1,000,000');
  await settle(page);
  const beyondMaximum = await measure(page);
  assert.ok(beyondMaximum.rects['.host-credits__amount'].width > prior.rects['.host-credits__amount'].width, 'beyond maximum grows naturally');
  assert.equal(beyondMaximum.reserved, '1,000,000');
  const { measureFooterGeometry, assertFits } = await import('./footer-geometry.js');
  assertFits(await shadow(page, measureFooterGeometry), 'above maximum keeps the existing compact/refit rules');
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait357-checks.json'), JSON.stringify({ head, checks, beyondMaximum, shots }, null, 2));
}
