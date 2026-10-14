// AIT-171: shipped Settings geometry; all identity/mail routes are local fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, evidenceCommit } from './start2-display-helpers.js';

const click = (page, selector) => shadow(page, (c, s) => c.shadowRoot.querySelector(s).click(), selector);
const frame = async page => { await page.bringToFront(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
const geometry = page => shadow(page, c => {
  const r = c.shadowRoot, entry = r.querySelector('#email'), stack = entry.querySelector('.m-stack');
  const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  const mail = entry.querySelector('[data-view=mail]'), notice = mail.querySelector('.m-notice');
  return { mailAction: box(mail.querySelector('.verify-entry')), boxes: ['#email', '.operator-section', '.settings__footer'].map(s => box(r.querySelector(s))),
    stackHeight: stack.getBoundingClientRect().height, mailHeight: notice.getBoundingClientRect().bottom - mail.getBoundingClientRect().top,
    reservationGap: stack.getBoundingClientRect().bottom - notice.getBoundingClientRect().bottom,
    hairlineGap: r.querySelector('.operator-section').getBoundingClientRect().top - notice.getBoundingClientRect().bottom,
    rowGap: parseFloat(getComputedStyle(r.querySelector('.general')).rowGap), lineHeight: parseFloat(getComputedStyle(notice).lineHeight) };
});

async function fixture(page, locale, delivery, canConfirm = delivery, credits = {}) {
  await shadow(page, async (c, options) => {
    const { locale, delivery, canConfirm, credits } = options;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { Verification } = await import('/packages/ui/src/verification.js');
    window.emailOriginalFetch ??= window.fetch.bind(window);
    window.emailSetCredits ??= Verification.prototype.setCredits;
    Verification.prototype.setCredits = function (credits) { window.emailBoot.creditsCalls++; window.emailBoot.settingsOpenAtCredits.push(c.shadowRoot.querySelector('dialog.settings').open); return window.emailSetCredits.call(this, credits); };
    const state = window.emailBoot = { address: null, status: 'guest', delivery: 'sent', spent: 0, hold: false, failure: false, rateLimited: false, creditsCalls: 0, settingsOpenAtCredits: [], canConfirm, holdCredits: Boolean(credits.hold), failCredits: Boolean(credits.fail), creditsRequests: 0, creditsFinished: 0, visitorReads: 0, linkRequests: 0 };
    const allowancesMicro = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
    const current = () => state.status === 'verified' ? 'emailConfirmed' : state.address ? 'emailGiven' : 'anonymous';
    const identity = () => ({ ...c.session.identity, address: state.address, status: state.status, delivery: state.delivery,
      verificationRequired: false, assessmentUnlocked: true, conceptsUnlocked: true, pollVerification: false, resendAfterMs: 0 });
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, method = init.method ?? 'GET';
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/credits')) {
        state.creditsRequests++;
        while (state.holdCredits) await new Promise(resolve => setTimeout(resolve, 10));
        state.creditsFinished++;
        if (state.failCredits) return Response.json({}, { status: 503 });
        return Response.json({ balance: { owner: { limitMicro: allowancesMicro[current()], committedMicro: state.spent, availableMicro: allowancesMicro[current()] - state.spent } }, exhausted: false, limitSlot: null,
        tiers: { current: current(), next: !state.address ? 'emailGiven' : state.canConfirm ? 'emailConfirmed' : null, canConfirm: state.canConfirm, allowancesMicro } });
      }
      if (path === '/api/visitor/email') {
        state.visitorReads++;
        if (method === 'PUT' || method === 'DELETE') {
          while (state.hold) await new Promise(resolve => setTimeout(resolve, 10));
          if (state.failure) return Response.json({}, { status: 503 });
          state.address = method === 'PUT' ? JSON.parse(init.body).address : null; state.status = 'guest';
        }
        return Response.json({ visitor: { address: state.address }, notice: { version: 'ait-171-fixture', deliveryEnabled: delivery }, privacyDocumentConfigured: true });
      }
      if (path.endsWith('/identity')) return Response.json({ identity: identity(), delivery, privacyDocumentConfigured: true });
      if (/\/identity\/(request|change|resend)$/u.test(path)) {
        state.linkRequests++;
        while (state.hold) await new Promise(resolve => setTimeout(resolve, 10));
        state.status = 'verification-pending'; state.delivery = state.failure ? 'failed' : 'sent';
        return Response.json({ identity: identity() }, { status: state.rateLimited ? 429 : 200 });
      }
      return window.emailOriginalFetch(url, init);
    };
    for (const legal of c.querySelectorAll('[slot=legal]')) legal.remove();
    const legal = document.createElement('a'); legal.slot = 'legal'; legal.href = '/privacy'; legal.setAttribute('data-aithema-privacy', ''); legal.textContent = locale === 'de' ? 'Datenschutz' : 'Privacy'; c.append(legal);
    const session = structuredClone(c.session); session.locale = locale; session.demo = false; session.identity = identity();
    c.setAttribute('motion', 'off');
    c.configure({ session, copy, host: { credits: true, verification: { delivery, privacyDocumentConfigured: true }, operator: { url: '/api/operator/login/', logoutUrl: '/api/operator/logout/', provider: 'Zitadel' } } });
  }, { locale, delivery, canConfirm, credits });
  if (credits.hold) await until(page, () => window.emailBoot.creditsRequests > 0 && window.emailBoot.visitorReads > 0);
  else await until(page, () => window.emailBoot.creditsCalls > 0 && document.querySelector('aithema-session').shadowRoot.querySelector('.m-lead-save').textContent);
  // No Settings visit triggers this read: HostSurface.connect -> loadCredits -> setCredits.
  assert.deepEqual(await page.evaluate(() => window.emailBoot.settingsOpenAtCredits), credits.hold ? [] : [false]);
  await page.evaluate(() => document.fonts.ready);
  await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
  await shadow(page, c => { const body = c.shadowRoot.querySelector('.settings__body'); body.scrollTop = body.scrollHeight; });
  await frame(page);
}

