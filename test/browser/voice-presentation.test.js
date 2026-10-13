// AIT-102 PR 3: deterministic viewport evidence of main's voice presentation.
// Lifecycle and real media safety remain covered by the unchanged AIT-145/146 tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, settle, evidenceCommit } from './start2-display-helpers.js';

test('AIT-102 PR 3: voice viewport matrix, 390/1440, light/dark, DE/EN', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-voice-presentation-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_COMMIT: '6fe12b6', AITHEMA_BUILD_DATE: '2026-10-13T00:00:00Z',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(async () => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js');
    const render = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { globalThis.presentationRail = this; return render.call(this); };
    globalThis.presentationSeed = document.querySelector('aithema-session').session;
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.select('#theme', theme);
    for (const state of ['idle', 'listening', 'speaking', 'paused', 'waiting', 'old-tab', 'used-up']) {
      await page.evaluate(async ({ locale, state }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
        const { paintUtilities } = await import('/demo/page-preferences.js');
        const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.presentationSeed);
        session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
        session.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
        session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true, reason: null }]));
        session.transcript = [{ id: 'fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
        const client = { manifest, async start() {} };
        c.configure({ copy, session, voiceClient: client, voicePresentation: manifest.presentation,
          host: { version: { version: '0.0.0', commit: '6fe12b6', date: '2026-10-13T00:00:00Z' } } });
        const rail = globalThis.presentationRail;
        rail.state = ['old-tab', 'used-up'].includes(state) ? 'waiting' : state;
        rail.session = state === 'idle' ? null : { callId: 'fixture-call', providerSessionId: 'fixture-segment' };
        rail.paused = ['paused', 'waiting', 'old-tab', 'used-up'].includes(state);
        rail.moved = state === 'old-tab'; rail.requiresTakeover = rail.moved;
        rail.errorKey = rail.moved ? 'voiceMoved' : null;
        rail.usedUp = () => state === 'used-up'; rail.feature = () => ({ available: true, reason: null });
        rail.render(); rail.waveform.baseline();
        c.shadowRoot.querySelector('.connection-timer').textContent = '0:00';
        c.shadowRoot.activeElement?.blur(); document.documentElement.lang = locale;
        document.querySelector('#locale').value = locale; paintUtilities(copy); scrollTo(0, 0);
      }, { locale, state });
      await page.mouse.move(0, 500); await settle();
      assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off');
      await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '0:00'; });
      const name = `voice-${state}-${width}-${theme}-${locale}.png`;
      if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: false });
      files.push({ file: name, state, width, theme, locale, viewport: true });
    }
  }
  if (evidence) await writeFile(join(evidence, 'voice-presentation-evidence.json'), JSON.stringify({ ticket: 'AIT-102', head: evidenceCommit, baselineMain: '6fe12b6', files }, null, 2));
  t.diagnostic(`AIT-102 voice presentation: ${files.length} viewport shots.`);
});
