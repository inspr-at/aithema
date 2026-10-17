// AIT-188: Tick's binding follow-ups. Viewport evidence only, remote runner only.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { pausedOverview } from '../fixtures/pause-overview.js';
import { startChild } from '../helpers.js';
import { shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

// Device capabilities are configured before navigation. Resizes keep that
// exact configuration: changing hasTouch/isMobile would reload and lose focus.
// Desktop resizes use metrics alone because resetting touch emulation would
// discard the explicit native fine pointer on headless Linux.
async function setViewport(page, viewport) {
  if (page.phoneTouch) {
    const device = page.viewport();
    assert.equal(device.hasTouch, true, 'phone touch emulation must already be configured');
    assert.equal(device.isMobile, false, 'resizing must not change mobile emulation');
    return page.setViewport({ ...device, ...viewport });
  }
  page.metricsSession ??= await page.createCDPSession();
  return page.metricsSession.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    screenOrientation: viewport.isLandscape ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' },
  });
}

// Share the host across every test. A page is reused while device capabilities
// match; desktop's native fine pointer still needs its own launch configuration.
let host, currentFixture, cleanup;
after(() => cleanup?.());
async function hostForFile() {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-pause-phone-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  cleanup = async () => { await currentFixture?.browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); };
  return { demo, hostConfig: await fetch(new URL('/demo/config', demo.url)).then(response => response.json()) };
}
async function fixture(t, touch = true) {
  const { demo, hostConfig } = await (host ??= hostForFile());
  if (currentFixture?.touch === touch) {
    const { page, browser } = currentFixture;
    await page.goto('about:blank');
    const session = await page.createCDPSession();
    try { await session.send('Storage.clearDataForOrigin', { origin: new URL(demo.url).origin, storageTypes: 'all' }); }
    finally { await session.detach(); }
    const cookies = await browser.cookies();
    if (cookies.length) await browser.browser().defaultBrowserContext().deleteCookie(...cookies);
    page.holdSnapshot = null; page.reloadSession = null; page.replaySessionId = null;
    await setViewport(page, { width: 800, height: 600 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await shadow(page, c => { globalThis.tickSeed = c.session; });
    return page;
  }
  await currentFixture?.browser.close();
  const browser = await browserForFile(touch ? {} : { defaultViewport: null, args: [
    // Preserve real desktop fine-pointer media capabilities; switching fixture
    // modes replaces Chrome, while serial fixtures in the same mode reuse it.
    '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2,maxTouchPoints=0',
  ] });
  const page = await browser.newPage();
  currentFixture = { touch, browser, page };
  page.phoneTouch = touch;
  if (touch) await page.setViewport({ width: 800, height: 600, hasTouch: true, isMobile: false });
  else await setViewport(page, { width: 800, height: 600 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const path = new URL(request.url()).pathname;
    if (page.holdSnapshot && request.method() === 'GET' && path === `/api/sessions/${page.snapshotId}`) {
      const hold = page.holdSnapshot; hold.resolve(); await hold.release.promise;
    }
    // Replayed voice snapshots reload through a host that still binds a local fake client.
    if (page.reloadSession && path === '/demo/config') return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...hostConfig, voiceMode: 'fake' }) });
    if (page.reloadSession && request.method() === 'GET' && path === `/api/sessions/${page.reloadSession.id}`) {
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(page.reloadSession) });
    }
    // Replayed events own this UI's state, including its snapshot reads. A late
    // pause refresh from the real no-provider server can otherwise overwrite
    // the next scene's enabled text verdict after configure resets its cursor.
    if (page.replaySessionId && request.method() === 'GET' && path === `/api/sessions/${page.replaySessionId}`) {
      const session = await shadow(page, c => c.session);
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    }
    if (path.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    // Server-scenario events are replayed into this isolated UI host. Its empty
    // demo stream stays genuinely open; it does not own the replay's cursor.
    if (path.endsWith('/events')) return request.continue({ headers: { ...request.headers(), 'last-event-id': '0' } });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.tickSeed = c.session; });
  return page;
}
async function scene(page, locale, theme, width, { reset = true, ready = true } = {}) {
  await setViewport(page, { width, height: width === 393 ? 852 : width < 600 ? 844 : 900 }); await page.select('#theme', theme);
  await page.evaluate(async ({ locale, reset }) => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale;
    if (reset) c.configure({ copy, session, host: { library: true }, voiceClient: {} });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    scrollTo(0, 0);
  }, { locale, reset });
  if (ready) await frame(page);
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
  page.replaySessionId = await shadow(page, c => c.session.id);
  await scene(page, locale, theme, width, { reset: false, ready: false });
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
      voiceClient: globalThis.tickVoiceClient = { manifest, async start({ callId }) {
        const events = voiceEvents();
        return { callId, providerSessionId: 'tick-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
          async close() { events.end(); return { closureConfirmed: false, reconciliationPending: true }; } };
      } } });
    document.documentElement.lang = locale;
  }, locale);
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
  await frame(page);
}
const frame = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
async function metrics(page) {
  return shadow(page, c => {
    const r = c.shadowRoot, b = r.querySelector('.composer').getBoundingClientRect(), f = r.querySelector('.display-foot').getBoundingClientRect();
    const v = visualViewport, top = v?.offsetTop ?? 0, bottom = top + (v?.height ?? innerHeight);
    const action = r.querySelector('.purpose-new'), a = action.getBoundingClientRect();
    const pauses = [...r.querySelectorAll('*')].filter(n => !n.closest('style, [aria-hidden="true"], .sr-only, .visually-hidden, .features') && getComputedStyle(n).visibility === 'visible' && n.getClientRects().length)
      .filter(n => [...n.childNodes].some(t => t.nodeType === Node.TEXT_NODE && /pausiert|paused/iu.test(t.textContent)));
    return { composer: { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom },
      viewport: { top, bottom }, footerTop: f.top, footer: r.querySelector('.status__label').textContent, connected: r.querySelector('.status').hasAttribute('data-connected'), inViewport: b.top >= top && b.bottom <= bottom && b.bottom <= (f.height ? f.top : bottom),
      newVisible: !action.hidden && a.top >= top && a.bottom <= bottom && a.bottom <= (f.height ? f.top : bottom),
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
async function clickComposer(t, page, label) {
  try {
    // Locator keeps its enabled/viewport/two-frame geometry checks. Also require
    // the actual composer input to own the point that the pointer will click.
    await page.locator('aithema-session >>> .composer #message').filter(input => {
      const b = input.getBoundingClientRect();
      return input.getRootNode().elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === input;
    }).click();
  } catch (error) {
    const click = await shadow(page, async c => {
      const r = c.shadowRoot, input = r.querySelector('#message');
      const rect = () => { const b = input.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
      const before = rect(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = rect(), point = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
      const describe = n => n ? { tag: n.localName, id: n.id, className: n.className } : null;
      const session = c.session;
      return { point, hit: describe(r.elementFromPoint(point.x, point.y)), documentHit: describe(document.elementFromPoint(point.x, point.y)),
        input: { ...describe(input), disabled: input.disabled, inert: Boolean(input.closest('[inert]')), visibility: getComputedStyle(input).visibility, before, after },
        session: { seq: session.seq, paused: session.paused, featureMatrix: session.featureMatrix }, viewport: { width: innerWidth, height: innerHeight },
        animations: r.getAnimations().map(a => ({ state: a.playState, timing: a.effect.getComputedTiming() })) };
    });
    t.diagnostic(`FAIL L2 click ${label}: ${JSON.stringify(click)}`);
    if (process.env.AITHEMA_EVIDENCE_DIR) {
      const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'L2'); await mkdir(dir, { recursive: true });
      const name = `click-failure-${label.replaceAll('/', '-')}`;
      await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false, captureBeyondViewport: false });
      await writeFile(join(dir, `${name}.json`), JSON.stringify({ head: evidenceCommit, label, ...click, pass: false }, null, 2));
    }
    throw error;
  }
}

test('AIT-188 L2: phone composer dock, focus and keyboard viewport, idle/call/both pauses DE/EN L/D', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await setViewport(page, { width, height: width === 393 ? 852 : 844 }); await frame(page);
    assert.ok((await metrics(page)).transcriptHeight >= 320, 'phone keeps a usable transcript viewport above the dock');
    const baseline = (await metrics(page)).composer;
    for (const state of ['idle', 'in-call', 'purpose-pause', 'session-pause']) {
      if (state === 'session-pause') { await voiceScene(page, locale, theme, width); await setViewport(page, { width, height: width === 393 ? 852 : 844 }); }
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
    assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true, 'touch emulation is configured before focus');
    await shadow(page, c => {
      const input = c.shadowRoot.querySelector('textarea');
      globalThis.keyboardFocusProbe = { input, blurs: 0 };
      input.addEventListener('blur', () => { globalThis.keyboardFocusProbe.blurs++; });
    });
    // The scene was rebuilt: click only after its input is enabled and stable.
    await clickComposer(t, page, `${locale}/${theme}/${width}`);
    assert.equal((await metrics(page)).focused, 'message', 'pointer focuses the composer before keyboard resize');
    await setViewport(page, { width, height: 480 }); await frame(page);
    const continuity = await shadow(page, c => ({
      sameInput: globalThis.keyboardFocusProbe.input === c.shadowRoot.querySelector('textarea'),
      blurs: globalThis.keyboardFocusProbe.blurs,
      focused: c.shadowRoot.activeElement?.id,
    }));
    assert.deepEqual(continuity, { sameInput: true, blurs: 0, focused: 'message' }, 'keyboard resize retains the input and focus without a blur');
    await page.keyboard.type(locale === 'de' ? 'Mein Vorhaben' : 'My project');
    const keyboard = await metrics(page);
    assert.equal(keyboard.inViewport, true, `${locale}/${theme}/${width}: keyboard does not cover input ${JSON.stringify(keyboard)}`);
    assert.equal(keyboard.focused, 'message');
    await page.keyboard.press('Tab');
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'attach');
    await record(t, 'L2', page, `${locale}-${theme}-${width}-keyboard`, keyboard);
    await setViewport(page, { width, height: 844 }); await frame(page);
    await page.evaluate(() => {
      globalThis.nativeViewport = visualViewport;
      const viewport = new EventTarget(); Object.assign(viewport, { height: 440, offsetTop: 30, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      // Reconnect while the visual viewport differs from the layout viewport.
      const c = document.querySelector('aithema-session'); c.remove(); document.querySelector('main').append(c);
      c.shadowRoot.querySelector('textarea').focus({ preventScroll: true });
      viewport.dispatchEvent(new Event('resize'));
    }); await frame(page);
    const overlay = await metrics(page);
    assert.equal(overlay.inViewport, true, `overlay keyboard: ${JSON.stringify(overlay)}`);
    assert.equal(overlay.focused, 'message');
    await record(t, 'L2', page, `${locale}-${theme}-${width}-overlay-keyboard`, overlay);
    await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.nativeViewport }); dispatchEvent(new Event('resize')); });
  }
});

