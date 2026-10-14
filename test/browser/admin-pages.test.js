import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { listen } from '../../packages/server/src/http.js';
import { adminFixture } from '../fixtures/admin-host.js';
import { adminSteps } from './admin-steps.js';
import { browserPath, evidenceCommit } from './start2-display-helpers.js';

const states = ['overview', 'editing', 'saved', 'conflict', 'invalid', 'confirmation-off', 'no-delivery', 'cap-near', 'latched', 'audit-end', 'audit-empty', 'signed-out', 'expired'];
const widths = [390, 1024, 1440];
// CI already sets an evidence directory for artifacts. Reserve the complete
// screenshot matrix for deliberate evidence runs outside CI; otherwise every
// state still runs in both locales/themes, with widths rotated across states.
const fullMatrix = Boolean(process.env.AITHEMA_EVIDENCE_DIR) && !process.env.CI;
const geometry = page => page.evaluate(() => {
  const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y + scrollY, b.width, b.height]; };
  return [...document.querySelectorAll('.ad-sec:not([data-sec=log]),#h-log,.ad-save,.ad-btn,.ad-discard,.ad-status,.ad-tier,.ad-sub')].map(box);
});
const edit = (page, value) => page.$eval('#f-emailGiven', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);

const click = (page, run, selector) => run(`click ${selector}`, () => page.locator(selector).setTimeout(4_000).click());

async function closeBrowser(browser, run) {
  if (!browser) return;
  try {
    await run('browser.close', () => browser.close(), { timeout: 3_000, cleanup: true });
  } catch (error) {
    // A wedged protocol must not keep Chrome or the test worker alive.
    const child = browser.process();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await run('browser process exit', () => exited, { timeout: 2_000, cleanup: true });
    }
    throw error;
  }
}

