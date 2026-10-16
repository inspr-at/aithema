// AIT-131 evidence: the real reference page and component, with deterministic display snapshots and local voice.
// No provider calls, microphone, wallet writes or voice lifecycle work. Run only on the remote browser runner.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { readFile } from 'node:fs/promises';
import { shadow, until, settle, boxes, layoutBoxes, statusGeometry, sameBoxes, pixelRgb, finishRevealEntry, freezeRevealExit, seekReveal, evidenceCommit } from './start2-display-helpers.js';

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

export async function displayMatrix(t, section) {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-display-'));
    const reply = 'anthropic/claude-haiku-5.5', understanding = 'anthropic/claude-opus-5.5';
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_PROVIDER: 'openrouter', OPENROUTER_MODEL: understanding, OPENROUTER_SPEECH_MODEL: reply,
      OPENROUTER_API_KEY: 'fixture-not-a-key', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [reply]: { prompt: 1e-6, completion: 5e-6 }, [understanding]: { prompt: 5e-6, completion: 25e-6 } }),
      AITHEMA_COMMIT: evidenceCommit, AITHEMA_BUILD_DATE: '2026-10-12T09:00:00Z',
    });
    const browser = await browserForFile();
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
    const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], reveals = [];
    if (evidence) await mkdir(evidence, { recursive: true });
    let coverageGroup;
    const caseCounts = { 'integrated-flow': 0, 'integrated-narrow': 0 };
    const shot = async (state, width, theme, preserveFocus = false) => {
      if (coverageGroup) caseCounts[coverageGroup]++;
      const name = `${state}-${width}-${theme}-${locale}.png`;
      if (!preserveFocus) await shadow(page, c => { const active = c.shadowRoot.activeElement; if (active && !c.shadowRoot.querySelector('.conversations-menu').contains(active)) active.blur(); });
      if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: false }); files.push(name); }
    };
    async function scene(stage, drafts = 'off') {
      await page.evaluate(async ({ stage, drafts, locale, words, commit }) => {
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
          for (const turn of s.transcript) if (turn.role === 'assistant') turn.inputRevision = inputRevision(s);
          s.understanding = { ...s.understanding, locale, inputRevision: inputRevision(s), readinessAssessed: true, draft: false, summary: words.summary,
            signals: words.signals, openQuestions: words.questions, progress: { talk: { value: .5 }, build: { value: .2 } } };
        }
        c.configure({ copy, copyForLocale: value => ({ en, de })[value], session: s, voiceClient: globalThis.displayClient,
          host: { library: true, credits: true, locale: () => locale, version: { version: '0.0.0', commit, date: '2026-10-12T09:00:00Z' } } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
        window.scrollTo(0, 0);
      }, { stage, drafts, locale, words: content[locale], commit: evidenceCommit });
      await until(page, () => /655/.test(document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__text').textContent));
      await page.mouse.move(0, 0); await settle();
    }
    async function revealEvidence(width, theme, copy) {
      const label = `${width}-${theme}-${locale}`, selector = 'aithema-session >>> .band-orb .orb';
      const baseline = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map(node => {
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { box: [r.x, r.y, r.width, r.height], opacity: style.opacity,
          eligible: style.visibility !== 'hidden' && Number(style.opacity) !== 0 && node.getClientRects().length > 0 };
      }));
      const orb = await shadow(page, c => { const r = c.shadowRoot.querySelector('.band-orb .orb').getBoundingClientRect(); return [r.width, r.height]; });
      assert.deepEqual(orb, [44, 44], `${label}: real band orb hit target`);
      assert.deepEqual((await boxes(page, ['.band-orb .orb__body']))[0].slice(2), [40, 40], `${label}: 40px visual`);
      await page.hover(selector); await new Promise(resolve => setTimeout(resolve, 120));
      await page.mouse.move(0, 300); await new Promise(resolve => setTimeout(resolve, 260));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'closed', `${label}: quick pass`);
      await page.hover(selector);
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.band').dataset.aithemaRevealState === 'open');
      // Wait for the actual finite entry effects; elapsed wall time does not prove
      // that Chrome has finished a transition on a busy runner.
      await finishRevealEntry(page);
      await shot('reveal-open', width, theme, true);
      const links = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band .aithema-reveal__link')].map(n => ({ href: n.href, title: n.title,
        right: n.getBoundingClientRect().right, bottom: n.getBoundingClientRect().bottom, opacity: getComputedStyle(n).opacity })));
      assert.deepEqual(links.map(n => n.href), copy.reveal.links.map(link => new URL(link.href).href));
      assert.deepEqual(links.map(n => n.title), copy.reveal.links.map(link => link.subtitle));
      const band = (await boxes(page, ['.band']))[0];
      assert.ok(links.every(n => n.opacity === '1' && n.right <= width + .5 && n.bottom <= band[1] + band[3]), `${label}: reveal links fit the real band`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__version code').textContent), evidenceCommit.slice(0, 10));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__version code').title), evidenceCommit);
      assert.match(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__version').title), /2026-10-12/);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__row').getAttribute('aria-label')), copy.reveal.label);
      const controls = await shadow(page, (c, baseline) => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map((n, i) => ({
        name: n.className, inert: n.inert, proxy: Boolean(n.closest('.aithema-reveal__dissolves')), marked: n.hasAttribute('data-aithema-reveal-control'),
        eligible: baseline[i].eligible,
      })), baseline);
      const phase = await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState);
      assert.ok(phase === 'open' && controls.every(n => n.eligible ? n.inert && n.marked : !n.marked), `${label}: only visible controls dissolve (${phase}): ${JSON.stringify(controls)}`);
      // Hold only this synchronous exit's cleanup. Its genuine CSS timelines can then be sampled
      // at exact times without screenshot latency advancing them between requested frames.
      assert.deepEqual(await freezeRevealExit(page), { phase: 'exiting', from: '1', to: '0', duration: 300 }, `${label}: capture the genuine brand exit transition`);
      const samples = [], point = { x: 2, y: Math.floor(band[1] + band[3] - 10), width: 1, height: 1 };
      for (let ms = 0; ms <= 900; ms += 50) {
        await seekReveal(page, ms);
        const opacities = await shadow(page, c => ({
          phase: c.shadowRoot.querySelector('.band').dataset.aithemaRevealState,
          glass: Number(getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__glass')).opacity),
          brand: Number(getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity),
          controls: [...c.shadowRoot.querySelectorAll('[data-aithema-reveal-control]')].map(n => {
            const style = getComputedStyle(n); return { name: n.className, opacity: Number(style.opacity), visible: style.visibility !== 'hidden' && n.getClientRects().length > 0 };
          }),
          proxies: [...c.shadowRoot.querySelectorAll('.aithema-reveal__proxy')].map(n => Number(getComputedStyle(n).opacity)),
        }));
        assert.equal(opacities.phase, 'exiting', `${label}: every frame belongs to the captured exit`);
        if (ms >= 300) assert.equal(opacities.brand, 0, `${label}: brand exit is complete at ${ms}ms`);
        if (opacities.brand > .25 && ![...opacities.controls.filter(n => n.visible).map(n => n.opacity), ...opacities.proxies].every(value => value <= .25)) {
          const timeline = await shadow(page, c => ({
            phase: c.shadowRoot.querySelector('.band').dataset.aithemaRevealState,
            animations: globalThis.displayRevealTimeline.filter(a => a.effect.target.matches('.aithema-reveal__row,.aithema-reveal__glass,[data-aithema-reveal-control]')).map(a => ({
              target: a.effect.target.className, property: a.transitionProperty, state: a.playState, pending: a.pending,
              currentTime: a.currentTime, timing: a.effect.getTiming(), keyframes: a.effect.getKeyframes(),
            })),
          }));
          assert.fail(`${label}: brand and visible controls do not overlap: ${JSON.stringify({ ms, ...opacities, timeline })}`);
        }
        samples.push({ ms, rgb: pixelRgb(Buffer.from(await page.screenshot({ clip: point }))), ...opacities });
        if ([0, 150, 300, 450, 700].includes(ms)) await shot(`reveal-exit-${ms}ms`, width, theme, true);
      }
      for (let channel = 0; channel < 3; channel++) {
        const values = samples.map(sample => sample.rgb[channel]), direction = Math.sign(values.at(-1) - values[0]);
        if (direction === 0) assert.ok(Math.max(...values) - Math.min(...values) <= 2, `${label}: exit colour channel ${channel}`);
        else for (let i = 1; i < values.length; i++) assert.ok((values[i] - values[i - 1]) * direction >= -2, `${label}: monotonic exit colour channel ${channel}`);
      }
      await seekReveal(page, 1600); await page.evaluate(() => { globalThis.displayRevealCleanup(); delete globalThis.displayRevealCleanup; });
      const restored = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map(n => {
        const r = n.getBoundingClientRect(); return { box: [r.x, r.y, r.width, r.height], opacity: getComputedStyle(n).opacity, inert: n.inert };
      }));
      sameBoxes(baseline.map(n => n.box), restored.map(n => n.box), `${label}: reveal restores the band`);
      assert.deepEqual(restored.map(n => n.opacity), baseline.map(n => n.opacity));
      assert.ok(restored.every(n => !n.inert));
      await page.mouse.move(0, 300); await shot('reveal-restored', width, theme);
      // Use the actual edge toggle for both modules, including an open reveal.
      await page.click('aithema-session >>> .motion-toggle');
      await shadow(page, c => c.shadowRoot.querySelector('.band-orb .orb').focus());
      await finishRevealEntry(page);
      const calm = await shadow(page, c => ({ motion: c.getAttribute('motion'), orb: c.shadowRoot.querySelector('.band-orb .orb').dataset.orbMotion,
        reveal: c.shadowRoot.querySelector('.band').dataset.aithemaRevealMotion,
        duration: getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__glass')).transitionDuration,
        brand: getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity,
        controlsHidden: [...c.shadowRoot.querySelectorAll('[data-aithema-reveal-control]')].every(n => getComputedStyle(n).opacity === '0'),
        sparks: Boolean(c.shadowRoot.querySelector('.aithema-reveal__stars')),
        animations: c.shadowRoot.querySelector('.band').getAnimations({ subtree: true }).filter(a => a.playState === 'running').length }));
      assert.deepEqual(calm, { motion: 'off', orb: 'off', reveal: 'off', duration: '0.2s', brand: '1', controlsHidden: true, sparks: false, animations: 0 });
      await shot('reveal-motion-off-open', width, theme, true);
      await page.keyboard.press('Escape');
      await until(page, () => {
        const band = document.querySelector('aithema-session').shadowRoot.querySelector('.band');
        return band.dataset.aithemaRevealState === 'closed' && band.getAnimations({ subtree: true }).every(a => a.playState !== 'running');
      });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'closed');
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity), '0', `${label}: calm exit hides the brand`);
      assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map(n => getComputedStyle(n).opacity)), baseline.map(n => n.opacity), `${label}: calm exit restores every control`);
      await page.click('aithema-session >>> .motion-toggle');
      reveals.push({ width, theme, locale, links, point, clock: 'paused CSS timelines; exact 50ms rendered-pixel samples', samples });
    }
    async function menuEvidence(width, theme) {
      const selectors = ['.band-orb', '.conversations-toggle', '.settings-open'], before = await boxes(page, selectors);
      await page.click('aithema-session >>> .conversations-toggle');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
      const menu = await shadow(page, c => {
        const n = c.shadowRoot.querySelector('.conversations-menu'), b = n.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
          painted: [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]]
            .every(([x, y]) => n.contains(c.shadowRoot.elementFromPoint(x, y))) };
      });
      assert.ok(menu.left >= 0 && menu.right <= width + .5 && menu.top >= 0 && menu.bottom <= (width === 390 ? 844 : 900), `${width}-${theme}-${locale}: conversations menu fits ${JSON.stringify(menu)}`);
      assert.equal(menu.painted, true, `${width}-${theme}-${locale}: every menu corner is visible ${JSON.stringify(menu)}`);
      sameBoxes(before, await boxes(page, selectors), 'opening the menu keeps the band fixed');
      await shot('conversations-menu-open', width, theme); await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
    }
    if (section === 'geometry') {
    await t.test('B1/B2: header icon and Settings preferences retain icon sizes, centred chevrons and gaps at every width', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 321, 390, 400, 600, 680, 768, 900, 1000, 1024, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        await page.click('aithema-session >>> .settings-open');
        const menus = await page.evaluate(() => {
          const root = document.querySelector('aithema-session').shadowRoot;
          const button = root.querySelector('.conversations-toggle');
          const rect = n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, cy: b.top + b.height / 2, width: b.width, height: b.height }; };
          return [{ host: button, glyph: button.firstElementChild, label: null, chevron: null },
            ...[...document.querySelectorAll('.utility')].map(host => ({ host, glyph: host.querySelector('.utility-icon svg'), label: host.querySelector('.utility-value'), chevron: host.querySelector('.utility-chevron svg') }))]
            .map(({ host, glyph, label, chevron }) => ({ glyph: rect(glyph), label: label ? rect(label) : null, chevron: chevron ? rect(chevron) : null,
              path: chevron?.querySelector('path')?.getAttribute('d'), gap: getComputedStyle(host).columnGap, theme: host.classList.contains('utility-theme'), bounds: rect(host) }));
        });
        assert.ok(menus.every(n => n.bounds.left >= 0 && n.bounds.right <= width + .5), `${width}/${theme}/${locale}: menus fit`);
        assert.ok(menus.slice(1).every(n => n.chevron), 'language and appearance use the shared SVG chevron');
        for (const menu of menus.filter(menu => menu.label?.width > 0)) {
          assert.equal(menu.chevron.width, 10); assert.equal(menu.chevron.height, 10);
          assert.ok(Math.abs(menu.chevron.cy - menu.label.cy) <= .5, 'chevron is centred on its label');
          assert.equal(menu.path, menus[1].path);
          assert.equal(menu.gap, menu.theme ? '4px' : menus[1].gap, 'AIT-206 theme chevron uses Tick’s 4px gap; other menus keep their shared spacing');
          assert.equal(menu.glyph.width, 16); assert.equal(menu.glyph.height, 16);
        }
        await page.keyboard.press('Escape');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-toggle > svg').getBoundingClientRect().width), 16, 'the conversations icon is visible even at 320');
      }
    });
    await t.test('B3/B4/B8: footer zones stay 24px apart, digits start after 6px, and only the credit number is bold', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1000, 900, 768, 680, 600, 390, 320]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
        const footer = await shadow(page, c => {
          const root = c.shadowRoot, rect = s => { const b = root.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top }; };
          const visible = s => getComputedStyle(root.querySelector(s)).display !== 'none';
          const weight = s => Number(getComputedStyle(root.querySelector(s)).fontWeight);
          const timer = root.querySelector('.connection-timer'), style = getComputedStyle(timer);
          const digits = document.createRange(); digits.selectNodeContents(timer);
          return { zones: ['.ai-notice', '.host-credits', '.footer-right'].map(rect), flag: rect('.engine__flag'), label: rect('.status__label'),
            digits: digits.getBoundingClientRect().left, timer: rect('.connection-timer'), align: style.textAlign, numeric: style.fontVariantNumeric,
            amount: weight('.host-credits__amount'), total: weight('.host-credits__total'), unit: weight('.host-credits__unit'),
            voice: visible('.ai-notice__voice'), short: visible('.ai-notice__short'), legal: !root.querySelector('.host-legal').hidden, connected: visible('.status__label') };
        });
        const context = `${width}/${theme}/${locale}: ${JSON.stringify(footer)}`;
        assert.ok(footer.zones[1].left - footer.zones[0].right >= (width < 600 && footer.legal ? 7.5 : 23.5) && footer.zones[2].left - footer.zones[1].right >= (width < 600 && footer.legal ? 7.5 : 23.5), context);
        assert.ok(footer.zones.every(n => n.left >= 0 && n.right <= width + .5 && Math.abs(n.top - footer.zones[0].top) <= .5), context);
        if (footer.connected) { assert.ok(Math.abs(footer.digits - footer.label.right - 6) <= .5, context); assert.ok(Math.abs(footer.label.left - footer.flag.right - 12) <= .5, context); }
        assert.equal(footer.align, 'start'); assert.equal(footer.numeric, 'tabular-nums');
        assert.ok(footer.amount >= 600); assert.equal(footer.total, 400); assert.equal(footer.unit, 400);
        assert.equal(footer.voice, width >= 1100); assert.equal(footer.short, width < 680);
        const before = await boxes(page, ['.connection-timer', '.engine-info', '.ai-notice', '.host-credits']);
        await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '1:00:00'; });
        sameBoxes(before, await boxes(page, ['.connection-timer', '.engine-info', '.ai-notice', '.host-credits']), 'reserve after digits prevents jitter');
        await shot('footer-amended', width, theme);
      }
    });
    await t.test('B5: 320 flag hover has no slide-in label; 390 retains it without moving the credits', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 390]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        const before = await boxes(page, ['.engine-info', '.host-credits__amount', '.connection-timer']);
        await page.hover('aithema-session >>> .engine-info'); await settle();
        const label = await shadow(page, c => { const n = c.shadowRoot.querySelector('.engine__value'), style = getComputedStyle(n);
          return { displayed: style.display !== 'none', popup: getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility }; });
        assert.equal(label.displayed, width >= 360); assert.equal(label.popup, 'visible');
        sameBoxes(before, await boxes(page, ['.engine-info', '.host-credits__amount', '.connection-timer']), 'flag hover');
        await shot('flag-hover-amended', width, theme);
      }
    });
    await t.test('B6: the hidden stop slot never gets a reveal proxy or stagger', async () => {
      locale = 'de'; await page.setViewport({ width: 1440, height: 900 }); await scene('conversation');
      const before = await shadow(page, c => c.shadowRoot.querySelector('.audio-rail .voice-pause').outerHTML);
      await shadow(page, c => c.shadowRoot.querySelector('.band-orb .orb').click());
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.aithema-reveal__proxy.voice-pause'))), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail .voice-pause').outerHTML), before, 'hidden control is untouched');
      await scene('conversation');
    });
    await t.test('B7: status flanks hide together below 24px without removing the waveform box', async () => {
      for (locale of ['de', 'en']) for (const width of [320, 390, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', 'light'); await scene('ready');
        const wave = await shadow(page, c => { const n = c.shadowRoot.querySelector('.voice-wave'), style = getComputedStyle(n), rect = n.getBoundingClientRect();
          return { width: rect.width, height: rect.height, flank: rect.width / 2 - parseFloat(style.getPropertyValue('--voice-label-half')) - Math.abs(parseFloat(style.getPropertyValue('--voice-label-center'))) - 16, visibility: style.visibility }; });
        assert.ok(wave.width > 0 && wave.height === 30, 'visibility keeps the reserved box');
        assert.equal(wave.visibility, wave.width >= 184 && wave.flank >= 24 ? 'visible' : 'hidden', JSON.stringify({ width, locale, ...wave }));
        await shot('band-amended', width, 'light');
      }
    });
    await t.test('AIT-240 menu: one icon and a full localized accessible name at every width', async () => {
      for (locale of ['de', 'en']) for (const width of [390, 393, 400, 412, 430, 440, 447, 448, 479, 480, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', 'light'); await scene('ready');
        const menu = await shadow(page, c => {
          const n = c.shadowRoot.querySelector('.conversations-toggle'), label = n.querySelector('span'), style = getComputedStyle(label);
          const rect = n.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(label);
          return { name: n.getAttribute('aria-label'), title: n.title, label: label.textContent, visible: style.display !== 'none',
            overflow: style.textOverflow, icon: n.firstElementChild.getBoundingClientRect().width,
            fits: range.getBoundingClientRect().width <= labelRect.width + .5 && labelRect.right <= rect.right + .5 };
        });
        const name = locale === 'de' ? 'Gespräche' : 'Conversations';
        assert.equal(menu.name, name); assert.equal(menu.title, name); assert.equal(menu.label, name); assert.equal(menu.icon, 16);
        // AIT-260 restores the approved desktop label; phones keep the menu glyph.
        assert.equal(menu.visible, width >= 600); assert.notEqual(menu.overflow, 'ellipsis');
        if (menu.visible) assert.equal(menu.fits, true, `${width}/${locale}: ${JSON.stringify(menu)}`);
        await shot('r2-band', width, 'light');
      }
    });
    await t.test('AIT-239 status: one/two lines keep 8px clear space plus 8px fade, no waveform under text and no control shift', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('ready');
        const single = await statusGeometry(page);
        if (width >= 600) assert.equal(single.rendered.length, 1, 'the ready label is a one-line reference');
        const selectors = ['.band', '.band-orb', '.audio-rail', '.voice-cell--output', '.voice-cell--mic', '.settings-open'];
        const before = await boxes(page, selectors), mic = (await boxes(page, ['.voice-cell--mic']))[0];
        await page.mouse.move(mic[0] + 22, mic[1] + 22);
        await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } }));
        await until(page, expected => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-state').textContent === expected, { de, en }[locale].featureConsent.voice);
        await settle();
        const label = await statusGeometry(page), renderedWidth = Math.max(...label.rendered.map(r => r.width));
        assert.ok(Math.abs(label.half - renderedWidth / 2) <= .5, `${width}/${theme}/${locale}: rendered-line hole ${JSON.stringify(label)}`);
        if (width >= 600) for (const [i, gap] of label.gaps.entries()) {
          assert.ok(Math.abs(gap - 16) <= .5, `8px clear space plus 8px fade beside the widest line: ${JSON.stringify(label)}`);
          assert.ok(Math.abs(gap - single.gaps[i]) <= 2, 'one-line and wrapped text have the same gap (±2px)');
        }
        assert.ok(Math.abs(label.x + label.width / 2 - label.waveX - label.waveWidth / 2) <= .5, 'the hole is centred under the label');
        assert.ok(label.lines <= 2.05, `${width}/${theme}/${locale}: at most two lines ${JSON.stringify(label)}`);
        if (width >= 600) assert.ok(label.width <= label.waveWidth / 2 + .5, 'the wide status label uses at most half the wave');
        assert.notEqual(label.overflow, 'ellipsis'); assert.ok(label.scrollHeight <= label.clientHeight + 1, 'the full consent text stays readable');
        sameBoxes(before, await boxes(page, selectors), 'status and observer preserve every control under the pointer');
        await shot('r3-consent-status', width, theme, true);
        // The capped box may contain wave outside the rendered lines. Isolate paint underneath
        // the text itself, retaining the layout and mask while hiding only the glyphs.
        const text = label.textBox, clip = { x: Math.ceil(text.x), y: Math.ceil(text.y), width: Math.floor(text.right) - Math.ceil(text.x), height: Math.floor(text.bottom) - Math.ceil(text.y) };
        const background = await shadow(page, c => {
          const signal = c.shadowRoot.querySelector('.voice-signal');
          const saved = [signal.style.getPropertyValue('background'), signal.style.getPropertyPriority('background')];
          // The transparent hole must expose exactly the same backdrop in both shots.
          // Gradient dithering can change by 1/255 when Chrome changes compositing layers.
          signal.style.setProperty('background', 'var(--aithema-paper)');
          c.shadowRoot.querySelector('.voice-state').style.visibility = 'hidden';
          return saved;
        });
        let painted, clear;
        try {
          painted = Buffer.from(await page.screenshot({ clip }));
          await shadow(page, c => { c.shadowRoot.querySelector('.voice-wave').style.visibility = 'hidden'; });
          clear = Buffer.from(await page.screenshot({ clip }));
        } finally {
          await shadow(page, (c, [value, priority]) => {
            const signal = c.shadowRoot.querySelector('.voice-signal');
            value ? signal.style.setProperty('background', value, priority) : signal.style.removeProperty('background');
            c.shadowRoot.querySelector('.voice-wave').style.removeProperty('visibility');
            c.shadowRoot.querySelector('.voice-state').style.removeProperty('visibility');
          }, background);
        }
        if (evidence) {
          for (const [suffix, bytes] of [['painted', painted], ['wave-hidden', clear]]) {
            const name = `r3-consent-pixels-${width}-${theme}-${locale}-${suffix}.png`; await writeFile(join(evidence, name), bytes); files.push(name);
          }
          await writeFile(join(evidence, `r3-consent-geometry-${width}-${theme}-${locale}.json`), JSON.stringify({ single, consent: label }, null, 2));
        }
        assert.ok(painted.equals(clear), `${width}/${theme}/${locale}: no flank pixel under the rendered text`);
      }
    });
    } else {
    coverageGroup = 'integrated-flow';
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 0, 'integrated-flow')) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.select('#theme', theme);
      const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
      await scene('entrance');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'entrance');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        t.diagnostic('phone overflow geometry: ' + JSON.stringify(await page.evaluate(() => {
          const nodes = [], visit = root => { for (const n of root.querySelectorAll('*')) { nodes.push(n); if (n.shadowRoot) visit(n.shadowRoot); } }; visit(document);
          return { viewport: innerWidth, page: document.documentElement.scrollWidth, nodes: nodes.flatMap(n => {
            const b = n.getBoundingClientRect(), s = getComputedStyle(n);
            if (b.right <= innerWidth + .5 || !b.width || s.display === 'none') return [];
            return [{ tag: n.tagName, class: typeof n.className === 'string' ? n.className : n.className.baseVal, x: b.x, right: b.right, width: b.width,
              position: s.position, visibility: s.visibility, overflow: s.overflowX, clip: s.clipPath, minWidth: s.minWidth, maxWidth: s.maxWidth, left: s.left, transform: s.transform }];
          }).slice(0, 30) };
        })));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
      const header = await boxes(page, ['.band-orb', '.conversations-toggle', '.settings-open']);
      assert.ok(Math.abs(header[0][1] + header[0][3] / 2 - header[1][1] - header[1][3] / 2) < .5, `${label}: band orb and menu share the first row`);
      assert.equal(header[1][3], 44); assert.equal(header[2][2], 44); assert.equal(header[2][3], 44);
      const edge = await boxes(page, ['.motion-toggle', '.fold', '.band']);
      assert.equal(edge[0][2], 44); assert.equal(edge[1][2], 44);
      assert.ok(Math.abs(edge[0][0] + 22 - 28) <= .5 && Math.abs(edge[1][0] + 22 - 28) <= .5, `${label}: edge controls share the 14 px column`);
      assert.ok(Math.abs(edge[0][1] + 22 - (edge[2][1] + edge[2][3] / 2 - 3)) <= .5, `${label}: motion control follows the approved band centre`);
      await page.click('aithema-session >>> .settings-open');
      for (const selector of ['#locale', '#theme']) {
        const target = await page.$eval(selector, n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, title: n.title }));
        assert.ok(target.width >= 44 && target.height >= 44 && target.title, `${label}: ${selector} target and tooltip`);
      }
      await page.keyboard.press('Escape');
      if (locale === 'de' && theme === 'light' && width === 390) {
        await page.evaluate(() => localStorage.removeItem('aithema-motion'));
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await scene('entrance');
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', 'system default follows reduced motion');
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        await until(page, () => document.querySelector('aithema-session').getAttribute('motion') === 'on');
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
      assert.ok((await boxes(page, ['.intro__orb .orb']))[0][2] >= 64, `${label}: the entrance keeps its large orb`);
      await scene('ready'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'ready');
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.intro__orb')).display), 'none', `${label}: the band is the only ready orb`);
      await shot('readiness', width, theme);
      await scene('conversation');
      await revealEvidence(width, theme, copy);
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
      // AIT-188 bounds the phone transcript above its dock. Reveal the hover
      // target before recording geometry: Puppeteer's implicit scroll is a
      // reading-position change, not a hover-induced layout change.
      await shadow(page, c => c.shadowRoot.querySelector('.turn.user').scrollIntoView({ block: 'center', behavior: 'instant' }));
      const stable = ['.turn.user', '.withdraw', '.composer', '.display-foot'], before = await boxes(page, stable);
      await page.hover('aithema-session >>> .turn.user'); sameBoxes(before, await boxes(page, stable), `${label}: withdraw hover`);
      await shadow(page, c => c.shadowRoot.querySelector('.withdraw').focus({ preventScroll: true })); sameBoxes(before, await boxes(page, stable), `${label}: withdraw focus`);
      assert.equal((await boxes(page, ['.withdraw']))[0][2], 44);
      await page.mouse.move(0, 0); await page.evaluate(() => window.scrollTo(0, 0));
      const foldBefore = await boxes(page, ['.fold', '.motion-toggle', '.band']);
      const scrollBefore = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop));
      await shadow(page, c => c.shadowRoot.querySelector('.fold').click()); await settle();
      sameBoxes(foldBefore, await boxes(page, ['.fold', '.motion-toggle', '.band']), `${label}: fold control stays fixed`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').hidden || c.shadowRoot.querySelector('.understanding').hidden), false, `${label}: no-drafts host retains the transcript`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.fold-question').hidden), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.drafts-canvas').checkVisibility()), false, `${label}: no empty canvas promise`);
      await shot('no-drafts-transcript', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click()); await settle();
      assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop)), scrollBefore, `${label}: restore pane scroll`);
      const footerStable = ['.display-foot', '.engine-info', '.connection-timer'], footerBefore = await boxes(page, footerStable);
      const timerText = await shadow(page, c => { const timer = c.shadowRoot.querySelector('.connection-timer'), text = timer.textContent; timer.textContent = '1:00:00'; return text; });
      sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: timer hour boundary keeps its width`);
      await shadow(page, (c, text) => { c.shadowRoot.querySelector('.connection-timer').textContent = text; }, timerText);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: ${name}`);
        const popup = await shadow(page, (c, selector) => {
          const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(p);
          const clipped = [...range.getClientRects()].filter(r => r.width && r.height).some(r => r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1);
          return { visible: getComputedStyle(p).visibility, left: b.left, right: b.right, top: b.top, bottom: b.bottom, clipped, painted: [b.top + 4, b.bottom - 4].every(y => p.contains(c.shadowRoot.elementFromPoint(b.left + b.width / 2, y))) };
        }, selector);
        assert.equal(popup.visible, 'visible'); assert.equal(popup.clipped, false, `${label}: every popup line is readable`); assert.equal(popup.painted, true, `${label}: popup is painted through its whole height`);
        assert.ok(popup.left >= 0 && popup.right <= width + .5 && popup.top >= 0 && popup.bottom <= (width === 390 ? 844 : 900), `${label}: unclipped popup ${JSON.stringify(popup)}`);
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
      await menuEvidence(width, theme);
      await scene('conversation', 'off');

      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsOff);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-off', width, theme);
      await scene('conversation', 'on');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').textContent), `${copy.display.draftsOn}\u00a0· ${copy.display.creditUpperBound.replace('{cost}', `40 ${copy.display.credits}`).replaceAll(' ', '\u00a0')}`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').disabled), false); await shot('drafts-on', width, theme);
      await scene('conversation', 'low');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsLow);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-low', width, theme);
      await scene('conversation');
      await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      const status = await shadow(page, c => { const n = c.shadowRoot.querySelector('.voice-state'), style = getComputedStyle(n);
        return { text: n.textContent, background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, border: style.borderWidth }; });
      assert.deepEqual(status, { text: copy.voiceStates.listening, background: 'rgba(0, 0, 0, 0)', image: 'none', shadow: 'none', border: '0px' }, `${label}: voice status sits directly on the band`);
      await shot('band-voice-listening', width, theme);
      await page.evaluate(() => globalThis.displayVoiceEvents.push({ type: 'speaking', callId: globalThis.displayCallId }));
      await new Promise(resolve => setTimeout(resolve, 700));
      const wave = await shadow(page, c => { const canvas = c.shadowRoot.querySelector('.voice-wave'), box = canvas.getBoundingClientRect(), ratio = Math.min(2,devicePixelRatio);
        return { width: canvas.width / ratio, cssWidth: box.width, stroke: canvas.getContext('2d').lineWidth / ratio }; });
      assert.ok(Math.abs(wave.width - wave.cssWidth) <= .5, `${label}: waveform backing store follows its width`);
      assert.ok(Math.abs(wave.stroke - 1.6) <= 1e-6, `${label}: 1.6 px waveform bars`);
      await shot('voice-rail-live', width, theme);
      // AIT-138: waiting keeps the same logical call and the same fixed cells.
      const waitingSelectors = ['.band', '.audio-rail', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.composer'];
      const beforeWaiting = await layoutBoxes(page, waitingSelectors);
      await page.evaluate(() => globalThis.displayVoiceEvents.push({ type: 'waiting', callId: globalThis.displayCallId, reason: 'recovery-failed' }));
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'waiting');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), copy.voiceStates.waiting);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').title), copy.resume);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-message')), false);
      sameBoxes(beforeWaiting, await layoutBoxes(page, waitingSelectors), `${label}: waiting reserves existing rail space`);
      if ([390, 1440].includes(width)) await shot('ait-138-voice-waiting', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'idle');
    }
    assertMatrixCaseCount('integrated-flow', caseCounts['integrated-flow']);
    coverageGroup = 'integrated-narrow';
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of matrixWidths([320, 600, 680, 768, 900, 1000], theme, 1, 'integrated-narrow')) {
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
      assert.equal(row.short, width < 680); assert.equal(row.version, width >= 680); assert.equal(row.unit, width >= 360);
      await shot('footer-narrow', width, theme);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        const popup = await shadow(page, (c, selector) => { const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect(); return [b.left,b.right,b.top,b.bottom]; }, selector);
        assert.ok(popup[0] >= 0 && popup[1] <= width + .5 && popup[2] >= 0 && popup[3] <= 900, 'narrow popup fits');
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
      await menuEvidence(width, theme);
    }
    assertMatrixCaseCount('integrated-narrow', caseCounts['integrated-narrow']);
    coverageGroup = undefined;
    locale = 'de'; await page.setViewport({ width: 1440, height: 900 }); await page.select('#theme', 'light'); await scene('conversation');
    const footer = await boxes(page, ['.display-foot', '.engine-info', '.composer']);
    await page.hover('aithema-session >>> .engine-info'); sameBoxes(footer, await boxes(page, ['.display-foot', '.engine-info', '.composer']), 'footer model hover');
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility), 'visible');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.engine__detail').textContent), 'Beste Modelle, international\nAntworten: Claude Haiku 5.5\nEinschätzung: Claude Opus 5.5\nüber OpenRouter\u00a0· Stimme: ElevenLabs');
    await shot('footer-model-hover-open', 1440, 'light');
    await page.mouse.move(0, 0); await page.click('aithema-session >>> .conversations-toggle');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
    assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.conversations-menu [role="menuitem"]')].map(n => n.textContent)),
      ['Neues Gespräch', 'Website für Stickpolsterjetzt', 'Buchhaltung automatisieren11. Okt.', 'Termine per Telefon10. Okt.', 'Alle Gespräche verwalten']);
    await shot('conversations-menu-open', 1440, 'light');
    await page.keyboard.press('Escape'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'conversations-toggle');
    }
    assert.deepEqual(errors, []);
    if (evidence) {
      await writeFile(join(evidence, section === 'geometry' ? 'geometry-display-evidence.json' : 'display-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, createdAt: new Date().toISOString(), files }, null, 2));
      await writeFile(join(evidence, section === 'geometry' ? 'geometry-integrated-reveal-evidence.json' : 'integrated-reveal-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, createdAt: new Date().toISOString(), reveals }, null, 2));
    }
    // Optional read-only design reference supplied on the remote runner; never committed to the public repo.
    if (evidence && section === 'evidence') {
      try {
        const html = await readFile('/tmp/aithema-ait-131-approved.html', 'utf8');
        const reference = await browser.newPage();
        for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
          await reference.goto('about:blank');
          await reference.setViewport({ width, height: width === 390 ? 844 : 900 });
          await reference.setContent(html);
          await reference.evaluate(theme => { document.body.classList.add('noanno'); document.documentElement.dataset.theme = theme; }, theme);
          await reference.screenshot({ path: join(evidence, `approved-reference-${width}-${theme}-de.png`), fullPage: true });
          await reference.focus('.band .glassorb'); await new Promise(resolve => setTimeout(resolve, 2200));
          await reference.screenshot({ path: join(evidence, `approved-reference-reveal-${width}-${theme}-de.png`), fullPage: true });
        }
        await reference.close();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    t.diagnostic(`AIT-131 display ${section}: Round-2 state and footer screenshots; ${files.length} files written.`);
}
