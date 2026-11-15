// AIT-274: one page and one browser; all state-only contracts live in unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';
import { manifest as voiceManifest } from '../../plugins/elevenlabs/src/manifest.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const geometry = page => shadow(page, c => [
  '.understanding', '.questions-heading', '.questions', '.open-questions', '.missing',
  '.understanding > .foot', '.composer-shell', '.band', ...[1, 2, 3].map(i => `.open-question:nth-child(${i})`),
].map(selector => {
  const n = c.shadowRoot.querySelector(selector);
  return [selector, n.offsetLeft, selector === '.band' ? n.getBoundingClientRect().top : n.offsetTop, n.offsetWidth, n.offsetHeight];
})).then(rects => {
  for (const [selector, , , width, height] of rects) assert.ok(width > 0 && height > 0, `${selector}: measured geometry has a positive box`);
  return rects;
});

test('AIT-274 clarify states: 0 px at 1440/1024/390, DE/EN, light/dark, retained focus and one retry', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-clarify-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [], passes = [], shots = [], overviewDiagnostics = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  await shadow(page, c => {
    window.clarifyPosts = [];
    window.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (init.method === 'POST') {
        window.clarifyPosts.push(String(url));
        if (String(url).endsWith('/focus-question')) return new Promise(resolve => { window.releaseFocus = resolve; });
        if (String(url).endsWith('/retry')) return Response.json({ accepted: true });
      }
      return Response.json(c.session);
    };
  });
  const states = ['rest', 'requesting', 'selected', 'asked', 'stale', 'retry', 'refused-paused', 'refused-consent', 'refused-deadline', 'second-requesting', 'second-refused-paused', 'voice-busy-resolved'];
  for (const locale of ['de', 'en']) for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1024, 'light'], ...(evidence ? [[1024, 'dark']] : []), [390, 'light'], ...(evidence ? [[390, 'dark']] : [])]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    for (const state of (theme === 'dark' && width !== 1440 ? ['rest', 'selected', 'stale'] : states)) {
      await shadow(page, async (c, locale, theme, state, manifest) => {
        const { createSession, inputRevision } = await import('/packages/core/src/session.js');
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = createSession({ demo: true, locale });
        session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
        session.transcript = [{ id: 'person', role: 'user', content: locale === 'de' ? 'Wir gleichen rund 400 Rechnungen im Monat von Hand ab.' : 'We reconcile about 400 invoices a month by hand.' },
          { id: 'ordinary', role: 'assistant', content: locale === 'de' ? 'Wer gleicht die Rechnungen heute ab?' : 'Who reconciles the invoices today?', inputRevision: inputRevision(session) }];
        Object.assign(session.understanding, { readinessAssessed: true, draft: false, inputRevision: inputRevision(session),
          summary: locale === 'de' ? 'Drei Personen gleichen rund 400 Rechnungen im Monat von Hand ab; die Freigabe dauert oft eine Woche.' : 'Three people reconcile about 400 invoices a month by hand; approval often takes a week.',
          signals: locale === 'de' ? ['Rund 400 Eingangsrechnungen pro Monat'] : ['About 400 incoming invoices per month'],
          openQuestions: locale === 'de' ? ['Welches Buchhaltungssystem ist im Einsatz?', 'Wer gibt Rechnungen frei, und ab welchem Betrag?', 'Kommen die Rechnungen als PDF oder auf Papier?'] : ['Which accounting system is in use?', 'Who approves invoices, and above what amount?', 'Do invoices arrive as PDF or on paper?'] });
        session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
        c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
        c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
        c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
        let voiceEvents, voiceCallId;
        if (state === 'voice-busy-resolved') {
          const { voiceEvents: createEvents } = await import('/packages/core/src/live-voice.js');
          voiceEvents = createEvents(); session.featureMatrix.best.voice = { available: true };
          c.configure({ session, copy, voiceClient: { manifest, async start(request) {
            voiceCallId = request.callId;
            return { callId: voiceCallId, providerSessionId: 'evidence-voice', events: voiceEvents,
              async setInput() {}, async setOutput() {}, async updateContext() {},
              async close() { voiceEvents.end(); return { closureConfirmed: true }; } };
          } } });
        } else c.configure({ session, copy });
        window.clarifyPosts = [];
        window.clarifyState = async state => {
          const revision = session.operations.inputRevision;
          const receive = (type, data) => c.receive({ seq: c.session.seq + 1, type, data });
          const lane = (running, failures = []) => c.receive({ type: 'lane.status', data: { inputRevision: revision, running, failures, lastFailure: failures.at(-1) ?? null } });
          if (state === 'rest') return;
          const second = state.startsWith('second-');
          if (second) {
            const item = c.openQuestionItems[1];
            const first = c.focusQuestion(item.id);
            window.releaseFocus(Response.json({ accepted: true, event: { seq: c.session.seq + 1, type: 'question.focused', data: {
              ...item, questionId: item.id, requestId: 'first-focus', chosenBy: 'user', inputRevision: revision,
            } } }, { status: 202 }));
            await first;
            receive('turn.final', { id: 'first-reply', role: 'assistant', content: locale === 'de' ? 'Wer gibt Rechnungen frei?' : 'Who approves invoices?', inputRevision: revision, focusRequestId: 'first-focus' });
            lane([]);
          }
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          if (state === 'voice-busy-resolved') {
            c.shadowRoot.querySelector('.voice-start').click();
            while (c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'listening') await frame();
            voiceEvents.push({ type: 'speaking', callId: voiceCallId });
            while (c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'speaking') await frame();
          }
          const button = c.shadowRoot.querySelectorAll('.clarify-action')[second ? 0 : 1]; button.focus({ preventScroll: true });
          window.focusAction = button;
          window.focusPromise = c.focusQuestion(c.openQuestionItems[second ? 0 : 1].id).catch(() => {});
          if (state === 'requesting' || state === 'second-requesting') return;
          if (state === 'voice-busy-resolved') {
            window.releaseFocus(Response.json({ error: 'focus-refused', reason: 'reply-in-flight' }, { status: 409 }));
            await window.focusPromise;
            window.voiceBusyWasRequesting = c.shadowRoot.querySelectorAll('.open-question')[1].dataset.state === 'requesting';
            voiceEvents.push({ type: 'listening', callId: voiceCallId });
            while (c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'listening') await frame();
            await frame(); return;
          }
          if (state === 'stale' || state.startsWith('refused') || state === 'second-refused-paused') {
            const reason = { stale: 'stale-question', 'refused-paused': 'paused', 'second-refused-paused': 'paused', 'refused-consent': 'consent-required', 'refused-deadline': 'not-admitted' }[state];
            if (state.endsWith('refused-paused')) receive('session.paused', { paused: true });
            window.releaseFocus(Response.json({ error: 'focus-refused', reason, ...(state === 'refused-deadline' ? { admissionReason: 'one-hour' } : {}) }, { status: 409 }));
            return window.focusPromise;
          }
          const event = { seq: c.session.seq + 1, type: 'question.focused', data: { question: c.openQuestionItems[1].question,
            questionId: c.openQuestionItems[1].id, requestId: 'focus', chosenBy: 'user', inputRevision: revision } };
          window.releaseFocus(Response.json({ accepted: true, event }, { status: 202 }));
          return window.focusPromise.then(() => {
            lane(['reaction']);
            if (state === 'retry') { lane([], [{ lane: 'reaction', error: 'reasoning-unavailable', retryable: true }]); return; }
            c.receive({ type: 'turn.partial', data: { id: 'focused', delta: locale === 'de' ? 'Wer gibt bei Ihnen Rechnungen frei?' : 'Who approves invoices in your company?', inputRevision: revision } });
            if (state === 'asked') {
              receive('turn.final', { id: 'focused', role: 'assistant', content: locale === 'de' ? 'Wer gibt bei Ihnen Rechnungen frei, und ab welchem Betrag braucht es eine zweite Freigabe?' : 'Who approves invoices in your company, and above what amount is a second approval needed?', inputRevision: revision, focusRequestId: 'focus' });
              lane([]);
            }
          });
        };
      }, locale, theme, state, voiceManifest);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await settle(page); const before = await geometry(page);
      await page.evaluate(state => window.clarifyState(state), state);
      await settle(page);
      assert.deepEqual(await geometry(page), before, `${locale}/${width}/${theme}/${state}: exact 0 px state displacement`);
      const checks = await shadow(page, (c, state) => {
        const rows = [...c.shadowRoot.querySelectorAll('.open-question')], row = rows[state.startsWith('second-') ? 0 : 1], action = row.querySelector('button');
        const retry = c.shadowRoot.querySelector('.retry'), overviewRetry = c.shadowRoot.querySelector('.overview-retry');
        const target = action.getBoundingClientRect(), pseudo = getComputedStyle(action, '::after');
        const line = row.querySelector('.question-state'), text = line.getBoundingClientRect();
        return { itemState: row.dataset.state, previousState: rows[1].dataset.state, voiceBusyWasRequesting: window.voiceBusyWasRequesting, actionEnabled: action.getAttribute('aria-disabled') === 'false', label: action.textContent, focusRetained: c.shadowRoot.activeElement === window.focusAction,
          targetHeight: target.height - parseFloat(pseudo.top) - parseFloat(pseudo.bottom),
          noOverflow: line.scrollWidth <= text.width + 1,
          oneRetry: retry.hidden && overviewRetry.hidden, noDeadlineButtons: rows.every(row => row.querySelector('button').hidden),
          refusalIcon: Boolean(row.querySelector('.question-status svg')),
          metaWrap: c.shadowRoot.querySelector('.clarify-meta-question') ? getComputedStyle(c.shadowRoot.querySelector('.clarify-meta-question')).whiteSpace : null,
          metaCount: c.shadowRoot.querySelectorAll('.clarify-meta').length, title: c.shadowRoot.querySelector('#understanding-title').textContent };
      }, state);
      if (state === 'second-requesting') { assert.equal(checks.itemState, 'requesting'); assert.equal(checks.previousState, 'asked'); assert.equal(checks.focusRetained, true); }
      if (state === 'second-refused-paused') {
        assert.equal(checks.itemState, 'refused'); assert.equal(checks.previousState, 'asked'); assert.equal(checks.actionEnabled, true);
        assert.match(checks.label, locale === 'de' ? /Fortsetzen/ : /Resume/); assert.equal(checks.refusalIcon, true);
      }
      if (state === 'voice-busy-resolved') { assert.equal(checks.voiceBusyWasRequesting, true); assert.equal(checks.itemState, 'requesting'); assert.equal(checks.actionEnabled, false); }
      if (['requesting', 'selected', 'asked'].includes(state)) assert.equal(checks.focusRetained, true, 'keyboard focus stays on the original action');
      if (['rest', 'requesting', 'selected', 'asked'].includes(state)) assert.equal(checks.targetHeight, 44, '44 px pointer target');
      if (state === 'retry') { assert.equal(checks.oneRetry, true); assert.equal(checks.noOverflow, true, 'narrow retry fits the reserved line'); }
      if (state === 'refused-deadline') assert.equal(checks.noDeadlineButtons, true);
      if (['selected', 'asked'].includes(state)) { assert.equal(checks.metaCount, 1); assert.equal(checks.metaWrap, 'nowrap', 'reply meta stays on one ellipsized line'); }
      if (state.startsWith('refused')) assert.equal(checks.refusalIcon, true, 'approved refusal glyph is present');
      if (locale === 'en') assert.equal(checks.title, 'Overview');
      if (['rest', 'selected', 'stale'].includes(state)) {
        const entry = await shadow(page, c => {
          const pane = c.shadowRoot.querySelector('.analysis-content');
          return { scrollTop: pane.scrollTop, topFade: pane.hasAttribute('data-top') };
        });
        assert.deepEqual(entry, { scrollTop: 0, topFade: false }, 'overview starts without clipped content');
      }
      const pass = `AIT-274 GEOMETRY PASS ${locale} ${width} ${theme} ${state}: 0 px; reserved heading/action; focus/target/retry checks passed`;
      passes.push(pass); console.log(pass);
      if (evidence) {
        await shadow(page, (c, state) => {
          const analysis = c.shadowRoot.querySelector('.analysis-content');
          // Rest evidence must show the real entry position, never clipped earlier sections.
          analysis.scrollTop = 0;
          if (innerWidth < 600) {
            const aside = c.shadowRoot.querySelector('.understanding'), band = c.shadowRoot.querySelector('.band');
            aside.scrollIntoView({ block: 'start', behavior: 'instant' });
            window.scrollBy({ top: aside.getBoundingClientRect().top - band.getBoundingClientRect().bottom - 12, behavior: 'instant' });
          }
          c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
        }, state);
        await page.mouse.move(-1, -1); await settle(page);
        if (width === 1440 && ['rest', 'selected', 'stale'].includes(state)) {
          const diagnostics = await shadow(page, c => {
            const root = c.shadowRoot, pane = root.querySelector('.analysis-content');
            const box = n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
            return { scrollTop: pane.scrollTop, topFade: pane.hasAttribute('data-top'), mask: getComputedStyle(pane).maskImage,
              elements: ['.readiness', '.analysis-content', '.summary', '.signals', '.signals li', '.open-questions'].map(selector => {
                const n = root.querySelector(selector), style = getComputedStyle(n);
                return { selector, ...box(n), borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth, hidden: n.hidden };
              }) };
          });
          assert.equal(diagnostics.scrollTop, 0, 'rest/selected/stale capture is unscrolled');
          assert.equal(diagnostics.topFade, false, 'no clipped content in a top fade at rest');
          overviewDiagnostics.push({ locale, theme, state, mode: 'unscrolled overview', ...diagnostics });
          const clip = await shadow(page, c => { const b = c.shadowRoot.querySelector('.understanding').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: 310 }; });
          await page.screenshot({ path: join(evidence, `ait288-after-${locale}-${theme}-${state}-1440-crop.png`), clip, captureBeyondViewport: false });
        }
        const file = `ait288-${locale}-${width}-${theme}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
        shots.push({ file, head: evidenceCommit, theme, locale, state, width, pass, viewportOnly: true, reducedMotion: true, fontsPinned: true, controlsBlurred: true });
        if (state === 'selected' && width === 390) {
          await shadow(page, c => {
            const transcript = c.shadowRoot.querySelector('.transcript-shell'), band = c.shadowRoot.querySelector('.band');
            transcript.scrollIntoView({ block: 'start', behavior: 'instant' });
            window.scrollBy({ top: transcript.getBoundingClientRect().top - band.getBoundingClientRect().bottom - 12, behavior: 'instant' });
          });
          await settle(page);
          const file = `ait288-${locale}-${width}-${theme}-${state}-conversation.png`;
          await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
          shots.push({ file, head: evidenceCommit, theme, locale, state, width, pass, viewportOnly: true, reducedMotion: true, fontsPinned: true, controlsBlurred: true });
        }
      }
      if (['rest', 'selected', 'stale'].includes(state)) {
        const empty = await shadow(page, c => {
          const root = c.shadowRoot, pane = root.querySelector('.analysis-content');
          const boxes = () => ['.understanding', '.readiness', '.understanding > .foot', '.composer-shell', '.band'].map(selector => {
            const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
          });
          const baseline = boxes(), original = structuredClone(c.session.understanding);
          const update = data => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data });
          update({ ...original, summary: '', signals: [] });
          const sections = ['.summary', '.signals-section'].map(selector => {
            const n = root.querySelector(selector); return { hidden: n.hidden, height: n.getBoundingClientRect().height, display: getComputedStyle(n).display };
          });
          const first = [...pane.querySelectorAll(':scope > section')].find(n => !n.hidden);
          const result = { baseline, empty: boxes(), sections, signalRows: root.querySelector('.signals').children.length,
            firstBorder: getComputedStyle(first).borderTopColor, scrollTop: pane.scrollTop };
          update(original); result.arrived = boxes(); return result;
        });
        assert.deepEqual(empty.sections, Array(2).fill({ hidden: true, height: 0, display: 'none' }), 'empty sections have no heading, border or reserved space');
        assert.equal(empty.signalRows, 0, 'no placeholder bullet or ghost text');
        assert.equal(empty.firstBorder, 'rgba(0, 0, 0, 0)', 'only readiness draws the entry divider');
        assert.equal(empty.scrollTop, 0);
        assert.deepEqual(empty.empty, empty.baseline, 'empty content keeps pane, readiness, footer, composer and band at 0 px');
        assert.deepEqual(empty.arrived, empty.baseline, 'content arrival keeps surrounding layout at 0 px');
        const pass = `AIT-288 PASS ${locale} ${width} ${theme} ${state}: empty sections 0 px/no paint; one entry divider; scrollTop=0/no top fade; content arrival surrounding shift 0 px`;
        passes.push(pass); console.log(pass);
      }
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, shots, passes, overviewDiagnostics }, null, 2));
});

// AIT-504: overview status and continuous real-handler paint contracts.
const overviewSelectors = ['.notice', '.summary', '.signals-section', '.open-questions', '.questions', '.missing', '.understanding > .foot', '.composer-shell', '.band'];
async function overviewGeometry(page) {
  return shadow(page, (c, selectors) => selectors.map(selector => {
    const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, r.x, r.y, r.width, r.height];
  }), overviewSelectors);
}
function sameOverviewBoxes(before, after, context) {
  for (let i = 0; i < before.length; i++) {
    assert.ok(before[i][3] > 0 && before[i][4] > 0 && after[i][3] > 0 && after[i][4] > 0, `${context}: positive ${before[i][0]}`);
    for (let j = 1; j < 5; j++) assert.equal(after[i][j] - before[i][j], 0, `${context}: ${before[i][0]} rect ${j}`);
  }
}
async function setupOverviewFixture(page, locale, theme) {
  await shadow(page, async (c, locale, theme) => {
    const { createSession, inputRevision } = await import('/packages/core/src/session.js');
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const session = createSession({ demo: true, locale });
    session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
    session.transcript = [{ id: 'u', role: 'user', content: 'We reconcile invoices by hand.' }, { id: 'a', role: 'assistant', content: 'Which system do you use?', inputRevision: inputRevision(session) }];
    Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
      summary: 'Three people reconcile invoices by hand.', signals: ['400 invoices monthly'], openQuestions: ['Which system do you use?', 'Who approves invoices?'] });
    session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
    window.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      return Response.json(c.session);
    };
    c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ copy, session });
  }, locale, theme);
  await page.mouse.move(0, 0); await settle(page);
  await shadow(page, c => { c.shadowRoot.querySelector('.analysis-content').scrollTop = 0; c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start', behavior: 'instant' }); });
  await settle(page);
}
test('AIT-504 RC24: constant overview slot, positive boxes and five consecutive answers without tab changes', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), rows = [], errors = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  // One injected clock drives every synthetic event and each assessment in this UI fixture.
  await page.evaluate(() => { window.rc24Now = 100_000; const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [window.rc24Now])); } static now() { return window.rc24Now; } }; });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await setupOverviewFixture(page, locale, theme);
    const baseline = await overviewGeometry(page);
    const visible = await shadow(page, c => { const n = c.shadowRoot.querySelector('.notice').getBoundingClientRect(), p = c.shadowRoot.querySelector('.analysis-content').getBoundingClientRect(); return { top: n.top - p.top, bottom: p.bottom - n.bottom, slotWidth: n.width, slotHeight: n.height, paneWidth: p.width, paneHeight: p.height }; });
    assert.ok(visible.slotWidth > 0 && visible.slotHeight > 0 && visible.paneWidth > 0 && visible.paneHeight > 0, 'status and scroll pane have positive boxes');
    assert.ok(visible.top >= 0 && visible.bottom >= 0, `${locale}/${theme}/${width}: status is inside its visible scroll pane`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice-text').textContent), locale === 'en' ? 'Up to date' : 'Auf dem neuesten Stand');
    for (const state of ['pending', 'updating', 'idle', 'current']) {
      await shadow(page, async (c, state) => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        const emit = (type, data) => c.receive({ ...(type === 'lane.status' ? {} : { seq: c.session.seq + 1 }), type, data, at: new Date().toISOString() });
        if (state === 'pending') { emit('turn.final', { id: 'next', role: 'user', content: 'Another detail' }); emit('turn.final', { id: 'next-reply', role: 'assistant', content: 'Thanks', inputRevision: inputRevision(c.session) }); }
        else if (state === 'current') emit('understanding.updated', { ...c.session.understanding, inputRevision: inputRevision(c.session) });
        if (state !== 'pending') emit('lane.status', { inputRevision: inputRevision(c.session), running: state === 'updating' ? ['understanding'] : [], failures: [], lastFailure: null });
      }, state);
      await settle(page); const boxes = await overviewGeometry(page); sameOverviewBoxes(baseline, boxes, `${locale}/${theme}/${width}/${state}`);
      rows.push({ locale, theme, width, state, boxes, maxDelta: 0 });
    }
    for (let i = 1; i <= 5; i++) {
      const result = await shadow(page, async (c, i) => {
        window.rc24Now += 1000;
        const { inputRevision } = await import('/packages/core/src/session.js');
        const emit = (type, data) => c.receive({ ...(type === 'lane.status' ? {} : { seq: c.session.seq + 1 }), type, data, at: new Date().toISOString() });
        emit('turn.final', { id: `answer-${i}`, role: 'user', content: `Answer ${i}` });
        const label = c.shadowRoot.querySelector('.notice-text'), announcement = label.firstChild;
        const copy = (await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale];
        emit('lane.status', { inputRevision: inputRevision(c.session), running: ['reaction'], failures: [], lastFailure: null });
        if (label.textContent !== copy.stale || !c.shadowRoot.querySelector('.overview-retry').hidden) throw new Error('reaction-first status must keep Updating without Retry');
        if (label.firstChild !== announcement) throw new Error('reaction-first status re-announced Updating');
        emit('turn.final', { id: `reply-${i}`, role: 'assistant', content: 'Thank you', inputRevision: inputRevision(c.session) });
        emit('lane.status', { inputRevision: inputRevision(c.session), running: ['understanding'], failures: [], lastFailure: null });
        if (label.firstChild !== announcement) throw new Error('understanding handoff re-announced Updating');
        emit('understanding.updated', { ...c.session.understanding, summary: `Overview ${i}`, progress: { talk: { value: i / 10 }, build: { value: i / 20 } }, inputRevision: inputRevision(c.session) });
        emit('lane.status', { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null });
        return { summary: c.shadowRoot.querySelector('.summary-text').textContent, readiness: c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'), current: c.shadowRoot.querySelector('.understanding').dataset.overview };
      }, i);
      assert.equal(result.summary, `Overview ${i}`); assert.match(result.readiness, new RegExp(`${i * 10}`)); assert.equal(result.current, 'current');
    }
    if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true }); await shadow(page, c => { c.shadowRoot.querySelector('.analysis-content').scrollTop = 0; c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start', behavior: 'instant' }); }); await settle(page); await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `rc24-overview-${locale}-${theme}-${width}.png`), fullPage: false }); }
  }
  assert.deepEqual(errors, []);
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'rc24-overview-rects.json'), JSON.stringify(rows, null, 2));
});

test('AIT-504 real handler/SSE: five typed answers repaint overview and readiness on one focused page', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-sequence-'));
  const fixture = await startChild(new URL('../fixtures/rc24-sequence.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [];
  let snapshotReads = 0;
  page.on('request', request => { if (request.method() === 'GET' && /\/api\/sessions\/[^/?]+$/.test(new URL(request.url()).pathname)) snapshotReads++; });
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  await page.evaluate(() => { window.rc24Now = 1_800_000_000_000; const NativeDate = Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [window.rc24Now])); } static now() { return window.rc24Now; } }; });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await shadow(page, async (c, locale, theme) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = await (await fetch(`/sequence?locale=${locale}`)).json();
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ copy, session });
    }, locale, theme);
    await page.mouse.move(0, 0); await settle(page);
    await shadow(page, c => {
      if (window.rc24Receive) c.receive = window.rc24Receive;
      const receive = c.receive.bind(c); window.rc24Receive = receive;
      c.receive = event => {
        const result = receive(event);
        window.rc24Trace?.push({ type: event.type, running: c.session.operations?.running,
          text: c.shadowRoot.querySelector('.notice-text').textContent,
          retry: !c.shadowRoot.querySelector('.overview-retry').hidden });
        return result;
      };
    });
    let previous = await shadow(page, c => c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'));
    for (let answer = 1; answer <= 5; answer++) {
      const readsBefore = snapshotReads;
      await shadow(page, async (c, answer) => {
        window.rc24Now = (await (await fetch('/clock')).json()).now;
        window.rc24Trace = [];
        const textarea = c.shadowRoot.querySelector('textarea'); textarea.value = `Our project needs workflow step ${answer}.`;
        textarea.dispatchEvent(new Event('input', { bubbles: true })); c.shadowRoot.querySelector('.send').click();
      }, answer);
      await until(page, answer => { const c = document.querySelector('aithema-session'); return c.shadowRoot.querySelector('.summary-text').textContent.includes(`workflow step ${answer}`) && c.shadowRoot.querySelector('.understanding').dataset.overview === 'current'; }, answer);
      const result = await shadow(page, c => ({ summary: c.shadowRoot.querySelector('.summary-text').textContent,
        readiness: c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'),
        revision: c.session.understanding.inputRevision, operations: c.session.operations, sequence: window.rc24Trace }));
      assert.equal(snapshotReads, readsBefore, 'every answer arrives over SSE without the 18-second snapshot fallback');
      const assessment = result.sequence.findIndex(state => state.type === 'understanding.updated');
      assert.ok(assessment >= 0, 'assessment delivered through receive');
      const due = result.sequence.slice(0, assessment);
      assert.ok(due.some(state => state.type === 'lane.status' && state.running.includes('reaction') && !state.running.includes('understanding')), 'real server reaction-first order observed');
      const copy = locale === 'de' ? (await import('../../packages/ui/src/i18n/de.js')).de : (await import('../../packages/ui/src/i18n/en.js')).en;
      for (const state of due) { assert.equal(state.text, copy.stale, `${locale}/${width}/answer ${answer}: ${state.type} keeps Updating`); assert.equal(state.retry, false, 'no idle Retry while understanding is due'); }
      assert.notEqual(result.readiness, previous, `readiness advances after answer ${answer}`); previous = result.readiness;
      assert.equal(result.revision, result.operations.inputRevision); assert.deepEqual(result.operations.running, []);
      records.push({ locale, theme, width, answer, ...result });
    }
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'rc24-five-answers.json'), JSON.stringify(records, null, 2)); }
});

const boxes = (page, omitAction = false) => shadow(page, (c, omitAction) => ['.open-question', '.question-state', '.clarify-action', '.understanding > .foot', '.composer-shell'].filter(selector => !omitAction || selector !== '.clarify-action').map(selector => {
  const b = c.shadowRoot.querySelector(selector).getBoundingClientRect();
  return { selector, x: b.x, y: b.y, width: b.width, height: b.height };
}), omitAction);

test('AIT-503 RC24: bounded row recovery, positive stable controls, EN/DE light/dark 390/1440', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), rects = [], errors = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await shadow(page, async (c, locale, theme) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      session.transcript = [{ id: 'visitor', role: 'user', content: 'Invoice approvals' }, { id: 'reply', role: 'assistant', content: 'Who approves?' }];
      session.transcript[1].inputRevision = inputRevision(session);
      Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
        summary: 'Invoice approvals', openQuestions: [locale === 'de' ? 'Wer gibt Rechnungen frei?' : 'Who approves invoices?'] });
      session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
      window.rc24Posts = [];
      window.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
          init.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }));
        if (init.method === 'POST') { window.rc24Posts.push(String(url)); return window.rc24Post(); }
        return Response.json(c.session);
      };
      window.rc24Copy = copy;
      window.rc24Reset = () => c.configure({ session, copy });
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme); window.rc24Reset();
    }, locale, theme);
    for (const state of ['rest', 'requesting', 'wait', 'retry', 'focus-retry', 'unavailable', 'cleared']) {
      await shadow(page, c => { window.rc24Reset(); c.shadowRoot.querySelector('.open-questions').scrollIntoView({ block: 'center' }); });
      await settle(page);
      const before = await boxes(page, state === 'unavailable');
      const resting = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.open-question');
        const boxes = ['.question-text', '.clarify-icon'].map(selector => {
          const r = row.querySelector(selector).getBoundingClientRect();
          return { selector, x: r.x, width: r.width, height: r.height };
        });
        return { question: boxes[0].x, label: boxes[1].x, boxes };
      });
      for (const box of resting.boxes) assert.ok(box.width > 0 && box.height > 0, `${box.selector}: positive resting box`);
      assert.equal(resting.label, resting.question, 'gate1 M3 A: resting action begins under the question');
      const point = before[1]; await page.mouse.move(point.x + 2, point.y + 2);
      await shadow(page, async (c, state) => {
        window.rc24Posts = [];
        const revision = c.session.operations.inputRevision, item = c.openQuestionItems[0];
        if (state === 'rest') return;
        if (state === 'requesting') {
          window.rc24Post = () => new Promise(resolve => { window.rc24Release = resolve; });
          void c.focusQuestion(item.id).catch(() => {}); return;
        }
        if (state === 'wait') {
          window.rc24Post = () => { c.receive({ type: 'lane.status', data: { inputRevision: revision, running: ['reaction'], failures: [] } });
            return Response.json({ reason: 'reply-in-flight' }, { status: 409 }); };
          await c.focusQuestion(item.id).catch(() => {}); return;
        }
        if (state === 'retry' || state === 'cleared') {
          window.rc24Post = () => Response.json({ event: { seq: c.session.seq + 1, type: 'question.focused', data: {
            ...item, questionId: item.id, requestId: 'visible-focus', chosenBy: 'user', inputRevision: revision,
          } } }, { status: 202 });
          await c.focusQuestion(item.id);
          c.receive({ type: 'lane.failed', data: { lane: 'reaction', retryable: true, inputRevision: revision } });
        } else if (state === 'focus-retry') {
          // Inject the wait deadline; no calendar or elapsed wall-clock comparison.
          const original = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) => delay === 60_000 ? (window.rc24Expire = callback, 0) : original.call(window, callback, delay, ...args);
          try {
            window.rc24Post = () => { c.receive({ type: 'lane.status', data: { inputRevision: revision, running: ['reaction'], failures: [] } });
              return Response.json({ reason: 'reply-in-flight' }, { status: 409 }); };
            await c.focusQuestion(item.id).catch(() => {}); window.rc24Expire();
          } finally { window.setTimeout = original; }
        } else {
          window.rc24Post = () => Response.json({ reason: 'not-admitted', admissionReason: 'plugin unhealthy' }, { status: 403 });
          await c.focusQuestion(item.id).catch(() => {});
        }
      }, state);
      let beforeClear;
      if (state === 'cleared') {
        await settle(page); beforeClear = await boxes(page);
        await shadow(page, c => {
          window.rc24Post = () => new Promise(resolve => { window.rc24Release = resolve; });
          c.shadowRoot.querySelector('.clarify-action').click();
        });
      }
      await settle(page);
      const after = await boxes(page, state === 'unavailable');
      if (beforeClear) for (let i = 0; i < beforeClear.length; i++) {
        assert.ok(beforeClear[i].width > 0 && beforeClear[i].height > 0, `${beforeClear[i].selector}: positive before clearing`);
        for (const key of ['x', 'y', 'width', 'height']) assert.equal(after[i][key], beforeClear[i][key], `exact 0 px while clearing/${beforeClear[i].selector}/${key}`);
      }
      for (let index = 0; index < before.length; index++) {
        assert.ok(before[index].width > 0 && before[index].height > 0);
        assert.ok(after[index].width > 0 && after[index].height > 0);
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(before[index][key] - after[index][key]) <= 0.5, `${locale}/${theme}/${width}/${state}/${before[index].selector}/${key}`);
          assert.equal(after[index][key], before[index][key], `gate1: exact 0 px/${locale}/${theme}/${width}/${state}/${before[index].selector}/${key}`);
        }
      }
      await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
      await settle(page);
      const repainted = await boxes(page, state === 'unavailable');
      for (let i = 0; i < after.length; i++) for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(repainted[i].width > 0 && repainted[i].height > 0);
        assert.ok(Math.abs(repainted[i][key] - after[i][key]) <= 0.5, `resting pointer repaint/${state}/${after[i].selector}/${key}`);
        assert.equal(repainted[i][key], after[i][key], `gate1: exact 0 px repaint/${state}/${after[i].selector}/${key}`);
      }
      const check = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.open-question'), line = row.querySelector('.question-state');
        return { state: row.dataset.state, noOverflow: line.scrollWidth <= line.clientWidth + 0.5,
          text: row.textContent, posts: window.rc24Posts.length, postPaths: window.rc24Posts,
          statusHidden: row.querySelector('.question-status').hidden, actionHidden: row.querySelector('button').hidden };
      });
      if (state === 'wait' || state === 'cleared') assert.equal(check.state, 'requesting');
      else assert.equal(check.state, state);
      assert.ok(check.noOverflow); assert.ok(!check.text.includes('undefined'));
      if (state === 'rest') assert.equal(check.posts, 0);
      else if (state === 'cleared') {
        assert.equal(check.posts, 2); assert.ok(check.postPaths[1].endsWith('/retry')); assert.equal(check.statusHidden, true);
      } else assert.equal(check.posts, state === 'unavailable' ? 2 : 1);
      if (state === 'unavailable') assert.ok(check.actionHidden);
      else if (['retry', 'focus-retry'].includes(state)) assert.match(check.text, locale === 'de' ? /Gerade nicht/ : /Not now|Couldn't ask just now/);
      if (['retry', 'focus-retry'].includes(state)) {
        const inline = await shadow(page, c => {
          const row = c.shadowRoot.querySelector('.open-question');
          return ['.question-status', '.question-separator', '.clarify-label'].map(selector => {
            const r = row.querySelector(selector).getBoundingClientRect();
            return { selector, x: r.x, y: r.y, right: r.right, width: r.width, height: r.height };
          });
        });
        for (const box of inline) assert.ok(box.width > 0 && box.height > 0, `${box.selector}: positive inline box`);
        assert.ok(inline[1].x >= inline[0].right && inline[2].x >= inline[1].right);
        assert.ok(inline[2].x - inline[0].right <= 18, 'status and Retry share an adjacent separator');
        check.inline = inline;
      }
      rects.push({ locale, theme, width, state, resting, before, beforeClear, after, repainted, check });
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait503-${locale}-${theme}-${width}-${state}.png`) });
      }
    }
  }
  assert.deepEqual(errors, []);
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait503-rects.json'), JSON.stringify(rects, null, 2));
});

