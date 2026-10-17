// AIT-186: Tick's binding follow-ups. Viewport evidence only, remote runner only.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

// Every scene reconfigures from tickSeed; keep the expensive host and page for
// the file, including the genuinely open SSE connection checked by F8.
let fileFixture, cleanup;
after(() => cleanup?.());
const fixture = () => fileFixture ??= createFixture();
async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-tick-followups-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  cleanup = async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); };
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.tickSeed = c.session; });
  return page;
}
// Reduced motion is configured before navigation. Drain actual rendering and
// finite transitions instead of sleeping 120 ms after every matrix action.
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(resolve));
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
    .filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime))
    .map(a => a.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(resolve));
});
async function scene(page, locale, theme, width, { reset = true, ready = true } = {}) {
  await page.setViewport({ width, height: width < 600 ? 844 : 900 }); await page.select('#theme', theme);
  await page.evaluate(async ({ locale, reset }) => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale;
    if (reset) c.configure({ copy, session, host: { library: true } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    scrollTo(0, 0);
  }, { locale, reset });
  if (ready) await settle(page);
}
async function evidence(finding, page, label, values, { hoverSelector } = {}) {
  const root = process.env.AITHEMA_EVIDENCE_DIR;
  if (root) {
    const dir = join(root, finding); await mkdir(dir, { recursive: true });
    await page.mouse.move(-1, -1);
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    if (hoverSelector) await page.hover(hoverSelector);
    await settle(page);
    await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(dir, `${label}.json`), JSON.stringify({ head: evidenceCommit, finding, label, ...values, pass: true }, null, 2));
  }
}

test('AIT-186 F1: phone header controls never overlap; DE/EN, L/D', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark', 'system']) for (const width of [390, 393, 400, 412, 430, 440, 447, 448, 460, 479, 480, 500, 550, 1024, 1440]) {
    await scene(page, locale, theme, width);
    const selectors = ['.band', '.conversations-toggle', '.host-account', '.settings-open'];
    const before = await boxes(page, selectors);
    const metrics = await shadow(page, c => {
      const r = c.shadowRoot, button = r.querySelector('.conversations-toggle');
      const b = button.getBoundingClientRect(), settings = r.querySelector('.settings-open').getBoundingClientRect();
      return { overlapPx: Math.max(0, b.right - settings.left), width: b.width, height: b.height,
        name: button.getAttribute('aria-label'), icons: [...button.querySelectorAll('svg')].filter(n => n.getBoundingClientRect().width > 0).length,
        preferencesInSettings: r.querySelector('slot[name="utilities"]').closest('dialog')?.classList.contains('settings') };
    });
    const label = `${locale}-${theme}-${width}`;
    assert.equal(metrics.overlapPx, 0, `${label}: header overlap ${JSON.stringify(metrics)}`);
    assert.equal(metrics.width, width < 600 ? 44 : 168); assert.equal(metrics.height, 44); assert.equal(metrics.icons, width < 600 ? 1 : 2);
    assert.equal(metrics.name, locale === 'de' ? 'Gespräche' : 'Conversations');
    assert.equal(metrics.preferencesInSettings, true);
    await page.hover('aithema-session >>> .conversations-toggle');
    assert.deepEqual(await boxes(page, selectors), before, `${label}: hover shift 0 px`);
    const values = { ...metrics, shiftPx: 0 };
    await evidence('F1', page, label, values, { hoverSelector: 'aithema-session >>> .conversations-toggle' }); t.diagnostic(`PASS F1 ${label}: ${JSON.stringify(values)}`);
  }
});