test('AIT-169 admin: 13 page states plus AIT-165 entry evidence; exact 0 px flow, precision, DE/EN light/dark with rotating widths (full evidence matrix)', { timeout: fullMatrix ? 120_000 : 60_000 }, async t => {
  const { at, run } = adminSteps(t.signal);
  const dir = await run('mkdtemp', () => mkdtemp(join(tmpdir(), 'aithema-admin-browser-')));
  let f, held, responseMode = 'ok', browser;
  const server = await run('listen', () => listen(async request => {
    const path = new URL(request.url).pathname;
    if (/^\/(demo\/(host\.css|theme-init\.js|admin-page\.js|admin-view\.js|page-preferences\.js)|packages\/ui\/src\/(i18n\/(de|en|admin)\.js|display\.js|icons\.js)|packages\/core\/src\/ai-notice\.js)$/u.test(path)) {
      return new Response(await run('readFile', () => readFile(new URL('../../' + path.slice(1), import.meta.url))), { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    }
    if (request.method === 'POST' && path.endsWith('/settings')) {
      if (held) { const gate = held; held = null; gate.arrived(); await run('held settings POST release', () => gate.pending); }
      if (responseMode === '401') return new Response('{}', { status: 401 });
      if (responseMode === 'error') return new Response('{}', { status: 503 });
      if (responseMode === 'conflict') f.host.visitorCredits.saveSettings({ baseRevision: f.host.visitorCredits.settings().revision, confirmationEnabled: true }, { source: 'ops-cli', actor: 'ops-cli:concurrent' });
    }
    return await run('f.admin.handle', () => f.admin.handle(request)) ?? new Response(null, { status: 404 });
  }));
  let releaseHeld = () => {};
  t.after(async () => {
    releaseHeld(); held = null;
    const results = await Promise.allSettled([
      closeBrowser(browser, run),
      run('server.close', () => new Promise((resolve, reject) => {
        server.server.close(error => error ? reject(error) : resolve());
        server.server.closeAllConnections();
      }), { cleanup: true }),
    ]);
    f?.close();
    await run('remove fixture directory', () => rm(dir, { recursive: true, force: true }), { cleanup: true });
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'admin cleanup failed');
  });
  f = await run('adminFixture', () => adminFixture({ origin: server.url }));
  const seed = () => {
    f.setTime(Date.parse('2026-10-14T20:00:00Z'));
    f.storage.db.prepare('DELETE FROM operator_grants').run();
    f.store.issue('g'.repeat(43), f.provider.sessionNamespace, { name: 'Ada', subject: 'verified-subject' }, f.now() + 8 * 60 * 60_000);
    f.storage.db.prepare('UPDATE visitor_credit_settings SET anonymous_micro=10123456,email_given_micro=15654321,email_confirmed_micro=24999999,confirmation_enabled=1,mail_cap_hour=30,mail_cap_day=200,mail_ip_cap_hour=5,mail_ip_cap_day=20 WHERE id=1').run();
    f.storage.db.prepare('DELETE FROM visitor_credit_audit').run();
    for (let i = 0; i < 21; i++) f.host.visitorCredits.auditMailCap({ window: i % 2 ? 'day' : 'hour', count: i + 1 });
    f.storage.db.prepare('DELETE FROM host_mail_slots').run(); f.storage.db.prepare('DELETE FROM host_mail_ip_slots').run();
    f.storage.db.prepare('DELETE FROM spend_reservations').run();
    f.storage.db.prepare('INSERT INTO host_mail_slots VALUES (?,?)').run(f.now() - 1000, 12);
    f.storage.db.prepare('INSERT INTO host_mail_slots VALUES (?,?)').run(f.now() - 4_000_000, 36);
    f.storage.db.prepare('INSERT INTO host_mail_ip_slots VALUES (?,?,?)').run('stub-private-bucket', f.now() - 1000, 2);
  };
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, shots = [], pass = [], errors = [], external = [];
  if (evidence) await run('mkdir', () => mkdir(evidence, { recursive: true }));
  for (const locale of ['de', 'en']) {
    at('launch', { locale, theme: 'light', width: 390 });
    const executablePath = await run('browserPath', () => browserPath());
    browser = await run('puppeteer.launch', () => puppeteer.launch({ executablePath, headless: true, timeout: 8_000, protocolTimeout: 5_000, userDataDir: join(dir, locale),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] }), { timeout: 10_000 });
    const page = await run('browser.newPage', () => browser.newPage()); page.setDefaultTimeout(5_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => {
      void run('dialog.accept', () => dialog.accept()).catch(error => errors.push(error.message));
    });
    page.on('request', r => { if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) external.push(r.url()); });
    await run('page.evaluateOnNewDocument', () => page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale));
    const open = async () => {
      await run('page.goto', () => page.goto(server.url + '/admin?lang=' + locale, { waitUntil: 'domcontentloaded' }));
      // Await the document's module, including its initial state/audit reads and
      // event wiring, rather than paying the network-idle delay on every state.
      await run('page.evaluate', () => page.evaluate(() => import('/demo/admin-page.js')));
      await run('page.waitForSelector', () => page.waitForSelector('.ad-page')); await run('page.evaluate', () => page.evaluate(() => document.fonts.ready));
    };
    const shot = async (state, width, theme, part = '') => {
      if (!evidence) return;
      const name = `ait-169-${evidenceCommit}-${locale}-${theme}-${width}-${state}${part}.png`;
      await run(`page.screenshot ${state}${part}`, () => page.screenshot({ path: join(evidence, name), fullPage: false })); shots.push(name);
    };
    for (const [widthIndex, width] of widths.entries()) for (const theme of ['light', 'dark']) {
      at('viewport', { locale, theme, width });
      await run('page.setViewport', () => page.setViewport({ width, height: width === 390 ? 844 : 900 })); await run('page.emulateMediaFeatures', () => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]));
      for (const [stateIndex, state] of states.entries()) {
        if (!fullMatrix && stateIndex % widths.length !== widthIndex) continue;
        at(state, { locale, theme, width });
        seed(); responseMode = 'ok';
        await run('page.setCookie', () => page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url }));
        if (state === 'signed-out') await run('page.deleteCookie', () => page.deleteCookie({ name: 'aithema-operator', url: server.url }));
        if (state === 'expired') f.advance(8 * 60 * 60_000);
        if (state === 'confirmation-off') f.storage.db.prepare('UPDATE visitor_credit_settings SET confirmation_enabled=0 WHERE id=1').run();
        if (state === 'no-delivery') f.host.identity.deliversVerification = false;
        if (state === 'cap-near') {
          f.storage.db.prepare('UPDATE host_mail_slots SET count=27 WHERE created_at=?').run(f.now() - 1000);
          f.storage.db.prepare('UPDATE host_mail_ip_slots SET count=4').run();
          f.storage.db.prepare('INSERT INTO host_mail_ip_slots VALUES (?,?,?)').run('stub-private-bucket', f.now() - 4_000_000, 14);
        }
        if (state === 'latched') f.spendCap.settle(f.spendCap.reserve(100_000), 110_000);
        if (state === 'audit-empty') f.storage.db.prepare('DELETE FROM visitor_credit_audit').run();
        await open();
        if (['editing', 'saved', 'conflict', 'invalid'].includes(state)) {
          await run('edit', () => edit(page, state === 'invalid' ? '800' : '1800'));
          assert.equal(await run('page.$eval', () => page.$eval('[data-sec=credits]', n => n.dataset.mode)), state === 'invalid' ? 'invalid' : 'dirty');
        }
        if (state === 'saved' || state === 'conflict') {
          responseMode = state === 'conflict' ? 'conflict' : 'ok';
          await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector(`[data-sec=credits][data-mode=${state}]`));
          if (state === 'saved') assert.deepEqual(f.host.visitorCredits.settings().allowancesMicro, { anonymous: 10_123_456, emailGiven: 18_000_000, emailConfirmed: 24_999_999 }, 'untouched fields retain six decimal USD precision');
        }
        if (state === 'audit-end') { await click(page, run, '.ad-more'); await run('page.waitForSelector', () => page.waitForSelector('.ad-end')); assert.equal(await run('page.$$eval', () => page.$$eval('.ad-log li', ns => ns.length)), 21); }
        assert.equal(await run('page.evaluate', () => page.evaluate(() => document.documentElement.scrollWidth)), width);
        assert.equal(await run('page.$$eval', () => page.$$eval('[style],style,script:not([src])', ns => ns.length)), 0);
        assert.equal(await run('page.$$eval', () => page.$$eval('.voice-rail', ns => ns.length)), 0);
        if (!['signed-out', 'expired'].includes(state)) {
          assert.equal(await run('page.$eval', () => page.$eval('.ad-btn', n => getComputedStyle(n).color)), 'rgb(255, 255, 255)');
          assert.equal(await run('page.$eval', () => page.$eval('#f-emailGiven', n => getComputedStyle(n).fontSize)), '15px');
          assert.ok(await run('page.$eval', () => page.$eval('.ad-btn', n => n.getBoundingClientRect().height >= 44)));
        }
        if (state === 'no-delivery') assert.equal(await run('page.$eval', () => page.$eval('#f-confirm', n => n.disabled)), true);
        if (state === 'latched') { const text = await run('page.$eval', () => page.$eval('[data-sec=prov]', n => n.textContent)); assert.ok(text.includes(locale === 'de' ? 'Gesperrt · Grund:' : 'Locked · Reason:')); assert.ok(text.includes(locale === 'de' ? 'keine neuen Anfragen' : 'no new requests')); }
        if (state === 'signed-out' || state === 'expired') { assert.equal(await run('page.$$eval', () => page.$$eval('.ad-sec', ns => ns.length)), 0); assert.equal(await run('page.$eval', () => page.$eval('.ad-login', n => n.getAttribute('href'))), '/api/operator/login/?return=admin'); }
        await shot(state, width, theme);
        if (evidence && !['signed-out', 'expired'].includes(state)) {
          for (const [part, selector] of [['-mail', '#h-mail'], ['-spending-audit', '#h-prov']]) {
            await run('page.$eval', () => page.$eval(selector, n => n.scrollIntoView())); await shot(state, width, theme, part);
          }
        }
        f.host.identity.deliversVerification = true;
        pass.push(`PASS head=${evidenceCommit} AIT-169 ${locale}-${theme}-${width}/${state}`);
      }
      at('flow-open', { locale, theme, width });
      seed(); responseMode = 'ok'; await run('page.setCookie', () => page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url })); await open();
      const before = await run('geometry', () => geometry(page));
      at('flow-edit');
      await run('edit', () => edit(page, '1800')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'edit: 0 px');
      let arrived, release; const arrival = new Promise(r => { arrived = r; }); held = { arrived, pending: new Promise(r => { release = r; }) };
      releaseHeld = release;
      at('flow-saving');
      // A selector click can return without dispatching a POST when the control
      // is not actionable yet. Locator clicks await enabled, visible and stable
      // controls; POST arrival still has its own deadline and finally-release.
      try {
        await click(page, run, '[data-save=credits]');
        await run('settings POST arrival', () => arrival);
        assert.deepEqual(await run('geometry', () => geometry(page)), before, 'saving: 0 px');
      } finally { release(); held = null; releaseHeld = () => {}; }
      at('flow-saved');
      await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=saved]')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'saved: 0 px');
      at('flow-conflict');
      await run('edit', () => edit(page, '1900')); responseMode = 'conflict'; await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=conflict]')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'conflict: 0 px');
      at('flow-reload');
      responseMode = 'ok'; await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=clean]')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'reload: 0 px');
      at('flow-invalid');
      await run('edit', () => edit(page, '800')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'invalid: 0 px');
      at('flow-failed');
      await click(page, run, '[data-discard=credits]'); await run('edit', () => edit(page, '1900')); responseMode = 'error'; await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=failed]')); assert.deepEqual(await run('geometry', () => geometry(page)), before, 'failed: 0 px');
      at('flow-retry');
      responseMode = 'ok'; await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=saved]'));
      at('flow-expired');
      await run('edit', () => edit(page, '2000')); responseMode = '401'; await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('.ad-out')); assert.equal(await run('page.$$eval', () => page.$$eval('.ad-sec', ns => ns.length)), 0);
      pass.push(`PASS head=${evidenceCommit} AIT-169 ${locale}-${theme}-${width} edit → saving → saved → conflict → reload → invalid → failed: 0.00 px shift; retry; 401 expires page`);
    }
    at('close');
    try { await closeBrowser(browser, run); } finally { browser = null; }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(pass.length, states.length * 4 * (fullMatrix ? widths.length : 1) + 12, 'all DE/EN light/dark states and all 12 width/theme/locale flows');
  if (evidence) assert.equal(shots.length, (states.length * 3 - 4) * 4 * (fullMatrix ? widths.length : 1));
  if (evidence) { await run('writeFile', () => writeFile(join(evidence, 'ait-169-admin-pass-lines.txt'), pass.join('\n') + '\n')); await run('writeFile', () => writeFile(join(evidence, 'ait-169-admin-evidence.json'), JSON.stringify({ head: evidenceCommit, shots, pass }, null, 2) + '\n')); }
  pass.forEach(line => t.diagnostic(line));
});

