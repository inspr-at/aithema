import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(requestAnimationFrame);
});

test('AIT-173: large voice hold, reconciling and genuine low; DE/EN L/D 390/1024/1440; 0 px shift', { timeout: process.env.AITHEMA_EVIDENCE_DIR && !process.env.CI ? 600_000 : 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-credit-hold-'));
  const fixture = await startChild(new URL('../fixtures/credit-hold.js', import.meta.url), join(directory, 'unused.sqlite'));
  let browser;
  t.after(async () => { await browser?.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, realLongWait = Boolean(evidence && !process.env.CI), passes = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), errors = [], loadErrors = [];
  // Accelerate the 15 s credit/admission polls; unit coverage verifies their real cadence.
  await page.evaluateOnNewDocument(realLongWait => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => interval(callback, ms === 15_000 ? 1000 : ms, ...args);
    const timeout = window.setTimeout.bind(window);
    window.__longWait = null;
    window.setTimeout = (callback, ms, ...args) => {
      if (ms === 60_000) {
        let timer;
        window.__reconcilingStarted = Date.now();
        window.__longWait = () => { window.clearTimeout(timer); callback(...args); };
        timer = timeout(realLongWait ? window.__longWait : () => {}, 60_000);
        return timer;
      }
      return timeout(callback, ms, ...args);
    };
  }, realLongWait);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) loadErrors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => loadErrors.push(`${request.failure()?.errorText} ${request.url()}`));
  const moduleResponse = await fetch(`${fixture.url}/packages/ui/src/session-element.js`);
  assert.equal(moduleResponse.status, 200, `Fixture UI module: ${await moduleResponse.text()}`);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  // Surface a failed module load directly instead of a registry polling timeout.
  try { await page.evaluate(() => import('/packages/ui/src/session-element.js')); }
  catch (cause) { throw new Error(`Fixture module startup: ${JSON.stringify({ errors, loadErrors })}`, { cause }); }
  await until(page, () => Boolean(document.querySelector('aithema-session')?.shadowRoot));
  for (const locale of ['de', 'en']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    let baseline;
    for (const state of ['in-call', 'reconciling', 'reconciling-blocked', 'low', 'full-hold']) {
      await shadow(page, async (c, { locale, state }) => {
        const { session } = await (await fetch(`/fixture?state=${state}&locale=${locale}`)).json();
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const { voiceEvents } = await import('/packages/core/src/live-voice.js');
        session.locale = locale; session.demo = false; session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
        const verdict = state === 'reconciling-blocked' ? { available: false, reason: 'budget denied' } : { available: true };
        session.featureMatrix = { best: { text: verdict, analysis: { available: true }, voice: { available: true } } };
        const voiceClient = { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native' } } },
          async start(request) { const events = voiceEvents(); return { callId: request.callId, providerSessionId: 'hold-fixture', events,
            async setInput() {}, async setOutput() {}, async heartbeat() {}, async updateContext() {},
            async close() { events.end(); return { closureConfirmed: false, outcome: 'uncertain', usage: null }; } }; } };
        c.setAttribute('motion', 'off');
        c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery: false, privacyDocumentConfigured: true } } });
        const legal = document.createElement('a'); legal.slot = 'legal'; legal.href = '/privacy'; legal.setAttribute('data-aithema-privacy', ''); c.replaceChildren(legal);
        c.shadowRoot.querySelector('.voice-start').click();
      }, { locale, state });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.trim() !== '…');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      if (state.startsWith('reconciling')) {
        const immediate = await shadow(page, c => {
          const root = c.shadowRoot, rects = () => ['.composer-shell', '.display-foot', '.host-credits', '.audio-rail'].map(selector => {
            const r = root.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
          });
          const before = rects(); root.querySelector('.voice-close').click(); const after = rects();
          return { usedUp: root.querySelector('.composer-shell').hasAttribute('data-used-up'), ask: root.querySelector('.workspace').dataset.emailAsk,
            shift: Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j])))) };
        });
        assert.equal(immediate.usedUp, false, 'synchronous hangup has no used-up panel');
        assert.equal(immediate.ask, 'closed', 'synchronous hangup has no email ask');
        assert.equal(immediate.shift, 0, 'synchronous hangup preserves the slot height');
        await until(page, () => /abgeglichen|reconciled/u.test(document.querySelector('aithema-session').shadowRoot.querySelector('.voice-state').textContent));
      }
      if (state === 'reconciling-blocked') await until(page, () => document.querySelector('aithema-session').session.featureMatrix.best.text.reason === 'budget reconciling');
      await settle(page);
      const targets = ['.composer-shell', '.display-foot', '.host-credits', '.audio-rail', '.host-credits__amount'];
      const capture = await shadow(page, (c, width) => {
        const root = c.shadowRoot;
        const gap = () => root.querySelector('.display-foot').getBoundingClientRect().top - root.querySelector('.composer-actions').getBoundingClientRect().bottom;
        let oldCaptureGapPx = null;
        if (width < 960) { root.querySelector('.composer-dock').scrollIntoView({ block: 'end' }); oldCaptureGapPx = gap();
          root.querySelector('.composer-dock').scrollIntoView({ block: 'center' }); }
        return { oldCaptureGapPx, composerFooterGapPx: gap(), scrollY: window.scrollY };
      }, width);
      await settle(page);
      const rects = await boxes(page, targets); baseline ??= rects;
      for (const theme of ['light', 'dark']) {
        await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
        const view = await shadow(page, c => ({ low: c.shadowRoot.querySelector('.host-credits').dataset.low,
          amount: c.shadowRoot.querySelector('.host-credits__amount').textContent,
          ask: c.shadowRoot.querySelector('.workspace').dataset.emailAsk,
          rail: c.shadowRoot.querySelector('.voice-state').textContent,
          ending: c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-credit-ending'),
          title: c.shadowRoot.querySelector('.host-credits__button').getAttribute('title'),
          description: c.shadowRoot.querySelector('.host-credits__button').getAttribute('aria-description'),
          footer: c.shadowRoot.querySelector('.host-credits').textContent,
          numericStyle: getComputedStyle(c.shadowRoot.querySelector('.host-credits__amount')).fontVariantNumeric,
          usedUp: c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up') }));
        assert.equal(view.low, state === 'low' ? 'true' : 'false', `${locale}/${width}/${state}: ${JSON.stringify(view)}`);
        assert.equal(view.usedUp, false); assert.equal(view.ending, false);
        if (state !== 'low') { assert.equal(view.ask, 'closed'); assert.equal(view.amount.replace(/[.,]/gu, ''), state === 'full-hold' ? '0' : '600'); assert.doesNotMatch(view.rail, /wenig|low|aufgebraucht|used up/iu); }
        else assert.match(view.rail, locale === 'de' ? /wenig/u : /low/u);
        const reconciliation = locale === 'de' ? 'Kosten werden noch abgeglichen' : 'Costs are still being reconciled';
        assert.equal(view.title, state.startsWith('reconciling') ? reconciliation : null);
        assert.equal(view.description, state.startsWith('reconciling') ? reconciliation : null);
        assert.equal(view.footer.includes(reconciliation), false, 'reconciliation has no visible footer hint');
        assert.match(view.numericStyle, /tabular-nums/u);
        if (state.startsWith('reconciling')) assert.match(view.rail, locale === 'de' ? /Kosten werden noch abgeglichen/u : /Costs are still being reconciled/u);
        let textAdmission = null;
        if (state.startsWith('reconciling')) {
          const admission = await shadow(page, c => ({ disabled: c.shadowRoot.querySelector('textarea').disabled,
            sendDisabled: c.shadowRoot.querySelector('.send').disabled,
            reason: c.shadowRoot.querySelector('.composer-reason').textContent, overview: c.shadowRoot.querySelector('.notice').textContent, features: c.shadowRoot.querySelector('.features').textContent }));
          assert.equal(admission.disabled, false, 'the draft stays editable during reconciliation');
          assert.equal(admission.sendDisabled, state === 'reconciling-blocked');
          assert.doesNotMatch(admission.reason + admission.overview + admission.features, /nach dem Anruf|after the call/u);
          if (state === 'reconciling-blocked') {
            assert.equal(admission.reason, locale === 'de' ? 'Einen Moment, die Kosten des Anrufs werden noch abgeglichen.' : "One moment, the call's costs are still being reconciled.");
            assert.doesNotMatch(admission.reason + admission.overview + admission.features, /aufgebraucht|used up/iu);
          }
          if (state === 'reconciling-blocked') {
            const overview = await shadow(page, c => ({ summary: c.shadowRoot.querySelector('.summary-text').textContent,
              slider: getComputedStyle(c.shadowRoot.querySelector('.readiness')).visibility,
              sectionHidden: c.shadowRoot.querySelector('.summary').hidden, retry: c.shadowRoot.querySelector('.retry').hidden }));
            assert.ok(overview.summary.length > 0, 'the overview retains its last summary');
            assert.equal(overview.slider, 'visible'); assert.equal(overview.sectionHidden, false); assert.equal(overview.retry, true);
            assert.doesNotMatch(admission.overview, /Einen Moment|One moment|nicht verfügbar|unavailable/iu);
          }
          textAdmission = admission;
          if (state.startsWith('reconciling')) {
            const typed = locale === 'de' ? 'Ich tippe während des Kostenabgleichs.' : 'Typed while costs reconcile.';
            await shadow(page, c => { c.shadowRoot.querySelector('textarea').value = ''; });
            await shadow(page, c => c.shadowRoot.querySelector('textarea').focus());
            await page.keyboard.type(typed);
            assert.equal(await shadow(page, c => c.shadowRoot.querySelector('textarea').value), typed);
            textAdmission.typed = typed;
            await settle(page);
          }
        }
        const controls = await shadow(page, c => {
          const root = c.shadowRoot, visible = selector => getComputedStyle(root.querySelector(selector)).visibility !== 'hidden';
          return { state: root.querySelector('.audio-rail').dataset.state, call: root.querySelector('.audio-rail').dataset.call,
            pauseVisible: visible('.pause'), pauseBackground: getComputedStyle(root.querySelector('.pause')).backgroundColor,
            micVisible: visible('.voice-input'), startVisible: visible('.voice-start'), stopVisible: visible('.voice-close') };
        });
        if (state.startsWith('reconciling')) { assert.equal(controls.call, 'none'); assert.equal(controls.micVisible, false);
          assert.equal(controls.startVisible, true); assert.equal(controls.stopVisible, false); }
        if (width === 390 && state === 'reconciling') {
          const fit = await shadow(page, c => { const r = c.shadowRoot.querySelector('.composer-shell').getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, footerTop: c.shadowRoot.querySelector('.display-foot').getBoundingClientRect().top }; });
          assert.ok(fit.top >= 0 && fit.bottom <= fit.footerTop, `390 composer fully visible: ${JSON.stringify(fit)}`);
        }
        const after = await boxes(page, targets), shift = Math.max(...baseline.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
        assert.equal(shift, 0, `${locale}/${width}/${state}: layout shift ${shift} px`);
        const pass = { ...capture, controls, textAdmission, head: evidenceCommit, locale, width, theme, state, layoutShiftPx: shift, tooltip: view.title, accessibleDescription: view.description, amount: view.amount, numericStyle: view.numericStyle, pass: true }; passes.push(pass);
        console.log(`AIT-173 PASS ${locale} ${theme} ${width} ${state}: hold-safe credits; no used-up wording or email ask while reconciling; footer tooltip=${view.title ?? "none"}; shift=${shift}px; composer gap=${capture.composerFooterGapPx}px; old capture gap=${capture.oldCaptureGapPx ?? 'n/a'}px`);
        if (evidence) await page.screenshot({ path: join(evidence, `ait173-${locale}-${theme}-${width}-${state}.png`), fullPage: false, captureBeyondViewport: false });
      }
      if (state === 'reconciling-blocked') {
        const before = await boxes(page, targets);
        if (realLongWait && width !== 1024) {
          await page.waitForFunction(() => /noch nicht bestätigt|aren't confirmed yet/u.test(document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent), { polling: 100, timeout: 65_000 });
        } else await page.evaluate(() => window.__longWait());
        await settle(page);
        const long = await shadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-reason'), range = document.createRange(); range.selectNodeContents(reason);
          const lines = new Set([...range.getClientRects()].map(r => r.top));
          return { text: reason.textContent, elapsedMs: Date.now() - window.__reconcilingStarted, lines: lines.size, scrollHeight: reason.scrollHeight, clientHeight: reason.clientHeight,
            overview: c.shadowRoot.querySelector('.notice').textContent, retry: c.shadowRoot.querySelector('.retry').hidden };
        });
        assert.equal(long.text, locale === 'de' ? 'Die Anrufkosten sind noch nicht bestätigt. Ihr Text bleibt erhalten.' : "The call's costs aren't confirmed yet. Your text is kept.");
        if (realLongWait && width !== 1024) assert.ok(long.elapsedMs >= 60_000, `real long wait elapsed ${long.elapsedMs}ms`);
        if (width === 390) { assert.ok(long.lines <= 2, `long wait has ${long.lines} lines`); assert.ok(long.scrollHeight <= long.clientHeight + 1, 'the long-wait text fits without scrolling'); }
        assert.doesNotMatch(long.overview, /nicht verfügbar|unavailable|bestätigt|confirmed/iu); assert.equal(long.retry, true);
        const after = await boxes(page, targets), shift = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
        assert.equal(shift, 0);
        for (const theme of ['light', 'dark']) {
          await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
          passes.push({ head: evidenceCommit, locale, width, theme, state: 'long-wait', ...long, layoutShiftPx: shift, real60Seconds: Boolean(realLongWait && width !== 1024), pass: true });
          if (evidence) await page.screenshot({ path: join(evidence, `ait173-${locale}-${theme}-${width}-long-wait.png`), fullPage: false, captureBeyondViewport: false });
        }
        console.log(`AIT-173 PASS ${locale} ${width} long wait: exact copy; ${long.lines} lines; overview kept; no error or retry; shift=${shift}px`);
      }
      if (state.startsWith('reconciling')) {
        const before = await boxes(page, targets);
        const draft = await shadow(page, c => c.shadowRoot.querySelector('textarea').value);
        // Only change the server ledger. Polling must restore admission without a close/end signal.
        await page.evaluate(() => fetch('/reconcile'));
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.trim() === '595');
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.send').disabled, 25_000);
        await settle(page);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('textarea').value), draft, 'settlement keeps the draft');
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__button').hasAttribute('title')), false);
        const overview = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
          retry: c.shadowRoot.querySelector('.retry').hidden, summary: c.shadowRoot.querySelector('.summary-text').textContent }));
        assert.doesNotMatch(overview.notice, /nicht verfügbar|unavailable/iu); assert.equal(overview.retry, true, 'settlement offers no manual retry');
        assert.ok(overview.summary.length > 0);
        const after = await boxes(page, targets), shift = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
        assert.equal(shift, 0, `${locale}/${width}: settlement shifted the credit number by ${shift}px`);
        for (const theme of ['light', 'dark']) {
          await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
          passes.push({ head: evidenceCommit, locale, width, theme, state: `${state}-settled`, draftKept: true, sendReenabled: true, layoutShiftPx: shift, pass: true });
          if (evidence) await page.screenshot({ path: join(evidence, `ait173-${locale}-${theme}-${width}-${state}-settled.png`), fullPage: false, captureBeyondViewport: false });
        }
        console.log(`AIT-173 PASS ${locale} ${width} ${state} settled: draft kept; send re-enabled automatically; overview kept; no error or retry; tooltip cleared; shift=${shift}px`);
      }
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait173-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});
