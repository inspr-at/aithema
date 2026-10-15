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
    if (evidence) await page.screenshot({ path: join(evidence, `ait198-${locale}-${width}-${verdict}.png`), fullPage: false, captureBeyondViewport: false });
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
    if (evidence) await page.screenshot({ path: join(evidence, `ait198-${locale}-${width}-${verdict}-recovered.png`), fullPage: false, captureBeyondViewport: false });
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
    if (evidence) await page.screenshot({ path: join(evidence, `ait198-${locale}-${width}-stuck.png`), fullPage: false, captureBeyondViewport: false });
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
      if (kind.endsWith('voice')) session.voiceLifecycle = { callId: 'call', providerSessionId: 'provider', epoch: 1,
        state: kind === 'waiting voice' ? 'waiting' : 'active' };
      session.transcript.push({ id: 'person', role: 'user', content: 'Wir vereinfachen die Auftragsbearbeitung.',
        ...(kind === 'facade pending' ? { voiceCallId: 'call', voiceProviderId: 'provider' } :
          kind === 'spoken facade pending' ? { callId: 'call', providerSessionId: 'provider' } : {}) });
      session.operations = { inputRevision: inputRevision(session), running: [], lastFailure: null };
      c.setAttribute('motion', 'off'); c.configure({ session, copy });
      window.reactionFailureCopy = copy.reasoningFailed;
    }, locale, kind);
    await settle(page);
    const pending = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      inlineHidden: c.shadowRoot.querySelector('.overview-retry').hidden, footerHidden: c.shadowRoot.querySelector('.retry').hidden }));
    assert.equal(pending.inlineHidden, true, `${kind} ${locale}/${width}: no false inline Retry while waiting`);
    assert.equal(pending.footerHidden, true, `${kind} ${locale}/${width}: no footer Retry without a failure`);
    assert.doesNotMatch(pending.notice, /couldn't be built|konnte gerade nicht erstellt/iu, `${kind}: no false failure while waiting`);
    await shadow(page, c => c.receive({ type: 'lane.status', data: { inputRevision: c.session.operations.inputRevision,
      running: [], lastFailure: { lane: 'reaction', error: 'reasoning-unavailable', retryable: true } } }));
    await settle(page);
    const failed = await shadow(page, c => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
      expected: window.reactionFailureCopy, inlineHidden: c.shadowRoot.querySelector('.overview-retry').hidden,
      footerHidden: c.shadowRoot.querySelector('.retry').hidden, footerDisabled: c.shadowRoot.querySelector('.retry').disabled }));
    assert.equal(failed.notice, failed.expected, `${kind} ${locale}/${width}: recorded reaction failure notice`);
    assert.equal(failed.inlineHidden, true, `${kind} ${locale}/${width}: reaction failure uses footer Retry`);
    assert.equal(failed.footerHidden, false, `${kind} ${locale}/${width}: recorded reaction failure keeps footer Retry`);
    assert.equal(failed.footerDisabled, false, `${kind} ${locale}/${width}: footer Retry is enabled`);
  }
});
