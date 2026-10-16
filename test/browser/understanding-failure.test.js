import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
});

const captureViewport = async (page, options) => {
  await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
  await page.mouse.move(-1, -1);
  await settle(page);
  return page.screenshot(options);
};

test('AIT-242 project action preserves the footer and Retry geometry, configured or absent, DE/EN 390/1440', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-project-footer-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    const configure = enabled => shadow(page, async (c, locale, enabled) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      session.transcript = [{ id: 'person', role: 'user', content: 'A bakery preorder app.' }, { id: 'reply', role: 'assistant', content: 'Which payment methods?' }];
      session.transcript[1].inputRevision = inputRevision(session);
      session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
      Object.assign(session.understanding, { inputRevision: inputRevision(session), summary: 'A bakery preorder app.', readinessAssessed: true });
      c.setAttribute('motion', 'off'); c.setAttribute('theme', 'light');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy, ...(enabled ? { paimosImportUrl: 'https://paimos.example.test/import/project-draft', paimosImportVersion: 1 } : {}) });
    }, locale, enabled);
    const targets = ['.understanding', '.understanding > .foot', '.composer-shell', '.display-foot', '.audio-rail'];
    let baseline, retryBaseline;
    for (const enabled of [false, true]) {
      await configure(enabled); await settle(page);
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.create-project'))), enabled, 'unconfigured hosts have no project action');
      const normal = await boxes(page, targets);
      if (!enabled) baseline = normal;
      else assert.deepEqual(normal, baseline, 'enabling the project action adds 0 px to the existing footer row');
      for (const state of ['failure', 'pending', 'normal']) {
        await shadow(page, (c, state) => c.receive({ type: 'lane.status', data: {
          inputRevision: c.session.operations.inputRevision, running: state === 'pending' ? ['understanding'] : [],
          failures: state === 'failure' ? [{ lane: 'reaction', error: 'reasoning-unavailable', retryable: true }] : [],
          lastFailure: state === 'failure' ? { lane: 'reaction', error: 'reasoning-unavailable', retryable: true } : null,
        } }), state);
        await settle(page);
        assert.deepEqual(await boxes(page, targets), baseline, `${locale}/${width}/${enabled}/${state}: 0 px surrounding and footer displacement`);
        const action = await shadow(page, c => {
          const create = c.shadowRoot.querySelector('.create-project'), retry = c.shadowRoot.querySelector('.retry');
          const foot = retry.parentElement.getBoundingClientRect(), link = c.shadowRoot.querySelector('.export').getBoundingClientRect();
          const rect = create?.getBoundingClientRect();
          return { retryHidden: retry.hidden, createVisible: Boolean(create?.getClientRects().length),
            sameRow: !rect || !rect.height || (innerWidth < 480 ? rect.top >= link.bottom : rect.top === link.top) && rect.bottom <= foot.bottom && rect.right <= foot.right,
            overlap: Boolean(rect?.width && rect.left < link.right && rect.top < link.bottom) };
        });
        assert.equal(action.retryHidden, state !== 'failure');
        assert.equal(action.createVisible, enabled && state !== 'failure', 'footer Retry owns the action space during a failure');
        assert.equal(action.sameRow, true); assert.equal(action.overlap, false);
        if (state === 'failure') {
          const retry = await boxes(page, ['.retry']);
          if (!enabled) retryBaseline = retry;
          else assert.deepEqual(retry, retryBaseline, 'project configuration changes Retry position by exactly 0 px');
        }
        if (evidence && enabled) {
          await shadow(page, c => c.shadowRoot.querySelector('.understanding > .foot').scrollIntoView({ block: 'center' }));
          await captureViewport(page, { path: join(evidence, `ait242-${locale}-${width}-${state}-footer.png`), fullPage: false, captureBeyondViewport: false });
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await settle(page);
        }
      }
      console.log(`AIT-242 FOOTER PASS ${locale} ${width} configured=${enabled}: normal/failure/pending 0 px; Retry position unchanged`);
    }
  }
});