test('AIT-171: mail-only reservation, boot tiers, zero shift and unchanged save geometry; 390/1024/1440 L/D DE/EN', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-email-space-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  // Render main's two email modules on this same runner: platform fonts must match.
  const baseline = JSON.parse(await readFile(new URL('../fixtures/email-save-baseline.json', import.meta.url), 'utf8'));
  const rows = [], saves = {}, shots = [];
  const record = async (page, label, state, metrics, shiftPx) => {
    const row = { head: evidenceCommit, label, state, ...metrics, shiftPx, bootCreditsBeforeSettings: await page.evaluate(() => window.emailBoot.settingsOpenAtCredits[0] === false) }; rows.push(row);
    t.diagnostic(`${shiftPx === 0 && (state !== 'mail-none' || metrics.reservationGap <= metrics.lineHeight && metrics.hairlineGap <= metrics.lineHeight) ? 'PASS' : 'FAIL'} AIT-171 ${label}/${state}: gap=${metrics.reservationGap.toFixed(3)} px; hairline=${metrics.hairlineGap.toFixed(3)} px; shift=${shiftPx} px`);
    if (evidence && ['mail-none', 'mail-sent', 'save-none'].includes(state)) {
      const name = `ait-171-${evidenceCommit}-${label}-${state}.png`; await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name);
    }
  };
  const comparePixels = async (page, mainPage, clip, label) => {
    // Each tab must be foreground and painted when its focused pixels are read.
    await frame(page); const actual = await page.screenshot({ clip });
    await frame(mainPage); const expected = await mainPage.screenshot({ clip });
    if (!actual.equals(expected) && evidence) {
      await writeFile(join(evidence, `ait-171-${evidenceCommit}-${label}-save-current-mismatch.png`), actual);
      await writeFile(join(evidence, `ait-171-${evidenceCommit}-${label}-save-main-mismatch.png`), expected);
    }
    assert.ok(actual.equals(expected), `${label}: save pixels match main ${baseline.sourceHead}`);
  };
  for (const locale of ['de', 'en']) {
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(dir, 'chrome-' + locale), env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(), mainPage = await browser.newPage();
    await mainPage.setRequestInterception(true);
    mainPage.on('request', request => { const source = baseline.modules[new URL(request.url()).pathname.slice(1)]; if (source) void request.respond({ status: 200, contentType: 'text/javascript', body: source }); else void request.continue(); });
    await mainPage.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await mainPage.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(mainPage, () => document.querySelector('aithema-session')?.session);
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
      const label = `${locale}-${theme}-${width}`;
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await fixture(page, locale, false); const save = await geometry(page); saves[label] = save.boxes; await record(page, label, 'save-none', save, 0);
      await mainPage.setViewport({ width, height: width === 390 ? 844 : 1000 }); await mainPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await fixture(mainPage, locale, false);
      assert.deepEqual(save.boxes, (await geometry(mainPage)).boxes, `${label}: save geometry matches main ${baseline.sourceHead}`);
      // Compare the visible email section's PNG bytes, with focus away from the input caret.
      for (const p of [page, mainPage]) { await shadow(p, c => c.shadowRoot.querySelector('#email-heading').focus({ preventScroll: true })); await frame(p); }
      const clip = await shadow(page, c => { const b = c.shadowRoot.querySelector('#email').getBoundingClientRect(), body = c.shadowRoot.querySelector('.settings__body').getBoundingClientRect(); const y = Math.max(b.y, body.y), bottom = Math.min(b.bottom, body.bottom); return { x: b.x, y, width: b.width, height: bottom - y }; });
      await comparePixels(page, mainPage, clip, label);
      await fixture(page, locale, true, false); assert.deepEqual((await geometry(page)).boxes, save.boxes, 'confirmation off retains save geometry');
      await shadow(page, c => c.shadowRoot.querySelector('#email-heading').focus({ preventScroll: true })); await frame(page);
      await comparePixels(page, mainPage, clip, label + '-confirmation-off');
      await fixture(page, locale, true); const before = await geometry(page); await record(page, label, 'mail-none', before, 0);
      await t.test(`${label}: mail content owns height`, () => {
        assert.ok(before.hairlineGap <= before.lineHeight, `content-to-hairline gap ${before.hairlineGap} px exceeds one line ${before.lineHeight} px`);
        assert.ok(before.reservationGap <= before.lineHeight, `unused reservation ${before.reservationGap} px exceeds one line ${before.lineHeight} px`);
        assert.ok(Math.abs(before.stackHeight - before.mailHeight) < 1, `stack ${before.stackHeight} px vs mail ${before.mailHeight} px`);
      });
      const check = async state => {
        const temporarilyOpen = await shadow(page, c => { const r = c.shadowRoot, closed = !r.querySelector('dialog.settings').open; if (closed) c.openSettings(undefined, { tab: 'general', anchor: '#email' }); const body = r.querySelector('.settings__body'); body.scrollTop = body.scrollHeight; return closed; });
        await frame(page); const after = await geometry(page);
        const shift = Math.max(...before.boxes.flatMap((box, i) => box.map((v, j) => Math.abs(v - after.boxes[i][j]))));
        await record(page, label, state, after, shift);
        await t.test(`${label}/${state}: 0 px shift`, () => assert.equal(shift, 0));
        if (temporarilyOpen) await click(page, 'dialog.settings .done');
      };
      await check('boot-settled');
      await click(page, '.verify-entry');
      await shadow(page, c => { window.emailBoot.hold = true; const f = c.shadowRoot.querySelector('dialog.verify-dialog .verify-form'); f.querySelector('input').value = 'reader@example.test'; f.requestSubmit(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog .verify-send').getAttribute('aria-disabled') === 'true'); await check('mail-sending');
      await page.evaluate(() => { window.emailBoot.hold = false; });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email').dataset.emailState === 'pending');
      await click(page, '.verify-dialog-close'); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
      await check('mail-sent');
      await click(page, '.verify-entry'); await page.evaluate(() => { window.emailBoot.failure = true; }); await click(page, 'dialog.verify-dialog .verify-resend');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog .verify__message').textContent.length > 0); await check('mail-failed');
      await page.evaluate(() => { window.emailBoot.failure = false; window.emailBoot.rateLimited = true; }); await click(page, 'dialog.verify-dialog .verify-resend'); await frame(page); await check('mail-rate-limited');
      await click(page, '.verify-dialog-close'); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
      await shadow(page, c => { window.emailBoot.status = 'verified'; c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity, address: window.emailBoot.address, status: 'verified', assessmentUnlocked: true, conceptsUnlocked: true } }); }); await check('mail-confirmed');
      await shadow(page, c => { window.emailBoot.address = 'a'.repeat(230) + '@example.test'; c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity, address: window.emailBoot.address } }); }); await check('mail-long-address');
      await click(page, '.m-delete-mail'); await check('mail-delete-confirm');
      await shadow(page, c => { window.emailBoot.failure = true; c.shadowRoot.querySelector('.m-del').click(); }); await frame(page); await check('mail-delete-failed');
      await shadow(page, c => { window.emailBoot.failure = false; window.emailBoot.hold = true; c.shadowRoot.querySelector('.m-del').click(); }); await frame(page); await check('mail-deleting');
      await page.evaluate(() => { window.emailBoot.hold = false; }); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email').dataset.emailState === 'mailnone'); await check('mail-deleted');
    }
    await browser.close(); browser = null;
  }
  if (evidence) {
    await writeFile(join(evidence, 'ait-171-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, rows, shots }, null, 2));
    await writeFile(join(evidence, 'email-save-geometry.json'), JSON.stringify(saves, null, 2));
  }
});