async function voiceScene(page, locale, theme, width) {
  await scene(page, locale, theme, width, { reset: false, ready: false });
  await page.evaluate(async locale => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js');
    if (!globalThis.tickRailHook) {
      const render = AudioRail.prototype.render;
      AudioRail.prototype.render = function () { globalThis.tickRail = this; return render.call(this); };
      globalThis.tickRailHook = true;
    }
    const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const { voiceEvents } = await import('/packages/core/src/live-voice.js');
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
    session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true }]));
    session.transcript = [{ id: 'tick-user', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
    c.configure({ copy, session, host: { library: true }, voicePresentation: manifest.presentation,
      voiceClient: { manifest, async start({ callId }) {
        const events = voiceEvents();
        return { callId, providerSessionId: 'tick-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
          async close() { events.end(); return { closureConfirmed: false, reconciliationPending: true }; } };
      } } });
    document.documentElement.lang = locale;
  }, locale);
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
  await settle(page);
}
const railBoxes = ['.band', '.audio-rail', '.voice-cell--output', '.voice-signal', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.composer'];

test('AIT-186 F3: both used-up paths share idle controls and a drawn line, 0 px shift', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) for (const state of ['voice-used-up', 'after-call-used-up']) {
    await voiceScene(page, locale, theme, width);
    if (state === 'after-call-used-up') await page.evaluate(async () => { await globalThis.tickRail.start(); await globalThis.tickRail.close(); });
    const before = await boxes(page, railBoxes);
    await page.evaluate(state => {
      const rail = globalThis.tickRail;
      if (state === 'voice-used-up') { rail.state = 'waiting'; rail.paused = true; rail.session = { callId: 'used-up-call', providerSessionId: 'used-up-provider' }; }
      rail.usedUp = () => true; rail.render(); rail.waveform.baseline();
    }, state);
    await settle(page);
    const view = await shadow(page, c => {
      const r = c.shadowRoot, visible = selector => getComputedStyle(r.querySelector(selector)).visibility === 'visible';
      return { visible: ['.pause', '.pause .voice-icon', '.pause .voice-icon--resume', '.voice-input', '.voice-close', '.voice-retry'].filter(visible),
        start: visible('.voice-start'), startDisabled: r.querySelector('.voice-start').disabled, speaker: visible('.voice-output'),
        line: visible('.voice-wave'), transform: getComputedStyle(r.querySelector('.voice-wave')).transform,
        railText: r.querySelector('.voice-state').textContent };
    });
    const label = `${locale}-${theme}-${width}-${state}`;
    assert.deepEqual(view.visible, [], `${label}: no dead pause, mic or stop controls`);
    assert.equal(view.start, true); assert.equal(view.startDisabled, true); assert.equal(view.speaker, true); assert.equal(view.line, true);
    assert.equal(view.transform, 'none', 'the calm line is drawn at full stroke height');
    assert.equal(view.railText, locale === 'de' ? 'Credits aufgebraucht' : 'Credits used up');
    assert.deepEqual(await boxes(page, railBoxes), before, `${label}: 0 px shift`);
    const values = { ...view, shiftPx: 0 }; await evidence('F3', page, label, values); t.diagnostic(`PASS F3 ${label}: ${JSON.stringify(values)}`);
    await page.evaluate(() => { globalThis.tickRail.session = null; });
  }
});

test('AIT-186 F4: reconciling fits two lines at 390 DE without moving the mic', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await voiceScene(page, locale, theme, width);
    await page.evaluate(() => globalThis.tickRail.start()); await settle(page);
    const before = await boxes(page, railBoxes);
    await page.evaluate(() => globalThis.tickRail.close()); await settle(page);
    const view = await shadow(page, c => {
      const root = c.shadowRoot, n = root.querySelector('.voice-state'), range = document.createRange(); range.selectNodeContents(n);
      const narrow = n.querySelector('.consent-narrow');
      const rects = narrow && getComputedStyle(narrow).display !== 'none' ? [...narrow.getClientRects()] : [...range.getClientRects()], mic = root.querySelector('.voice-cell--mic').getBoundingClientRect(), band = root.querySelector('.band').getBoundingClientRect();
      return { labelWidth: n.getBoundingClientRect().width, signalWidth: root.querySelector('.voice-signal').getBoundingClientRect().width,
        lines: new Set(rects.map(r => r.y)).size, textRight: Math.max(...rects.map(r => r.right)), micLeft: mic.left,
        textBottom: Math.max(...rects.map(r => r.bottom)), bandBottom: band.bottom, railText: n.textContent };
    });
    const label = `${locale}-${theme}-${width}-reconciling`;
    if (width === 390) assert.ok(view.labelWidth >= view.signalWidth + 44, `${label}: label can use the empty pause reservation: ${JSON.stringify(view)}`);
    assert.ok(view.lines <= 2, `${label}: at most two lines: ${JSON.stringify(view)}`);
    if (width >= 600) assert.ok(view.textRight <= view.micLeft, `${label}: label never covers mic`);
    else assert.ok(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').getBoundingClientRect().top >= c.shadowRoot.querySelector('.voice-input').getBoundingClientRect().bottom), `${label}: status below mic`);
    assert.ok(view.textBottom < view.bandBottom, `${label}: label clears hairline`);
    assert.deepEqual(await boxes(page, railBoxes), before, `${label}: mic and all rail cells shift 0 px`);
    const values = { ...view, shiftPx: 0 }; await evidence('F4', page, label, values); t.diagnostic(`PASS F4 ${label}: ${JSON.stringify(values)}`);
  }
});

