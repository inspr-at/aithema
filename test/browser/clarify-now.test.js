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
    const visible = await shadow(page, c => { const n = c.shadowRoot.querySelector('.notice').getBoundingClientRect(), p = c.shadowRoot.querySelector('.analysis-content').getBoundingClientRect(); return { top: n.top - p.top, bottom: p.bottom - n.bottom }; });
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
        emit('lane.status', { inputRevision: inputRevision(c.session), running: ['reaction', 'understanding'], failures: [], lastFailure: null });
        emit('turn.final', { id: `reply-${i}`, role: 'assistant', content: 'Thank you', inputRevision: inputRevision(c.session) });
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
    let previous = await shadow(page, c => c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'));
    for (let answer = 1; answer <= 5; answer++) {
      await shadow(page, async (c, answer) => {
        window.rc24Now = (await (await fetch('/clock')).json()).now;
        const textarea = c.shadowRoot.querySelector('textarea'); textarea.value = `Our project needs workflow step ${answer}.`;
        textarea.dispatchEvent(new Event('input', { bubbles: true })); c.shadowRoot.querySelector('.send').click();
      }, answer);
      await until(page, answer => { const c = document.querySelector('aithema-session'); return c.shadowRoot.querySelector('.summary-text').textContent.includes(`workflow step ${answer}`) && c.shadowRoot.querySelector('.understanding').dataset.overview === 'current'; }, answer);
      const result = await shadow(page, c => ({ summary: c.shadowRoot.querySelector('.summary-text').textContent,
        readiness: c.shadowRoot.querySelector('.scale').getAttribute('aria-valuetext'),
        revision: c.session.understanding.inputRevision, operations: c.session.operations }));
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
    for (const state of ['retry', 'focus-retry', 'unavailable']) {
      await shadow(page, c => { window.rc24Reset(); c.shadowRoot.querySelector('.open-questions').scrollIntoView({ block: 'center' }); });
      await settle(page);
      const before = await boxes(page, state === 'unavailable');
      const point = before[1]; await page.mouse.move(point.x + 2, point.y + 2);
      await shadow(page, async (c, state) => {
        window.rc24Posts = [];
        const revision = c.session.operations.inputRevision, item = c.openQuestionItems[0];
        if (state === 'retry') {
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
      await settle(page);
      const after = await boxes(page, state === 'unavailable');
      for (let index = 0; index < before.length; index++) {
        assert.ok(before[index].width > 0 && before[index].height > 0);
        assert.ok(after[index].width > 0 && after[index].height > 0);
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[index][key] - after[index][key]) <= 0.5, `${locale}/${theme}/${width}/${state}/${before[index].selector}/${key}`);
      }
      await shadow(page, c => c.receive({ type: 'lane.status', data: c.session.operations }));
      await settle(page);
      const repainted = await boxes(page, state === 'unavailable');
      for (let i = 0; i < after.length; i++) for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(repainted[i].width > 0 && repainted[i].height > 0);
        assert.ok(Math.abs(repainted[i][key] - after[i][key]) <= 0.5, `resting pointer repaint/${state}/${after[i].selector}/${key}`);
      }
      const check = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.open-question'), line = row.querySelector('.question-state');
        return { state: row.dataset.state, noOverflow: line.scrollWidth <= line.clientWidth + 0.5,
          text: row.textContent, posts: window.rc24Posts.length, actionHidden: row.querySelector('button').hidden };
      });
      assert.equal(check.state, state); assert.ok(check.noOverflow); assert.ok(!check.text.includes('undefined'));
      assert.equal(check.posts, state === 'unavailable' ? 2 : 1);
      if (state === 'unavailable') assert.ok(check.actionHidden);
      else assert.match(check.text, locale === 'de' ? /Gerade nicht/ : /Not now|Couldn't ask just now/);
      rects.push({ locale, theme, width, state, before, after, repainted, check });
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
