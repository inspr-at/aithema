// AIT-131 evidence: the real reference page and component, with deterministic display snapshots and local voice.
// No provider calls, microphone, wallet writes or voice lifecycle work. Run only on the remote browser runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';

async function browserPath() {
  const paths = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name)))];
  for (const path of paths) { try { await access(path, constants.X_OK); return path; } catch { /* remote runner */ } }
  throw new Error('No browser available on the remote test runner');
}
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: 30_000 }, arg);
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
const sameBoxes = (before, after, context) => before.forEach((box, i) => box.forEach((value, n) =>
  assert.ok(Math.abs(value - after[i][n]) <= .5, `${context}: ${i}/${n} shifted ${value} → ${after[i][n]}`)));

const content = {
  de: {
    first: 'Soll die Website eine geschätzte Lieferzeit anzeigen, die sich nach dem Backlog richtet? Bitte mit Ja oder Nein antworten.',
    answer: 'Ja.', reply: 'Danke, dann notiere ich: Die Website zeigt eine geschätzte Lieferzeit, die sich nach dem Backlog richtet.\n\nSollen Kundinnen und Kunden auf der Website Motiv, Farbe und Größe selbst wählen können?',
    summary: 'Die Person stickt Polster selbst in Handarbeit, etwa zehn pro Woche, und möchte eine Website dazu. Kundinnen und Kunden sollen sofort online bezahlen können. Bestellungen werden nie gestoppt; sie laufen in einen Backlog, längere Wartezeiten werden akzeptiert. Auf die Ja-oder-Nein-Frage bestätigt die Person nun eindeutig: Die Website soll eine geschätzte Lieferzeit anzeigen, die sich nach dem Backlog richtet. Der Konfigurator für Motiv, Farbe und Größe bleibt unklar, da die früheren Zustimmungen auf Entweder-oder-Fragen erfolgten.',
    signals: ['Die Person stickt die Polster selbst.', 'Kapazität: etwa zehn Polster pro Woche.', 'Sofortige Online-Bezahlung gewünscht.', 'Keine Bestellbegrenzung: Bestellungen laufen in einen Backlog.', 'Längere Wartezeiten werden akzeptiert.', 'Geschätzte Lieferzeit nach Backlog soll angezeigt werden.', 'Konfigurator für Motiv, Farbe und Größe nicht eindeutig bestätigt.'],
    questions: ['Können Kundinnen und Kunden Motiv, Farbe und Größe selbst wählen?', 'Wie soll die geschätzte Lieferzeit berechnet werden?'],
    recent: ['Website für Stickpolster', 'Buchhaltung automatisieren', 'Termine per Telefon'],
  },
  en: {
    first: 'Should the website show an estimated delivery time based on the backlog? Please answer yes or no.',
    answer: 'Yes.', reply: 'Thank you. I will note that the website shows an estimated delivery time based on the backlog.\n\nShould customers be able to choose the design, colour and size on the website?',
    summary: 'The person embroiders cushions by hand, about ten a week, and would like a website for them. Customers should be able to pay online immediately. Orders are never stopped; they join a backlog, and longer waiting times are accepted. In response to the yes-or-no question, the person has now clearly confirmed that the website should display an estimated delivery time based on the backlog. The configurator for design, colour and size remains unclear because earlier confirmations followed either-or questions.',
    signals: ['The person embroiders the cushions by hand.', 'Capacity: about ten cushions a week.', 'Immediate online payment is wanted.', 'No order limit: orders join a backlog.', 'Longer waiting times are accepted.', 'Estimated delivery time should follow the backlog.', 'A configurator for design, colour and size has not been clearly confirmed.'],
    questions: ['Can customers choose the design, colour and size themselves?', 'How should estimated delivery time be calculated?'],
    recent: ['Cushion website', 'Automate accounting', 'Phone appointments'],
  },
};

