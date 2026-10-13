// AIT-102 PR 3: deterministic viewport evidence of main's voice presentation.
// Lifecycle and real media safety remain covered by the unchanged AIT-145/146 tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, settle, evidenceCommit } from './start2-display-helpers.js';
import { pixels, samePaint } from './png-pixels.js';

test('AIT-102 PR 3: voice viewport matrix, 390/1440, light/dark, DE/EN', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-voice-presentation-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_COMMIT: '6fe12b6', AITHEMA_BUILD_DATE: '2026-10-13T00:00:00Z',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], passLines = [];
  // The remote builder transfers main's captured viewports here before the head run.
  // CI still captures the matrix when that separately retained baseline is absent.
  const baseline = process.env.AITHEMA_VOICE_BASELINE_DIR ?? '/private/tmp/aithema-ait102-pr3-merge-baseline-5fae3bb51c';
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
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
      await page.mouse.move(0, 500); await settle();
      assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off');
      await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '0:00'; });
      const name = `voice-${state}-${width}-${theme}-${locale}.png`;
      // Backdrop-filter layers can retain the preceding rail state for a frame.
      // Flush them and wait for consecutive stable viewport paints on both revisions.
      let captured, previous = Buffer.from(await page.screenshot({ fullPage: false })), stable = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        await settle();
        await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '0:00'; });
        captured = Buffer.from(await page.screenshot({ fullPage: false }));
        if (samePaint(previous, captured)) { stable = true; break; }
        previous = captured;
      }
      assert.equal(stable, true, `${name}: stable backdrop paint`);
      if (evidence) await writeFile(join(evidence, name), captured);
      let original;
      try { original = await readFile(join(baseline, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (original) {
        const before = pixels(original), after = pixels(captured);
        assert.deepEqual([after.width, after.height, after.channels], [before.width, before.height, before.channels]);
        let changedPixels = 0, rawChangedPixels = 0, maxChannelDelta = 0;
        for (let offset = 0; offset < after.result.length; offset += after.channels) {
          const deltas = [...after.result.subarray(offset, offset + after.channels)].map((value, channel) => Math.abs(value - before.result[offset + channel]));
          if (deltas.some(value => value > 0)) rawChangedPixels++;
          // Match png-pixels.js's existing compositor-dithering convention.
          // Record raw differences as well; no changed glyph, stroke or layout is masked.
          if (deltas.some(value => value > 1)) changedPixels++;
          maxChannelDelta = Math.max(maxChannelDelta, ...deltas);
        }
        assert.equal(changedPixels, 0, `${name}: main-to-head pixel difference beyond one-unit compositor dithering`);
        passLines.push({ file: name, changedPixels, rawChangedPixels, maxChannelDelta, tolerance: 1, pass: true });
        t.diagnostic(`PASS ${name}: 0 px diff (1-unit compositor tolerance; ${rawChangedPixels} raw differing pixels)`);
      }
      files.push({ file: name, state, width, theme, locale, viewport: true });
    }
  }
  if (evidence) await writeFile(join(evidence, 'voice-presentation-evidence.json'), JSON.stringify({ ticket: 'AIT-102', head: evidenceCommit, baselineMain: '5fae3bb51ce6fb7afd5f85af6264dcabedf25533', files }, null, 2));
  if (evidence && passLines.length) await writeFile(join(evidence, 'voice-pixel-diff.json'), JSON.stringify({ ticket: 'AIT-102', head: evidenceCommit, baselineMain: '5fae3bb51ce6fb7afd5f85af6264dcabedf25533', passLines }, null, 2));
  t.diagnostic(`AIT-102 voice presentation: ${files.length} viewport shots.`);
});