test('AIT-198 failed overview: DE/EN 390/1440, immediate free visitor settlement, retry recovery and 0 px', { timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-understanding-failure-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [], passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) for (const verdict of ['uncertain', 'failed']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale) => {
      const response = await fetch('/fixture?locale=' + locale);
      if (!response.ok) throw new Error('Fixture setup failed: ' + await response.text());
      const session = await response.json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.configure({ session, copy, host: { credits: true } });
      window.fixtureComponent = c;
    }, locale);
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.includes('…'));
    await settle(page);
    if (width === 390) await shadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
    const targets = ['.understanding', '.composer-shell', '.display-foot', '.host-credits', '.audio-rail'];
    const before = await boxes(page, targets);
    const held = await shadow(page, c => c.shadowRoot.querySelector('.host-credits__amount').textContent);
    await shadow(page, c => {
      const input = c.shadowRoot.querySelector('textarea'); input.focus({ preventScroll: true }); input.value = 'I am still typing';
      window.retryFocusPulls = [];
      c.shadowRoot.addEventListener('focusin', event => { if (event.target.matches('.overview-retry, .retry')) window.retryFocusPulls.push(event.target.className); });
    });
    await page.evaluate((verdict, held) => { window.heldCredits = held; return fetch('/settle?verdict=' + verdict); }, verdict, held);
    const expected = locale === 'de' ? 'Der Überblick konnte gerade nicht erstellt werden · Erneut versuchen' : "The overview couldn't be built just now · Try again";
    await page.waitForFunction(expected => document.querySelector('aithema-session').shadowRoot.querySelector('.notice').textContent === expected, { timeout: 10_000 }, expected);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent !== window.heldCredits, undefined);
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'failure never pulls focus from the composer');
    assert.deepEqual(await page.evaluate(() => window.retryFocusPulls), [], 'no intermediate Retry focus');
    const failed = await shadow(page, c => {
      const r = c.shadowRoot, n = r.querySelector('.notice'), s = getComputedStyle(n);
      const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;color:var(--aithema-muted)'; r.querySelector('.understanding').append(probe);
      const quietInk = getComputedStyle(probe).color; probe.remove();
      return { amount: r.querySelector('.host-credits__amount').textContent, color: s.color, quietInk,
        background: s.backgroundColor, alerts: r.querySelectorAll('.understanding [role="alert"]').length, reload: c === window.fixtureComponent };
    });
    assert.notEqual(failed.amount, held, 'same settlement releases the held visitor credits');
    const balance = await page.evaluate(async () => (await (await fetch(`/api/sessions/${document.querySelector('aithema-session').session.id}/credits`)).json()).balance.owner);
    assert.equal(balance.confirmedSpendMicro, (passes.length + 1) * 100_000 + passes.length * 100_000, 'only successful replies and previous successful analyses charge the visitor');
    assert.equal(failed.amount, new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.floor(balance.availableMicro / 10_000)), 'footer shows the authoritative released balance');
    assert.equal(balance.uncertainSpendMicro, 0); assert.equal(balance.reservedMicro, 0);
    assert.equal(failed.color, failed.quietInk);
    assert.equal(failed.alerts, 0); assert.equal(failed.background, 'rgba(0, 0, 0, 0)'); assert.equal(failed.reload, true);
    assert.deepEqual(await boxes(page, targets), before, 'failed overview causes 0 px surrounding displacement');
    await shadow(page, c => {
      const retry = c.shadowRoot.querySelector('.overview-retry');
      retry.focus(); window.focusedOverviewRetry = retry;
      c.receive({ type: 'lane.status', data: c.session.operations });
    });
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === window.focusedOverviewRetry && c.shadowRoot.querySelector('.overview-retry') === window.focusedOverviewRetry), true, 'inline retry retains keyboard focus across live renders');
    if (evidence) await captureViewport(page, { path: join(evidence, `ait198-${locale}-${width}-${verdict}.png`), fullPage: false, captureBeyondViewport: false });
    await page.evaluate(() => fetch('/success'));
    const retry = await shadow(page, c => ({ inlineDisabled: c.shadowRoot.querySelector('.overview-retry').disabled, footerDisabled: c.shadowRoot.querySelector('.retry').disabled, operations: c.session.operations, features: c.session.featureMatrix }));
    assert.equal(retry.inlineDisabled, false, JSON.stringify(retry)); assert.equal(retry.footerDisabled, false, JSON.stringify(retry));
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/retry'), { timeout: 5000 }), shadow(page, c => c.shadowRoot.querySelector('.overview-retry').click())]);
    assert.equal(response.status(), 202);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.summary-text').textContent === 'Ein Überblick. An overview.');
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), locale === 'de' ? 'Aktuelle Einschätzung' : 'Current assessment');
    assert.deepEqual(await boxes(page, targets), before, 'next success causes 0 px surrounding displacement');
    assert.equal(await shadow(page, c => c === window.fixtureComponent), true);
    const pass = { head: evidenceCommit, locale, width, verdict, visitorCharge: 0, layoutShiftPx: 0, recoveredWithoutReload: true, pass: true };
    passes.push(pass); console.log(`AIT-198 PASS ${locale} ${width} ${verdict}: quiet failure, hold released on settle, next success without reload, 0 px`);
    if (evidence) await captureViewport(page, { path: join(evidence, `ait198-${locale}-${width}-${verdict}-recovered.png`), fullPage: false, captureBeyondViewport: false });
  }
  assert.equal(passes.length, 8);
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait198-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});

