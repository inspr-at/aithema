import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { listen } from '../../packages/server/src/http.js';
import { adminFixture } from '../fixtures/admin-host.js';
import { browserPath, evidenceCommit } from './start2-display-helpers.js';

const states = ['overview', 'editing', 'saved', 'conflict', 'invalid', 'confirmation-off', 'no-delivery', 'cap-near', 'latched', 'audit-end', 'audit-empty', 'signed-out', 'expired'];
const geometry = page => page.evaluate(() => {
  const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y + scrollY, b.width, b.height]; };
  return [...document.querySelectorAll('.ad-sec:not([data-sec=log]),#h-log,.ad-save,.ad-btn,.ad-discard,.ad-status,.ad-tier,.ad-sub')].map(box);
});
const edit = (page, value) => page.$eval('#f-emailGiven', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);

test('AIT-169 admin: 13 page states plus AIT-165 entry evidence; exact 0 px flow, precision, DE/EN light/dark 390/1024/1440', { timeout: 180_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-admin-browser-'));
  let f, held, responseMode = 'ok', browser;
  const server = await listen(async request => {
    const path = new URL(request.url).pathname;
    if (/^\/(demo\/(host\.css|theme-init\.js|admin-page\.js|admin-view\.js|page-preferences\.js)|packages\/ui\/src\/(i18n\/(de|en|admin)\.js|display\.js|icons\.js)|packages\/core\/src\/ai-notice\.js)$/u.test(path)) {
      return new Response(await readFile(new URL('../../' + path.slice(1), import.meta.url)), { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    }
    if (request.method === 'POST' && path.endsWith('/settings')) {
      if (held) { const gate = held; held = null; gate.arrived(); await gate.pending; }
      if (responseMode === '401') return new Response('{}', { status: 401 });
      if (responseMode === 'error') return new Response('{}', { status: 503 });
      if (responseMode === 'conflict') f.host.visitorCredits.saveSettings({ baseRevision: f.host.visitorCredits.settings().revision, confirmationEnabled: true }, { source: 'ops-cli', actor: 'ops-cli:concurrent' });
    }
    return await f.admin.handle(request) ?? new Response(null, { status: 404 });
  });
  try { f = await adminFixture({ origin: server.url }); }
  catch (error) { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); await rm(dir, { recursive: true, force: true }); throw error; }
  t.after(async () => { await browser?.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); f.close(); await rm(dir, { recursive: true, force: true }); });
  const seed = () => {
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
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) {
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(dir, locale),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => void dialog.accept());
    page.on('request', r => { if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) external.push(r.url()); });
    await page.evaluateOnNewDocument(locale => localStorage.setItem('aithema-demo-locale', locale), locale);
    const open = async () => {
      await page.goto(server.url + '/admin?lang=' + locale, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.ad-page'); await page.evaluate(() => document.fonts.ready);
    };
    const shot = async (state, width, theme, part = '') => {
      const name = `ait-169-${evidenceCommit}-${locale}-${theme}-${width}-${state}${part}.png`; shots.push(name);
      if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: false });
    };
    for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      for (const state of states) {
        seed(); responseMode = 'ok';
        await page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url });
        if (state === 'signed-out') await page.deleteCookie({ name: 'aithema-operator', url: server.url });
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
        if (['editing', 'saved', 'conflict', 'invalid'].includes(state)) await edit(page, state === 'invalid' ? '800' : '1800');
        if (state === 'saved' || state === 'conflict') {
          responseMode = state === 'conflict' ? 'conflict' : 'ok';
          await page.click('[data-save=credits]'); await page.waitForSelector(`[data-sec=credits][data-mode=${state}]`);
          if (state === 'saved') assert.deepEqual(f.host.visitorCredits.settings().allowancesMicro, { anonymous: 10_123_456, emailGiven: 18_000_000, emailConfirmed: 24_999_999 }, 'untouched fields retain six decimal USD precision');
        }
        if (state === 'audit-end') { await page.click('.ad-more'); await page.waitForSelector('.ad-end'); assert.equal(await page.$$eval('.ad-log li', ns => ns.length), 21); }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.$$eval('[style],style,script:not([src])', ns => ns.length), 0);
        assert.equal(await page.$$eval('.voice-rail', ns => ns.length), 0);
        if (state === 'no-delivery') assert.equal(await page.$eval('#f-confirm', n => n.disabled), true);
        if (state === 'latched') { const text = await page.$eval('[data-sec=prov]', n => n.textContent); assert.ok(text.includes(locale === 'de' ? 'Gesperrt · Grund:' : 'Locked · Reason:')); assert.ok(text.includes(locale === 'de' ? 'keine neuen Anfragen' : 'no new requests')); }
        if (state === 'signed-out' || state === 'expired') { assert.equal(await page.$$eval('.ad-sec', ns => ns.length), 0); assert.equal(await page.$eval('.ad-login', n => n.getAttribute('href')), '/api/operator/login/?return=admin'); }
        await shot(state, width, theme);
        if (!['signed-out', 'expired'].includes(state)) {
          for (const [part, selector] of [['-mail', '#h-mail'], ['-spending-audit', '#h-prov']]) {
            await page.$eval(selector, n => n.scrollIntoView()); await shot(state, width, theme, part);
          }
        }
        f.host.identity.deliversVerification = true;
        pass.push(`PASS head=${evidenceCommit} AIT-169 ${locale}-${theme}-${width}/${state}`);
      }
      seed(); responseMode = 'ok'; await page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url }); await open();
      const before = await geometry(page);
      await edit(page, '1800'); assert.deepEqual(await geometry(page), before, 'edit: 0 px');
      let arrived, release; const arrival = new Promise(r => { arrived = r; }); held = { arrived, pending: new Promise(r => { release = r; }) };
      await page.click('[data-save=credits]'); await arrival; assert.deepEqual(await geometry(page), before, 'saving: 0 px');
      release(); await page.waitForSelector('[data-sec=credits][data-mode=saved]'); assert.deepEqual(await geometry(page), before, 'saved: 0 px');
      await edit(page, '1900'); responseMode = 'conflict'; await page.click('[data-save=credits]'); await page.waitForSelector('[data-sec=credits][data-mode=conflict]'); assert.deepEqual(await geometry(page), before, 'conflict: 0 px');
      responseMode = 'ok'; await page.click('[data-save=credits]'); await page.waitForSelector('[data-sec=credits][data-mode=clean]'); assert.deepEqual(await geometry(page), before, 'reload: 0 px');
      await edit(page, '800'); assert.deepEqual(await geometry(page), before, 'invalid: 0 px');
      await page.click('[data-discard=credits]'); await edit(page, '1900'); responseMode = 'error'; await page.click('[data-save=credits]'); await page.waitForSelector('[data-sec=credits][data-mode=failed]'); assert.deepEqual(await geometry(page), before, 'failed: 0 px');
      responseMode = 'ok'; await page.click('[data-save=credits]'); await page.waitForSelector('[data-sec=credits][data-mode=saved]');
      await edit(page, '2000'); responseMode = '401'; await page.click('[data-save=credits]'); await page.waitForSelector('.ad-out'); assert.equal(await page.$$eval('.ad-sec', ns => ns.length), 0);
      pass.push(`PASS head=${evidenceCommit} AIT-169 ${locale}-${theme}-${width} edit → saving → saved → conflict → reload → invalid → failed: 0.00 px shift; retry; 401 expires page`);
    }
    await browser.close(); browser = null;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  if (evidence) { await writeFile(join(evidence, 'ait-169-admin-pass-lines.txt'), pass.join('\n') + '\n'); await writeFile(join(evidence, 'ait-169-admin-evidence.json'), JSON.stringify({ head: evidenceCommit, shots, pass }, null, 2) + '\n'); }
  pass.forEach(line => t.diagnostic(line));
});

