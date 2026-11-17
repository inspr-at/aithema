import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, fullMatrix, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';
import { shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';
import { fixture, settle, stable, click } from './email-ask-fixture.js';

const gateReady = page => until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.emailAsk !== 'closed');
const pointerClick = async (page, selector) => {
  const point = await shadow(page, (c, selector) => { const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, selector);
  await page.mouse.click(...point);
  // Leave the ask so a hover does not interfere with folding or screenshots.
  await page.mouse.move(0, 0);
};
const openCredits = page => shadow(page, c => {
  const entry = c.shadowRoot.querySelector('.host-credits'), button = entry.querySelector('.host-credits__button');
  if (entry.hasAttribute('data-pinned')) button.click();
  button.click(); // Activation runs the production viewport-positioning handler.
});
const fixed = ['.composer-shell', '.send', '.understanding > .foot', '.display-foot', '.host-credits', '.engine-info'];
test('AIT-164: viewport state matrix, DE/EN light/dark 390/1024/1440; zero layout shift', { timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-email-ask-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const passes = [], footerChecks = [];
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    await page.select('#locale', locale);
    await until(page, locale => document.querySelector('aithema-session')?.session.locale === locale, locale);
    // Full evidence replays every width; CI rotates widths at fixture boundaries.
    // Both theme screenshots and assertions are
    // taken from each resulting state instead of replaying every interaction.
    for (let width of matrixWidths([390, 1024, 1440], 'light', 0, 'email-ask')) {
      await page.setViewport({ width, height: 1000 });
      const setTheme = async theme => {
        await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      };
      await setTheme('light');
      let label = `${locale}-${width}`;
      // The stacked assessment is below the phone viewport. Only controls
      // visible under its pointer are part of that viewport's shift contract.
      let targets = width >= 960 ? fixed : fixed.filter(selector => !selector.startsWith('.understanding'));
      let baseline, stateGroup = 0;
      const begin = async (options = {}, widths = [390, 1024, 1440]) => {
        const group = stateGroup === 10 ? 'email-ask-folded' : 'email-ask';
        const selected = matrixWidths(widths, 'light', stateGroup++, group);
        if (!fullMatrix) width = selected[0];
        await page.setViewport({ width, height: 1000 });
        label = `${locale}-${width}`;
        targets = width >= 960 ? fixed : fixed.filter(selector => !selector.startsWith('.understanding'));
        await fixture(page, locale, options);
      };
      const shot = async state => {
        for (const theme of ['light', 'dark']) {
          await setTheme(theme); await settle(page);
          const shift = stable(baseline, await boxes(page, targets), `${label}/${theme}/${state}`);
          passes.push({ head: evidenceCommit, locale, theme, width, state, layoutShiftPx: shift, pass: true });
          if (evidence) await page.screenshot({ path: join(evidence, `ait164-${locale}-${theme}-${width}-${state}.png`), fullPage: false });
        }
        await setTheme('light');
      };
      const reply = async () => {
        const reads = await page.evaluate(() => window.ait164.creditsReads);
        await page.evaluate(() => window.ait164.reply());
        await until(page, reads => window.ait164.creditsReads > reads, reads);
        await settle(page);
      };
      await begin(); baseline = await boxes(page, targets); await shot('before');
      await reply(); await gateReady(page);
      const gate = await shadow(page, c => ({ placement: c.shadowRoot.querySelector('.workspace').dataset.emailAsk, focus: c.shadowRoot.activeElement?.id ?? null }));
      assert.equal(gate.placement, width >= 960 ? 'pane' : 'dock'); assert.notEqual(gate.focus, 'email-ask-input'); await shot('gate');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'visitor@example.test'; input.focus({ preventScroll: true }); }); await shot('gate-typing');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'invalid-address'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-ask-input').getAttribute('aria-invalid')), 'true'); await shot('gate-invalid');
      await page.evaluate(() => { window.ait164.saving = true; });
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'visitor@example.test'; });
      await pointerClick(page, '.email-ask__save');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask').dataset.step === 'saving'); await shot('gate-saving');
      await page.evaluate(() => { window.ait164.saving = false; });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask').dataset.step === 'done');
      const pointerFocus = await shadow(page, c => { const skip = c.shadowRoot.querySelector('.email-ask__skip'); return { focused: c.shadowRoot.activeElement === skip, visible: skip.matches(':focus-visible'), outline: getComputedStyle(skip).outlineStyle }; });
      assert.equal(pointerFocus.focused, true); assert.equal(pointerFocus.visible, false); assert.equal(pointerFocus.outline, 'none');
      await shot('gate-saved');
      const viewportScroll = await page.evaluate(() => [scrollX, scrollY]);
      await page.keyboard.press('Tab');
      // Select the same control after real keyboard input; this focus-style
      // check does not depend on the host page's neighboring tab stops.
      await shadow(page, c => c.shadowRoot.querySelector('.email-ask__skip').focus({ preventScroll: true }));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-ask__skip').matches(':focus-visible')), true, 'keyboard focus retains its ring');
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.email-ask__skip')).outlineStyle), 'solid');
      await page.evaluate(([x, y]) => window.scrollTo(x, y), viewportScroll);
      await click(page, '.email-ask__skip');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.emailAsk === 'closed'); await shot('gate-dismissed');
      await begin({ delivery: true }); baseline = await boxes(page, targets); await reply(); await settle(page); await shot('gate-mail');
      await shadow(page, c => { c.shadowRoot.querySelector('#email-ask-input').value = 'visitor@example.test'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask').dataset.step === 'done');
      assert.deepEqual(await page.evaluate(() => window.ait164.requests), ['save', 'link']); await shot('gate-saved-mail');
      await begin(); baseline = await boxes(page, targets); await reply(); await settle(page);
      await page.evaluate(() => { window.ait164.saveFails = true; });
      await shadow(page, c => { c.shadowRoot.querySelector('#email-ask-input').value = 'visitor@example.test'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email-ask-message').textContent.trim() !== '' && document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask').dataset.step === 'idle'); await shot('gate-save-failed');
      assert.equal(await page.evaluate(() => window.ait164.address), null);
      await begin({ delivery: true }); baseline = await boxes(page, targets); await reply(); await settle(page);
      await page.evaluate(() => { window.ait164.linkFails = true; });
      await shadow(page, c => { c.shadowRoot.querySelector('#email-ask-input').value = 'visitor@example.test'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask').dataset.step === 'done'); await shot('gate-saved-delivery-failed');
      assert.equal(await page.evaluate(() => window.ait164.credits().tiers.current), 'emailGiven');
      assert.match(await shadow(page, c => c.shadowRoot.querySelector('.email-ask__hint').textContent), locale === 'de' ? /konnte.*nicht/u : /could not/u);
      for (const [state, options] of [
        ['low-text', { low: true }], ['low-voice', { low: true, voice: true }],
        ['low-given', { low: true, address: 'visitor@example.test' }], ['low-confirmed', { low: true, address: 'visitor@example.test', delivery: true, confirmed: true }],
        ['low-pending', { low: true, address: 'visitor@example.test', delivery: true }], ['out', { out: true }],
      ]) {
        await begin(options); baseline = await boxes(page, targets); await reply(); await settle(page);
        const values = await shadow(page, c => ({ ask: c.shadowRoot.querySelector('.workspace').dataset.emailAsk, low: c.shadowRoot.querySelector('.host-credits').dataset.low,
          line: Boolean(c.shadowRoot.querySelector('.email-low-line')), rail: c.shadowRoot.querySelector('.voice-state')?.textContent ?? null, usedUp: c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up') }));
        if (!options.voice) assert.equal(values.rail, null, 'AIT-260: no rail without a bound client');
        if (state === 'out') assert.equal(values.usedUp, true);
        else assert.equal(values.low, 'true');
        if (state === 'low-voice') { assert.equal(values.ask, 'closed'); assert.equal(values.line, false); assert.equal(values.rail, locale === 'de' ? 'Noch wenig Guthaben' : 'Credit running low'); }
        if (options.address) assert.equal(values.ask, 'closed');
        await shot(state);
        if (state === 'low-voice') { await click(page, '.voice-pause'); await gateReady(page); await shot('low-after-call'); assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed'); }
      }
      // Fold, deferred typing, no mid-stream opening, and changing digit count.
      await begin({}, [1024, 1440]); baseline = await boxes(page, targets); await reply(); await settle(page);
      if (width >= 960) { await reply(); await reply();
        await until(page, () => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.email-ask-fold')).visibility === 'visible'); assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.email-ask-fold')).visibility), 'visible'); await shot('gate-folded'); }
      await begin(); baseline = await boxes(page, targets);
      const footerBefore = await boxes(page, ['.host-credits', '.engine-info']);
      await page.evaluate(() => { window.ait164.after = Date.now() + 86_400_000; window.ait164.spent = 12_000_000 - 980_000; }); await reply();
      stable(footerBefore, await boxes(page, ['.host-credits', '.engine-info']), `${label}/footer-fewer-digits`);
      const footer = await shadow(page, c => { const r = c.shadowRoot, left = r.querySelector('.ai-notice').getBoundingClientRect(), credit = r.querySelector('.host-credits').getBoundingClientRect(); return { gap: credit.left - left.right, numeric: getComputedStyle(r.querySelector('.host-credits__amount')).fontVariantNumeric }; });
      // Tick AIT-406 (2026-10-20), AIT-260 ee4fe983: band-styles.js
      // .display-foot__row is 24px at :137, overridden to 8px below 600px at :340.
      const phoneFooter = width < 600;
      if (evidence) {
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        const file = `ait406-footer-gap-${label}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false });
        await writeFile(join(evidence, `${file}.json`), JSON.stringify({ locale, width, footer,
          geometry: await shadow(page, c => ['.display-foot', '.ai-notice', '.host-credits'].map(selector => {
            const node = c.shadowRoot.querySelector(selector), style = getComputedStyle(node);
            return { selector, box: node.getBoundingClientRect().toJSON(), gap: style.gap, fontFamily: style.fontFamily };
          })) }, null, 2));
      }
      assert.ok(phoneFooter ? Math.abs(footer.gap - 8) <= .5 : footer.gap >= 23.5, `${label}: footer gap ${footer.gap}`);
      assert.equal(footer.numeric, 'tabular-nums');
      footerChecks.push({ locale, width, ...footer, phoneFooter, pass: true, decision: 'Tick AIT-406, 2026-10-20; AIT-260 ee4fe983' });
      if (evidence) await writeFile(join(evidence, 'ait406-footer-checks.json'), JSON.stringify(footerChecks, null, 2));
      if (evidence && locale === 'de' && width === 390) await page.screenshot({ path: join(evidence, 'ait406-footer-after.png'), fullPage: false });
      await shot('footer-fewer-digits');
      await begin({ motion: 'on' }); baseline = await boxes(page, targets);
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#message'); input.value = 'draft'; input.focus(); input.dispatchEvent(new Event('input')); });
      await reply(); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed', 'typing defers the ask');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#message'); input.value = ''; input.blur(); });
      await gateReady(page); await settle(page);
      assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed');
      if (width < 960) {
        const lift = await shadow(page, c => { const r = c.shadowRoot; return r.querySelector('.composer-shell').getBoundingClientRect().bottom - r.querySelector('.email-ask').getBoundingClientRect().bottom; });
        assert.equal(lift, 20, 'phone gate lifts exactly 20 px');
      }
      await shot('flow-gate');
      await begin(); baseline = await boxes(page, targets);
      await shadow(page, c => { c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'stream-u5', role: 'user', content: 'A requirement.' } });
        c.receive({ type: 'turn.partial', data: { id: 'stream-a5', delta: 'A partial reply', inputRevision: c.session.inputRevision } }); });
      await settle(page); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed', 'no ask during the fifth reply');
      await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'stream-a5', role: 'assistant', content: 'A complete reply.' } })); await gateReady(page); await shot('flow-stream-finished');
      await begin({ voice: true }); baseline = await boxes(page, targets); await reply(); await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed'); await shot('flow-call');
      await page.evaluate(() => { window.ait164.spent = 12_000_000 - 720_000; }); await reply();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-low-line') === null), true); await shot('flow-low-call');
      await click(page, '.voice-close'); await gateReady(page); await shot('flow-low-call-ended');
      await click(page, '.email-ask__skip'); await reply();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed', 'the visitor-wide claim suppresses another ask');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits').dataset.low), 'true', 'amber footer stays low after the claim');
      await click(page, '.voice-start');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-state').textContent === (window.ait164Locale === 'de' ? 'Noch wenig Guthaben' : 'Credit running low'));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').classList.contains('low')), true, 'call label stays low after the claim');
      await click(page, '.voice-close'); await settle(page);
      assert.deepEqual(errors, [], label);
    }
    await browser.close(); browser = null;
  }
  assertMatrixCaseCount('email-ask', passes.length);
  if (evidence) await writeFile(join(evidence, 'ait164-pass-lines.json'), JSON.stringify({ head: evidenceCommit, runner: 'mbp2606/CI', captures: 'viewport', passes }, null, 2));
  t.diagnostic(`AIT-164 HEAD ${evidenceCommit}: ${passes.length} viewport state checks PASS; layout shift 0 px`);
});


test('AIT-168: Settings saves only with confirmation disabled and saves plus requests a link when enabled', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-confirm-gate-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  browser = await browserForFile();
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['de', 'en']) for (const enabled of [false, true]) {
    // Keep the follow-up read pending beyond paint so save cannot stand in for completion.
    await fixture(page, locale, { delivery: true, confirmationEnabled: enabled, consentDelayMs: 300 });
    await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').dataset.emailMode), enabled ? 'mail' : 'save');
    if (enabled) {
      await click(page, '.host-verify .verify-entry');
      await shadow(page, c => { const form = c.shadowRoot.querySelector('dialog.verify-dialog .verify-form'); form.querySelector('input').value = 'settings@example.test'; form.requestSubmit(); });
    } else {
      await shadow(page, c => { c.shadowRoot.querySelector('#email-input').value = 'settings@example.test'; c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit(); });
    }
    await until(page, () => window.ait164.address === 'settings@example.test');
    await settle(page);
    // Saving the address is only the first acknowledgement. In mail mode the
    // form stays busy through the credit/consent refresh and confirmation request.
    if (enabled) await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog .verify-send').getAttribute('aria-disabled') === 'false');
    assert.deepEqual(await page.evaluate(() => window.ait164.requests), enabled ? ['save', 'link'] : ['save']);
    assert.equal(await page.evaluate(() => window.ait164.credits().tiers.current), 'emailGiven');
    if (!enabled) {
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').dataset.emailState), 'saved');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify .verify-entry').hidden), true);
    }
  }
  assert.deepEqual(errors, []);
});


test('AIT-172: email ask privacy DE/EN save/mail/confirmation-off, 390/1440, main geometry and mail pixels', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-ask-privacy-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  const baseline = JSON.parse(await readFile(new URL('../fixtures/email-privacy-baseline.json', import.meta.url), 'utf8'));
  const rows = [], shots = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage(), main = await browser.newPage();
    await main.setRequestInterception(true);
    main.on('request', request => {
      const source = baseline.modules[new URL(request.url()).pathname.slice(1)];
      // Tick AIT-445 round 3 approves only this larger composer reservation.
      // Retain the frozen email styles and every exact geometry/pixel assertion.
      if (source) void request.respond({ status: 200, contentType: 'text/javascript',
        body: source.replace('.composer-out__steps { min-height:4.05em; }', '.composer-out__steps { min-height:4lh; }') });
      else void request.continue();
    });
    for (const p of [page, main]) {
      await p.bringToFront();
      await p.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
      await p.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(p, () => document.querySelector('aithema-session')?.session);
    }
    for (const width of [390, 1440]) for (const [mode, delivery, confirmationEnabled] of [['save', false, false], ['confirmation-off', true, false], ['mail', true, true]]) {
      const label = `${locale}-light-${width}-${mode}`;
      for (const p of [page, main]) {
        await p.bringToFront();
        await p.setViewport({ width, height: width === 390 ? 844 : 1000 }); await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await fixture(p, locale, { delivery, confirmationEnabled });
        await shadow(p, c => c.setAttribute('theme', 'light'));
        await p.evaluate(() => window.ait164.reply()); await gateReady(p); await settle(p);
      }
      const expected = locale === 'de' ? mode === 'mail' ? 'Ihre E‑Mail-Adresse wird nur für Ihr Guthaben und die Bestätigungsmail verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.' : 'Ihre E‑Mail-Adresse wird nur für Ihr Guthaben verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.' : mode === 'mail' ? 'We use your email address only for your credit and the confirmation email. Never for advertising. After 90 days without use, we delete it automatically.' : 'We use your email address only for your credit. Never for advertising. After 90 days without use, we delete it automatically.';
      let passed = false;
      await t.test(label, async () => {
        // All notice consumers, including the hidden lock form and confirmation dialog.
        const texts = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.m-notice-text')].map(n => n.textContent));
        assert.ok(texts.length >= 5); assert.ok(texts.every(text => text === expected), JSON.stringify(texts));
        const targets = ['.email-ask', '#email-ask-input', '#email-ask-notice', '.email-ask__actions', ...fixed];
        assert.deepEqual(await boxes(page, targets), await boxes(main, targets), '0 px shift against main');
        if (mode === 'mail') {
          // Compare the ask itself: conversation IDs and unrelated demo chrome differ per session.
          const clip = await shadow(page, c => { const b = c.shadowRoot.querySelector('.email-ask').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
          await page.bringToFront(); await settle(page); const actual = await page.screenshot({ clip });
          await main.bringToFront(); await settle(main); assert.ok(actual.equals(await main.screenshot({ clip })), 'mail ask pixel-identical to main');
        }
        passed = true;
      });
      if (!passed) continue;
      rows.push({ head: evidenceCommit, label, surface: 'email-ask', shiftPx: 0, mailPixelIdentical: mode === 'mail', text: expected });
      t.diagnostic(`PASS AIT-172 ${label}/email-ask: 0 px shift${mode === 'mail' ? '; mail pixels identical to main' : ''}`);
      if (evidence) { const name = `ait-172-${evidenceCommit}-${label}-email-ask.png`; await page.bringToFront(); await settle(page); await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name); }
    }
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'ait-172-email-ask-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, baseline: baseline.sourceHead, rows, shots }, null, 2));
});


// AIT-490: measure the shipped send paths before deciding the SMTP joiner rule.
// BEH + BEH are dual-joining Persian letters, so the intervening ZWNJ satisfies
// IDNA2008 CONTEXTJ's joining-type context (RFC 5892, Appendix A.2).
test('AIT-490: typed CONTEXTJ ZWNJ domain is converted or blocked before any recipient request', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-recipient-joiner-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), rows = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const unicode = 'user@ب\u200cب.example';
  for (const path of ['verification', 'email-ask', 'visitor-email']) {
    // The ASCII control proves each fixture actually reaches its send handler.
    for (const recipient of ['control@example.test', unicode]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session);
      await fixture(page, 'en', { delivery: true, confirmationEnabled: path !== 'visitor-email', ...(path === 'verification' ? { address: 'prior@example.test' } : {}) });
      let selector;
      if (path === 'email-ask') {
        await page.evaluate(() => window.ait164.reply()); await gateReady(page);
        selector = '#email-ask-input';
      } else {
        await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
        if (path === 'verification') {
          await click(page, '.m-change-mail');
          await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
          selector = '#verify-dialog-email';
        } else selector = '#email-input';
      }
      await page.evaluate(() => {
        const previous = window.fetch;
        window.recipientRequests = [];
        window.fetch = async (url, init = {}) => {
          const address = init.body && JSON.parse(init.body).address;
          if (address) {
            window.recipientRequests.push({ path: new URL(url, location.href).pathname, address });
            // Count at the host-route fixture; never contact a mail provider.
            return Response.json({ error: 'measurement' }, { status: 400 });
          }
          return previous(url, init);
        };
      });
      const input = await page.evaluateHandle(selector => document.querySelector('aithema-session').shadowRoot.querySelector(selector), selector);
      await input.evaluate(input => { input.value = ''; });
      await input.type(recipient);
      const observed = await input.evaluate(input => ({ value: input.value, valid: input.checkValidity(), typeMismatch: input.validity.typeMismatch }));
      await input.evaluate(input => input.form.requestSubmit());
      await until(page, selector => window.recipientRequests.length > 0 || document.querySelector('aithema-session').shadowRoot.querySelector(selector).getAttribute('aria-invalid') === 'true', selector);
      const requests = await page.evaluate(() => window.recipientRequests);
      rows.push({ engine: await browser.browser().version(), path, typed: recipient, ...observed, sends: requests.length, requests });
      await input.dispose(); await page.close();
    }
  }
  t.diagnostic(JSON.stringify(rows));
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait490-joiner-measurement.json'), JSON.stringify(rows, null, 2));
  }
  for (const row of rows) {
    if (row.typed !== unicode) { assert.ok(row.sends > 0, `${row.path}: ASCII control reaches the fixture`); continue; }
    if (row.value === unicode) {
      assert.equal(row.typeMismatch, true, `${row.path}: unconverted Unicode is invalid`);
      assert.equal(row.valid, false, `${row.path}: unconverted Unicode fails checkValidity()`);
      assert.equal(row.sends, 0, `${row.path}: STOP: Unicode joiner recipient left the page`);
    } else {
      assert.match(row.value, /^user@xn--[a-z0-9-]+\.example$/u, `${row.path}: browser ToASCII conversion`);
      assert.equal(row.valid, true);
      assert.ok(row.requests.every(request => request.address === row.value), `${row.path}: only the converted recipient leaves the page`);
    }
  }
});








test('AIT-507 deferred credits email link is hidden with reserved positive geometry', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-deferred-email-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), rects = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: {}, initialMessages: 0 });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
    await openCredits(page);
    await settle(page);
    const targets = ['.host-credits', '.credits-popup', '.credits-email', '.host-credits__scope', '.host-credits__next'];
    const sample = async () => { const result = await boxes(page, targets); for (const box of result) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive reserved popup geometry`); return result; };
    const inViewport = async () => { const box = (await sample())[1]; assert.ok(box[0] >= -.5 && box[1] >= -.5 && box[0] + box[2] <= width + .5 && box[1] + box[3] <= page.viewport().height + .5, `${label}: popup fits viewport ${box}`); };
    await inViewport();
    const before = await sample();
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.credits-email')).visibility), 'hidden', `${label}: before-input email link is hidden`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.credits-email').hidden), true);
    if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-507-${label}-before-input-credits.png`) });
    await page.evaluate(() => window.ait164.reply()); await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.credits-email').hidden), false);
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.credits-email')).visibility), 'visible');
    await inViewport();
    const after = await sample(), shift = Math.max(...before.flatMap((box, i) => box.map((v, j) => Math.abs(v - after[i][j]))));
    assert.ok(shift <= .5, `${label}: reserved popup shift ${shift}`); rects.push({ label, targets, before, after, shift });
    if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-507-${label}-after-input-credits.png`) });
  }
  if (evidence) await writeFile(join(evidence, 'ait-507-credits-rects.json'), JSON.stringify(rects, null, 2));
});

