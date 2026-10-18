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
  for (const width of [320, 390, 1024, 1440]) for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 });
    await shadow(page, async (c, { locale, theme }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(window.ait357Base); session.locale = locale;
      window.ait357 = { limitMicro: 100_000_000 };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy, host: { credits: true, library: true } });
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme; c.setAttribute('theme', theme);
      document.querySelector('#locale').value = locale; document.querySelector('#theme').value = theme;
      const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
    }, { locale, theme });
    await until(page, () => window.ait357.requested);
    await settle(page);
    const before = await measure(page), label = `${width}/${locale}/${theme}`;
    assert.equal(before.value, '…', `${label}: receipt held pending`);
    if (locale === 'de' && theme === 'light' && width < 400) await capture(width, 'before');
    await page.evaluate(() => window.ait357.release());
    await until(page, locale => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent === new Intl.NumberFormat(locale).format(10_000), locale);
    await settle(page);
    const after = await measure(page);
    if (locale === 'de' && theme === 'light' && width < 400) await capture(width, 'after');
    checks.push({ width, locale, theme, before, after });
    // Exact rectangles, including width/height: no tolerance can hide a refit.
    assert.deepEqual(after.rects, before.rects, `${label}: first receipt moves credits or neighbours (0px required)`);
    assert.deepEqual(after.legal, before.legal, `${label}: first receipt moves legal neighbours`);
    assert.equal(after.fit, before.fit, `${label}: first receipt must not refit`);
    assert.equal(before.numeric, 'tabular-nums'); assert.equal(before.align, 'end');
    assert.equal(before.reserved, new Intl.NumberFormat(locale).format(10_000));
    if (width === 320) assert.equal(before.gap, '0px', '320px exercises gap:0');
    t.diagnostic(`AIT-357 ${label}: credits and all footer neighbours move exactly 0px`);
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait357-checks.json'), JSON.stringify({ head, checks, shots }, null, 2));
}
