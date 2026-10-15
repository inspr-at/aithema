// AIT-188: Tick's binding follow-ups. Viewport evidence only, remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, settle, boxes, evidenceCommit } from './start2-display-helpers.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-tick-followups-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
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
async function scene(page, locale, theme, width) {
  await page.setViewport({ width, height: width < 600 ? 844 : 900 }); await page.select('#theme', theme);
  await page.evaluate(async locale => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale;
    c.configure({ copy, session, host: { library: true } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    scrollTo(0, 0);
  }, locale);
  await settle();
}
async function evidence(finding, page, label, values) {
  const root = process.env.AITHEMA_EVIDENCE_DIR;
  if (root) {
    const dir = join(root, finding); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(dir, `${label}.json`), JSON.stringify({ head: evidenceCommit, finding, label, ...values, pass: true }, null, 2));
  }
}

async function voiceScene(page, locale, theme, width) {
  await scene(page, locale, theme, width);
  await page.evaluate(async locale => {
    const { [locale]: pauseCopy } = await import(`/packages/ui/src/i18n/${locale}.js`); globalThis.pauseCopy = pauseCopy;
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
  await settle();
}
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function metrics(page) {
  return shadow(page, c => {
    const r = c.shadowRoot, b = r.querySelector('.composer').getBoundingClientRect(), f = r.querySelector('.display-foot').getBoundingClientRect();
    const v = visualViewport, top = v?.offsetTop ?? 0, bottom = top + (v?.height ?? innerHeight);
    const action = r.querySelector('.purpose-new'), a = action.getBoundingClientRect();
    const pauses = [...r.querySelectorAll('*')].filter(n => !n.closest('style, [aria-hidden="true"], .sr-only, .visually-hidden, .features') && getComputedStyle(n).visibility === 'visible' && n.getClientRects().length)
      .filter(n => [...n.childNodes].some(t => t.nodeType === Node.TEXT_NODE && /pausiert|paused/iu.test(t.textContent)));
    return { composer: { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom },
      viewport: { top, bottom }, footerTop: f.top, inViewport: b.top >= top && b.bottom <= bottom && b.bottom <= f.top,
      newVisible: !action.hidden && a.top >= top && a.bottom <= bottom && a.bottom <= f.top,
      pauseElements: pauses.length, pauseTextElements: pauses.map(n => ({ className: n.className, text: n.textContent })), pausesInComposer: pauses.every(n => n.closest('.composer-shell')),
      focused: r.activeElement?.id, transcriptHeight: r.querySelector('.transcript-shell').clientHeight };
  });
}
async function record(t, finding, page, label, values) {
  await evidence(finding, page, label, values);
  const line = `PASS ${finding} ${evidenceCommit} ${label}: ${JSON.stringify(values)}`;
  t.diagnostic(line);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(process.env.AITHEMA_EVIDENCE_DIR, finding, 'pass-lines.txt'), line + '\n');
  }
}
test('AIT-188 L2: phone composer dock, focus and keyboard viewport, idle/call/both pauses DE/EN L/D', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await page.setViewport({ width, height: width === 393 ? 852 : 844 }); await frame(page);
    const baseline = (await metrics(page)).composer;
    for (const state of ['idle', 'in-call', 'purpose-pause', 'session-pause']) {
      if (state === 'session-pause') { await voiceScene(page, locale, theme, width); await page.setViewport({ width, height: width === 393 ? 852 : 844 }); }
      if (state === 'in-call') await page.evaluate(() => globalThis.tickRail.start());
      if (state === 'purpose-pause' || state === 'session-pause') {
        await shadow(page, (c, state) => c.receive({ seq: c.session.seq + 1, type: 'session.paused',
          data: { paused: true, ...(state === 'purpose-pause' ? { reason: 'purpose' } : {}) } }), state);
      }
      await frame(page);
      const view = await metrics(page), label = `${locale}-${theme}-${width}-${state}`;
      assert.equal(view.inViewport, true, `${label}: composer box in viewport ${JSON.stringify(view)}`);
      assert.deepEqual(view.composer, baseline, `${label}: typing/pause shift 0 px`);
      if (state === 'purpose-pause') assert.equal(view.newVisible, true, `${label}: New conversation in viewport`);
      await record(t, 'L2', page, label, { ...view, shiftPx: 0 });
    }
    // Reconfigure an unpaused scene, focus by pointer, then shrink the visible
    // viewport as a phone keyboard does. No real OS keyboard is claimed here.
    await voiceScene(page, locale, theme, width);
    await page.click('aithema-session >>> textarea');
    await page.setViewport({ width, height: 480 }); await frame(page);
    await page.keyboard.type(locale === 'de' ? 'Mein Vorhaben' : 'My project');
    const keyboard = await metrics(page);
    assert.equal(keyboard.inViewport, true, `${locale}/${theme}/${width}: keyboard does not cover input ${JSON.stringify(keyboard)}`);
    assert.equal(keyboard.focused, 'message');
    await page.keyboard.press('Tab');
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'attach');
    await record(t, 'L2', page, `${locale}-${theme}-${width}-keyboard`, keyboard);
  }
});

test('AIT-188 L1: visual drafts enabled, stage retains pre-pause text and pause said once, DE/EN L/D phone/desktop', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const reason of ['purpose', 'session']) {
    await voiceScene(page, locale, theme, width);
    await shadow(page, c => {
      const session = structuredClone(c.session);
      session.featureMatrix.best.html = { available: true };
      session.conceptVisualKind = 'html';
      session.conceptCost = { maxMicro: 100_000 };
      c.configure({ copy: globalThis.pauseCopy, session, host: { library: true } });
    });
    await frame(page);
    const stage = await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').innerText);
    assert.doesNotMatch(stage, /nicht eingerichtet|not set up|not configured/iu, 'fixture exercises enabled visual drafts');
    const before = await boxes(page, ['.concept-bar', '.composer', '.display-foot']);
    await shadow(page, (c, reason) => c.receive({ seq: c.session.seq + 1, type: 'session.paused',
      data: { paused: true, ...(reason === 'purpose' ? { reason } : {}) } }), reason);
    await frame(page);
    const afterStage = await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').innerText), view = await metrics(page);
    const label = `${locale}-${theme}-${width}-${reason}-pause`;
    assert.equal(afterStage, stage, `${label}: stage keeps pre-pause text`);
    assert.equal(view.pauseElements, 1, `${label}: exactly one pause text ${JSON.stringify(view)}`);
    assert.equal(view.pausesInComposer, true);
    assert.deepEqual(await boxes(page, ['.concept-bar', '.composer', '.display-foot']), before, `${label}: shift 0 px`);
    await record(t, 'L1', page, label, { ...view, stage, afterStage, shiftPx: 0 });
  }
});