test('AIT-503 MAC-LEAD: a typed chat answer removes its open question without Clarify', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-reconciliation-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.mouse.move(0, 0);
    await shadow(page, async (c, locale, theme) => {
      const { inputRevision } = await import('/packages/core/src/index.js');
      const response = await fetch('/reconciliation?locale=' + locale);
      const session = await response.json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme); c.configure({ session, copy });
      window.reconciliationCurrent = () => c.session.understanding.inputRevision === inputRevision(c.session) &&
        c.session.understanding.readinessAssessed && !c.session.understanding.draft;
      window.reconciliationFocusPosts = 0;
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => { if (String(args[0]).endsWith('/focus-question')) window.reconciliationFocusPosts++; return fetchOriginal(...args); };
    }, locale, theme);
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot?.querySelector('.open-question'));
    const before = await shadow(page, c => c.shadowRoot.querySelector('.question-text').textContent);
    await shadow(page, (c, locale) => {
      const textarea = c.shadowRoot.querySelector('textarea'); textarea.value = locale === 'de' ? 'Die Buchhaltung gibt alle Rechnungen frei.' : 'Accounting approves every invoice.';
      textarea.dispatchEvent(new Event('input', { bubbles: true })); c.shadowRoot.querySelector('.send').click();
    }, locale);
    await until(page, () => { const c = document.querySelector('aithema-session'); return window.reconciliationCurrent?.() && c?.session?.transcript.some(turn => turn.role === 'user' && /Accounting approves|Buchhaltung gibt/.test(turn.content)) &&
      ![...c.shadowRoot.querySelectorAll('.question-text')].some(n => /Who approves|Wer gibt/.test(n.textContent)); });
    assert.match(before, /Who approves|Wer gibt/);
    assert.equal(await page.evaluate(() => window.reconciliationFocusPosts), 0);
    assert.deepEqual(await page.evaluate(async locale => (await fetch('/reconciliation-proof?locale=' + locale)).json(), locale),
      { promptRule: true, typedAnswer: true, reconciled: true });
    assert.ok(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.none-yet'))));
  }
});