test('AIT-198 stuck overview: missing reply, nothing running, no failure; DE/EN 390/1440, one inline Retry and 0 px', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-stuck-overview-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true, reason: null }, analysis: { available: true, reason: null } } };
      session.transcript.push({ id: 'stuck-person', role: 'user', content: 'Wir möchten die Auftragsbearbeitung vereinfachen.' });
      session.operations = { inputRevision: inputRevision(session), running: ['reaction'], lastFailure: null };
      c.setAttribute('motion', 'off'); c.configure({ session, copy });
    }, locale);
    await settle(page);
    if (width === 390) await shadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
    const targets = ['.understanding', '.composer-shell', '.display-foot', '.audio-rail'];
    const before = await boxes(page, targets);
    await shadow(page, c => {
      const input = c.shadowRoot.querySelector('textarea'); input.focus({ preventScroll: true }); input.value = 'Ich schreibe weiter';
      window.retryFocusPulls = [];
      c.shadowRoot.addEventListener('focusin', event => { if (event.target.matches('.overview-retry, .retry')) window.retryFocusPulls.push(event.target.className); });
      c.receive({ type: 'lane.status', data: { inputRevision: c.session.operations.inputRevision, running: [], lastFailure: null } });
    });
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'stuck state never pulls focus from the composer');
    assert.deepEqual(await page.evaluate(() => window.retryFocusPulls), [], 'no intermediate Retry focus');
    await settle(page);
    const expected = locale === 'de' ? 'Der Überblick konnte gerade nicht erstellt werden · Erneut versuchen' : "The overview couldn't be built just now · Try again";
    const state = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      inline: c.shadowRoot.querySelectorAll('.notice .overview-retry').length,
      disabled: c.shadowRoot.querySelector('.overview-retry')?.disabled,
      footerHidden: c.shadowRoot.querySelector('.retry').hidden, operations: c.session.operations }));
    assert.equal(state.notice, expected);
    assert.equal(state.inline, 1); assert.equal(state.disabled, false); assert.equal(state.footerHidden, true);
    assert.equal(state.operations.lastFailure, null); assert.deepEqual(state.operations.running, []);
    assert.deepEqual(await boxes(page, targets), before, 'idle stuck state causes exactly 0 px displacement');
    if (evidence) await captureViewport(page, { path: join(evidence, `ait198-${locale}-${width}-stuck.png`), fullPage: false, captureBeyondViewport: false });
    passes.push({ head: evidenceCommit, locale, width, missingReply: true, running: [], lastFailure: null, inlineRetries: 1, layoutShiftPx: 0, pass: true });
  }
  assert.equal(passes.length, 4);
  if (evidence) await writeFile(join(evidence, 'ait198-stuck-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});

for (const kind of ['typed', 'live voice', 'facade pending', 'spoken facade pending']) test(`AIT-198 ${kind}: no false failure during reply event gaps, DE/EN 390/1440`, { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-reply-gap-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale, kind) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      if (kind === 'live voice') session.voiceLifecycle = { callId: 'call', providerSessionId: 'provider', epoch: 1, state: 'active' };
      c.setAttribute('motion', 'off'); c.configure({ session, copy });
      window.gapStates = [];
      window.captureGap = phase => {
        const r = c.shadowRoot;
        window.gapStates.push({ phase, notice: r.querySelector('.notice').textContent,
          inlineHidden: r.querySelector('.overview-retry').hidden, footerHidden: r.querySelector('.retry').hidden });
      };
      c.receive({ seq: 1, type: 'turn.final', data: { id: 'person', role: 'user', content: 'Wir vereinfachen die Auftragsbearbeitung.',
        ...(kind === 'facade pending' ? { voiceCallId: 'call', voiceProviderId: 'provider' } :
          kind === 'spoken facade pending' ? { callId: 'call', providerSessionId: 'provider' } : {}) } });
      window.captureGap('person final before lane.status');
      window.gapRevision = inputRevision(c.session);
    }, locale, kind);
    await settle(page);
    const targets = ['.understanding', '.composer-shell', '.display-foot', '.audio-rail'];
    const before = await boxes(page, targets);
    await shadow(page, (c, kind) => {
      window.captureGap('paint before lane.status');
      c.receive({ type: 'lane.status', data: { inputRevision: window.gapRevision, running: kind === 'typed' ? ['reaction'] : [], lastFailure: null } });
      window.captureGap('lane.status');
      c.receive({ type: 'turn.partial', data: { id: 'reply', inputRevision: window.gapRevision, delta: 'Welche Arbeit?' } });
      window.captureGap('assistant partial');
    }, kind);
    await settle(page);
    assert.deepEqual(await boxes(page, targets), before, 'pending reply causes exactly 0 px surrounding displacement');
    await shadow(page, c => {
      window.captureGap('paint before assistant final');
      c.receive({ seq: 2, type: 'understanding.updated', data: { ...c.session.understanding, inputRevision: window.gapRevision } });
      c.receive({ seq: 3, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Welche Arbeit?', inputRevision: window.gapRevision } });
      c.receive({ type: 'lane.status', data: { inputRevision: window.gapRevision, running: [], lastFailure: null } });
      window.captureGap('assistant final');
    });
    for (const state of await page.evaluate(() => window.gapStates)) {
      assert.equal(state.inlineHidden, true, `${kind} ${locale}/${width}: ${state.phase}`);
      assert.equal(state.footerHidden, true, `${kind} ${locale}/${width}: ${state.phase}`);
      assert.doesNotMatch(state.notice, /couldn't be built|konnte gerade nicht erstellt/iu, `${kind}: ${state.phase}`);
    }
  }
});

for (const kind of ['live voice', 'waiting voice', 'facade pending', 'spoken facade pending']) test(`AIT-198 ${kind}: recorded reaction failure keeps footer Retry, DE/EN 390/1440`, { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-reaction-retry-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), passes = [];
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale, kind) => {
      const { createSession, inputRevision } = await import('/packages/core/src/index.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true, locale });
      session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
      if (kind.endsWith('voice')) session.voiceLifecycle = { callId: 'call', providerSessionId: 'provider', epoch: 1,
        state: kind === 'waiting voice' ? 'waiting' : 'active' };
      session.transcript.push({ id: 'person', role: 'user', content: 'Wir vereinfachen die Auftragsbearbeitung.',
        ...(kind === 'facade pending' ? { voiceCallId: 'call', voiceProviderId: 'provider' } :
          kind === 'spoken facade pending' ? { callId: 'call', providerSessionId: 'provider' } : {}) });
      session.operations = { inputRevision: inputRevision(session), running: [], lastFailure: null };
      c.setAttribute('motion', 'off'); c.setAttribute('theme', 'light'); c.configure({ session, copy });
      window.reactionFailureCopy = copy.reasoningFailed;
    }, locale, kind);
    await settle(page);
    const pending = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      inlineHidden: c.shadowRoot.querySelector('.overview-retry').hidden, footerHidden: c.shadowRoot.querySelector('.retry').hidden }));
    assert.equal(pending.inlineHidden, true, `${kind} ${locale}/${width}: no false inline Retry while waiting`);
    assert.equal(pending.footerHidden, true, `${kind} ${locale}/${width}: no footer Retry without a failure`);
    assert.doesNotMatch(pending.notice, /couldn't be built|konnte gerade nicht erstellt/iu, `${kind}: no false failure while waiting`);
    const targets = ['.understanding', '.composer-shell', '.display-foot', '.audio-rail'];
    const before = await boxes(page, targets);
    await shadow(page, c => c.receive({ type: 'lane.status', data: { inputRevision: c.session.operations.inputRevision,
      running: [], lastFailure: { lane: 'reaction', error: 'reasoning-unavailable', retryable: true } } }));
    await settle(page);
    const failed = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      expected: window.reactionFailureCopy, occurrences: c.shadowRoot.textContent.split(window.reactionFailureCopy).length - 1,
      replyNotice: c.shadowRoot.querySelector('.reaction-failure').textContent,
      retries: [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length, inlineHidden: c.shadowRoot.querySelector('.overview-retry').hidden,
      footerHidden: c.shadowRoot.querySelector('.retry').hidden, footerDisabled: c.shadowRoot.querySelector('.retry').disabled }));
    assert.equal(failed.replyNotice, failed.expected, `${kind} ${locale}/${width}: recorded reaction failure notice`);
    assert.equal(failed.occurrences, 1, 'reply failure sentence appears exactly once across the UI');
    assert.equal(pending.notice, locale === 'de' ? 'Ihr Überblick wird erstellt …' : 'Preparing your overview …', 'normal pending overview copy');
    assert.equal(failed.notice, locale === 'de' ? 'Der Überblick folgt, sobald die Antwort da ist.' : 'The overview follows once the reply is in.', 'overview waits behind the failed reply');
    assert.equal(failed.retries, 1, 'exactly one Retry');
    assert.equal(failed.inlineHidden, true, `${kind} ${locale}/${width}: reaction failure uses footer Retry`);
    assert.equal(failed.footerHidden, false, `${kind} ${locale}/${width}: recorded reaction failure keeps footer Retry`);
    assert.equal(failed.footerDisabled, false, `${kind} ${locale}/${width}: footer Retry is enabled`);
    assert.deepEqual(await boxes(page, targets), before, 'single reply failure causes 0 px surrounding displacement');
    passes.push({ head: evidenceCommit, kind, locale, width, theme: 'light', failureSentences: 1, retries: 1, layoutShiftPx: 0, pass: true });
    console.log(`AIT-212 PASS single reply failure ${kind} ${locale} ${width} light: sentence once, one Retry, 0 px`);
    if (evidence && kind === 'waiting voice' && locale === 'de') await captureViewport(page, { path: join(evidence, `ait212-de-${width}-reply-failure-light.png`), fullPage: false, captureBeyondViewport: false });
  }
  if (evidence) await writeFile(join(evidence, `ait212-reply-failure-${kind.replaceAll(' ', '-')}-passes.json`), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});


