// AIT-225: bounded dock, real component, deterministic replies, keyboard and voice. Remote runner only.
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

test('AIT-225: bounded question card at 1440/1024/800/390/393, light/dark, DE/EN; transcript clearance, keyboard, voice and zero target movement',
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

    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 800, 390, 393]) {
      await t.test(`${locale}/${theme}/${width}`, async () => {
        const label = `${locale}-${theme}-${width}`;
        const shot = async state => { if (evidence) {
          if (state !== 'bounded-options' || ![390, 393, 1440].includes(width) || width !== 390 && theme !== (locale === 'en' ? 'light' : 'dark')) return;
          await page.mouse.move(0, 0); await page.mouse.move(-1, -1);
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
        // Begin this independent layout scenario following the transcript,
        // after the preceding voice fixture has finished its notice updates.
        await page.mouse.move(0, 0); await page.mouse.move(-1, -1);
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); c.shadowRoot.querySelector('.transcript-latest').click(); });
        await nextFrame(page);
        // A long, overflowing transcript and option list exercise the actual phone limit.
        await page.evaluate(() => {
          const c = document.querySelector('aithema-session'), de = c.session.locale === 'de';
          for (let index = 0; index < 14; index++) globalThis.showQuestion({ options: [],
            content: de ? `Antwort ${index}: Motiv und Farbe können frei gewählt werden.` : `Reply ${index}: the design and colour can be chosen freely.` });
          const answers = de ? [
            'Motiv, Farbe und Größe selbst zusammenstellen und danach den passenden Polster bestellen',
            'Nur fertige Polster aus einer Auswahl kaufen, ohne das Motiv oder die Farbe zu verändern',
            'Beides anbieten: fertige Polster kaufen oder einen eigenen Polster zusammenstellen',
            'Noch nicht entschieden: zuerst die verschiedenen Möglichkeiten miteinander vergleichen',
          ] : [
            'Choose the design, colour and size yourself, then order the cushion that suits your home',
            'Buy only finished cushions from a selection, without changing their design or colour',
            'Offer both: buy finished cushions or put together your own design, colour and size',
            'Not decided yet: first compare the different ways customers could choose their cushions',
          ];
          globalThis.showQuestion({ options: answers.map((text, index) => ({
            text: text + (de ? '. Verfügbarkeit und Lieferzeit können vor der Bestellung geprüft werden.'
              : '. Availability and delivery details can be checked before placing an order.'), likely: index === 0,
          })) });
        });
        await nextFrame(page);
        const bounded = await shadow(page, c => {
          const r = c.shadowRoot, card = r.querySelector('.qcard'), opts = r.querySelector('.qopts');
          const bubble = [...r.querySelectorAll('.turn:not(.user)')].at(-1).getBoundingClientRect();
          const shell = r.querySelector('.transcript-shell').getBoundingClientRect(), b = card.getBoundingClientRect();
          return { height: b.height, viewport: innerHeight, top: b.top, bubbleBottom: bubble.bottom, shellBottom: shell.bottom, shellTop: shell.top,
            scrollTop: r.querySelector('.transcript-shell').scrollTop, scrollHeight: r.querySelector('.transcript-shell').scrollHeight, clientHeight: r.querySelector('.transcript-shell').clientHeight,
            textContained: [...opts.children].every(row => {
              const b = row.getBoundingClientRect(), text = row.querySelector('.t').getBoundingClientRect();
              return b.height >= 44 && text.top >= b.top - 1 && text.bottom <= b.bottom + 1;
            }),
            overflow: opts.scrollHeight > opts.clientHeight, role: opts.getAttribute('role'),
            name: r.querySelector(`#${opts.getAttribute('aria-labelledby')}`)?.textContent };
        });
        if (width <= 600) assert.ok(bounded.height <= .36 * bounded.viewport, `AIT-225: phone card ${bounded.height}px exceeds 36vh`);
        assert.ok(bounded.bubbleBottom <= bounded.top, `AIT-225: latest reply/card geometry ${JSON.stringify(bounded)}`);
        assert.ok(bounded.shellBottom <= bounded.top, 'AIT-225: the transcript viewport ends above the card');
        assert.ok(bounded.bubbleBottom > bounded.shellTop + 26, `AIT-225: the latest reply is visible inside the transcript viewport: ${JSON.stringify(bounded)}`);
        if (width <= 600) assert.equal(bounded.overflow, true, `the options scroll inside the capped phone card: ${JSON.stringify(bounded)}`);
        assert.equal(bounded.textContained, true, 'long answer text stays inside its own 44px-or-taller row');
        assert.equal(bounded.role, 'region'); assert.ok(bounded.name, 'the options scroll region has an accessible name');
        await shot('bounded-options');
        const answerBoxes = await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']);
        await shadow(page, c => c.shadowRoot.querySelector('.qopt').focus({ preventScroll: true }));
        for (let index = 1; index < 4; index++) {
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
        try {
          await page.mouse.click(...first);
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.qopt')?.getAttribute('aria-disabled') === 'true');
          assert.deepEqual(await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']), answerBoxes, 'answering never moves the other options or composer');
        } finally {
          // The pointer must leave before persistence closes the card: otherwise
          // it is now over the transcript and intentionally holds its reading anchor.
          await page.mouse.move(0, 0); await page.mouse.move(-1, -1);
          globalThis.qcardAnswerHold.resolve(); globalThis.qcardAnswerHold = null;
        }
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.qcard').hidden);
        await nextFrame(page); still(baseline, await boxes(page), 'long answer disappearance');
        const closed = await shadow(page, c => {
          const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
          return { gap: shell.scrollHeight - shell.clientHeight - shell.scrollTop,
            bubble: [...r.querySelectorAll('.turn:not(.user)')].at(-1).getBoundingClientRect().bottom,
            composer: r.querySelector('.composer').getBoundingClientRect().top };
        });
        assert.ok(Math.abs(closed.gap) <= 1, `removing the card keeps the transcript following its latest turn: ${JSON.stringify(closed)}`);
        assert.ok(closed.bubble <= closed.composer, 'the latest assistant reply remains above the composer after answering');
        // A question can arrive and be answered elsewhere while an older turn
        // is under the pointer. Its scroll anchor must survive both changes.
        const anchorPoint = await shadow(page, c => {
          const shell = c.shadowRoot.querySelector('.transcript-shell'); shell.scrollTop = 100;
          const bounds = shell.getBoundingClientRect(); return [bounds.left + 30, bounds.top + 65];
        });
        await nextFrame(page); await page.mouse.move(...anchorPoint);
        const readingBefore = await shadow(page, c => {
          const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
          globalThis.qcardAnchor = [...r.querySelectorAll('.turn')].find(row => { const b = row.getBoundingClientRect(); return b.top >= shell.getBoundingClientRect().top + 26; });
          const b = globalThis.qcardAnchor.getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        });
        await page.evaluate(() => globalThis.showQuestion()); await nextFrame(page);
        const readingBox = () => shadow(page, () => { const b = globalThis.qcardAnchor.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
        assert.deepEqual(await readingBox(), readingBefore, 'card appearance preserves the older reply under the pointer');
        await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'other-answer', role: 'user', content: c.session.locale === 'de' ? 'Beides' : 'Both' } }));
        await nextFrame(page);
        assert.deepEqual(await readingBox(), readingBefore, 'card disappearance preserves the older reply under the pointer');
        await page.mouse.move(0, 0); await page.mouse.move(-1, -1);
        await shadow(page, c => c.shadowRoot.querySelector('.transcript-latest').click()); await nextFrame(page);
        if (width <= 600) {
          await page.evaluate(() => globalThis.showQuestion({ question_short: (globalThis.qcardReply.question_short + ' ').repeat(4) }));
          await nextFrame(page);
          const longQuestion = await shadow(page, c => ({
            height: c.shadowRoot.querySelector('.qcard').getBoundingClientRect().height,
            options: c.shadowRoot.querySelector('.qopts').clientHeight, viewport: innerHeight,
          }));
          assert.ok(longQuestion.height <= .36 * longQuestion.viewport && longQuestion.options >= 44,
            'a long question still leaves a reachable answer inside the phone cap');
        }
        checks.push({ locale, theme, width, geometry, bounded, closed, controlShiftPx: 0, requests: await page.evaluate(() => globalThis.qcardRequests) });
      });
    }
    if (globalThis.interceptionError) throw globalThis.interceptionError;
    if (evidence) {
      assert.equal(files.length, 8, 'six phone and two desktop viewport captures are required');
      const commit = process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1];
      await writeFile(join(evidence, 'ait-225-evidence.json'), JSON.stringify({ ticket: 'AIT-225', commit, files, checks }, null, 2));
      await writeFile(join(evidence, 'ait-225-pass-lines.json'), JSON.stringify({ ticket: 'AIT-225', commit,
        passLines: checks.map(({ locale, theme, width, controlShiftPx, bounded }) => ({ locale, theme, width, pass: true,
          states: ['card-with-likely-and-others', 'hover', 'keyboard-focus', 'fold', 'question-without-options-no-card'],
          foldStrip: locale === 'de' ? 'Offene Frage · Ausklappen' : 'Open question · Unfold',
          composerControlShiftPx: controlShiftPx, cardAndComposerShiftPx: 0, dockGapPx: 0, pendingAnswerOptionShiftPx: 0,
          readingAnchorShiftPx: 0, cardVh: 100 * bounded.height / bounded.viewport,
          latestReplyClearancePx: bounded.top - bounded.bubbleBottom, transcriptClearancePx: bounded.top - bounded.shellBottom })) }, null, 2));
    }
  });