test('AIT-516 counted and accessible headings: 0/1/n, overrides, erased locale, EN/DE light/dark 390/1440', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-counted-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), evidence = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  const accessibility = await page.createCDPSession();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.mouse.move(0, 0);
    await shadow(page, async (c, locale, theme) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      session.transcript = [{ id: 'visitor', role: 'user', content: 'Invoice approvals' }, { id: 'reply', role: 'assistant', content: 'Who approves?' }];
      session.transcript[1].inputRevision = inputRevision(session);
      Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false, summary: 'Invoice approvals' });
      window.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
          init.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }));
        return Response.json(c.session);
      };
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme);
      const copies = await Promise.all(['en', 'de'].map(l => import(`/packages/ui/src/i18n/${l}.js`).then(m => m[l])));
      window.countedConfigure = override => c.configure({ session, copy: { ...copy, ...override }, copyForLocale: l => copies[l === 'de' ? 1 : 0] });
      window.countedConfigure(); c.shadowRoot.querySelector('.open-questions').scrollIntoView({ block: 'center' });
    }, locale, theme);
    let baseline;
    for (const count of [0, 1, 3]) {
      await shadow(page, (c, count) => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: {
        ...c.session.understanding, openQuestions: Array.from({ length: count }, (_, i) => `Question ${i + 1}?`),
      } }), count);
      await settle(page);
      const expected = locale === 'en' ? count ? `${count} open question${count === 1 ? '' : 's'}` : 'Open questions'
        : count ? `${count} offene Frage${count === 1 ? '' : 'n'}` : 'Offene Fragen';
      const check = await shadow(page, c => {
        const root = c.shadowRoot;
        return { heading: root.querySelector('#open-questions-title').textContent,
          noneYet: Boolean(root.querySelector('.questions .none-yet')),
          boxes: ['.questions-heading', '.understanding > .foot', '.composer-shell'].map(selector => {
            const r = root.querySelector(selector).getBoundingClientRect(); return { selector, x: r.x, y: r.y, width: r.width, height: r.height };
          }) };
      });
      assert.equal(check.heading, expected); assert.equal(check.noneYet, count === 0);
      const { nodes } = await accessibility.send('Accessibility.getFullAXTree');
      assert.ok(nodes.some(n => n.role?.value === 'heading' && n.name?.value === expected), 'accessible heading matches visible count');
      assert.ok(nodes.some(n => n.role?.value === 'list' && n.name?.value === expected), 'question list is named by the counted heading');
      for (const b of check.boxes) assert.ok(b.width > 0 && b.height > 0);
      if (!baseline) baseline = check.boxes;
      else for (let i = 0; i < baseline.length; i++) for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(baseline[i][key] - check.boxes[i][key]) <= 0.5, `${locale}/${theme}/${width}/${count}/${baseline[i].selector}/${key}`);
      evidence.push({ locale, theme, width, count, expected, ...check });
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait516-${locale}-${theme}-${width}-${count}.png`) });
      }
    }
    await shadow(page, c => window.countedConfigure({ questions: 'Host heading' }));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#open-questions-title').textContent), 'Host heading');
    await shadow(page, c => {
      window.countedConfigure();
      c.receive({ seq: c.session.seq + 1, type: 'session.erased', data: {} });
    });
    await shadow(page, (c, locale) => c.changeLocale(locale === 'en' ? 'de' : 'en'), locale);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#open-questions-title').textContent), locale === 'en' ? 'Offene Fragen' : 'Open questions');
    const erasedHeading = await shadow(page, c => {
      const heading = c.shadowRoot.querySelector('#open-questions-title'), box = heading.getBoundingClientRect();
      return { text: heading.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
    });
    assert.ok(erasedHeading.width > 0 && erasedHeading.height > 0, 'erased heading has a positive box');
    evidence.push({ locale, theme, width, erased: true, heading: erasedHeading });
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait516-${locale}-${theme}-${width}-erased.png`) });
    }
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait516-counted-rects.json'), JSON.stringify(evidence, null, 2));
  }
});

