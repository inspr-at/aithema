import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, evidenceCommit } from './start2-display-helpers.js';

const widths = [...new Set([...Array.from({ length: 26 }, (_, i) => 600 + i * 20), 699, 700, 701])].sort((a, b) => a - b);
const shotWidths = [600, 680, 700, 701, 1024];
const tolerancePx = .25;
const settle = page => shadow(page, async () => {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

// Measure the original text ranges too: overflow:hidden, ellipsis or a smaller
// fixed box must not turn an overlong translation into a passing measurement.
const geometry = page => shadow(page, c => {
  const root = c.shadowRoot, row = root.querySelector('.display-foot__row');
  const rect = node => {
    const b = node.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  };
  const visible = node => {
    if (!node.getClientRects().length || getComputedStyle(node).visibility !== 'visible') return false;
    for (let parent = node; parent && parent !== root; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return !node.closest('.footer-popup');
  };
  const outside = (inner, outer) => Math.max(0, outer.left - inner.left, inner.right - outer.right,
    outer.top - inner.top, inner.bottom - outer.bottom);
  const container = rect(row), footprints = new Map(), violations = [];
  let maxOverflowPx = 0, maxOverlapPx = 0;
  for (const selector of ['.footer-info', '.host-credits', '.footer-right']) {
    const zone = root.querySelector(selector), bounds = rect(zone), painted = { ...bounds };
    const record = (box, limit, item) => {
      const overflow = Math.max(outside(box, limit), outside(box, container));
      maxOverflowPx = Math.max(maxOverflowPx, overflow);
      if (overflow > 0) violations.push({ item, overflowPx: overflow });
      painted.left = Math.min(painted.left, box.left); painted.right = Math.max(painted.right, box.right);
      painted.top = Math.min(painted.top, box.top); painted.bottom = Math.max(painted.bottom, box.bottom);
    };
    record(bounds, container, selector);
    for (const node of zone.querySelectorAll('*')) if (visible(node)) record(rect(node), bounds, node.className);
    const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
    for (let text; (text = walker.nextNode());) {
      if (!text.textContent.trim() || !visible(text.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const box of range.getClientRects()) record(box, rect(text.parentElement), `${text.parentElement.className}: ${text.textContent}`);
    }
    footprints.set(selector, painted);
  }
  const groups = [
    ['.footer-info', '.host-credits', '.footer-right'],
    ['.ai-notice .speaker-sign', '.display-version', '.ai-notice__label', '.ai-notice__short', '.ai-notice__voice'],
    ['.host-credits__stack', '.host-credits__track'],
    ['.engine', '.status'],
    ['.status__label', '.connection-timer'],
  ];
  for (const selectors of groups) {
    const items = selectors.filter(selector => visible(root.querySelector(selector)))
      .map(selector => ({ selector, box: footprints.get(selector) ?? rect(root.querySelector(selector)) }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const overlap = Math.max(0, Math.min(Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left),
        Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)));
      maxOverlapPx = Math.max(maxOverlapPx, overlap);
      if (overlap > 0) violations.push({ items: [a.selector, b.selector], overlapPx: overlap });
    }
  }
  return { maxOverflowPx, maxOverlapPx, violations,
    compact: getComputedStyle(root.querySelector('.host-credits__total')).display === 'none',
    measureCompact: getComputedStyle(root.querySelector('.host-credits__measure-total')).display === 'none',
    amount: root.querySelector('.host-credits__amount').textContent };
});

const assertFits = (measurement, label) => {
  assert.ok(measurement.maxOverflowPx <= tolerancePx, `${label}: footer overflow ${JSON.stringify(measurement)}`);
  assert.ok(measurement.maxOverlapPx <= tolerancePx, `${label}: footer overlap ${JSON.stringify(measurement)}`);
};

test('AIT-164: footer width sweep 600–1100/20 plus 699/700/701, DE/EN, full/fewer digits; no overflow, overlap or clipping',
  { timeout: 90_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-sweep-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
    });
    let browser;
    t.after(async () => { await browser?.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
    if (evidence) await mkdir(evidence, { recursive: true });
    const passes = [], summaries = [], shots = [];
    for (const locale of ['de', 'en']) {
      browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, locale),
        env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width: 1100, height: 900 });
      await page.evaluateOnNewDocument(locale => {
        localStorage.setItem('aithema-demo-locale', locale);
        window.ait164Footer = { availableMicro: 24_000_000 };
        const original = window.fetch.bind(window);
        window.fetch = async (url, init = {}) => {
          if (new URL(url, location.href).pathname.endsWith('/credits')) {
            const limitMicro = 24_000_000, availableMicro = window.ait164Footer.availableMicro;
            return Response.json({ exhausted: false, limitSlot: null, lowAtMicro: 0, lowAtMaxMicro: 2_400_000,
              tiers: { current: 'emailConfirmed', next: null, delta: 0, allowancesMicro: { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: limitMicro } },
              balance: { owner: { limitMicro, availableMicro, committedMicro: limitMicro - availableMicro, reservedMicro: 0 } } });
          }
          return original(url, init);
        };
      }, locale);
      // One navigation per locale. Both digit states and every width resize the
      // same live component; only the twenty requested viewports are captured.
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      await shadow(page, async (c, { locale, commit }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = structuredClone(c.session); session.locale = locale; session.demo = false;
        session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
        session.transcript = [
          { id: 'footer-user', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' },
          { id: 'footer-reply', role: 'assistant', content: locale === 'de' ? 'Was soll die Website leisten?' : 'What should the website do?' },
        ];
        c.setAttribute('motion', 'off');
        c.configure({ session, copy, host: { credits: true, library: true, version: { version: '0.0.0', commit } } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      }, { locale, commit: evidenceCommit });
      const setBalance = async availableMicro => {
        await shadow(page, (c, availableMicro) => {
          window.ait164Footer.availableMicro = availableMicro;
          c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
        }, availableMicro);
        await until(page, availableMicro => {
          const amount = document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent;
          return amount.replace(/[.,]/gu, '') === String(availableMicro / 10_000);
        }, availableMicro);
      };
      const summary = { head: evidenceCommit, locale, widths, digitStates: ['full', 'fewer'], checks: 0, maxOverflowPx: 0, maxOverlapPx: 0 };
      for (const [digits, availableMicro] of [['full', 24_000_000], ['fewer', 980_000]]) {
        await setBalance(availableMicro);
        for (const width of widths) {
          await page.setViewport({ width, height: 900 }); await settle(page);
          const measurement = await geometry(page), label = `HEAD ${evidenceCommit} ${locale}/${width}/${digits}`;
          assertFits(measurement, label);
          assert.equal(measurement.compact, width < 700, `${label}: compact boundary`);
          assert.equal(measurement.measureCompact, measurement.compact, `${label}: reserved total uses the same boundary`);
          passes.push({ head: evidenceCommit, locale, width, digits, ...measurement, pass: true }); summary.checks++;
          summary.maxOverflowPx = Math.max(summary.maxOverflowPx, measurement.maxOverflowPx);
          summary.maxOverlapPx = Math.max(summary.maxOverlapPx, measurement.maxOverlapPx);
        }
      }
      // Prove the guard still sees an overlong string when its element clips.
      await page.setViewport({ width: 701, height: 900 }); await settle(page);
      const original = await shadow(page, c => {
        const label = c.shadowRoot.querySelector('.ai-notice__label'), original = label.textContent;
        label.style.cssText = `width:${label.getBoundingClientRect().width}px;overflow:hidden;text-overflow:ellipsis;flex:none`;
        label.textContent += ' longer translated footer text'.repeat(12);
        return original;
      });
      const clippedMeasurement = await geometry(page);
      assert.throws(() => assertFits(clippedMeasurement, 'clipped longer string'), /footer overflow/u);
      await shadow(page, (c, original) => {
        const label = c.shadowRoot.querySelector('.ai-notice__label'); label.textContent = original; label.removeAttribute('style');
      }, original);
      await setBalance(24_000_000);
      for (const width of shotWidths) for (const theme of ['light', 'dark']) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await settle(page);
        const measurement = await geometry(page); assertFits(measurement, `HEAD ${evidenceCommit} ${locale}/${width}/${theme}/viewport`);
        const file = `ait164-fix2-footer-${locale}-${theme}-${width}.png`;
        if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
        shots.push({ head: evidenceCommit, locale, width, theme, file, captures: 'viewport', ...measurement, pass: true });
      }
      assert.deepEqual(errors, [], locale); summaries.push(summary);
      t.diagnostic(`AIT-164 HEAD ${evidenceCommit} ${locale}: ${summary.checks} footer sweep checks PASS; max overflow ${summary.maxOverflowPx} px; max overlap ${summary.maxOverlapPx} px; tolerance ${tolerancePx} px; clipped longer string rejected`);
      await browser.close(); browser = null;
    }
    if (evidence) await writeFile(join(evidence, 'ait164-fix2-footer-pass-lines.json'), JSON.stringify({
      head: evidenceCommit, tolerancePx, captures: 'viewport', summaries, passes, shots,
    }, null, 2));
    t.diagnostic(`AIT-164 HEAD ${evidenceCommit}: ${passes.length} geometry sweep checks PASS; ${shots.length} footer viewports PASS`);
  });
