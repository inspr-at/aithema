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
  const baseline = process.env.AITHEMA_VOICE_BASELINE_DIR;
  let baselineMain = process.env.AITHEMA_VOICE_BASELINE_MAIN ?? evidenceCommit;
  if (baseline && !process.env.AITHEMA_VOICE_BASELINE_MAIN) {
    try { baselineMain = JSON.parse(await readFile(join(baseline, 'voice-presentation-evidence.json'), 'utf8')).head; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
      try { if (baseline) original = await readFile(join(baseline, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  if (evidence) await writeFile(join(evidence, 'voice-presentation-evidence.json'), JSON.stringify({ ticket: 'AIT-102', head: evidenceCommit, baselineMain, files }, null, 2));
  if (evidence && passLines.length) await writeFile(join(evidence, 'voice-pixel-diff.json'), JSON.stringify({ ticket: 'AIT-102', head: evidenceCommit, baselineMain, passLines }, null, 2));
  t.diagnostic(`AIT-102 voice presentation: ${files.length} viewport shots.`);
});

test('AIT-179: hangup paints idle controls synchronously; reconciling and settled rail shift 0 px', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-ended-rail-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(() => {
    globalThis.endedRailSeed = document.querySelector('aithema-session').session;
    const fetch = window.fetch.bind(window);
    window.fetch = (url, options = {}) => {
      const c = document.querySelector('aithema-session');
      // The fake voice client owns this presentation fixture; admission refreshes
      // must not replace it with the no-provider server's voice-off snapshot.
      if ((options.method ?? 'GET') === 'GET' && new URL(url, location.href).pathname === `/api/sessions/${c.session.id}`)
        return Promise.resolve(Response.json(c.session));
      return fetch(url, options);
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    const label = `${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      const { voiceEvents } = await import('/packages/core/src/live-voice.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.endedRailSeed);
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
      session.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true }]));
      session.transcript = [{ id: 'fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
      const events = voiceEvents(); globalThis.endedRailTerminal = Promise.withResolvers();
      c.configure({ copy, session, voicePresentation: manifest.presentation, voiceClient: { manifest, async start({ callId }) {
        globalThis.endedRailCallId = callId;
        return { callId, providerSessionId: 'ended-provider', events,
          async setInput() {}, async setOutput() {}, async updateContext() {},
          close() { events.end(); return globalThis.endedRailTerminal.promise; } };
      } } });
      globalThis.readEndedRail = () => {
        const root = c.shadowRoot, rail = root.querySelector('.audio-rail');
        const visible = selector => getComputedStyle(root.querySelector(selector)).visibility === 'visible';
        return { state: rail.dataset.state, call: rail.dataset.call, text: root.querySelector('.voice-state').textContent,
          start: visible('.voice-start'), startEnabled: !root.querySelector('.voice-start').disabled,
          liveMic: visible('.voice-input'), pauseGlyph: visible('.pause .voice-icon:not(.voice-icon--resume)'),
          pause: visible('.pause'), stop: visible('.voice-close'),
          boxes: ['.band', '.audio-rail', '.voice-cell--output', '.voice-signal', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.composer'].map(selector => {
            const r = root.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
          }) };
      };
      c.shadowRoot.querySelector('.voice-start').click();
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
      c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); scrollTo(0, 0);
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    await page.mouse.move(0, 500); await settle();
    const live = await page.evaluate(() => globalThis.readEndedRail());
    assert.equal(live.pause, true, `${label}: live pause unchanged`); assert.equal(live.liveMic, true);
    const ended = await page.evaluate(() => {
      document.querySelector('aithema-session').shadowRoot.querySelector('.voice-close').click();
      return globalThis.readEndedRail(); // Same task: no frame, timer, microtask or network response can intervene.
    });
    const assertIdle = value => {
      assert.equal(value.state, 'idle'); assert.equal(value.call, 'none');
      assert.equal(value.pauseGlyph, false, `${label}: no pause glyph`); assert.equal(value.pause, false);
      assert.equal(value.liveMic, false, `${label}: no live mic`); assert.equal(value.stop, false);
      assert.equal(value.start, true, `${label}: idle start control`); assert.equal(value.startEnabled, true, `${label}: start remains admitted: ${JSON.stringify(value)}`);
    };
    assertIdle(ended);
    assert.equal(ended.text, locale === 'de' ? 'Anruf beendet. Kosten werden noch abgeglichen.' : 'Call ended. Costs are still being reconciled.');
    await page.evaluate(async () => { globalThis.endedRailTerminal.resolve({ closureConfirmed: false, reconciliationPending: true }); });
    await settle();
    const reconciling = await page.evaluate(() => globalThis.readEndedRail());
    assertIdle(reconciling); assert.equal(reconciling.text, ended.text);
    const files = [];
    const capture = async state => {
      const file = `ait-179-${state}-${label}.png`; files.push(file);
      if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
    };
    await capture('ended-reconciling');
    await page.evaluate(() => document.querySelector('aithema-session').receive({ type: 'voice.state', data: {
      callId: globalThis.endedRailCallId, providerSessionId: 'ended-provider', state: 'ended',
      terminal: { closureConfirmed: true, usage: { costEstimated: false } },
    } }));
    await settle();
    const idle = await page.evaluate(() => globalThis.readEndedRail()); assertIdle(idle);
    assert.equal(idle.text, locale === 'de' ? 'Anruf beendet.' : 'Call ended.');
    for (const value of [reconciling, idle]) assert.deepEqual(value.boxes, ended.boxes, `${label}: 0 px layout shift`);
    await capture('idle');
    checks.push({ width, theme, locale, synchronous: true, ended, reconciling, idle, layoutShiftPx: 0, files, pass: true });
    t.diagnostic(`PASS AIT-179 ${evidenceCommit} ${label}: synchronous idle start control; no pause glyph; no live mic; reconciling text until settled; 0 px`);
  }
  if (evidence) await writeFile(join(evidence, 'ait-179-pass-lines.json'), JSON.stringify({ ticket: 'AIT-179', head: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', checks }, null, 2));
});
