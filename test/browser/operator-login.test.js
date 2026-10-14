// Real host + local Zitadel-shaped issuer. Viewport captures only; remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { listen } from '../../packages/server/src/http.js';
import { startChild } from '../helpers.js';
import { stubOperatorIssuer } from '../fixtures/operator-issuer.js';
import { browserPath, shadow, until, evidenceCommit } from './start2-display-helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';

async function host(directory, issuer, configured) {
  const reservation = await listen(() => new Response());
  const port = reservation.server.address().port;
  await new Promise(resolve => reservation.server.close(resolve));
  const running = await startChild(new URL('../../demo/server.js', import.meta.url), join(directory, configured ? 'on.sqlite' : 'off.sqlite'), {
    PORT: String(port), AITHEMA_PROVIDER: 'mock', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_PUBLIC_ORIGIN: `http://localhost:${port}`, AITHEMA_COMMIT: evidenceCommit,
    AITHEMA_ADMIN_SOCKET: join(directory, configured ? 'on-admin' : 'off-admin'),
    ...(configured ? { AITHEMA_OPERATOR_ISSUER: issuer.issuer, AITHEMA_OPERATOR_CLIENT_ID: 'browser-client', AITHEMA_OPERATOR_SUBJECT: 'allowed-operator' } : {}),
  });
  return { ...running, url: `http://localhost:${port}` };
}
const geometry = page => shadow(page, c => {
  const r = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  return ['dialog.settings', '.operator-section', '.operator-row', '.operator-notice', '.settings__footer'].map(s => box(r.querySelector(s)));
});
// Session SSE remains open; navigation waits for the document, then explicit UI readiness.
const openGeneral = async page => {
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '.operator-section' }));
  await until(page, () => {
    const entry = document.querySelector('aithema-session').shadowRoot.querySelector('.host-verify');
    return entry.dataset.emailState && entry.querySelector('.m-lead-save')?.textContent;
  });
  // Scroll the last section into view; the footer stays fixed.
  await shadow(page, c => { const s = c.shadowRoot; s.querySelector('.settings__body').scrollTop = s.querySelector('.settings__body').scrollHeight; });
  await page.evaluate(() => document.fonts.ready);
};

