// AIT-547: a pinned host contact must leave a readable collapsed overview.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { manifest } from '../../plugins/elevenlabs/src/manifest.js';

const positive = (box, label) => assert.ok(box.width > 0 && box.height > 0, `${label}: positive box`);
const settle = page => shadow(page, async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

// Independent geometry oracle for AIT-290: natural real copy/action variants,
// measured without reading the production reservation or its CSS variable.
export async function compactStatusMaximum(page) {
  return shadow(page, async c => {
    const r = c.shadowRoot, slot = r.querySelector('.overview-status');
    const pane = r.querySelector('.analysis-stack').getBoundingClientRect(), bounds = slot.getBoundingClientRect();
    if (!(pane.width > 0 && pane.height > 0 && bounds.width > 0 && bounds.height > 0)) throw new Error('positive status oracle pane and slot');
    const compact = r.querySelector('.workspace').hasAttribute('data-contact') &&
      innerWidth >= 60 * parseFloat(getComputedStyle(document.documentElement).fontSize) && pane.height <= 500;
    if (!compact) return null;
    const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
    const { overviewStatusCandidates } = await import('/packages/ui/src/overview-status-copy.js');
    const variants = overviewStatusCandidates(copy, c.session.locale);
    const probe = slot.cloneNode(false), width = bounds.width;
    Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', width: `${width}px`,
      height: 'auto', minHeight: '0', overflow: 'visible', visibility: 'hidden', margin: '0' });
    probe.removeAttribute('role'); probe.setAttribute('aria-hidden', 'true'); probe.inert = true; slot.after(probe);
    let maximum = 0;
    try {
      for (const state of variants) {
        const text = document.createElement('span'); text.className = 'notice-text'; probe.replaceChildren(text);
        if (state.consent) {
          text.dataset.consentFeature = 'analysis';
          const label = document.createElement('span'); label.className = 'consent-line-copy'; label.textContent = copy.featureConsent.analysis;
          const action = document.createElement('button'); action.className = 'consent-action'; action.textContent = copy.featureConsent.action;
          text.append(label, action);
        } else text.textContent = state.text;
        if (state.retry) {
          const retry = document.createElement('button'); retry.className = 'overview-retry'; retry.textContent = copy.understandingRetry; probe.append(retry);
        }
        for (const n of probe.querySelectorAll('.notice-text, .consent-line-copy')) {
          n.style.webkitLineClamp = 'none'; n.style.overflow = 'visible';
          if (!n.hasAttribute('data-consent-feature')) n.style.display = 'block';
        }
        const b = probe.getBoundingClientRect();
        if (!(b.width > 0 && b.height > 0)) throw new Error('positive natural status probe');
        maximum = Math.max(maximum, b.height);
      }
    } finally { probe.remove(); }
    return maximum;
  });
}