// Hold the pause-triggered snapshot until the next replay scene is mounted.
// Before snapshot isolation, releasing it let the real demo's consent/provider
// verdict disable #message: elementFromPoint still hit the input; no animations.
test('AIT-194: delayed pause snapshot must not disable the next replay composer', { timeout: 45_000 }, async t => {
  const page = await fixture(t);
  await voiceScene(page, 'de', 'dark', 393);
  page.snapshotId = await shadow(page, c => c.session.id);
  const hold = page.holdSnapshot = { ...Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => hold.release.resolve());
  await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }));
  await hold.promise;
  page.holdSnapshot = null;
  await voiceScene(page, 'de', 'dark', 393);
  await page.evaluate(() => {
    globalThis.pauseSnapshotApplied = new Promise(resolve => document.querySelector('aithema-session')
      .addEventListener('aithema-features', resolve, { once: true }));
  });
  hold.release.resolve();
  await page.evaluate(() => globalThis.pauseSnapshotApplied.then(() => true));
  await clickComposer(t, page, 'delayed-pause-snapshot');
  assert.equal((await metrics(page)).focused, 'message', 'a real pointer focuses the next replay composer');
});

test('AIT-188 L1: visual drafts enabled, stage retains pre-pause text and pause said once, DE/EN L/D phone/desktop', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const reason of ['purpose', 'session']) {
    await voiceScene(page, locale, theme, width);
    await shadow(page, c => {
      const session = structuredClone(c.session);
      session.featureMatrix.best.html = { available: true };
      session.visualsBound = true; // This scene binds drafts independently of the active preset verdict.
      session.conceptVisualKind = 'html';
      session.conceptCost = { maxMicro: 100_000 };
      c.configure({ copy: globalThis.pauseCopy, session, host: { library: true }, voiceClient: globalThis.tickVoiceClient });
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

test('AIT-189: reloaded purpose/session pauses match unpaused stage, visual drafts on/off, DE/EN L/D 390/1440', { timeout: 120_000 }, async t => {
  const page = await fixture(t), seed = await shadow(page, () => globalThis.tickSeed);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const enabled of [true, false]) for (const reason of ['purpose', 'session']) {
    page.reloadSession = null;
    await shadow(page, (c, seed) => { globalThis.tickSeed = seed; }, seed);
    // Use the same visual-drafts scene as AIT-188 L1, including its disabled verdict.
    await voiceScene(page, locale, theme, width);
    await shadow(page, (c, enabled) => {
      const session = structuredClone(c.session);
      session.featureMatrix.best.html = enabled ? { available: true } : { available: false, reason: 'not configured' };
      session.visualsBound = true; // Keep the configured host while varying its active preset verdict.
      session.conceptVisualKind = 'html'; session.conceptCost = { maxMicro: 100_000 };
      c.configure({ copy: globalThis.pauseCopy, session, host: { library: true }, voiceClient: globalThis.tickVoiceClient });
    }, enabled);
    await frame(page);
    const stage = await shadow(page, c => c.shadowRoot.querySelector('.concept-rail').innerText);
    assert.ok(stage.trim(), 'the non-paused reference has visible stage text');
    assert.equal(/nicht eingerichtet|not set up|not configured/iu.test(stage), !enabled, 'fixture exercises both visual-draft verdicts');
    const selectors = ['.concept-bar', '.composer', '.display-foot'];
    const before = await boxes(page, selectors);
    await shadow(page, (c, reason) => c.receive({ seq: c.session.seq + 1, type: 'session.paused',
      data: { paused: true, ...(reason === 'purpose' ? { reason } : {}) } }), reason);
    await frame(page);
    const livePause = await boxes(page, selectors);
    assert.deepEqual(livePause, before, 'live pause shift 0 px');
    page.reloadSession = await shadow(page, c => c.session);
    // A real server snapshot gates a configured visual with session paused while
    // carrying its underlying verdict for presentation only (server-tested).
    if (enabled) page.reloadSession.featureMatrix.best.html = { available: false, reason: 'session paused',
      unpaused: page.reloadSession.featureMatrix.best.html };
    await page.evaluate(async locale => {
      const { localeKey, remember } = await import('/demo/page-preferences.js'); remember(localeKey, locale);
    }, locale);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.paused);
    await frame(page);
    const label = `${locale}-${theme}-${width}-drafts-${enabled ? 'on' : 'off'}-${reason}-pause-reloaded`;
    const value = await shadow(page, c => {
      const r = c.shadowRoot, rail = r.querySelector('.concept-rail');
      const text = r.querySelector('.concept-activity').hidden ? r.querySelector('.concept-request') : r.querySelector('.concept-activity-text');
      const b = text.getBoundingClientRect(), style = getComputedStyle(text);
      return { stage: rail.innerText, text: text.innerText, textVisible: !text.hidden && style.visibility === 'visible' && style.opacity !== '0'
        && b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth,
        actionDisabled: r.querySelector('.concept-request').disabled, paused: c.session.paused, pauseReason: c.session.pauseReason,
        locale: c.session.locale, theme: document.querySelector('#theme').value };
    });
    assert.equal(value.stage, stage, `${label}: reloaded stage equals non-paused text`);
    assert.ok(value.text.trim(), `${label}: never icon-only`);
    assert.equal(value.textVisible, true, `${label}: stage text visible in viewport`);
    assert.equal(value.actionDisabled, true, `${label}: pause disables generation`);
    assert.equal(value.paused, true); assert.equal(value.pauseReason === 'purpose', reason === 'purpose');
    assert.equal(value.locale, locale); assert.equal(value.theme, theme);
    assert.deepEqual(await boxes(page, selectors), livePause, `${label}: reload shift 0 px`);
    const view = await metrics(page);
    assert.equal(view.pauseElements, 1, `${label}: pause said exactly once`);
    assert.equal(view.pausesInComposer, true, `${label}: pause stays in composer`);
    assert.equal(view.inViewport, true, `${label}: composer remains in viewport`);
    await record(t, 'AIT-189', page, label, { ...value, nonPausedStage: stage, ...view, shiftPx: 0 });
  }
});

test('AIT-188 V1: settled project overview replaces the placeholder after purpose pause, DE/EN L/D phone/desktop', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) {
    const scenario = await pausedOverview(locale);
    for (const theme of ['light', 'dark']) for (const width of [390, 393, 1440]) {
      await scene(page, locale, theme, width);
      await setViewport(page, { width, height: width === 393 ? 852 : width === 390 ? 844 : 900 });
      await page.evaluate(async ({ before, locale }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        document.querySelector('aithema-session').configure({ copy, session: { ...before, id: globalThis.tickSeed.id }, voiceClient: globalThis.tickVoiceClient });
      }, { before: scenario.before, locale }); await frame(page);
      // configure() opens the stream asynchronously. Establish readiness before
      // the settlement replay so the assertion below still checks it stays open.
      await page.waitForFunction(() => document.querySelector('aithema-session')?.shadowRoot
        .querySelector('.status')?.hasAttribute('data-connected'), { polling: 50, timeout: 5_000 })
        .catch(cause => { throw new Error('AIT-188 V1: paused overview event stream did not connect within 5 s', { cause }); });
      const baseline = (await metrics(page)).composer;
      await shadow(page, (c, events) => { for (const event of events) c.receive({ ...event, sessionId: c.session.id }); }, scenario.events);
      await frame(page);
      const overview = await shadow(page, c => ({ summary: c.shadowRoot.querySelector('.summary-text').textContent,
        visible: !c.shadowRoot.querySelector('.summary').hidden, notice: c.shadowRoot.querySelector('.notice').textContent,
        placeholder: globalThis.tickSeed.understanding.summary }));
      assert.equal(overview.visible, true);
      assert.equal(overview.summary, scenario.after.understanding.summary);
      assert.doesNotMatch(overview.notice, /Nach dem ersten Satz|After the first sentence|wird aktualisiert|Updating/u);
      assert.deepEqual((await metrics(page)).composer, baseline, 'analysis settlement moves composer 0 px');
      if (width < 600) await shadow(page, c => {
        const r = c.shadowRoot, aside = r.querySelector('.understanding').getBoundingClientRect();
        scrollTo(0, scrollY + aside.top - r.querySelector('.band').getBoundingClientRect().height - 12);
      });
      await frame(page);
      const view = await metrics(page);
      assert.equal(view.connected, true, 'overview keeps open event stream');
      assert.equal(view.inViewport, true, 'overview reading keeps phone composer in view');
      assert.deepEqual(view.composer, baseline, 'overview scrolling moves composer 0 px');
      await record(t, 'V1', page, `${locale}-${theme}-${width}-settled-overview`, { ...view, ...overview,
        assessments: scenario.assessments, offTopicTurns: scenario.offTopicTurns, shiftPx: 0 });
    }
  }
});


