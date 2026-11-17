// AIT-547: a pinned host contact must leave a readable collapsed overview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { manifest } from '../../plugins/elevenlabs/src/manifest.js';

const positive = (box, label) => assert.ok(box.width > 0 && box.height > 0, `${label}: positive box`);
const settle = page => shadow(page, async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

test('AIT-547 pinned contact: opaque heading and first signal above the fade, stable status EN/DE', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-overview-fade-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [], errors = [];
  const evidence = process.env.AITHEMA_EVIDENCE_DIR && join(process.env.AITHEMA_EVIDENCE_DIR, 'overview-fade');
  if (evidence) await mkdir(evidence, { recursive: true });
  t.after(async () => {
    if (evidence) await writeFile(join(evidence, 'geometry.json'), JSON.stringify({ head: evidenceCommit, records, errors }, null, 2));
    await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true });
  });
  page.on('pageerror', error => errors.push(error.message));
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
  await page.addStyleTag({ content: await readFile(new URL('../../demo/host.css', import.meta.url), 'utf8') });
  const measure = () => shadow(page, c => {
    const r = c.shadowRoot, box = selector => r.querySelector(selector).getBoundingClientRect().toJSON();
    const pane = r.querySelector('.analysis-content'), status = r.querySelector('.overview-status');
    const range = document.createRange(); range.selectNodeContents(status.querySelector('.notice-text'));
    return { pane: box('.analysis-content'), status: box('.overview-status'), statusText: range.getBoundingClientRect().toJSON(),
      summary: box('.summary'), summaryText: box('.summary-text'), heading: box('.signals-heading'), toggle: box('.signals-toggle'),
      signal: box('.signals li'), contact: c.querySelector('[slot="sidebar-contact"] button').getBoundingClientRect().toJSON(),
      foot: box('.understanding > .foot'), bottomFade: pane.hasAttribute('data-bottom'), mask: getComputedStyle(pane).maskImage,
      scrollTop: pane.scrollTop, lines: r.querySelector('.summary-text').style.getPropertyValue('--summary-lines'),
      summaryExpanded: r.querySelector('.summary-toggle').getAttribute('aria-expanded'), signalsExpanded: r.querySelector('.signals-toggle').getAttribute('aria-expanded') };
  });
  for (const [width, height] of [[1366, 768], [1440, 900], [1024, 600], [390, 844]])
    for (const slots of ['row-only', 'both-slots']) for (const [locale, theme] of [['en', 'light'], ['de', 'dark']])
      for (const entrance of ['separate', 'combined']) {
        await page.setViewport({ width, height }); await page.mouse.move(-10, -10);
        await shadow(page, async (c, locale, theme, slots, entrance, manifest) => {
          const { createSession, inputRevision, reduceUnderstanding } = await import('/packages/core/src/index.js');
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const session = createSession({ demo: true, locale });
          session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
          session.transcript = [{ id: 'user', role: 'user', content: 'We process orders.' }, { id: 'reply', role: 'assistant', content: 'Which workflow follows?' }];
          session.transcript.at(-1).inputRevision = inputRevision(session);
          session.understanding = reduceUnderstanding(session.understanding, {
            summary: (locale === 'de' ? 'Sie planen einen übersichtlichen Ablauf für die Buchung und Freigabe. ' : 'You plan a clear workflow for booking and approval. ').repeat(30),
            signals: Array.from({ length: 7 }, (_, i) => ({ text: locale === 'de' ? `Sie nutzen den Ablauf ${i + 1}.` : `You use workflow ${i + 1}.`, basis: 'visitor' })),
            constraints: {}, progress: {}, openQuestions: [locale === 'de' ? 'Welcher Ablauf folgt?' : 'Which workflow follows?'],
          }, { transcript: session.transcript, inputRevision: inputRevision(session), locale });
          session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
          window.fetch = async (url, init = {}) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start(controller) {
            init.signal?.addEventListener('abort', () => controller.close(), { once: true });
          } })) : Response.json(c.session);
          document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
          c.querySelectorAll('[slot="sidebar-contact"], [slot="contact-launcher"]').forEach(n => n.remove());
          const contact = document.createElement('section'); contact.slot = 'sidebar-contact'; contact.className = 'demo-contact';
          contact.innerHTML = `<p class="demo-contact-note">${locale === 'de' ? 'Kontakt aufnehmen' : 'Get in touch'}</p><button class="demo-contact-open" type="button">${locale === 'de' ? 'Kontakt' : 'Contact'}</button>`;
          c.append(contact);
          if (slots === 'both-slots') {
            const launcher = document.createElement('button'); launcher.slot = 'contact-launcher'; launcher.className = 'demo-contact-launcher'; launcher.textContent = '@'; c.append(launcher);
          }
          c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
          c.configure({ session, copy, ...(entrance === 'combined' ? { entrance } : {}), voiceClient: { manifest } });
        }, locale, theme, slots, entrance, manifest);
        await settle(page);
        await shadow(page, c => { c.shadowRoot.querySelector('.analysis-content').scrollTop = 0; }); await settle(page);
        const name = `${width}x${height}-${slots}-${locale}-${theme}-${entrance}`, initial = await measure();
        records.push({ name, initial });
        if (evidence && width >= 1366) await page.screenshot({ path: join(evidence, `${name}.png`) });
        for (const key of ['pane', 'status', 'statusText', 'summary', 'summaryText', 'heading', 'toggle', 'signal', 'foot']) positive(initial[key], `${name}: ${key}`);
        assert.equal(initial.summaryExpanded, 'false'); assert.equal(initial.signalsExpanded, 'false');
        if (width >= 1366) {
          positive(initial.contact, `${name}: contact`);
          assert.equal(initial.scrollTop, 0, `${name}: initial overview is unscrolled`);
          for (const key of ['heading', 'toggle', 'signal']) assert.ok(initial[key].bottom <= initial.pane.bottom - 44 + .5,
            `${name}: ${key} bottom ${initial[key].bottom} clears fade at ${initial.pane.bottom - 44}`);
          // No blank reservation between the rendered status line and summary.
          if (initial.pane.height < 500) assert.ok(initial.summary.top - initial.statusText.bottom <= 8, `${name}: status band collapses to the rendered line`);
        }
        // All ordinary overview states reserve the same track, including Retry.
        for (const state of ['stale', 'staleIdle', 'draft', 'understandingFailed', 'overviewCurrent']) {
          await shadow(page, async (c, state, locale) => {
            const copy = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale], r = c.shadowRoot;
            r.querySelector('.notice-text').textContent = copy[state];
            const retry = r.querySelector('.overview-retry'); retry.textContent = copy.understandingRetry; retry.hidden = !['staleIdle', 'understandingFailed'].includes(state);
          }, state, locale);
          await settle(page); const after = await measure(); records.push({ name, state, geometry: after });
          for (const key of ['status', 'summary', 'heading', 'toggle', 'signal', 'foot']) {
            positive(after[key], `${name}/${state}: ${key}`);
            for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(initial[key][axis] - after[key][axis]) <= .5, `${name}/${state}: stable ${key}.${axis}`);
          }
          if (width >= 1366) assert.ok(after.statusText.bottom <= after.status.bottom + .5, `${name}/${state}: complete status text`);
        }
        // A heading passing through the bottom band must never be faded.
        await shadow(page, c => {
          const r = c.shadowRoot, pane = r.querySelector('.analysis-content'), heading = r.querySelector('.signals-heading');
          r.querySelector('.summary-toggle').click();
          pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().bottom + 22;
          pane.dispatchEvent(new Event('scroll'));
        });
        await settle(page); const crossing = await measure(); records.push({ name, crossing });
        positive(crossing.heading, `${name}: crossing heading`); positive(crossing.pane, `${name}: crossing pane`);
        if (crossing.heading.top < crossing.pane.bottom && crossing.toggle.bottom > crossing.pane.bottom - 44)
          assert.equal(crossing.bottomFade, false, `${name}: bottom fade cannot cover the heading row`);
      }
  assert.deepEqual(errors, []);
});
