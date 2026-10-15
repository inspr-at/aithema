// AIT-188: Tick's binding follow-ups. Viewport evidence only, remote runner only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { pausedOverview } from '../fixtures/pause-overview.js';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

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
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
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
async function scene(page, locale, theme, width) {
  await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : width < 600 ? 844 : 900 }); await page.select('#theme', theme);
  await page.evaluate(async locale => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.tickSeed);
    session.locale = locale;
    c.configure({ copy, session, host: { library: true } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    scrollTo(0, 0);
  }, locale);
  await frame(page);
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
test('AIT-188 L2: phone composer dock, focus and keyboard viewport, idle/call/both pauses DE/EN L/D', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 393]) {
    await voiceScene(page, locale, theme, width);
    await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 }); await frame(page);
    assert.ok((await metrics(page)).transcriptHeight >= 320, 'phone keeps a usable transcript viewport above the dock');
    const baseline = (await metrics(page)).composer;
    for (const state of ['idle', 'in-call', 'purpose-pause', 'session-pause']) {
      if (state === 'session-pause') { await voiceScene(page, locale, theme, width); await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 }); }
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
    await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: 480 }); await frame(page);
    await page.keyboard.type(locale === 'de' ? 'Mein Vorhaben' : 'My project');
    const keyboard = await metrics(page);
    assert.equal(keyboard.inViewport, true, `${locale}/${theme}/${width}: keyboard does not cover input ${JSON.stringify(keyboard)}`);
    assert.equal(keyboard.focused, 'message');
    await page.keyboard.press('Tab');
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'attach');
    await record(t, 'L2', page, `${locale}-${theme}-${width}-keyboard`, keyboard);
    await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: 844 }); await frame(page);
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

test('AIT-188 V1: settled project overview replaces the placeholder after purpose pause, DE/EN L/D phone/desktop', { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const locale of ['de', 'en']) {
    const scenario = await pausedOverview(locale);
    for (const theme of ['light', 'dark']) for (const width of [390, 393, 1440]) {
      await scene(page, locale, theme, width);
      await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : width === 390 ? 844 : 900 });
      await page.evaluate(async ({ before, locale }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        document.querySelector('aithema-session').configure({ copy, session: { ...before, id: globalThis.tickSeed.id } });
      }, { before: scenario.before, locale }); await frame(page);
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
    await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 });
    for (const state of ['idle', 'purpose-pause', 'session-pause', 'resized-keyboard', 'overlay-keyboard']) {
      if (state !== 'idle') { await voiceScene(page, 'de', theme, width); await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 }); }
      if (state.endsWith('pause')) await shadow(page, (c, state) => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, ...(state === 'purpose-pause' ? { reason: 'purpose' } : {}) } }), state);
      if (state === 'resized-keyboard') { await page.click('aithema-session >>> textarea'); await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: 480 }); }
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
    await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 });
    await page.click('aithema-session >>> textarea');
    if (mode === 'resized') await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: 480 }); else await overlayKeyboard(page);
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
    if (mode === 'overlay') await closeOverlay(page); else { await page.setViewport({ width, hasTouch: page.phoneTouch !== false, height: width === 393 ? 852 : 844 }); await frame(page); }
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
      c.configure({ copy: globalThis.pauseCopy, session });
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
      c.configure({ copy: globalThis.pauseCopy, session });
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
      assert.ok(ended.controls.every(b => b.height >= 44), 'ordinary row returns at call end with 44px targets');
      if (following) {
        for (const b of [ended.notice, ...ended.controls]) assert.ok(b.top >= ended.viewport.top && b.bottom <= ended.viewport.bottom && b.bottom <= ended.dockTop - 12, `ordinary row fully visible after render: ${JSON.stringify(ended)}`);
      } else {
        assert.deepEqual(ended.first, beforeEnd.first, 'call end shows row: first bubble shift 0px');
        assert.equal(ended.badge, beforeEnd.badge, 'ordinary row adds no badge');
      }
      await record(t, 'r3-ordinary', page, `${locale}-${theme}-${width}-${position}-call-end`, { ...ended, firstBubbleShift: following ? null : ended.first.top - beforeEnd.first.top });
    }
  }
});

test('AIT-188 r3 keyboard: fine-pointer desktop resize keeps footer', async t => {
  const page = await fixture(t); page.phoneTouch = false;
  await voiceScene(page, 'en', 'light', 500);
  assert.equal(await page.evaluate(() => matchMedia('(pointer:fine)').matches && navigator.maxTouchPoints === 0), true);
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }));
  await page.setViewport({ width: 500, height: 644, hasTouch: false }); await frame(page);
  assert.notEqual(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display), 'none', 'desktop window shrink is not an on-screen keyboard');
});

test('AIT-188 r3 keyboard: touch width/orientation reset and blur never stick footer hidden', async t => {
  const page = await fixture(t);
  await voiceScene(page, 'de', 'dark', 390);
  const footer = () => shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.display-foot')).display);
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }));
  await page.setViewport({ width: 390, height: 480, hasTouch: true }); await frame(page);
  assert.equal(await footer(), 'none', 'touch keyboard opens');
  await page.setViewport({ width: 500, height: 600, hasTouch: true, isLandscape: true }); await frame(page);
  assert.notEqual(await footer(), 'none', 'width/orientation establishes a new unobstructed baseline');
  await page.setViewport({ width: 500, height: 400, hasTouch: true, isLandscape: true }); await frame(page);
  assert.equal(await footer(), 'none', 'keyboard detected against the new baseline');
  await shadow(page, c => c.shadowRoot.querySelector('.fold').focus({ preventScroll: true })); await frame(page);
  assert.notEqual(await footer(), 'none', 'leaving composer clears keyboard state without resize');
  await page.setViewport({ width: 500, height: 600, hasTouch: true, isLandscape: true }); await frame(page);
  assert.notEqual(await footer(), 'none', 'keyboard closed');
  await shadow(page, c => c.shadowRoot.querySelector('textarea').focus({ preventScroll: true })); await frame(page);
  assert.notEqual(await footer(), 'none', 'focus alone cannot reuse a stale height');
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