test('AIT-504 shipped overview states fit the fixed slot at 390 and 1440 without clipping', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc24-overflow-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), records = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  for (const locale of ['en', 'de']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await setupOverviewFixture(page, locale, 'light');
    const results = await shadow(page, async (c, locale) => {
      const copy = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      const slot = c.shadowRoot.querySelector('.notice'), text = slot.querySelector('.notice-text'), action = c.shadowRoot.querySelector('.overview-retry');
      slot.append(action); action.textContent = copy.understandingRetry;
      // Only failure and stale-idle own an overview Retry. Analysis refusals
      // cannot co-occur with that action; voice, visuals and uploads never render here.
      const states = Object.fromEntries(['empty', 'stale', 'staleIdle', 'overviewCurrent', 'draft', 'preparingOverview', 'understandingFailed', 'reasoningFailed', 'overviewPendingReply', 'noProjectDetails'].map(key => [key, copy[key]]));
      const { BINDING_REASON_CODES } = await import('/packages/core/src/presets.js');
      const reasons = [...new Set([...BINDING_REASON_CODES, 'not configured', 'unavailable on device', 'plugin not registered',
        'plugin not in preset', 'preset not configured', 'preset choices invalid', 'unknown preset', 'model not offered',
        'effort not offered', 'binding invalid', 'plugin binding mismatch', 'plugin kind unsupported', 'operation unsupported',
        'effort not supported', 'browser only', 'model not supported', 'processing scope invalid',
        'processing residency unverified', 'processing countries missing', 'recipient seat outside eu', 'processing residency denied',
        'training policy denied', 'endpoint not allowed', 'invalid mock budget', 'document text not covered by reasoning scope', 'consent port unavailable',
        'plugin unhealthy', 'admission deadline', 'budget denied', 'verification required'])];
      const { reasonText } = await import('/packages/ui/src/settings-dialog.js');
      for (const reason of reasons) states[`analysis: ${reason}`] = reasonText(copy, reason, 'analysis');
      states.consent = copy.featureConsent.analysis;
      states.analysisBudgetDuringCall = copy.voiceBudgetDenied;
      const { paintConsentLine } = await import('/packages/ui/src/consent-line.js');
      // Reconciliation and pauses preserve a cached assessment. Their visible
      // status is stale/current/draft above, rather than the unavailable reason.

      const results = [];
      for (const [key, value] of Object.entries(states)) {
        paintConsentLine(text, { copy, feature: 'analysis', separator: '', verdict: key === 'consent'
          ? { available: false, reason: 'current processing consent required' } : { available: true }, text: value, open() {} });
        action.hidden = !['staleIdle', 'understandingFailed'].includes(key);
        const label = key === 'consent' ? text.querySelector('.consent-line-copy') : text;
        const shownAction = key === 'consent' ? text.querySelector('.consent-action') : action.hidden ? null : action;
        const b = slot.getBoundingClientRect(), a = shownAction?.getBoundingClientRect();
        results.push({ key, value, hasAction: key === 'consent' || !action.hidden, width: b.width, height: b.height, scrollHeight: slot.scrollHeight, clientHeight: slot.clientHeight,
          textScrollHeight: label.scrollHeight, textClientHeight: label.clientHeight, textClientWidth: label.clientWidth, actionWidth: a?.width ?? null, actionHeight: a?.height ?? null, actionBottom: a ? a.bottom - b.top : null });
      }
      paintConsentLine(text, { copy, feature: 'analysis', verdict: { available: true }, text: 'Long host override '.repeat(100), open() {} }); action.hidden = false;
      const actionBox = action.getBoundingClientRect();
      results.push({ key: 'host override', hasAction: true, fullText: text.textContent, clamped: text.scrollHeight > text.clientHeight,
        width: slot.getBoundingClientRect().width, height: slot.getBoundingClientRect().height, scrollHeight: slot.scrollHeight, clientHeight: slot.clientHeight,
        textClientWidth: text.clientWidth, textClientHeight: text.clientHeight, actionWidth: actionBox.width, actionHeight: actionBox.height, actionBottom: actionBox.bottom - slot.getBoundingClientRect().top });
      return results;
    }, locale);
    for (const state of results) {
      assert.ok(state.width > 0 && state.height > 0, 'visible positive slot');
      assert.ok(state.textClientWidth > 0 && state.textClientHeight > 0, 'visible positive text box');
      if (state.hasAction) assert.ok(state.actionWidth > 0 && state.actionHeight > 0, 'visible positive action box');
      assert.equal(state.height, results[0].height, 'every state keeps exactly the same height');
      assert.ok(state.scrollHeight <= state.clientHeight, `${locale}/${width}/${state.key}: slot content fits`);
      if (state.key !== 'host override') {
        assert.ok(state.textScrollHeight <= state.textClientHeight, `${locale}/${width}/${state.key}: shipped text is not clamped`);
        if (state.hasAction) assert.ok(state.actionBottom <= state.height, 'action stays within slot');
      } else { assert.equal(state.clamped, true); assert.ok(state.fullText.length > 1000, 'full override remains in the accessible DOM'); }
      records.push({ locale, viewportWidth: width, ...state });
    }
  }
  if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'rc24-overview-overflow.json'), JSON.stringify(records, null, 2)); }
});

