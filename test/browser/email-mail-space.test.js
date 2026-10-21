// AIT-171: shipped Settings geometry; all identity/mail routes are local fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';
import { shadow, until, evidenceCommit } from './start2-display-helpers.js';

const click = (page, selector) => shadow(page, (c, s) => c.shadowRoot.querySelector(s).click(), selector);
const frame = async page => { await page.bringToFront(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
// Opening/focusing and Done's acknowledged save can finish after a protocol
// round trip. Measure an open, scroll-idle dialog, never its hidden zero boxes.
async function settleSettings(page) {
  await page.bringToFront();
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
  await shadow(page, async c => {
    await document.fonts.ready;
    const r = c.shadowRoot, dialog = r.querySelector('dialog.settings'), body = r.querySelector('.settings__body');
    const snapshot = () => ({ open: dialog.open, scrollTop: body.scrollTop,
      boxes: ['dialog.settings', '#email', '.operator-section', '.settings__footer'].map(s => {
        const b = r.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
      }) });
    let previous, current;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      current = snapshot();
      const animating = dialog.getAnimations({ subtree: true }).some(a => a.pending || a.playState === 'running');
      if (current.open && document.fonts.status === 'loaded' && !animating && current.boxes.every(b => b[2] > 0 && b[3] > 0)) {
        const measured = JSON.stringify(current);
        if (measured === previous) return;
        previous = measured;
      } else previous = undefined;
    }
    throw new Error(`Settings did not settle: ${JSON.stringify(current)}`);
  });
}
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
      if (path.endsWith('/identity')) return Response.json({ identity: identity(), visitorEmail: { canSave: true, canDelete: true }, delivery, privacyDocumentConfigured: true });
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
    if (credits.replyAvailable) session.featureMatrix = { best: { text: { available: true }, analysis: { available: false, reason: 'not configured' } } };
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
  await settleSettings(page);
}