export async function overviewFadeCheck(t) {
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
  const measure = async () => {
    const result = await shadow(page, c => {
    const r = c.shadowRoot, box = selector => r.querySelector(selector).getBoundingClientRect().toJSON();
    const pane = r.querySelector('.analysis-content'), status = r.querySelector('.overview-status');
    const contact = r.querySelector('.sidebar-contact').checkVisibility({ checkVisibilityCSS: true })
      ? c.querySelector('[slot="sidebar-contact"] button') : c.querySelector('[slot="contact-launcher"]');
    const retry = r.querySelector('.overview-retry');
    const range = document.createRange(); range.selectNodeContents(status.querySelector('.notice-text'));
    return { pane: box('.analysis-content'), status: box('.overview-status'), statusText: range.getBoundingClientRect().toJSON(),
      summary: box('.summary'), summaryText: box('.summary-text'), heading: box('.signals-heading'), toggle: box('.signals-toggle'),
      signal: box('.signals li'), contact: contact.getBoundingClientRect().toJSON(), retry: retry.hidden ? null : retry.getBoundingClientRect().toJSON(),
      foot: box('.understanding > .foot'), topFade: pane.hasAttribute('data-top'), bottomFade: pane.hasAttribute('data-bottom'), mask: getComputedStyle(pane).maskImage,
      scrollTop: pane.scrollTop, lines: r.querySelector('.summary-text').style.getPropertyValue('--summary-lines'),
      summaryExpanded: r.querySelector('.summary-toggle').getAttribute('aria-expanded'), signalsExpanded: r.querySelector('.signals-toggle').getAttribute('aria-expanded') };
    });
    for (const [key, value] of Object.entries(result)) if (value && typeof value === 'object' && 'width' in value) positive(value, key);
    return result;
  };
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
        if (evidence && width >= 1366) {
          await page.screenshot({ path: join(evidence, `${name}.png`) });
          await page.screenshot({ path: join(evidence, `${name}-status-band.png`), clip: {
            x: initial.status.x, y: initial.status.y, width: initial.status.width,
            height: initial.summary.top + 44 - initial.status.y,
          } });
        }
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
            const retry = r.querySelector('.overview-retry'); r.querySelector('.overview-status').append(retry); retry.textContent = copy.understandingRetry; retry.hidden = !['staleIdle', 'understandingFailed'].includes(state);
          }, state, locale);
          await settle(page); const after = await measure(); records.push({ name, state, geometry: after });
          for (const key of ['status', 'summary', 'heading', 'toggle', 'signal', 'foot']) {
            positive(after[key], `${name}/${state}: ${key}`);
            for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(initial[key][axis] - after[key][axis]) <= .5, `${name}/${state}: stable ${key}.${axis}`);
          }
          if (width >= 1366) {
            assert.ok(after.statusText.bottom <= after.status.bottom + .5, `${name}/${state}: complete status text`);
            if (after.retry) assert.ok(after.retry.bottom <= after.status.bottom + .5, `${name}/${state}: complete Retry action`);
          }
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
        assert.ok(crossing.heading.top < crossing.pane.bottom && crossing.toggle.bottom > crossing.pane.bottom - 44,
          `${name}: heading crosses the bottom band`);
        assert.equal(crossing.bottomFade, false, `${name}: bottom fade cannot cover the heading row`);
        await shadow(page, c => {
          const r = c.shadowRoot, pane = r.querySelector('.analysis-content'), heading = r.querySelector('.signals-heading');
          pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - 13;
          pane.dispatchEvent(new Event('scroll'));
        });
        await settle(page); const topCrossing = await measure(); records.push({ name, topCrossing });
        positive(topCrossing.heading, `${name}: top crossing heading`); positive(topCrossing.pane, `${name}: top crossing pane`);
        assert.ok(topCrossing.scrollTop > 4 && topCrossing.heading.top < topCrossing.pane.top + 26 && topCrossing.heading.bottom > topCrossing.pane.top,
          `${name}: heading crosses the top band`);
        assert.equal(topCrossing.topFade, false, `${name}: top fade cannot cover the heading row`);
      }
  assert.deepEqual(errors, []);
}