test('AIT-165 viewport matrix: real sign-in/logout, inline error and feature off; DE/EN, light/dark, 390/1024/1440; 0 px shift',
  { timeout: 180_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-operator-ui-')), issuer = await stubOperatorIssuer();
    const evidence = process.env.AITHEMA_EVIDENCE_DIR, passLines = [], shots = [];
    let browser, configured, absent;
    t.after(async () => { await browser?.close(); await configured?.kill(); await absent?.kill(); await issuer.close(); await rm(directory, { recursive: true, force: true }); });
    configured = await host(directory, issuer, true); absent = await host(directory, issuer, false);
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const [locale, copy] of [['de', de], ['en', en]]) {
      browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome-' + locale),
        env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
      const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.evaluateOnNewDocument(locale => { localStorage.setItem('aithema-demo-locale', locale); }, locale);
      const capture = async (state, width, theme) => {
        const name = `ait-165-${evidenceCommit}-${locale}-${theme}-${width}-${state}.png`;
        if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: false }); shots.push(name);
          if (['signed-in', 'signed-out'].includes(state)) await page.screenshot({ path: join(evidence, `ait-169-${evidenceCommit}-${locale}-${theme}-${width}-${state === 'signed-in' ? 'entry' : 'entry-out'}.png`), fullPage: false }); }
        const row = { head: evidenceCommit, locale, theme, width, state, shiftPx: 0 };
        passLines.push(row); t.diagnostic(`PASS head=${evidenceCommit} AIT-165 ${locale}-${theme}-${width}/${state} 0 px layout shift`);
      };
      for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewport({ width, height: width === 390 ? 844 : 900 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.goto(configured.url, { waitUntil: 'domcontentloaded' }); await openGeneral(page);
        const before = await geometry(page);
        const info = await shadow(page, c => {
          const s = c.shadowRoot, section = s.querySelector('.operator-section'), link = s.querySelector('.operator-login'), b = link.getBoundingClientRect();
          return { last: section === section.parentElement.lastElementChild, headings: section.querySelectorAll('h2,h3,h4').length,
            text: link.textContent.trim(), font: getComputedStyle(link).fontSize, height: b.height, muted: getComputedStyle(link).color === getComputedStyle(s.querySelector('.m-notice')).color,
            overflow: s.querySelector('.general').scrollWidth - s.querySelector('.general').clientWidth,
            otherEntries: s.querySelectorAll('.band .operator-login,.composer .operator-login,footer .operator-login').length };
        });
        assert.equal(info.last, true); assert.equal(info.headings, 0); assert.equal(info.text, copy.settings.operatorLogin.replace('{provider}', 'Zitadel'));
        assert.equal(info.font, '13px'); assert.ok(info.height >= 44); assert.equal(info.muted, true); assert.equal(info.overflow, 0); assert.equal(info.otherEntries, 0);
        await capture('signed-out', width, theme);
        // The native link visits the local issuer and returns to the exact callback.
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), shadow(page, c => c.shadowRoot.querySelector('.operator-login').click())]);
        await openGeneral(page);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.operator-name').textContent), 'Operator: Ada');
        // Chrome inserts newlines between flex items in form.innerText; each
        // item's innerText still exposes whether its spaces actually rendered.
        assert.equal(await shadow(page, c => [...c.shadowRoot.querySelector('.operator-signed-in').children].map(n => n.innerText).join('')),
          locale === 'de' ? 'Operator: Ada · Verwaltung · Abmelden' : 'Operator: Ada · Admin · Sign out');
        assert.deepEqual(await page.evaluate(async () => (await (await fetch('/demo/config')).json()).operator), { name: 'Ada' });
        assert.deepEqual(await geometry(page), before, 'sign-in: 0 px shift');
        const form = await shadow(page, c => ({ method: c.shadowRoot.querySelector('.operator-signed-in').method,
          height: c.shadowRoot.querySelector('.operator-logout').getBoundingClientRect().height }));
        assert.equal(form.method, 'post'); assert.ok(form.height >= 44);
        await capture('signed-in', width, theme);
        // Native form submits a same-origin POST; the replayed cookie no longer works.
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), shadow(page, c => c.shadowRoot.querySelector('.operator-logout').click())]);
        await openGeneral(page); assert.deepEqual(await geometry(page), before, 'sign-out: 0 px shift');
        assert.equal(await page.evaluate(async () => Object.hasOwn(await (await fetch('/demo/config')).json(), 'operator')), false);
        await page.goto(configured.url + '/api/operator/callback/?state=wrong&code=wrong', { waitUntil: 'domcontentloaded' }); await openGeneral(page);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.operator-error').textContent), copy.settings.operatorError);
        assert.deepEqual(await geometry(page), before, 'inline error: 0 px shift');
        await capture('error', width, theme);
        await page.goto(absent.url, { waitUntil: 'domcontentloaded' }); await openGeneral(page);
        assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.operator-section'))), false);
        const offFrame = await shadow(page, c => ['dialog.settings', '.settings__footer'].map(selector => {
          const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        }));
        assert.deepEqual(offFrame, [before[0], before[4]], 'feature off: 0 px frame/footer shift');
        assert.equal(await page.evaluate(async () => Object.hasOwn(await (await fetch('/demo/config')).json(), 'operatorLogin')), false);
        await capture('no-zitadel', width, theme);
      }
      assert.deepEqual(errors, []); await browser.close(); browser = null;
    }
    if (evidence) await writeFile(join(evidence, `ait-165-${evidenceCommit}-passes.json`), JSON.stringify({ head: evidenceCommit, viewport: true, passLines, shots }, null, 2));
    assert.equal(passLines.length, 48);
  });