test('gate1 L3: MAC-LEAD EN/DE copy proof sheets', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-copy-proof-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: 844 });
    const words = await page.evaluate(async (locale, theme) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      // A labelled evidence sheet renders the exact bundle values, including the
      // placeholder. It is copy evidence, not a simulated provider interaction.
      const sheet = document.createElement('main'); sheet.lang = locale;
      sheet.style.cssText = `position:fixed;inset:0;z-index:999999;overflow:auto;padding:24px;box-sizing:border-box;font:16px/1.5 system-ui;background:${theme === 'dark' ? '#18181b' : '#fff'};color:${theme === 'dark' ? '#fafafa' : '#18181b'}`;
      const heading = document.createElement('h1'); heading.textContent = `MAC-LEAD copy proof · ${locale.toUpperCase()}`; sheet.append(heading);
      const entries = [['settings.fixedEffort', copy.settings.fixedEffort], ['reasons.delegated', copy.reasons.delegated], ['host.loadingBinding', copy.host.loadingBinding]];
      for (const [key, value] of entries) {
        const label = document.createElement('h2'); label.textContent = key; label.style.fontSize = '14px';
        const text = document.createElement('p'); text.textContent = value; sheet.append(label, text);
      }
      document.querySelector('[data-copy-proof]')?.remove(); sheet.dataset.copyProof = ''; document.body.append(sheet);
      return entries.map(([key, value]) => ({ key, value }));
    }, locale, theme);
    assert.equal(words.length, 3); assert.ok(words.every(({ value }) => value.length > 0));
    if (locale === 'de') {
      assert.match(words[0].value, /einstellbaren Verarbeitungsaufwand/);
      assert.equal(words[1].value, 'Sprachverarbeitung: {reason}');
      assert.equal(words[2].value, 'Verarbeitungseinstellungen werden geladen …');
    }
    if (evidence) await page.screenshot({ path: join(evidence, `l3-copy-${locale}-${theme}-${width}.png`) });
  }
});

