// AIT-132: deterministic contract fixtures, real component, keyboard and voice client. Remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';

async function browserPath() {
  const paths = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name)))];
  for (const path of paths) { try { await access(path, constants.X_OK); return path; } catch { /* remote runner */ } }
  throw new Error('No browser available on the remote test runner');
}
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const controls = ['textarea', '.attach', '.send'];
const boxes = page => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), controls);
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shown = page => shadow(page, c => Boolean(c.shadowRoot.querySelector('.qcard:not([hidden])')));
const still = (before, after, label) => assert.deepEqual(after, before, `${label}: composer controls shift exactly 0 px`);

test('AIT-132: approved card, hover, focus and fold at 1440/390, light/dark, DE/EN; mouse, keyboard, voice and zero layout shift',
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-qcard-'));
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    });
    t.after(() => demo.kill());
    const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    t.after(() => browser.close());
    const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
    if (evidence) await mkdir(evidence, { recursive: true });
    // Snapshots model approved reply data; local acknowledgements let us inspect the exact request bytes.
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/events')) { await request.respond({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }); return; }
        if (path.endsWith('/turns') && request.method() === 'POST') {
          const body = JSON.parse(request.postData());
          const event = await shadow(page, (c, body) => {
            globalThis.qcardRequests.push(body);
            return { seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content,
              ...(body.voiceCallId ? { voiceCallId: body.voiceCallId } : {}) } };
          }, body);
          await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(event) }); return;
        }
        await request.continue();
      })().catch(error => { globalThis.interceptionError = error; });
    });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
    await shadow(page, c => { globalThis.qcardSeed = c.session; });

    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await t.test(`${locale}/${theme}/${width}`, async () => {
        const label = `${locale}-${theme}-${width}`;
        await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
        await page.select('#theme', theme);
        await page.evaluate(async locale => {
          const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
          const { inputRevision } = await import('/packages/core/src/session.js');
          const { voiceEvents } = await import('/packages/core/src/live-voice.js');
          const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
          const { paintUtilities } = await import('/demo/page-preferences.js');
          const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.qcardSeed), copy = { en, de }[locale];
          const deLocale = locale === 'de';
          session.locale = locale; session.seq = 1; session.inputRevision = 1; session.settings.origin = 'chosen';
          session.transcript = [{ id: 'source', role: 'user', content: deLocale ? 'Eine Website für unsere handgestickten Polster.' : 'A website for our hand-embroidered cushions.' }];
          session.featureMatrix.best = { text: { available: true }, voice: { available: true }, analysis: { available: true } };
          session.understanding = { ...session.understanding, inputRevision: inputRevision(session), draft: false,
            summary: deLocale ? 'Handgestickte Polster sollen online bestellt werden können.' : 'Hand-embroidered cushions should be available to order online.',
            openQuestions: [deLocale ? 'Sollen Kundinnen und Kunden selbst wählen können?' : 'Should customers be able to choose for themselves?'] };
          globalThis.qcardRequests = []; globalThis.qcardCommands = []; globalThis.qcardVoiceEvents = voiceEvents();
          globalThis.qcardCopy = copy;
          c.configure({ copy, session, voiceClient: { manifest, async start({ callId }) {
            globalThis.qcardCallId = callId;
            return { callId, providerSessionId: 'qcard-browser', events: globalThis.qcardVoiceEvents,
              async setInput(on) { globalThis.qcardCommands.push(['input', on]); }, async setOutput() {},
              async updateContext(context) { globalThis.qcardCommands.push(['context', context]); },
              async sendText(text) { globalThis.qcardCommands.push(['text', text]); },
              async close() { globalThis.qcardVoiceEvents.end(); return { closureConfirmed: true }; } };
          } } });
          globalThis.qcardReply = {
            content: deLocale ? 'Sollen Kundinnen und Kunden Motiv, Farbe und Größe selbst wählen, oder fertige Polster kaufen?' : 'Should customers choose the design, colour and size themselves, or buy finished cushions?',
            question_short: deLocale ? 'Motiv, Farbe und Größe selbst wählen, oder fertige Polster kaufen?' : 'Choose the design, colour and size, or buy finished cushions?',
            options: [
              { text: deLocale ? 'Nur fertige Polster aus einer Auswahl' : 'Only finished cushions from a selection' },
              { text: deLocale ? 'Selbst wählen: Motiv, Farbe, Größe' : 'Choose the design, colour and size', likely: true },
              { text: deLocale ? 'Beides' : 'Both' },
            ],
          };
          globalThis.showQuestion = patch => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
            id: `question-${c.session.seq}`, role: 'assistant', inputRevision: inputRevision(c.session), ...globalThis.qcardReply, ...patch,
          } });
          document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
          c.shadowRoot.querySelector('textarea').scrollIntoView({ block: 'end', behavior: 'instant' });
        }, locale);
        await page.mouse.move(0, 0); await nextFrame(page);
        const baseline = await boxes(page);
        await page.evaluate(() => globalThis.showQuestion({ options: [] })); await nextFrame(page);
        assert.equal(await shown(page), false, 'a question without answers has no card'); still(baseline, await boxes(page), 'no options');
        await page.evaluate(() => globalThis.showQuestion()); await nextFrame(page);
        assert.equal(await shown(page), true, 'the card renders only from a final reply with answers');
        still(baseline, await boxes(page), 'appearance');
        const geometry = await shadow(page, c => {
          const root = c.shadowRoot, card = root.querySelector('.qcard'), composer = root.querySelector('.composer');
          const r = card.getBoundingClientRect(), f = composer.getBoundingClientRect(), rows = [...card.querySelectorAll('.qopt')];
          return { card: [r.x, r.y, r.width, r.height], dockGap: f.top - r.bottom,
            radii: [getComputedStyle(card).borderTopLeftRadius, getComputedStyle(card).borderBottomLeftRadius,
              getComputedStyle(composer).borderTopLeftRadius, getComputedStyle(composer).borderBottomLeftRadius],
            heading: root.querySelector('.qhead').textContent, hint: root.querySelector('.qhint').textContent,
            texts: rows.map(row => row.querySelector('.t').textContent), likely: rows.map(row => row.classList.contains('likely')),
            arrows: rows.map(row => { const b = row.querySelector('.go').getBoundingClientRect(); return [b.width, b.height]; }),
            arrowFills: rows.map(row => getComputedStyle(row.querySelector('.go')).backgroundColor),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.equal(geometry.dockGap, 0); assert.deepEqual(geometry.radii, ['18px', '0px', '0px', '18px']);
        assert.deepEqual(geometry.likely, [true, false, false]); assert.ok(geometry.arrows.every(arrow => arrow[0] === 30 && arrow[1] === 30));
        assert.equal(geometry.heading, locale === 'de' ? 'Offene Frage' : 'Open question');
        assert.equal(geometry.horizontalOverflow, false); assert.notEqual(geometry.arrowFills[0], geometry.arrowFills[1]);
        const shot = async state => { if (evidence) {
          const file = `ait-132-${label}-${state}.png`; await page.screenshot({ path: join(evidence, file), fullPage: true }); files.push(file);
        } };
        await shot('card');
        const point = await shadow(page, c => { const b = c.shadowRoot.querySelectorAll('.qopt')[1].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
        await page.mouse.move(...point); await nextFrame(page);
        const hoverFill = await shadow(page, c => getComputedStyle(c.shadowRoot.querySelectorAll('.qopt .go')[1]).backgroundColor);
        assert.equal(hoverFill, geometry.arrowFills[0]); still(baseline, await boxes(page), 'hover'); await shot('hover');
        await page.mouse.move(0, 0); await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        await page.keyboard.press('Tab'); await nextFrame(page);
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelectorAll('.qopt')[1]), true);
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement.matches(':focus-visible')), true);
        assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.activeElement.querySelector('.go')).backgroundColor), geometry.arrowFills[0]);
        still(baseline, await boxes(page), 'focus'); await shot('focus');

        // Real keyboard activation: no synthetic click handler or custom key event stands in for the browser.
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => globalThis.qcardRequests.length === 1 && document.querySelector('aithema-session').session.transcript.at(-1).role === 'user');
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'Enter disappearance');
        assert.equal(await page.evaluate(() => globalThis.qcardRequests[0].content), geometry.texts[1]);
        await page.evaluate(() => globalThis.showQuestion());
        await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        await page.keyboard.press('Space');
        await page.waitForFunction(() => globalThis.qcardRequests.length === 2 && document.querySelector('aithema-session').session.transcript.at(-1).role === 'user');
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'Space disappearance');
        assert.equal(await page.evaluate(() => globalThis.qcardRequests[1].content), geometry.texts[0]);
        await page.evaluate(() => globalThis.showQuestion());
        await shadow(page, c => c.shadowRoot.querySelector('.fold').click()); await nextFrame(page); await shot('fold');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.fold-question').textContent), locale === 'de' ? 'Offene Frage · Ausklappen' : 'Open question · Unfold');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.fold-question').hidden), false);
        await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click()); await nextFrame(page);
        still(baseline, await boxes(page), 'unfold');

        await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
        assert.equal(await shown(page), true, 'speaking can start while the card is open');
        await shadow(page, c => c.shadowRoot.querySelector('.qopt').click());
        await page.waitForFunction(() => globalThis.qcardCommands.some(([name]) => name === 'text'));
        assert.equal(await shown(page), false); assert.equal(await page.evaluate(() => globalThis.qcardCommands.filter(([name]) => name === 'text').length), 1);
        assert.equal(await page.evaluate(() => globalThis.qcardRequests[2].content), geometry.texts[0]);
        await page.evaluate(() => { globalThis.showQuestion(); globalThis.qcardVoiceEvents.push({ type: 'partial', callId: globalThis.qcardCallId, role: 'user', text: 'Both' }); });
        await nextFrame(page); assert.equal(await shown(page), true);
        await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
          id: 'spoken-answer', role: 'user', content: 'Both', callId: globalThis.qcardCallId, providerSessionId: 'qcard-browser',
        } }));
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'spoken answer disappearance');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').dataset.call), 'active');
        await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
        checks.push({ locale, theme, width, geometry, controlShiftPx: 0, requests: await page.evaluate(() => globalThis.qcardRequests) });
      });
    }
    if (globalThis.interceptionError) throw globalThis.interceptionError;
    if (evidence) await writeFile(join(evidence, 'ait-132-evidence.json'), JSON.stringify({ ticket: 'AIT-132',
      commit: process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1], files, checks }, null, 2));
  });