test('AIT-237: a held Done save preserves reopened Settings and its email scroll', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-settings-done-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session);
  await fixture(page, 'de', true);
  await page.evaluate(() => {
    const fetch = window.fetch, held = Promise.withResolvers();
    window.doneSave = { posts: [], release: held.resolve };
    window.fetch = async (url, init = {}) => {
      if (new URL(url, location.href).pathname.endsWith('/settings') && init.method === 'POST') {
        window.doneSave.posts.push(JSON.parse(init.body));
        await held.promise;
      }
      return fetch(url, init);
    };
  });
  assert.notEqual(await shadow(page, c => c.session.settings.origin), 'chosen');
  await click(page, 'dialog.settings .done');
  await until(page, () => window.doneSave.posts.length === 1);
  assert.equal(await page.evaluate(() => window.doneSave.posts[0].confirm), true);
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), true, 'Done waits for the acknowledgement');
  await page.keyboard.press('Escape');
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), false);
  await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
  await settleSettings(page);
  const scrollTop = await shadow(page, c => c.shadowRoot.querySelector('.settings__body').scrollTop);
  const before = await geometry(page);
  assert.ok(scrollTop > 0, 'the reopened email cell is scrolled into view');
  await page.evaluate(() => window.doneSave.release());
  await until(page, () => {
    const c = document.querySelector('aithema-session');
    return c.session.settings.origin === 'chosen' && c.shadowRoot.querySelector('dialog.settings').getAttribute('aria-busy') === 'false';
  });
  await settleSettings(page);
  const open = await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open);
  const afterScroll = await shadow(page, c => c.shadowRoot.querySelector('.settings__body').scrollTop);
  t.diagnostic(`held Done released: reopened Settings open=${open}; scroll=${scrollTop}/${afterScroll}`);
  assert.equal(open, true, 'the earlier Done must not close reopened Settings');
  assert.equal(afterScroll, scrollTop, 'the earlier Done must not rescroll reopened Settings');
  assert.deepEqual((await geometry(page)).boxes, before.boxes, 'the reopened email geometry stays unchanged');
  assert.equal(await page.evaluate(() => window.doneSave.posts.length), 1, 'the explicit confirmation still records chosen once');
});

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
    for (const p of [page, mainPage]) await shadow(p, c => { c.shadowRoot.querySelector('#email-notice').style.visibility = 'hidden'; });
    await frame(page); const actual = await page.screenshot({ clip });
    await frame(mainPage); const expected = await mainPage.screenshot({ clip });
    if (!actual.equals(expected) && evidence) {
      await writeFile(join(evidence, `ait-171-${evidenceCommit}-${label}-save-current-mismatch.png`), actual);
      await writeFile(join(evidence, `ait-171-${evidenceCommit}-${label}-save-main-mismatch.png`), expected);
    }
    for (const p of [page, mainPage]) await shadow(p, c => { c.shadowRoot.querySelector('#email-notice').style.visibility = ''; });
    assert.ok(actual.equals(expected), `${label}: save pixels outside the privacy line match main ${baseline.sourceHead}`);
  };
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage(), mainPage = await browser.newPage();
    await mainPage.setRequestInterception(true);
    mainPage.on('request', request => { const source = baseline.modules[new URL(request.url()).pathname.slice(1)]; if (source) void request.respond({ status: 200, contentType: 'text/javascript', body: source }); else void request.continue(); });
    await mainPage.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await mainPage.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(mainPage, () => document.querySelector('aithema-session')?.session);
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 0, 'mail-reservation')) {
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
        await settleSettings(page); const after = await geometry(page);
        const shift = Math.max(...before.boxes.flatMap((box, i) => box.map((v, j) => Math.abs(v - after.boxes[i][j]))));
        if (shift !== 0) t.diagnostic(`Settings shift: ${JSON.stringify({ before: before.boxes, after: after.boxes,
          ...await shadow(page, c => ({ open: c.shadowRoot.querySelector('dialog.settings').open,
            scrollTop: c.shadowRoot.querySelector('.settings__body').scrollTop })) })}`);
        await record(page, label, state, after, shift);
        await t.test(`${label}/${state}: 0 px shift`, () => assert.equal(shift, 0));
        if (temporarilyOpen) {
          await click(page, 'dialog.settings .done');
          // Done may await a save acknowledgement. Finish this measurement's
          // cleanup before another state can reopen Settings underneath it.
          await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
        }
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
  assertMatrixCaseCount('mail-reservation', rows.length);
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
    await settleSettings(page);
  };
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    for (const theme of ['light', 'dark']) for (const width of matrixWidths([390, 1024, 1440], theme, 1, 'mail-latch')) {
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
            await settleSettings(page);
            const failedShift = shift(before, await geometry(page));
            rows.push({ head: evidenceCommit, label, scenario: 'failed-load', shiftPx: failedShift });
            t.diagnostic(`${failedShift === 0 ? 'PASS' : 'FAIL'} AIT-171 ${label}/failed-load: shift=${failedShift} px`);
            await t.test(`${label}/failed-load: 0 px shift`, () => assert.equal(failedShift, 0));
            await page.evaluate(() => { window.emailBoot.failCredits = false; });
            await refresh(page, false);
          } else await until(page, () => window.emailBoot.creditsCalls > 0);
        } else await refresh(page, !initialMail);
        await settleSettings(page);
        const after = await geometry(page), shiftPx = shift(before, after);
        const actionShiftPx = initialMail ? Math.max(...before.mailAction.map((v, i) => Math.abs(v - after.mailAction[i]))) : 0;
        const mode = await shadow(page, c => c.shadowRoot.querySelector('#email').dataset.emailMode);
        rows.push({ head: evidenceCommit, label, scenario, shiftPx, actionShiftPx, beforeHeight: before.stackHeight, afterHeight: after.stackHeight, mode });
        t.diagnostic(`${shiftPx === 0 && actionShiftPx === 0 && mode === initialMode ? 'PASS' : 'FAIL'} AIT-171 ${label}/${scenario}: shift=${shiftPx} px; action=${actionShiftPx} px; mode=${mode}; height=${before.stackHeight}/${after.stackHeight}`);
        await t.test(`${label}/${scenario}: latched mode and 0 px shift`, () => { assert.equal(mode, initialMode); assert.equal(shiftPx, 0); assert.equal(actionShiftPx, 0, 'mail action stays under the pointer'); });
        await t.test(`${label}/${scenario}: measure remains aria-hidden`, async () => assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.m-mail-tier-measure').getAttribute('aria-hidden')), 'true'));
        await click(page, 'dialog.settings .done');
        await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
        await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settleSettings(page);
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
  assertMatrixCaseCount('mail-latch', rows.length);
  if (evidence) await writeFile(join(evidence, 'ait-171-latch-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, rows, shots }, null, 2));
});


// Round 3: the status occupies the existing lead slot while real credits are pending.
test('AIT-171 status: loading to loaded/failed, mail/save, DE/EN, 390/1024/1440; 0 px shift', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-email-status-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const rows = [], shots = [];
  const capture = async (page, label, state) => {
    if (!evidence) return;
    const name = `ait-171-${evidenceCommit}-${label}-tiers-unknown-${state}.png`;
    await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name);
  };
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    for (const width of [390, 1024, 1440]) for (const delivery of [true, false]) for (const failed of [false, true]) {
      const label = `${locale}-light-${width}-${delivery ? 'mail' : 'save'}`;
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await fixture(page, locale, delivery, delivery, { hold: true, fail: failed });
      const leadSelector = delivery ? '.m-lead-mail' : '.m-lead-save';
      const loading = locale === 'de' ? 'Guthaben wird geladen …' : 'Loading credit …';
      const failure = (locale === 'de' ? 'Guthaben gerade nicht verfügbar.' : "Credit isn't available right now.") +
        (delivery ? locale === 'de' ? ' Sie können die Adresse trotzdem bestätigen.' : ' You can still confirm your address.' :
          locale === 'de' ? ' Sie können die Adresse trotzdem speichern.' : ' You can still save your address.');
      assert.equal(await shadow(page, (c, s) => c.shadowRoot.querySelector(s).textContent, leadSelector), loading);
      const before = await geometry(page);
      const leadBox = await shadow(page, (c, s) => { const b = c.shadowRoot.querySelector(s).getBoundingClientRect(); return [b.x, b.y]; }, leadSelector);
      if (!failed) await capture(page, label, 'loading');
      await page.evaluate(() => { window.emailBoot.holdCredits = false; });
      await until(page, ({ leadSelector, loading }) => document.querySelector('aithema-session').shadowRoot.querySelector(leadSelector).textContent !== loading, { leadSelector, loading });
      await settleSettings(page);
      const text = await shadow(page, (c, s) => c.shadowRoot.querySelector(s).textContent, leadSelector);
      if (failed) { assert.equal(text, failure); await capture(page, label, 'failed'); }
      else assert.match(text, locale === 'de' ? /Mit Ihrer E-Mail-Adresse/u : /With your email address/u);
      const after = await geometry(page);
      const shiftPx = Math.max(...before.boxes.flatMap((box, i) => box.map((v, j) => Math.abs(v - after.boxes[i][j]))),
        ...before.mailAction.map((v, i) => Math.abs(v - after.mailAction[i])));
      assert.deepEqual(await shadow(page, (c, s) => { const b = c.shadowRoot.querySelector(s).getBoundingClientRect(); return [b.x, b.y]; }, leadSelector), leadBox, 'lead stays in its first line slot');
      const state = failed ? 'failed' : 'loaded';
      rows.push({ head: evidenceCommit, label, state, shiftPx, text });
      t.diagnostic(`${shiftPx === 0 ? 'PASS' : 'FAIL'} AIT-171 ${label}/loading-to-${state}: shift=${shiftPx} px`);
      await t.test(`${label}/loading-to-${state}: 0 px shift`, () => assert.equal(shiftPx, 0));
      assert.equal(await page.evaluate(() => window.emailBoot.creditsRequests), 1, 'status adds no requests');
    }
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'ait-171-status-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, rows, shots }, null, 2));
});


