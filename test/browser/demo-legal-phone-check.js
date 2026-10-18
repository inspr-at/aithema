import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceCommit, shadow, until } from './start2-display-helpers.js';

// These are the complete demo legal rules at base beb35ba2. Compare the live
// desktop against their actual layout in the same browser/font environment.
const baseLegalCSS = `
#demo-legal { display:flex; gap:1rem; }
#demo-legal a { display:inline-flex; align-items:center; min-width:44px; min-height:44px; line-height:1.15; white-space:normal; overflow-wrap:anywhere; color:var(--accent); }
#demo-license > span { min-width:0; }
.demo-license-id { white-space:nowrap; }
@media(max-width:600px) {
  #demo-legal { gap:8px; }
  #demo-license { flex-shrink:0; width:min-content; }
  #demo-legal a { min-height:max(44px,4lh); }
}
@media(width < 360px) { #demo-legal a { min-height:max(44px,5lh); } }
`;
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  for (const root of [document, c.shadowRoot]) for (const animation of root.getAnimations()) {
    if (animation.effect?.getTiming().iterations !== Infinity) await animation.finished.catch(() => {});
  }
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
});
const measure = page => shadow(page, c => {
  const root = c.shadowRoot, links = [...c.querySelectorAll('#demo-legal a')];
  const box = node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  const overlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
  // The legal slot is inside footer-right; compare its sibling zones rather
  // than treating its containing zone as an overlap with itself.
  const zones = ['.footer-info', '.actor-role', '.host-credits', '.preset-panel', '.footer-right > .status'].map(s => root.querySelector(s))
    .filter(n => n.checkVisibility({ visibilityProperty: true, opacityProperty: true })).map(box);
  const row = box(root.querySelector('.display-foot__row')), footer = box(root.querySelector('.display-foot'));
  return {
    fixed: ['.display-foot', '.display-foot__row', '.footer-info', '.host-credits', '.footer-right', '.host-legal', '.engine__flag', '.status__dot'].map(s => box(root.querySelector(s))),
    flag: root.querySelector('.engine__flag').checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    dot: root.querySelector('.status__dot').checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    links: links.map(link => {
      const bounds = box(link), range = document.createRange(), rows = [], textBoxes = [];
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (!node.textContent.trim() || !node.parentElement.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) {
          textBoxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          if (!rows.some(y => Math.abs(r.y - y) < 1)) rows.push(r.y);
        }
      }
      const clipping = [];
      for (let n = link; n; n = n.assignedSlot ?? n.parentElement ?? n.getRootNode().host) {
        const style = getComputedStyle(n), b = box(n);
        if (style.display === 'contents') continue;
        if (style.clipPath !== 'none' || (/hidden|clip|auto|scroll/u.test(style.overflowX) && (bounds.x < b.x || bounds.x + bounds.width > b.x + b.width)) ||
            (/hidden|clip|auto|scroll/u.test(style.overflowY) && (bounds.y < b.y || bounds.y + bounds.height > b.y + b.height))) clipping.push(n.localName);
      }
      const points = [[1, 1], [bounds.width - 1, 1], [1, bounds.height - 1], [bounds.width - 1, bounds.height - 1], [bounds.width / 2, bounds.height / 2]];
      return { text: link.innerText, name: link.getAttribute('aria-label'), title: link.title, bounds, lines: rows.length,
        textInside: textBoxes.length > 0 && textBoxes.every(b => inside(b, bounds)), clipping,
        visible: link.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
        inside: [row, footer, { x: 0, y: 0, width: innerWidth, height: innerHeight }].every(b => inside(bounds, b)),
        overlap: zones.some(b => overlap(bounds, b)) || links.some(other => other !== link && overlap(bounds, box(other))),
        unobscured: points.every(([x, y]) => link.contains(document.elementFromPoint(bounds.x + x, bounds.y + y))) };
    }),
  };
});