async function followupPage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-overview-followups-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'fixture.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  return page;
}

test('AIT-504 follow-up: failure and idle Retry have no dangling separator or indent', { timeout: 120_000 }, async t => {
  const page = await followupPage(t);
  for (const locale of ['en', 'de']) for (const width of [390, 1440]) for (const state of ['failure', 'idle']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await setupOverviewFixture(page, locale, 'light');
    const result = await shadow(page, async (c, state) => {
      const session = c.session, copy = (await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale];
      if (state === 'idle') session.understanding.inputRevision = 'older';
      else {
        const failure = { lane: 'understanding', error: 'reasoning-unavailable', retryable: true };
        session.operations.failures = [failure]; session.operations.lastFailure = failure;
      }
      c.configure({ copy, session });
      const text = c.shadowRoot.querySelector('.notice-text'), action = c.shadowRoot.querySelector('.overview-retry');
      const lines = new Map(), range = document.createRange();
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) for (let i = 0; i < node.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        lines.set(rect.top, (lines.get(rect.top) ?? '') + node.data[i]);
      }
      const a = action.getBoundingClientRect(), b = text.getBoundingClientRect();
      return { lines: [...lines.values()], action: { x: a.x, y: a.y, width: a.width, height: a.height }, text: { x: b.x, y: b.y, width: b.width, height: b.height }, hidden: action.hidden };
    }, state);
    const context = `${locale}/${width}/${state}`;
    assert.equal(result.hidden, false, context);
    assert.ok(result.action.width > 0 && result.action.height > 0 && result.text.width > 0 && result.text.height > 0, context);
    assert.ok(result.lines.every(line => !line.trimEnd().endsWith('·')), `${context}: no line ends with a separator`);
    assert.equal(result.action.x, result.text.x, `${context}: action aligns with text`);
    assert.ok(result.action.y > result.text.y, `${context}: consistent action row`);
  }
});

test('AIT-504 follow-up: fixed overview slot reserves exactly three reachable lines', { timeout: 120_000 }, async t => {
  const page = await followupPage(t);
  for (const locale of ['en', 'de']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await setupOverviewFixture(page, locale, 'light');
    const box = await shadow(page, c => {
      const n = c.shadowRoot.querySelector('.notice'), rect = n.getBoundingClientRect();
      return { width: rect.width, height: rect.height, lineHeight: parseFloat(getComputedStyle(n).lineHeight) };
    });
    assert.ok(box.width > 0 && box.height > 0);
    assert.ok(Math.abs(box.height - 3 * box.lineHeight) < 0.02, `${locale}/${width}: three lines, no fourth-line empty band`);
  }
});

