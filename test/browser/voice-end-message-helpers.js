import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';
import { browserPath, until, evidenceCommit } from './start2-display-helpers.js';

export async function checkVoiceEndMessages(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-voice-ends-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith(demo.url) && !request.url().startsWith('data:')) return request.abort();
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/turns')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'turn.final', data: { id: 'typed', role: 'user', content: 'Continue typing' } }) });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(async () => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js'), render = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { window.endRail = this; return render.call(this); };
    window.endSeed = structuredClone(document.querySelector('aithema-session').session);
  });
  const box = r => { assert.ok(r.width > 0 && r.height > 0, `positive measured box: ${JSON.stringify(r)}`); };
  const unchanged = (before, after) => { for (const key of Object.keys(before)) { box(before[key]); box(after[key]);
    for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key][axis] - after[key][axis]) <= .5, `${key}.${axis}: ${before[key][axis]} -> ${after[key][axis]}`); } };
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(window.endSeed);
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
      session.engine.voice = { id: 'elevenlabs', offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(k => [k, { available: true }]));
      session.transcript = [{ id: 'seed', role: 'user', content: 'A website' }];
      c.configure({ copy, session, voiceClient: { manifest, async start() { return new Promise(() => {}); } }, voicePresentation: manifest.presentation });
      window.endRail.state = 'idle'; window.endRail.errorKey = null; window.endRail.render();
      window.readEnds = () => {
        const rail = window.endRail, root = c.shadowRoot, status = root.querySelector('.voice-state'), close = root.querySelector('.voice-message-close');
        const rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const visible = n => n && !n.hidden && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden';
        return { controls: Object.fromEntries(['.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.voice-signal'].map(s => [s, rect(root.querySelector(s))])),
          close: visible(close) ? rect(close) : null, closeLabel: close?.getAttribute('aria-label'), outsideLive: close?.parentElement === status.parentElement && !status.contains(close),
          header: rect(root.querySelector('.band')), message: rect(status), retry: rect(rail.button('retry')), narrow: status.querySelector('.consent-narrow')?.dataset.copy,
          narrowVisible: visible(status.querySelector('.consent-narrow')), label: status.getAttribute('aria-label'), errorKey: rail.errorKey,
          color: getComputedStyle(status).color, neutralColor: getComputedStyle(root.querySelector('textarea')).color,
          messagePresent: rail.root.hasAttribute('data-message') };
      };
    }, locale);
    await page.evaluate(() => document.fonts.ready); await page.mouse.move(0, 500);
    const before = await page.evaluate(() => window.readEnds());
    for (const action of ['dismiss', 'escape', 'typed', 'retry', 'close']) {
      await page.evaluate(() => { const r = window.endRail; r.session = null; r.state = 'failed'; r.errorKey = 'voiceTimeLimit'; r.render(); });
      const shown = await page.evaluate(() => window.readEnds()); unchanged(before.controls, shown.controls); box(shown.message); box(shown.retry);
      assert.equal(shown.label, locale === 'en' ? 'The call reached its maximum length. Start a new call or continue typing.' : 'Der Anruf hat seine maximale Dauer erreicht. Starten Sie einen neuen Anruf oder schreiben Sie weiter.');
      assert.equal(shown.outsideLive, true); assert.equal(shown.color, shown.neutralColor, 'time-limit uses neutral ink');
      if (width < 600) { assert.equal(shown.close, null); assert.equal(shown.narrowVisible, true); assert.equal(shown.narrow, locale === 'en' ? 'Time limit reached' : 'Zeitlimit erreicht'); }
      else {
        box(shown.close); assert.ok(shown.close.width >= 44 && shown.close.height >= 44);
        assert.ok(shown.close.y - shown.retry.y - shown.retry.height >= 0, 'close and Retry targets do not overlap');
        assert.equal(shown.closeLabel, locale === 'en' ? 'Close message' : 'Meldung schließen');
        assert.ok(Math.abs(shown.message.y - shown.retry.y - shown.retry.height - 8) <= .5, 'message under Retry');
        const left = Math.max(16, shown.header.x), right = Math.min(width - 16, shown.header.x + shown.header.width);
        const anchoredLeft = Math.max(left, Math.min(shown.retry.x + shown.retry.width / 2 - shown.message.width / 2, right - shown.message.width));
        assert.ok(Math.abs(shown.message.x - anchoredLeft) <= .5, 'message centred on Retry or clamped inside header');
      }
      await page.evaluate(() => { window.endRail.errorKey = 'voiceConnectFailed'; window.endRail.render(); });
      const connection = await page.evaluate(() => window.readEnds()); unchanged(before.controls, connection.controls);
      assert.equal(connection.label, locale === 'en' ? "The call couldn't connect. Select Retry call, or continue typing." : 'Der Anruf konnte nicht aufgebaut werden. Wählen Sie „Erneut anrufen“ oder schreiben Sie weiter.');
      if (width < 600) { assert.equal(connection.narrowVisible, true); assert.equal(connection.narrow, locale === 'en' ? "Couldn't connect" : 'Keine Verbindung'); }
      else { box(connection.close); unchanged({ close: shown.close }, { close: connection.close }); }
      await page.evaluate(() => { window.endRail.errorKey = 'voiceTimeLimit'; window.endRail.render(); });
      if (action === 'dismiss' && width < 600) await page.evaluate(() => window.endRail.clearMessage());
      else if (action === 'dismiss') await page.evaluate(() => window.endRail.root.querySelector('.voice-message-close').click());
      else if (action === 'escape') await page.evaluate(() => (window.endRail.button('retry').focus(), window.endRail.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))));
      else if (action === 'typed') await page.evaluate(() => { const root = document.querySelector('aithema-session').shadowRoot; root.querySelector('textarea').value = 'Continue typing'; root.querySelector('form').requestSubmit(); });
      else if (action === 'retry') await page.evaluate(() => window.endRail.button('retry').click());
      else await page.evaluate(() => window.endRail.close());
      await until(page, () => !window.endRail.root.hasAttribute('data-message'));
      const cleared = await page.evaluate(() => window.readEnds()); unchanged(before.controls, cleared.controls);
      assert.equal(cleared.errorKey, null); assert.equal(cleared.close, null);
      checks.push({ locale, theme, width, action, before: before.controls, shown, connection, cleared: cleared.controls, tolerancePx: .5, pointer: { x: 0, y: 500 } });
      await page.evaluate(() => window.endRail.close());
    }
  }
  assert.deepEqual(errors, []);
  if (process.env.AITHEMA_EVIDENCE_DIR) { await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait502-rects.json'), JSON.stringify({ testedCommit: evidenceCommit, checks }, null, 2)); }
}