export async function demoLegalPhoneCheck(t) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const head = event?.pull_request?.head.sha ?? evidenceCommit;
  const directory = await mkdtemp(join(tmpdir(), 'aithema-demo-legal-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile(), page = await browser.newPage(), errors = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => localStorage.setItem('aithema-demo-locale', 'de'));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.documentElement.hasAttribute('data-host-ready'));
  await shadow(page, c => {
    c.setAttribute('motion', 'off');
    c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
    c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
  });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, pass = [], shots = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (width, theme, locale) => {
    const file = `ait304-${width}-${theme}-${locale}-footer.png`;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle(page);
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    shots.push({ file, viewport: true, reducedMotion: true, blurred: true });
  };
  for (const locale of ['de', 'en']) {
    await page.select('#locale', locale);
    await until(page, locale => document.documentElement.lang === locale && document.querySelector('aithema-session').session.locale === locale, locale);
    const full = locale === 'de' ? ['Lizenz: AGPL-3.0-only', 'Quellcode und Hinweise'] : ['Licence: AGPL-3.0-only', 'Source and notices'];
    for (const width of [390, 320, 360, 599, 600, 601, 700, 1024, 1440]) for (const theme of ['light', 'dark']) {
      await page.setViewport({ width, height: 844 }); await page.select('#theme', theme);
      await page.mouse.move(-1, -1); await settle(page);
      const state = await measure(page), label = `${width}/${theme}/${locale}`;
      if ([320, 360, 390].includes(width) || width === 1440 && theme === 'light' && locale === 'de') await capture(width, theme, locale);
      if (width < 600) for (const [i, link] of state.links.entries()) {
        assert.equal(link.lines, 1, `${label} ${i}: legal link has exactly one line box (got ${link.lines})`);
        assert.equal(link.text, i === 0 ? 'AGPL-3.0' : locale === 'de' ? 'Quellcode' : 'Source', `${label}: short visible wording`);
      }
      for (const [i, link] of state.links.entries()) {
        assert.ok(link.bounds.width >= 44 && link.bounds.height >= 44, `${label}: >=44px target`);
        assert.equal(link.visible && link.inside && link.textInside && link.unobscured && !link.overlap, true, `${label}: legal visible/unclipped/unobscured/no overlap ${JSON.stringify(link)}`);
        assert.deepEqual(link.clipping, [], `${label}: no clipping ancestor`);
        assert.equal(link.name, full[i], `${label}: full accessible name`); assert.equal(link.title, full[i], `${label}: full title`);
        const accessible = await page.$(`::-p-aria([name="${full[i]}"][role="link"])`);
        assert.ok(accessible, `${label}: browser accessibility tree has full link name`); await accessible.dispose();
      }
      assert.equal(state.links.length, 2); assert.equal(state.flag, true, `${label}: module flag visible`); assert.equal(state.dot, true, `${label}: module dot visible`);
      if (width >= 600) {
        const original = await shadow(page, async (c, { baseLegalCSS, full }) => {
          const links = [...c.querySelectorAll('#demo-legal a')], original = links.map(a => a.innerHTML);
          const style = document.createElement('style'); style.id = 'ait304-base-css'; style.textContent = baseLegalCSS; document.head.append(style);
          // The unchanged painter reproduces base beb35ba2's atomic SPDX span.
          const { paintLicenseLabel } = await import('/demo/license-label.js'); paintLicenseLabel(links[0], full[0]); links[1].textContent = full[1];
          return original;
        }, { baseLegalCSS, full });
        await settle(page); const base = await measure(page);
        await shadow(page, (c, original) => {
          document.querySelector('#ait304-base-css').remove(); [...c.querySelectorAll('#demo-legal a')].forEach((a, i) => { a.innerHTML = original[i]; });
        }, original);
        assert.deepEqual(state.fixed, base.fixed, `${label}: footer geometry unchanged from beb35ba2`);
        assert.deepEqual(state.links.map(a => [a.text, a.bounds]), base.links.map(a => [a.text, a.bounds]), `${label}: desktop labels/geometry unchanged from beb35ba2`);
      }
      // Keep the pointer on each actual anchor while hover/focus/theme paints settle.
      for (const [i, link] of state.links.entries()) {
        await page.mouse.move(link.bounds.x + link.bounds.width / 2, link.bounds.y + link.bounds.height / 2);
        await page.focus(i === 0 ? '#demo-license' : '#demo-legal-source');
        await page.select('#theme', theme === 'light' ? 'dark' : 'light'); await settle(page);
        const held = await measure(page);
        assert.deepEqual(held.fixed, state.fixed, `${label}: module footer movement exactly 0px under resting pointer`);
        assert.deepEqual(held.links.map(a => a.bounds), state.links.map(a => a.bounds), `${label}: legal movement exactly 0px under resting pointer`);
        assert.equal(held.links[i].unobscured, true);
        await page.select('#theme', theme); await settle(page);
      }
      const line = `PASS ${label}: legal one line below 600; >=44px; full accessible name/title; visible/unclipped/unobscured; no overlap; flag/dot visible; 0px held movement${width >= 600 ? '; labels/geometry match base beb35ba2' : ''}`;
      pass.push(line); checks.push({ width, theme, locale, ...state }); t.diagnostic(line);
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait304-checks.json'), JSON.stringify({ head, base: 'beb35ba2', fonts: 'Chrome baseline UI/display stacks pinned', pass, checks, shots, errors }, null, 2) + '\n');
}