test('AIT-504 follow-up: long host consent keeps its action visible, focusable and fully described', { timeout: 120_000 }, async t => {
  const page = await followupPage(t);
  await page.setViewport({ width: 390, height: 844 });
  for (const locale of ['en', 'de']) {
    await setupOverviewFixture(page, locale, 'light');
    const result = await shadow(page, async (c, locale) => {
      const defaults = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      const fullText = (locale === 'de' ? 'Lange Einwilligung des Hosts. ' : 'Long consent from a host. ').repeat(80);
      const copy = { ...defaults, featureConsent: { ...defaults.featureConsent, analysis: fullText } }, session = c.session;
      session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
      c.configure({ copy, session });
      const slot = c.shadowRoot.querySelector('.notice'), action = slot.querySelector('.consent-action'), text = slot.querySelector('.consent-line-copy');
      const initialSlot = slot.getBoundingClientRect(), initialAction = action.getBoundingClientRect();
      const beforeFocus = { slotWidth: initialSlot.width, slotHeight: initialSlot.height, actionWidth: initialAction.width, actionHeight: initialAction.height,
        top: initialAction.top - initialSlot.top, bottom: initialAction.bottom - initialSlot.top };
      action.focus();
      const b = slot.getBoundingClientRect(), a = action.getBoundingClientRect(), x = text.getBoundingClientRect();
      return { fullText, beforeFocus, accessibleText: c.shadowRoot.getElementById(action.getAttribute('aria-describedby')).textContent,
        focused: c.shadowRoot.activeElement === action, disabled: action.disabled,
        slot: { width: b.width, height: b.height }, text: { width: x.width, height: x.height }, action: { width: a.width, height: a.height, top: a.top - b.top, bottom: a.bottom - b.top } };
    }, locale);
    assert.ok(result.slot.width > 0 && result.slot.height > 0 && result.text.width > 0 && result.text.height > 0 && result.action.width > 0 && result.action.height > 0);
    assert.ok(result.beforeFocus.slotWidth > 0 && result.beforeFocus.slotHeight > 0 && result.beforeFocus.actionWidth > 0 && result.beforeFocus.actionHeight > 0);
    assert.ok(result.beforeFocus.top >= 0 && result.beforeFocus.bottom <= result.beforeFocus.slotHeight, `${locale}: consent action is visible before focus`);
    assert.ok(result.action.top >= 0 && result.action.bottom <= result.slot.height, `${locale}: consent action stays inside fixed slot`);
    assert.equal(result.focused, true); assert.equal(result.disabled, false);
    assert.ok(result.accessibleText.includes(result.fullText), 'full override remains the action’s accessible description');
  }
});