test('AIT-169 independent edits survive a save in another section, then each section can save with the new revision', { timeout: 15_000 }, async t => {
  const { at, run } = adminSteps(t.signal);
  const dir = await run('mkdtemp', () => mkdtemp(join(tmpdir(), 'aithema-admin-edits-')));
  let f, browser;
  const server = await run('listen', () => listen(async request => {
    const path = new URL(request.url).pathname;
    if (/^\/(demo\/(host\.css|theme-init\.js|admin-page\.js|admin-view\.js|page-preferences\.js)|packages\/ui\/src\/(i18n\/(de|en|admin)\.js|display\.js|icons\.js)|packages\/core\/src\/ai-notice\.js)$/u.test(path)) {
      return new Response(await run('readFile', () => readFile(new URL('../../' + path.slice(1), import.meta.url))), { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    }
    return await run('f.admin.handle', () => f.admin.handle(request)) ?? new Response(null, { status: 404 });
  }));
  t.after(async () => {
    try { await closeBrowser(browser, run); }
    finally {
      try {
        await run('server.close', () => new Promise((resolve, reject) => {
          server.server.close(error => error ? reject(error) : resolve());
          server.server.closeAllConnections();
        }), { cleanup: true });
      } finally {
        f?.close();
        await run('remove fixture directory', () => rm(dir, { recursive: true, force: true }), { cleanup: true });
      }
    }
  });
  f = await run('adminFixture', () => adminFixture({ origin: server.url }));
  f.host.visitorCredits.saveSettings({ baseRevision: 1, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '24' } }, { source: 'ops-cli', actor: 'ops-cli:fixture' });
  const executablePath = await run('browserPath', () => browserPath());
  browser = await run('puppeteer.launch', () => puppeteer.launch({ executablePath, headless: true, timeout: 8_000, protocolTimeout: 5_000, userDataDir: join(dir, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] }), { timeout: 10_000 });
  at('independent-edits', { locale: 'de', theme: 'light', width: 800 });
  const page = await run('browser.newPage', () => browser.newPage()), errors = []; page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  await run('page.setCookie', () => page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url }));
  await run('page.goto', () => page.goto(server.url + '/admin', { waitUntil: 'domcontentloaded' }));
  await run('page.evaluate', () => page.evaluate(() => import('/demo/admin-page.js')));
  await run('page.evaluate', () => page.evaluate(() => document.fonts.ready));
  const before = await run('geometry', () => geometry(page));
  await run('edit', () => edit(page, '1800'));
  await run('page.$eval', () => page.$eval('#f-confirm', i => { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }));
  await click(page, run, '[data-save=confirm]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=confirm][data-mode=saved]'));
  assert.equal(await run('page.$eval', () => page.$eval('#f-emailGiven', i => i.value.replace(/[.,\s]/gu, ''))), '1800', 'other edit is preserved');
  assert.equal(f.host.visitorCredits.settings().allowancesMicro.emailGiven, 15_000_000);
  assert.deepEqual(await run('geometry', () => geometry(page)), before, 'confirmation reachability: 0 px');
  await run('page.$eval', () => page.$eval('#f-mail-hour', i => { i.value = '40'; i.dispatchEvent(new Event('input', { bubbles: true })); }));
  await click(page, run, '[data-save=credits]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=credits][data-mode=saved]'));
  assert.equal(await run('page.$eval', () => page.$eval('#f-mail-hour', i => i.value)), '40');
  await click(page, run, '[data-save=mail]'); await run('page.waitForSelector', () => page.waitForSelector('[data-sec=mail][data-mode=saved]'));
  const saved = f.host.visitorCredits.settings();
  assert.equal(saved.allowancesMicro.emailGiven, 18_000_000); assert.equal(saved.mailCap.hour, 40); assert.equal(saved.confirmationEnabled, true);
  assert.deepEqual(await run('geometry', () => geometry(page)), before, 'three section saves: 0 px'); assert.deepEqual(errors, []);
});