async function backdropMetrics(page) {
  return shadow(page, c => {
    const r = c.shadowRoot, dock = r.querySelector('.composer-dock').getBoundingClientRect();
    const points = [[10, dock.bottom + 6], [dock.right + 8, dock.top + dock.height / 2]];
    return { points, hits: points.map(([x, y]) => r.elementFromPoint(x, y)?.className),
      dock: { top: dock.top, bottom: dock.bottom, right: dock.right },
      paper: getComputedStyle(r.querySelector('.workspace')).getPropertyValue('--aithema-paper').trim(),
      background: r.querySelector('.phone-dock-backdrop') ? getComputedStyle(r.querySelector('.phone-dock-backdrop')).backgroundColor : null };
  });
}
async function overlayKeyboard(page) {
  await page.evaluate(() => {
    globalThis.nativeViewport = visualViewport;
    const viewport = new EventTarget(); Object.assign(viewport, { height: 440, offsetTop: 30, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const c = document.querySelector('aithema-session'); c.remove(); document.querySelector('main').append(c);
    c.shadowRoot.querySelector('textarea').focus({ preventScroll: true });
    viewport.dispatchEvent(new Event('resize'));
  }); await frame(page);
}
async function closeOverlay(page) {
  await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.nativeViewport }); dispatchEvent(new Event('resize')); });
  await frame(page);
}
test('AIT-188 L2a: opaque phone dock backdrop hits in gaps and gutters, all states L/D 390/393', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, 'de', theme, width);
    await setViewport(page, { width, height: width === 393 ? 852 : 844 });
    for (const state of ['idle', 'purpose-pause', 'session-pause', 'resized-keyboard', 'overlay-keyboard']) {
      if (state !== 'idle') { await voiceScene(page, 'de', theme, width); await setViewport(page, { width, height: width === 393 ? 852 : 844 }); }
      if (state.endsWith('pause')) await shadow(page, (c, state) => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, ...(state === 'purpose-pause' ? { reason: 'purpose' } : {}) } }), state);
      if (state === 'resized-keyboard') { await page.click('aithema-session >>> textarea'); await setViewport(page, { width, height: 480 }); }
      if (state === 'overlay-keyboard') await overlayKeyboard(page);
      await frame(page);
      const values = await backdropMetrics(page), label = `de-${theme}-${width}-${state}`;
      assert.deepEqual(values.hits, ['phone-dock-backdrop', 'phone-dock-backdrop'], `${label}: backdrop hit tests ${JSON.stringify(values)}`);
      assert.match(values.background, /^rgb\(/u, 'backdrop is opaque');
      await record(t, 'r2-backdrop', page, label, values);
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'r2-backdrop');
        await page.screenshot({ path: join(dir, `${label}-gap.png`), clip: { x: 0, y: values.dock.bottom, width, height: 12 }, captureBeyondViewport: false });
        await page.screenshot({ path: join(dir, `${label}-gutter.png`), clip: { x: 0, y: values.dock.top - 12, width: 20, height: values.dock.bottom - values.dock.top + 24 }, captureBeyondViewport: false });
      }
      if (state === 'overlay-keyboard') await closeOverlay(page);
    }
  }
});
test('AIT-188 L2b: keyboard hides footer synchronously and leaves 100px transcript in both modes', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 393]) for (const mode of ['resized', 'overlay']) {
    await voiceScene(page, 'de', theme, width);
    await setViewport(page, { width, height: width === 393 ? 852 : 844 });
    await page.click('aithema-session >>> textarea');
    if (mode === 'resized') await setViewport(page, { width, height: 480 }); else await overlayKeyboard(page);
    // Dispatch in the current task and inspect before a frame or observer can run.
    const synchronous = await shadow(page, c => {
      (visualViewport ?? window).dispatchEvent(new Event('resize'));
      return getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display;
    });
    assert.equal(synchronous, 'none', 'footer hides in the keyboard resize task');
    await frame(page);
    const view = await metrics(page);
    assert.ok(view.transcriptHeight >= 100, `${mode}: transcript >=100px ${JSON.stringify(view)}`);
    assert.equal(view.inViewport, true);
    await record(t, 'r2-keyboard', page, `de-${theme}-${width}-${mode}`, view);
    assert.equal(await shadow(page, c => {
      c.shadowRoot.querySelector('.attach').focus({ preventScroll: true });
      (visualViewport ?? window).dispatchEvent(new Event('resize'));
      return getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display;
    }), 'none', 'footer stays hidden while keyboard remains open after focus moves');
    if (mode === 'overlay') await closeOverlay(page); else { await setViewport(page, { width, height: width === 393 ? 852 : 844 }); await frame(page); }
    assert.notEqual(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display), 'none', 'footer returns when keyboard closes');
  }
});
test('AIT-188 gate1 footer: phone bottom never moves footer above 600px', async t => {
  const page = await fixture(t);
  for (const width of [601, 768, 1440]) {
    await voiceScene(page, 'de', 'light', width);
    const bottom = await shadow(page, c => {
      c.shadowRoot.querySelector('.workspace').style.setProperty('--phone-bottom', '217px');
      return getComputedStyle(c.shadowRoot.querySelector('.display-foot')).bottom;
    });
    assert.equal(bottom, '0px', `desktop/tablet ${width}`);
  }
});
test('AIT-188 gate1 focus: phone overview and transcript controls clear dock and footer', async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, 'de', theme, width);
    const margins = await shadow(page, c => {
      const r = c.shadowRoot, dock = r.querySelector('.composer-dock').getBoundingClientRect(), foot = r.querySelector('.display-foot').getBoundingClientRect();
      return [...r.querySelectorAll('.understanding :is(button,a,[tabindex]), .transcript-shell :is(button,a,[tabindex])')].map(n => ({ name: n.className, margin: parseFloat(getComputedStyle(n).scrollMarginBottom), required: dock.height + foot.height }));
    });
    assert.ok(margins.length > 3);
    for (const m of margins) assert.ok(m.margin >= m.required, `${m.name}: ${JSON.stringify(m)}`);
    await shadow(page, c => c.shadowRoot.querySelector('.export').focus()); await frame(page);
    assert.equal(await shadow(page, c => { const b = c.shadowRoot.querySelector('.export').getBoundingClientRect(), d = c.shadowRoot.querySelector('.composer-dock').getBoundingClientRect(); return b.top >= 0 && b.bottom <= d.top - 12; }), true, 'focused export fully above backdrop');
  }
});
async function noticeMetrics(page) {
  return shadow(page, c => {
    const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), v = shell.getBoundingClientRect(), d = r.querySelector('.composer-dock').getBoundingClientRect();
    const rect = n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    const visible = [...r.querySelectorAll('ol .turn')].find(n => n.getBoundingClientRect().bottom > v.top);
    return { viewport: rect(shell), dockTop: d.top, notice: rect(r.querySelector('.voice-notices')),
      controls: [...r.querySelectorAll('.voice-repeat,.voice-read-text')].map(rect),
      first: visible ? { id: visible.dataset.id, top: visible.getBoundingClientRect().top } : null,
      badge: getComputedStyle(r.querySelector('.transcript-latest')).visibility,
      lastItem: shell.lastElementChild.className, scrollTop: shell.scrollTop, maxScroll: shell.scrollHeight - shell.clientHeight };
  });
}
test('AIT-188 notice option a: last scroll item follows and preserves scrolled-up bubbles 0px, long call DE/EN L/D 390/393', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await shadow(page, c => {
      const session = structuredClone(c.session), text = session.transcript[0].content;
      session.transcript = Array.from({ length: 48 }, (_, i) => ({ id: `long-call-${i}`, role: i % 2 ? 'assistant' : 'user', content: text }));
      c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
    });
    await page.mouse.move(0, 0); await frame(page);
    for (const position of ['following', 'scrolled-up', 'near-bottom']) {
      const following = position === 'following';
      await shadow(page, (c, following) => { const s = c.shadowRoot.querySelector('.transcript-shell'); s.scrollTop = following ? s.scrollHeight : 400; s.dispatchEvent(new Event('scroll')); }, following);
      if (following) { const box = await boxes(page, ['.transcript-shell']); await page.mouse.move(box[0][0] + 60, box[0][1] + box[0][3] - 60); }
      await frame(page); const before = await noticeMetrics(page);
      await page.evaluate(() => globalThis.tickRail.notices.recovered({ userUnconfirmed: true, deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: document.querySelector('aithema-session').session.transcript.at(-1).content }));
      await frame(page); const shown = await noticeMetrics(page);
      assert.equal(shown.lastItem, 'voice-notices', 'notice is last item after transcript list');
      if (following) {
        for (const b of [shown.notice, ...shown.controls]) assert.ok(b.top >= shown.viewport.top && b.bottom <= shown.viewport.bottom && b.bottom <= shown.dockTop - 12, `fully visible notice/controls ${JSON.stringify(shown)}`);
        for (const b of shown.controls) assert.ok(b.height >= 44);
      } else { assert.deepEqual(shown.first, before.first, 'notice appears: first bubble shift 0px'); assert.equal(shown.badge, before.badge, 'notice adds no badge'); }
      await record(t, 'r2-notice', page, `${locale}-${theme}-${width}-${position}`, { ...shown, firstBubbleShift: following ? null : shown.first.top - before.first.top });
      let beforeClear = shown;
      if (position === 'near-bottom') {
        await shadow(page, c => { const s = c.shadowRoot.querySelector('.transcript-shell'); s.scrollTop = s.scrollHeight - s.clientHeight - 20; s.dispatchEvent(new Event('scroll')); });
        await frame(page); beforeClear = await noticeMetrics(page);
      }
      await page.evaluate(() => globalThis.tickRail.notices.clear()); await frame(page); const cleared = await noticeMetrics(page);
      if (!following) assert.deepEqual(cleared.first, beforeClear.first, 'notice removed: first bubble shift 0px');
      else assert.equal(cleared.scrollTop, cleared.maxScroll, 'removed last item settles at bottom');
      await record(t, 'r2-notice', page, `${locale}-${theme}-${width}-${position}-removed`, { ...cleared, firstBubbleShift: following ? null : cleared.first.top - beforeClear.first.top });
    }
  }
});


