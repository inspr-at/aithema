// AIT-135 A2 D. The shipped component against deterministic owner-route fixtures.
// Run exclusively through remote-browser.sh or CI; screenshots never render the design mock.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, fullMatrix, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';
import { contrast } from '../contrast.js';
import { settleEvidenceFrame } from './start2-display-helpers.js';

const workflowEvent = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
const head = workflowEvent?.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1];
// Headless-shell has no mouse by default. Touch viewport emulation still overrides
// these defaults at 390; assert the actual media queries, never infer from width.
const pointerLaunch = { args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'] };
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn) => page.waitForFunction(fn, { timeout: 20_000, polling: 'raf' });
const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
// Wait for the rendered fixture and finite UI transitions instead of paying
// 450 ms after every action in all twelve viewport/theme/language combinations.
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  let quietFrames = 0;
  while (quietFrames < 2) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const animations = c.shadowRoot.getAnimations({ subtree: true })
      .filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect.getComputedTiming().endTime));
    if (!animations.length) quietFrames++;
    else { quietFrames = 0; await Promise.all(animations.map(animation => animation.finished.catch(() => {}))); }
  }
});
const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
const unchanged = (before, after, label) => {
  const displacement = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
  assert.equal(displacement, 0, `${label}: surrounding controls displaced ${displacement} px; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return displacement;
};

export async function fixture(page, locale, { address = null, spent = 3_450_000, reserved = 0, delivery = false, privacy = true, handover = false, demo = false, confirmed = false, voiceRunning = false, voiceAdmissionFailure = false, waitingCall = false, creditScope = null, dailyCap = false,
  allowancesMicro = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 } } = {}) {
  // Touch viewport changes reload the demo; wait for its owner session seed.
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, async (c, options) => {
    const { locale, address, spent, reserved, delivery, privacy, handover, demo, confirmed, voiceRunning, voiceAdmissionFailure, waitingCall, creditScope, dailyCap, allowancesMicro } = options;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { inputRevision } = await import('/packages/core/src/session.js');
    window.a2OriginalFetch ??= window.fetch.bind(window);
    const state = window.a2 = { address, spent, reserved, delivery, privacy, confirmed, saving: false,
      creditScope, dailyCap, denyVoice: voiceAdmissionFailure, voiceRequests: [], voiceCloses: 0, creditsReads: 0 };
    const identity = () => ({ ...c.session.identity, address: state.address, status: state.confirmed ? 'verified' : state.address && delivery ? 'verification-pending' : 'guest',
      assessmentUnlocked: true, conceptsUnlocked: true, verificationRequired: false, resendAfterMs: 0, pollVerification: false, delivery: 'sent' });
    const current = () => state.confirmed ? 'emailConfirmed' : state.address ? 'emailGiven' : 'anonymous';
    const visitor = () => ({ address: state.address, tier: current(), limitMicro: allowancesMicro[current()] });
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, method = init.method ?? 'GET';
      // The mocked snapshot owns its journal too. The real demo stream cannot
      // replay these synthetic sequences and would cause repeated gap restores.
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        if (init.signal?.aborted) controller.close();
        else init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (method === 'GET' && path === `/api/sessions/${c.session.id}`) return Response.json({ ...c.session, identity: identity(), featureMatrix: { best: Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: allowancesMicro[current()] > state.spent + state.reserved, reason: allowancesMicro[current()] > state.spent + state.reserved ? null : 'budget denied' }])) } });
      if (path.endsWith('/credits')) {
        state.creditsReads++;
        const tier = current(), next = !privacy ? null : !state.address ? 'emailGiven' : delivery && !state.confirmed ? 'emailConfirmed' : null;
        const limitMicro = allowancesMicro[tier];
        return Response.json({ balance: { owner: { limitMicro, committedMicro: state.spent + state.reserved,
          confirmedSpendMicro: state.spent, reservedMicro: state.reserved, uncertainSpendMicro: 0, availableMicro: Math.max(0, limitMicro - state.spent - state.reserved) } }, exhausted: state.spent >= limitMicro, limitSlot: null,
          ...(state.creditScope ? { scope: state.creditScope } : {}),
          ...(state.dailyCap ? { scope: 'session', dailyCapReached: true } : {}),
          tiers: { current: tier, next, delta: next ? allowancesMicro[next] - limitMicro : 0, canConfirm: delivery && privacy, allowancesMicro } });
      }
      if (path.endsWith('/visitor/email')) {
        if (method === 'PUT') { while (state.saving) await new Promise(resolve => setTimeout(resolve, 20)); state.address = JSON.parse(init.body).address; state.confirmed = false; }
        if (method === 'DELETE') { state.address = null; state.confirmed = false; }
        return Response.json({ visitor: visitor(), notice: { version: 'ait-135-v1', deliveryEnabled: delivery }, privacyDocumentConfigured: privacy });
      }
      if (path.endsWith('/identity')) return Response.json({ identity: identity(), delivery, privacyDocumentConfigured: privacy });
      if (/\/identity\/(request|change|resend)$/u.test(path)) { state.address = JSON.parse(init.body).address ?? state.address; state.confirmed = false; return Response.json({ identity: identity() }); }
      return window.a2OriginalFetch(url, init);
    };
    for (const legal of c.querySelectorAll('[slot="legal"]')) legal.remove();
    if (privacy) { const legal = document.createElement('nav'); legal.slot = 'legal'; const link = document.createElement('a'); link.setAttribute('data-aithema-privacy', ''); link.href = '/privacy?locale=' + locale; legal.append(link); c.append(legal); }
    const session = structuredClone(c.session); session.locale = locale; session.demo = demo; session.paused = false; session.identity = identity(); session.credits = null;
    delete session.voiceLifecycle;
    if (waitingCall) session.voiceLifecycle = { callId: 'fixture-waiting-call', providerSessionId: 'fixture-waiting-provider', state: 'waiting' };
    session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
    session.transcript = [{ id: 'visitor-fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte meine Anforderungen besprechen.' : 'I would like to discuss my requirements.' }];
    const question = locale === 'de' ? 'Welche Anforderungen möchten Sie besprechen?' : 'Which requirements would you like to discuss?';
    session.transcript.push({ id: 'visitor-fixture-question', role: 'assistant', content: question, inputRevision: inputRevision(session),
      question_short: question, options: [{ text: locale === 'de' ? 'Ziele' : 'Goals', likely: true }, { text: locale === 'de' ? 'Ressourcen' : 'Resources' }] });
    session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
    c.setAttribute('motion', 'off');
    let voiceClient;
    if (voiceRunning || voiceAdmissionFailure || waitingCall) {
      const { voiceEvents } = await import('/packages/core/src/live-voice.js');
      voiceClient = { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native', sendText: 'native' } } },
        async start(request) {
          state.voiceRequests.push(request);
          while (state.holdVoice) await new Promise(resolve => setTimeout(resolve, 20));
          if (state.denyVoice) throw Object.assign(new Error('fixture admission refused'), { code: 'not-admitted', reason: 'host-limit' });
          const events = voiceEvents();
          return { callId: request.callId, providerSessionId: 'fixture-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async heartbeat() {},
            async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
            async close() { state.voiceCloses++; events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } };
        } };
    }
    c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery, privacyDocumentConfigured: privacy }, handover } });
    if (voiceRunning) c.shadowRoot.querySelector('.voice-start').click();
  }, { locale, address, spent, reserved, delivery, privacy, handover, demo, confirmed, voiceRunning, voiceAdmissionFailure, waitingCall, creditScope, dailyCap, allowancesMicro });
  await until(page, () => window.a2.creditsReads > 0);
  await settle(page);
}

// The v1–v4 matrices run serially and configure fresh owner-route state in-page.
// Keep their server, page and AX session alive until file teardown.
let reservationHarness;
after(async () => {
  if (!reservationHarness) return;
  const { browser, demo, directory } = await reservationHarness;
  try { await browser.close(); }
  finally { await demo.kill(); await rm(directory, { recursive: true, force: true }); }
});
const reservationPage = () => reservationHarness ??= (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-reservation-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(pointerLaunch), page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session);
  const accessibility = await page.createCDPSession();
  await accessibility.send('Accessibility.enable');
  return { directory, demo, browser, page, accessibility };
})();

// Tick spec v1, AIT-406 (2026-10-20): always cover all twelve combinations,
// reuse one page, and compare every state against the same default geometry.
export async function composerCreditReservationMatrix(t) {
  const { page, accessibility } = await reservationPage();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const rows = [], selectors = ['.question-card', '.composer-shell'];
  if (evidence) await mkdir(evidence, { recursive: true });
  // Keep the v1.1 copy, line-count and DE/EN evidence checks intact.
  await t.test('AIT-434 v1.1: four-digit DE offer fits two lines; DE/EN composer heights match', async () => {
    const checks = [];
    for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      for (const locale of ['de', 'en']) {
        await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
        await page.select('#locale', locale); await page.select('#theme', theme);
        await fixture(page, locale, {
          allowancesMicro: { anonymous: 12_000_000, emailGiven: 22_000_000, emailConfirmed: 28_000_000 } });
        const before = await boxes(page, selectors);
        await shadow(page, c => {
          window.a2.spent = 12_000_000;
          c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
        });
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up'));
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        const measured = await shadow(page, c => {
          const root = c.shadowRoot, offer = root.querySelector('.composer-out__body > [data-active="true"]');
          const style = getComputedStyle(offer), lines = new Map(), walker = document.createTreeWalker(offer, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode;
            for (let i = 0; i < text.length; i++) {
              const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
              const rect = [...range.getClientRects()].find(rect => rect.width && rect.height);
              if (rect) lines.set(rect.top, (lines.get(rect.top) ?? '') + text.data[i]);
            }
          }
          return { offer: offer.textContent, lines: [...lines.values()].map(line => line.trim()),
            composerHeight: root.querySelector('.composer-shell').getBoundingClientRect().height,
            font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
            visibility: style.visibility, ariaHidden: offer.getAttribute('aria-hidden'),
            reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches, focused: Boolean(root.activeElement) };
        });
        const after = await boxes(page, selectors), label = `AIT-434 v1.1 ${locale}/${theme}/${width}`;
        const row = { locale, theme, width, ...measured, lineCount: measured.lines.length, before, after, viewport: true, settled: true, blurred: true };
        checks.push(row); t.diagnostic(`${label}: ${JSON.stringify(row)}`);
        if (evidence) {
          await mkdir(join(evidence, 'ait434'), { recursive: true });
          await writeFile(join(evidence, 'ait434', 'v1.1-checks.json'), JSON.stringify({ ticket: 'AIT-434', head, spec: 'Tick spec v1.3, 2026-10-21', checks }, null, 2));
          if (theme === 'light' && (width === 390 || width === 1440 && locale === 'de')) {
            const scrollBefore = await page.evaluate(() => scrollY);
            await shadow(page, c => c.shadowRoot.querySelector('.composer-shell').scrollIntoView({ block: 'center', behavior: 'instant' }));
            await settle(page);
            await page.screenshot({ path: join(evidence, 'ait434', `${width}-light-${locale}-host-give-1000.png`), fullPage: false, captureBeyondViewport: false, optimizeForSpeed: true });
            await page.evaluate(top => scrollTo(0, top), scrollBefore); await settle(page);
          }
        }
        assert.equal(measured.visibility, 'visible', `${label}: offer is painted`);
        assert.equal(measured.ariaHidden, 'false', `${label}: offer is accessible`);
        assert.ok(row.lineCount > 0, `${label}: offer has rendered line boxes`);
        if (locale === 'de' && width === 390) assert.ok(row.lineCount <= 2, `${label}: 1.000 delta must fit in at most two lines; got ${row.lineCount}: ${JSON.stringify(row.lines)}`);
        if (locale === 'de' && width === 390) assert.ok(row.lines.every(line => !/(?:^|\s)Ihr$/u.test(line)), `${label}: 1.000 delta must not leave Ihr at a line end: ${JSON.stringify(row.lines)}`);
        assert.equal(measured.offer, locale === 'de' ? 'Mit E-Mail-Adresse: 1.000 weitere\u00a0Credits. Ihr\u00a0Gespräch bleibt gespeichert.'
          : 'With your email address you get 1,000 more\u00a0credits. Your conversation stays saved.', `${label}: exact Tick copy and formatted delta`);
        assert.equal(measured.font, 'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif');
        assert.equal(measured.reducedMotion, true); assert.equal(measured.focused, false);
        unchanged(before, after, `${label}: default to host-give`);
      }
      const [de, en] = checks.slice(-2);
      assert.equal(de.before[1][3], en.before[1][3], `AIT-434 v1.1 ${theme}/${width}: DE == EN default composer height`);
      assert.equal(de.composerHeight, en.composerHeight, `AIT-434 v1.1 ${theme}/${width}: DE == EN host-give composer height`);
    }
    assert.equal(checks.length, 12);
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1024, 390, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.select('#locale', locale); await page.select('#theme', theme);
    await fixture(page, locale);
    const before = await boxes(page, selectors);
    // Retain the container handle, but inspect its current descendants for
    // every state: changing text can replace a text node inside a stable span.
    const { result } = await accessibility.send('Runtime.evaluate', { expression: "document.querySelector('aithema-session').shadowRoot.querySelector('.composer-out__body')" });
    for (const state of ['default', 'host-limit', 'one-hour', 'daily-cap']) {
      if (state !== 'default') {
        const reads = await page.evaluate(() => window.a2.creditsReads);
        await shadow(page, (c, state) => {
          window.a2.spent = 12_000_000;
          window.a2.dailyCap = state === 'daily-cap';
          c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: state === 'one-hour' ? 'one-hour' : 'host-limit' } });
        }, state);
        await page.waitForFunction(reads => window.a2.creditsReads > reads, { timeout: 20_000 }, reads);
      }
      if (state !== 'default') await settle(page);
      const { after, variants, activeBody } = await shadow(page, (c, selectors) => ({
        after: selectors.map(selector => { const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }),
        activeBody: [...c.shadowRoot.querySelectorAll('.composer-out__body > span')].filter(n => getComputedStyle(n).visibility === 'visible').map(n => n.textContent),
        variants: [...c.shadowRoot.querySelectorAll('.composer-out__body > span')].map(n => ({
        key: n.dataset.creditVariant, text: n.textContent, visibility: getComputedStyle(n).visibility, ariaHidden: n.getAttribute('aria-hidden'),
        gridCell: [getComputedStyle(n).gridRowStart, getComputedStyle(n).gridColumnStart],
      })) }), selectors);
      // One complete AX snapshot replaces ten separately refreshed partial
      // trees. Check every hidden span AND its current descendants: none may
      // be exposed. A nonempty document tree prevents an empty-tree false pass.
      const [{ node }, { nodes }] = await Promise.all([
        accessibility.send('DOM.describeNode', { objectId: result.objectId, depth: -1 }),
        accessibility.send('Accessibility.getFullAXTree'),
      ]);
      assert.ok(nodes.some(n => n.role?.value === 'RootWebArea' && n.ignored === false), 'AX snapshot contains the accessible document');
      const variantNodes = node.children.filter(n => n.nodeName === 'SPAN');
      assert.equal(variantNodes.length, variants.length, 'every reserved variant has a cached backend node');
      const exposed = new Set(nodes.filter(n => !n.ignored).map(n => n.backendDOMNodeId));
      const descendants = n => [n.backendNodeId, ...(n.children ?? []).flatMap(descendants)];
      const hiddenAX = variants.flatMap((variant, i) => {
        if (variant.ariaHidden !== 'true') return [];
        const node = variantNodes[i];
        const keyIndex = node.attributes.indexOf('data-credit-variant');
        assert.equal(node.attributes[keyIndex + 1], variant.key, 'cached AX node matches the sampled variant');
        const checkedBackendNodes = descendants(node);
        return [{ key: variant.key, ignored: checkedBackendNodes.every(id => !exposed.has(id)), checkedBackendNodes }];
      });
      const row = { locale, theme, width, state, before, after, composerHeight: after[1][3],
        movementPx: Math.max(...before.flatMap((box, i) => box.map((value, j) => Math.abs(value - after[i][j])))),
        variants, hiddenAX, hiddenVariantsAbsent: hiddenAX.every(n => n.ignored),
        activeBody };
      rows.push(row);
      t.diagnostic(`AIT-406 ${locale}-${theme}-${width}/${state}: ${JSON.stringify(row)}`);
      if (evidence && locale === 'de' && theme === 'light' && state === 'one-hour' && [390, 1024].includes(width)) {
        const scrollBefore = await page.evaluate(() => scrollY);
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1);
        if (width === 390) await shadow(page, c => c.shadowRoot.querySelector('.composer-shell').scrollIntoView({ block: 'center', behavior: 'instant' }));
        await settle(page);
        await page.screenshot({ path: join(evidence, `ait406-${width}-light-de-one-hour.png`), fullPage: false, optimizeForSpeed: true });
        await page.evaluate(top => scrollTo(0, top), scrollBefore); await settle(page);
      }
    }
    await accessibility.send('Runtime.releaseObject', { objectId: result.objectId });
  }
  if (evidence) await writeFile(join(evidence, 'ait406-composer-checks.json'), JSON.stringify({ head, spec: 'Tick spec v1, AIT-406, 2026-10-20', rows }, null, 2));
  assert.equal(rows.length, 48);
  // Geometry precedes variant assertions so the unfixed baseline proves the
  // original regression, rather than failing on the new markup contract first.
  for (const row of rows) {
    const label = `${row.locale}-${row.theme}-${row.width}/${row.state}`;
    unchanged(row.before, row.after, label);
    assert.equal(row.composerHeight, row.before[1][3], `${label}: identical composer height`);
  }
  // Tick spec v1.2 (2026-10-20): DE == EN replaces the retired long-copy baseline.
  for (const de of rows.filter(row => row.locale === 'de')) {
    const en = rows.find(row => row.locale === 'en' && row.theme === de.theme && row.width === de.width && row.state === de.state);
    assert.equal(de.composerHeight, en.composerHeight, `AIT-434 v1.2 ${de.theme}/${de.width}/${de.state}: DE == EN composer height`);
  }
  for (const row of rows) {
    const label = `${row.locale}-${row.theme}-${row.width}/${row.state}`;
    assert.deepEqual(row.variants.map(n => n.key), ['active', 'default', 'host-give', 'host-confirm', 'host-confirm-anonymous', 'one-hour', 'session', 'voiceVisitor', 'host-limit', 'daily-cap'], `${label}: every variant reserves the grid cell`);
    assert.ok(row.variants.every(n => n.gridCell.join('/') === '1/1'), `${label}: variants share grid-area 1/1`);
    assert.equal(row.variants.filter(n => n.ariaHidden === 'true').length, row.state === 'default' ? 10 : 9, `${label}: inactive variants aria-hidden`);
    assert.ok(row.variants.filter(n => n.ariaHidden === 'true').every(n => n.visibility === 'hidden'), `${label}: inactive variants hidden`);
    assert.equal(row.hiddenVariantsAbsent, true, `${label}: hidden variants absent from accessibility tree`);
    assert.equal(row.activeBody.length, row.state === 'default' ? 0 : 1, `${label}: only the active variant is painted`);
  }
}

// Tick spec v2: exercise the same admitted-call recovery in both directions.
// Reuse the page and fixture; only the owner-route admission verdict changes.
export async function topUpReservationMatrix(t) {
  const { page, accessibility } = await reservationPage();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const rows = [], selectors = ['.question-card', '.composer-dock', '.composer-shell'];
  const copyChecks = [];
  const v3Rows = [], v3Selectors = ['.transcript-shell .turn.user', '.transcript-shell .turn:last-child', '.voice-reply-actions', '.qopts', ...selectors];
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.select('#locale', locale); await page.select('#theme', theme);
    await fixture(page, locale, { spent: 11_990_000, voiceAdmissionFailure: true });
    await click(page, '.voice-start');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up'));
    await shadow(page, c => {
      window.a2.denyVoice = false;
      c.shadowRoot.querySelector('#email-input').value = 'reader@example.test';
      c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit();
    });
    await until(page, () => {
      const r = document.querySelector('aithema-session').shadowRoot;
      return r.querySelector('.host-verify').dataset.emailState === 'saved' && !r.querySelector('.audio-rail').hasAttribute('data-used-up');
    });
    await settle(page);
    const before = await boxes(page, selectors), v3Before = await boxes(page, v3Selectors);
    const recordV3 = async (state, settled = false) => {
      if (!settled) await settle(page);
      const { after, controls } = await shadow(page, (c, selectors) => ({
        after: selectors.map(selector => { const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }),
        controls: [...c.shadowRoot.querySelectorAll('.voice-repeat, .voice-read-text')].map(n => {
        const style = getComputedStyle(n);
        n.focus({ preventScroll: true });
        const focused = c.shadowRoot.activeElement === n;
        n.blur();
        return { hidden: n.hidden, visible: style.display !== 'none' && style.visibility === 'visible' && n.getClientRects().length > 0,
          attached: n.parentElement.parentElement.matches('.turn:last-child'), disabled: n.disabled, ariaDisabled: n.getAttribute('aria-disabled'),
          title: n.title, description: n.getAttribute('aria-description'), opacity: style.opacity, focused };
      }) }), v3Selectors);
      const inCall = ['starting', 'running'].includes(state);
      const axControls = [];
      if (inCall) for (const selector of ['.voice-repeat', '.voice-read-text']) {
        const { result } = await accessibility.send('Runtime.evaluate', { expression: `document.querySelector('aithema-session').shadowRoot.querySelector('${selector}')` });
        const { node } = await accessibility.send('DOM.describeNode', { objectId: result.objectId });
        const { nodes } = await accessibility.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
        const ax = nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
        axControls.push({ ignored: ax?.ignored, description: ax?.description?.value, properties: Object.fromEntries((ax?.properties ?? []).map(p => [p.name, p.value.value])) });
        await accessibility.send('Runtime.releaseObject', { objectId: result.objectId });
      }
      let tabSkipped = null;
      if (inCall) {
        await shadow(page, c => {
          const actions = c.shadowRoot.querySelector('.voice-reply-actions');
          for (const side of ['before', 'after']) {
            const sentinel = document.createElement('span'); sentinel.tabIndex = 0; sentinel.dataset.v3Tab = side;
            sentinel.style.position = 'fixed'; actions[side](sentinel);
          }
          c.shadowRoot.querySelector('[data-v3-tab=before]').focus({ preventScroll: true });
        });
        await page.keyboard.press('Tab');
        tabSkipped = await shadow(page, c => {
          const skipped = c.shadowRoot.activeElement?.dataset.v3Tab === 'after';
          c.shadowRoot.querySelectorAll('[data-v3-tab]').forEach(n => n.remove()); return skipped;
        });
      }
      v3Rows.push({ locale, theme, width, state, before: v3Before, after, controls, axControls, tabSkipped,
        movementPx: Math.max(...v3Before.flatMap((box, i) => box.map((value, j) => Math.abs(value - after[i][j])))) });
    };
    for (const state of ['ready', 'running', 'denied', 'ready-again']) {
      if (state === 'running') {
        await shadow(page, () => { window.a2.holdVoice = true; });
        await click(page, '.voice-retry');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'connecting');
        await recordV3('starting');
        await shadow(page, () => { window.a2.holdVoice = false; });
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
      } else if (state === 'denied') {
        await click(page, '.voice-close');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
        await shadow(page, () => { window.a2.denyVoice = true; });
        await click(page, '.voice-start');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up'));
      } else if (state === 'ready-again') {
        const reads = await page.evaluate(() => window.a2.creditsReads);
        await shadow(page, c => {
          window.a2.denyVoice = false;
          c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
        });
        await page.waitForFunction(reads => window.a2.creditsReads > reads && !document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up'), { timeout: 20_000 }, reads);
      }
      if (state === 'denied') {
        const denied = await shadow(page, c => ({ status: c.shadowRoot.querySelector('.voice-state').getAttribute('aria-label'), footer: c.shadowRoot.querySelector('.host-credits__value').textContent }));
        assert.equal(denied.status, locale === 'de' ? 'Sprache gerade nicht verfügbar' : 'Voice unavailable right now');
        assert.equal(denied.footer, '601', 'AIT-422: host refusal preserves the positive visitor balance');
      }
      if (state !== 'ready') await settle(page);
      const after = await boxes(page, selectors);
      const detail = await shadow(page, c => {
        const r = c.shadowRoot;
        return Object.fromEntries(['.qtext', '.qopts', '.qhint', '.transcript-shell .turn:last-child', '.composer-reason', '.voice-state'].map(selector => {
          const n = r.querySelector(selector), b = n?.getBoundingClientRect();
          return [selector, { text: n?.textContent, box: b && [b.x, b.y, b.width, b.height], style: n && { font: getComputedStyle(n).font, grid: getComputedStyle(n).gridTemplateRows } }];
        }));
      });
      const row = { locale, theme, width, state, before, after, detail,
        movementPx: Math.max(...before.flatMap((box, i) => box.map((value, j) => Math.abs(value - after[i][j])))) };
      await recordV3(state, true);
      rows.push(row); t.diagnostic(`AIT-406 v2 ${locale}-${theme}-${width}/${state}: ${JSON.stringify(row)}`);
      if (state === 'denied') {
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        const shot = `${width}-${theme}-${locale}-retry-denied.png`;
        const presentation = await shadow(page, c => ({ status: c.shadowRoot.querySelector('.voice-state').getAttribute('aria-label'), footer: c.shadowRoot.querySelector('.host-credits__value').textContent }));
        copyChecks.push({ ...row, creditReason: 'host-limit-retry-denied', presentation, shot, viewport: true, settled: true, blurred: true });
        if (evidence) {
          await mkdir(join(evidence, 'ait422'), { recursive: true });
          await page.screenshot({ path: join(evidence, 'ait422', shot), fullPage: false, captureBeyondViewport: false, optimizeForSpeed: true });
        }
      }
      if (evidence && locale === 'de' && theme === 'light' && (width === 390 || width === 1440 && state === 'running') && state !== 'ready-again') {
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        await page.screenshot({ path: join(evidence, `ait406-${width}-light-de-top-up-retry-${state}.png`), fullPage: false, optimizeForSpeed: true });
      }
    }
    // AIT-422 reuses this page and the reserved cells; no additional browser worker.
    await fixture(page, locale, { voiceAdmissionFailure: true });
    const copySelectors = ['.band', '.audio-rail', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', ...selectors];
    const copyBefore = await boxes(page, copySelectors);
    for (const creditReason of ['host-limit', 'session', 'dailyCap']) {
      await fixture(page, locale, { spent: creditReason === 'host-limit' ? 5_990_000 : 12_000_000, voiceAdmissionFailure: true,
        creditScope: creditReason === 'host-limit' ? null : 'session', dailyCap: creditReason === 'dailyCap' });
      if (creditReason === 'host-limit') await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }));
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up'));
      await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
      await page.mouse.move(-1, -1); await settle(page);
      const presentation = await shadow(page, c => {
        const r = c.shadowRoot, status = r.querySelector('.voice-state'), style = getComputedStyle(c);
        return { full: status.querySelector('.consent-wide').textContent, short: status.querySelector('.consent-narrow').dataset.copy,
          label: status.getAttribute('aria-label'), footer: r.querySelector('.host-credits__value').textContent,
          offer: r.querySelector('.composer-out__body > [data-active="true"]').textContent,
          ink3: style.getPropertyValue('--ink-3').trim(), muted: style.getPropertyValue('--aithema-muted').trim(),
          font: getComputedStyle(status).fontFamily, reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
          focused: Boolean(c.shadowRoot.activeElement) };
      });
      const expected = creditReason === 'dailyCap' ? (locale === 'de' ? 'Tageslimit erreicht' : 'Daily limit reached')
        : creditReason === 'session' ? (locale === 'de' ? 'Credits aufgebraucht' : 'Credits used up')
        : locale === 'de' ? 'Sprache gerade nicht verfügbar' : 'Voice unavailable right now';
      assert.equal(presentation.full, expected); assert.equal(presentation.short, expected); assert.equal(presentation.label, expected);
      assert.equal(presentation.footer, '0');
      if (creditReason === 'host-limit') assert.equal(presentation.offer, locale === 'de' ? 'Mit E-Mail-Adresse: 600 weitere\u00a0Credits. Ihr\u00a0Gespräch bleibt gespeichert.' : 'With your email address you get 600 more\u00a0credits. Your conversation stays saved.');
      assert.equal(presentation.ink3, presentation.muted);
      assert.equal(presentation.muted, theme === 'light' ? '#496477' : '#9db4c4');
      assert.equal(presentation.reducedMotion, true); assert.equal(presentation.focused, false);
      assert.equal(presentation.font, 'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif');
      const after = await boxes(page, copySelectors), movementPx = unchanged(copyBefore, after, `AIT-422 ${locale}/${theme}/${width}/${creditReason}`);
      const shot = `${width}-${theme}-${locale}-${creditReason}.png`;
      copyChecks.push({ locale, theme, width, creditReason, presentation, movementPx, before: copyBefore, after, shot, viewport: true, settled: true, blurred: true });
      if (evidence) {
        await mkdir(join(evidence, 'ait422'), { recursive: true });
        await page.screenshot({ path: join(evidence, 'ait422', shot), fullPage: false, captureBeyondViewport: false, optimizeForSpeed: true });
        if (creditReason === 'host-limit' && theme === 'light' && (width === 390 || width === 1440 && locale === 'de')) {
          const scrollBefore = await page.evaluate(() => scrollY);
          await shadow(page, c => c.shadowRoot.querySelector('.composer-shell').scrollIntoView({ block: 'center', behavior: 'instant' }));
          await settle(page);
          await mkdir(join(evidence, 'ait434'), { recursive: true });
          await page.screenshot({ path: join(evidence, 'ait434', `${width}-light-${locale}-host-give.png`), fullPage: false, captureBeyondViewport: false, optimizeForSpeed: true });
          await page.evaluate(top => scrollTo(0, top), scrollBefore); await settle(page);
        }
      }
    }
  }
  assert.equal(copyChecks.length, 48);
  if (evidence) await writeFile(join(evidence, 'ait422', 'checks.json'), JSON.stringify({ ticket: 'AIT-422', head, spec: 'Tick spec v1, 2026-10-20', checks: copyChecks }, null, 2));
  if (evidence) await writeFile(join(evidence, 'ait406-top-up-checks.json'), JSON.stringify({ head, spec: 'Tick spec v2, AIT-406, 2026-10-20', rows }, null, 2));
  if (evidence) await writeFile(join(evidence, 'ait406-replay-checks.json'), JSON.stringify({ head, spec: 'Tick spec v3, AIT-406, 2026-10-20', selectors: v3Selectors, rows: v3Rows }, null, 2));
  assert.equal(rows.length, 48);
  await t.test('v2: exact zero top-up geometry', () => {
    for (const row of rows) unchanged(row.before, row.after, `${row.locale}-${row.theme}-${row.width}/top-up-retry-${row.state}`);
  });
  await t.test('v3: exact zero transcript and control geometry, disabled accessibility', () => {
    assert.equal(v3Rows.length, 60);
    for (const row of v3Rows) {
      const label = `${row.locale}-${row.theme}-${row.width}/${row.state}`;
      unchanged(row.before, row.after, label);
      assert.equal(row.controls.length, 2, `${label}: both reply controls`);
      const inCall = ['starting', 'running'].includes(row.state);
      const description = row.locale === 'de' ? 'Während des Anrufs nicht verfügbar' : 'Not available during a call';
      for (const control of row.controls) {
        assert.equal(control.hidden, false, `${label}: control remains unhidden`);
        assert.equal(control.visible, true, `${label}: control remains visible`);
        assert.equal(control.attached, true, `${label}: control remains on the latest reply`);
        assert.equal(control.disabled, inCall, `${label}: native disabled state`);
        if (inCall) {
          assert.equal(control.ariaDisabled, 'true', `${label}: aria-disabled`);
          assert.equal(control.title, description, `${label}: tooltip`);
          assert.equal(control.description, description, `${label}: aria-description`);
          assert.equal(control.opacity, '0.5', `${label}: existing disabled style`);
          assert.equal(control.focused, false, `${label}: cannot receive focus`);
        } else {
          assert.notEqual(control.ariaDisabled, 'true', `${label}: active aria state restored`);
          assert.equal(control.description, null, `${label}: call description cleared`);
          assert.notEqual(control.title, description, `${label}: call tooltip cleared`);
          assert.equal(control.focused, true, `${label}: focus restored`);
        }
      }
      if (inCall) {
        assert.equal(row.tabSkipped, true, `${label}: Tab skips both disabled controls`);
        assert.equal(row.axControls.length, 2, `${label}: both controls in AX`);
        for (const ax of row.axControls) {
          assert.equal(ax.ignored, false, `${label}: disabled control remains in AX`);
          assert.equal(ax.description, description, `${label}: AX description`);
          assert.equal(ax.properties.disabled, true, `${label}: AX disabled`);
          assert.notEqual(ax.properties.focusable, true, `${label}: AX not focusable`);
        }
      }
    }
  });
}

export async function visitorCreditMatrix(t, locales) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-a2-browser-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await demo.kill(); await rm(directory, { recursive: true, force: true }); } });
  if (evidence) await mkdir(evidence, { recursive: true });
  const event = workflowEvent;
  const branchHead = event?.pull_request?.head?.sha ?? head;
  const passLines = [], states = [], captures = [], uiChecks = [];
  for (const locale of locales) {
    browser = await browserForFile(pointerLaunch);
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const problems = []; page.on('pageerror', error => problems.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session);
    // Exercise the visitor's real picker path so the host slots change with the component.
    await page.select('#locale', locale);
    await page.waitForFunction(locale => document.querySelector('aithema-session')?.session.locale === locale
      && document.documentElement.lang === locale && document.querySelector('#language-value').textContent === locale.toUpperCase(), { timeout: 20_000 }, locale);
    for (const theme of ['light', 'dark']) for (const width of matrixWidths([1440, 1024, 390], theme, 2, 'visitor-credit')) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      const label = `${locale}-${theme}-${width}`;
      const ait292Capture = async state => {
        if (!evidence || locale !== 'de' || ![1440, 390].includes(width)) return;
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        const file = `ait292-${label}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, optimizeForSpeed: true });
        captures.push({ locale, theme, width, state, file, capture: 'viewport' });
      };
      const actions = async state => {
        const metrics = await shadow(page, c => {
          const r = c.shadowRoot, row = r.querySelector('.host-verify .m-view.on .m-acts');
          const buttons = [...row.querySelectorAll('button')].filter(n => !n.hidden), dot = row.querySelector('.m-dot');
          const boxes = buttons.map(n => n.getBoundingClientRect());
          const sameRow = boxes[0].top === boxes[1].top;
          const pairWidth = boxes.reduce((sum, box, i) => {
            const style = getComputedStyle(buttons[i]);
            return sum + box.width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
          }, 24);
          return { gapPx: sameRow ? boxes[1].left - boxes[0].right : boxes[1].top - boxes[0].bottom, sameRow,
            pairFits: pairWidth <= row.getBoundingClientRect().width + .5,
            linkBelow: boxes[1].top >= boxes[0].bottom && boxes[1].left === boxes[0].left,
            dot: dot?.textContent ?? null, dotVisible: Boolean(dot && !dot.hidden), targets44: boxes.every(box => box.height >= 44),
            labels: buttons.map(n => {
              const range = document.createRange(); range.selectNodeContents(n);
              return { text: n.textContent, lines: new Set([...range.getClientRects()].map(rect => rect.top)).size };
            }) };
        });
        assert.equal(metrics.gapPx, 24, `${label}/${state}: 24 px between actions`);
        assert.equal(metrics.sameRow, metrics.pairFits, `${label}/${state}: link moves below when the pair does not fit`);
        if (!metrics.sameRow) assert.equal(metrics.linkBelow, true, `${label}/${state}: link below the button`);
        assert.equal(metrics.dot, state === 'deleting' ? null : '·', `${label}/${state}: dot only between text actions`);
        assert.equal(metrics.dotVisible, state !== 'deleting');
        assert.equal(metrics.targets44, true);
        for (const button of metrics.labels) assert.equal(button.lines, 1, `${label}/${state}: "${button.text}" is one line`);
        uiChecks.push({ locale, theme, width, state, pass: true, ...metrics });
      };
      const shot = async state => {
        // Wait for fonts, rendered frames and real finite transitions instead
        // of sleeping 160 ms for each of the 148 CI / 444 evidence states.
        // These two states explicitly prove focus placement; retain that focus
        // in their evidence. All other captures clear incidental control focus.
        if (!['deleting', 'privacy-gate'].includes(state)) {
          await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        }
        await page.mouse.move(-1, -1);
        await settle(page); states.push({ locale, theme, width, state });
        if (state === 'credit-used-up-give' && theme === 'dark') {
          const primary = await shadow(page, c => {
            const out = c.shadowRoot.querySelector('.composer-out'), button = out.querySelector('.composer-out__upgrade');
            return { hostLimit: out.hasAttribute('data-host-limit'), visible: getComputedStyle(button).visibility,
              background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color };
          });
          assert.deepEqual(primary, { hostLimit: false, visible: 'visible', background: 'rgb(18, 144, 140)', color: 'rgb(11, 26, 38)' }, `${label}: dark filled primary outside host-limit`);
          uiChecks.push({ locale, theme, width, state: 'dark-filled-primary', pass: true, ...primary });
        }
        if (state === 'credits-used-up-give') {
          const popup = await shadow(page, c => {
            const r = c.shadowRoot, note = r.querySelector('.host-credits__limit'), unit = r.querySelector('.host-credits__equivalence');
            return { noteOwnRow: note.getBoundingClientRect().top >= r.querySelector('.credits-email').getBoundingClientRect().bottom,
              unitLast: unit.parentElement.lastElementChild === unit, unitAfterNote: unit.getBoundingClientRect().top >= note.getBoundingClientRect().bottom };
          });
          assert.deepEqual(popup, { noteOwnRow: true, unitLast: true, unitAfterNote: true }, `${label}: host note has its own row before the unit line`);
          uiChecks.push({ locale, theme, width, state, pass: true, ...popup });
        }
        const language = await page.evaluate(() => ({ picker: document.querySelector('#locale').value,
          language: document.documentElement.lang, accounts: document.querySelectorAll('[slot="account"]').length,
          limitNote: document.querySelector('#demo-credits-limit').textContent,
          heading: document.querySelector('aithema-session').shadowRoot.querySelector('#email-heading').textContent }));
        assert.equal(language.picker, locale); assert.equal(language.language, locale);
        assert.equal(language.heading, locale === 'en' ? 'Email' : 'E-Mail');
        assert.equal(language.accounts, 0, 'email identity never adds a person icon');
        assert.match(language.limitNote, locale === 'en' ? /^Demo only/u : /^Nur Demo/u);
        if (locale === 'en') assert.doesNotMatch(await page.evaluate(() => {
          const c = document.querySelector('aithema-session'); return c.shadowRoot.textContent + c.textContent;
        }), /E-Mail|Konto|Nur Demo|Als Nutzung zählt/u, `${label}/${state}: no German in English captures`);
        if (!evidence) return;
        // Capture actual viewports: full-page painting moves sticky band/dock content over the page.
        await shadow(page, c => {
          window.a2ShotScroll = { page: [scrollX, scrollY], panes: [...c.shadowRoot.querySelectorAll('*')].map(n => [n, n.scrollLeft, n.scrollTop]) };
          if (!c.shadowRoot.querySelector('dialog[open]')) scrollTo({ top: 0, behavior: 'instant' });
        });
        const capture = async suffix => {
          const file = `a2-${label}-${state}${suffix}.png`;
          await page.screenshot({ path: join(evidence, file), fullPage: false, optimizeForSpeed: true });
          captures.push({ locale, theme, width, state, file, capture: 'viewport',
            ...await page.evaluate(() => ({ height: innerHeight, scrollY })) });
        };
        try {
          await capture('');
          if (width === 390) {
            const regions = await shadow(page, c => {
              const r = c.shadowRoot, verify = r.querySelector('dialog.verify-dialog[open]'), settings = r.querySelector('dialog.settings[open]');
              if (verify) return [{ selector: 'dialog.verify-dialog .m-notice', suffix: '-scrolled' }];
              if (settings) return [{ selector: '.m-view.on > :last-child', suffix: '-scrolled' }];
              return [{ selector: '.composer-shell', suffix: '-scrolled' }, { selector: '.display-foot', suffix: '-footer-scrolled' }];
            });
            for (const { selector, suffix } of regions) {
              const scrolled = await shadow(page, (c, selector) => {
                const n = c.shadowRoot.querySelector(selector); if (!n || getComputedStyle(n).visibility === 'hidden') return false;
                const box = n.getBoundingClientRect(), pane = n.closest('.settings__body'), bounds = pane?.getBoundingClientRect();
                const top = bounds?.top ?? c.shadowRoot.querySelector('.band').getBoundingClientRect().bottom, bottom = bounds?.bottom ?? innerHeight;
                if (box.top >= top && box.bottom <= bottom) return false;
                n.scrollIntoView({ block: 'center', behavior: 'instant' });
                if (!pane && selector === '.composer-shell') {
                  // The card grows above the dock: centre their combined region between sticky controls.
                  const r = c.shadowRoot, card = r.querySelector('.question-card'), composer = n.getBoundingClientRect();
                  const start = card.hidden ? composer.top : card.getBoundingClientRect().top, height = composer.bottom - start;
                  const clearTop = r.querySelector('.band').getBoundingClientRect().bottom + 12;
                  const clearBottom = r.querySelector('.display-foot').getBoundingClientRect().top - 12;
                  scrollBy({ top: start - (clearTop + (clearBottom - clearTop - height) / 2), behavior: 'instant' });
                }
                return true;
              }, selector);
              if (scrolled) {
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                if (selector === '.composer-shell') assert.equal(await shadow(page, c => {
                  const r = c.shadowRoot, card = r.querySelector('.question-card').getBoundingClientRect(), composer = r.querySelector('.composer-shell').getBoundingClientRect();
                  return card.top >= r.querySelector('.band').getBoundingClientRect().bottom && composer.bottom <= r.querySelector('.display-foot').getBoundingClientRect().top;
                }), true, `${label}/${state}: the scrolled card and composer clear the sticky band and footer`);
                await capture(suffix);
              }
            }
          }
        } finally {
          await page.evaluate(() => {
            for (const [n, left, top] of window.a2ShotScroll.panes) { n.scrollLeft = left; n.scrollTop = top; }
            scrollTo({ left: window.a2ShotScroll.page[0], top: window.a2ShotScroll.page[1], behavior: 'instant' });
            delete window.a2ShotScroll;
          });
        }
      };
      await fixture(page, locale);
      const dock = await boxes(page, ['.question-card', '.composer-shell']);
      assert.ok(dock[0][3] > 0, 'AIT-132 final-reply card is visible');
      assert.equal(dock[0][1] + dock[0][3], dock[1][1], 'AIT-132 card meets the A2 composer without a gap');
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('#email-input'))), true, 'the inline email input exists');
      await click(page, '.host-credits__button'); await shot('credits-anonymous');
      await click(page, '.credits-email'); await settle(page);
      const fixed = ['.settings__tabs', '.general-new', '.general-consent-manage', '.general-recommended', '.host-verify', '.settings-context', '.settings__footer'];
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), true, 'the credit link opened Settings');
      await click(page, 'dialog.settings [data-tab="model"]'); await settle(page);
      const vial = await shadow(page, c => {
        const gauge = c.shadowRoot.querySelector('[data-gauge="quality"]'), mark = gauge.querySelector('.gauge__unrated'),
          inside = getComputedStyle(gauge.querySelector('.gauge__inside')), ink = getComputedStyle(mark);
        return { vialState: gauge.dataset.state, unrated: gauge.classList.contains('gauge--unrated'), mark: mark.textContent,
          display: ink.display, hatch: inside.backgroundImage, foreground: ink.color, background: ink.backgroundColor,
          hatchInk: getComputedStyle(c).getPropertyValue('--aithema-muted').trim(),
          liquidHidden: getComputedStyle(gauge.querySelector('.gauge__level')).visibility === 'hidden' };
      });
      assert.equal(vial.unrated, true, `${label}: no-rating quality vial`);
      assert.equal(vial.mark, '–'); assert.equal(vial.display, 'block'); assert.equal(vial.liquidHidden, true);
      assert.match(vial.hatch, /repeating-linear-gradient/u);
      const hex = rgb => '#' + rgb.match(/\d+/gu).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
      const markContrast = contrast(hex(vial.foreground), hex(vial.background)), hatchContrast = contrast(vial.hatchInk, hex(vial.background));
      assert.ok(markContrast >= 4.5, `${label}: dash contrast ${markContrast}`);
      assert.ok(hatchContrast >= 3, `${label}: hatch contrast ${hatchContrast}`);
      const gaugeFixed = ['.gauge-panel', '.settings__footer', ...['quality', 'speed', 'cost', 'privacy', 'voice', 'images'].map(kind => `[data-gauge="${kind}"]`)];
      const vialBefore = await boxes(page, gaugeFixed);
      await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } })); await settle(page);
      uiChecks.push({ locale, theme, width, state: 'unrated-vials', pass: true, ...vial, markContrast, hatchContrast,
        displacementPx: unchanged(vialBefore, await boxes(page, gaugeFixed), `${label}/unrated-vials`) });
      await ait292Capture('unrated-vials');
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      const before = await boxes(page, fixed);
      const check = async state => { await settle(page); const displacementPx = unchanged(before, await boxes(page, fixed), `${label}/${state}`); passLines.push({ locale, theme, width, state, displacementPx, pass: true }); await shot(state); };
      await check('no-email');
      const footer = await shadow(page, c => {
        const r = c.shadowRoot, status = r.querySelector('.save-status'), range = document.createRange(); range.selectNodeContents(status);
        return { lines: range.getClientRects().length, reservation: r.querySelectorAll('.save-state-measure').length,
          left: status.getBoundingClientRect().left - r.querySelector('.save-state').getBoundingClientRect().left,
          notice: r.querySelector('#email-notice .m-notice-text').textContent,
          boldAmounts: [...r.querySelectorAll('.m-lead-save strong')].map(n => n.textContent) };
      });
      if (width === 390) { assert.equal(footer.lines, 1, `${label}: automatic-save footer fits one line`); assert.equal(footer.left, 0); }
      assert.equal(footer.reservation, 5); assert.doesNotMatch(footer.notice, /Als Nutzung zählt|Use means/u);
      assert.deepEqual(footer.boldAmounts, locale === 'de' ? ['1.200', '1.800'] : ['1,200', '1,800']);
      uiChecks.push({ locale, theme, width, state: 'no-email', pass: true, ...footer });
      const targets = await shadow(page, c => ['.host-verify .m-in', '.host-verify .m-save', '#email-notice .m-pp'].map(selector => {
        const n = c.shadowRoot.querySelector(selector), rect = n.getBoundingClientRect(), after = getComputedStyle(n, '::after');
        return rect.height + Math.max(0, -(parseFloat(after.top) || 0)) + Math.max(0, -(parseFloat(after.bottom) || 0));
      }));
      const primary = await shadow(page, c => { const button = c.shadowRoot.querySelector('.host-verify .m-save'), style = getComputedStyle(button); return { label: button.textContent, color: style.color, background: style.backgroundColor }; });
      assert.ok(primary.label && primary.color !== primary.background, 'the save label is visible on its primary fill');
      assert.ok(targets.every(height => height >= 44), `44 px capture and privacy targets: ${targets}`);
      await shadow(page, c => { c.shadowRoot.querySelector('#email-input').value = 'reader@example.test'; }); await check('typing');
      await shadow(page, c => { c.shadowRoot.querySelector('#email-input').value = 'reader'; c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit(); }); await check('invalid');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-input'); input.value = 'reader@example.test'; input.dispatchEvent(new Event('input', { bubbles: true })); window.a2.saving = true; c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit(); }); await check('saving');
      await page.evaluate(() => { window.a2.saving = false; }); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-verify').dataset.emailState === 'saved'); await check('email-saved');
      await actions('email-saved');
      await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-email-saved');
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      await click(page, '.m-change'); await check('editing'); await click(page, '.m-cancel');
      await click(page, '.m-delete'); await check('deleting');
      await actions('deleting');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.className), 'm-act m-keep');
      await click(page, '.m-del'); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-verify').dataset.emailState === 'capture');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-input').value), '', 'acknowledged deletion clears the cancelled edit');
      await check('deleted'); passLines.at(-1).emailInputEmpty = true;
      await click(page, 'dialog.settings .done');
      await fixture(page, locale, { address: 'reader@example.test', spent: 15_000_000 });
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page); await click(page, '.m-delete'); await shot('over-spent-delete');
      await click(page, '.m-del'); await settle(page); await shot('over-spent-deleted'); await click(page, 'dialog.settings .done'); await shot('credit-used-up-give');
      await click(page, '.host-credits__button'); await shot('credits-used-up-give');
      await fixture(page, locale, { address: 'reader@example.test', spent: 18_000_000 }); await shot('credit-used-up-none'); await click(page, '.host-credits__button'); await shot('credits-used-up-none');
      await fixture(page, locale, { privacy: false, spent: 12_000_000 });
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      const focus = await shadow(page, c => { const heading = c.shadowRoot.querySelector('#email-heading'); return {
        focused: c.shadowRoot.activeElement === heading, outline: getComputedStyle(heading).outlineStyle, tabindex: heading.tabIndex }; });
      assert.deepEqual(focus, { focused: true, outline: 'none', tabindex: -1 }, `${label}: privacy gate retains heading focus without a ring`);
      uiChecks.push({ locale, theme, width, state: 'privacy-gate', pass: true, ...focus });
      await shot('privacy-gate'); await click(page, 'dialog.settings .done'); await shot('privacy-gate-used-up');
      await fixture(page, locale, { handover: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page); await shot('handover-notice');
      await click(page, 'dialog.settings .done');
      await fixture(page, locale, { delivery: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page); await shot('mail-no-email');
      await click(page, '.verify-entry'); await settle(page); await shot('mail-confirm-dialog');
      const order = await shadow(page, c => {
        const form = c.shadowRoot.querySelector('dialog.verify-dialog form');
        return ['.verify__field', '.verify__note', '.m-notice', '.verify__actions'].map(selector => form.querySelector(selector).getBoundingClientRect().top);
      });
      assert.ok(order.every((top, i) => i === 0 || top > order[i - 1]), `${label}: field, helper, notice, submit`);
      const sendLabel = await shadow(page, c => {
        const form = c.shadowRoot.querySelector('dialog.verify-dialog form'), button = form.querySelector('.verify-send');
        const range = document.createRange(); range.selectNodeContents(button);
        const bounds = button.getBoundingClientRect(), field = form.getBoundingClientRect(), text = range.getBoundingClientRect();
        return { text: button.textContent, lines: new Set([...range.getClientRects()].map(rect => rect.top)).size,
          fits: bounds.left >= field.left && bounds.right <= field.right && text.left >= bounds.left && text.right <= bounds.right };
      });
      assert.equal(sendLabel.lines, 1, `${label}/mail-confirm-dialog: "${sendLabel.text}" is one line`);
      assert.equal(sendLabel.fits, true, `${label}/mail-confirm-dialog: label and button fit the form`);
      uiChecks.push({ locale, theme, width, state: 'mail-confirm-dialog', pass: true, order, sendLabel });
      await shadow(page, c => { c.shadowRoot.querySelector('#verify-dialog-email').value = 'reader@example.test'; c.shadowRoot.querySelector('dialog.verify-dialog form').requestSubmit(); }); await settle(page); await shot('mail-link-sent');
      const sent = await shadow(page, c => {
        const form = c.shadowRoot.querySelector('dialog.verify-dialog form'), pending = form.querySelector('.verify__pending'),
          button = form.querySelector('.verify-resend'), message = form.querySelector('.verify__message');
        const text = document.createRange(); text.selectNodeContents(pending.querySelector('.verify__address'));
        const address = text.getBoundingClientRect(), change = pending.querySelector('.verify-change').getBoundingClientRect();
        return { confirmation: message.textContent, helper: form.querySelector('.verify__note').textContent,
          inlineChange: Math.abs(address.top + address.height / 2 - change.top - change.height / 2) < 12,
          separator: pending.textContent.match(/reader@example\.test(.*?)((?:Ändern)|Change)/u)?.[1], gapPx: message.getBoundingClientRect().top - button.getBoundingClientRect().bottom,
          widthPx: button.getBoundingClientRect().width, primaryWidthPx: form.querySelector('.verify__primary').getBoundingClientRect().width };
      });
      assert.equal(sent.helper, ''); assert.equal(sent.separator, '\u00a0· '); assert.equal(sent.inlineChange, true, `${label}: Change stays inline`);
      assert.equal(sent.gapPx, 12); assert.ok(sent.widthPx < sent.primaryWidthPx, `${label}: resend hugs its label`);
      assert.match(sent.confirmation, locale === 'de' ? /^Der Bestätigungslink wurde gesendet\./u : /^We sent you a confirmation link/u);
      uiChecks.push({ locale, theme, width, state: 'mail-link-sent', pass: true, ...sent });
      await page.keyboard.press('Escape');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test' }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      await actions('mail-pending');
      assert.equal(await shadow(page, c => {
        const r = c.shadowRoot, prefix = r.querySelector('.host-verify .m-sent-prefix'), address = r.querySelector('.verify-entry-address');
        const range = document.createRange(); range.selectNodeContents(prefix); const textRight = range.getBoundingClientRect().right;
        return { text: prefix.textContent + address.textContent, display: getComputedStyle(prefix.parentElement).display,
          addressGap: address.getBoundingClientRect().left - textRight };
      }).then(m => m.display === 'block' && m.addressGap === 0 && m.text === (locale === 'de' ? 'Link gesendet an ' : 'Link sent to ') + 'reader@example.test'), true, `${label}: one normal space before pending address`);
      await shot('mail-pending'); await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-mail-pending');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test', confirmed: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      await actions('mail-confirmed');
      const alignment = await shadow(page, c => {
        const r = c.shadowRoot, address = r.querySelector('.verify-entry-address'), heading = r.querySelector('#email-heading');
        return { indentPx: address.getBoundingClientRect().left - heading.getBoundingClientRect().left,
          tierText: r.querySelector('.host-verify .m-mail-tier').textContent, gapPx: parseFloat(getComputedStyle(r.querySelector('.host-verify .m-mail-tier')).gap) };
      });
      assert.equal(alignment.indentPx, 0); assert.equal(alignment.gapPx, 0);
      assert.match(alignment.tierText, locale === 'de' ? /Bestätigt\u00a0· Guthaben: 2\.400 Credits/u : /Confirmed\u00a0· Credit: 2,400 Credits/u);
      uiChecks.push({ locale, theme, width, state: 'mail-confirmed', pass: true, ...alignment });
      await shot('mail-confirmed'); await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-mail-confirmed');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test', spent: 18_000_000 }); await shot('credit-used-up-confirm');
      const liveFixed = ['.band', '.question-card', '.composer-dock', '.composer-shell', '.display-foot', '.export', '.concept-bar'];
      await fixture(page, locale, { spent: 0, voiceRunning: true });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('textarea').placeholder), locale === 'de' ? 'Sprechen Sie einfach los – oder tippen Sie.' : 'Just start talking – or type.');
      const heldBefore = await boxes(page, liveFixed);
      await shadow(page, c => {
        window.a2.reserved = 12_000_000;
        c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
        c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
      }); await settle(page);
      await until(page, () => {
        const c = document.querySelector('aithema-session');
        return c.shadowRoot.querySelector('.host-credits__amount').textContent === '0' && !c.session.featureMatrix.best.voice.available;
      });
      const held = await shadow(page, c => {
        const r = c.shadowRoot;
        return { voiceCloses: window.a2.voiceCloses, voiceState: r.querySelector('.audio-rail').dataset.state,
          availableCredits: r.querySelector('.host-credits__amount').textContent,
          railUsedUp: r.querySelector('.audio-rail').hasAttribute('data-used-up'), creditsUsedUp: r.querySelector('.host-credits').dataset.ended === 'true',
          composerUsedUp: r.querySelector('.composer-shell').hasAttribute('data-used-up'), closeDisabled: r.querySelector('.voice-close').disabled,
          newVoiceAvailable: c.session.featureMatrix.best.voice.available };
      });
      assert.deepEqual(held, { voiceCloses: 0, voiceState: 'listening', availableCredits: '0', railUsedUp: false, creditsUsedUp: false, composerUsedUp: false, closeDisabled: false, newVoiceAvailable: false });
      const heldCopy = await shadow(page, c => {
        const r = c.shadowRoot;
        return { composerHint: r.querySelector('.composer-reason').textContent, panelStatus: r.querySelector('.analysis-content .notice').textContent,
          placeholder: r.querySelector('textarea').placeholder };
      });
      const afterCall = locale === 'de' ? 'Schreiben geht nach dem Anruf wieder' : 'You can type again after the call';
      assert.equal(await shadow(page, c => c.session.understanding.readinessAssessed), false, 'the held-call fixture has no assessment');
      assert.equal(await shadow(page, c => c.session.featureMatrix.best.analysis.reason), 'budget denied');
      // AIT-197 R4: this unavailable analysis has a budget reason. Its visitor
      // wording wins over the no-details fallback, even before an assessment.
      assert.deepEqual(heldCopy, { composerHint: afterCall, panelStatus: afterCall, placeholder: locale === 'de' ? 'Sprechen Sie einfach weiter.' : 'Just keep talking.' }, `${label}/full-hold-call: visitor copy`);
      passLines.push({ locale, theme, width, state: 'full-hold-call', displacementPx: unchanged(heldBefore, await boxes(page, liveFixed), `${label}/full-hold-call`), pass: true, ...held, ...heldCopy });
      await shot('full-hold-call');
      if (evidence && theme === 'light' && [390, 1440].includes(width)) {
        const offset = await page.evaluate(() => [scrollX, scrollY]);
        await shadow(page, c => c.shadowRoot.querySelector('textarea').scrollIntoView({ block: 'center', behavior: 'instant' }));
        const visible = await shadow(page, c => {
          const box = c.shadowRoot.querySelector('textarea').getBoundingClientRect();
          return box.top >= c.shadowRoot.querySelector('.band').getBoundingClientRect().bottom && box.bottom <= innerHeight;
        });
        assert.equal(visible, true, `${label}: full-hold placeholder is visible in the viewport`);
        await page.screenshot({ path: join(evidence, `ait155-full-hold-${label}.png`), fullPage: false, optimizeForSpeed: true });
        await page.evaluate(([x, y]) => scrollTo({ left: x, top: y, behavior: 'instant' }), offset);
      }
      await click(page, '.host-credits__button'); await shot('full-hold-credits');
      await shadow(page, c => {
        window.a2.reserved = 0;
        c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
        c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
      });
      await until(page, () => {
        const c = document.querySelector('aithema-session');
        return c.shadowRoot.querySelector('textarea').placeholder === (c.session.locale === 'de' ? 'Sprechen Sie einfach los – oder tippen Sie.' : 'Just start talking – or type.');
      });
      assert.equal(unchanged(heldBefore, await boxes(page, liveFixed), `${label}/full-hold-released`), 0);
      for (const waitingCall of [false, true]) {
        await fixture(page, locale, { spent: 11_990_000, voiceAdmissionFailure: true, waitingCall });
        await click(page, waitingCall ? '.pause' : '.voice-start');
        await until(page, () => window.a2.voiceRequests.length === 1 && document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state !== 'connecting');
        await settle(page);
        const recoveryBefore = await boxes(page, liveFixed), action = waitingCall ? 'resume' : 'retry';
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up')), true);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits').dataset.ended), 'false', 'denial-only recovery stays below the ceiling');
        assert.equal(await page.evaluate(() => window.a2.spent), 11_990_000);
        await shot(`top-up-${action}-denied`);
        await shadow(page, c => {
          window.a2.denyVoice = false;
          c.shadowRoot.querySelector('#email-input').value = 'reader@example.test'; c.shadowRoot.querySelector('.host-verify .m-form').requestSubmit();
        });
        await until(page, () => {
          const r = document.querySelector('aithema-session').shadowRoot;
          return r.querySelector('.host-verify').dataset.emailState === 'saved' && !r.querySelector('.audio-rail').hasAttribute('data-used-up') && !r.querySelector('.composer-shell').hasAttribute('data-used-up');
        }); await settle(page);
        assert.equal(await shadow(page, (c, waiting) => c.shadowRoot.querySelector(waiting ? '.voice-pause' : '.voice-retry').disabled, waitingCall), false);
        assert.equal(await shadow(page, c => c.session.featureMatrix.best.voice.available), true);
        assert.equal(await page.evaluate(() => window.a2.voiceRequests.length), 1, 'top-up never starts or resumes a call automatically');
        passLines.push({ locale, theme, width, state: `top-up-${action}-ready`, displacementPx: unchanged(recoveryBefore, await boxes(page, liveFixed), `${label}/top-up-${action}-ready`), pass: true, voiceAvailable: true, usedUp: false, voiceRequests: 1 });
        await shot(`top-up-${action}-ready`);
        await click(page, waitingCall ? '.pause' : '.voice-retry');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
        // Listening is published before the acknowledged feature repaint and
        // its ResizeObserver reservation. Compare the settled card, as above.
        await settle(page);
        const requests = await page.evaluate(() => window.a2.voiceRequests);
        assert.equal(requests.length, 2);
        if (waitingCall) assert.deepEqual(requests[1], requests[0], 'Resume keeps the same logical call');
        assert.equal(await shadow(page, c => ['.voice-input', '.voice-output', '.voice-close'].every(selector => !c.shadowRoot.querySelector(selector).disabled)), true);
        passLines.push({ locale, theme, width, state: `top-up-${action}-running`, displacementPx: unchanged(recoveryBefore, await boxes(page, liveFixed), `${label}/top-up-${action}-running`), pass: true, voiceState: 'listening', voiceRequests: 2 });
        await shot(`top-up-${action}-running`);
      }
      await fixture(page, locale, { spent: 11_990_000, voiceRunning: true });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      const liveBefore = await boxes(page, liveFixed);
      const creditsBefore = await page.evaluate(() => window.a2.creditsReads);
      await shadow(page, c => { window.a2.spent = 12_000_000; c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }); });
      const endingDisplacement = unchanged(liveBefore, await boxes(page, liveFixed), `${label}/call-ending`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits').dataset.ended), 'true', `${label}: footer shows used-up during call ending`);
      await page.waitForFunction(reads => window.a2.creditsReads > reads, { timeout: 20_000, polling: 40 }, creditsBefore);
      await until(page, () => {
        const root = document.querySelector('aithema-session').shadowRoot;
        return !root.querySelector('.audio-rail').hasAttribute('data-credit-ending') &&
          root.querySelector('.composer-shell').hasAttribute('data-used-up') && root.querySelector('.question-card').inert;
      });
      await settle(page);
      // F7: the 600ms ending phrase is transient. Capture the stable post-hangup state under its own name.
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer-out__title').textContent),
        locale === 'de' ? 'Ihre Credits sind aufgebraucht.' : 'Your credits are used up.', 'AIT-291 host-limit title keeps the reserved composer geometry');
      const capturedRailText = await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent);
      assert.equal(capturedRailText, locale === 'de' ? 'Sprache gerade nicht verfügbar' : 'Voice unavailable right now', `${label}: F7 after-hangup-used-up capture matches its label`);
      passLines.push({ locale, theme, width, state: 'after-hangup-used-up', displacementPx: endingDisplacement, railText: capturedRailText, pass: true }); await shot('after-hangup-used-up');
      const calm = await shadow(page, c => {
        const r = c.shadowRoot, ink = getComputedStyle(r.querySelector('.composer-out__title')).color;
        return { questionReadable: !r.querySelector('.question-card').hidden, answersRest: r.querySelector('.question-card').inert,
          pauseDisabled: r.querySelector('.pause').disabled, neutral: ['.voice-close', '.pause', '.host-credits__used-up'].every(selector => getComputedStyle(r.querySelector(selector)).color === ink) };
      });
      assert.deepEqual(calm, { questionReadable: true, answersRest: true, pauseDisabled: true, neutral: true });
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-out__upgrade')).color), theme === 'dark' ? 'rgb(79, 189, 181)' : 'rgb(14, 111, 108)', 'the host-limit upgrade link keeps the approved START teal');
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-out__upgrade')).backgroundColor), 'rgba(0, 0, 0, 0)', 'the host-limit primary stays a text link in both themes');
      passLines.push({ locale, theme, width, state: 'run-out', displacementPx: unchanged(liveBefore, await boxes(page, liveFixed), `${label}/run-out`), pass: true }); await shot('run-out');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no horizontal overflow');
      await fixture(page, locale);
      const hourBefore = await boxes(page, liveFixed);
      await shadow(page, c => {
        for (const type of ['credits.limit-reached', 'conversation.end-requested']) {
          c.receive({ seq: c.session.seq + 1, type, data: { reason: 'one-hour' } });
        }
      }); await settle(page);
      const oneHour = await shadow(page, c => {
        const r = c.shadowRoot;
        return { title: r.querySelector('.composer-out__title').textContent, body: r.querySelector('.composer-out__body > [data-active="true"]').textContent,
          announcement: r.querySelector('.credit-announcement').textContent, polite: r.querySelector('.credit-announcement').getAttribute('aria-live'),
          duplicateToast: Boolean(r.querySelector('.composer-dock > .status__label')) };
      });
      assert.equal(oneHour.duplicateToast, false); assert.equal(oneHour.polite, 'polite');
      assert.equal(oneHour.announcement, `${oneHour.title} ${oneHour.body}`);
      const hourAfter = await boxes(page, liveFixed);
      if (evidence && JSON.stringify(hourBefore) !== JSON.stringify(hourAfter)) {
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle(page);
        const file = `ait406-one-hour-${label}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false, optimizeForSpeed: true });
        await writeFile(join(evidence, `${file}.json`), JSON.stringify({ locale, theme, width, selectors: liveFixed,
          before: hourBefore, after: hourAfter, settled: await boxes(page, liveFixed),
          fonts: await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-shell')).fontFamily) }, null, 2));
      }
      uiChecks.push({ locale, theme, width, state: 'one-hour-single-announcement', pass: true, ...oneHour,
        displacementPx: unchanged(hourBefore, hourAfter, `${label}/one-hour`) });
      if (theme === 'light') await ait292Capture('one-hour');
    }
    assert.deepEqual(problems, []);
    await browser.close(); browser = null;
  }
  assertMatrixCaseCount('visitor-credit', states.length);
  const stamp = rows => rows.map(row => ({ head, branchHead, ...row }));
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head, branchHead, passLines: stamp([...passLines, ...uiChecks]) }, null, 2));
  if (evidence) await writeFile(join(evidence, `a2-${locales.join('-')}-pass-lines.json`), JSON.stringify({ head, branchHead, runner: 'remote/CI', source: 'shipped component with owner-route fixtures; language selected through the picker', passLines: stamp(passLines), uiChecks: stamp(uiChecks), states, captures }, null, 2));
  for (const row of [...passLines, ...uiChecks].filter(row => [390, 1440].includes(row.width) && ['full-hold-call', 'deleting', 'mail-confirm-dialog', 'unrated-vials', 'one-hour-single-announcement', 'dark-filled-primary'].includes(row.state))) {
    t.diagnostic(`PASS branch-head=${branchHead} source-head=${head} ${row.locale}-${row.theme}-${row.width}/${row.state}${row.displacementPx === 0 ? ' 0 px layout shift' : ''} ${JSON.stringify(row)}`);
  }
  t.diagnostic(`${passLines.length} zero-displacement checks; ${states.length} states; ${captures.length} viewport screenshots across all ${new Set(states.map(row => `${row.locale}/${row.theme}/${row.width}`)).size} viewport/theme/language combinations`);
}

// Tick v4: reuse one page, keeping exact reply identities through every transition.
export async function replyRowsMatrix(t) {
  const { browser, demo } = await reservationPage();
  let page;
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, rows = [], captures = [], pointerRest = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const pointerBoxes = () => shadow(page, c => [...c.shadowRoot.querySelectorAll('.reply-actions, .reply-actions button, .reply-actions svg')]
    .map(n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
  const hoverRow = async () => {
    const [x, y, w, h] = (await boxes(page, ['.reply-actions']))[0];
    await page.mouse.move(x + w / 2, y + h / 2);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.reply-actions').matches(':hover')), true, 'pointer actually hovers the control row');
  };
  const shot = async (name, hover = false) => {
    if (!evidence) return;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1);
    if (hover) await hoverRow();
    await settle(page);
    await page.screenshot({ path: join(evidence, `ait410-${name}.png`), fullPage: false, optimizeForSpeed: true });
    await page.mouse.move(-1, -1);
  };
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    // Linux headless-shell restores hardware-none defaults when touch emulation
    // is reconfigured on a reused page. Configure a fresh target before navigation
    // so Blink's mouse defaults apply consistently; keep every media assertion.
    page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, isMobile: width === 390, hasTouch: width === 390 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session);
    const media = await page.evaluate(() => ({ fine: matchMedia('(hover:hover) and (pointer:fine)').matches,
      hover: matchMedia('(hover:hover)').matches, pointer: matchMedia('(pointer:fine)').matches,
      coarse: matchMedia('(pointer:coarse)').matches }));
    assert.deepEqual(media, { fine: width !== 390, hover: width !== 390, pointer: width !== 390, coarse: width === 390 }, `${width}: asserted mouse/touch media queries`);
    await page.mouse.move(-1, -1);
    await page.select('#locale', locale); await page.select('#theme', theme);
    // Touch emulation can reload the page; install observation afterwards.
    await page.evaluate(async () => {
      const { AudioRail } = await import('/packages/ui/src/audio-rail.js');
      if (!AudioRail.prototype.ait410Render) {
        const render = AudioRail.prototype.render; AudioRail.prototype.ait410Render = render;
        AudioRail.prototype.render = function () { window.ait410Rail = this; return render.call(this); };
      }
    });
    await fixture(page, locale, { voiceAdmissionFailure: true });
    await shadow(page, c => {
      window.a2.denyVoice = false; window.a2.replays = [];
      window.ait410Rail.client.replayReply = async reply => { window.a2.replays.push(reply); return { kind: 'text', text: reply.text }; };
      window.ait410First = c.shadowRoot.querySelector('.turn:not(.user)');
      window.ait410Actions = window.ait410First.querySelector('.reply-actions');
    });
    const original = await boxes(page, ['.turn:not(.user)']);
    for (let i = 2; i <= 3; i++) await shadow(page, (c, { i, width }) => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
      id: `ait410-reply-${i}`, role: 'assistant',
      content: width === 390 ? `Reply ${i}` : `${(c.session.transcript.find(t => t.role === 'assistant').content + ' ').repeat(8)}${i}`,
    } }), { i, width });
    await settle(page);
    // Compare size only: following the growing transcript legitimately scrolls it.
    const afterReplies = await boxes(page, ['.turn:not(.user)']);
    assert.deepEqual(afterReplies[0].slice(2), original[0].slice(2), 'new replies preserve the original reply size exactly');
    assert.equal(await shadow(page, () => window.ait410First.querySelector('.reply-actions') === window.ait410Actions && Boolean(window.ait410Actions)), true, 'each reply keeps the same control row');
    // Reading an earlier reply retains the reader's position when a notice
    // arrives. Explicit bottom-follow behavior has its separate AIT-188 checks.
    await shadow(page, c => {
      const shell = c.shadowRoot.querySelector('.transcript-shell');
      shell.scrollTop = 0; shell.dispatchEvent(new Event('scroll'));
    });
    await settle(page);
    assert.equal(await shadow(page, c => { const s = c.shadowRoot.querySelector('.transcript-shell'); return s.scrollHeight - s.clientHeight > 8; }), true, 'earlier-reply fixture exceeds the bottom-follow threshold');
    const selectors = ['.turn:not(.user)', '.turn:last-child', '.qopts', '.question-card', '.composer-shell'];
    const before = await boxes(page, selectors);
    const iconBefore = await pointerBoxes();
    const presentation = await shadow(page, c => {
      const r = c.shadowRoot, fine = matchMedia('(hover:hover) and (pointer:fine)').matches;
      const ink = getComputedStyle(r.querySelector('.voice-reply-dialog')).color;
      const token = document.createElement('span');
      token.style.cssText = 'position:fixed;visibility:hidden;color:var(--ink-3,var(--aithema-muted))';
      r.append(token); const muted = getComputedStyle(token).color; token.remove();
      // Canvas resolves computed CSS Color 4 bubble fills to sRGB for WCAG contrast.
      const context = new OffscreenCanvas(1, 1).getContext('2d');
      const hex = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
      };
      const controls = [...r.querySelectorAll('.reply-actions button')].map(button => {
        const svg = button.querySelector('svg'), style = getComputedStyle(button), iconStyle = getComputedStyle(svg);
        const rest = iconStyle.visibility, color = style.color;
        const opacity = style.opacity, iconOpacity = iconStyle.opacity;
        const transitionDuration = style.transitionDuration, iconTransitionDuration = iconStyle.transitionDuration;
        const foreground = hex(color), background = hex(getComputedStyle(button.closest('.turn')).backgroundColor);
        const geometry = () => [button.closest('.reply-actions'), button, svg].map(n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
        const restBoxes = geometry();
        button.focus({ preventScroll: true });
        const focus = { visible: getComputedStyle(svg).visibility, color: getComputedStyle(button).color,
          opacity: getComputedStyle(button).opacity, iconOpacity: getComputedStyle(svg).opacity, boxes: geometry() };
        button.blur(); return { rest, color, foreground, background, opacity, iconOpacity, transitionDuration, iconTransitionDuration, restBoxes, focus };
      });
      return { fine, ink, muted, controls };
    });
    assert.equal(presentation.fine, width !== 390, 'presentation uses the asserted pointer media');
    assert.equal(presentation.muted, theme === 'light' ? 'rgb(73, 100, 119)' : 'rgb(157, 180, 196)', 'AIT-422: the r4 rest ink is the existing muted token');
    for (const control of presentation.controls) {
      assert.equal(control.rest, 'visible', 'Tick v4.1: pointer and touch icons are visible at rest');
      assert.equal(control.focus.visible, 'visible', 'native focus reveals the icon');
      unchanged(control.restBoxes, control.focus.boxes, 'focused row, button and icon stay exactly in place');
      if (width !== 390) {
        control.contrast = contrast(control.foreground, control.background);
        assert.ok(control.contrast >= 3, `${locale}/${theme}/${width}: enabled icon contrast ${control.contrast} >= 3:1`);
        assert.equal(control.color, presentation.muted, 'resting pointer icons use ink-3');
        assert.notEqual(control.color, presentation.ink, 'resting pointer icons are muted');
        assert.equal(control.focus.color, presentation.ink, 'pointer focus paints full ink');
        assert.equal(control.opacity, '1'); assert.equal(control.iconOpacity, '1');
        assert.equal(control.focus.opacity, '1'); assert.equal(control.focus.iconOpacity, '1');
        assert.equal(control.transitionDuration, '0s', 'no delayed or faded button reveal');
        assert.equal(control.iconTransitionDuration, '0s', 'no delayed or faded icon reveal');
      }
    }
    unchanged(iconBefore, await pointerBoxes(), 'focus moves neither rows, buttons nor icons');
    if (width !== 390) {
      pointerRest.push({ locale, theme, width, ...media, rest: presentation.controls.map(control => control.rest),
        contrast: presentation.controls.map(control => control.contrast) });
      await hoverRow();
      const hover = await shadow(page, c => [...c.shadowRoot.querySelector('.reply-actions').querySelectorAll('button')].map(n => ({ visibility: getComputedStyle(n.querySelector('svg')).visibility, color: getComputedStyle(n).color,
        opacity: getComputedStyle(n).opacity, iconOpacity: getComputedStyle(n.querySelector('svg')).opacity })));
      for (const control of hover) {
        assert.equal(control.visibility, 'visible'); assert.equal(control.color, presentation.ink, 'row hover paints full ink');
        assert.equal(control.opacity, '1'); assert.equal(control.iconOpacity, '1');
      }
      presentation.hover = hover;
      unchanged(iconBefore, await pointerBoxes(), 'hover moves neither rows, buttons nor icons');
      await page.mouse.move(-1, -1);
    }
    unchanged(before, await boxes(page, selectors), 'focus and hover reserve exactly the same space');
    const record = async state => {
      await settle(page);
      const { after, controls } = await shadow(page, (c, selectors) => ({
        after: selectors.map(selector => { const b = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }),
        controls: [...c.shadowRoot.querySelectorAll('.reply-actions')].map(row => ({
        id: row.parentElement.dataset.id, height: row.getBoundingClientRect().height,
        controls: [...row.querySelectorAll('button')].map(n => ({ disabled: n.disabled, ariaDisabled: n.getAttribute('aria-disabled'),
          description: n.getAttribute('aria-description'), title: n.title, visible: getComputedStyle(n).visibility,
          icons: n.querySelectorAll('svg').length, iconVisibility: getComputedStyle(n.querySelector('svg')).visibility, label: n.getAttribute('aria-label'), text: n.textContent.trim() }))
      })) }), selectors);
      const movementPx = unchanged(before, after, `${locale}/${theme}/${width}/${state}`);
      assert.equal(controls.length, 3, 'all three replies own a row');
      for (const row of controls) {
        assert.equal(row.height, 44); assert.equal(row.controls.length, 2);
        for (const control of row.controls) {
          assert.equal(control.icons, 1); assert.equal(control.text, '', 'icon buttons have no visible labels'); assert.ok(control.label);
          const inCall = state === 'running';
          assert.equal(control.disabled, inCall); assert.equal(control.ariaDisabled, String(inCall));
          assert.equal(control.iconVisibility, 'visible', 'Tick v4.1: all icons remain visible in place');
          if (inCall) assert.equal(control.description, locale === 'de' ? 'Während des Anrufs nicht verfügbar' : 'Not available during a call');
          else assert.equal(control.description, null);
          assert.equal(control.visible, 'visible');
        }
      }
      rows.push({ locale, theme, width, state, fine: media.fine, media, movementPx, before, after, controls, presentation });
    };
    await record('ready');
    if (locale === 'de' && theme === 'light' && width !== 390) {
      await shot(`${width}-light-de-pointer-rest`);
      await shot(`${width}-light-de-pointer-hover`, true);
    }
    await click(page, '.voice-start');
    await until(page, () => window.ait410Rail.state === 'listening');
    await record('running');
    if (width !== 390) {
      const disabledStyles = () => shadow(page, c => [...c.shadowRoot.querySelector('.reply-actions').querySelectorAll('button')]
        .map(n => ({ disabled: n.disabled, color: getComputedStyle(n).color, opacity: getComputedStyle(n).opacity,
          visible: getComputedStyle(n.querySelector('svg')).visibility })));
      const disabledBefore = await disabledStyles(), disabledBoxes = await pointerBoxes();
      for (const control of disabledBefore) {
        assert.equal(control.disabled, true); assert.equal(control.opacity, '0.5', 'native disabled styling remains');
        assert.notEqual(control.color, presentation.ink, 'disabled icon stays muted'); assert.equal(control.visible, 'visible');
      }
      await hoverRow();
      assert.deepEqual(await disabledStyles(), disabledBefore, 'row hover never raises disabled icons to full ink');
      unchanged(disabledBoxes, await pointerBoxes(), 'disabled hover moves neither rows, buttons nor icons');
      presentation.disabledHover = disabledBefore;
      await page.mouse.move(-1, -1);
      if (locale === 'de' && theme === 'light' && width === 1440) await shot('1440-light-de-pointer-mid-call');
    }
    if (evidence && locale === 'de' && theme === 'light' && width === 390) {
      // This is a real reader scroll, leaving the fixture and dock unchanged.
      // Restore it before the next geometry sample so all 60 baselines remain.
      const scrollTop = await shadow(page, c => {
        const r = c.shadowRoot, shell = r.querySelector('.transcript-shell'), previous = shell.scrollTop;
        const last = [...r.querySelectorAll('.reply-actions')].at(-1).getBoundingClientRect();
        const bottom = Math.min(shell.getBoundingClientRect().bottom, r.querySelector('.composer-shell').getBoundingClientRect().top);
        shell.scrollTop += Math.max(0, last.bottom - bottom + 8);
        return previous;
      });
      await settle(page);
      const capture = await shadow(page, c => {
        const r = c.shadowRoot, shell = r.querySelector('.transcript-shell').getBoundingClientRect();
        const top = Math.max(shell.top + 8, r.querySelector('.band').getBoundingClientRect().bottom);
        const bottom = Math.min(shell.bottom, r.querySelector('.composer-shell').getBoundingClientRect().top, innerHeight);
        return { top, bottom, rows: [...r.querySelectorAll('.reply-actions')].map(n => {
          const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height, visible: b.top >= top && b.bottom <= bottom };
        }) };
      });
      assert.equal(capture.rows.length, 3, 'mid-call capture includes all three control rows');
      assert.ok(capture.rows.every(row => row.visible && row.height === 44), 'all three complete control rows clear the band, transcript clip and dock');
      captures.push({ name: '390-light-de-three-replies-mid-call', ...capture });
      await shot('390-light-de-three-replies-mid-call');
      await shadow(page, (c, top) => { c.shadowRoot.querySelector('.transcript-shell').scrollTop = top; }, scrollTop);
      await settle(page);
    }
    await click(page, '.voice-close');
    await until(page, () => window.ait410Rail.root.dataset.call === 'none');
    await record('hangup');
    await shadow(page, () => window.ait410Rail.notices.recovered({ userUnconfirmed: true }));
    await record('recovery');
    await shadow(page, () => window.ait410Rail.notices.clear());
    await record('cleared');
    // Read and replay every reply, including earlier replies with different bytes.
    for (let index = 0; index < 3; index++) {
      const expected = await shadow(page, (c, index) => c.shadowRoot.querySelectorAll('.reply-actions')[index].parentElement.querySelector('.turn-text').textContent, index);
      for (const action of ['read', 'replay']) {
        await shadow(page, (c, { index, action }) => c.shadowRoot.querySelectorAll('.reply-actions')[index].querySelector(`[data-reply-action=${action}]`).click(), { index, action });
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-text').textContent), expected);
        await click(page, '.voice-reply-close');
      }
    }
    assert.equal(await page.evaluate(() => window.a2.replays.length), 3, 'each replay targets its own reply');
    if (locale === 'de' && theme === 'light' && width === 390) {
      await shadow(page, c => {
        window.a2.spent = 12_000_000;
        c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } });
        c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'visitor' } });
      });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').hasAttribute('data-used-up'));
      assert.equal(await shadow(page, c => c.session.paused && c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up')), true, 'paused budget-denied evidence shows the used-up panel');
      await shot('390-light-de-paused-budget-denied');
    }
    await page.close();
  }
  if (evidence) await writeFile(join(evidence, 'ait410-reply-rows-checks.json'), JSON.stringify({ head, spec: 'Tick v4.1', rows, captures }, null, 2));
  assert.equal(rows.length, 60);
  if (evidence) await writeFile(join(evidence, 'ait410-pointer-rest-checks.json'), JSON.stringify({ head, pointerRest }, null, 2));
  assert.ok(pointerRest.every(row => row.rest.every(visibility => visibility === 'visible')),
    `Tick v4.1: fine-pointer icons must be visible at rest: ${JSON.stringify(pointerRest)}`);
}

// AIT-426 evidence owns fresh pages and its handover-only conversation fixture.
// Never run these scroll/state steps inside the shared credit-state matrix.
export async function impersonalGermanEvidence(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-ait426-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(pointerLaunch), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  t.after(async () => { try { await browser.close(); } finally { await demo.kill(); await rm(directory, { recursive: true, force: true }); } });
  if (evidence) await mkdir(evidence, { recursive: true });
  const checks = [];
  const evidencePage = async ({ handover = false } = {}) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session);
    await page.select('#locale', 'de'); await page.select('#theme', 'light');
    await fixture(page, 'de', { delivery: !handover });
    if (handover) {
      await shadow(page, c => {
        const creditFetch = window.fetch;
        window.fetch = (url, init = {}) => {
          if (new URL(url, location.href).pathname.endsWith('/handover') && (init.method ?? 'GET') === 'GET') {
            return Promise.resolve(Response.json({ offer: { available: true }, handover: null }));
          }
          return creditFetch(url, init);
        };
        const session = structuredClone(c.session);
        session.transcript = session.transcript.filter(turn => turn.role === 'user');
        c.configure({ session, host: { credits: true, verification: { delivery: false, privacyDocumentConfigured: true }, handover: true } });
      });
    }
    await settleEvidenceFrame(page);
    return page;
  };
  await t.test('handover sent copy on an isolated page', async () => {
    const page = await evidencePage({ handover: true });
    await shadow(page, c => c.shadowRoot.querySelector('.handover').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await settleEvidenceFrame(page);
    const targets = ['.handover', '.handover-request', '.handover__state'];
    const before = await boxes(page, targets);
    await shadow(page, async c => {
      const { inputRevision } = await import('/packages/core/src/session.js');
      c.receive({ seq: c.session.seq + 1, type: 'handover.state', data: { status: 'sent', revision: inputRevision(c.session) } });
    });
    await settleEvidenceFrame(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.handover__state').textContent), 'Ihre Anfrage wurde gesendet. Sie erhalten eine persönliche Rückmeldung.');
    const shiftPx = unchanged(before, await boxes(page, targets), 'AIT-426 handover sent');
    assert.equal(await shadow(page, c => {
      const r = c.shadowRoot, state = r.querySelector('.handover__state').getBoundingClientRect();
      return state.top >= r.querySelector('.band').getBoundingClientRect().bottom &&
        state.bottom <= r.querySelector('.composer-shell').getBoundingClientRect().top;
    }), true, 'AIT-426 handover sent text clears the sticky band and composer');
    checks.push({ locale: 'de', theme: 'light', width: 390, state: 'ait-426-handover-sent', pass: true, shiftPx });
    if (evidence) await page.screenshot({ path: join(evidence, 'ait-426-de-light-390-handover-sent.png'), fullPage: false });
    await page.close();
  });
  await t.test('email notice evidence on an isolated page', async () => {
    const page = await evidencePage();
    await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    await settle(page); await click(page, '.verify-entry'); await settleEvidenceFrame(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.verify-dialog[open] .m-notice').textContent),
      'Ihre E-Mail-Adresse wird nur für Ihr Guthaben und später für eine Bestätigungsmail verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.');
    checks.push({ locale: 'de', theme: 'light', width: 390, state: 'ait-426-email-dialog-notice', pass: true });
    if (evidence) await page.screenshot({ path: join(evidence, 'ait-426-de-light-390-email-dialog-notice.png'), fullPage: false });
    await page.close();
  });
  if (evidence) await writeFile(join(evidence, 'ait426-evidence-checks.json'), JSON.stringify({ head, checks }, null, 2));
}