test('AIT-172: Settings privacy DE/EN save/mail/confirmation-off, 390/1440, main geometry and mail pixels', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-email-privacy-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  const baseline = JSON.parse(await readFile(new URL('../fixtures/email-privacy-baseline.json', import.meta.url), 'utf8'));
  const rows = [], shots = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) {
    browser = await browserForFile();
    const page = await browser.newPage(), main = await browser.newPage();
    await main.setRequestInterception(true);
    main.on('request', request => { const source = baseline.modules[new URL(request.url()).pathname.slice(1)]; if (source) void request.respond({ status: 200, contentType: 'text/javascript', body: source }); else void request.continue(); });
    for (const p of [page, main]) {
      await p.bringToFront();
      await p.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
      await p.goto(server.url, { waitUntil: 'domcontentloaded' }); await until(p, () => document.querySelector('aithema-session')?.session);
    }
    for (const width of [390, 1440]) for (const [mode, delivery, confirm] of [['save', false, false], ['confirmation-off', true, false], ['mail', true, true]]) {
      const label = `${locale}-light-${width}-${mode}`;
      for (const p of [page, main]) {
        await p.bringToFront();
        await p.setViewport({ width, height: width === 390 ? 844 : 1000 }); await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
        await fixture(p, locale, delivery, confirm);
        await shadow(p, c => c.shadowRoot.querySelector('#email-heading').focus({ preventScroll: true })); await frame(p);
      }
      const expected = locale === 'de' ? mode === 'mail' ? 'Ihre E-Mail-Adresse wird nur für Ihr Guthaben und die Bestätigungsmail verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.' : 'Ihre E-Mail-Adresse wird nur für Ihr Guthaben verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.' : mode === 'mail' ? 'We use your email address only for your credit and the confirmation email. Never for advertising. After 90 days without use, we delete it automatically.' : 'We use your email address only for your credit. Never for advertising. After 90 days without use, we delete it automatically.';
      const selectors = ['#email', '.m-stack', mode === 'mail' ? '.m-mail-notice' : '#email-notice', mode === 'mail' ? '.verify-entry' : '.m-save', '.operator-section', '.settings__footer'];
      const metrics = p => shadow(p, (c, selectors) => selectors.map(s => { const b = c.shadowRoot.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }), selectors);
      let passed = false;
      await t.test(label, async () => {
        assert.equal(await shadow(page, (c, s) => c.shadowRoot.querySelector(s + ' .m-notice-text').textContent, selectors[2]), expected);
        assert.deepEqual(await metrics(page), await metrics(main), '0 px shift against main');
        if (mode === 'mail') {
          const clip = await shadow(page, c => { const b = c.shadowRoot.querySelector('#email').getBoundingClientRect(), body = c.shadowRoot.querySelector('.settings__body').getBoundingClientRect(); const y = Math.max(b.y, body.y); return { x: b.x, y, width: b.width, height: Math.min(b.bottom, body.bottom) - y }; });
          await frame(page); const actual = await page.screenshot({ clip });
          await frame(main); assert.ok(actual.equals(await main.screenshot({ clip })), 'mail section pixel-identical to main');
        }
        passed = true;
      });
      if (!passed) continue;
      rows.push({ head: evidenceCommit, label, surface: 'settings', shiftPx: 0, mailPixelIdentical: mode === 'mail', text: expected });
      t.diagnostic(`PASS AIT-172 ${label}/settings: 0 px shift${mode === 'mail' ? '; mail pixels identical to main' : ''}`);
      if (evidence) { const name = `ait-172-${evidenceCommit}-${label}-settings.png`; await frame(page); await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name); }
    }
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'ait-172-settings-pass-lines.json'), JSON.stringify({ head: evidenceCommit, viewport: true, baseline: baseline.sourceHead, rows, shots }, null, 2));
});

