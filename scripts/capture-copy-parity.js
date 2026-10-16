// Manual AIT-228 viewport evidence. Run only through remote-browser.sh, never on mbp2607.
// Reuses one Chrome/page; no required-suite browser workload is added.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from '../test/browser/shared-browser.js';
import { startChild } from '../test/helpers.js';
import { shadow, until, finishWorkspaceEntry, evidenceCommit } from '../test/browser/start2-display-helpers.js';

test('AIT-228 manual copy evidence: round 2 plural upper bound at 390 DE light and 1440 EN dark', { timeout: 180_000 }, async t => {
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  assert.ok(evidence, 'EVIDENCE_OUT must name the head evidence directory');
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'aithema-copy-evidence-'));
  const demo = await startChild(new URL('../test/fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.copySeed = structuredClone(c.session); });
  const rows = [];
  const shot = async (label, state) => {
    await page.mouse.move(-1, -1);
    const metrics = await page.evaluate(async () => {
      const c = document.querySelector('aithema-session');
      c?.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = [...document.getAnimations(), ...(c?.shadowRoot.getAnimations({ subtree: true }) ?? [])];
      await Promise.all(animations.filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      return { blurred: !c?.shadowRoot.activeElement && document.activeElement === document.body,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(metrics.blurred, true); assert.equal(metrics.reducedMotion, true); assert.equal(metrics.overflow, false);
    const file = `${label}-${state}.png`;
    await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    rows.push({ label, state, file, ...metrics });
  };
  for (const { locale, theme, width } of [
    { locale: 'de', theme: 'light', width: 390 },
    { locale: 'en', theme: 'dark', width: 1440 },
  ]) {
    const label = `${width}-${theme}-${locale}`, micro = 1_000_000;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.select('#theme', theme);
    await shadow(page, async (c, { locale, micro }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { inputRevision } = await import('/packages/core/src/session.js');
      const s = structuredClone(window.copySeed); s.locale = locale;
      s.paused = false; s.pauseReason = null; s.settings = { ...s.settings, origin: 'chosen' };
      s.transcript = [{ id: 'copy-person', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' },
        { id: 'copy-answer', role: 'assistant', content: locale === 'de' ? 'Wie sollen Kunden bestellen?' : 'How should customers order?' }];
      s.transcript[1].inputRevision = inputRevision(s);
      s.understanding = { ...s.understanding, inputRevision: inputRevision(s), summary: s.transcript[0].content, readinessAssessed: true };
      s.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'html', 'images'].map(k => [k, { available: true, reason: null }])) };
      s.conceptCost = { maxMicro: micro }; s.conceptVisualKind = 'html'; s.concepts = []; s.conceptStatus = { phase: 'idle' };
      c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ copy, session: s });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
      const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      window.scrollTo(0, 0);
    }, { locale, micro });
    await finishWorkspaceEntry(page);
    await shot(label, 'plural');
    await shadow(page, c => {
      c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' });
      window.scrollBy(0, -c.shadowRoot.querySelector('.band').getBoundingClientRect().bottom - 12);
    });
    const geometry = await shadow(page, c => {
      const request = c.shadowRoot.querySelector('.concept-request'), text = request.firstChild;
      const phrase = request.textContent.split('· ')[1];
      const range = document.createRange(); range.setStart(text, request.textContent.indexOf(phrase)); range.setEnd(text, text.length);
      const rects = [...range.getClientRects()].filter(r => r.width > 0);
      const button = request.getBoundingClientRect(), band = c.shadowRoot.querySelector('.band').getBoundingClientRect();
      return { text: request.textContent, phraseLines: new Set(rects.map(r => r.top)).size,
        visible: button.top >= band.bottom && button.bottom < innerHeight,
        contained: rects.every(r => r.left >= button.left && r.right <= button.right),
        buttonHeight: button.height, lineHeight: getComputedStyle(request).lineHeight };
    });
    assert.equal(geometry.text, locale === 'de' ? 'Entwurf anfordern\u00a0· bis\u00a0zu\u00a0100\u00a0Credits' : 'Request a draft\u00a0· up\u00a0to\u00a0100\u00a0credits');
    assert.equal(geometry.phraseLines, 1, 'the complete cost phrase never splits');
    assert.equal(geometry.visible, true); assert.equal(geometry.contained, true);
    await shot(label, 'plural-overview');
    rows.at(-1).request = geometry;
  }
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ head: evidenceCommit, viewportOnly: true, baselineFontsPinned: true, combinations: 2, rows }, null, 2));
  t.diagnostic(`${rows.length} settled, blurred viewport captures; 100-credit cost phrases stay together`);
});
