// AIT-293: called only by the existing host-polish evidence path. No CI audit.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { shadow, until, evidenceCommit, evidenceBrowserArgs } from './start2-display-helpers.js';

const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const base = 'c285d360';
const labels = {
  de: { private: 'Privatperson', company: 'Unternehmen', representative: 'Vertretung', agency: 'Agentur' },
  en: { private: 'Private individual', company: 'Company', representative: 'Representative', agency: 'Agency' },
};
const settle = page => page.evaluate(async () => {
  await document.fonts.ready;
  const root = document.querySelector('aithema-session')?.shadowRoot ?? document;
  await Promise.all(root.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

export async function auditMainSurfaces(t, evidence) {
  assert.ok(evidence, 'axe requires an explicit evidence directory');
  assert.ok(!process.env.CI, 'axe must never run on the CI path');
  const directory = await mkdtemp(join(tmpdir(), 'aithema-a11y-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await browserForFile({ args: evidenceBrowserArgs }), page = await browser.newPage();
  const errors = [], runs = [], shots = [], manual = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir(evidence, { recursive: true });
  const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.addScriptTag({ path: axePath });
  await shadow(page, c => {
    window.a11ySeed = structuredClone(c.session);
    const native = window.fetch;
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (path.endsWith('/focus-question')) return new Promise(resolve => { window.a11yFocusAck = resolve; });
      if (path.endsWith('/identity')) return Response.json({ roleChoice: c.session.roleChoice });
      if (path.endsWith('/credits')) return Response.json({ balance: { owner: { availableMicro: 6_550_000, limitMicro: 10_000_000, committedMicro: 3_450_000 } }, limitSlot: null });
      if (path.endsWith('/features')) return Response.json({ featureMatrix: c.session.featureMatrix });
      if (path.endsWith('/consent')) return Response.json({ contract: 'a11y-fixture',
        items: [{ id: 'models-international', version: 1, title: 'Processing', recipients: 'Local fixture', text: 'Local accessibility evidence only.' }],
        selected: [], features: Object.fromEntries(['text', 'analysis', 'html', 'voice', 'images', 'uploads'].map(key => [key, ['models-international']])) });
      if (path.endsWith('/settings') && init.method === 'POST') return Response.json({
        processingPreset: c.session.processingPreset, settings: { ...c.session.settings, origin: 'chosen' }, engine: c.session.engine,
      });
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      if (path.endsWith('/image')) return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+XikzGQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      if (path.endsWith('/html')) return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Evidence draft</title></head><body><h1>Invoice approval</h1><p>Local evidence fixture.</p><button type="button">Approve invoice</button></body></html>', { headers: { 'content-type': 'application/octet-stream' } });
      return native(url, init);
    };
  });
  const configure = async (locale, theme, state = 'live', role = false) => {
    await shadow(page, async (c, { locale, theme, state, role, labels }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { inputRevision } = await import('/packages/core/src/session.js');
      const session = structuredClone(window.a11ySeed);
      session.locale = locale; session.paused = false; session.pauseReason = null;
      session.settings = { ...session.settings, origin: state === 'entrance' ? 'default' : 'chosen', voice: state.endsWith('voice') ? 'fixture-voice' : 'off', visuals: 'off' };
      session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'images', 'html'].map(key => [key, { available: true }])),
        eu: { text: { available: false, reason: 'not configured' } }, custom: { text: { available: false, reason: 'not configured' } } };
      session.visualsBound = true; session.conceptVisualKind = 'image'; session.conceptCost = { maxMicro: 0 };
      if (state.endsWith('voice')) session.featureMatrix.best.voice = { available: true };
      if (state === 'consent') {
        session.settings.visuals = 'fixture-image';
        for (const feature of Object.keys(session.featureMatrix.best)) session.featureMatrix.best[feature] = { available: false, reason: 'current processing consent required' };
      }
      if (state === 'paused') session.paused = true;
      if (state === 'no-text') session.featureMatrix.best.text = { available: false, reason: 'not configured' };
      session.concepts = []; session.conceptStatus = { phase: 'idle' };
      session.transcript = ['entrance', 'ready', 'ready-voice'].includes(state) ? [] : [
        { id: 'person', role: 'user', content: locale === 'de' ? 'Wir gleichen 400 Rechnungen von Hand ab.' : 'We reconcile 400 invoices by hand.' },
        { id: 'reply', role: 'assistant', content: locale === 'de' ? 'Wer gibt die Rechnungen heute frei?' : 'Who approves invoices today?', inputRevision: 1 },
      ];
      Object.assign(session.understanding, { readinessAssessed: true, draft: false, inputRevision: inputRevision(session),
        summary: locale === 'de' ? '400 Rechnungen im Monat abgleichen.' : 'Reconcile 400 invoices a month.',
        signals: [locale === 'de' ? '400 Rechnungen' : '400 invoices'],
        openQuestions: locale === 'de' ? ['Welches System ist im Einsatz?', 'Wer gibt Rechnungen frei?', 'PDF oder Papier?'] : ['Which system is in use?', 'Who approves invoices?', 'PDF or paper?'] });
      session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
      if (state === 'concept' || state === 'draft') {
        session.settings.visuals = 'fixture-image';
        session.conceptVisualKind = state === 'draft' ? 'html' : 'image';
        session.concepts = [{ id: 'a11y-image', mediaType: state === 'draft' ? 'text/html' : 'image/png', turnIds: ['person'], referenceIds: [], archived: false }];
      }
      if (role) {
        session.demo = false;
        session.roleChoice = { available: true, roles: Object.keys(labels.en), role: 'company', source: 'inferred', reasoning: locale === 'de' ? 'Sie sprechen von Ihrem Unternehmen.' : 'You refer to your company.', revision: session.seq };
        session.actor = { type: 'company', evidence: 'inferred', reasoning: session.roleChoice.reasoning };
      }
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme);
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy, ...(state.endsWith('voice') ? { voiceClient: {} } : {}), host: { credits: true, version: { version: '261015164601.0.0', version_scheme: 'inspr-calver-3',
        commit: 'c285d360', date: '2026-10-17T10:00:00Z' }, ...(role ? { actorRole: { labels } } : {}) } });
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      window.scrollTo(0, 0);
    }, { locale, theme, state, role, labels });
    await settle(page);
  };
  const audit = async (surface, state, locale, theme, width, shot = false) => {
    const focused = await page.evaluateHandle(() => document.querySelector('aithema-session')?.shadowRoot.activeElement ?? document.activeElement);
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); }).catch(() => {});
    await page.mouse.move(-1, -1); await settle(page);
    const result = await page.evaluate(async tags => {
      const result = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
      const shape = rule => ({ id: rule.id, impact: rule.impact, count: rule.nodes.length, help: rule.help, helpUrl: rule.helpUrl,
        nodes: rule.nodes.map(n => ({ target: n.target, html: n.html, impact: n.impact, summary: n.failureSummary,
          checks: [...n.any, ...n.all, ...n.none].map(c => ({ id: c.id, data: c.data, message: c.message })) })) });
      return { axe: result.testEngine.version, violations: result.violations.map(shape), incomplete: result.incomplete.map(shape), passes: result.passes.map(r => r.id) };
    }, tags);
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('aithema-session')?.shadowRoot ?? document;
      return Object.fromEntries(['.band', '.conversation', '.composer-shell', '.send', '.understanding', '.display-foot', '.concept-access', 'dialog[open]'].map(selector => {
        const b = root.querySelector(selector)?.getBoundingClientRect(); return [selector, b ? [b.x, b.y, b.width, b.height] : null];
      }));
    });
    const scene = await page.evaluate(() => {
      const r = document.querySelector('aithema-session')?.shadowRoot;
      return r ? { stage: r.querySelector('.workspace').dataset.stage, composer: r.querySelector('.composer-reason').outerHTML,
        itemStates: [...r.querySelectorAll('.open-question')].map(n => n.dataset.state), openDialogs: [...r.querySelectorAll('dialog[open]')].map(n => n.className),
        conceptItems: document.querySelector('aithema-session').session.concepts?.length } : { route: location.pathname };
    });
    runs.push({ surface, state, locale, theme, width, height: width === 390 ? 844 : 1000, geometry, scene, ...result });
    // No visible product change in AIT-293. Enable only the affected surfaces if
    // a future fix changes their paint; evidence must not collect unrelated PNGs.
    const visibleChanges = [];
    if (shot && locale === 'de' && visibleChanges.includes(surface)) {
      const file = `a11y-${surface}-${state}-${locale}-${theme}-${width}.png`;
      await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file);
    }
    // Flush after every scene so partial evidence survives a remote interruption.
    await writeFile(join(evidence, 'a11y-audit.json'), JSON.stringify({ head: evidenceCommit, productBase: base, tags, scope: 'whole document including open shadow roots; counts are node observations per scene', runs }, null, 2));
    // Capture with blurred controls, then continue the visitor's keyboard path.
    await focused.evaluate(n => { if (n?.isConnected) n.focus?.({ preventScroll: true }); });
    await focused.dispose();
  };
  try {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await configure(locale, theme, 'entrance');
      await audit('entrance', 'presets', locale, theme, width, true);
      await configure(locale, theme, 'ready');
      await audit('entrance', 'readiness', locale, theme, width, true);
      await configure(locale, theme, 'ready-voice');
      await audit('entrance', 'readiness-voice', locale, theme, width);
      await configure(locale, theme);
      await audit('conversation', 'thread-composer-footer', locale, theme, width, true);
      await shadow(page, c => c.shadowRoot.querySelector('.ai-notice').click());
      await audit('conversation', 'footer-popup', locale, theme, width, true);
      await page.keyboard.press('Escape');
      for (const state of ['consent', 'paused', 'no-text']) {
        await configure(locale, theme, state);
        await audit('conversation', state, locale, theme, width, true);
      }
      await configure(locale, theme, 'live-voice');
      await audit('conversation', 'voice-rail', locale, theme, width);
      for (const state of ['rest', 'requesting', 'selected', 'asked', 'stale', 'retry', 'refused-paused', 'refused-consent', 'refused-deadline']) {
        await configure(locale, theme);
        if (state !== 'rest') await shadow(page, async (c, state) => {
          const item = c.openQuestionItems[1], revision = c.session.operations.inputRevision;
          window.a11yFocusPromise = c.focusQuestion(item.id).catch(() => {});
          if (state === 'requesting') return;
          const receive = (type, data) => c.receive({ seq: c.session.seq + 1, type, data });
          if (state === 'stale' || state.startsWith('refused')) {
            const reason = { stale: 'stale-question', 'refused-paused': 'paused', 'refused-consent': 'consent-required', 'refused-deadline': 'not-admitted' }[state];
            if (state === 'refused-paused') receive('session.paused', { paused: true });
            window.a11yFocusAck(Response.json({ error: 'focus-refused', reason, ...(state === 'refused-deadline' ? { admissionReason: 'one-hour' } : {}) }, { status: 409 }));
            await window.a11yFocusPromise; return;
          }
          window.a11yFocusAck(Response.json({ accepted: true, event: { seq: c.session.seq + 1, type: 'question.focused', data: {
            question: item.question, questionId: item.id, requestId: 'a11y-focus', chosenBy: 'user', inputRevision: revision,
          } } }, { status: 202 }));
          await window.a11yFocusPromise;
          const lane = (running, failures = []) => c.receive({ type: 'lane.status', data: { inputRevision: revision, running, failures, lastFailure: failures.at(-1) ?? null } });
          lane(['reaction']);
          if (state === 'retry') { lane([], [{ lane: 'reaction', error: 'reasoning-unavailable', retryable: true }]); return; }
          if (state === 'asked') {
            receive('turn.final', { id: 'focused', role: 'assistant', content: 'Who approves invoices?', inputRevision: revision, focusRequestId: 'a11y-focus' }); lane([]);
          }
        }, state);
        await audit('overview', state, locale, theme, width, state === 'rest' || state === 'retry');
      }
      await configure(locale, theme);
      await shadow(page, c => c.openSettings());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.select__value')?.textContent);
      await audit('settings', 'model-gauges', locale, theme, width, true);
      const controls = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.select__button')].map(n => ({
        id: n.id, target: n.getAttribute('aria-controls'), exists: Boolean(c.shadowRoot.getElementById(n.getAttribute('aria-controls'))),
      })));
      assert.ok(controls.every(n => n.exists));
      await shadow(page, c => c.shadowRoot.querySelector('[data-select="model"] button').click());
      await audit('settings', 'model-options', locale, theme, width, true);
      await page.keyboard.press('Escape');
      await shadow(page, c => c.shadowRoot.querySelector('[data-tab="general"]').click());
      await audit('settings', 'general-consent', locale, theme, width, true);
      await page.keyboard.press('Escape');
      await configure(locale, theme, 'consent');
      await audit('consent', 'opener', locale, theme, width, true);
      await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text .consent-action').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.consent-editor input'));
      await audit('consent', 'dialog', locale, theme, width, true);
      await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.matches('.consent-action')), true, 'consent returns focus to its opener');
      for (const reason of ['one-hour', 'session', 'voiceVisitor', 'host-limit']) {
        await configure(locale, theme);
        await shadow(page, (c, reason) => {
          for (const [type, data] of [['credits.limit-reached', { reason }], ['conversation.end-requested', { reason, preserveTranscript: true, settleOutstanding: true }], ['credits.state', { status: 'ending', endReason: reason, remainingMs: 0 }]]) c.receive({ seq: c.session.seq + 1, type, data });
        }, reason);
        await audit('limits', reason, locale, theme, width, true);
      }
      await configure(locale, theme, 'live', true);
      await shadow(page, (c, width) => c.shadowRoot.querySelector(width === 390 ? '.settings-open' : '.actor-trigger').click(), width);
      await audit('actor-role', width === 390 ? 'phone-sheet' : 'popover', locale, theme, width, true);
      await page.keyboard.press('Escape');
      assert.equal(await shadow(page, (c, width) => c.shadowRoot.activeElement?.matches(width === 390 ? '.settings-open' : '.actor-trigger'), width), true, 'actor role returns focus to its opener');
      await configure(locale, theme, 'concept');
      await audit('concept', 'backdrop-access', locale, theme, width, true);
      await shadow(page, c => { const n = c.shadowRoot.querySelector('.concept-preview'); n.focus(); n.click(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-viewer').open);
      await audit('concept', 'viewer', locale, theme, width, true);
      await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.matches('.concept-preview')), true, 'viewer returns focus to its opener');
      await configure(locale, theme, 'draft');
      await audit('concept', 'draft-access', locale, theme, width);
      await shadow(page, c => { const n = c.shadowRoot.querySelector('.concept-preview'); n.focus(); n.click(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-viewer').open);
      await audit('concept', 'draft-viewer', locale, theme, width);
      await page.keyboard.press('Escape');
      manual.push({ locale, theme, width, dialogsClosedByEscape: true, consentFocusReturned: true, actorFocusReturned: true, conceptFocusReturned: true, ariaControls: controls });
    }
    // The consent page is a host route; use the same browser/page and local server.
    const session = await shadow(page, c => structuredClone(c.session));
    const consentDocument = { contract: 'a11y-page-fixture', items: [{ id: 'models-international', version: 1,
      title: 'Processing', recipients: 'Local fixture', text: 'Local accessibility evidence only.' }], selected: [] };
    let consentLocale = 'de';
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const json = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/demo/config') return json({ processingConsent: consentDocument });
      if (path === `/api/sessions/${session.id}`) return json({ ...session, locale: consentLocale });
      if (path.endsWith('/consent')) return json(consentDocument);
      return request.continue();
    });
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      consentLocale = locale;
      await page.evaluate(({ locale, theme }) => { localStorage.setItem('aithema-demo-locale', locale); localStorage.setItem('aithema-demo-theme', theme); }, { locale, theme });
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(`${demo.url}/demo/consent.html?session=${session.id}`, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('#consent-status')?.dataset.state === 'ready');
      await page.select('#locale', locale); await page.select('#theme', theme);
      await page.addScriptTag({ path: axePath });
      await audit('consent', 'page', locale, theme, width, true);
    }
    assert.deepEqual(errors, []);
    const passLines = [`PASS: ${runs.length} WCAG 2.2 AA evidence scenes, DE/EN, 1440/390, light/dark; no provider calls`, 'PASS: evidence only; CI never imports or runs axe; viewport shots, reduced motion, pinned component fonts, blurred controls'];
    await writeFile(join(evidence, 'a11y-checks.json'), JSON.stringify({ head: evidenceCommit, tags, passLines, shots, manual }, null, 2));
    for (const line of passLines) console.log(`AIT-293 ${line}`);
  } finally { await browser.close(); await demo.kill(); }
}