// R3 uses touch emulation from the first viewport onward. No mouse/pointer is
// introduced: the ordinary row must obey the same last-message rules itself.
test('AIT-188 r3 ordinary row: touch-only call start/end, 24 turns DE/EN L/D 390/393, exact 0px reading shift', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await shadow(page, c => {
      const session = structuredClone(c.session), text = session.transcript[0].content;
      session.transcript = Array.from({ length: 48 }, (_, i) => ({ id: `ordinary-${i}`, role: i % 2 ? 'assistant' : 'user', content: text }));
      // This replay owns a newer cursor than the empty fixture server.
      session.seq++;
      c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
    });
    await frame(page);
    assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0 && matchMedia('(pointer:coarse)').matches), true);
    for (const position of ['following', 'scrolled-up', 'near-bottom']) {
      const following = position === 'following';
      const positionTranscript = () => shadow(page, (c, position) => {
        const s = c.shadowRoot.querySelector('.transcript-shell');
        s.scrollTop = position === 'following' ? s.scrollHeight : position === 'near-bottom' ? s.scrollHeight - s.clientHeight - 20 : 400;
        s.dispatchEvent(new Event('scroll'));
      }, position);
      await positionTranscript(); await frame(page);
      const beforeStart = await noticeMetrics(page);
      assert.ok(beforeStart.controls.every(b => b.height >= 44), 'ordinary row exists before call starts');
      await page.evaluate(() => globalThis.tickRail.start()); await frame(page);
      const started = await noticeMetrics(page);
      assert.ok(started.controls.every(b => b.height === 0), 'ordinary row removed at call start');
      if (following) assert.equal(started.scrollTop, started.maxScroll, 'removed last item settles at bottom');
      else assert.deepEqual(started.first, beforeStart.first, 'call start removes row: first bubble shift 0px');
      await record(t, 'r3-ordinary', page, `${locale}-${theme}-${width}-${position}-call-start`, { ...started, firstBubbleShift: following ? null : started.first.top - beforeStart.first.top });
      await positionTranscript(); await frame(page);
      const beforeEnd = await noticeMetrics(page);
      await page.evaluate(() => {
        const rail = globalThis.tickRail;
        rail.session.events.push({ type: 'ended', callId: rail.session.callId, reason: 'closed' });
      });
      await until(page, () => globalThis.tickRail.session === null); await frame(page);
      const ended = await noticeMetrics(page);
      assert.equal(ended.lastItem, 'voice-notices');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-actions').parentElement.dataset.id), 'ordinary-47', 'ordinary controls belong to the last assistant bubble');
      assert.ok(ended.controls.every(b => b.height >= 44), 'ordinary row returns at call end with 44px targets');
      if (following) {
        for (const b of ended.controls) assert.ok(b.top >= ended.viewport.top && b.bottom <= ended.viewport.bottom && b.bottom <= ended.dockTop - 12, `ordinary row fully visible after render: ${JSON.stringify(ended)}`);
      } else {
        assert.deepEqual(ended.first, beforeEnd.first, 'call end shows row: first bubble shift 0px');
        assert.equal(ended.badge, beforeEnd.badge, 'ordinary row adds no badge');
      }
      await record(t, 'r3-ordinary', page, `${locale}-${theme}-${width}-${position}-call-end`, { ...ended, firstBubbleShift: following ? null : ended.first.top - beforeEnd.first.top });
    }
  }
});

