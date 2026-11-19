import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { measureFooterGeometry, assertFits } from './footer-geometry.js';

const settle = page => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const clipAround = (boxes, padding = 2) => {
  const x = Math.floor(Math.min(...boxes.map(b => b.x)) - padding);
  const y = Math.floor(Math.min(...boxes.map(b => b.y)) - padding);
  return { x, y, width: Math.ceil(Math.max(...boxes.map(b => b.x + b.width)) + padding) - x,
    height: Math.ceil(Math.max(...boxes.map(b => b.y + b.height)) + padding) - y };
};
const decode = (page, png) => page.evaluate(async encoded => {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
  return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
}, Buffer.from(png).toString('base64'));
// Two ticks in one image keep the complete before/after packet below ten PNGs.
const paired = async (page, images, path) => {
  const encoded = await page.evaluate(async images => {
    const bitmaps = await Promise.all(images.map(encoded => createImageBitmap(new Blob([
      Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
    ], { type: 'image/png' }))));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(...bitmaps.map(b => b.width));
    canvas.height = bitmaps.reduce((sum, b) => sum + b.height, 0);
    const context = canvas.getContext('2d'); let y = 0;
    for (const bitmap of bitmaps) { context.drawImage(bitmap, 0, y); y += bitmap.height; bitmap.close(); }
    return canvas.toDataURL('image/png').split(',')[1];
  }, images.map(png => Buffer.from(png).toString('base64')));
  await writeFile(path, Buffer.from(encoded, 'base64'));
};