test('AIT-186 F5: voice-failure popover has readable words and measured viewport width', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 400, 1024, 1440]) {
    await voiceScene(page, locale, theme, width);
    const before = await boxes(page, railBoxes);
    await page.evaluate(() => { globalThis.tickRail.state = 'failed'; globalThis.tickRail.failure(new Error('fixture voice outage')); });
    await settle(page);
    const view = await shadow(page, c => {
      const r = c.shadowRoot, n = r.querySelector('.voice-state'), b = n.getBoundingClientRect(), style = getComputedStyle(n);
      const bubble = r.querySelector('li.turn').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(n);
      const narrow = n.querySelector('.consent-narrow');
      const rects = narrow && getComputedStyle(narrow).display !== 'none' ? [...narrow.getClientRects()] : [...range.getClientRects()];
      return { popoverWidth: b.width, left: b.left, right: b.right, lines: new Set(rects.map(r => r.y)).size,
        overlapPx: Math.max(0, Math.min(b.bottom, bubble.bottom) - Math.max(b.top, bubble.top)),
        overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, hyphens: style.hyphens, railText: n.textContent };
    });
    const label = `${locale}-${theme}-${width}-voice-failure`;
    if (width >= 600) assert.equal(view.popoverWidth, Math.min(280, width - 32), `${label}: popover width`);
    else assert.ok(view.lines <= 2, `${label}: narrow failure is at most two lines`);
    if (width >= 600) assert.ok(view.left >= 16 && view.right <= width - 16, `${label}: inset 16 px: ${JSON.stringify(view)}`);
    else assert.ok(view.left >= 0 && view.right <= width, `${label}: narrow status stays in viewport`);
    assert.equal(view.overflowWrap, 'normal'); assert.equal(view.wordBreak, 'normal'); assert.equal(view.hyphens, 'auto');
    assert.equal(view.overlapPx, 0, `${label}: first bubble clear`);
    assert.deepEqual(await boxes(page, railBoxes), before, `${label}: 0 px shift`);
    const values = { ...view, shiftPx: 0 }; await evidence('F5', page, label, values); t.diagnostic(`PASS F5 ${label}: ${JSON.stringify(values)}`);
  }
});

// F8 investigation: safeguards.test.js:26 ends its stub SSE response. The live
// handlers.js events() stream stays open, so pause must keep its Connected status.
test('AIT-186 F8: purpose pause keeps Connected with the real open event stream', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await voiceScene(page, locale, theme, width);
    const before = await boxes(page, [...railBoxes, '.display-foot', '.status']);
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'purpose' } }));
    await settle(page);
    const view = await shadow(page, c => {
      const root = c.shadowRoot;
      return { footer: root.querySelector('.status__label').textContent, connected: root.querySelector('.status').hasAttribute('data-connected'),
        paused: c.session.paused, reason: c.session.pauseReason, composer: root.querySelector('.purpose-pause-copy').textContent,
        railText: root.querySelector('.voice-state').textContent };
    });
    const label = `${locale}-${theme}-${width}-purpose-pause-live-stream`;
    assert.equal(view.footer, locale === 'de' ? 'Verbunden' : 'Connected'); assert.equal(view.connected, true);
    assert.equal(view.paused, true); assert.equal(view.reason, 'purpose'); assert.equal(view.railText, '');
    assert.deepEqual(await boxes(page, [...railBoxes, '.display-foot', '.status']), before, `${label}: 0 px shift`);
    const values = { ...view, shiftPx: 0, cause: 'finite SSE fixture at test/browser/safeguards.test.js:26; no production fix' };
    await evidence('F8', page, label, values); t.diagnostic(`PASS F8 ${label}: ${JSON.stringify(values)}`);
  }
});