test('AIT-188 r3 keyboard: fine-pointer desktop resize keeps footer', async t => {
  const page = await fixture(t, false);
  await voiceScene(page, 'en', 'light', 500);
  const device = await page.evaluate(() => ({ fine: matchMedia('(pointer:fine)').matches, coarse: matchMedia('(pointer:coarse)').matches, none: matchMedia('(pointer:none)').matches, touchPoints: navigator.maxTouchPoints }));
  t.diagnostic(`desktop device: ${JSON.stringify(device)}`);
  assert.equal(device.fine && device.touchPoints === 0, true, JSON.stringify(device));
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }));
  await setViewport(page, { width: 500, height: 644 }); await frame(page);
  assert.equal(await page.evaluate(() => matchMedia('(pointer:fine)').matches && navigator.maxTouchPoints === 0), true, 'resizing retains native desktop capabilities');
  assert.notEqual(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display), 'none', 'desktop window shrink is not an on-screen keyboard');
});

test('AIT-188 r3 keyboard: touch width/orientation reset and blur never stick footer hidden', async t => {
  const page = await fixture(t);
  await voiceScene(page, 'de', 'dark', 390);
  const footer = () => shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display);
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }));
  await setViewport(page, { width: 390, height: 480 }); await frame(page);
  assert.equal(await footer(), 'none', 'touch keyboard opens');
  await setViewport(page, { width: 500, height: 600, isLandscape: true }); await frame(page);
  assert.notEqual(await footer(), 'none', 'width/orientation establishes a new unobstructed baseline');
  await setViewport(page, { width: 500, height: 400, isLandscape: true }); await frame(page);
  assert.equal(await footer(), 'none', 'keyboard detected against the new baseline');
  await shadow(page, c => c.shadowRoot.querySelector('.fold').focus({ preventScroll: true })); await frame(page);
  assert.notEqual(await footer(), 'none', 'leaving composer clears keyboard state without resize');
  await setViewport(page, { width: 500, height: 600, isLandscape: true }); await frame(page);
  assert.notEqual(await footer(), 'none', 'keyboard closed');
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true })); await frame(page);
  assert.notEqual(await footer(), 'none', 'focus alone cannot reuse a stale height');
  await setViewport(page, { width: 390, height: 600, isLandscape: false }); await frame(page);
  assert.notEqual(await footer(), 'none', 'a short unobstructed portrait viewport keeps its footer too');
});