test('AIT-504 follow-up: capture every overview state for the release design check', { timeout: 180_000 }, async t => {
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (!evidence) return t.skip('release screenshots need an evidence destination');
  const page = await followupPage(t), records = [];
  const shots = join(evidence, 'shots'); await mkdir(shots, { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    for (const state of ['empty', 'current', 'updating', 'idle', 'draft', 'preparing', 'failed', 'both-failed', 'reply-pending', 'no-details', 'unavailable', 'consent', 'long-consent', 'paused', 'reconciling']) {
      await setupOverviewFixture(page, locale, theme);
      await shadow(page, async (c, locale, state) => {
        let copy = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
        const session = c.session, u = session.understanding, ops = session.operations;
        const failures = lanes => { ops.failures = lanes.map(lane => ({ lane, error: 'reasoning-unavailable', retryable: true })); ops.lastFailure = ops.failures.at(-1); };
        if (state === 'empty') {
          const { applyEvent } = await import('/packages/core/src/session.js');
          Object.assign(session, applyEvent(session, { seq: session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'u', reason: 'withdrawal' } }));
        }
        if (['updating', 'idle', 'reconciling'].includes(state)) u.inputRevision = 'older';
        if (state === 'updating') ops.running = ['understanding'];
        if (state === 'draft') { u.draft = true; ops.running = ['understanding']; }
        if (state === 'preparing') { u.readinessAssessed = false; ops.running = ['understanding']; }
        if (state === 'failed') failures(['understanding']);
        if (state === 'both-failed') failures(['reaction', 'understanding']);
        if (state === 'reply-pending') { u.readinessAssessed = false; session.transcript.pop(); failures(['reaction']); }
        if (state === 'no-details') u.readinessAssessed = false;
        if (state === 'unavailable') { u.readinessAssessed = false; session.featureMatrix.best.analysis = { available: false, reason: 'admission deadline' }; }
        if (state === 'consent' || state === 'long-consent') {
          session.featureMatrix.best.analysis = { available: false, reason: 'current processing consent required' };
          if (state === 'long-consent') copy = { ...copy, featureConsent: { ...copy.featureConsent, analysis: (locale === 'de' ? 'Lange Einwilligung des Hosts. ' : 'Long consent from a host. ').repeat(80) } };
        }
        if (state === 'paused') session.paused = true;
        if (state === 'reconciling') session.featureMatrix.best.analysis = { available: false, reason: 'budget reconciling' };
        c.configure({ copy, session });
      }, locale, state);
      await settle(page);
      await shadow(page, c => { c.shadowRoot.querySelector('.analysis-content').scrollTop = 0; c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start', behavior: 'instant' }); });
      await settle(page);
      const record = await shadow(page, c => {
        const slot = c.shadowRoot.querySelector('.notice'), box = slot.getBoundingClientRect();
        return { text: slot.textContent, slotWidth: box.width, slotHeight: box.height };
      });
      assert.ok(record.slotWidth > 0 && record.slotHeight > 0, `${locale}/${theme}/${width}/${state}: visible slot`);
      assert.ok(record.text.trim(), 'the overview slot is never empty');
      const path = `shots/overview-${locale}-${theme}-${width}-${state}.png`;
      await page.screenshot({ path: join(evidence, path), fullPage: false });
      records.push({ locale, theme, width, state, path, ...record });
    }
  }
  await writeFile(join(evidence, 'overview-screenshots.json'), JSON.stringify(records, null, 2));
});

// AIT-514 owns real typography/overflow and geometry here; no provider dispatch.
test('AIT-514 summary measured clamp, expansion, rewrites and responsive evidence', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-summary-'));
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
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  if (evidence) await writeFile(join(evidence, 'ait-514-start.json'), JSON.stringify({ head: evidenceCommit, phase: 'started' }));
  const update = text => shadow(page, (c, text) => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated',
    data: { ...c.session.understanding, summary: text } }), text);
  const state = () => shadow(page, c => {
    const r = c.shadowRoot, p = r.querySelector('.summary-text'), b = r.querySelector('.summary-toggle'), h = r.querySelector('#summary-title');
    const rect = p.getBoundingClientRect(), heading = h.getBoundingClientRect(), line = parseFloat(getComputedStyle(p).lineHeight);
    return { button: !!b, hidden: b?.hidden, expanded: b?.getAttribute('aria-expanded'), name: b?.textContent,
      controls: b?.getAttribute('aria-controls') === p.id, height: rect.height, width: rect.width, line,
      heading: h.textContent, headingWidth: heading.width, headingHeight: heading.height,
      fade: getComputedStyle(p).maskImage, html: p.innerHTML, text: p.textContent };
  }).then(value => {
    assert.ok(value.width > 0 && value.height > 0, 'summary has a positive measured box');
    assert.ok(value.headingWidth > 0 && value.headingHeight > 0, 'heading has a positive measured box');
    assert.ok(value.line > 0, 'summary has a resolved line height');
    return value;
  });
  const frames = async () => { await settle(page); };
  const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, `ait-514-${name}.png`), fullPage: true }); };
  const frameBoxes = async () => {
    const rects = await shadow(page, c => ['.band', '.audio-rail', '.understanding', '.understanding > .foot', '.composer', '.attach', '.send'].map(selector => {
      const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return { selector, x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    }));
    for (const r of rects) assert.ok(r.width > 0 && r.height > 0, `positive ${r.selector}`);
    return rects;
  };
  const compare = (before, after, label) => {
    before.forEach((r, i) => { for (const key of r.selector === '.composer' ? ['x', 'width', 'bottom'] : ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(r[key] - after[i][key]) <= .5, `${label} ${r.selector}.${key}: ${r[key]} → ${after[i][key]}`);
    } }); rows.push({ label, before, after });
  };
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 1024 ? 640 : 1000 });
    await page.mouse.move(-10, -10);
    await shadow(page, async (c, locale, theme, manifest) => {
      const { createSession, inputRevision } = await import('/packages/core/src/session.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
      session.transcript = [{ id: 'person', role: 'user', content: 'A booking workflow.' }];
      Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
        summary: 'Short.', signals: ['A stable signal'], openQuestions: [] });
      // Every request stays in this browser; no fixture/provider operation is admitted.
      window.fetch = async (url, init = {}) => String(url).endsWith('/events') ? new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } })) : Response.json(session);
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off'); c.configure({ session, copy, voiceClient: { manifest } });
      window.summarySession = session; window.summaryCopy = copy;
      window.summaryLong = (locale === 'de' ? 'Sie planen einen übersichtlichen Ablauf für die Buchung und Freigabe. ' : 'You plan a clear workflow for booking and approval. ').repeat(35);
    }, locale, theme, voiceManifest);
    await frames();
    let s = await state(); assert.equal(s.button, true); assert.equal(s.hidden, true);
    assert.equal(s.heading, locale === 'de' ? 'Unser Verständnis bisher' : 'What we understood so far');
    assert.ok(s.headingWidth > 1 && s.headingHeight > 1, 'heading is visibly rendered');
    await shot(`${locale}-${theme}-${width}-fit`);
    // Exact nine-line boundary, measured using real line boxes, then one line over.
    await shadow(page, c => { c.shadowRoot.querySelector('.summary-text').style.whiteSpace = 'pre-line'; });
    await update(Array(9).fill('Line').join('\n')); await frames();
    assert.equal((await state()).hidden, true, 'exact nine lines fit');
    await update(Array(10).fill('Line').join('\n')); await frames();
    s = await state(); assert.equal(s.hidden, false); assert.equal(s.expanded, 'false'); assert.equal(s.controls, true);
    assert.ok(s.width > 0 && s.height > 0); assert.ok(s.height <= 9 * s.line + .5, 'collapsed summary is at most nine lines');
    assert.notEqual(s.fade, 'none');
    await shadow(page, c => { c.shadowRoot.querySelector('.summary-text').style.fontSize = '20px'; }); await frames();
    s = await state(); assert.equal(s.hidden, false);
    assert.ok(Math.abs(s.height - 9 * s.line) <= .5, 'font size change while clamped preserves exactly nine rendered lines');
    await shadow(page, c => { c.shadowRoot.querySelector('.summary-text').style.fontSize = ''; c.shadowRoot.querySelector('.summary-text').style.whiteSpace = ''; });
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: window.summaryLong } }));
    await frames(); await shot(`${locale}-${theme}-${width}-collapsed`);
    const readMoreName = locale === 'de' ? 'Mehr anzeigen' : 'Read more';
    const namedToggle = (tree, name, expanded) => tree && (tree.role === 'button' && tree.name === name && tree.expanded === expanded || tree.children?.some(child => namedToggle(child, name, expanded)));
    assert.ok(namedToggle(await page.accessibility.snapshot({ interestingOnly: false }), readMoreName, false), 'screen reader finds the named collapsed native control');
    if (width === 1024) {
      const visible = await shadow(page, c => {
        const p = c.shadowRoot.querySelector('.analysis-content').getBoundingClientRect(), r = c.shadowRoot.querySelector('.signals li').getBoundingClientRect();
        return { pane: p.toJSON(), signal: r.toJSON(), positive: p.width > 0 && p.height > 0 && r.width > 0 && r.height > 0,
          visible: r.top >= p.top && r.bottom <= p.bottom };
      });
      assert.equal(visible.positive, true, 'first signal and pane have positive boxes');
      if (evidence) await writeFile(join(evidence, `ait-514-${locale}-${theme}-1024-first-signal.json`), JSON.stringify(visible, null, 2));
      assert.equal(visible.visible, true, `first signal visible at 1024×640: ${JSON.stringify(visible)}`);
    }
    const before = await frameBoxes();
    await shadow(page, c => { const b = c.shadowRoot.querySelector('.summary-toggle'); b.focus({ preventScroll: true }); });
    await page.keyboard.press('Enter'); await frames();
    s = await state(); assert.equal(s.expanded, 'true'); assert.equal(s.name, locale === 'de' ? 'Weniger anzeigen' : 'Show less'); assert.equal(s.fade, 'none');
    assert.ok(namedToggle(await page.accessibility.snapshot({ interestingOnly: false }), s.name, true), 'screen reader finds the named expanded native control');
    compare(before, await frameBoxes(), `${locale}/${theme}/${width} expand`);
    await shot(`${locale}-${theme}-${width}-expanded`);
    await update('A rewrite. '.repeat(150)); await frames(); assert.equal((await state()).expanded, 'true');
    await update('Short again.'); await frames(); assert.equal((await state()).hidden, true);
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: window.summaryLong } }));
    await frames(); assert.equal((await state()).expanded, 'true', 'short rewrite keeps expansion preference');
    await shadow(page, c => c.shadowRoot.querySelector('.summary-toggle').click()); await frames();
    assert.equal((await state()).expanded, 'false');
    // Rewrites above a resting pointer preserve the signal's positive box.
    await shadow(page, c => c.shadowRoot.querySelector('.signals li').scrollIntoView({ block: 'center' })); await frames();
    const signal = await shadow(page, c => { const r = c.shadowRoot.querySelector('.signals li').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    assert.ok(signal.width > 0 && signal.height > 0); await page.mouse.move(signal.x + signal.width / 2, signal.y + signal.height / 2);
    await update('Short rewrite.'); await frames();
    const afterSignal = await shadow(page, c => { const r = c.shadowRoot.querySelector('.signals li').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    assert.ok(afterSignal.width > 0 && afterSignal.height > 0); assert.ok(Math.abs(signal.y - afterSignal.y) <= .5, 'signal stays under pointer');
    rows.push({ label: `${locale}/${theme}/${width} rewrite anchor`, before: signal, after: afterSignal });
    await page.mouse.move(-10, -10); await frames();
    const focusBefore = await shadow(page, c => {
      const n = c.shadowRoot.querySelector('.signals li'); n.tabIndex = 0; n.focus({ preventScroll: true }); window.summaryFocusedSignal = n;
      return n.getBoundingClientRect().toJSON();
    });
    assert.ok(focusBefore.width > 0 && focusBefore.height > 0, 'focused signal has a positive box');
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: window.summaryLong } })); await frames();
    const focusAfter = await shadow(page, c => ({ ...window.summaryFocusedSignal.getBoundingClientRect().toJSON(), focused: c.shadowRoot.activeElement === window.summaryFocusedSignal }));
    assert.ok(focusAfter.width > 0 && focusAfter.height > 0, 'focused signal keeps a positive box');
    assert.equal(focusAfter.focused, true); assert.ok(Math.abs(focusAfter.y - focusBefore.y) <= .5, 'signal stays at keyboard reading position');
    rows.push({ label: `${locale}/${theme}/${width} focus anchor`, before: focusBefore, after: focusAfter });
    if (evidence) await writeFile(join(evidence, 'ait-514-rects.json'), JSON.stringify(rows, null, 2));
    await update('<img src=x onerror=alert(1)> the person'); await frames();
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.summary-text img') === null), true);
    assert.equal((await state()).text, '<img src=x onerror=alert(1)> the person');
  }
  // Width and font changes trigger real overflow measurement without a new assessment.
  await page.setViewport({ width: 1440, height: 1000 });
  await shadow(page, c => { c.shadowRoot.querySelector('.summary-text').style.whiteSpace = 'pre-line'; });
  await update(Array(9).fill('A clear booking and approval workflow for teams.').join('\n')); await frames();
  assert.equal((await state()).hidden, true, 'nine lines fit at the wide width');
  await page.setViewport({ width: 390, height: 1000 }); await frames();
  assert.equal((await state()).hidden, false, 'width change alone exposes measured overflow');
  await page.setViewport({ width: 1440, height: 1000 }); await frames();
  assert.equal((await state()).hidden, true, 'widening hides the unneeded toggle');
  await shadow(page, c => { c.shadowRoot.querySelector('.summary-text').style.fontSize = '32px'; }); await frames();
  assert.equal((await state()).hidden, false);
  await shadow(page, c => c.shadowRoot.querySelector('.summary-toggle').click());
  await shadow(page, c => {
    const session = structuredClone(c.session); session.understanding.summary = window.summaryLong;
    c.configure({ session, copy: { ...window.summaryCopy, summary: 'Host heading', summaryMore: 'Host more', showLess: 'Host less' } });
  });
  await frames();
  assert.equal((await state()).heading, 'Host heading'); assert.equal((await state()).name, 'Host less');
  assert.equal((await state()).expanded, 'true', 'same conversation configuration keeps expansion');
  await shadow(page, async c => {
    const { en } = await import('/packages/ui/src/i18n/en.js');
    c.configure({ session: { ...c.session, locale: 'en' }, copy: en });
  });
  await frames(); assert.equal((await state()).name, 'Show less', 'locale changes keep expansion and repaint the native button');
  await shadow(page, c => { const session = structuredClone(window.summarySession); session.id += '-different'; session.understanding.summary = window.summaryLong; c.configure({ session, copy: { ...window.summaryCopy } }); });
  await frames(); assert.equal((await state()).expanded, 'false', 'different conversation resets expansion');
  await shadow(page, c => c.shadowRoot.querySelector('.summary-toggle').click());
  await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.erased', data: {} }));
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.summary-toggle').hidden), true, 'erasure removes the toggle');
  if (evidence) await writeFile(join(evidence, 'ait-514-rects.json'), JSON.stringify(rows, null, 2));
  t.diagnostic(`AIT-514 ${rows.length} positive geometry comparisons`);
});