// B7: each regression runs independently so the red lane identifies every
// blocked entry point without the first failure masking the remaining cases.
for (const scenario of ['used-up', 'used-up-mail', 'saved-address', 'no-next-tier', 'refused-focus']) test(`AIT-507 b7 ${scenario}: before-input recovery and stable geometry`, { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-offer-recovery-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await fixture(page, locale, { opener: true, delivery: scenario !== 'used-up', emailOffer: { afterMessages: scenario === 'refused-focus' ? 2 : 1 }, initialMessages: scenario === 'refused-focus' ? 1 : 0,
      out: scenario.startsWith('used-up'), address: ['saved-address', 'no-next-tier'].includes(scenario) ? 'saved@example.test' : null,
      confirmed: scenario === 'no-next-tier' });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
    const shot = async state => { await settle(page); if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-507-${label}-b7-${scenario}-${state}.png`) }); };
    const sample = async targets => {
      const result = await boxes(page, targets);
      for (const [i, box] of result.entries()) assert.ok(box[2] > 0 && box[3] > 0, `${label}/${scenario}/${targets[i]}: positive geometry ${box}`);
      const popup = result[targets.indexOf('.credits-popup')];
      if (popup) assert.ok(popup[0] >= -.5 && popup[1] >= -.5 && popup[0] + popup[2] <= width + .5 && popup[1] + popup[3] <= page.viewport().height + .5, `${label}/${scenario}: popup fits viewport ${popup}`);
      return result;
    };
    const compare = async (targets, before, state) => {
      const after = await sample(targets), shift = Math.max(...before.flatMap((box, i) => box.map((n, j) => Math.abs(n - after[i][j]))));
      assert.ok(shift <= .5, `${label}/${scenario}/${state}: shift ${shift}; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      rects.push({ label, scenario, state, targets, before, after, shift });
    };
    if (scenario.startsWith('used-up')) {
      assert.equal(await shadow(page, c => c.session.transcript.length), 0);
      const upgrade = await sample(['.composer-out__upgrade']);
      await shot('upgrade');
      await click(page, '.composer-out__upgrade');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').hidden), false, `${label}: used-up capture remains reachable`);
      const inputSelector = scenario === 'used-up-mail' ? '#verify-dialog-email' : '#email-input';
      if (scenario === 'used-up-mail') {
        await shot('settings');
        await click(page, '.host-verify .verify-entry');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
      }
      rects.push({ label, scenario, state: 'capture-input', targets: [inputSelector], boxes: await sample([inputSelector]) });
      await shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).focus(), inputSelector);
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.id), inputSelector.slice(1));
      const targets = [scenario === 'used-up-mail' ? 'dialog.verify-dialog' : 'dialog.settings', '.display-foot'];
      if (scenario === 'used-up-mail') targets.push('.verify-dialog .verify__field', '.verify-dialog .verify__actions');
      const before = await sample(targets);
      rects.push({ label, scenario, state: 'upgrade', targets: ['.composer-out__upgrade'], boxes: upgrade });
      await shot('capture');
      await shadow(page, (c, selector) => { const input = c.shadowRoot.querySelector(selector); input.value = 'recovered@example.test'; input.form.requestSubmit(); }, inputSelector);
      await until(page, () => window.ait164.address === 'recovered@example.test' && document.querySelector('aithema-session').shadowRoot.querySelector('.m-addr').textContent === 'recovered@example.test');
      assert.equal(await page.evaluate(() => window.ait164.noticeVersion), 'ait-135-v1');
      await settle(page); await compare(targets, before, 'saved'); await shot('saved');
      if (scenario === 'used-up-mail') await shadow(page, c => c.shadowRoot.querySelector('dialog.verify-dialog').close());
      await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').close());
    } else if (scenario === 'refused-focus') {
      // The entrance reveal owns a finite timer as well as CSS animations.
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').hasAttribute('data-reveal'));
      await settle(page);
      await page.evaluate(() => window.ait164.reply());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer'));
      const targets = ['.email-offer', '.email-offer__row', '.email-offer__send', '.composer-shell'], before = await sample(targets);
      await page.evaluate(() => { window.ait164.saveStatus = 400; window.ait164.saving = true; });
      const input = await page.evaluateHandle(() => document.querySelector('aithema-session').shadowRoot.querySelector('#email-offer-input'));
      await input.evaluate(input => { input.value = 'a(b)@example.com'; input.focus(); });
      await page.keyboard.press('Enter');
      await until(page, () => window.ait164.requests.includes('save'));
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.id), 'email-offer-input', `${label}: focus stays during Enter save`);
      await page.evaluate(() => { window.ait164.saving = false; });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email-offer-input').getAttribute('aria-invalid') === 'true');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.id), 'email-offer-input', `${label}: focus stays after 400`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-offer-input').value), 'a(b)@example.com');
      await settle(page); await compare(targets, before, 'refused'); await shot('refused');
    } else {
      await openCredits(page);
      await settle(page);
      const targets = ['.host-credits', '.credits-popup', '.host-credits__scope', '.host-credits__current'];
      if (scenario === 'saved-address') targets.push('.credits-email', '.host-credits__next');
      const before = await sample(targets);
      const link = await shadow(page, c => { const link = c.shadowRoot.querySelector('.credits-email'); return { hidden: link.hidden, deferred: link.hasAttribute('data-capture-deferred'), display: getComputedStyle(link).display, visibility: getComputedStyle(link).visibility }; });
      assert.equal(link.deferred, false, `${label}: ${scenario} has no deferred capture slot`);
      if (scenario === 'saved-address') { assert.equal(link.hidden, false); assert.equal(link.visibility, 'visible'); }
      else { assert.equal(link.hidden, true); assert.equal(link.display, 'none'); }
      await shot('before-input');
      await page.evaluate(() => window.ait164.reply()); await settle(page);
      await compare(targets, before, 'after-input'); await shot('after-input');
    }
  }
  if (evidence) await writeFile(join(evidence, `ait-507-b7-${scenario}-rects.json`), JSON.stringify(rects, null, 2));
});
for (const finding of ['M3', 'M4', 'M6']) test(`AIT-540 ${finding}: one readable in-chat offer from page scroll zero`, { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-rc25-offer-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE:'off', AITHEMA_IMAGE_MODE:'off', AITHEMA_HTML_MODE:'off' });
  const browser = await browserForFile(), page = await browser.newPage();
  const evidence=process.env.AITHEMA_EVIDENCE_DIR, records=[];
  if(evidence) await mkdir(join(evidence,'shots'),{recursive:true});
  t.after(async () => { await browser.close(); await demo.kill(); });
  await page.evaluateOnNewDocument(() => { const OriginalDate=Date; window.Date=class extends OriginalDate { constructor(...args){super(...(args.length?args:[100_000]));} static now(){return 100_000;} }; });
  await page.goto(demo.url, {waitUntil:'domcontentloaded'}); await until(page,()=>document.querySelector('aithema-session')?.session);
  for (const locale of ['en','de']) for (const theme of ['light','dark']) for (const width of (finding==='M4'?[390,520,521,1024,1440]:[390,1024,1440])) await t.test(`${locale}/${theme}/${width}`,async()=>{
    await page.setViewport({width,height:width===390?844:1000});
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]);
    if (finding === 'M6') {
      // Each active-call capture owns a fresh session; no previous call can still be ending.
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session);
    }
    await fixture(page,locale,{opener:true,delivery:true,emailOffer:{afterMessages:2},initialMessages:1,lock:true,voice:finding==='M6'});
    await shadow(page,(c,theme)=>c.setAttribute('theme',theme),theme);
    await page.evaluate(()=>window.scrollTo(0,0)); await settle(page);
    await shadow(page,c=>c.shadowRoot.querySelector('textarea').focus({preventScroll:true}));
    const before=await shadow(page,c=>({focus:c.shadowRoot.activeElement?.id,scroll:scrollY}));
    await page.evaluate(()=>window.ait164.reply()); await until(page,()=>document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await settle(page);
    if (finding === 'M6') assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').dataset.call), 'active', 'M6 evidence requires an active call');
    const view=await shadow(page,c=>{
      const r=c.shadowRoot, offer=r.querySelector('.email-offer'), lock=r.querySelector('.verify-lock');
      const rect=n=>n.getBoundingClientRect().toJSON();
      return {offer:rect(offer),pane:rect(r.querySelector('.transcript-shell')),field:rect(offer.querySelector('input')),button:rect(offer.querySelector('.email-offer__send')),
        row:rect(offer.querySelector('.email-offer__row')),lead:rect(offer.querySelector('.email-offer__lead')),
        layout:['.band','.conversation-scroll','.concept-bar','.concept-thread','.transcript-shell'].map(s=>{const n=r.querySelector(s);return {selector:s,box:rect(n),scroll:n.scrollTop,client:n.clientHeight,content:n.scrollHeight,inset:n.style.getPropertyValue('--transcript-top-inset')};}),
        focus:r.activeElement?.id,scroll:scrollY,lockHidden:lock.hidden,lockTitle:lock.querySelector('h3').textContent,lockLead:lock.querySelector('.verify-lock__lead').textContent,
        lockFormVisible:!![...lock.querySelectorAll('form')].find(n=>n.getBoundingClientRect().height>0),closeSvg:!!offer.querySelector('.email-offer__dismiss svg')};
    });
    records.push({locale,theme,width,finding,before,view});
    if(evidence) {
      await writeFile(join(evidence,`ait-540-${finding}-rects.json`),JSON.stringify(records,null,2));
      if(width!==1024) await page.screenshot({path:join(evidence,'shots',`ait-540-${finding}-${locale}-${theme}-${width}-during-call.png`),fullPage:false});
    }
    for(const name of ['offer','pane','field','button','row','lead']) assert.ok(view[name].width>0&&view[name].height>0,`${name}: positive box`);
    if(finding==='M3') {
      assert.equal(view.lockHidden,false,'overview keeps title and lead'); assert.ok(view.lockTitle&&view.lockLead);
      assert.equal(view.lockFormVisible,false,'AIT-540 M3: visible offer owns the only email form');
    } else if(finding==='M4') {
      assert.equal(view.closeSvg,true,'AIT-540 M4: dismiss uses the shared SVG icon');
      if(width<=520){assert.ok(Math.abs(view.field.width-view.row.width)<=.5,'full-width phone field');assert.ok(Math.abs(view.button.width-view.row.width)<=.5,'full-width phone button');assert.ok(view.button.top>=view.field.bottom,'phone button below field');}
      assert.ok(view.button.height>=44,'actual 44px button');
    } else {
      assert.equal(view.scroll,before.scroll,'offer never scrolls the page');assert.equal(view.focus,before.focus,'offer never takes focus');
      if(width===390) assert.ok(view.offer.top>=view.pane.top-.5&&view.offer.bottom<=view.pane.bottom+.5,`AIT-540 M6: complete during-call offer fits: ${JSON.stringify(view)}`);
    }
  });
});