test('AIT-188 r3 fade: overlay keyboard backdrop has a transparent-to-paper top 12px, L/D 390/393', async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, 'de', theme, width); await overlayKeyboard(page);
    const edge = await shadow(page, c => {
      const r = c.shadowRoot, n = r.querySelector('.phone-dock-backdrop'), b = n.getBoundingClientRect(), d = r.querySelector('.composer-dock').getBoundingClientRect();
      return { top: b.top, dockTop: d.top, mask: getComputedStyle(n).maskImage, background: getComputedStyle(n).backgroundColor };
    });
    assert.equal(edge.dockTop - edge.top, 12, 'fade occupies the gap above composer');
    assert.match(edge.mask, /linear-gradient\(.*rgba\(0, 0, 0, 0\).*rgb\(0, 0, 0\) 12px/u, 'transparent-to-opaque gradient across top 12px');
    await record(t, 'r3-fade', page, `de-${theme}-${width}-overlay-keyboard`, { ...edge, gradientPresent: true, fadePx: 12 });
    if (process.env.AITHEMA_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, 'r3-fade', `de-${theme}-${width}-edge-crop.png`), clip: { x: 0, y: edge.top - 4, width, height: 24 }, captureBeyondViewport: false });
    await closeOverlay(page);
  }
});


test('AIT-188 r3 ordinary return: following after releasing removed-row space shows the next reply controls, touch DE/EN L/D 390/393', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await shadow(page, c => {
      const session = structuredClone(c.session), text = session.transcript[0].content;
      session.transcript = Array.from({ length: 48 }, (_, i) => ({ id: `return-${i}`, role: i % 2 ? 'assistant' : 'user', content: text }));
      session.seq++;
      c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
    }); await frame(page);
    await shadow(page, c => {
      const s = c.shadowRoot.querySelector('.transcript-shell');
      s.scrollTop = 400; s.dispatchEvent(new Event('scroll'));
    }); await frame(page);
    // Real withdrawal erases dependent assistant replies, hiding the ordinary
    // row while reading. Then the person deliberately returns to the bottom.
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'return-0' } })); await frame(page);
    assert.equal((await noticeMetrics(page)).notice.height, 44, 'removed reply action row keeps exactly its 44px reading room');
    await shadow(page, c => {
      const s = c.shadowRoot.querySelector('.transcript-shell');
      s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll'));
    }); await frame(page);
    assert.equal((await noticeMetrics(page)).notice.height, 0, 'following releases removed last-item room');
    await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final',
      data: { id: 'return-reply', role: 'assistant', content: c.session.transcript.find(t => t.role === 'user' && !t.erased).content } })); await frame(page);
    const shown = await noticeMetrics(page);
    for (const b of shown.controls) assert.ok(b.top >= shown.viewport.top && b.bottom <= shown.viewport.bottom && b.bottom <= shown.dockTop - 12, `next ordinary row follows after render: ${JSON.stringify(shown)}`);
    for (const b of shown.controls) assert.ok(b.height >= 44);
    await record(t, 'r3-return', page, `${locale}-${theme}-${width}-following-next-reply`, shown);
  }
});

// AIT-190: use the existing remote-only fixture. Phones have touch capabilities
// from navigation onward; no mouse is introduced in this regression matrix.
async function recoveryRowMetrics(page) {
  return shadow(page, c => {
    const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
    const rect = n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, height: b.height }; };
    const actions = r.querySelector('.voice-reply-actions'), row = rect(actions), parent = actions.parentElement;
    const text = parent.querySelector('.turn-text'), first = [...r.querySelectorAll('ol .turn')].find(n => n.getBoundingClientRect().bottom > shell.getBoundingClientRect().top);
    return { row, parent: parent.className, turnId: parent.dataset.id ?? null,
      audioAvailable: globalThis.tickRail.notices.audioAvailable(),
      clientReplayAvailable: typeof globalThis.tickVoiceClient.replayReply === 'function',
      emptySpaceAbovePx: text ? row.top - text.getBoundingClientRect().bottom : null,
      controls: [...actions.querySelectorAll('button')].map(n => ({ ...rect(n), hidden: n.hidden, border: getComputedStyle(n).borderWidth, background: getComputedStyle(n).backgroundColor })),
      first: first ? { id: first.dataset.id, top: rect(first).top } : null,
      shell: rect(shell), dock: rect(r.querySelector('.composer-dock')), scrollTop: shell.scrollTop, maxScroll: shell.scrollHeight - shell.clientHeight,
      sentence: r.querySelector('.voice-notice--reply > span').textContent,
      coarse: matchMedia('(pointer:coarse)').matches, fine: matchMedia('(pointer:fine)').matches, touchPoints: navigator.maxTouchPoints };
  });
}

