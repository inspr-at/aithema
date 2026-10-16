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
  { timeout: 240_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-qcard-'));
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    });
    t.after(() => demo.kill());
    const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    t.after(() => browser.close());
    const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [], keyboardChecks = [], stabilityChecks = [];
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
        const shot = async (state, height) => { if (evidence) {
          if (!height && (!['card', 'bounded-options'].includes(state) || ![390, 1440].includes(width))) return;
          await page.mouse.move(-1, -1);
          await shadow(page, c => {
            globalThis.qcardShotFocus = c.shadowRoot.activeElement ?? document.activeElement;
            c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
          });
          try {
            await page.evaluate(async () => {
              await document.fonts.ready;
              for (const animation of document.getAnimations()) {
                if (animation.effect?.getComputedTiming().iterations !== Infinity) await animation.finished.catch(() => {});
              }
            });
            await nextFrame(page); await nextFrame(page);
            const file = `ait-225-${label}-${state}.png`;
            await page.screenshot({ path: join(evidence, file), fullPage: false,
              ...(height ? { clip: { x: 0, y: 0, width, height }, captureBeyondViewport: false } : {}) });
            files.push(file);
          } finally {
            await page.evaluate(() => { globalThis.qcardShotFocus?.focus({ preventScroll: true }); delete globalThis.qcardShotFocus; });
          }
        } };
        const rest = () => shadow(page, c => {
          const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), bubble = r.querySelector('.turn:last-child').getBoundingClientRect();
          return { box: [bubble.x, bubble.y, bubble.width, bubble.height], gap: r.querySelector('.qcard').getBoundingClientRect().top - bubble.bottom,
            turnGap: parseFloat(getComputedStyle(shell.querySelector('ol')).rowGap),
            shell: [shell.getBoundingClientRect().top, shell.getBoundingClientRect().bottom, shell.clientHeight, shell.scrollHeight, shell.scrollTop],
            reserve: r.querySelector('.conversation').style.getPropertyValue('--question-card-height'),
            limit: r.querySelector('.qcard').style.getPropertyValue('--question-card-limit'),
            notices: [r.querySelector('.voice-notices').getBoundingClientRect().height, r.querySelector('.voice-notices').style.minHeight],
            startVisible: bubble.top >= shell.getBoundingClientRect().top + parseFloat(getComputedStyle(shell).paddingTop) - 1 };
        });
        const assertRest = async state => {
          if (![390, 1440].includes(width)) return;
          const before = await rest();
          assert.ok(before.startVisible, `${state}: latest reply starts below the fade: ${JSON.stringify(before)}`);
          assert.ok(Math.abs(before.gap - before.turnGap) <= 1.5, `${state}: latest reply/card gap equals the turn gap: ${JSON.stringify(before)}`);
          await shadow(page, c => {
            const shell = c.shadowRoot.querySelector('.transcript-shell');
            shell.dispatchEvent(new Event('scroll'));
            shell.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
            for (const key of ['End', 'PageDown']) shell.dispatchEvent(new KeyboardEvent('keydown', { key }));
          });
          await nextFrame(page);
          assert.deepEqual((await rest()).box, before.box, `${state}: release moves the latest bubble exactly 0 px`);
          return before;
        };
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
          // configure() seeds the component directly; notify the real host too
          // so slotted account/legal copy uses this scene's language.
          c.dispatchEvent(new CustomEvent('aithema-locale'));
          // Pin the existing Chrome baseline stack for every scene and capture.
          document.documentElement.style.setProperty('--ui', 'ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif');
          c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
          c.shadowRoot.querySelector('.send').scrollIntoView({ block: 'end', behavior: 'instant' });
        }, locale);
        await page.mouse.move(0, 0); await nextFrame(page);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.$eval('#demo-account-label', n => n.textContent), locale === 'de' ? 'Konto (Demo)' : 'Account (demo)', 'the host slots use the conversation language');
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
        const cardRest = await assertRest('card');
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
        const boundedRest = await assertRest('bounded-options');
        assert.equal(await shadow(page, c => {
          const r = c.shadowRoot, opts = r.querySelector('.qopts');
          return opts.hasAttribute('data-more-end') === (opts.scrollHeight > opts.clientHeight + 1) && !opts.hasAttribute('data-more-start')
            && getComputedStyle(opts).getPropertyValue('--qfade-end').trim() === (opts.scrollHeight > opts.clientHeight + 1 ? '24px' : '0px')
            && getComputedStyle(r.querySelector('.qopt .t')).fontWeight === getComputedStyle(r.querySelector('.qopt:nth-child(2) .t')).fontWeight;
        }), true, 'options fade only toward more content and the suggestion uses normal text weight');
        await shot('bounded-options');
        const answerBoxes = await boxes(page, ['.qcard', '.qopts', '.qopt', '.qopt:nth-child(2)', '.composer', 'textarea', '.send']);
        const maskBoxes = await boxes(page, ['.qcard', '.qopts', '.composer']);
        await shadow(page, c => { const opts = c.shadowRoot.querySelector('.qopts'); opts.scrollTop = opts.scrollHeight; });
        await nextFrame(page);
        assert.equal(await shadow(page, c => {
          const opts = c.shadowRoot.querySelector('.qopts');
          return opts.hasAttribute('data-more-start') === (opts.scrollTop > 1) && !opts.hasAttribute('data-more-end');
        }), true, 'at the option list end, only the edge toward earlier content fades');
        assert.deepEqual(await boxes(page, ['.qcard', '.qopts', '.composer']), maskBoxes, 'changing option fades moves the layout exactly 0 px');
        await shadow(page, c => { c.shadowRoot.querySelector('.qopts').scrollTop = 0; });
        await nextFrame(page);
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
        // Keep the reader's pointer fixed through release. Leaving the pane
        // separately clears the existing pointer-anchor padding.
        const releaseBefore = await readingBox();
        await shadow(page, c => c.shadowRoot.querySelector('.transcript-shell').dispatchEvent(new Event('scroll')));
        await nextFrame(page);
        assert.deepEqual(await readingBox(), releaseBefore, 'releasing held card space keeps the reading anchor at exactly the same box');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').style.getPropertyValue('--question-card-height')), '0px', 'only the visible card reserves space');
        // Reading anchors survive closing; no retained card band needs a later release.
        await page.mouse.move(-1, -1);
        await page.evaluate(() => globalThis.showQuestion()); await nextFrame(page);
        const bottomPoint = await shadow(page, c => {
          const shell = c.shadowRoot.querySelector('.transcript-shell'); shell.scrollTop = shell.scrollHeight;
          const b = shell.getBoundingClientRect(); return [b.left + 30, b.bottom - 30];
        });
        await nextFrame(page); await page.mouse.move(...bottomPoint);
        const bottomBefore = await boxes(page, ['.turn:last-child']);
        await page.evaluate(() => globalThis.showQuestion({ options: [] })); await nextFrame(page);
        assert.deepEqual(await boxes(page, ['.turn:nth-last-child(2)']), bottomBefore, 'closing at the reading bottom preserves visible text');
        await page.mouse.wheel({ deltaY: 10_000 });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.conversation').style.getPropertyValue('--question-card-height') === '0px');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').style.getPropertyValue('--question-card-height')), '0px', 'reaching the bottom releases the obsolete gap while the pointer stays in the transcript');
        await page.evaluate(async () => { for (let frame = 0; frame < 12; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); });
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').style.getPropertyValue('--question-card-height')), '0px', 'the bottom gap stays released without new content or pointer movement');
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
        if (width === 390) {
          // Emulate a keyboard that changes only visualViewport. The layout
          // viewport stays 390×844, so window.resize cannot drive this check.
          await page.evaluate(() => {
            globalThis.qcardNativeViewport = visualViewport;
            const viewport = new EventTarget(); Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
            const c = document.querySelector('aithema-session'), parent = c.parentNode;
            c.remove(); parent.append(c);
            c.shadowRoot.querySelector('textarea').focus({ preventScroll: true });
          });
          try {
            const heights = [844, 508, ...Array.from({ length: 21 }, (_, index) => 460 + 8 * index), 320, 844];
            for (const height of heights) {
              const samples = await shadow(page, async (c, height) => {
                const card = c.shadowRoot.querySelector('.qcard'), states = [];
                visualViewport.height = height;
                for (let resize = 0; resize < 2; resize++) {
                  visualViewport.dispatchEvent(new Event('resize'));
                  // Settle layout observers, then sample twelve consecutive frames.
                  for (let frame = 0; frame < 14; frame++) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    if (frame >= 2) states.push(card.hasAttribute('data-compact'));
                  }
                }
                return states;
              }, height);
              assert.deepEqual(samples, Array(24).fill(height <= 620), `${locale}/${theme}/390×${height}: explicit compact state stays stable across 12 frames after each of two equal-size resizes`);
              stabilityChecks.push({ locale, theme, height, compact: height <= 620, frames: 24, resizes: 2 });
            }
            for (const height of [508, 420, 320]) {
              await shadow(page, (c, height) => {
                c.shadowRoot.querySelector('textarea').focus({ preventScroll: true });
                visualViewport.height = height; visualViewport.dispatchEvent(new Event('resize'));
              }, height);
              await nextFrame(page); await nextFrame(page);
              const keyboard = await shadow(page, c => {
                const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
                const card = r.querySelector('.qcard').getBoundingClientRect(), opts = r.querySelector('.qopts').getBoundingClientRect();
                const row = r.querySelector('.qopt').getBoundingClientRect(), composer = r.querySelector('.composer').getBoundingClientRect();
                const bubble = [...r.querySelectorAll('.turn:not(.user)')].at(-1).getBoundingClientRect();
                const band = r.querySelector('.band').getBoundingClientRect();
                return { layoutHeight: innerHeight, viewport: visualViewport.height, compact: r.querySelector('.qcard').hasAttribute('data-compact'),
                  rowHeight: row.height, rowTop: row.top, rowBottom: row.bottom, optionsTop: opts.top, optionsBottom: opts.bottom,
                  cardTop: card.top, bubbleTop: bubble.top, bubbleHeight: bubble.height, bubbleBottom: Math.min(bubble.bottom, shell.getBoundingClientRect().bottom), shellTop: shell.getBoundingClientRect().top, shellBottom: shell.getBoundingClientRect().bottom,
                  composerBottom: composer.bottom, bandBottom: band.bottom };
              });
              assert.equal(keyboard.layoutHeight, 844, 'only the visual viewport shrinks');
              assert.equal(keyboard.compact, true, `390×${height}: short keyboard viewports explicitly use compact answers`);
              assert.ok(keyboard.rowHeight >= 44 && keyboard.rowTop >= keyboard.optionsTop - 1 && keyboard.rowBottom <= keyboard.optionsBottom + 1,
                `390×${height}: a full answer stays visible: ${JSON.stringify(keyboard)}`);
              assert.ok(keyboard.rowTop >= Math.max(0, keyboard.bandBottom) && keyboard.rowBottom <= height,
                `390×${height}: the answer is on screen below the band: ${JSON.stringify(keyboard)}`);
              assert.ok(keyboard.bubbleBottom <= keyboard.cardTop && keyboard.shellBottom <= keyboard.cardTop,
                `390×${height}: the latest reply ends above the card: ${JSON.stringify(keyboard)}`);
              if (keyboard.bubbleHeight > keyboard.shellBottom - keyboard.shellTop) assert.ok(keyboard.bubbleTop >= keyboard.shellTop - 1, 'an oversized latest reply shows its start at the top of the compact pane');
              assert.ok(keyboard.bubbleBottom >= keyboard.shellTop + 20, `390×${height}: the latest reply remains visible: ${JSON.stringify(keyboard)}`);
              assert.ok(keyboard.composerBottom <= height && height - keyboard.composerBottom <= 14, 'the composer stays docked to the visible viewport');
              const chips = await shadow(page, c => {
                const r = c.shadowRoot, opts = r.querySelector('.qopts'), first = opts.firstElementChild, b = first.getBoundingClientRect(), v = opts.getBoundingClientRect();
                const input = r.querySelector('textarea'), style = getComputedStyle(input), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
                context.font = style.font;
                return { scrollLeft: opts.scrollLeft, suggestionFirst: first.classList.contains('likely'), fullyVisible: b.left >= v.left && b.right <= v.right,
                  name: first.getAttribute('aria-label'), text: first.querySelector('.t').textContent,
                  ellipsis: getComputedStyle(first.querySelector('.t')).textOverflow,
                  moreStart: opts.hasAttribute('data-more-start'), moreEnd: opts.hasAttribute('data-more-end'), overflows: opts.scrollWidth > opts.clientWidth + 1,
                  fade: getComputedStyle(opts).getPropertyValue('--qfade-end').trim(), placeholder: input.placeholder,
                  placeholderWidth: context.measureText(input.placeholder).width,
                  inputWidth: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
              });
              assert.equal(chips.scrollLeft, 0, `390×${height}: chips enter compact mode at scrollLeft 0`);
              assert.equal(chips.suggestionFirst && chips.fullyVisible, true, `the suggestion is first and fully visible: ${JSON.stringify(chips)}`);
              assert.equal(chips.name, chips.text, 'the accessible name is the full label');
              assert.equal(chips.ellipsis, 'ellipsis');
              assert.equal(chips.moreStart, false); assert.equal(chips.moreEnd, chips.overflows);
              assert.equal(chips.fade, chips.overflows ? '24px' : '0px');
              assert.equal(chips.placeholder, locale === 'de' ? 'Ihre Nachricht …' : 'Your message …');
              assert.ok(chips.placeholderWidth <= chips.inputWidth, 'the compact placeholder fits on one line');
              await shadow(page, c => {
                c.shadowRoot.querySelector('.qopts').scrollLeft = 150;
                c.receive({ type: 'lane.status', data: { inputRevision: c.session.inputRevision, running: ['understanding'] } });
              });
              await nextFrame(page);
              assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qopts').scrollLeft), 0, 'an unrelated re-render resets chips to their suggested first answer');
              await shot(`keyboard-${height}`, height);
              assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'a mid-sequence capture restores composer focus');
              // Shift+Tab from the composer reaches the final answer through
              // the browser's native order and scrolls the chip into view.
              await page.keyboard.down('Shift');
              try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
              await nextFrame(page);
              assert.equal(await shadow(page, c => {
                const r = c.shadowRoot, row = [...r.querySelectorAll('.qopt')].at(-1), b = row.getBoundingClientRect(), v = r.querySelector('.qopts').getBoundingClientRect();
                return r.activeElement === row && b.height >= 44 && b.top >= v.top - 1 && b.bottom <= v.bottom + 1 && b.left >= v.left - 1 && b.right <= v.right + 1;
              }), true, 'Tab reaches an answer and brings its whole target into view');
              // Native focus need only reveal the target; it may leave a few
              // pixels after it. Scroll fully to the edge to check that mask.
              await shadow(page, c => { const opts = c.shadowRoot.querySelector('.qopts'); opts.scrollLeft = opts.scrollWidth; });
              await nextFrame(page);
              const endMask = await shadow(page, c => {
                const opts = c.shadowRoot.querySelector('.qopts');
                return { start: opts.hasAttribute('data-more-start'), end: opts.hasAttribute('data-more-end'),
                  offset: opts.scrollLeft, max: opts.scrollWidth - opts.clientWidth, compact: c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact') };
              });
              assert.ok(endMask.start && !endMask.end, `390×${height}: at the final chip only earlier answers fade: ${JSON.stringify(endMask)}`);
              keyboardChecks.push({ locale, theme, width, height, ...keyboard, chips, reachableByTab: true });

            }
            for (const height of [320, 844]) {
              await shadow(page, (c, height) => {
                visualViewport.height = height; visualViewport.dispatchEvent(new Event('resize'));
                globalThis.showQuestion();
              }, height);
              await nextFrame(page); await nextFrame(page);
              const beforeClose = await boxes(page);
              assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), height === 320);
              await page.evaluate(() => globalThis.showQuestion({ options: [] }));
              await nextFrame(page); await nextFrame(page);
              still(beforeClose, await boxes(page), `390×${height}: close in ${height === 320 ? 'compact' : 'full'} mode`);
            }
            // At one fixed viewport a longer question can require chips. That
            // content decision must never resize or move the input underneath.
            await shadow(page, () => {
              visualViewport.height = 728; visualViewport.dispatchEvent(new Event('resize'));
              globalThis.showQuestion({ question_short: 'Choose?' });
            });
            await nextFrame(page); await nextFrame(page);
            const beforeModeChange = await boxes(page);
            assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), false, '390×728: a short question fits the full card');
            await page.evaluate(() => globalThis.showQuestion({ question_short: (globalThis.qcardReply.question_short + ' ').repeat(4) }));
            await nextFrame(page); await nextFrame(page);
            assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), true, '390×728: a longer question needs compact answers');
            still(beforeModeChange, await boxes(page), 'full-to-compact content change at the same viewport');
            await page.evaluate(() => globalThis.showQuestion({ question_short: 'Choose?' }));
            await nextFrame(page); await nextFrame(page);
            assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), false);
            still(beforeModeChange, await boxes(page), 'compact-to-full content change at the same viewport');
          } finally {
            await page.evaluate(() => {
              const c = document.querySelector('aithema-session'), parent = c.parentNode; c.remove();
              Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.qcardNativeViewport });
              parent.append(c);
            });
            await nextFrame(page);
          }
        }
        if ([390, 1440].includes(width)) {
          await page.evaluate(() => globalThis.showQuestion({ content: (globalThis.qcardReply.content + ' ').repeat(30) }));
          await shadow(page, c => c.shadowRoot.querySelector('.transcript-latest').click());
          await nextFrame(page); await nextFrame(page);
          const oversized = await shadow(page, c => {
            const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), row = r.querySelector('.turn:last-child'), button = row.querySelector('.turn-read-full');
            const b = row.getBoundingClientRect(), s = shell.getBoundingClientRect(), a = button?.getBoundingClientRect();
            return { top: b.top, expectedTop: s.top + parseFloat(getComputedStyle(shell).paddingTop),
              link: button?.textContent, visible: button && !button.hidden && a.top >= s.top && a.bottom <= s.bottom + 1 };
          });
          assert.ok(Math.abs(oversized.top - oversized.expectedTop) <= 1, `an oversized reply starts below the fade: ${JSON.stringify(oversized)}`);
          assert.equal(oversized.link, locale === 'de' ? 'Ganze Antwort lesen' : 'Read full reply');
          assert.equal(oversized.visible, true, 'the full-reply action stays visible while a long reply is top-aligned');
          await shadow(page, c => c.shadowRoot.querySelector('.turn:last-child .turn-read-full').click());
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-dialog').open && c.shadowRoot.querySelector('.voice-reply-text').textContent === c.session.transcript.at(-1).content), true, 'the full-reply action opens the exact complete answer');
          await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-dialog').close());
        }
        checks.push({ locale, theme, width, geometry, cardRest, boundedRest, bounded, closed, controlShiftPx: 0, requests: await page.evaluate(() => globalThis.qcardRequests) });
      });
    }
    if (globalThis.interceptionError) throw globalThis.interceptionError;
    if (evidence) {
      assert.equal(files.length, 28, 'sixteen card/bounded and twelve keyboard viewport captures are required');
      const commit = process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1];
      await writeFile(join(evidence, 'index.md'), `# AIT-225 round 4 — head ${commit}\n\nViewport captures; reduced motion, pinned baseline fonts, blur before every shot, focus restored after each shot.\n\n${files.map(file => `- [${file}](${file})`).join('\n')}\n\nPass lines: [ait-225-pass-lines.json](ait-225-pass-lines.json) · metadata: [ait-225-evidence.json](ait-225-evidence.json)\n`);
      await writeFile(join(evidence, 'ait-225-evidence.json'), JSON.stringify({ ticket: 'AIT-225', commit, files, checks, keyboardChecks, stabilityChecks }, null, 2));
      await writeFile(join(evidence, 'ait-225-pass-lines.json'), JSON.stringify({ ticket: 'AIT-225', commit,
        stabilityPassLines: stabilityChecks.map(check => ({ ...check, viewport: `390×${check.height}`, pass: true })),
        keyboardPassLines: keyboardChecks.map(({ locale, theme, height, rowHeight, cardTop, bubbleBottom, shellBottom, chips }) => ({
          locale, theme, viewport: `390×${height}`, pass: true, answerHeightPx: rowHeight, reachableByTab: true, chips,
          latestReplyClearancePx: cardTop - bubbleBottom, transcriptClearancePx: cardTop - shellBottom })),
        passLines: checks.map(({ locale, theme, width, controlShiftPx, bounded, cardRest, boundedRest }) => ({ locale, theme, width, pass: true,
          states: ['card-with-likely-and-others', 'hover', 'keyboard-focus', 'fold', 'question-without-options-no-card'],
          foldStrip: locale === 'de' ? 'Offene Frage · Ausklappen' : 'Open question · Unfold',
          composerControlShiftPx: controlShiftPx, cardAndComposerShiftPx: 0, dockGapPx: 0, pendingAnswerOptionShiftPx: 0,
          readingAnchorShiftPx: 0, readingAnchorReleaseShiftPx: 0, cardRest, boundedRest, releaseShiftPx: 0, cardVh: 100 * bounded.height / bounded.viewport,
          latestReplyClearancePx: bounded.top - bounded.bubbleBottom, transcriptClearancePx: bounded.top - bounded.shellBottom })) }, null, 2));
    }
  });