test('AIT-540 M6: reloaded open offer preserves the latest turn, page scroll and focus', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-offer-reload-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, records = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(join(evidence, 'shots'), { recursive: true });
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  let restoreDocument;
  await page.setRequestInterception(true);
  page.on('request', request => { void (new URL(request.url()).pathname === '/ait540-restore'
    ? request.respond({ status: 200, contentType: 'text/html', body: restoreDocument }) : request.continue()); });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 2 }, initialMessages: 1, lock: true });
    await page.evaluate(() => window.ait164.reply());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer'));
    // Persist an open offer followed by many complete turns, not a tail offer.
    for (let i = 0; i < 8; i++) await page.evaluate(() => window.ait164.reply());
    await settle(page);
    const saved = await shadow(page, c => ({ session: c.session, credits: window.ait164.credits() }));
    restoreDocument = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><style>body{margin:0}aithema-session{--aithema-height:100dvh}</style><body><script type="module">
      import '/packages/ui/src/session-element.js';
      import {${locale} as copy} from '/packages/ui/src/i18n/${locale}.js';
      const saved=${JSON.stringify(saved).replaceAll('<', '\\u003c')};
      const c=document.createElement('aithema-session');c.setAttribute('theme','${theme}');c.setAttribute('motion','off');
      c.innerHTML='<a slot="legal" data-aithema-privacy href="/privacy">Privacy</a>';document.body.append(c);
      const creditsReady=new Promise(resolve=>globalThis.releaseCredits=resolve);
      globalThis.fetch=async(url,init={})=>{
        const path=new URL(url,location.href).pathname;
        if(path.endsWith('/events'))return new Response(new ReadableStream({start(controller){init.signal?.addEventListener('abort',()=>controller.close(),{once:true})}}));
        if(path.endsWith('/credits')){await creditsReady;return Response.json(saved.credits);}
        if(path.endsWith('/visitor/email'))return Response.json({visitor:{address:null,tier:'anonymous'},notice:{version:'ait-135-v1',deliveryEnabled:true},privacyDocumentConfigured:true});
        if(path.endsWith('/identity'))return Response.json({identity:saved.session.identity,delivery:true,privacyDocumentConfigured:true,visitorEmail:{canSave:true,canDelete:true}});
        return Response.json(saved.session);
      };
      c.configure({session:saved.session,copy,entrance:'combined',host:{credits:true,verification:{delivery:true,privacyDocumentConfigured:true}}});
      globalThis.ready=true;
    </script></body></html>`;
    await page.goto(`${demo.url}/ait540-restore`); await page.waitForFunction(() => globalThis.ready);
    // Reload the same persisted snapshot, then deliver credits after first paint.
    await page.reload(); await page.waitForFunction(() => globalThis.ready); await settle(page);
    await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }));
    const sample = () => shadow(page, c => {
      const r = c.shadowRoot, rect = n => n.getBoundingClientRect().toJSON();
      return { latest: rect(r.querySelector('ol > .turn:last-child')), pane: rect(r.querySelector('.transcript-shell')),
        page: [scrollX, scrollY], focus: r.activeElement?.id, offer: r.querySelector('.email-offer') ? rect(r.querySelector('.email-offer')) : null };
    });
    const before = await sample();
    await page.evaluate(() => globalThis.releaseCredits());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await settle(page);
    const after = await sample(); records.push({ locale, theme, before, after });
    if (evidence) {
      await writeFile(join(evidence, 'ait-540-M6-reload-rects.json'), JSON.stringify(records, null, 2));
      await page.screenshot({ path: join(evidence, 'shots', `ait-540-M6-${locale}-${theme}-390-reloaded-offer.png`) });
    }
    for (const state of [before, after]) for (const name of ['latest', 'pane']) assert.ok(state[name].width > 0 && state[name].height > 0, `${name}: positive reload box`);
    assert.ok(after.offer.width > 0 && after.offer.height > 0, 'restored offer has a positive box');
    assert.deepEqual(after.page, before.page, 'restoring an offer preserves page scroll');
    assert.equal(after.focus, before.focus, 'restoring an offer preserves focus');
    assert.ok(after.latest.top >= after.pane.top - .5 && after.latest.bottom <= after.pane.bottom + .5,
      `AIT-540 M6: reload keeps the latest turn in view: ${JSON.stringify(after)}`);
  }
});

test('AIT-543: identity-only offer sent and failure matrix, EN/DE light/dark 390/1440; zero layout shift', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-identity-offer-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, records = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(join(evidence, 'ait-543'), { recursive: true });
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) await t.test(`${locale}/${theme}/${width}`, async () => {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await fixture(page, locale, { visitorStore: false, opener: true, delivery: true, emailOffer: { afterMessages: 1 }, initialMessages: 0 });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
    await page.evaluate(() => window.ait164.reply());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await settle(page);
    const { [locale]: copy } = await import(`../../packages/ui/src/i18n/${locale}.js`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-offer__lead').textContent), copy.hostSurface.usedUp.hostConfirm.replace('{delta}', new Intl.NumberFormat(locale).format(1200)));
    const targets = ['.email-offer', '.email-offer__row', '.email-offer__send', '.email-offer__message-slot', '.composer-shell', '.display-foot'];
    const sample = async () => {
      const result = await boxes(page, targets);
      for (const [i, box] of result.entries()) assert.ok(box[2] > 0 && box[3] > 0, `${label}/${targets[i]}: positive box ${box}`);
      return result;
    };
    const baseline = await sample();
    const capture = async state => {
      await settle(page);
      const after = await sample(), shift = stable(baseline, after, `${label}/${state}`);
      records.push({ head: evidenceCommit, locale, theme, width, state, targets, before: baseline, after, shift });
      if (evidence) {
        await page.screenshot({ path: join(evidence, 'ait-543', `${label}-${state}.png`) });
        await writeFile(join(evidence, 'ait-543', 'geometry.json'), JSON.stringify(records, null, 2));
      }
    };
    const submit = () => shadow(page, c => { const input = c.shadowRoot.querySelector('#email-offer-input'); input.value = 'visitor@example.test'; input.focus({ preventScroll: true }); input.form.requestSubmit(); });
    for (const [state, status, key] of [['failure', 503, 'failed'], ['rate-limited', 429, 'rateLimited']]) {
      await page.evaluate(status => { window.ait164.linkStatus = status; }, status);
      const previous = await page.evaluate(() => window.ait164.identityCommands?.length ?? 0);
      await submit();
      await until(page, previous => (window.ait164.identityCommands?.length ?? 0) > previous, previous);
      await until(page, text => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__message').textContent === text, copy.hostSurface.verify[key]);
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.id), 'email-offer-input');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-offer-input').value), 'visitor@example.test');
      await capture(state);
    }
    await page.evaluate(() => { window.ait164.linkStatus = 200; window.ait164.linking = true; });
    await submit();
    await until(page, text => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__message').textContent === text, copy.hostSurface.verify.sending);
    await capture('sending');
    await page.evaluate(() => { window.ait164.linking = false; });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer').dataset.step === 'sent');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-offer__message').textContent), copy.hostSurface.verify.sent);
    const address = await boxes(page, ['.email-offer__address']);
    assert.ok(address[0][2] > 0 && address[0][3] > 0, 'sent address has positive geometry');
    assert.equal(await page.evaluate(() => window.ait164.credits().tiers.current), 'anonymous', 'credit remains unchanged until confirmation');
    await capture('sent');
    await click(page, '.email-offer__send');
    await until(page, () => window.ait164.identityCommands.at(-1).command === 'resend');
    assert.deepEqual(await page.evaluate(() => window.ait164.identityCommands.map(call => call.command)), ['request', 'request', 'request', 'resend']);
    assert.deepEqual(await page.evaluate(() => window.ait164.identityCommands.at(-1).body), {});
    assert.equal(await page.evaluate(() => window.ait164.requests.includes('save') || window.ait164.requests.includes('refused-save')), false, 'no visitor PUT, refused or successful');
    assert.equal(await page.evaluate(() => window.ait164.visitorReads), 0, 'explicit capability also avoids the unavailable read');
  });
});