// Exercise the real status renderer: changing only textContent misses consent,
// failure and availability states, including the width reserved for their actions.
export async function compactStatusCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-compact-status-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [], failures = [];
  const evidence = process.env.AITHEMA_EVIDENCE_DIR && join(process.env.AITHEMA_EVIDENCE_DIR, 'compact-status');
  if (evidence) await mkdir(evidence, { recursive: true });
  t.after(async () => {
    if (evidence) await writeFile(join(evidence, 'states.json'), JSON.stringify({ head: evidenceCommit, records, failures }, null, 2));
    await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true });
  });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  await page.addStyleTag({ content: await readFile(new URL('../../demo/host.css', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    window.compactControlBoxes = c => {
      const r = c.shadowRoot;
      const nodes = [...r.querySelectorAll('.summary-heading h3, .signals-heading h3, .signals-toggle, .summary-toggle, .overview-retry, .consent-action')]
        .filter(n => n.checkVisibility({ checkVisibilityCSS: true }));
      nodes.push(...c.querySelectorAll('[slot="sidebar-contact"] button, [slot="contact-launcher"]'));
      return Object.fromEntries(nodes.filter(n => n.checkVisibility({ checkVisibilityCSS: true })).map(n =>
        [n.matches('h3') ? n.id : n.className || n.slot, n.getBoundingClientRect().toJSON()]));
    };
  });
  const assertControls = (after, before, label) => {
    for (const [key, box] of Object.entries(after)) {
      positive(box, `${label}/${key}`);
      if (before[key]) for (const axis of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(box[axis] - before[key][axis]) <= .5, `${label}/${key}.${axis} moves 0px`);
    }
  };
  for (const [width, height, font] of [[1024, 600], [1024, 768], [1280, 800], [1366, 768], [1440, 900], [1024, 768, 'Verdana'], [1280, 800, 'Verdana']])
    for (const slots of ['row-only', 'both-slots']) for (const [locale, theme] of [['en', 'light'], ['de', 'dark']]) {
      await page.setViewport({ width, height }); await page.mouse.move(-10, -10);
      let baseline; const group = [];
      for (const state of ['current', 'updating', 'idle', 'draft', 'preparing', 'failed', 'both-failed', 'reasoning-failed', 'reply-pending', 'no-details', 'unavailable', 'consent', 'paused', 'reconciling', 'empty']) {
        await shadow(page, async (c, locale, theme, slots, state, manifest, font) => {
          const { createSession, inputRevision, applyEvent } = await import('/packages/core/src/session.js');
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const session = createSession({ demo: true, locale });
          session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
          session.transcript = [{ id: 'u', role: 'user', content: 'We reconcile invoices.' }, { id: 'a', role: 'assistant', content: 'Which workflow follows?' }];
          session.transcript[1].inputRevision = inputRevision(session);
          const u = session.understanding;
          Object.assign(u, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
            summary: (locale === 'de' ? 'Sie planen einen übersichtlichen Ablauf für die Buchung und Freigabe. ' : 'You plan a clear workflow for booking and approval. ').repeat(30),
            signals: Array.from({ length: 7 }, (_, i) => locale === 'de' ? `Sie nutzen den Ablauf ${i + 1}.` : `You use workflow ${i + 1}.`) });
          const ops = session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
          const fail = lanes => { ops.failures = lanes.map(lane => ({ lane, error: 'reasoning-unavailable', retryable: true })); ops.lastFailure = ops.failures.at(-1); };
          if (['updating', 'idle', 'reconciling'].includes(state)) u.inputRevision = 'older';
          if (state === 'updating') ops.running = ['understanding'];
          if (state === 'draft') { u.draft = true; ops.running = ['understanding']; }
          if (state === 'preparing') { u.readinessAssessed = false; ops.running = ['understanding']; }
          if (state === 'failed') fail(['understanding']);
          if (state === 'both-failed') fail(['reaction', 'understanding']);
          if (state === 'reasoning-failed') fail(['other']);
          if (state === 'reply-pending') { u.readinessAssessed = false; session.transcript.pop(); fail(['reaction']); }
          if (state === 'no-details') u.readinessAssessed = false;
          if (state === 'unavailable') { u.readinessAssessed = false; session.featureMatrix.best.analysis = { available: false, reason: 'admission deadline' }; }
          if (state === 'consent') session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
          if (state === 'paused') session.paused = true;
          if (state === 'reconciling') session.featureMatrix.best.analysis = { available: false, reason: 'budget reconciling' };
          if (state === 'empty') Object.assign(session, applyEvent(session, { seq: session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'u', reason: 'withdrawal' } }));
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
          c.style.setProperty('--aithema-font', font || 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ session, copy, voiceClient: { manifest } });
        }, locale, theme, slots, state, manifest, font);
        await settle(page);
        await shadow(page, c => { c.shadowRoot.querySelector('.analysis-content').scrollTop = 0; }); await settle(page);
        const geometry = await shadow(page, c => {
          const r = c.shadowRoot, slot = r.querySelector('.overview-status'), text = slot.querySelector('.notice-text');
          const pane = r.querySelector('.analysis-stack').getBoundingClientRect(), box = slot.getBoundingClientRect();
          // Measure a clone without the line clamp: Chromium can report the
          // clamped box as scrollHeight, and text-overflow does not expose a
          // -webkit-line-clamp ellipsis.
          const probe = slot.cloneNode(true);
          probe.removeAttribute('role'); probe.setAttribute('aria-hidden', 'true'); probe.inert = true;
          Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', width: `${box.width}px`, height: 'auto', minHeight: '0', overflow: 'visible', visibility: 'hidden' });
          for (const n of probe.querySelectorAll('.notice-text, .consent-line-copy')) {
            n.style.webkitLineClamp = 'none'; n.style.overflow = 'visible';
            if (!n.hasAttribute('data-consent-feature')) n.style.display = 'block';
          }
          slot.after(probe);
          const naturalTexts = [...probe.querySelectorAll('.notice-text, .consent-line-copy')].map(n => n.getBoundingClientRect().toJSON());
          const naturalSlot = probe.getBoundingClientRect().toJSON();
          probe.remove();
          const measureText = n => { const b = n.getBoundingClientRect(), style = getComputedStyle(n); return { box: b.toJSON(),
            scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth,
            font: style.fontFamily, clamp: style.webkitLineClamp, ellipsis: style.textOverflow === 'ellipsis', lineHeight: parseFloat(style.lineHeight) }; };
          return { slot: box.toJSON(), pane: pane.toJSON(), text: text.textContent, controls: window.compactControlBoxes(c),
            compact: r.querySelector('.workspace').hasAttribute('data-contact') && innerWidth >= 60 * parseFloat(getComputedStyle(document.documentElement).fontSize) && pane.height <= 500,
            normalHeight: parseFloat(getComputedStyle(slot).fontSize) * 4.35,
            naturalSlot, naturalTexts, textBoxes: [text, ...text.querySelectorAll('.consent-line-copy')].map(measureText),
            actions: [...slot.querySelectorAll('button:not([hidden])')].map(n => ({ text: n.textContent, ...n.getBoundingClientRect().toJSON() })) };
        });
        const name = `${width}x${height}-${slots}-${locale}-${theme}-${font || 'default'}-${state}`;
        records.push({ name, state, ...geometry }); group.push({ name, geometry });
        positive(geometry.slot, `${name}: slot`); positive(geometry.pane, `${name}: pane`);
        baseline ??= geometry.slot;
        const problems = [];
        positive(geometry.naturalSlot, `${name}: natural slot`);
        if (!geometry.compact && Math.abs(geometry.slot.height - geometry.normalHeight) > .5) problems.push('incorrect exact slot height');
        for (const axis of ['x', 'y', 'width', 'height']) if (Math.abs(geometry.slot[axis] - baseline[axis]) > .5) problems.push(`status ${axis} shifted`);
        for (const [i, text] of geometry.textBoxes.entries()) {
          positive(text.box, `${name}: text ${i}`); positive(geometry.naturalTexts[i], `${name}: unclamped text ${i}`);
          if (geometry.compact && (text.box.top < geometry.slot.top - .5 || text.box.bottom > geometry.slot.bottom + .5 || text.box.left < geometry.slot.left - .5 || text.box.right > geometry.slot.right + .5)) problems.push(`text ${i} outside slot`);
          if (geometry.compact && (text.scrollHeight > text.clientHeight || text.scrollWidth > text.clientWidth || text.ellipsis || text.clamp !== 'none' || geometry.naturalTexts[i].height > text.box.height + .5)) problems.push(`text ${i} clipped or ellipsized`);
        }
        if (font) assert.equal(geometry.textBoxes[0].font, font, `${name}: stress font is applied`);
        if (state === 'reasoning-failed') assert.equal(geometry.text, (locale === 'de' ? de : en).reasoningFailed);
        if (['failed', 'idle', 'consent'].includes(state) && !geometry.actions.length) problems.push('missing Retry/consent action');
        for (const action of geometry.actions) {
          positive(action, `${name}: action`);
          if (action.top < geometry.slot.top - .5 || action.bottom > geometry.slot.bottom + .5 || action.left < geometry.slot.left - .5 || action.right > geometry.slot.right + .5) problems.push('action outside slot');
        }
        if (problems.length) failures.push({ name, problems, geometry });
        if (state === 'current' && geometry.compact) {
          const transitions = await shadow(page, async c => {
            const { overviewStatusCandidates } = await import('/packages/ui/src/overview-status-copy.js');
            const { paintConsentLine } = await import('/packages/ui/src/consent-line.js');
            const copy = (await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale];
            const r = c.shadowRoot, slot = r.querySelector('.overview-status'), text = slot.querySelector('.notice-text');
            const retry = r.querySelector('.overview-retry'), results = [];
            for (const variant of [...overviewStatusCandidates(copy, c.session.locale), { state: 'restored', text: copy.overviewCurrent }]) {
              paintConsentLine(text, { copy, feature: 'analysis', separator: '', text: variant.text,
                verdict: { available: !variant.consent, reason: 'current processing consent required' }, open: () => {} });
              retry.textContent = copy.understandingRetry; retry.hidden = !variant.retry;
              if (variant.retry) slot.append(retry); else slot.after(retry);
              const box = text.getBoundingClientRect();
              results.push({ state: variant.state, reason: variant.rawReason, text: text.textContent,
                slot: slot.getBoundingClientRect().toJSON(), textBox: box.toJSON(), scrollHeight: text.scrollHeight, clientHeight: text.clientHeight,
                controls: window.compactControlBoxes(c) });
            }
            return results;
          });
          const seenControls = { ...geometry.controls };
          for (const transition of transitions) {
            const label = `${name}/${transition.state}/${transition.reason ?? ''}`;
            positive(transition.slot, `${label}: slot`); positive(transition.textBox, `${label}: text`);
            for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(transition.slot[axis] - geometry.slot[axis]) <= .5, `${label}: constant slot ${axis}`);
            assert.ok(transition.scrollHeight <= transition.clientHeight, `${label}: complete text`);
            assert.ok(transition.textBox.top >= transition.slot.top - .5 && transition.textBox.bottom <= transition.slot.bottom + .5, `${label}: text inside reserve`);
            assertControls(transition.controls, seenControls, label);
            Object.assign(seenControls, transition.controls);
            for (const [key, box] of Object.entries(transition.controls)) if (key === 'overview-retry' || key === 'consent-action')
              assert.ok(box.top >= transition.slot.top - .5 && box.bottom <= transition.slot.bottom + .5 && box.left >= transition.slot.left - .5 && box.right <= transition.slot.right + .5, `${label}/${key}: action inside reserve`);
          }
          records.push({ name: `${name}-catalog-transitions`, transitions });
          if (evidence) {
            // Preserve the longest reason and idle state in every requested font/layout.
            for (const target of ['longest', 'idle']) {
              const chosen = target === 'longest' ? transitions.filter(value => value.reason).sort((a, b) => b.textBox.height - a.textBox.height || b.text.length - a.text.length)[0]
                : transitions.find(value => value.state === 'idle');
              await shadow(page, async (c, chosen) => {
                const r = c.shadowRoot, slot = r.querySelector('.overview-status'), retry = r.querySelector('.overview-retry');
                r.querySelector('.notice-text').textContent = chosen.text; retry.hidden = chosen.state !== 'idle';
                if (chosen.state === 'idle') slot.append(retry); else slot.after(retry);
              }, chosen);
              await page.screenshot({ path: join(evidence, `${name}-${target}.png`) });
            }
            await shadow(page, (c, current) => {
              const r = c.shadowRoot; r.querySelector('.notice-text').textContent = current; r.querySelector('.overview-retry').hidden = true;
            }, geometry.text);
          }
        }
        // A live state update must reuse the already measured reservation,
        // rather than measuring only the newly displayed message.
        if (state === 'current' && width === 1024 && height === 768 && slots === 'both-slots' && locale === 'de' && !font) {
          await shadow(page, c => {
            window.statusProbeInsertions = 0;
            window.statusProbeObserver = new MutationObserver(changes => {
              for (const change of changes) for (const node of change.addedNodes)
                if (node.nodeType === 1 && node.matches('.overview-status[aria-hidden="true"]')) window.statusProbeInsertions++;
            });
            window.statusProbeObserver.observe(c.shadowRoot, { childList: true, subtree: true });
          });
          for (const next of ['failed', 'updating', 'current']) {
            await shadow(page, (c, next) => {
              const operations = structuredClone(c.session.operations);
              const failure = { lane: 'understanding', error: 'reasoning-unavailable', retryable: true };
              operations.running = next === 'updating' ? ['understanding'] : [];
              operations.failures = next === 'failed' ? [failure] : []; operations.lastFailure = operations.failures[0] ?? null;
              c.receive({ type: 'lane.status', data: operations });
            }, next);
            await settle(page);
            const live = await shadow(page, c => {
              const slot = c.shadowRoot.querySelector('.overview-status'), text = slot.querySelector('.notice-text');
              return { box: slot.getBoundingClientRect().toJSON(), scrollHeight: text.scrollHeight, clientHeight: text.clientHeight, controls: window.compactControlBoxes(c) };
            });
            positive(live.box, `${name}/${next}: live slot`);
            assertControls(live.controls, geometry.controls, `${name}/${next}: live controls`);
            for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(live.box[axis] - geometry.slot[axis]) <= .5, `${name}/${next}: live ${axis} moves 0px`);
            assert.ok(live.scrollHeight <= live.clientHeight, `${name}/${next}: live text is complete`);
            records.push({ name: `${name}-live-${next}`, ...live });
          }
          await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').style.setProperty('--aithema-slack-top', '5px'));
          await settle(page);
          const slack = await shadow(page, c => c.shadowRoot.querySelector('.overview-status').getBoundingClientRect().toJSON());
          positive(slack, `${name}: anchoring slack slot`);
          assert.ok(Math.abs(slack.y - geometry.slot.y - 5) <= .5, `${name}: all 5px of anchoring slack remains effective with a tall status`);
          await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').style.removeProperty('--aithema-slack-top'));
          await settle(page);
          const insertions = await shadow(page, () => { window.statusProbeObserver.disconnect(); return window.statusProbeInsertions; });
          assert.equal(insertions, 0, `${name}: state changes never remeasure the reservation`);
          // Resize and an actual font lifecycle notification do recompute it.
          for (const wider of [true, false]) {
            await page.setViewport(wider ? { width: 1280, height: 800 } : { width, height }); await settle(page);
            const expected = await compactStatusMaximum(page);
            const resized = await shadow(page, c => c.shadowRoot.querySelector('.overview-status').getBoundingClientRect().toJSON());
            positive(resized, `${name}: resized slot`);
            assert.ok(Math.abs(resized.height - expected) <= .5, `${name}: resize uses the exact natural maximum`);
          }
          for (const stress of [true, false]) {
            await shadow(page, (c, stress) => {
              if (stress) { window.statusHostFont = c.style.getPropertyValue('--aithema-font'); c.style.setProperty('--aithema-font', 'Verdana'); }
              else c.style.setProperty('--aithema-font', window.statusHostFont);
              document.fonts.dispatchEvent(new Event('loadingdone'));
            }, stress);
            await settle(page);
            const expected = await compactStatusMaximum(page);
            const loaded = await shadow(page, c => c.shadowRoot.querySelector('.overview-status').getBoundingClientRect().toJSON());
            positive(loaded, `${name}: font-loaded slot`);
            assert.ok(Math.abs(loaded.height - expected) <= .5, `${name}: font load uses the exact natural maximum`);
          }
        }
        // Keep all failing states, plus the requested compact-state TICK packet.
        if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
      }
      const maximum = Math.max(...group.map(({ geometry }) => geometry.naturalSlot.height));
      for (const { name, geometry } of group) if (geometry.compact && Math.abs(geometry.slot.height - maximum) > .5)
        failures.push({ name, problems: ['slot differs from the measured longest real state'], maximum, geometry });
    }
  for (const [width, height] of [[1366, 768], [1440, 900]]) for (const slots of ['row-only', 'both-slots'])
    for (const [locale, theme] of [['en', 'light'], ['de', 'dark']]) {
      await page.setViewport({ width, height });
      await shadow(page, async (c, locale, theme, slots) => {
        const { createSession } = await import('/packages/core/src/session.js');
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = createSession({ demo: true, locale });
        session.identity = { status: 'anonymous', verificationRequired: true, assessmentUnlocked: false };
        c.style.removeProperty('--aithema-font');
        c.querySelector('.demo-contact-note').textContent = locale === 'de' ? 'Kontakt aufnehmen' : 'Get in touch';
        c.querySelector('.demo-contact-open').textContent = locale === 'de' ? 'Kontakt' : 'Contact';
        c.querySelectorAll('[slot="contact-launcher"]').forEach(n => n.remove());
        if (slots === 'both-slots') {
          const launcher = document.createElement('button'); launcher.slot = 'contact-launcher'; launcher.textContent = '@'; c.append(launcher);
        }
        document.documentElement.dataset.theme = theme; c.setAttribute('theme', theme);
        c.configure({ session, copy, host: { verification: true } });
      }, locale, theme, slots);
      await settle(page);
      const lock = await shadow(page, c => {
        const r = c.shadowRoot, pane = r.querySelector('.analysis-content'), stack = r.querySelector('.analysis-stack');
        return { pane: pane.getBoundingClientRect().toJSON(), lock: r.querySelector('.verify-lock').getBoundingClientRect().toJSON(),
          containerType: getComputedStyle(stack).containerType, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight,
          stage: r.querySelector('.workspace').dataset.stage };
      });
      const name = `${width}x${height}-${slots}-${locale}-${theme}-verification-lock`;
      records.push({ name, ...lock });
      if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
      positive(lock.pane, `${name}: pane`); positive(lock.lock, `${name}: lock`);
      assert.notEqual(lock.stage, 'live'); assert.equal(lock.containerType, 'normal', `${name}: auto-height entrance has no size containment`);
      assert.ok(lock.scrollHeight <= lock.clientHeight + 1, `${name}: verification form grows the page without internal scrolling`);
      assert.ok(lock.lock.top >= lock.pane.top - .5 && lock.lock.bottom <= lock.pane.bottom + .5, `${name}: complete verification form inside pane`);
    }
  t.diagnostic(`AIT-547 real status states: ${records.length} scenes, ${failures.length} clipped/unstable states`);
  assert.deepEqual(failures, [], 'every real compact overview status fits the exact measured maximum without clipping; actions stay inside the constant slot');
}
