// AIT-511/AIT-513: real layout, fixture-only transport; remote lane or CI only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { settleEvidenceFrame } from './start2-display-helpers.js';

const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const positive = (box, label) => assert.ok(box.width > 0 && box.height > 0, `${label}: positive box ${JSON.stringify(box)}`);
const frame = ['.band', '.understanding', '.understanding > .foot', '.display-foot', '.composer-actions .attach', '.send'];
const geometry = async page => { const state = await shadow(page, c => {
  const r = c.shadowRoot, box = selector => r.querySelector(selector).getBoundingClientRect().toJSON();
  const input = r.querySelector('textarea'), shell = r.querySelector('.transcript-shell');
  return { boxes: Object.fromEntries(['.composer', 'textarea', '.transcript-shell', '.turn:first-child', '.turn:last-child', '.qcard', '.qopts', '.audio-rail', '.concept-bar', '.concept-access', ...['.band', '.understanding', '.understanding > .foot', '.display-foot', '.composer-actions .attach', '.send']]
    .filter(selector => r.querySelector(selector)).map(selector => [selector, box(selector)])),
  inputScroll: input.scrollHeight, inputClient: input.clientHeight, value: input.value,
  scroll: shell.scrollTop, extent: shell.scrollHeight, client: shell.clientHeight,
  growth: parseFloat(getComputedStyle(r.querySelector('.workspace')).getPropertyValue('--aithema-composer-growth')),
  noticeParent: r.querySelector('.voice-notices')?.parentElement.className ?? '',
  noticeHeight: r.querySelector('.voice-notices')?.getBoundingClientRect().height ?? 0,
  listPadding: parseFloat(getComputedStyle(shell.querySelector('ol')).paddingBottom),
  jump: getComputedStyle(r.querySelector('.transcript-latest')).visibility,
  cardHidden: r.querySelector('.qcard').hidden,
  footerHidden: getComputedStyle(r.querySelector('.display-foot')).display === 'none' };
});
  for (const selector of ['.composer', 'textarea', '.transcript-shell', '.turn:first-child', '.turn:last-child']) positive(state.boxes[selector], selector);
  return state;
};
const stable = (before, after, label) => {
  assert.equal(after.footerHidden, before.footerHidden, `${label}: footer visibility stays unchanged`);
  for (const selector of frame) {
    // The existing short-phone keyboard layout explicitly hides the footer.
    // Assert that state above; never compare its 0x0 box as no movement.
    if (selector === '.display-foot' && before.footerHidden) continue;
    const a = before.boxes[selector], b = after.boxes[selector]; positive(a, selector); positive(b, selector);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `${label}/${selector}/${key}: ${a[key]} -> ${b[key]}`);
  }
  for (const state of [before, after]) positive(state.boxes['.composer'], 'composer');
  assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, `${label}: composer bottom`);
};
const settleHeld = page => page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const draft = (page, lines) => shadow(page, (c, lines) => {
  const input = c.shadowRoot.querySelector('textarea'); input.value = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, lines);

test('AIT-511/AIT-513: transcript height, upward composer growth, caps, anchoring and send lifecycle', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-composer-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  }); t.after(() => server.kill());
  const browser = await browserForFile({ args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'] });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.composerSeed = structuredClone(c.session); });
  const records = [], evidence = process.env.AITHEMA_EVIDENCE_DIR; let fittingChecks = 0;
  if (evidence) await mkdir(evidence, { recursive: true });
  const reset = async (width, height, locale = 'en', theme = 'light', { voice = false, card = false, turns = 4, visuals = false, usedUp = false, entrance = 'choice', opener = false } = {}) => {
    await page.mouse.move(0, 0); await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await shadow(page, async (c, options) => {
      const { locale, theme, voice, card, turns, visuals, usedUp, entrance, opener } = options;
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      const { inputRevision } = await import('/packages/core/src/session.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const s = structuredClone(globalThis.composerSeed); s.seq = 10; s.locale = locale; s.inputRevision = 1; s.settings.origin = 'chosen';
      s.settings.visuals = visuals ? 'fixture-image' : 'off';
      if (opener) s.opener = { text: locale === 'de' ? 'Willkommen. Welches Vorhaben soll geklärt werden?' : 'Welcome. What project needs clarification?', locale };
      s.conceptVisualKind = 'image'; s.visualsBound = Boolean(visuals); s.conceptCost = visuals ? { maxMicro: 0 } : null;
      s.concepts = visuals === 'populated' ? [{ id: 'fixture-image', mediaType: 'image/png', turnIds: ['t0'], referenceIds: [], archived: false }] : [];
      s.conceptStatus = { phase: visuals === 'populated' ? 'ready' : 'idle' };
      s.transcript = Array.from({ length: turns }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', content: locale === 'de' ? 'Eine kurze Nachricht.' : 'A short message.' }));
      s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'images', 'html'].map(key => [key, { available: ['text', 'analysis'].includes(key) || voice && key === 'voice' || visuals && key === 'images', reason: 'not configured' }]));
      if (usedUp) s.featureMatrix.best.text = { available: false, reason: 'budget denied' };
      globalThis.composerFailure = false; globalThis.composerPending = null;
      window.fetch = async (url, init = {}) => {
        const path = new URL(url, location.href).pathname;
        if (path.endsWith('/image')) return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
        if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
        if (path.endsWith('/turns')) {
          if (globalThis.composerPending) await globalThis.composerPending.promise;
          if (globalThis.composerFailure) return new Response(null, { status: 503 });
          const body = JSON.parse(init.body); return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
        }
        if (path.endsWith(`/sessions/${s.id}`)) return Response.json(c.session);
        return Response.json({});
      };
      c.configure({ entrance, copy, session: s, ...(voice ? { voiceClient: { manifest, async start() { throw new Error('No voice calls in layout fixtures'); } } } : {}) });
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      document.querySelector('#locale').value = locale; paintUtilities(copy);
      if (card) c.receive({ seq: 11, type: 'turn.final', data: { id: 'question', role: 'assistant', inputRevision: inputRevision(c.session),
        content: locale === 'de' ? 'Welche Option passt?' : 'Which option fits?', question_short: locale === 'de' ? 'Welche Option passt?' : 'Which option fits?',
        options: [{ text: 'Option A', likely: true }, { text: 'Option B' }, { text: 'Option C' }] } });
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }, { locale, theme, voice, card, turns, visuals, usedUp, entrance, opener });
    await settleEvidenceFrame(page);
  };
  const capture = async label => {
    const state = await geometry(page); records.push({ label, ...state });
    if (evidence) await page.screenshot({ path: join(evidence, `${label}.png`), captureBeyondViewport: false });
    return state;
  };
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 640], [900, 700], [768, 1024], [390, 844]]) {
    await t.test(`growth and reclaimed notice space ${width}x${height}`, async () => {
      await reset(width, height, 'en', 'light', { voice: true });
      const before = await geometry(page);
      assert.match(before.noticeParent, /transcript-shell/, 'voice notices belong to transcript end at every width');
      assert.equal(before.noticeHeight, 0, 'no empty voice reservation'); assert.equal(before.listPadding, 0);
      positive(before.boxes['.transcript-shell'], 'transcript'); positive(before.boxes['.turn:first-child'], 'first turn');
      if (before.extent <= before.client + .5) {
        assert.ok(before.boxes['.turn:first-child'].top >= before.boxes['.transcript-shell'].top, 'fitting first turn unclipped');
        fittingChecks++;
      } else assert.ok(before.scroll > 0, 'overflow is handled by transcript scrolling');
      await draft(page, 12); await settleEvidenceFrame(page); const grown = await geometry(page);
      assert.ok(grown.boxes.textarea.height > before.boxes.textarea.height, '12 lines grow textarea');
      assert.ok(grown.growth > 0, 'single measurement owner publishes growth'); stable(before, grown, '12-line growth');
      positive(before.boxes['.audio-rail'], 'rail'); positive(grown.boxes['.audio-rail'], 'rail');
      assert.deepEqual(grown.boxes['.audio-rail'], before.boxes['.audio-rail'], 'audio rail stays fixed');
      await draft(page, 30); await settleEvidenceFrame(page); const capped = await geometry(page);
      assert.ok(capped.inputScroll > capped.inputClient, '30 lines scroll inside the textarea');
      assert.ok(capped.boxes['.composer'].height <= .4 * height + .5, 'whole composer respects visual viewport cap'); stable(before, capped, 'cap');
      records.push({ label: `${width}x${height}`, before, grown, capped });
    });
  }
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    await t.test(`${locale}/${theme}/${width} screenshot states`, async () => {
      await reset(width, width === 390 ? 844 : 900, locale, theme);
      await capture(`ait-511-${locale}-${theme}-${width}-short`);
      await draft(page, 12); await settleEvidenceFrame(page); await capture(`ait-513-${locale}-${theme}-${width}-grown`);
      await draft(page, 30); await settleEvidenceFrame(page); await capture(`ait-513-${locale}-${theme}-${width}-capped`);
      await reset(width, width === 390 ? 844 : 900, locale, theme, { card: true });
      await capture(`ait-511-${locale}-${theme}-${width}-card`);
      await draft(page, 30); await settleEvidenceFrame(page); await capture(`ait-513-${locale}-${theme}-${width}-card-capped`);
      for (const visuals of [true, 'populated']) {
        await reset(width, width === 390 ? 844 : 900, locale, theme, { visuals, voice: true });
        const state = await capture(`ait-511-${locale}-${theme}-${width}-visuals-${visuals}`);
        // Image access moves to the fixed phone dock; measure the visible row,
        // rather than its now-empty desktop parent.
        positive(state.boxes['.concept-access'], 'visual bar'); assert.equal(state.boxes['.concept-access'].height, 44, 'visual bar uses one 44px row');
      }
      const beforeNotice = await geometry(page);
      await shadow(page, async c => {
        const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
        c.shadowRoot.querySelector('.voice-notice--recovered').textContent = copy.voiceRecovered;
      });
      await settleEvidenceFrame(page);
      const notice = await capture(`ait-511-${locale}-${theme}-${width}-recovery-notice`); stable(beforeNotice, notice, 'recovery notice');
      if (width === 1440) {
        await reset(width, 640, locale, theme, { card: true, voice: true });
        await capture(`ait-511-${locale}-${theme}-${width}-short-desktop-card`);
        await draft(page, 30); await settleEvidenceFrame(page); await capture(`ait-513-${locale}-${theme}-${width}-short-desktop-capped`);
        await reset(width, 640, locale, theme, { voice: true, usedUp: true });
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer-out').checkVisibility({ visibilityProperty: true })), true, 'the compact used-up peer is genuinely visible');
        await capture(`ait-513-${locale}-${theme}-${width}-short-desktop-used-up`);
      }
    });
  }
  for (const voice of [false, true]) await t.test(`1024x640 question card stays reachable voice=${voice}`, async () => {
    await reset(1024, 640, 'de', 'dark', { card: true, voice }); const before = await geometry(page);
    await draft(page, 30); await settleEvidenceFrame(page); const after = await geometry(page);
    stable(before, after, 'card-aware growth'); positive(before.boxes['.qcard'], 'card before growth'); positive(after.boxes['.qcard'], 'card'); positive(after.boxes['.qopts'], 'options');
    assert.ok(after.boxes['.qcard'].height >= 150, 'card retains 150px minimum');
    assert.ok(after.boxes['.transcript-shell'].height >= 128, 'reply retains 128px floor');
    assert.ok(after.boxes['.qopts'].height >= 44, 'one option remains reachable');
    const gap = after.boxes['.qcard'].top - after.boxes['.turn:last-child'].bottom;
    assert.ok(gap >= -.5 && gap <= 24.5, `reply/card clearance stays between 0 and 24px: ${gap}`);
    records.push({ label: `card-${voice}`, before, after });
  });
  await t.test('combined opener permits draft growth before visitor input without revealing overview', async () => {
    for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
      await reset(width, 900, locale, theme, { entrance: 'combined', turns: 0, opener: true });
      assert.equal(await shadow(page, async c => {
        const { hasVisitorInput } = await import('/packages/core/src/document-context.js');
        return hasVisitorInput(c.session);
      }), false, 'render-only host opener is not visitor input');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent', 'opener does not reveal overview');
      const before = await geometry(page);
      await draft(page, 12); await settleEvidenceFrame(page); const after = await capture(`ait-513-combined-${locale}-${theme}-${width}-opener-draft`);
      assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined field grows before the first visitor message');
      positive(before.boxes['.send'], 'combined entrance Send before'); positive(after.boxes['.send'], 'combined entrance Send after');
      assert.ok(Math.abs(before.boxes['.send'].top - after.boxes['.send'].top) <= .5, 'combined entrance Send stays pinned');
      assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined entrance composer bottom stays pinned');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent', 'unsent drafting does not reveal overview');
      records.push({ label: `combined-opener-${locale}-${theme}-${width}`, before, after });
    }
  });
  for (const [width, height] of [[1440, 900], [1024, 640], [390, 844], [390, 620], [390, 568]]) {
    await t.test(`combined entrance grows upward without overlap ${width}x${height}`, async () => {
      for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
        await reset(width, height, locale, theme, { entrance: 'combined' });
        const measure = () => shadow(page, c => {
          const r = c.shadowRoot, box = selector => r.querySelector(selector).getBoundingClientRect().toJSON();
          return { boxes: Object.fromEntries(['.band', '.understanding', '.understanding > .foot', '.send', '.composer-mic', 'textarea', '.composer-notice', '.composer', '.transcript-shell'].map(selector => [selector, box(selector)])),
            hiddenAttach: getComputedStyle(r.querySelector('.attach')).display === 'none' };
        });
        const before = await measure();
        await capture(`ait-513-combined-${locale}-${theme}-${width}x${height}-short`);
        assert.equal(before.hiddenAttach, true, 'combined entrance keeps Attach hidden');
        await draft(page, 12); await settleEvidenceFrame(page);
        const after = await measure();
        for (const state of [before, after]) for (const [selector, box] of Object.entries(state.boxes)) positive(box, `combined ${selector}`);
        assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined field grows with a multiline draft');
        for (const selector of ['.band', '.understanding', '.understanding > .foot', '.send', '.composer-mic']) {
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before.boxes[selector][key] - after.boxes[selector][key]) <= .5,
            `combined ${width}x${height}/${selector}/${key}: ${before.boxes[selector][key]} -> ${after.boxes[selector][key]}`);
        }
        assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined composer bottom stays pinned');
        assert.ok(after.boxes['.transcript-shell'].bottom <= after.boxes['.composer'].top + .5, 'combined transcript clears composer');
        for (const selector of ['.send', '.composer-mic']) assert.ok(after.boxes.textarea.right <= after.boxes[selector].left + .5, 'combined field clears actions');
        const label = `ait-513-combined-${locale}-${theme}-${width}x${height}`;
        await capture(label); records.push({ label: `${label}-frame`, before, after });
        await draft(page, 30); await settleEvidenceFrame(page);
        const capped = await capture(`${label}-capped`);
        assert.ok(capped.inputScroll > capped.inputClient, 'combined capped field scrolls internally');
      }
    });
  }
  for (const voice of [false, true]) await t.test(`combined 1024x640 retains reply and question budget voice=${voice}`, async () => {
    await reset(1024, 640, 'de', 'dark', { entrance: 'combined', card: true, voice });
    const before = await geometry(page);
    await draft(page, 30); await settleEvidenceFrame(page);
    const after = await capture(`ait-513-combined-de-dark-1024-card-${voice}`);
    positive(after.boxes['.qcard'], 'combined card'); positive(after.boxes['.qopts'], 'combined options');
    assert.ok(after.boxes['.qcard'].height >= 150, 'combined card retains 150px minimum');
    assert.ok(after.boxes['.transcript-shell'].height >= 128, 'combined reply retains 128px floor');
    assert.ok(after.boxes['.qopts'].height >= 44, 'combined card options remain reachable');
    assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined card budget permits draft growth');
    assert.ok(after.inputScroll > after.inputClient, 'combined card caps long draft internally');
    const gap = after.boxes['.qcard'].top - after.boxes['.turn:last-child'].bottom;
    assert.ok(gap >= -.5 && gap <= 24.5, `combined reply/card clearance stays between 0 and 24px: ${gap}`);
    for (const selector of frame.filter(selector => selector !== '.composer-actions .attach')) {
      const a = before.boxes[selector], b = after.boxes[selector]; positive(a, selector); positive(b, selector);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `combined card/${selector}/${key}: ${a[key]} -> ${b[key]}`);
    }
    assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined card composer bottom stays pinned');
    records.push({ label: `combined-card-${voice}`, before, after });
  });
  await t.test('short phone keyboard grows at most three lines with stable Send', async () => {
    await reset(390, 844, 'de', 'dark', { card: true });
    await page.evaluate(() => {
      globalThis.originalComposerViewport = visualViewport; globalThis.originalComposerTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
      const viewport = new EventTarget(); Object.assign(viewport, { height: 420, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      document.querySelector('aithema-session').shadowRoot.querySelector('textarea').focus({ preventScroll: true });
      window.dispatchEvent(new Event('resize'));
    });
    try {
      await settleHeld(page); const before = await geometry(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').hasAttribute('data-phone-keyboard')), true, 'the visual keyboard is open with composer focus');
      await draft(page, 30); await settleHeld(page); const after = await capture('ait-513-de-dark-390-keyboard');
      stable(before, after, 'keyboard'); assert.ok(after.boxes.textarea.height <= 92.5, 'three 24px lines plus 20px padding');
      assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'short input can grow');
    } finally { await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.originalComposerViewport }); if (globalThis.originalComposerTouch) Object.defineProperty(navigator, 'maxTouchPoints', globalThis.originalComposerTouch); else delete navigator.maxTouchPoints; window.dispatchEvent(new Event('resize')); }); }
  });
  await t.test('failed send retains height; chip retains draft; successful typed send resets', async () => {
    await reset(1440, 900, 'en', 'light', { card: true }); await draft(page, 12); await settleEvidenceFrame(page);
    const grown = await geometry(page);
    await page.evaluate(() => { globalThis.composerFailure = true; document.querySelector('aithema-session').shadowRoot.querySelector('form.composer').requestSubmit(); });
    await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.send').disabled); await settleEvidenceFrame(page);
    assert.equal((await geometry(page)).boxes.textarea.height, grown.boxes.textarea.height, 'failure keeps size');
    await shadow(page, c => { globalThis.composerFailure = false; c.shadowRoot.querySelector('.qopt').click(); });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.qcard').hidden); await settleEvidenceFrame(page);
    const chip = await geometry(page); assert.equal(chip.value, grown.value); assert.equal(chip.boxes.textarea.height, grown.boxes.textarea.height, 'chip keeps draft size');
    await shadow(page, c => c.shadowRoot.querySelector('form.composer').requestSubmit());
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('textarea').value === ''); await settleEvidenceFrame(page);
    assert.ok((await geometry(page)).boxes.textarea.height < grown.boxes.textarea.height, 'successful send resets size');
  });
  await t.test('resting transcript pointer preserves rows during growth and recovery notice; Latest appears', async () => {
    await reset(1440, 900, 'en', 'light', { voice: true, turns: 22 });
    const target = await shadow(page, c => {
      const shell = c.shadowRoot.querySelector('.transcript-shell'); shell.scrollTop = Math.max(0, shell.scrollTop - 90);
      const bounds = shell.getBoundingClientRect();
      const row = [...shell.querySelectorAll('.turn')].find(n => n.getBoundingClientRect().top > bounds.top + 20);
      return { id: row.dataset.id, box: row.getBoundingClientRect().toJSON() };
    }); positive(target.box, 'pointer row');
    await page.mouse.move(target.box.x + 12, target.box.y + 12); await settleHeld(page);
    assert.equal(await shadow(page, (c, point) => c.shadowRoot.elementFromPoint(point.x + 12, point.y + 12)?.closest('.turn')?.dataset.id, target.box), target.id, 'the actual pointer rests on the measured row');
    await draft(page, 12); await settleHeld(page);
    const after = await shadow(page, (c, id) => c.shadowRoot.querySelector(`[data-id="${id}"]`).getBoundingClientRect().toJSON(), target.id);
    positive(after, 'pointer row after growth'); assert.ok(Math.abs(after.top - target.box.top) <= .5, 'resting row remains still');
    assert.equal((await geometry(page)).jump, 'visible', 'Latest offers the newly occluded tail');
    const beforeNotice = await geometry(page);
    await shadow(page, c => { c.shadowRoot.querySelector('.voice-notice--recovered').textContent = 'Connection recovered.'; });
    await settleHeld(page); const afterNotice = await geometry(page); stable(beforeNotice, afterNotice, 'async notice');
    const row = await shadow(page, (c, id) => c.shadowRoot.querySelector(`[data-id="${id}"]`).getBoundingClientRect().toJSON(), target.id);
    positive(row, 'pointer row after notice'); assert.ok(Math.abs(row.top - after.top) <= .5, 'notice preserves pointer row');
    records.push({ label: 'pointer', target, after, row, beforeNotice, afterNotice });
  });
  await t.test('a resting pointer at the followed tail wins when a notice arrives', async () => {
    await reset(1440, 900, 'en', 'light', { voice: true, turns: 22 });
    const before = await geometry(page); assert.match(before.noticeParent, /transcript-shell/);
    const target = await shadow(page, c => {
      const r = c.shadowRoot, bounds = r.querySelector('.transcript-shell').getBoundingClientRect();
      const row = [...r.querySelectorAll('.turn')].find(n => n.getBoundingClientRect().top > bounds.top + 20);
      return { id: row.dataset.id, box: row.getBoundingClientRect().toJSON() };
    }); positive(target.box, 'followed pointer row');
    await page.mouse.move(target.box.x + 12, target.box.y + 12); await settleHeld(page);
    assert.equal(await shadow(page, (c, point) => c.shadowRoot.elementFromPoint(point.x + 12, point.y + 12)?.closest('.turn')?.dataset.id, target.box), target.id);
    await shadow(page, c => { c.shadowRoot.querySelector('.voice-notice--recovered').textContent = 'Connection recovered.'; });
    await settleHeld(page); const after = await geometry(page); stable(before, after, 'followed notice');
    const row = await shadow(page, (c, id) => c.shadowRoot.querySelector(`[data-id="${id}"]`).getBoundingClientRect().toJSON(), target.id);
    positive(row, 'followed pointer row after notice'); assert.ok(Math.abs(row.top - target.box.top) <= .5, 'a notice cannot move a row even when follow was active before pointer entry');
    records.push({ label: 'pointer-at-followed-tail', before, after, target, row });
  });
  await t.test('scrollHeight fallback grows and caps without native field-sizing', async () => {
    await reset(1440, 900); const before = await geometry(page);
    await page.evaluate(() => {
      globalThis.composerNativeSupports = CSS.supports;
      CSS.supports = function (...args) { return args[0] === 'field-sizing' ? false : globalThis.composerNativeSupports.apply(this, args); };
    });
    try {
      await draft(page, 12); await settleEvidenceFrame(page); const grown = await geometry(page);
      assert.ok(grown.boxes.textarea.height > before.boxes.textarea.height, 'fallback grows'); stable(before, grown, 'fallback');
      await draft(page, 30); await settleEvidenceFrame(page); const capped = await geometry(page);
      assert.ok(capped.inputScroll > capped.inputClient, 'fallback caps and scrolls');
      assert.ok(capped.boxes['.composer'].height <= 360.5, 'fallback respects the same whole-composer cap');
      records.push({ label: 'fallback', before, grown, capped });
    } finally { await page.evaluate(() => { CSS.supports = globalThis.composerNativeSupports; }); }
  });
  await t.test('embedded host height keeps the composer bottom fixed', async () => {
    await reset(1440, 900);
    await shadow(page, c => c.style.setProperty('--aithema-height', '720px'));
    try {
      await settleEvidenceFrame(page); const before = await geometry(page);
      await draft(page, 12); await settleEvidenceFrame(page); const after = await geometry(page);
      stable(before, after, 'embedded'); records.push({ label: 'embedded-720', before, after });
    } finally { await shadow(page, c => c.style.removeProperty('--aithema-height')); }
  });
  await t.test('edits during a pending send keep the new draft and its height', async () => {
    await reset(1440, 900); const initial = await geometry(page); await draft(page, 12);
    await shadow(page, c => { globalThis.composerPending = Promise.withResolvers(); c.shadowRoot.querySelector('form.composer').requestSubmit(); });
    await draft(page, 30); await settleEvidenceFrame(page); const edited = await geometry(page);
    assert.ok(edited.boxes.textarea.height > initial.boxes.textarea.height, 'the pending draft grows');
    await page.evaluate(() => globalThis.composerPending.resolve());
    await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.send').disabled); await settleEvidenceFrame(page);
    const accepted = await geometry(page); assert.equal(accepted.value, edited.value); assert.equal(accepted.boxes.textarea.height, edited.boxes.textarea.height, 'acceptance does not reset newer edits');
  });
  await t.test('device send resets height after canonical acceptance', async () => {
    await reset(1440, 900);
    await shadow(page, async c => {
      const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`);
      const session = structuredClone(c.session); session.processingPreset = 'device';
      session.featureMatrix.device = { text: { available: true } };
      c.configure({ copy, session, deviceReasoning: { id: 'fixture', model: 'fixture', async connect() {}, async *stream() { yield JSON.stringify({ content: 'Fixture reply.', question_short: null, options: [] }); } } });
    });
    await draft(page, 12); await settleEvidenceFrame(page); const before = await geometry(page);
    await shadow(page, c => c.shadowRoot.querySelector('form.composer').requestSubmit());
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('textarea').value === '');
    await settleEvidenceFrame(page); assert.ok((await geometry(page)).boxes.textarea.height < before.boxes.textarea.height, 'device clears size');
  });
  assert.ok(fittingChecks >= 4, 'at least four measured size cases prove the fitting first-turn invariant');
  if (evidence) await writeFile(join(evidence, 'ait-511-513-rects.json'), JSON.stringify(records, null, 2));
});
