// Explicit remote evidence check; kept outside the recurring browser shards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from '../browser/shared-browser.js';
import { shadow, until, evidenceCommit } from '../browser/start2-display-helpers.js';
import { manifest } from '../../plugins/elevenlabs/src/manifest.js';

const settle = page => shadow(page, async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const positive = (box, label) => assert.ok(box.width > 0 && box.height > 0, `${label}: positive box`);
const stable = (a, b, label) => {
  positive(a, label); positive(b, label);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `${label}.${key}: ${a[key]} -> ${b[key]}`);
};

test('AIT-515 r13: both overview heading toggles, stable actions and scroll reachability', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-overview-toggles-'));
  const fixture = await startChild(new URL('./understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [], errors = [];
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(join(evidence, 'overview'), { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    if (evidence) await writeFile(join(evidence, 'overview-toggles.json'), JSON.stringify({ head: evidenceCommit, records, errors }, null, 2));
    await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true });
  });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    const NativeDate = Date, now = 1_800_000_000_000;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  const measure = () => shadow(page, c => {
    const root = c.shadowRoot, box = selector => root.querySelector(selector).getBoundingClientRect().toJSON();
    return { summary: box('.summary-toggle'), signals: box('.signals-toggle'), summaryHeading: box('#summary-title'),
      signalsHeading: box('#signals-title'), summaryRow: box('.summary-heading'), signalsRow: box('.signals-heading'),
      pane: box('.analysis-content'), questions: box('.questions-heading'), composer: box('.composer-shell'),
      foot: box('.understanding > .foot'), band: box('.band'),
      summaryExpanded: root.querySelector('.summary-toggle').getAttribute('aria-expanded'),
      signalsExpanded: root.querySelector('.signals-toggle').getAttribute('aria-expanded'),
      count: root.querySelectorAll('.signals li').length, fade: getComputedStyle(root.querySelector('.summary-text')).maskImage };
  });
  const reach = async selector => {
    await shadow(page, (c, selector) => {
      const root = c.shadowRoot, target = root.querySelector(selector);
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (innerWidth <= 600) {
        const box = target.getBoundingClientRect(), dock = root.querySelector('.composer-shell').getBoundingClientRect();
        if (box.bottom > dock.top - 12) window.scrollBy({ top: box.bottom - dock.top + 12, behavior: 'instant' });
      }
    }, selector);
    await settle(page);
    const result = await shadow(page, (c, selector) => {
      const root = c.shadowRoot, target = root.querySelector(selector), rect = target.getBoundingClientRect();
      const pane = root.querySelector('.analysis-content').getBoundingClientRect();
      const dock = root.querySelector('.composer-shell').getBoundingClientRect();
      const hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { selector, rect: rect.toJSON(), pane: pane.toJSON(), dock: dock.toJSON(), hit: hit === target || target.contains(hit),
        inset: parseFloat(getComputedStyle(root.querySelector('.workspace')).getPropertyValue('--composer-height')) || 0 };
    }, selector);
    positive(result.rect, selector); positive(result.pane, 'pane'); positive(result.dock, 'composer');
    assert.equal(result.hit, true, `${selector}: centre hit-test`);
    assert.ok(result.rect.top >= Math.max(0, result.pane.top) - .5 && result.rect.bottom <= Math.min(page.viewport().height, result.pane.bottom) + .5, `${selector}: fully reachable in the reading pane`);
    if (page.viewport().width <= 600) assert.ok(result.rect.bottom <= result.dock.top, `${selector}: above the composer`);
    return result;
  };
  for (const entrance of ['separate', 'combined']) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark'])
    for (const [width, height] of [[390, 1000], [1024, 640], [1440, 900], [390, 620], [390, 568]]) {
      await page.setViewport({ width, height }); await page.mouse.move(-10, -10);
      await shadow(page, async (c, locale, theme, entrance, manifest) => {
        const { createSession, inputRevision, reduceUnderstanding } = await import('/packages/core/src/index.js');
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = createSession({ demo: true, locale });
        session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
        session.transcript = [{ id: 'host:opener', role: 'assistant', origin: 'host', content: locale === 'de' ? 'Willkommen.' : 'Welcome.' },
          { id: 'visitor', role: 'user', content: locale === 'de' ? 'Wir bearbeiten Aufträge.' : 'We process orders.' },
          { id: 'reply', role: 'assistant', content: locale === 'de' ? 'Welcher Ablauf folgt?' : 'Which workflow comes next?' }];
        session.transcript.at(-1).inputRevision = inputRevision(session);
        const summary = (locale === 'de' ? 'Sie planen einen übersichtlichen Ablauf für die Buchung und Freigabe. ' : 'You plan a clear workflow for booking and approval. ').repeat(20);
        session.understanding = reduceUnderstanding(session.understanding, { summary,
          signals: Array.from({ length: 7 }, (_, i) => ({ text: locale === 'de' ? `Sie nutzen den Ablauf ${i + 1}.` : `You use workflow ${i + 1}.`, basis: i === 0 ? 'assistant' : 'visitor' })),
          constraints: {}, progress: {}, openQuestions: [locale === 'de' ? 'Welcher Ablauf folgt?' : 'Which workflow comes next?'] },
          { transcript: session.transcript, inputRevision: inputRevision(session), locale });
        session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
        window.fetch = async (url, init = {}) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start(controller) {
          init.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } })) : Response.json(c.session);
        c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
        c.configure({ session, copy, ...(entrance === 'combined' ? { entrance } : {}), voiceClient: { manifest } });
      }, locale, theme, entrance, manifest);
      await settle(page);
      const name = `${entrance}-${locale}-${theme}-${width}x${height}`;
      for (const [summaryExpanded, signalsExpanded] of [[false, false], [false, true], [true, true], [true, false], [false, false]]) {
        const desired = { summary: summaryExpanded, signals: signalsExpanded };
        for (const [kind, expanded] of Object.entries(desired)) {
          if ((await measure())[`${kind}Expanded`] === String(expanded)) continue;
          await reach(`.${kind}-toggle`);
          const before = await measure();
          await shadow(page, (c, kind) => c.shadowRoot.querySelector(`.${kind}-toggle`).click(), kind);
          await settle(page);
          const after = await measure();
          stable(before[kind], after[kind], `${name}: ${kind} toggle`);
          for (const target of ['foot', 'band']) stable(before[target], after[target], `${name}: ${target}`);
          positive(before.composer, 'composer before'); positive(after.composer, 'composer after');
          assert.ok(Math.abs(before.composer.bottom - after.composer.bottom) <= .5, 'composer bottom stays fixed');
          records.push({ name, event: `${kind}:${expanded}`, before, after });
        }
        const state = await measure();
        for (const key of ['summary', 'signals', 'summaryHeading', 'signalsHeading', 'summaryRow', 'signalsRow', 'questions']) positive(state[key], `${name}:${key}`);
        assert.equal(state.summaryExpanded, String(summaryExpanded)); assert.equal(state.signalsExpanded, String(signalsExpanded));
        assert.equal(state.count, signalsExpanded ? 7 : 5);
        assert.equal(state.fade === 'none', summaryExpanded);
        for (const kind of ['summary', 'signals']) assert.ok(state[`${kind}Heading`].right <= state[kind].left + .5, `${kind}: heading and action do not overlap`);
        const label = `summary-${summaryExpanded ? 'expanded' : 'collapsed'}-signals-${signalsExpanded ? 'expanded' : 'collapsed'}`;
        const summaryReach = await reach('.summary-toggle');
        if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, 'overview', `${name}-${label}.png`) });
        const signalsReach = await reach('.signals-toggle');
        if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, 'overview', `${name}-${label}-signals-view.png`) });
        records.push({ name, state: label, summaryReach, signalsReach });
      }
    }
  assert.deepEqual(errors, []);
});