test('AIT-190 N1: recovery sentence → quiet reply action row → gone, touch 390 and desktop 1024/1440, DE/EN L/D, 0px reading shift', { timeout: 120_000 }, async t => {
  for (const width of [390, 1024, 1440]) await t.test(`${width}px`, async t => {
    const page = await fixture(t, width === 390);
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) {
    for (const position of width === 390 ? ['following', 'scrolled-up', 'near-bottom'] : ['following', 'scrolled-up', 'near-bottom-9', 'near-bottom-20', 'near-bottom-43']) await t.test(`${locale}-${theme}-${position}`, async t => {
      // Replay methods are installed later in each position. Start with a fresh
      // client so the clear and action-row stages retain text-only coverage.
      await voiceScene(page, locale, theme, width);
      await page.evaluate(async () => {
        const { createPageReplay } = await import('/packages/ui/src/page-replay.js');
        globalThis.rowPlayer = createPageReplay({ document, control: { speakText: async () => ({ kind: 'audio', audio: { format: 'pcm_16000', data: btoa('\0'.repeat(512)) } }) } });
        const c = document.querySelector('aithema-session'), session = structuredClone(c.session);
        const user = session.transcript[0].content;
        const reply = session.locale === 'de' ? 'Die Website soll Menschen schnell zur richtigen Leistung führen.' : 'The website should help people find the right service quickly.';
        session.transcript = Array.from({ length: 48 }, (_, i) => ({ id: `row-${i}`, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? reply : user }));
        session.seq++;
        c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
      }); await frame(page);
      const following = position === 'following';
      const setPosition = () => shadow(page, (c, position) => {
        const s = c.shadowRoot.querySelector('.transcript-shell');
        s.scrollTop = position === 'following' ? s.scrollHeight : position.startsWith('near-bottom') ? s.scrollHeight - s.clientHeight - Number(position.split('-')[2] ?? 20) : 400;
        s.dispatchEvent(new Event('scroll'));
      }, position);
      await setPosition(); await frame(page);
      const before = await recoveryRowMetrics(page);
      if (width === 390) assert.equal(before.coarse && !before.fine && before.touchPoints > 0, true, 'phone has touch and no mouse pointer');
      else assert.equal(before.fine && !before.coarse && before.touchPoints === 0, true, 'desktop has native fine pointer');
      await page.evaluate(() => {
        const reply = document.querySelector('aithema-session').session.transcript.at(-1);
        globalThis.tickRail.notices.recovered({ userUnconfirmed: true, deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: reply.content, lastReplyTurnId: reply.id });
      }); await frame(page);
      const sentence = await recoveryRowMetrics(page), label = `${locale}-${theme}-${width}-${position}`;
      assert.equal(sentence.audioAvailable, false, `${label}-clear remains text-only`);
      assert.equal(sentence.clientReplayAvailable, false, `${label}-clear has no replay client`);
      if (!following) assert.deepEqual(sentence.first, before.first, 'notice add: first visible bubble shifts 0px');
      if (following) for (const b of sentence.controls) {
        assert.ok(b.top >= 0 && b.bottom <= 900, 'sentence controls fully visible in viewport');
        if (width === 390) assert.ok(b.top >= sentence.shell.top && b.bottom <= sentence.shell.bottom, 'sentence controls fully visible in transcript');
        if (width === 390) assert.ok(b.bottom <= sentence.dock.top - 12, 'sentence controls fully above dock');
      }
      await record(t, 'ait190', page, `${label}-clear`, { ...sentence, shiftPx: following ? sentence.dock.top - before.dock.top : sentence.first.top - before.first.top });
      await setPosition(); await frame(page);
      const beforeClear = await recoveryRowMetrics(page);
      await page.evaluate(() => globalThis.tickRail.notices.clear()); await frame(page);
      const row = await recoveryRowMetrics(page);
      assert.equal(row.audioAvailable, false, `${label}-action-row remains text-only`);
      assert.equal(row.clientReplayAvailable, false, `${label}-action-row has no replay client`);
      assert.equal(row.sentence, '');
      assert.equal(row.turnId, 'row-47', 'controls are the last assistant bubble action row');
      assert.equal(row.emptySpaceAbovePx, 0, 'no empty line above the action row');
      for (const b of row.controls) {
        assert.equal(b.height, 44, '44px target'); assert.equal(b.border, '0px', 'no control box'); assert.equal(b.background, 'rgba(0, 0, 0, 0)', 'quiet transparent action');
        if (following) {
          assert.ok(b.top >= row.shell.top && b.bottom <= row.shell.bottom, 'action row fully visible');
          if (width === 390) assert.ok(b.bottom <= row.dock.top - 12, 'action row fully above dock');
        }
      }
      if (!following) assert.deepEqual(row.first, beforeClear.first, 'notice clear to row: first visible bubble shifts 0px');
      await record(t, 'ait190', page, `${label}-action-row`, { ...row, shiftPx: following ? row.dock.top - beforeClear.dock.top : row.first.top - beforeClear.first.top });
      // Read the full text through the same moved control, without synthesis.
      if (following) {
        const b = row.controls[1];
        const target = await shadow(page, (c, point) => {
          const r = c.shadowRoot, button = r.querySelector('.voice-read-text'), hit = r.elementFromPoint(point.x, point.y);
          globalThis.rowTouchEvents = [];
          for (const type of ['pointerdown', 'touchstart', 'click']) button.addEventListener(type, () => globalThis.rowTouchEvents.push(type));
          return { hit: hit?.className, disabled: button.disabled, sameRail: globalThis.tickRail.root === r.querySelector('.audio-rail') };
        }, { x: b.left + 12, y: b.top + 22 });
        assert.deepEqual(target, { hit: 'voice-read-text', disabled: false, sameRail: true }, `text action hit target ${label}`);
        if (width === 390) await page.touchscreen.tap(b.left + 12, b.top + 22);
        else await page.mouse.click(b.left + 12, b.top + 22);
        t.diagnostic(`action ${label}: ${JSON.stringify(await page.evaluate(() => globalThis.rowTouchEvents))}`);
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-dialog').open), true);
        await shadow(page, c => { const dialog = c.shadowRoot.querySelector('dialog'); dialog.close(); }); await frame(page);
      }
      await page.evaluate(() => {
        globalThis.tickVoiceClient.replayReply = (reply, options) => globalThis.rowPlayer.replay(reply, options);
        globalThis.tickVoiceClient.stopReplay = () => globalThis.rowPlayer.stop();
        globalThis.tickRail.render();
      }); await frame(page);
      await setPosition(); await frame(page);
      const beforeGone = await recoveryRowMetrics(page);
      // A 16ms PCM fixture exercises the same production sink and real ended
      // event in every scene; no need to replay half a second of silence.
      // This plays real PCM through the production page audio sink. Completion
      // is observed, never advanced by a timeout or a synthetic ended event.
      await page.evaluate(() => globalThis.tickRail.notices.repeat());
      await until(page, () => globalThis.tickRail.notices.button.hidden); await frame(page);
      const gone = await recoveryRowMetrics(page);
      assert.ok(gone.controls.every(b => b.hidden && b.height === 0), 'fully visible and played-through reply has no controls');
      if (!following) assert.deepEqual(gone.first, beforeGone.first, 'row removal: first visible bubble shifts 0px');
      if (following) assert.equal(gone.scrollTop, gone.maxScroll, 'following remains at bottom');
      await record(t, 'ait190', page, `${label}-gone`, { ...gone, emptySpaceAbovePx: 0, shiftPx: following ? gone.dock.top - beforeGone.dock.top : gone.first.top - beforeGone.first.top });
      await page.evaluate(() => { globalThis.tickRail.notices.completedReply = null; globalThis.tickRail.notices.render(); });
      await frame(page);
      const readded = await recoveryRowMetrics(page);
      if (!following) assert.deepEqual(readded.first, gone.first, 'row add: first visible bubble shifts 0px');
      if (following) for (const b of readded.controls) assert.ok(b.top >= readded.shell.top && b.bottom <= readded.shell.bottom, 'added action row fully visible');
      await record(t, 'ait190', page, `${label}-readded`, { ...readded, shiftPx: following ? readded.dock.top - gone.dock.top : readded.first.top - gone.first.top });
    });
    }
  });
});