// Real host routes, including the unavailable visitor-email route; no provider or mail calls.
test('AIT-414: credit tiers with identity only confirm and change without visitor persistence', { timeout: 30_000 }, async t => {
  const { confirmationHost } = await import('../fixtures/confirmation-host.js');
  const f = await confirmationHost(t), dir = await mkdtemp(join(tmpdir(), 'aithema-confirm-identity-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'));
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.exposeFunction('confirmationRequest', f.call);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ identity, tiers }) => {
    const { Verification } = await import('/packages/ui/src/verification.js');
    const { en: copy } = await import('/packages/ui/src/i18n/en.js');
    const host = document.createElement('div'); document.body.replaceChildren(host);
    const root = host.attachShadow({ mode: 'open' }), entry = document.createElement('section'), lock = document.createElement('section'), dialog = document.createElement('dialog');
    root.append(entry, lock, dialog);
    const v = window.confirmation = new Verification({ root, entry, lock, dialog, copy, request: window.confirmationRequest, identity, demo: true });
    await v.load(); v.setCredits({ tiers });
  }, { identity: f.session.identity, tiers: f.tiers() });
  for (const [command, address] of [['request', 'first@example.test'], ['change', 'changed@example.test']]) {
    await page.evaluate(({ command, address }) => {
      const root = document.body.firstElementChild.shadowRoot;
      if (command === 'change') root.querySelector('.verify-change').click();
      root.querySelector('#verify-lock-email').value = address;
      root.querySelector('#verify-lock-email').form.requestSubmit();
    }, { command, address });
    await page.waitForFunction(() => window.confirmation.identity.status === 'verification-pending');
    assert.deepEqual(f.calls.filter(call => call.path === `identity/${command}`), [{ path: `identity/${command}`, body: { address } }]);
    assert.equal(f.deliveries.at(-1).address, address);
    const confirmed = await f.call('identity/confirm', { token: 'fixture-confirmation' });
    assert.equal(confirmed.ok, true);
    await page.evaluate(identity => window.confirmation.set(identity), confirmed.body.identity);
    assert.equal(await page.evaluate(() => window.confirmation.identity.status), 'verified');
    assert.equal(f.tiers().allowancesMicro[f.tiers().current], 1_000_000_000);
  }
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email' && call.body).length, 0);
  await page.evaluate(() => window.confirmation.destroy());
});