// Exercise real HostSurface reads while the visitor keeps Settings open. All
// requests, including confirmation after an operator flip, stay in this fixture.
test('AIT-171: latch open Settings through delayed/failed credits and both policy flips', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-email-latch-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const rows = [], shots = [];
  const shift = (before, after) => Math.max(...before.boxes.flatMap((box, i) => box.map((v, j) => Math.abs(v - after.boxes[i][j]))));
  const refresh = async (page, canConfirm) => {
    const calls = await shadow(page, (c, value) => {
      window.emailBoot.canConfirm = value;
      c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: {} });
      return window.emailBoot.creditsCalls;
    }, canConfirm);
    await until(page, calls => window.emailBoot.creditsCalls > calls, calls);
    await frame(page);
  };
  for (const locale of ['de', 'en']) {
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(dir, 'chrome-' + locale), env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
      const label = `${locale}-${theme}-${width}`;
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await fixture(page, locale, true, false); const saveHeight = (await geometry(page)).stackHeight;
      await fixture(page, locale, true, true); const mailHeight = (await geometry(page)).stackHeight;
      for (const scenario of ['delayed', 'failed', 'mail-to-save', 'save-to-mail']) {
        const unknown = ['delayed', 'failed'].includes(scenario), initialMail = scenario !== 'save-to-mail';
        await fixture(page, locale, true, initialMail, unknown ? { hold: true, fail: scenario === 'failed' } : {});
        const before = await geometry(page), initialMode = initialMail ? 'mail' : 'save';
        if (unknown) {
          await t.test(`${label}/${scenario}: full union at open`, async () => {
            assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('[data-view=capture]')).display), 'grid');
            assert.ok(before.stackHeight >= saveHeight, 'unknown tiers reserve the full save/mail union');
          });
          if (evidence && scenario === 'delayed') {
            const name = `ait-171-${evidenceCommit}-${label}-tiers-unknown-at-open.png`;
            await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name);
          }
          await page.evaluate(() => { window.emailBoot.holdCredits = false; });
          await until(page, () => window.emailBoot.creditsFinished > 0);
          if (scenario === 'failed') {
            await frame(page);
            const failedShift = shift(before, await geometry(page));
            rows.push({ head: evidenceCommit, label, scenario: 'failed-load', shiftPx: failedShift });
            t.diagnostic(`${failedShift === 0 ? 'PASS' : 'FAIL'} AIT-171 ${label}/failed-load: shift=${failedShift} px`);
            await t.test(`${label}/failed-load: 0 px shift`, () => assert.equal(failedShift, 0));
            await page.evaluate(() => { window.emailBoot.failCredits = false; });
            await refresh(page, false);
          } else await until(page, () => window.emailBoot.creditsCalls > 0);
        } else await refresh(page, !initialMail);
        await frame(page);
        const after = await geometry(page), shiftPx = shift(before, after);
        const actionShiftPx = initialMail ? Math.max(...before.mailAction.map((v, i) => Math.abs(v - after.mailAction[i]))) : 0;
        const mode = await shadow(page, c => c.shadowRoot.querySelector('#email').dataset.emailMode);
        rows.push({ head: evidenceCommit, label, scenario, shiftPx, actionShiftPx, beforeHeight: before.stackHeight, afterHeight: after.stackHeight, mode });
        t.diagnostic(`${shiftPx === 0 && actionShiftPx === 0 && mode === initialMode ? 'PASS' : 'FAIL'} AIT-171 ${label}/${scenario}: shift=${shiftPx} px; action=${actionShiftPx} px; mode=${mode}; height=${before.stackHeight}/${after.stackHeight}`);
        await t.test(`${label}/${scenario}: latched mode and 0 px shift`, () => { assert.equal(mode, initialMode); assert.equal(shiftPx, 0); assert.equal(actionShiftPx, 0, 'mail action stays under the pointer'); });
        await t.test(`${label}/${scenario}: measure remains aria-hidden`, async () => assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.m-mail-tier-measure').getAttribute('aria-hidden')), 'true'));
        await click(page, 'dialog.settings .done');
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
        await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await frame(page);
        const nextMail = scenario === 'delayed' || scenario === 'save-to-mail';
        await t.test(`${label}/${scenario}: reopen applies current mode and reservation`, async () => {
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email').dataset.emailMode), nextMail ? 'mail' : 'save');
          assert.equal((await geometry(page)).stackHeight, nextMail ? mailHeight : saveHeight);
        });
        if (scenario === 'mail-to-save') {
          // A click during the stale mail presentation still saves first and
          // receives the server's indistinguishable confirmation response.
          await fixture(page, locale, true, true); await refresh(page, false);
          await click(page, '.verify-entry');
          await t.test(`${label}: stale mail action still opens and saves`, async () => {
            assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.verify-dialog').open), true);
            await shadow(page, c => { const f = c.shadowRoot.querySelector('dialog.verify-dialog .verify-form'); f.querySelector('input').value = 'latched-reader@example.test'; f.requestSubmit(); });
            await until(page, () => window.emailBoot.linkRequests > 0);
            assert.equal(await page.evaluate(() => window.emailBoot.address), 'latched-reader@example.test');
            await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#email').dataset.emailState === 'saved');
          });
          await click(page, '.verify-dialog-close');
        }
      }
    }
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'ait-171-latch-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, rows, shots }, null, 2));
});
