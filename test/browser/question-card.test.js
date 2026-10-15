// AIT-132: deterministic contract fixtures, real component, keyboard and voice client. Remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';

import { browserPath } from '../../scripts/install-test-browser.js';
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const controls = ['textarea', '.attach', '.send', '.composer'];
const boxes = (page, selectors = controls) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shown = page => shadow(page, c => Boolean(c.shadowRoot.querySelector('.qcard:not([hidden])')));
const still = (before, after, label) => assert.deepEqual(after, before, `${label}: composer controls shift exactly 0 px`);

test('AIT-132: approved card, hover, focus, fold and no card at 1440/1024/390, light/dark, DE/EN; mouse, keyboard, voice and zero layout shift',
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
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/events')) { await request.respond({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }); return; }
        // The finite SSE fixture reconnects and refreshes capabilities. Its
        // snapshot must share the fixture's state, rather than overwrite it with
        // the no-provider server's different capabilities at a matching seq.
        if (/^\/api\/sessions\/[^/]+$/u.test(path) && request.method() === 'GET') {
          const snapshot = await page.evaluate(() => globalThis.qcardSeed ? document.querySelector('aithema-session').session : null);
          if (snapshot) { await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }); return; }
        }
        if (path.endsWith('/turns') && request.method() === 'POST') {
          const body = JSON.parse(request.postData());
          if (globalThis.qcardAnswerHold) await globalThis.qcardAnswerHold.promise;
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

    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390, 393]) {
      await t.test(`${locale}/${theme}/${width}`, async () => {
        const label = `${locale}-${theme}-${width}`;
        const shot = async state => { if (evidence) {
          if (state !== 'bounded-options' || width === 1024 || width !== 390 && theme !== (locale === 'en' ? 'light' : 'dark')) return;
          await page.mouse.move(-1, -1);
          await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
          await nextFrame(page);
          const file = `ait-225-${label}-${state}.png`; await page.screenshot({ path: join(evidence, file), fullPage: false }); files.push(file);
        } };
        await page.setViewport({ width, height: width === 390 ? 844 : width === 393 ? 852 : 900 });
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
          const events = globalThis.qcardVoiceEvents, commands = globalThis.qcardCommands;
          c.configure({ copy, session, voiceClient: { manifest, async start({ callId }) {
            globalThis.qcardCallId = callId;
            return { callId, providerSessionId: 'qcard-browser', events,
              async setInput(on) { commands.push(['input', on]); }, async setOutput() {},
              async updateContext(context) { commands.push(['context', context]); },
              async sendText(text) { commands.push(['text', text]); },
              async close() { events.end(); return { closureConfirmed: true }; } };
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
          // Pin the existing Chrome baseline stack for every scene and capture.
          document.documentElement.style.setProperty('--ui', 'ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif');
          c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
          c.shadowRoot.querySelector('.send').scrollIntoView({ block: 'end', behavior: 'instant' });
        }, locale);
        await page.mouse.move(0, 0); await nextFrame(page);
        await page.evaluate(() => document.fonts.ready);
        const baseline = await boxes(page);
        await page.evaluate(() => globalThis.showQuestion({ options: [] })); await nextFrame(page);
        assert.equal(await shown(page), false, 'a question without answers has no card'); still(baseline, await boxes(page), 'no options');
        await shot('no-card');
        await page.evaluate(() => globalThis.showQuestion()); await nextFrame(page);
        assert.equal(await shown(page), true, 'the card renders only from a final reply with answers');
        still(baseline, await boxes(page), 'appearance');
        const docked = await boxes(page, ['.qcard', '.composer']);
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
        await shot('card');
        const point = await shadow(page, c => { const b = c.shadowRoot.querySelectorAll('.qopt')[1].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
        await page.mouse.move(...point); await nextFrame(page);
        const hoverFill = await shadow(page, c => getComputedStyle(c.shadowRoot.querySelectorAll('.qopt .go')[1]).backgroundColor);
        assert.equal(hoverFill, geometry.arrowFills[0]); still(baseline, await boxes(page), 'hover'); await shot('hover');
        assert.deepEqual(await boxes(page, ['.qcard', '.composer']), docked, 'hover: card plus composer move exactly 0 px');
        await page.mouse.move(0, 0); await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        await page.keyboard.press('Tab'); await nextFrame(page);
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelectorAll('.qopt')[1]), true);
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement.matches(':focus-visible')), true);
        assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.activeElement.querySelector('.go')).backgroundColor), geometry.arrowFills[0]);
        still(baseline, await boxes(page), 'focus'); await shot('focus');
        assert.deepEqual(await boxes(page, ['.qcard', '.composer']), docked, 'keyboard focus: card plus composer move exactly 0 px');

        // Real keyboard activation: no synthetic click handler or custom key event stands in for the browser.
        assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('.qopt')[1].disabled), false, 'fixture text capability stays enabled through reconnects');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => globalThis.qcardRequests.length === 1 && document.querySelector('aithema-session').session.transcript.at(-1).role === 'user');
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'Enter disappearance');
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'Enter returns focus to the composer');
        assert.equal(await page.evaluate(() => globalThis.qcardRequests[0].content), geometry.texts[1]);
        await page.evaluate(() => globalThis.showQuestion());
        await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        await page.keyboard.press('Space');
        await page.waitForFunction(() => globalThis.qcardRequests.length === 2 && document.querySelector('aithema-session').session.transcript.at(-1).role === 'user');
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'Space disappearance');
        assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'Space returns focus to the composer');
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
        await page.evaluate(() => { globalThis.showQuestion(); globalThis.qcardVoiceEvents.push({ type: 'partial', turnId: 'spoken-answer', callId: globalThis.qcardCallId, role: 'user', text: 'Both' }); });
        await nextFrame(page); assert.equal(await shown(page), true);
        await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
          id: 'spoken-answer', role: 'user', content: 'Both', callId: globalThis.qcardCallId, providerSessionId: 'qcard-browser',
        } }));
        assert.equal(await shown(page), false); still(baseline, await boxes(page), 'spoken answer disappearance');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').dataset.call), 'active');
        await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
        // A long, overflowing transcript and option list exercise the actual phone limit.
        await page.evaluate(() => {
          const c = document.querySelector('aithema-session'), de = c.session.locale === 'de';
          for (let index = 0; index < 14; index++) globalThis.showQuestion({ options: [],
            content: de ? `Antwort ${index}: Motiv und Farbe können frei gewählt werden.` : `Reply ${index}: the design and colour can be chosen freely.` });
          globalThis.showQuestion({ options: Array.from({ length: 7 }, (_, index) => ({
            text: de ? `Auswahl ${index + 1}: Motiv, Farbe und Größe selbst zusammenstellen` : `Choice ${index + 1}: choose the design, colour and size yourself`, likely: index === 0,
          })) });
        });
        await nextFrame(page);
        const bounded = await shadow(page, c => {
          const r = c.shadowRoot, card = r.querySelector('.qcard'), opts = r.querySelector('.qopts');
          const bubble = [...r.querySelectorAll('.turn:not(.user)')].at(-1).getBoundingClientRect();
          const shell = r.querySelector('.transcript-shell').getBoundingClientRect(), b = card.getBoundingClientRect();
          return { height: b.height, viewport: innerHeight, top: b.top, bubbleBottom: bubble.bottom, shellBottom: shell.bottom,
            overflow: opts.scrollHeight > opts.clientHeight, role: opts.getAttribute('role'),
            name: r.querySelector(`#${opts.getAttribute('aria-labelledby')}`)?.textContent };
        });
        if (width <= 600) assert.ok(bounded.height <= .36 * bounded.viewport, `AIT-225: phone card ${bounded.height}px exceeds 36vh`);
        assert.ok(bounded.bubbleBottom <= bounded.top, `AIT-225: latest assistant bubble ${bounded.bubbleBottom} ends behind card ${bounded.top}`);
        assert.ok(bounded.shellBottom <= bounded.top, 'AIT-225: the transcript viewport ends above the card');
        assert.equal(bounded.overflow, true, 'the options scroll inside the card');
        assert.equal(bounded.role, 'region'); assert.ok(bounded.name, 'the options scroll region has an accessible name');
        await shot('bounded-options');
        const answerBoxes = await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']);
        await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        for (let index = 1; index < 7; index++) {
          await page.keyboard.press('Tab'); await nextFrame(page);
          const focus = await shadow(page, (c, index) => {
            const r = c.shadowRoot, row = r.querySelectorAll('.qopt')[index], b = row.getBoundingClientRect(), v = r.querySelector('.qopts').getBoundingClientRect();
            return { correct: r.activeElement === row, visible: row.matches(':focus-visible'), inside: b.top >= v.top - 1 && b.bottom <= v.bottom + 1 };
          }, index);
          assert.deepEqual(focus, { correct: true, visible: true, inside: true }, 'Tab reaches each option in order and scrolls it into view');
        }
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); c.shadowRoot.querySelector('.qopts').scrollTop = 0; }); await nextFrame(page);
        const first = await shadow(page, c => { const b = c.shadowRoot.querySelector('.qopt').getBoundingClientRect(); return [b.x + 20, b.y + b.height / 2]; });
        await page.mouse.move(...first); await nextFrame(page);
        assert.deepEqual(await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']), answerBoxes, 'hover never moves the card, options or composer');
        globalThis.qcardAnswerHold = Promise.withResolvers();
        await page.mouse.click(...first); await nextFrame(page);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qopt').getAttribute('aria-disabled')), 'true');
        assert.deepEqual(await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']), answerBoxes, 'answering never moves the other options or composer');
        globalThis.qcardAnswerHold.resolve(); globalThis.qcardAnswerHold = null;
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.qcard').hidden);
        await nextFrame(page); still(baseline, await boxes(page), 'long answer disappearance');
        const closed = await shadow(page, c => {
          const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
          return { gap: shell.scrollHeight - shell.clientHeight - shell.scrollTop,
            bubble: [...r.querySelectorAll('.turn:not(.user)')].at(-1).getBoundingClientRect().bottom,
            composer: r.querySelector('.composer').getBoundingClientRect().top };
        });
        assert.ok(Math.abs(closed.gap) <= 1, 'removing the card keeps the transcript following its latest turn');
        assert.ok(closed.bubble <= closed.composer, 'the latest assistant reply remains above the composer after answering');
        checks.push({ locale, theme, width, geometry, bounded, closed, controlShiftPx: 0, requests: await page.evaluate(() => globalThis.qcardRequests) });
      });
    }
    if (globalThis.interceptionError) throw globalThis.interceptionError;
    if (evidence) {
      const commit = process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1];
      await writeFile(join(evidence, 'ait-225-evidence.json'), JSON.stringify({ ticket: 'AIT-225', commit, files, checks }, null, 2));
      await writeFile(join(evidence, 'ait-225-pass-lines.json'), JSON.stringify({ ticket: 'AIT-225', commit,
        passLines: checks.map(({ locale, theme, width, controlShiftPx }) => ({ locale, theme, width, pass: true,
          states: ['card-with-likely-and-others', 'hover', 'keyboard-focus', 'fold', 'question-without-options-no-card'],
          foldStrip: locale === 'de' ? 'Offene Frage · Ausklappen' : 'Open question · Unfold',
          composerControlShiftPx: controlShiftPx, cardAndComposerShiftPx: 0, dockGapPx: 0 })) }, null, 2));
    }
  });