export async function footerDotCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-dot-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(), evidence = process.env.AITHEMA_EVIDENCE_DIR, records = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const ticks = [[9, '0:09'], [10, '0:10'], [71, '1:11'], [599, '9:59'], [600, '10:00'],
    [3599, '59:59'], [3600, '1:00:00'], [40391, '11:13:11'], [359999, '99:59:59']];
  for (const width of [1440, 390]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    await t.test(`${width}/${locale}/${theme}: identical dot pixels and footer boxes across timer ticks`, async () => {
      const page = await browser.newPage(), errors = [];
      try {
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.evaluateOnNewDocument(({ locale, theme }) => {
          localStorage.setItem('aithema-demo-locale', locale); localStorage.setItem('aithema-theme', theme);
          // One injected clock drives the real ConnectionTimer and its interval callbacks.
          // Other delays retain their native scheduling; no elapsed wall time enters assertions.
          const base = Date.now(), intervals = new Map(); let now = base, id = -1;
          Date.now = () => now;
          const nativeInterval = window.setInterval, nativeClear = window.clearInterval;
          window.setInterval = (fn, delay, ...args) => {
            if (delay !== 1000) return nativeInterval(fn, delay, ...args);
            intervals.set(id, () => fn(...args)); return id--;
          };
          window.clearInterval = id => { if (!intervals.delete(id)) nativeClear(id); };
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (url, init) => new URL(url, location.href).pathname.endsWith('/credits')
            ? Promise.resolve(Response.json({ exhausted: false, limitSlot: null, lowAtMicro: 0, lowAtMaxMicro: 2_400_000,
              tiers: { current: 'emailConfirmed', next: null, delta: 0, allowancesMicro: { emailConfirmed: 24_000_000 } },
              balance: { owner: { limitMicro: 24_000_000, availableMicro: 24_000_000, committedMicro: 0, reservedMicro: 0 } } }))
            : nativeFetch(url, init);
          window.footerTick = seconds => { now = base + seconds * 1000; for (const fn of intervals.values()) fn(); };
        }, { locale, theme });
        await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
        await until(page, () => document.querySelector('aithema-session')?.shadowRoot.querySelector('.status__dot')?.dataset.state === 'connected');
        await shadow(page, async (c, locale) => {
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const session = structuredClone(c.session); session.locale = locale;
          session.transcript = [{ id: 'dot-user', role: 'user', content: 'A website.' },
            { id: 'dot-reply', role: 'assistant', content: 'What should it do?' }];
          c.setAttribute('motion', 'off'); c.configure({ session, copy, host: { credits: true } });
        }, locale);
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent);
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status__dot').dataset.state === 'connected');
        await settle(page);
        if (width === 390) {
          await shadow(page, c => c.shadowRoot.querySelector('.ai-notice').click());
          await shadow(page, async c => Promise.all(c.shadowRoot.querySelector('.footer-info').getAnimations({ subtree: true })
            .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished)));
        }
        await page.mouse.move(0, 0); await settle(page);
        const measurements = [], cropShots = [], footerShots = [], pixels = [];
        let dotClip;
        const capture = evidence && (width === 1440 && locale === 'en' && theme === 'light' || width === 390 && locale === 'de' && theme === 'dark');
        for (const [seconds, text] of ticks) {
          await page.evaluate(seconds => window.footerTick(seconds), seconds); await settle(page);
          const frame = await shadow(page, c => {
            const root = c.shadowRoot, box = selector => {
              const n = root.querySelector(selector), b = n.getBoundingClientRect();
              return { x: b.x, y: b.y, width: b.width, height: b.height, visible: n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) };
            };
            const dot = root.querySelector('.status__dot'), timer = root.querySelector('.connection-timer');
            const range = document.createRange(); range.selectNodeContents(timer); const text = range.getBoundingClientRect(), bounds = timer.getBoundingClientRect();
            return { dot: box('.status__dot'), timer: box('.connection-timer'), footer: box('.display-foot'),
              others: ['.footer-info', '.host-credits', '.engine-info', '.status'].map(box), text: timer.textContent,
              label: dot.getAttribute('aria-label'), state: dot.dataset.state,
              statusClip: getComputedStyle(root.querySelector('.status')).clipPath,
              unclipped: text.width > 0 && text.height > 0 && text.left >= bounds.left && text.right <= bounds.right && text.top >= bounds.top && text.bottom <= bounds.bottom };
          });
          dotClip ??= clipAround([frame.dot]);
          const decoded = await decode(page, await page.screenshot({ clip: dotClip, captureBeyondViewport: false }));
          pixels.push(decoded);
          measurements.push({ seconds, ...frame, dotClip, pixelHash: createHash('sha256').update(Buffer.from(decoded)).digest('hex') });
          if (capture && (seconds === 9 || seconds === 10)) {
            cropShots.push(await page.screenshot({ clip: clipAround([frame.dot, frame.timer]), captureBeyondViewport: false }));
            const popup = width === 390 ? await shadow(page, c => {
              const b = c.shadowRoot.querySelector('.footer-info .footer-popup').getBoundingClientRect();
              return { x: b.x, y: b.y, width: b.width, height: b.height };
            }) : frame.footer;
            const clip = clipAround([frame.footer, popup], 0);
            footerShots.push(await page.screenshot({ clip, captureBeyondViewport: false }));
          }
          assert.equal(frame.text, text, 'real timer paints the requested elapsed value');
        }
        const record = { head: evidenceCommit, width, locale, theme, measurements }; records.push(record);
        if (capture) {
          const name = `ait562-${width}-${locale}-${theme}`;
          await paired(page, cropShots, join(evidence, `${name}-crop.png`));
          await paired(page, footerShots, join(evidence, `${name}-footer.png`));
        }
        // Collect all frames and review images even on red, then assert both contracts.
        const failures = [];
        for (const [i, frame] of measurements.entries()) {
          const label = `${width}/${locale}/${theme}/${frame.text}`;
          try {
            for (const box of [frame.dot, frame.timer, frame.footer, ...frame.others]) {
              assert.ok(box.width > 0 && box.height > 0 && box.visible, `${label}: measured box is painted: ${JSON.stringify(box)}`);
            }
            assert.equal(frame.state, 'connected', label); assert.equal(frame.label, measurements[0].label, label);
            assert.ok(frame.unclipped, `${label}: timer text is not clipped`);
            assert.deepEqual(frame.dot, measurements[0].dot, `${label}: dot box stays fixed`);
            assert.deepEqual(frame.others, measurements[0].others, `${label}: adjacent footer boxes stay fixed`);
            assert.deepEqual(frame.footer, measurements[0].footer, `${label}: footer box stays fixed`);
            if (width === 390) {
              assert.equal(frame.statusClip, 'inset(50%)', `${label}: phone status remains intentionally clipped`);
              continue;
            }
            assert.deepEqual(pixels[i], pixels[0], `${label}: decoded dot pixels stay identical`);
            assert.equal(frame.dot.x, Math.round(frame.dot.x), `${label}: dot x is a whole pixel`);
            assert.equal(frame.dot.y, Math.round(frame.dot.y), `${label}: dot y is a whole pixel`);
          } catch (error) { failures.push(error.message); }
        }
        assertFits(await shadow(page, measureFooterGeometry), `${width}/${locale}/${theme}`);
        assert.deepEqual(errors, []); assert.deepEqual(failures, []);
      } finally { await page.close(); }
    });
  }
  if (evidence) await writeFile(join(evidence, 'ait562-dot-pixels.json'), JSON.stringify({ head: evidenceCommit, ticks, records }, null, 2));
}