test('AIT-418 O9: address change waits in place during reply; race keeps failed reply and retry', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-identity-stream-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), checks = [], errors = [];
  t.after(async () => { await browser.close(); await server.kill(); await rm(dir, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 390, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session);
  const settle = () => shadow(page, async c => {
    await document.fonts.ready;
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const measure = () => shadow(page, c => ['dialog.verify-dialog', '.verify-dialog .verify__input', '.verify-dialog .verify-send', '.verify-dialog .verify__message'].map(s => {
    const b = c.shadowRoot.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
  }));
  const shot = async name => {
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle();
    if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false });
  };
  for (const locale of ['de', 'en']) {
    await fixture(page, locale, true, true, { replyAvailable: true });
    await shadow(page, c => {
      c.setAttribute('theme', 'light'); c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      window.emailBoot.address = 'before@example.test'; window.emailBoot.status = 'verified';
      c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity, identified: true, status: 'verified', address: 'before@example.test' } });
    });
    await click(page, '.m-change-mail');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.verify-dialog').open);
    await settle(); const baseline = await measure();
    await shadow(page, async c => {
      const { inputRevision } = await import('/packages/core/src/session.js');
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'o9-user', role: 'user', content: c.session.locale === 'de' ? 'Welche Möglichkeiten gibt es?' : 'What are the options?' } });
      c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: ['reaction'], failures: [], lastFailure: null } });
      c.receive({ type: 'turn.partial', data: { id: 'o9-reply', inputRevision: inputRevision(c.session), delta: c.session.locale === 'de' ? 'Wir sehen uns die Möglichkeiten an.' : 'Let us look at the options.' } });
      const input = c.shadowRoot.querySelector('.verify-dialog input'); input.value = 'after@example.test';
    });
    await settle(); assert.deepEqual(await measure(), baseline, `${locale}: 0 px streaming shift`);
    const state = await shadow(page, c => {
      const form = c.shadowRoot.querySelector('.verify-dialog .verify-form');
      const result = { disabled: form.querySelector('.verify-send').getAttribute('aria-disabled'), editable: !form.querySelector('input').disabled && !form.querySelector('input').readOnly,
        reason: form.querySelector('.verify__message').textContent, links: window.emailBoot.linkRequests };
      form.requestSubmit(); return result;
    });
    assert.equal(state.disabled, 'true'); assert.equal(state.editable, true);
    assert.equal(state.reason, locale === 'de' ? 'Möglich, sobald die Antwort fertig ist.' : 'Available once the reply has finished.');
    await shot(`ait418-390-light-${locale}-streaming-disabled.png`);
    assert.equal(await page.evaluate(() => window.emailBoot.linkRequests), state.links);
    await shadow(page, async c => {
      const { inputRevision } = await import('/packages/core/src/session.js');
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'o9-reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
      c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
    });
    await settle(); assert.deepEqual(await measure(), baseline, `${locale}: 0 px re-enable shift`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.verify-dialog .verify-send').getAttribute('aria-disabled')), 'false');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.verify-dialog input').value), 'after@example.test');
    if (locale === 'de') {
      await click(page, '.verify-dialog-close');
      await shadow(page, async c => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'o9-race-user', role: 'user', content: 'Bitte weiter.' } });
        c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity, identified: false, status: 'verification-pending', address: 'race@example.test' } });
        const failure = { inputRevision: inputRevision(c.session), lane: 'reaction', error: 'reasoning-unavailable', reason: 'identity-changed', retryable: true };
        c.receive({ type: 'lane.failed', data: failure });
        c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [failure], lastFailure: failure } });
        c.shadowRoot.querySelector('.reaction-failure').scrollIntoView({ block: 'center' });
      });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.reaction-failure').hidden), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.retry').hidden), false);
      await shot('ait418-390-light-de-race-reply-failed.png');
    }
    checks.push({ locale, width: 390, theme: 'light', shiftPx: 0, ...state });
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait418-checks.json'), JSON.stringify({ head: evidenceCommit, checks, errors }, null, 2));
});