// A narrow desktop window has phone notices and a real resting mouse pointer.
for (const behavior of ['release retained room', 'follow notice changes']) {
  test(`AIT-244: wheel over an upload must ${behavior} at phone-notice widths`, { timeout: 120_000 }, async t => {
    const page = await fixture(t, false);
    for (const width of [390, 393]) {
      await voiceScene(page, 'en', 'light', width);
      await shadow(page, c => {
        const session = structuredClone(c.session);
        session.transcript = Array.from({ length: 24 }, (_, i) => ({ id: `hover-${i}`, role: 'user', content: 'Earlier conversation message. '.repeat(8) }));
        session.uploads = [{ id: 'hover-upload', filename: 'brief.txt', bytes: 128, state: 'accepted' }];
        c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
      });
      await page.mouse.move(-1, -1); await frame(page);
      await page.evaluate(() => globalThis.tickRail.notices.recovered()); await frame(page);
      await shadow(page, c => {
        const shell = c.shadowRoot.querySelector('.transcript-shell');
        shell.scrollTop = shell.scrollHeight - shell.clientHeight - 20;
        shell.dispatchEvent(new Event('scroll'));
      });
      await frame(page);
      if (behavior === 'release retained room') {
        await page.evaluate(() => globalThis.tickRail.notices.clear()); await frame(page);
        assert.ok(await shadow(page, c => parseFloat(c.shadowRoot.querySelector('.voice-notices').style.minHeight) > 0), 'reading retains removed notice room before the wheel');
      }
      const point = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.upload').getBoundingClientRect();
        const shell = c.shadowRoot.querySelector('.transcript-shell').getBoundingClientRect();
        // The 20px wheel movement must leave the pointer inside this same row.
        return [row.left + 20, Math.min(row.bottom - 25, shell.bottom - 25)];
      });
      await page.mouse.move(...point);
      const hovered = () => shadow(page, (c, point) => Boolean(c.shadowRoot.elementFromPoint(...point)?.closest('.upload')), point);
      assert.equal(await hovered(), true, 'native pointer hits the upload before the wheel');
      const outer = await boxes(page, ['.band', '.transcript-shell', '.composer-dock']);
      await page.mouse.wheel({ deltaY: 10_000 });
      await until(page, () => {
        const shell = document.querySelector('aithema-session').shadowRoot.querySelector('.transcript-shell');
        return shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 1;
      });
      await frame(page);
      assert.equal(await hovered(), true, 'pointer still rests on the upload after the native wheel reaches bottom');
      if (behavior === 'follow notice changes') {
        const before = await boxes(page, ['.upload']);
        await page.evaluate(() => globalThis.tickRail.notices.recovered({ userUnconfirmed: true })); await frame(page);
        assert.deepEqual(await boxes(page, ['.upload']), before, 'notice growth keeps the resting upload at exactly the same box');
      }
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notices').style.minHeight), '', `${behavior}: following must leave no reading reservation`);
      assert.deepEqual(await boxes(page, ['.band', '.transcript-shell', '.composer-dock']), outer, 'notice handling moves the surrounding layout exactly 0px');
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-1, -1); await frame(page);
      await record(t, 'ait-244', page, `${width}-${behavior.replaceAll(' ', '-')}`, await noticeMetrics(page));
    }
  });
}

for (const change of ['shrink', 'remove']) for (const release of ['leave row', 'scroll']) {
  test(`AIT-244: notice ${change} holds a hovered upload until ${release}`, { timeout: 120_000 }, async t => {
    const page = await fixture(t, false);
    for (const width of [390, 393]) {
      await page.mouse.move(-1, -1);
      await voiceScene(page, 'en', 'light', width);
      await shadow(page, c => {
        const session = structuredClone(c.session);
        session.transcript = Array.from({ length: 24 }, (_, i) => ({ id: `shrink-${i}`, role: 'user', content: 'Earlier conversation message. '.repeat(8) }));
        session.uploads = [{ id: 'shrink-upload', filename: 'brief.txt', bytes: 128, state: 'accepted' }];
        c.configure({ copy: globalThis.pauseCopy, session, voiceClient: globalThis.tickVoiceClient });
      }); await frame(page);
      await page.evaluate(() => globalThis.tickRail.notices.recovered({ userUnconfirmed: true })); await frame(page);
      await shadow(page, c => {
        const shell = c.shadowRoot.querySelector('.transcript-shell');
        shell.scrollTop = shell.scrollHeight; shell.dispatchEvent(new Event('scroll'));
      }); await frame(page);
      const point = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.upload').getBoundingClientRect();
        return [row.left + 20, row.top + 20];
      });
      await page.mouse.move(...point); await frame(page);
      assert.equal(await shadow(page, (c, point) => Boolean(c.shadowRoot.elementFromPoint(...point)?.closest('.upload')), point), true);
      const before = await boxes(page, ['.upload']);
      const oldHeight = await shadow(page, c => c.shadowRoot.querySelector('.voice-notices').getBoundingClientRect().height);
      await page.evaluate(change => {
        if (change === 'remove') globalThis.tickRail.notices.clear();
        else globalThis.tickRail.notices.recovered();
      }, change); await frame(page);
      assert.deepEqual(await boxes(page, ['.upload']), before, `${width}px notice ${change}: resting upload shifts exactly 0px`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notices').getBoundingClientRect().height), oldHeight, 'removed notice room remains while hovered');
      if (release === 'leave row') {
        // Stay inside the transcript: leaving only the upload is sufficient.
        const [[x, y]] = await boxes(page, ['.transcript-shell']);
        await page.mouse.move(x + 5, y + 5);
      } else await page.mouse.wheel({ deltaY: 10_000 });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-notices').style.minHeight === '');
      await frame(page);
      assert.ok(await shadow(page, c => c.shadowRoot.querySelector('.voice-notices').getBoundingClientRect().height) < oldHeight, 'leaving or scrolling releases the retained room');
      t.diagnostic(`${width}px ${change}, ${release}: upload shift 0px, reservation released`);
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-1, -1); await frame(page);
      await record(t, 'ait-244-shrink', page, `${width}-${change}-${release.replaceAll(' ', '-')}`, await noticeMetrics(page));
    }
  });
}