test('AIT-212 failed paid lane survives reconnect until explicit Retry, DE/EN 390/1440 L/D', { timeout: 150_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-reconnect-failure-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const kind of ['failed', '400', '408', '499', 'uncertain']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale, theme) => {
      const session = await (await fetch('/fixture?locale=' + locale)).json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme);
      c.configure({ session, copy, host: { credits: true } });
      window.failedCopy = `${copy.understandingFailed} · ${copy.understandingRetry}`;
    }, locale, theme);
    await page.evaluate(kind => fetch('/settle?verdict=' + kind), kind);
    await until(page, () => document.querySelector('aithema-session').session.operations?.lastFailure?.lane === 'understanding');
    const before = await page.evaluate(async () => (await fetch('/stats')).json());
    const credits = () => page.evaluate(async () => (await (await fetch(`/api/sessions/${document.querySelector('aithema-session').session.id}/credits`)).json()).balance.owner);
    const creditsAfterFailure = await credits();
    const failedAttempt = before.attempts.at(-1);
    assert.equal(failedAttempt.state, 'settled');
    if (kind === '400') assert.equal(failedAttempt.settled_micro, 0, 'fully received 4xx without usage settles at zero');
    else assert.equal(failedAttempt.settled_micro, kind === 'failed' ? 100_000 : locale === 'de' ? 802_567 : 802_568, 'exact usage or conservative provider settlement');
    // Restart real handlers and reopen SQLite before the client reconnects.
    await page.evaluate(() => fetch('/restart'));
    // A healthy fake on reconnect makes a silent rerun finish deterministically.
    await page.evaluate(() => fetch('/success'));
    const connected = page.waitForResponse(r => r.url().endsWith('/events') && r.status() === 200);
    await shadow(page, c => { c.remove(); document.body.append(c); });
    await connected;
    const after = await page.evaluate(async () => (await fetch('/stats')).json());
    // Boot imports already embedded receipts and acknowledges them locally. This
    // legitimately adds reconciliation metadata without another provider call or
    // changing the settlement. The bounded boot pass can defer an acknowledgement.
    // Compare both JSON fields, allowing exactly that local acknowledgement.
    const acknowledged = new Set(after.attempts.filter(a => JSON.parse(a.provider_cost_json)?.reconciled === 1).map(a => a.attempt_id));
    const billing = (stats, boot = false) => ({ providerCalls: stats.providerCalls,
      attempts: stats.attempts.map(attempt => {
        let provider = JSON.parse(attempt.provider_cost_json), cost = JSON.parse(attempt.cost_reconciliation_json);
        if (boot && acknowledged.has(attempt.attempt_id) && provider && !provider.reconciled && (provider.chargedMicro !== undefined || attempt.outcome !== 'uncertain')) {
          cost = { chargedMicro: provider.chargedMicro ?? attempt.settled_micro,
            ...(provider.generationId ? { generationId: provider.generationId } : {}) };
          provider = { ...provider, reconciled: 1, retryAt: null, retryAttempts: provider.retryAttempts ?? 0 };
        }
        return { ...attempt, provider_cost_json: provider, cost_reconciliation_json: cost };
      }) });
    assert.deepEqual(billing(after), billing(before, true), 'restart/reconnect only acknowledges existing receipts; zero provider calls, admissions or settlements');
    const creditsAfterReconnect = await credits();
    assert.deepEqual(creditsAfterReconnect, creditsAfterFailure, 'restart/reconnect never charges credits');
    await settle(page);
    const failed = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      expected: window.failedCopy, retries: [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length,
      enabled: !c.shadowRoot.querySelector('.overview-retry').disabled, failure: c.session.operations.lastFailure?.lane }));
    assert.equal(failed.notice, failed.expected); assert.equal(failed.retries, 1); assert.equal(failed.enabled, true); assert.equal(failed.failure, 'understanding');
    if (width === 390) await shadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
    await settle(page);
    if (evidence) await captureViewport(page, { path: join(evidence, `ait212-${locale}-${width}-${theme}-${kind}-reconnected.png`), fullPage: false, captureBeyondViewport: false });
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/retry')),
      shadow(page, c => c.shadowRoot.querySelector('.overview-retry').click())]);
    assert.equal(response.status(), 202);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.summary-text').textContent === 'Ein Überblick. An overview.');
    const retried = await page.evaluate(async () => (await fetch('/stats')).json());
    assert.equal(retried.providerCalls, before.providerCalls + 1);
    assert.equal(retried.attempts.length, before.attempts.length + 1);
    assert.equal(retried.attempts.at(-1).state, 'settled');
    passes.push({ head: evidenceCommit, locale, width, theme, kind, creditsAfterFailure: creditsAfterFailure.availableMicro, creditsAfterReconnect: creditsAfterReconnect.availableMicro, providerSettlementMicro: failedAttempt.settled_micro, settlement: kind === '400' ? 'zero: fully received 4xx without usage' : kind === 'failed' ? 'received usage' : 'conservative: timeout or uncertain', reconnectCalls: 0, reconnectSettlements: 0, retries: 1, explicitRetryAttempts: 1, pass: true });
    console.log(`AIT-212 PASS ${locale} ${width} ${theme} ${kind}: credits ${creditsAfterFailure.availableMicro} = ${creditsAfterReconnect.availableMicro}; provider settlement ${failedAttempt.settled_micro} (${passes.at(-1).settlement}); restart/reconnect 0 calls/settlements; one Retry; explicit Retry 1 settled attempt`);
  }
  if (evidence) await writeFile(join(evidence, 'ait212-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});

test('AIT-221 two failures: Retry at the first failure recovers both lanes, overview-only unchanged, 0 px', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-two-failures-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const capture = async (locale, width, theme, state) => {
    if (!evidence) return;
    const stem = `ait221-${locale}-${width}-${theme}-${state}`;
    await settle(page);
    await captureViewport(page, { path: join(evidence, `${stem}.png`), fullPage: false, captureBeyondViewport: false });
    if (width === 390) {
      const scrollY = await page.evaluate(() => window.scrollY);
      await shadow(page, c => c.shadowRoot.querySelector('.understanding').scrollIntoView({ block: 'start' }));
      await settle(page);
      await captureViewport(page, { path: join(evidence, `${stem}-overview.png`), fullPage: false, captureBeyondViewport: false });
      await shadow(page, c => c.shadowRoot.querySelector('.understanding > .foot').scrollIntoView({ block: 'center' }));
      await settle(page);
      await captureViewport(page, { path: join(evidence, `${stem}-footer.png`), fullPage: false, captureBeyondViewport: false });
      await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), scrollY);
      await settle(page);
    }
  };
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  for (const locale of ['de', 'en']) for (const width of evidence ? [390, 1024, 1440] : [390, 1440]) for (const theme of ['light', 'dark']) await t.test(`${locale} ${width} ${theme}`, async () => {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await shadow(page, async (c, locale, theme) => {
      const session = await (await fetch('/two-failures?locale=' + locale)).json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.setAttribute('theme', theme);
      // Pin the production Chrome baseline stack for both evidence states.
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy, paimosImportUrl: 'https://paimos.example.test/import/project-draft', paimosImportVersion: 1 });
      window.twoFailureCopy = `${copy.reasoningFailed}\u00a0· ${copy.retry}`;
      window.reasoningFailedCopy = copy.reasoningFailed;
    }, locale, theme);
    await settle(page);
    const state = await shadow(page, c => ({
      retries: [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length,
      reply: c.shadowRoot.querySelector('.transcript-shell .reaction-failure').textContent,
      overview: c.shadowRoot.querySelector('.notice-text').textContent,
      inlineHidden: c.shadowRoot.querySelector('.overview-retry').hidden,
      expectedReply: window.twoFailureCopy,
      atFirstFailure: c.shadowRoot.querySelector('.retry').parentElement === c.shadowRoot.querySelector('.reaction-failure'),
      inFooter: Boolean(c.shadowRoot.querySelector('.understanding > .foot > .retry')),
      projectVisible: Boolean(c.shadowRoot.querySelector('.create-project').getClientRects().length),
    }));
    assert.equal(state.atFirstFailure, true, 'the single Retry belongs to the reply notice, the first failure in reading order');
    assert.equal(state.inFooter, false); assert.equal(state.projectVisible, true, 'project action returns when Retry leaves the footer');
    assert.equal(state.retries, 1); assert.equal(state.reply, state.expectedReply);
    assert.equal(state.overview, locale === 'de' ? 'Der Überblick konnte gerade nicht erstellt werden.' : "The overview couldn't be built just now.");
    assert.equal(state.inlineHidden, true);
    const targets = ['.transcript-shell', '.understanding', '.composer-shell', '.display-foot', '.audio-rail'];
    const before = await boxes(page, targets);
    const statsBefore = await page.evaluate(async () => (await fetch('/stats')).json());
    await capture(locale, width, theme, 'two-failures');
    // Exercise hidden Retry and placement changes without another provider run.
    await shadow(page, c => {
      window.bothFailures = structuredClone(c.session.operations);
      c.receive({ type: 'lane.status', data: { ...window.bothFailures, running: ['reaction'] } });
    });
    assert.deepEqual(await shadow(page, c => ({ hidden: c.shadowRoot.querySelector('.retry').hidden,
      text: c.shadowRoot.querySelector('.reaction-failure-text').textContent,
      expected: window.reasoningFailedCopy })), { hidden: true, text: await page.evaluate(() => window.reasoningFailedCopy),
      expected: await page.evaluate(() => window.reasoningFailedCopy) }, 'hidden Retry leaves the failure sentence without a trailing separator');
    if ((locale === 'de' && theme === 'light') || (locale === 'en' && theme === 'dark')) await capture(locale, width, theme, 'two-failures-retry-hidden');
    await shadow(page, c => {
      c.receive({ type: 'lane.status', data: window.bothFailures });
      const failures = c.session.operations.failures.filter(f => f.lane === 'understanding');
      c.receive({ type: 'lane.status', data: { ...c.session.operations, failures, lastFailure: failures[0] } });
    });
    await settle(page);
    const overviewOnly = await shadow(page, c => ({
      inline: !c.shadowRoot.querySelector('.notice > .overview-retry')?.hidden,
      footerHidden: c.shadowRoot.querySelector('.retry').hidden,
      inFooter: Boolean(c.shadowRoot.querySelector('.understanding > .foot > .retry')),
      replyHidden: c.shadowRoot.querySelector('.reaction-failure').hidden,
      retries: [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length,
      projectVisible: Boolean(c.shadowRoot.querySelector('.create-project').getClientRects().length),
    }));
    assert.deepEqual(overviewOnly, { inline: true, footerHidden: true, inFooter: true, replyHidden: true, retries: 1, projectVisible: true }, 'overview-only keeps AIT-198 inline Retry and releases the project row');
    assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelector('.understanding > .foot').children].map(n => n.className)),
      ['export', 'retry', 'export-reason', 'create-project'], 'returning Retry restores DOM index 1 and the original footer tab order');
    assert.deepEqual(await boxes(page, targets), before, 'overview-only transition shifts exactly 0 px');
    await capture(locale, width, theme, 'overview-only');
    await shadow(page, c => c.receive({ type: 'lane.status', data: window.bothFailures }));
    await settle(page);
    assert.deepEqual(await boxes(page, targets), before, 'restoring two failures shifts exactly 0 px');
    await shadow(page, c => {
      const retry = c.shadowRoot.querySelector('.retry'); retry.focus(); window.firstFailureRetry = retry;
      c.receive({ type: 'lane.status', data: { ...c.session.operations } });
    });
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement === window.firstFailureRetry && c.shadowRoot.querySelector('.reaction-failure > .retry') === window.firstFailureRetry), true, 'live status preserves the reply Retry node and keyboard focus');
    await shadow(page, c => c.shadowRoot.querySelector('.retry').scrollIntoView({ block: 'center' }));
    await settle(page);
    assert.equal(await shadow(page, c => {
      const button = c.shadowRoot.querySelector('.retry'), box = button.getBoundingClientRect();
      return c.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
    }), true, 'visible Retry is reachable above the fixed dock');
    const retryButton = await page.$('aithema-session >>> .retry');
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/retry')),
      retryButton.click()]);
    assert.equal(response.status(), 202);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await until(page, () => {
      const c = document.querySelector('aithema-session');
      return c.shadowRoot.querySelector('.summary-text').textContent === 'Ein Überblick. An overview.' &&
        !c.session.operations.running.length && !c.session.operations.failures.length;
    });
    await settle(page);
    const statsAfter = await page.evaluate(async () => (await fetch('/stats')).json());
    assert.deepEqual(statsAfter.lanes.slice(statsBefore.providerCalls), ['reaction', 'understanding'], 'one click attempts both lanes once, reply first');
    assert.equal(statsAfter.attempts.length, statsBefore.attempts.length + 2);
    assert.ok(statsAfter.attempts.slice(-2).every(attempt => attempt.state === 'settled'));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.reaction-failure').hidden), true);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), locale === 'de' ? 'Aktuelle Einschätzung' : 'Current assessment');
    assert.deepEqual(await boxes(page, targets), before, 'both successful lanes settle in place at exactly 0 px');
    await capture(locale, width, theme, 'recovered');
    passes.push({ head: evidenceCommit, locale, width, theme, retries: 1, lanes: ['reaction', 'understanding'], attemptsPerLane: 1, layoutShiftPx: 0, reducedMotion: true, baselineFonts: true, pass: true });
    console.log(`AIT-221 PASS ${locale} ${width} ${theme}: one Retry; reply then overview exactly once; both settled; 0 px`);
  });
  if (evidence) await writeFile(join(evidence, 'ait221-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});

test('AIT-212 R5 reply-only failure: pending overview, one Retry, preparing then assessment; DE/EN 390/1440', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-reply-pending-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'session.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    const configure = off => shadow(page, async (c, locale, off) => {
      const session = await (await fetch(`/reply-failure?locale=${locale}&off=${Number(off)}`)).json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.setAttribute('theme', 'light');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      c.configure({ session, copy });
    }, locale, off);
    await configure(true); await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), locale === 'de' ? 'Noch keine Angaben zu Ihrem Vorhaben.' : 'No details about your project yet.', 'off-topic input retains no-details text');
    await configure(false); await settle(page);
    const expected = locale === 'de' ? 'Der Überblick folgt, sobald die Antwort da ist.' : 'The overview follows once the reply is in.';
    const state = await shadow(page, (c, expected) => {
      const r = c.shadowRoot, notice = r.querySelector('.notice');
      const probe = document.createElement('span'); probe.style.color = 'var(--aithema-muted)'; notice.after(probe);
      const quietInk = getComputedStyle(probe).color; probe.remove();
      return { notice: notice.textContent, occurrences: r.textContent.split(expected).length - 1,
        actions: notice.querySelectorAll('a, button:not([hidden])').length, color: getComputedStyle(notice).color, quietInk,
        retries: [...r.querySelectorAll('.retry, .overview-retry')].filter(n => !n.hidden).length,
        reply: r.querySelector('.reaction-failure').textContent, footerHidden: r.querySelector('.retry').hidden };
    }, expected);
    assert.equal(state.notice, expected); assert.equal(state.occurrences, 1); assert.equal(state.actions, 0);
    assert.equal(state.color, state.quietInk); assert.equal(state.retries, 1); assert.equal(state.footerHidden, false);
    assert.equal(state.reply, locale === 'de' ? 'Die Auswertung ist gerade nicht verfügbar. Ihre Nachrichten sind gespeichert.' : 'Reasoning is unavailable. Your messages are saved.');
    const targets = ['.transcript-shell', '.understanding', '.composer-shell', '.display-foot', '.audio-rail'];
    const before = await boxes(page, targets);
    await shadow(page, c => c.receive({ type: 'lane.status', data: { ...c.session.operations } }));
    await settle(page);
    assert.deepEqual(await boxes(page, targets), before, 'pending line re-render shifts 0 px');
    if (evidence && locale === 'de') {
      await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' }));
      await settle(page);
      await captureViewport(page, { path: join(evidence, `ait212-r5-de-${width}-reply-pending-light.png`), fullPage: false, captureBeyondViewport: false });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await settle(page);
    }
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/retry')), shadow(page, c => c.shadowRoot.querySelector('.retry').click())]);
    assert.equal(response.status(), 202);
    const preparing = locale === 'de' ? 'Ihr Überblick wird erstellt …' : 'Preparing your overview …';
    await until(page, text => document.querySelector('aithema-session').shadowRoot.querySelector('.notice').textContent === text, preparing);
    await settle(page);
    assert.deepEqual(await boxes(page, targets), before, 'preparing after successful reply shifts 0 px');
    await page.evaluate(() => fetch('/settle?verdict=success'));
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.summary-text').textContent === 'Ein Überblick. An overview.');
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), locale === 'de' ? 'Aktuelle Einschätzung' : 'Current assessment', 'normal overview copy after assessment');
    assert.deepEqual(await boxes(page, targets), before, 'assessment shifts 0 px');
    const pass = { head: evidenceCommit, locale, width, theme: 'light', notice: expected, occurrences: 1, retries: 1, layoutShiftPx: 0, reducedMotion: true, baselineFonts: true, pass: true };
    passes.push(pass);
    console.log(`AIT-212 R5 PASS ${locale} ${width} light: pending once, quiet ink, no link, one reply Retry, no-details off-topic, preparing then current assessment, 0 px`);
  }
  if (evidence) await writeFile(join(evidence, 'ait212-r5-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});
