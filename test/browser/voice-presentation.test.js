// AIT-102 PR 3: deterministic viewport evidence of main's voice presentation.
// Lifecycle and real media safety remain covered by the unchanged AIT-145/146 tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
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
      const path = new URL(url, location.href).pathname;
      if (options.method === 'POST' && path === `/api/sessions/${c.session.id}/pause`) {
        const { paused } = JSON.parse(options.body);
        globalThis.endedRailPauseRequests.push(paused);
        return Promise.resolve(Response.json({ event: { seq: c.session.seq + 1, type: 'session.paused', data: { paused } } }));
      }
      if ((options.method ?? 'GET') === 'GET' && path === `/api/sessions/${c.session.id}`)
        return Promise.resolve(Response.json(c.session));
      return fetch(url, options);
    };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
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
      const events = voiceEvents(); globalThis.endedRailTerminal = Promise.withResolvers(); globalThis.endedRailPauseRequests = [];
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
          pause: visible('.pause'), resumeGlyph: visible('.pause .voice-icon--resume'),
          pauseEnabled: !root.querySelector('.pause').disabled, pauseTitle: root.querySelector('.pause').title,
          sessionPaused: c.session.paused, stop: visible('.voice-close'),
          overview: root.querySelector('.notice').textContent, summary: root.querySelector('.summary-text').textContent,
          footer: root.querySelector('.status__label').textContent, composer: root.querySelector('.composer-reason').textContent,
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
    const assertIdle = (value, reconciling = true) => {
      assert.equal(value.state, 'idle'); assert.equal(value.call, 'none');
      assert.equal(value.pauseGlyph, !reconciling, `${label}: session pause returns after settlement`); assert.equal(value.pause, !reconciling);
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
      if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    };
    await capture('reconciling');
    const clickPause = async () => {
      const point = await shadow(page, c => {
        const r = c.shadowRoot.querySelector('.pause').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await page.mouse.click(...point); await settle();
    };
    // A durable session hold during reconciliation must still offer a usable Resume.
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }));
    await settle();
    const reconcilePaused = await page.evaluate(() => globalThis.readEndedRail());
    assert.equal(reconcilePaused.pause, true); assert.equal(reconcilePaused.resumeGlyph, true);
    assert.equal(reconcilePaused.pauseEnabled, true); assert.equal(reconcilePaused.liveMic, false);
    await clickPause();
    assert.equal(await shadow(page, c => c.session.paused), false, `${label}: Resume works during reconcile`);
    assertIdle(await page.evaluate(() => globalThis.readEndedRail()));
    await page.evaluate(() => document.querySelector('aithema-session').receive({ type: 'voice.state', data: {
      callId: globalThis.endedRailCallId, providerSessionId: 'ended-provider', state: 'ended',
      terminal: { closureConfirmed: true, usage: { costEstimated: false } },
    } }));
    await settle();
    const idle = await page.evaluate(() => globalThis.readEndedRail()); assertIdle(idle, false);
    assert.equal(idle.text, locale === 'de' ? 'Anruf beendet.' : 'Call ended.');
    for (const value of [reconciling, idle]) assert.deepEqual(value.boxes, ended.boxes, `${label}: 0 px layout shift`);
    await capture('settled-idle');
    await clickPause();
    const pausedAfterCall = await page.evaluate(() => globalThis.readEndedRail());
    assert.equal(pausedAfterCall.sessionPaused, true); assert.equal(pausedAfterCall.pause, true);
    assert.equal(pausedAfterCall.resumeGlyph, true); assert.equal(pausedAfterCall.pauseGlyph, false);
    assert.equal(pausedAfterCall.pauseEnabled, true); assert.equal(pausedAfterCall.liveMic, false);
    assert.equal(pausedAfterCall.pauseTitle, locale === 'de' ? 'Fortsetzen' : 'Resume');
    assert.equal(pausedAfterCall.overview, idle.overview, `${label}: F6 overview keeps its last content`);
    assert.equal(pausedAfterCall.summary, idle.summary);
    assert.equal(pausedAfterCall.footer, locale === 'de' ? 'Verbunden' : 'Connected', `${label}: F6 footer keeps connection status`);
    assert.equal(pausedAfterCall.composer, locale === 'de' ? 'Gespräch pausiert' : 'Conversation paused');
    await page.mouse.move(0, 500); await settle(); await capture('paused-after-call');
    await clickPause();
    const resumed = await page.evaluate(() => globalThis.readEndedRail());
    assert.equal(resumed.sessionPaused, false); assertIdle(resumed, false);
    assert.deepEqual(await page.evaluate(() => globalThis.endedRailPauseRequests), [false, true, false]);
    for (const value of [reconcilePaused, pausedAfterCall, resumed]) assert.deepEqual(value.boxes, ended.boxes, `${label}: pause/resume shifts 0 px`);
    checks.push({ width, theme, locale, synchronous: true, ended, reconciling, reconcilePaused, idle, pausedAfterCall, resumed,
      resumeWorks: true, layoutShiftPx: 0, files, pass: true });
    t.diagnostic(`PASS AIT-179 ${evidenceCommit} ${label}: no pause glyph or live mic during reconcile; settled idle Pause visible; paused-session Resume visible and works; 0 px`);
  }
  if (evidence) await writeFile(join(evidence, 'ait-179-pass-lines.json'), JSON.stringify({ ticket: 'AIT-179', head: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', checks }, null, 2));
});

async function checkPhoneVoiceHeader(t, widths) {
  const { voiceStatusCases, approvedNarrowForm } = await import('../voice-status-cases.js');
  const { narrowVoiceStatus } = await import('../../packages/ui/src/voice-status.js');
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const head = event?.pull_request?.head?.sha ?? evidenceCommit;
  const directory = await mkdtemp(join(tmpdir(), 'aithema-ait302-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_COMMIT: '45cd699', AITHEMA_BUILD_DATE: '2026-10-17T00:00:00Z',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await demo.kill(); } });
  browser = await puppeteer.launch({ signal: t.signal, executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], passLines = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const stableViewport = async label => {
    // Rebuild the same band paint on both sides. Incremental invalidation after
    // replacing inline nodes otherwise retains different antialiasing at the
    // unchanged pause circle in Linux Chrome (65 border pixels, delta <= 3).
    await shadow(page, async c => {
      const band = c.shadowRoot.querySelector('.band'), visibility = band.style.visibility;
      band.style.visibility = 'hidden';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      band.style.visibility = visibility;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    let previous;
    for (let attempt = 0; attempt < 8; attempt++) {
      await settle();
      await shadow(page, async c => {
        await Promise.all(c.shadowRoot.querySelector('.band').getAnimations({ subtree: true })
          .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const current = Buffer.from(await page.screenshot({ fullPage: false }));
      if (previous?.equals(current)) return current;
      previous = current;
    }
    assert.fail(`${label}: viewport must settle to consecutive identical paints`);
  };
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(async () => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js'), render = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { globalThis.ait302Rail = this; return render.call(this); };
    globalThis.ait302Seed = document.querySelector('aithema-session').session;
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) {
    const { [locale]: copy } = await import(`../../packages/ui/src/i18n/${locale}.js`);
    await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.ait302Seed);
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
      session.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true }]));
      session.transcript = [{ id: 'fixture-turn', role: 'user', content: 'A website.' }];
      c.configure({ copy, session, voiceClient: { manifest, async start() {} }, voicePresentation: manifest.presentation });
      const timer = c.shadowRoot.querySelector('.connection-timer'); timer.textContent = '0:00';
      Object.defineProperty(timer, 'textContent', { configurable: true, get: () => '0:00', set() {} });
      document.documentElement.lang = locale; scrollTo(0, 0);
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    await page.evaluate(() => document.fonts.ready);
    for (const width of widths) {
      await page.setViewport({ width, height: width < 600 ? 844 : 900 });
      await page.mouse.move(-1, -1);
      let baseline;
      const capturedShorts = new Map();
      // Full coverage below 600; desktop compares the legacy paint directly.
      const samples = width < 600 ? voiceStatusCases(copy) : voiceStatusCases(copy).filter(s => s.id === 'consent' || s.creditCase);
      for (const sample of samples) {
        const short = narrowVoiceStatus(copy, sample.full);
        // Tick's copy-table evidence: each named status, then only new short forms
        // among availability/admission sources. Every source still runs every check.
        const capture = width >= 600 || Boolean(evidence &&
          (!sample.id.startsWith('reason-') || !capturedShorts.has(short)));
        const geometry = await page.evaluate(async ({ sample, capture }) => {
          const rail = globalThis.ait302Rail, copy = rail.copy;
          rail.session = sample.kind === 'state' && !['idle', 'failed'].includes(sample.id) ? {} : null;
          rail.state = sample.kind === 'state' && !['low', 'usedUp', 'timeExpired', 'creditEnding'].includes(sample.id) ? sample.id : 'idle';
          rail.errorKey = sample.kind === 'error' ? sample.id : null; rail.paused = sample.id === 'paused'; rail.waitingCall = null;
          rail.usedUp = () => ['usedUp', 'timeExpired', 'creditEnding'].includes(sample.id);
          rail.endReason = () => sample.id === 'timeExpired' ? 'one-hour' : null;
          rail.ending = () => sample.id === 'creditEnding'; rail.lowCredit = () => sample.id === 'low';
          if (sample.id === 'low') { rail.state = 'listening'; rail.session = {}; }
          rail.feature = () => sample.kind === 'consent' ? { available: false, rawReason: 'current processing consent required', reason: copy.featureConsent.voice }
            : ['reason', 'unavailable'].includes(sample.kind) ? { available: false, reason: sample.full, rawReason: sample.reason } : { available: true };
          if (sample.creditCase) {
            const { applyCreditStatusCase } = await import('/test/voice-status-cases.js');
            applyCreditStatusCase(rail, sample);
          }
          rail.render(); rail.waveform.baseline();
          const c = document.querySelector('aithema-session');
          c.shadowRoot.querySelector('.connection-timer').textContent = '0:00'; c.shadowRoot.activeElement?.blur(); document.activeElement?.blur();
          const root = c.shadowRoot;
          // Geometry reads below force layout. Only screenshot evidence needs paint
          // frames and animation settlement; source-only checks do not repaint.
          if (capture) {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await Promise.all(root.querySelector('.band').getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
          }
          const status = root.querySelector('.voice-state'), lines = new Map();
          const record = (rect, text) => {
            // Inline boxes and glyph ranges can differ slightly at the same baseline.
            const y = [...lines.keys()].find(y => Math.abs(y - rect.y) < 3) ?? rect.y;
            const parts = lines.get(y) ?? []; parts.push({ x: rect.x, right: rect.right, text }); lines.set(y, parts);
          };
          const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode, parent = text.parentElement, style = getComputedStyle(parent);
            if (style.display === 'none' || parent.closest('[aria-hidden="true"]') || (style.position === 'absolute' && style.clipPath !== 'none')) continue;
            for (let i = 0; i < text.length; i++) {
              const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
              for (const rect of range.getClientRects()) if (rect.width && rect.height) {
                record(rect, text.textContent[i]);
              }
            }
          }
          const narrow = status.querySelector('.consent-narrow');
          if (narrow && getComputedStyle(narrow).display !== 'none') {
            for (const rect of narrow.getClientRects()) if (rect.width && rect.height) record(rect, narrow.dataset.copy);
          }
          const action = status.querySelector('.consent-action'), css = getComputedStyle(status);
          const canShareLine = action && narrow.getBoundingClientRect().width + action.getBoundingClientRect().width + parseFloat(css.columnGap)
            <= status.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
          return { accessibleName: status.getAttribute('aria-label'), live: status.getAttribute('aria-live'), canShareLine, lines: [...lines.values()].map(parts => parts.sort((a, b) => a.x - b.x)
              .map((p, i, row) => (i && p.x - row[i - 1].right > 1 ? ' ' : '') + p.text).join('')), short: narrow?.dataset.copy, text: status.textContent, font: getComputedStyle(status).fontSize, captionFont: getComputedStyle(root.querySelector('.voice-caption')).fontSize,
            boxes: ['.band', '.voice-state', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.voice-output', '.voice-playback', '.pause', '.voice-input', '.voice-start', '.conversations-toggle', '.settings-open'].map(selector => {
              const r = root.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
            }) };
        }, { sample, capture });
        const label = `${width}-${theme}-${locale}-${sample.id}`;
        assert.equal(geometry.accessibleName, sample.full, `${label}: accessible name keeps full sentence`);
        assert.equal(geometry.live, (sample.creditCase ? sample.exhausted : ['usedUp', 'timeExpired', 'creditEnding'].includes(sample.id)) ? 'off' : 'polite', `${label}: existing live-region policy`);
        assert.equal(geometry.text, sample.full + (sample.kind === 'consent' ? `\u00a0· ${copy.featureConsent.action}` : ''), `${label}: live announcement keeps full sentence`);
        if (width < 600) {
          assert.equal(geometry.font, geometry.captionFont, `${label}: existing phone type scale`);
          if (geometry.canShareLine) assert.equal(geometry.lines.length, 1, `${label}: both consent units fit on one line`);
          const approved = approvedNarrowForm(copy, sample);
          if (approved) assert.equal(geometry.short, approved, `${label}: Tick’s approved short form`);
          assert.ok(geometry.short && [...geometry.short].length <= 22, `${label}: short form`);
          assert.ok(geometry.lines.length > 0 && geometry.lines.length <= 2, `${label}: at most 2 lines ${JSON.stringify(geometry.lines)}`);
          assert.ok(geometry.lines.every(line => !/^·|·$/u.test(line.trim())), `${label}: no dangling separator`);
          baseline ??= geometry.boxes; assert.deepEqual(geometry.boxes, baseline, `${label}: controls shift 0 px`);
        }
        const name = `${sample.creditCase ? 'ait310' : 'ait302'}-${label}.png`;
        if (width < 600 && capture) {
          await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false, optimizeForSpeed: true });
          capturedShorts.set(short, name);
        }
        if (width >= 600) {
          if (sample.id === 'consent') assert.equal(geometry.text, `${copy.featureConsent.voice}\u00a0· ${copy.featureConsent.action}`, `${label}: unchanged wide bytes`);
          const before = await stableViewport(`${label}/current`);
          if (width !== 600 && evidence) await writeFile(join(evidence, name), before);
          // Restore precisely the old inline nodes, leaving the accepted desktop CSS untouched.
          await shadow(page, c => {
            const status = c.shadowRoot.querySelector('.voice-state'), full = status.querySelector('.consent-wide');
            if (full) full.replaceWith(document.createTextNode(full.textContent));
            status.querySelector('.consent-narrow')?.remove();
          });
          const after = await stableViewport(`${label}/legacy`);
          if (!after.equals(before) && evidence) {
            await writeFile(join(evidence, `ait302-${label}-current.png`), before);
            await writeFile(join(evidence, `ait302-${label}-legacy.png`), after);
            const a = pixels(before), b = pixels(after), changed = []; let maxDelta = 0;
            for (let i = 0; i < a.result.length; i += a.channels) {
              const delta = Math.max(...a.result.subarray(i, i + a.channels).map((v, c) => Math.abs(v - b.result[i + c])));
              if (delta) { changed.push([i / a.channels % a.width, Math.floor(i / a.channels / a.width)]); maxDelta = Math.max(maxDelta, delta); }
            }
            await writeFile(join(evidence, `ait302-${label}-diff.json`), JSON.stringify({ label, changed: changed.length, maxDelta,
              bounds: changed.length ? [Math.min(...changed.map(p => p[0])), Math.min(...changed.map(p => p[1])), Math.max(...changed.map(p => p[0])), Math.max(...changed.map(p => p[1]))] : [] }));
          }
          assert.ok(after.equals(before), `${label}: byte-identical legacy desktop viewport`);
        }
        const passLine = `PASS ${sample.creditCase ? 'AIT-310' : 'AIT-302'} ${head} ${label}: ${width < 600 ? '<=2 lines; no separator at line edges; controls shift 0 px; short <=22 characters' : 'byte-identical legacy desktop viewport'}; full accessible name and live announcement`;
        passLines.push(passLine);
        checks.push({ label, pass: true, passLine, lines: geometry.lines, layoutShiftPx: 0,
          accessibleName: geometry.accessibleName, liveText: geometry.text,
          file: evidence && width !== 600 && capture ? name : null,
          shortFormEvidence: width < 600 ? capturedShorts.get(short) ?? null : null });
      }
      const pass = `PASS AIT-302 ${head} ${width}-${theme}-${locale}: ${samples.length} statuses; <=2 lines; no separator at line edges; controls shift 0 px`;
      passLines.push(pass); t.diagnostic(pass);
    }
  }
  if (evidence && widths[0] < 600) await writeFile(join(evidence, 'ait310-checks.json'), JSON.stringify({ ticket: 'AIT-310', head, testedCommit: evidenceCommit, capture: 'viewport', reducedMotion: true,
    passLines: passLines.filter(line => line.startsWith('PASS AIT-310 ')), checks: checks.filter(check => check.passLine.startsWith('PASS AIT-310 ')) }, null, 2));
  if (evidence) await writeFile(join(evidence, widths[0] < 600 ? 'ait302-checks.json' : 'ait302-desktop-checks.json'), JSON.stringify({ ticket: 'AIT-302', head, testedCommit: evidenceCommit, capture: 'viewport', reducedMotion: true, passLines, checks }, null, 2));
}

test('AIT-302: phone header voice statuses and fixed controls', { timeout: 360_000 }, t => checkPhoneVoiceHeader(t, [320, 360, 390]));
test('AIT-302: unchanged desktop consent', { timeout: 90_000 }, t => checkPhoneVoiceHeader(t, [600, 1024, 1440]));