test('AIT-169 independent edits survive a save in another section, then each section can save with the new revision', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-admin-edits-'));
  let f, browser;
  const server = await listen(async request => {
    const path = new URL(request.url).pathname;
    if (/^\/(demo\/(host\.css|theme-init\.js|admin-page\.js|admin-view\.js|page-preferences\.js)|packages\/ui\/src\/(i18n\/(de|en|admin)\.js|display\.js|icons\.js)|packages\/core\/src\/ai-notice\.js)$/u.test(path)) {
      return new Response(await readFile(new URL('../../' + path.slice(1), import.meta.url)), { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    }
    return await f.admin.handle(request) ?? new Response(null, { status: 404 });
  });
  t.after(async () => { await browser?.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); f?.close(); await rm(dir, { recursive: true, force: true }); });
  f = await adminFixture({ origin: server.url });
  f.host.visitorCredits.saveSettings({ baseRevision: 1, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '24' } }, { source: 'ops-cli', actor: 'ops-cli:fixture' });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(dir, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), errors = []; page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  await page.setCookie({ name: 'aithema-operator', value: 'g'.repeat(43), url: server.url });
  await page.goto(server.url + '/admin', { waitUntil: 'networkidle0' });
  const before = await geometry(page);
  await edit(page, '1800');
  await page.$eval('#f-confirm', i => { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('[data-save=confirm]'); await page.waitForSelector('[data-sec=confirm][data-mode=saved]');
  assert.equal(await page.$eval('#f-emailGiven', i => i.value.replace(/[.,\s]/gu, '')), '1800', 'other edit is preserved');
  assert.equal(f.host.visitorCredits.settings().allowancesMicro.emailGiven, 15_000_000);
  assert.deepEqual(await geometry(page), before, 'confirmation reachability: 0 px');
  await page.$eval('#f-mail-hour', i => { i.value = '40'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('[data-save=credits]'); await page.waitForSelector('[data-sec=credits][data-mode=saved]');
  assert.equal(await page.$eval('#f-mail-hour', i => i.value), '40');
  await page.click('[data-save=mail]'); await page.waitForSelector('[data-sec=mail][data-mode=saved]');
  const saved = f.host.visitorCredits.settings();
  assert.equal(saved.allowancesMicro.emailGiven, 18_000_000); assert.equal(saved.mailCap.hour, 40); assert.equal(saved.confirmationEnabled, true);
  assert.deepEqual(await geometry(page), before, 'three section saves: 0 px'); assert.deepEqual(errors, []);
});