// Round 2 exercises the real HostSurface ledger path. Drive its 15 s cadence
// explicitly; application event debouncing still runs normally, with no sleeps.
test('AIT-186 r2: F2 fast ledger settlement, F6 session pause and AIT-174 purpose pause, 390/1440 L/D DE/EN', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window), fetch = window.fetch.bind(window);
    globalThis.r2Polls = new Map();
    window.setInterval = (fn, ms, ...args) => {
      const id = interval(fn, ms, ...args); if (ms === 15_000) globalThis.r2Polls.set(id, fn); return id;
    };
    window.clearInterval = id => { globalThis.r2Polls.delete(id); clear(id); };
    window.fetch = (url, options = {}) => {
      const c = document.querySelector('aithema-session'), path = new URL(url, location.href).pathname;
      if ((options.method ?? 'GET') === 'GET' && path === `/api/sessions/${c.session.id}/credits`) {
        globalThis.r2CreditReads++;
        return Promise.resolve(Response.json({ exhausted: false, reconciling: false,
          balance: { owner: { limitMicro: 5_000_000, availableMicro: 4_250_000, committedMicro: 750_000 } } }));
      }
      if ((options.method ?? 'GET') === 'GET' && path === `/api/sessions/${c.session.id}`) return Promise.resolve(Response.json(c.session));
      return fetch(url, options);
    };
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      const { voiceEvents } = await import('/packages/core/src/live-voice.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true }]));
      session.transcript = [{ id: 'r2-user', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
      globalThis.r2CreditReads = 0;
      c.configure({ copy, session, host: { library: true, credits: true }, voicePresentation: manifest.presentation,
        voiceClient: { manifest, async start({ callId }) {
          const events = voiceEvents(); globalThis.r2Identity = { callId, providerSessionId: 'r2-provider' };
          return { ...globalThis.r2Identity, events, async setInput() {}, async setOutput() {}, async updateContext() {},
            async close() { events.end(); throw new Error('terminal lost'); } };
        } } });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy); scrollTo(0, 0);
      c.shadowRoot.querySelector('.voice-start').click();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    await frame();
    const before = await boxes(page, [...railBoxes, '.display-foot', '.status']);
    await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click()); await frame();
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-call-reconciling')), true);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), locale === 'de'
      ? 'Anruf beendet. Kosten werden noch abgeglichen.' : 'Call ended. Costs are still being reconciled.');
    assert.deepEqual(await boxes(page, [...railBoxes, '.display-foot', '.status']), before, `${label}: F2 hangup 0 px`);
    await evidence('F2', page, `${label}-reconciling`, { shiftPx: 0, ledgerAlwaysFalse: true, lostTerminal: true });
    await page.evaluate(() => {
      const c = document.querySelector('aithema-session'), label = c.shadowRoot.querySelector('.voice-state');
      globalThis.r2EndedWrites = 0;
      globalThis.r2Observer?.disconnect();
      globalThis.r2Observer = new MutationObserver(() => {
        if (label.textContent === (c.session.locale === 'de' ? 'Anruf beendet.' : 'Call ended.')) globalThis.r2EndedWrites++;
      });
      globalThis.r2Observer.observe(label, { childList: true, characterData: true, subtree: true });
      c.receive({ type: 'voice.state', data: { ...globalThis.r2Identity, state: 'closing' } });
      for (const poll of globalThis.r2Polls.values()) poll();
    });
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-call-reconciling'));
    await frame();
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), locale === 'de' ? 'Anruf beendet.' : 'Call ended.');
    await page.evaluate(() => document.querySelector('aithema-session').receive({ type: 'voice.state', data: { ...globalThis.r2Identity, state: 'ended' } }));
    await frame();
    assert.equal(await page.evaluate(() => globalThis.r2EndedWrites), 1, `${label}: F2 exactly one ended announcement`);
    assert.deepEqual(await boxes(page, [...railBoxes, '.display-foot', '.status']), before, `${label}: F2 settlement 0 px`);
    await evidence('F2', page, `${label}-settled`, { shiftPx: 0, endedAnnouncements: 1, ledgerAlwaysFalse: true, lostTerminal: true });
    const overview = await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent);
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } })); await frame();
    const paused = await shadow(page, c => ({ readiness: c.shadowRoot.querySelector('.readiness').style.visibility,
      composer: c.shadowRoot.querySelector('.composer-reason').textContent, footer: c.shadowRoot.querySelector('.status__label').textContent,
      overview: c.shadowRoot.querySelector('.notice').textContent }));
    assert.equal(paused.readiness, ''); assert.equal(paused.composer, locale === 'de' ? 'Gespräch pausiert' : 'Conversation paused');
    assert.equal(paused.footer, locale === 'de' ? 'Verbunden' : 'Connected'); assert.equal(paused.overview, overview);
    assert.deepEqual(await boxes(page, [...railBoxes, '.display-foot', '.status']), before, `${label}: F6 pause 0 px`);
    await evidence('F6', page, `${label}-session-pause`, { ...paused, shiftPx: 0 });
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'purpose' } })); await frame();
    const purpose = await shadow(page, c => ({ readiness: getComputedStyle(c.shadowRoot.querySelector('.readiness')).visibility,
      assessment: c.session.understanding.inputRevision, copyVisible: !c.shadowRoot.querySelector('.purpose-pause-copy').hidden,
      footer: c.shadowRoot.querySelector('.status__label').textContent }));
    assert.equal(purpose.readiness, 'hidden'); assert.equal(purpose.assessment, null); assert.equal(purpose.copyVisible, true);
    assert.equal(purpose.footer, locale === 'de' ? 'Verbunden' : 'Connected');
    assert.deepEqual(await boxes(page, [...railBoxes, '.display-foot', '.status']), before, `${label}: AIT-174 purpose pause 0 px`);
    await evidence('AIT-174', page, `${label}-purpose-pause`, { ...purpose, shiftPx: 0, reference: '93ac509' });
    t.diagnostic(`PASS r2 ${evidenceCommit} ${label}: F2 false-first/lost-terminal settled exactly once; F6 session pause retained; AIT-174 purpose readiness hidden; 0 px`);
  }
});
