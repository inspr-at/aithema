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

test('AIT-228 manual copy evidence: 12 viewport/theme/locale combinations', { timeout: 180_000 }, async t => {
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
  const rows = [], stable = ['.band', '.conversation', '.understanding', '.display-foot'];
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
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
    const label = `${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.select('#theme', theme);
    let baseline;
    for (const [state, micro] of [['free', 0], ['sub-credit', 1234], ['one-credit', 10000], ['plural', 20000]]) {
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
      const boxes = await shadow(page, (c, selectors) => selectors.map(selector => {
        const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
      }), stable);
      if (baseline) assert.deepEqual(boxes, baseline, `${label}/${state}: zero layout shift`); else baseline = boxes;
      await shot(label, state);
      // Mobile stacks the overview below the conversation: capture each changed surface in its viewport.
      if (width === 390) {
        await shadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
        await shot(label, state + '-overview');
        await shadow(page, c => c.shadowRoot.querySelector('.display-foot').scrollIntoView({ block: 'end' }));
        await shot(label, state + '-footer');
      }
    }
    await shadow(page, c => {
      c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'failed' } } });
      c.shadowRoot.querySelector('.concept-request').scrollIntoView({ block: 'center' });
    });
    await shot(label, 'retry');
    await shadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
    await shot(label, 'regenerate');
    await shadow(page, c => c.shadowRoot.querySelector('.concept-close').click());
    // The real mock consent page with a locale-specific session response; all copy is production copy.
    const session = await shadow(page, c => c.session);
    await page.setRequestInterception(true);
    const intercept = request => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/sessions/${session.id}`) return request.respond({ contentType: 'application/json', body: JSON.stringify(session) });
      return request.continue();
    };
    page.on('request', intercept);
    await page.evaluate(({ locale, theme }) => { localStorage.setItem('aithema-demo-locale', locale); localStorage.setItem('aithema-theme', theme); }, { locale, theme });
    await page.goto(`${demo.url}/consent.html?session=${session.id}`, { waitUntil: 'networkidle0' });
    await until(page, () => document.querySelector('#consent-status')?.dataset.state === 'ready');
    const intro = await page.$eval('#consent-text', n => n.textContent);
    assert.ok(intro.endsWith(locale === 'de' ? 'Nicht ausgewählte Punkte sind nicht freigegeben.' : "Items you don't select are not allowed."));
    await page.addStyleTag({ content: ':root{--ui:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--display:Georgia,"Iowan Old Style","Palatino Linotype",serif}' });
    await shot(label, 'mock-consent');
    page.off('request', intercept); await page.setRequestInterception(false);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await shadow(page, c => { window.copySeed = structuredClone(c.session); });
  }
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ head: evidenceCommit, viewportOnly: true, baselineFontsPinned: true, combinations: 12, rows }, null, 2));
  t.diagnostic(`${rows.length} settled, blurred viewport captures; zero displacement across draft-cost states`);
});