test('AIT-131 approved display: eight states at 390, 1024, 1440, both themes and languages; model hover and conversations menu',
  { timeout: 360_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-display-'));
    const reply = 'anthropic/claude-haiku-5.5', understanding = 'anthropic/claude-opus-5.5';
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_PROVIDER: 'openrouter', OPENROUTER_MODEL: understanding, OPENROUTER_SPEECH_MODEL: reply,
      OPENROUTER_API_KEY: 'fixture-not-a-key', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [reply]: { prompt: 1e-6, completion: 5e-6 }, [understanding]: { prompt: 5e-6, completion: 25e-6 } }),
      AITHEMA_COMMIT: 'd886da3', AITHEMA_BUILD_DATE: '2026-10-12T09:00:00Z',
    });
    const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    t.after(async () => { await browser.close(); await demo.kill(); });
    const page = await browser.newPage(); page.setDefaultTimeout(30_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let locale = 'de';
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/credits')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        balance: { owner: { availableMicro: 6_550_000, limitMicro: 10_000_000, committedMicro: 3_450_000 } }, limitSlot: null,
      }) });
      if (url.pathname === '/api/library' && request.method() === 'GET') {
        const id = await shadow(page, c => c.session?.id);
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: content[locale].recent.map((title, i) =>
          ({ id: i === 0 ? id : `recent-${i}`, title, updatedAt: `2026-10-${12 - i}T09:00:00Z` })), total: 3 }) });
      }
      if (url.pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
      return request.continue();
    });
    await page.setViewport({ width: 1440, height: 900 }); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await page.evaluate(async () => {
      const { voiceEvents } = await import('/packages/core/src/live-voice.js');
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      globalThis.displaySeed = document.querySelector('aithema-session').session;
      globalThis.displayClient = { manifest, async start({ callId }) {
        const events = voiceEvents(); globalThis.displayVoiceEvents = events; globalThis.displayCallId = callId;
        return { callId, providerSessionId: 'local-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
          async sendText() {}, audioLevels: () => ({ input: .3, output: .65 }),
          async close() { events.end(); return { closureConfirmed: true }; } };
      } };
    });
    const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [];
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async (state, width, theme) => {
      const name = `${state}-${width}-${theme}-${locale}.png`;
      await shadow(page, c => c.shadowRoot.activeElement?.blur());
      if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: width === 390 }); files.push(name); }
    };
    async function scene(stage, drafts = 'off') {
      await page.evaluate(async ({ stage, drafts, locale, words }) => {
        const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
        const { inputRevision } = await import('/packages/core/src/session.js');
        const copy = { en, de }[locale], c = document.querySelector('aithema-session'), s = structuredClone(globalThis.displaySeed);
        s.locale = locale; s.settings.origin = stage === 'entrance' ? 'default' : 'chosen'; s.settings.voice = 'elevenlabs';
        s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
        s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true, reason: null }]));
        const visuals = drafts === 'off' ? { available: false, reason: 'not configured' } : drafts === 'low' ? { available: false, reason: 'owner credits exhausted' } : { available: true, reason: null };
        s.featureMatrix.best.html = visuals; s.featureMatrix.best.images = visuals;
        s.conceptVisualKind = 'html'; s.conceptCost = drafts === 'off' ? null : { maxMicro: 400_000 };
        if (stage === 'conversation') {
          s.inputRevision = 1; s.openQuestion = { stub: true };
          s.transcript = [{ id: 'a1', role: 'assistant', content: words.first }, { id: 'u1', role: 'user', content: words.answer }, { id: 'a2', role: 'assistant', content: words.reply }];
          s.understanding = { ...s.understanding, locale, inputRevision: inputRevision(s), readinessAssessed: true, draft: false, summary: words.summary,
            signals: words.signals, openQuestions: words.questions, progress: { talk: { value: .5 }, build: { value: .2 } } };
        }
        c.configure({ copy, copyForLocale: value => ({ en, de })[value], session: s, voiceClient: globalThis.displayClient,
          host: { library: true, credits: true, locale: () => locale, version: { version: '0.0.0', commit: 'd886da3', date: '2026-10-12T09:00:00Z' } } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
        window.scrollTo(0, 0);
      }, { stage, drafts, locale, words: content[locale] });
      await until(page, () => /655/.test(document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__text').textContent));
      await page.mouse.move(0, 0); await settle();
    }
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.select('#theme', theme);
      const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
      await scene('entrance');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'entrance');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
      const header = await boxes(page, ['.band-orb', '.conversations-toggle', '.settings-open']);
      assert.ok(Math.abs(header[0][1] + header[0][3] / 2 - header[1][1] - header[1][3] / 2) < .5, `${label}: band orb and menu share the first row`);
      assert.equal(header[1][3], 44); assert.equal(header[2][2], 44); assert.equal(header[2][3], 44);
      for (const selector of ['#locale', '#theme']) {
        const target = await page.$eval(selector, n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, title: n.title }));
        assert.ok(target.width >= 44 && target.height >= 44 && target.title, `${label}: ${selector} target and tooltip`);
      }
      if (locale === 'de' && theme === 'light' && width === 390) {
        await page.evaluate(() => localStorage.removeItem('aithema-motion'));
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await scene('entrance');
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', 'system default follows reduced motion');
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'on');
        await page.click('aithema-session >>> .motion-toggle');
        assert.equal(await page.evaluate(() => localStorage.getItem('aithema-motion')), 'off');
        await page.reload({ waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session?.id);
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', 'a stored choice survives a reload');
        // Seed the same deterministic fixture after the reload; it never acquires a microphone.
        await page.evaluate(async () => {
          const { voiceEvents } = await import('/packages/core/src/live-voice.js'), { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
          globalThis.displaySeed = document.querySelector('aithema-session').session;
          globalThis.displayClient = { manifest, async start({ callId }) {
            const events = voiceEvents(); globalThis.displayVoiceEvents = events; globalThis.displayCallId = callId;
            return { callId, providerSessionId: 'local-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async sendText() {},
              audioLevels: () => ({ input: .3, output: .65 }), async close() { events.end(); return { closureConfirmed: true }; } };
          } };
        });
        await page.click('aithema-session >>> .motion-toggle'); await scene('entrance');
      }
      await shot('entrance', width, theme);
      await scene('ready'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'ready');
      await shot('readiness', width, theme);
      await scene('conversation');
      const bad = await shadow(page, c => ({ sessionRow: Boolean(c.shadowRoot.querySelector('.toolbar .preset-panel')),
        tags: c.shadowRoot.querySelectorAll('.engine-tag').length, text: c.shadowRoot.querySelector('.workspace').textContent }));
      assert.equal(bad.sessionRow, false); assert.equal(bad.tags, 0);
      assert.doesNotMatch(bad.text, /~anthropic\/|anthropic\/claude|openrouter\/|Kosten unbekannt|Cost unavailable/u);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__text').textContent), locale === 'de' ? '655 von 1.000 Credits' : '655 of 1,000 Credits');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__track i').style.width), '65.5%');
      const pane = await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content'); p.scrollTop = 0;
        return { overflow: p.scrollHeight > p.clientHeight, titleMask: getComputedStyle(c.shadowRoot.querySelector('.understanding > .head')).maskImage }; });
      assert.equal(pane.overflow, true, `${label}: overflowing understanding`); assert.equal(pane.titleMask, 'none');
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').hasAttribute('data-bottom')), true);
      await shot('conversation-unscrolled', width, theme);
      await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content'), heading = c.shadowRoot.querySelector('.missing').previousElementSibling;
        p.scrollTop += heading.getBoundingClientRect().top - p.getBoundingClientRect().top - 28; });
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').hasAttribute('data-top')), true);
      const heading = await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content').getBoundingClientRect(), h = c.shadowRoot.querySelector('.missing').previousElementSibling.getBoundingClientRect();
        return { top: h.top - p.top, bottom: h.bottom - p.top, height: p.height }; });
      assert.ok(heading.top >= 24 && heading.bottom < heading.height - 40, `${label}: open-items heading stays clear of the fades: ${JSON.stringify(heading)}`);
      await shot('conversation-scrolled', width, theme);
      const stable = ['.turn.user', '.withdraw', '.composer', '.display-foot'], before = await boxes(page, stable);
      await page.hover('aithema-session >>> .turn.user'); sameBoxes(before, await boxes(page, stable), `${label}: withdraw hover`);
      await shadow(page, c => c.shadowRoot.querySelector('.withdraw').focus()); sameBoxes(before, await boxes(page, stable), `${label}: withdraw focus`);
      assert.equal((await boxes(page, ['.withdraw']))[0][2], 44);
      await page.mouse.move(0, 0); await page.evaluate(() => window.scrollTo(0, 0));
      const foldBefore = await boxes(page, ['.fold', '.motion-toggle', '.band']);
      const scrollBefore = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop));
      await shadow(page, c => c.shadowRoot.querySelector('.fold').click()); await settle();
      sameBoxes(foldBefore, await boxes(page, ['.fold', '.motion-toggle', '.band']), `${label}: fold control stays fixed`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').hidden && c.shadowRoot.querySelector('.understanding').hidden), true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.fold-question').hidden), false);
      const canvas = (await boxes(page, ['.drafts-canvas']))[0];
      assert.ok(canvas[2] >= width - 2 * Math.max(20, width * .04) - 2, `${label}: full-width canvas`);
      await shot('folded-strip-canvas', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click()); await settle();
      assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop)), scrollBefore, `${label}: restore pane scroll`);
      const footerStable = ['.display-foot', '.engine-info', '.connection-timer'], footerBefore = await boxes(page, footerStable);
      await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '1:00:00'; });
      sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: timer hour boundary keeps its width`);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: ${name}`);
        const popup = await shadow(page, (c, selector) => {
          const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect();
          return { visible: getComputedStyle(p).visibility, left: b.left, right: b.right, top: b.top, bottom: b.bottom, painted: [b.top + 4, b.bottom - 4].every(y => p.contains(c.shadowRoot.elementFromPoint(b.left + b.width / 2, y))) };
        }, selector);
        assert.equal(popup.visible, 'visible'); assert.equal(popup.painted, true, `${label}: popup is painted through its whole height`);
        assert.ok(popup.left >= 0 && popup.right <= width + .5 && popup.top >= 0 && popup.bottom <= (width === 390 ? 844 : 900), `${label}: unclipped popup ${JSON.stringify(popup)}`);
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
      await page.click('aithema-session >>> .conversations-toggle');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
      await shot('conversations-menu-open', width, theme); await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
      await scene('conversation', 'off');

      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsOff);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-off', width, theme);
      await scene('conversation', 'on');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').textContent), copy.display.draftsOn.replace('{credits}', '40'));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').disabled), false); await shot('drafts-on', width, theme);
      await scene('conversation', 'low');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsLow);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-low', width, theme);
      await scene('conversation');
      await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      await page.evaluate(() => globalThis.displayVoiceEvents.push({ type: 'speaking', callId: globalThis.displayCallId }));
      await new Promise(resolve => setTimeout(resolve, 700)); await shot('voice-rail-live', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'idle');
    }
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 768]) {
      await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
      const row = await shadow(page, c => {
        const r = c.shadowRoot, items = ['.ai-notice', '.host-credits', '.footer-right'].map(s => {
          const b = r.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        });
        const visible = s => getComputedStyle(r.querySelector(s)).display !== 'none';
        return { items, short: visible('.ai-notice__short'), version: visible('.display-version'), unit: visible('.host-credits__unit') };
      });
      assert.ok(row.items.every(b => b.left >= 0 && b.right <= width + .5), `${width}-${theme}-${locale}: footer fits`);
      assert.ok(row.items.every(b => Math.abs(b.top - row.items[0].top) <= .5), 'one footer line');
      assert.ok(row.items[0].right <= row.items[1].left + .5 && row.items[1].right <= row.items[2].left + .5, 'footer zones never overlap');
      assert.equal(row.short, width < 600); assert.equal(row.version, width >= 600); assert.equal(row.unit, width >= 360);
      await shot('footer-narrow', width, theme);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        const popup = await shadow(page, (c, selector) => { const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect(); return [b.left,b.right,b.top,b.bottom]; }, selector);
        assert.ok(popup[0] >= 0 && popup[1] <= width + .5 && popup[2] >= 0 && popup[3] <= 900, 'narrow popup fits');
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
    }
    locale = 'de'; await page.setViewport({ width: 1440, height: 900 }); await page.select('#theme', 'light'); await scene('conversation');
    const footer = await boxes(page, ['.display-foot', '.engine-info', '.composer']);
    await page.hover('aithema-session >>> .engine-info'); sameBoxes(footer, await boxes(page, ['.display-foot', '.engine-info', '.composer']), 'footer model hover');
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility), 'visible');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.engine__detail').textContent), 'Beste Modelle, international\nAntworten: Claude Haiku 5.5\nEinschätzung: Claude Opus 5.5\nüber OpenRouter · Stimme: ElevenLabs');
    await shot('footer-model-hover-open', 1440, 'light');
    await page.mouse.move(0, 0); await page.click('aithema-session >>> .conversations-toggle');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
    assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.conversations-menu [role="menuitem"]')].map(n => n.textContent)),
      ['Neues Gespräch', 'Website für Stickpolsterjetzt', 'Buchhaltung automatisieren11. Okt.', 'Termine per Telefon10. Okt.', 'Alle Gespräche verwalten']);
    await shot('conversations-menu-open', 1440, 'light');
    await page.keyboard.press('Escape'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'conversations-toggle');
    assert.deepEqual(errors, []);
    if (evidence) await writeFile(join(evidence, 'display-evidence.json'), JSON.stringify({ ticket: 'AIT-131', createdAt: new Date().toISOString(), files }, null, 2));
    // Optional read-only design reference supplied on the remote runner; never committed to the public repo.
    if (evidence) {
      try {
        const html = await readFile('/tmp/aithema-ait-131-approved.html', 'utf8');
        const reference = await browser.newPage(); await reference.setViewport({ width: 1440, height: 900 });
        await reference.setContent(html); await reference.evaluate(() => { document.body.classList.add('noanno'); document.documentElement.dataset.theme = 'light'; });
        await reference.screenshot({ path: join(evidence, 'approved-reference-1440-light-de.png'), fullPage: true }); await reference.close();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    t.diagnostic(`AIT-131 display matrix: Round-2 state and footer screenshots; ${files.length} files written.`);
  });
