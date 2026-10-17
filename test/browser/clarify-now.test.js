// AIT-274: one page and one browser; all state-only contracts live in unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';

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
}));

test('AIT-274 clarify states: 0 px at 1440/1024/390, DE/EN, light/dark, retained focus and one retry', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-clarify-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(directory, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [], passes = [], shots = [];
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
  for (const locale of ['de', 'en']) for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1024, 'light'], [390, 'light']]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    for (const state of states) {
      await shadow(page, async (c, locale, theme, state) => {
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
          const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
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
      }, locale, theme, state);
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
      if (state === 'voice-busy-resolved') { assert.equal(checks.voiceBusyWasRequesting, true); assert.equal(checks.itemState, 'rest'); assert.equal(checks.actionEnabled, true); }
      if (['requesting', 'selected', 'asked'].includes(state)) assert.equal(checks.focusRetained, true, 'keyboard focus stays on the original action');
      if (['rest', 'requesting', 'selected', 'asked'].includes(state)) assert.equal(checks.targetHeight, 44, '44 px pointer target');
      if (state === 'retry') { assert.equal(checks.oneRetry, true); assert.equal(checks.noOverflow, true, 'narrow retry fits the reserved line'); }
      if (state === 'refused-deadline') assert.equal(checks.noDeadlineButtons, true);
      if (['selected', 'asked'].includes(state)) { assert.equal(checks.metaCount, 1); assert.equal(checks.metaWrap, 'nowrap', 'reply meta stays on one ellipsized line'); }
      if (state.startsWith('refused')) assert.equal(checks.refusalIcon, true, 'approved refusal glyph is present');
      if (locale === 'en') assert.equal(checks.title, 'Overview');
      const pass = `AIT-274 GEOMETRY PASS ${locale} ${width} ${theme} ${state}: 0 px; reserved heading/action; focus/target/retry checks passed`;
      passes.push(pass); console.log(pass);
      if (evidence) {
        await shadow(page, (c, state) => {
          const analysis = c.shadowRoot.querySelector('.analysis-content'), section = c.shadowRoot.querySelector('.open-questions');
          analysis.scrollTop = Math.max(0, section.offsetTop - analysis.offsetTop - 24);
          if (innerWidth < 600) c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start', behavior: 'instant' });
          c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
        }, state);
        await page.mouse.move(-1, -1); await settle(page);
        const file = `ait274-${locale}-${width}-${theme}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
        shots.push({ file, head: evidenceCommit, theme, locale, state, width, pass, viewportOnly: true, reducedMotion: true, fontsPinned: true, controlsBlurred: true });
        if (state === 'selected' && width === 390) {
          await shadow(page, c => c.shadowRoot.querySelector('.transcript-shell').scrollIntoView({ block: 'start', behavior: 'instant' }));
          await settle(page);
          const file = `ait274-${locale}-${width}-${theme}-${state}-conversation.png`;
          await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
          shots.push({ file, head: evidenceCommit, theme, locale, state, width, pass, viewportOnly: true, reducedMotion: true, fontsPinned: true, controlsBlurred: true });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, shots, passes }, null, 2));
});
