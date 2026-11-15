import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';
import { manifest } from '../../plugins/elevenlabs/src/manifest.js';

test('AIT-514 height-aware clamp keeps heading and first signal visible with whole lines', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-summary-height-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), rows = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date, now = 1_000_000;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  const settle = () => shadow(page, async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const measure = () => shadow(page, c => {
    const root = c.shadowRoot, text = root.querySelector('.summary-text');
    const box = selector => root.querySelector(selector).getBoundingClientRect().toJSON();
    return { pane: box('.analysis-content'), heading: box('#summary-title'), text: box('.summary-text'),
      signal: box('.signals li'), button: box('.summary-toggle'),
      line: parseFloat(getComputedStyle(text).lineHeight), expanded: root.querySelector('.summary-toggle').getAttribute('aria-expanded'),
      scrollTop: root.querySelector('.analysis-content').scrollTop };
  });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width: 1440, height: 900 });
    await page.mouse.move(-10, -10);
    await shadow(page, async (c, locale, theme, manifest) => {
      const { createSession, inputRevision } = await import('/packages/core/src/session.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
      session.transcript = [{ id: 'person', role: 'user', content: 'A booking workflow.' },
        { id: 'reply', role: 'assistant', content: locale === 'de' ? 'Ein klarer Ablauf.' : 'A clear workflow.', inputRevision: inputRevision(session) }];
      Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
        summary: Array(20).fill(locale === 'de' ? 'Ein klarer Ablauf.' : 'A clear workflow.').join('\n'),
        signals: [locale === 'de' ? 'Ein klarer Ablauf' : 'A clear workflow'], openQuestions: [] });
      session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
      window.fetch = async (url, init = {}) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } })) : Response.json(session);
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ session, copy, voiceClient: { manifest } });
      c.shadowRoot.querySelector('.summary-text').style.whiteSpace = 'pre-line';
    }, locale, theme, manifest);
    for (const [width, height] of [[1440, 900], [1024, 640], [1440, 900]]) {
      await page.setViewport({ width, height }); await settle();
      const row = { locale, theme, width, height, ...await measure() }; rows.push(row);
      for (const name of ['pane', 'heading', 'text', 'signal', 'button']) {
        assert.ok(row[name].width > 0 && row[name].height > 0, `${locale}/${theme}/${width}: positive ${name}`);
      }
      // Record the actual three-line floor too, so an impossible pane budget is
      // distinguishable from a wrong line-count calculation without weakening it.
      if (width === 1024) {
        await shadow(page, c => c.shadowRoot.querySelector('.summary-text').style.maxHeight = '3lh');
        row.threeLineFloor = await measure();
        await shadow(page, c => c.shadowRoot.querySelector('.summary-text').style.maxHeight = '');
        await settle();
      }
    }
  }
  if (evidence) await writeFile(join(evidence, 'ait-514-height-budget.json'), JSON.stringify({ head: evidenceCommit, rows }, null, 2));
  for (const row of rows) {
    const label = `${row.locale}/${row.theme}/${row.width}×${row.height}`;
    const lines = row.text.height / row.line;
    assert.ok(Math.abs(lines - Math.round(lines)) < .03, `${label}: whole rendered lines`);
    assert.ok(lines >= 3 - .03 && lines <= 9 + .03, `${label}: three-to-nine rendered lines`);
    if (row.width === 1440) assert.ok(Math.abs(lines - 9) < .03, `${label}: tall pane uses nine lines`);
    assert.equal(row.expanded, 'false');
    assert.equal(row.scrollTop, 0, `${label}: entry remains unscrolled`);
    assert.ok(row.heading.top >= row.pane.top && row.heading.bottom <= row.pane.bottom, `${label}: heading fully inside pane`);
    assert.ok(row.signal.top >= row.pane.top && row.signal.bottom <= row.pane.bottom, `${label}: first signal fully inside pane: ${JSON.stringify(row)}`);
  }
});
