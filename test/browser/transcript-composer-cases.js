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
  const list = shell.querySelector('ol'), latest = shell.querySelector('.transcript-latest');
  const shellCSS = getComputedStyle(shell), latestCSS = getComputedStyle(latest);
  const paddingTop = parseFloat(shellCSS.paddingTop), paddingBottom = parseFloat(shellCSS.paddingBottom);
  const latestSlot = latest.getBoundingClientRect().height + (parseFloat(latestCSS.marginTop) || 0) + (parseFloat(latestCSS.marginBottom) || 0);
  const noticeHeight = r.querySelector('.voice-notices')?.getBoundingClientRect().height ?? 0;
  return { boxes: Object.fromEntries(['.composer', 'textarea', '.transcript-shell', '.transcript-shell > ol', '.transcript-latest', '.turn:first-child', '.turn:last-child', '.qcard', '.qopts', '.composer-mic', '.audio-rail', '.concept-bar', '.concept-access', ...['.band', '.understanding', '.understanding > .foot', '.display-foot', '.composer-actions .attach', '.send']]
    .filter(selector => r.querySelector(selector)).map(selector => [selector, box(selector)])),
  inputScroll: input.scrollHeight, inputClient: input.clientHeight, value: input.value,
  scroll: shell.scrollTop, extent: shell.scrollHeight, client: shell.clientHeight,
  growth: parseFloat(getComputedStyle(r.querySelector('.workspace')).getPropertyValue('--aithema-composer-growth')),
  noticeParent: r.querySelector('.voice-notices')?.parentElement.className ?? '',
  noticeHeight,
  noCardClearance: { paddingBottom, latestSlot,
    latestSlotTop: latest.getBoundingClientRect().top - (parseFloat(latestCSS.marginTop) || 0),
    contentOverflows: list.getBoundingClientRect().height + noticeHeight + paddingTop + paddingBottom > shell.clientHeight + .5,
    unused: Math.max(0, shell.clientHeight - paddingTop - paddingBottom - list.getBoundingClientRect().height - noticeHeight - latestSlot) },
  listPadding: parseFloat(getComputedStyle(shell.querySelector('ol')).paddingBottom),
  jump: getComputedStyle(r.querySelector('.transcript-latest')).visibility,
  cardHidden: r.querySelector('.qcard').hidden,
  footerHidden: getComputedStyle(r.querySelector('.display-foot')).display === 'none',
  attachHidden: getComputedStyle(r.querySelector('.attach')).display === 'none',
  pageLanguage: document.documentElement.lang,
  legalLabels: [...c.querySelectorAll('#demo-license, #demo-legal-source')].map(link => link.textContent),
  combinedReservations: Object.fromEntries(['.composer-feedback', '.composer-status-slot', '.composer-notice-slot']
    .filter(selector => r.querySelector(selector)).map(selector => {
      const node = r.querySelector(selector), css = getComputedStyle(node);
      return [selector, { box: node.getBoundingClientRect().toJSON(), rowGap: css.rowGap, text: node.innerText }];
    })) };
});
  for (const selector of ['.composer', 'textarea', '.transcript-shell', '.turn:first-child', '.turn:last-child']) positive(state.boxes[selector], selector);
  return state;
};
// D511a keeps short transcripts top-aligned; AIT-400 retains Latest's own
// end slot. Bound additional clearance independently of those two owners.
const noCardClearance = (state, label) => {
  assert.equal(state.cardHidden, true, `${label}: no-card clearance case`);
  for (const selector of ['.composer', '.transcript-shell', '.transcript-shell > ol', '.transcript-latest', '.turn:last-child']) positive(state.boxes[selector], selector);
  const composer = state.boxes['.composer'], pane = state.boxes['.transcript-shell'], last = state.boxes['.turn:last-child'];
  const { paddingBottom, latestSlot, unused } = state.noCardClearance;
  const gap = composer.top - pane.bottom + paddingBottom;
  const rawGap = composer.top - last.bottom;
  const extraGap = rawGap - unused - latestSlot - state.noticeHeight;
  assert.ok(last.bottom <= composer.top - gap + .5, `${label}: last fitting turn clears the composer: ${JSON.stringify({ rawGap, gap })}`);
  assert.ok(gap >= -.5 && gap <= 24.5, `${label}: pane/composer clearance is between 0 and 24px: ${gap}`);
  assert.ok(extraGap >= -.5 && extraGap <= 24.5, `${label}: no duplicated end clearance: ${JSON.stringify({ rawGap, unused, latestSlot, extraGap })}`);
  Object.assign(state.noCardClearance, { gap, rawGap, extraGap });
};
// Coordinator r15: D511a keeps short conversations top-anchored; no latest-gap
// assertion applies there. Keep their independent extra-clearance checks above.
// LEAD r16 option (a): only overflowing, at-latest, no-card content has a <=24px
// gap, measured to the TOP of AIT-400's reserved Latest slot (including its
// leading margin). Retain that slot so toggling Latest never moves controls.
const noCardLatestClearance = (state, label) => {
  assert.equal(state.cardHidden, true, `${label}: no question card`);
  for (const selector of ['.composer', '.transcript-shell', '.transcript-latest', '.turn:last-child']) positive(state.boxes[selector], selector);
  assert.ok(state.extent > state.client + .5, `${label}: transcript genuinely overflows`);
  assert.equal(state.noCardClearance.contentOverflows, true, `${label}: content exceeds the pane independently of Latest's slot`);
  assert.ok(state.scroll > 0, `${label}: overflowing transcript has scrolled`);
  assert.equal(state.jump, 'hidden', `${label}: latest content is read`);
  assert.ok(Math.abs(state.extent - state.client - state.scroll) <= 1, `${label}: transcript is at the native latest position`);
  const gap = state.noCardClearance.latestSlotTop - state.boxes['.turn:last-child'].bottom;
  assert.ok(gap >= -.5 && gap <= 24.5, `${label}: latest turn/reserved-slot gap is between 0 and 24px: ${gap}`);
  Object.assign(state.noCardClearance, { latestGap: gap });
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

export async function transcriptComposerCases(t) {
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
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    t.after(async () => {
      await writeFile(join(evidence, 'ait-511-513-rects.json'), JSON.stringify(records, null, 2));
      await writeFile(join(evidence, 'ait-511-513-fitting.json'), JSON.stringify({ fittingChecks,
        cases: records.filter(row => /^\d+x\d+$/.test(row.label)).map(row => ({ label: row.label, before: row.before })) }, null, 2));
    });
  }
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
    // This fixture configures the component directly, bypassing the demo's
    // session-language path. Paint its host-owned legal slot after breakpoint
    // listeners have settled, using the same labels and licence helper.
    await shadow(page, async (c, locale) => {
      const { [locale]: bundle } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { withDemoConsentCopy } = await import('/demo/consent-copy.js');
      const { paintLicenseLabel } = await import('/demo/license-label.js');
      const slots = withDemoConsentCopy(bundle).host.slots;
      for (const [id, full, short] of [['demo-license', slots.license, slots.licenseShort], ['demo-legal-source', slots.legalSource, slots.legalSourceShort]]) {
        const link = document.getElementById(id);
        link.setAttribute('aria-label', full); link.title = full;
        if (matchMedia('(width < 600px)').matches) {
          const label = document.createElement('span'); label.className = 'demo-legal-short'; label.textContent = short;
          link.replaceChildren(label);
        } else if (id === 'demo-license') paintLicenseLabel(link, full);
        else link.textContent = full;
      }
      document.querySelector('#demo-legal').setAttribute('aria-label', slots.legal);
      window.dispatchEvent(new Event('resize'));
    }, locale);
    await settleEvidenceFrame(page);
    const legal = await page.$$eval('#demo-license, #demo-legal-source', links => links.map(link => link.getAttribute('aria-label') ?? link.textContent));
    assert.deepEqual(legal, locale === 'en' ? ['Licence: AGPL-3.0-only', 'Source and notices']
      : ['Lizenz: AGPL-3.0-only', 'Quellcode und Hinweise'], 'capture fixture legal labels follow the page language');
    const visibleLegal = await page.$$eval('#demo-license, #demo-legal-source', links => links.map(link => link.textContent));
    assert.deepEqual(visibleLegal, width >= 600 ? legal
      : ['AGPL-3.0', locale === 'en' ? 'Source' : 'Quellcode'], 'fixture preserves full desktop and abbreviated phone legal labels');
  };
  const capture = async label => {
    const state = await geometry(page); records.push({ label, ...state });
    if (evidence) await page.screenshot({ path: join(evidence, `${label}.png`), captureBeyondViewport: false });
    return state;
  };
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 640], [1024, 900], [900, 700], [768, 1024], [390, 844]]) {
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
      for (const [label, state] of [['empty', before], ['grown', grown], ['capped', capped]]) {
        noCardClearance(state, `${width}x${height}/${label}`);
        if (state.noCardClearance.contentOverflows) noCardLatestClearance(state, `${width}x${height}/${label}`);
      }
      records.push({ label: `${width}x${height}`, before, grown, capped });
    });
  }
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 640], [900, 700], [768, 1024], [390, 844]]) {
    await t.test(`overflowing latest clearance at every growth size ${width}x${height}`, async () => {
      for (const entrance of ['choice', 'combined']) {
        await reset(width, height, 'en', 'light', { voice: true, turns: 40, entrance });
        for (const [label, lines] of [['empty', 0], ['grown', 12], ['capped', 30]]) {
          await draft(page, lines); await settleEvidenceFrame(page);
          const followed = await geometry(page);
          records.push({ label: `latest-follow-${entrance}-${width}x${height}-${label}`, ...followed });
          noCardLatestClearance(followed, `${entrance}/${width}x${height}/${label}/follow`);
          await shadow(page, c => {
            const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
            shell.scrollTop = 0; shell.dispatchEvent(new Event('scroll'));
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
              id: `latest-${c.session.seq}`, role: 'assistant', content: 'A new fixture reply.' } });
          });
          await settleEvidenceFrame(page);
          assert.equal((await geometry(page)).jump, 'visible', 'an earlier reader is offered Latest');
          await shadow(page, c => c.shadowRoot.querySelector('.transcript-latest').click());
          await settleEvidenceFrame(page);
          const latest = await geometry(page);
          records.push({ label: `latest-click-${entrance}-${width}x${height}-${label}`, ...latest });
          noCardLatestClearance(latest, `${entrance}/${width}x${height}/${label}/Latest`);
        }
      }
    });
  }
  for (const [width, height] of [[1440, 900], [1024, 600], [390, 844]]) {
    await t.test(`AIT-517 contact slots stay pinned through growth and Latest ${width}x${height}`, async () => {
      const contact = () => shadow(page, c => Object.fromEntries(['.sidebar-contact', '.contact-launcher'].map(selector => {
        const node = c.shadowRoot.querySelector(selector);
        return [selector, node.checkVisibility({ checkVisibilityCSS: true }) ? node.getBoundingClientRect().toJSON() : null];
      })));
      const pinned = (before, after, label) => {
        assert.ok(Object.values(before).some(Boolean), `${label}: a contact control is visible`);
        for (const selector of Object.keys(before)) {
          assert.equal(Boolean(after[selector]), Boolean(before[selector]), `${label}: contact route stays unchanged`);
          if (!before[selector]) continue;
          positive(before[selector], selector); positive(after[selector], selector);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[selector][key] - after[selector][key]) <= .5,
            `${label}/${selector}/${key}: ${before[selector][key]} -> ${after[selector][key]}`);
        }
      };
      for (const entrance of ['choice', 'combined']) {
        await reset(width, height, 'en', 'light', { turns: 80, entrance });
        records.push({ label: `contact-restored-${entrance}-${width}x${height}`, ...await geometry(page) });
        // This clone is a restored conversation. Establish follow mode through
        // a visible Latest action instead of assuming that restore discarded
        // its reader position; subsequent typing must preserve native latest.
        await shadow(page, c => {
          const shell = c.shadowRoot.querySelector('.transcript-shell');
          shell.scrollTop = 0; shell.dispatchEvent(new Event('scroll'));
          c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
            id: `contact-follow-start-${c.session.seq}`, role: 'assistant', content: 'A new fixture reply.' } });
        });
        await settleEvidenceFrame(page);
        assert.equal((await geometry(page)).jump, 'visible', 'contact reader can enter Latest before follow-mode growth');
        await shadow(page, c => c.shadowRoot.querySelector('.transcript-latest').click());
        await settleEvidenceFrame(page);
        const before = await geometry(page), beforeContact = await contact();
        records.push({ label: `contact-latest-start-${entrance}-${width}x${height}`, beforeContact, ...before });
        noCardLatestClearance(before, `${entrance}/contact/explicit Latest precondition`);
        for (const [label, lines] of [['empty', 0], ['grown', 12], ['capped', 30]]) {
          await draft(page, lines); await settleEvidenceFrame(page);
          const followed = await geometry(page), followedContact = await contact();
          records.push({ label: `contact-follow-${entrance}-${width}x${height}-${label}`, beforeContact, followedContact, ...followed });
          t.diagnostic(`Contact follow ${entrance}/${width}x${height}/${label}: ${JSON.stringify({ scroll: followed.scroll, extent: followed.extent, client: followed.client, nativeGap: followed.extent - followed.client - followed.scroll, attachHidden: followed.attachHidden })}`);
          if (entrance === 'choice') stable(before, followed, `${entrance}/contact/${label}`);
          else {
            // AIT-506's combined composer deliberately replaces Attach with
            // its mic. Match the existing combined-card/late-question frame
            // checks; never count the hidden Attach's 0x0 box as stable.
            assert.equal(before.attachHidden, true, 'combined Attach is explicitly hidden');
            assert.equal(followed.attachHidden, true, 'combined Attach is explicitly hidden');
            for (const selector of [...frame.filter(selector => selector !== '.composer-actions .attach'), '.composer-mic']) {
              const a = before.boxes[selector], b = followed.boxes[selector]; positive(a, selector); positive(b, selector);
              for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5,
                `${entrance}/contact/${label}/${selector}/${key}: ${a[key]} -> ${b[key]}`);
            }
            for (const state of [before, followed]) positive(state.boxes['.composer'], 'combined contact composer');
            assert.ok(Math.abs(before.boxes['.composer'].bottom - followed.boxes['.composer'].bottom) <= .5, 'combined contact composer bottom stays pinned');
          }
          pinned(beforeContact, followedContact, `${entrance}/growth/${label}`);
          noCardLatestClearance(followed, `${entrance}/contact/${label}/follow`);
          await shadow(page, c => {
            const r = c.shadowRoot, shell = r.querySelector('.transcript-shell');
            shell.scrollTop = 0; shell.dispatchEvent(new Event('scroll'));
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: {
              id: `contact-latest-${c.session.seq}`, role: 'assistant', content: 'A new fixture reply.' } });
          });
          await settleEvidenceFrame(page);
          assert.equal((await geometry(page)).jump, 'visible', 'contact reader is offered Latest');
          await shadow(page, c => c.shadowRoot.querySelector('.transcript-latest').click());
          await settleEvidenceFrame(page);
          const latest = await geometry(page), latestContact = await contact();
          noCardLatestClearance(latest, `${entrance}/contact/${label}/Latest`);
          pinned(beforeContact, latestContact, `${entrance}/Latest/${label}`);
          records.push({ label: `contact-${entrance}-${width}x${height}-${label}`, beforeContact, followedContact, latestContact, ...latest });
        }
      }
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
      for (const entrance of ['choice', 'combined']) {
        await reset(width, width === 390 ? 844 : 900, locale, theme, { usedUp: true, entrance });
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer-out').checkVisibility({ visibilityProperty: true })), true, 'used-up copy is visible in each entrance');
        await capture(`ait-513-${entrance}-${locale}-${theme}-${width}-used-up`);
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
  await t.test('phone card mode changes keep the overview frame fixed during draft growth', async () => {
    for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
      await reset(390, 728, locale, theme, { voice: true, card: true });
      await shadow(page, async c => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'growth-question', role: 'assistant', inputRevision: inputRevision(c.session),
          content: c.session.locale === 'de' ? 'Welche Option passt?' : 'Choose?',
          question_short: (c.session.locale === 'de' ? 'Welche dieser Optionen beschreibt Ihr Vorhaben und die vorgesehene Zielgruppe am besten? ' : 'Which of these options would best describe the project and its intended audience? ').repeat(3),
          options: [{ text: 'Option A', likely: true }, { text: 'Option B' }, { text: 'Option C' }] } });
      });
      await settleEvidenceFrame(page); const before = await capture(`ait-513-${locale}-${theme}-390-card-expanded`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), false, 'empty composer leaves room for an expanded card');
      await draft(page, 30); await settleEvidenceFrame(page); const after = await capture(`ait-513-${locale}-${theme}-390-card-compact`);
      records.push({ label: `phone-card-mode-${locale}-${theme}`, before, after });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.qcard').hasAttribute('data-compact')), true, 'visitor growth switches the constrained card to its horizontal row');
      positive(after.boxes['.qopts'], 'compact answer row'); assert.ok(after.boxes['.qopts'].height >= 44, 'compact card preserves answer targets');
      assert.ok(after.inputScroll > after.inputClient, 'the long draft scrolls internally');
      stable(before, after, 'phone card mode change');
    }
  });
  await t.test('combined opener permits draft growth before visitor input without revealing overview', async () => {
    for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390, 900], [1440, 900], [1440, 640], [1024, 640]]) {
      await reset(width, height, locale, theme, { entrance: 'combined', turns: 0, opener: true });
      assert.equal(await shadow(page, async c => {
        const { hasVisitorInput } = await import('/packages/core/src/document-context.js');
        return hasVisitorInput(c.session);
      }), false, 'render-only host opener is not visitor input');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent', 'opener does not reveal overview');
      const before = await geometry(page);
      assert.equal(before.growth, 0, 'empty combined entrance starts at its responsive baseline');
      await draft(page, 12); await settleEvidenceFrame(page); const after = await capture(`ait-513-combined-${locale}-${theme}-${width}x${height}-opener-draft`);
      for (const state of [before, after]) {
        positive(state.boxes['.display-foot'], 'combined entrance footer');
        assert.ok(state.boxes['.composer'].bottom <= state.boxes['.display-foot'].top + .5, 'combined entrance clears the fixed footer');
      }
      assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined field grows before the first visitor message');
      positive(before.boxes['.send'], 'combined entrance Send before'); positive(after.boxes['.send'], 'combined entrance Send after');
      assert.ok(Math.abs(before.boxes['.send'].top - after.boxes['.send'].top) <= .5, 'combined entrance Send stays pinned');
      assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined entrance composer bottom stays pinned');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent', 'unsent drafting does not reveal overview');
      records.push({ label: `combined-opener-${locale}-${theme}-${width}x${height}`, before, after });
    }
  });
  for (const [width, height] of [[1440, 900], [1440, 640], [1024, 640], [390, 844], [390, 620], [390, 568]]) {
    await t.test(`combined entrance grows upward without overlap ${width}x${height}`, async () => {
      for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
        await reset(width, height, locale, theme, { entrance: 'combined' });
        const measure = () => shadow(page, c => {
          const r = c.shadowRoot, box = selector => r.querySelector(selector).getBoundingClientRect().toJSON();
          return { boxes: Object.fromEntries(['.band', '.understanding', '.understanding > .foot', '.display-foot', '.send', '.composer-mic', 'textarea', '.composer-notice', '.composer', '.transcript-shell'].map(selector => [selector, box(selector)])),
            hiddenAttach: getComputedStyle(r.querySelector('.attach')).display === 'none' };
        });
        const before = await measure();
        await capture(`ait-513-combined-${locale}-${theme}-${width}x${height}-short`);
        assert.equal(before.hiddenAttach, true, 'combined entrance keeps Attach hidden');
        await draft(page, 12); await settleEvidenceFrame(page);
        const after = await measure();
        for (const state of [before, after]) for (const [selector, box] of Object.entries(state.boxes)) positive(box, `combined ${selector}`);
        assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined field grows with a multiline draft');
        for (const state of [before, after]) assert.ok(state.boxes['.composer'].bottom <= state.boxes['.display-foot'].top + .5, 'combined composer clears the fixed footer');
        for (const selector of ['.band', '.understanding', '.understanding > .foot', '.display-foot', '.send', '.composer-mic']) {
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
        assert.ok(capped.boxes['.composer'].height <= .4 * height + .5, 'combined composer respects visual viewport cap');
        if (width === 1440) {
          await reset(width, height, locale, theme, { entrance: 'combined', card: true });
          await capture(`${label}-card`); await draft(page, 30); await settleEvidenceFrame(page); await capture(`${label}-card-capped`);
        }
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
    for (const selector of [...frame.filter(selector => selector !== '.composer-actions .attach'), '.composer-mic']) {
      const a = before.boxes[selector], b = after.boxes[selector]; positive(a, selector); positive(b, selector);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `combined card/${selector}/${key}: ${a[key]} -> ${b[key]}`);
    }
    if (voice) {
      positive(before.boxes['.audio-rail'], 'combined rail before'); positive(after.boxes['.audio-rail'], 'combined rail after');
      assert.deepEqual(after.boxes['.audio-rail'], before.boxes['.audio-rail'], 'combined audio rail stays fixed');
    }
    assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined card composer bottom stays pinned');
    records.push({ label: `combined-card-${voice}`, before, after });
  });
  await t.test('short phone keyboard grows at most three lines with stable Send', async () => {
    for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
      await reset(390, 844, locale, theme, { card: true });
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
        await draft(page, 30); await settleHeld(page); const after = await capture(`ait-513-${locale}-${theme}-390-keyboard`);
        stable(before, after, 'keyboard'); assert.ok(after.boxes.textarea.height <= 92.5, 'three 24px lines plus 20px padding');
        assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'short input can grow');
        records.push({ label: `choice-keyboard-${locale}-${theme}`, before, after });
      } finally { await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.originalComposerViewport }); if (globalThis.originalComposerTouch) Object.defineProperty(navigator, 'maxTouchPoints', globalThis.originalComposerTouch); else delete navigator.maxTouchPoints; window.dispatchEvent(new Event('resize')); }); }
    }
  });
  await t.test('combined keyboard keeps its answer strip and pinned actions while the field grows', async () => {
    for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
      await reset(390, 844, locale, theme, { entrance: 'combined', card: true });
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
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').hasAttribute('data-phone-keyboard')), true, 'combined keyboard flag is active');
        await draft(page, 30); await settleHeld(page);
        const after = await capture(`ait-513-combined-${locale}-${theme}-390-keyboard`);
        assert.equal(before.footerHidden, true); assert.equal(after.footerHidden, true, 'combined keyboard explicitly hides footer');
        assert.ok(after.boxes.textarea.height > before.boxes.textarea.height, 'combined keyboard field grows');
        assert.ok(after.boxes.textarea.height <= 92.5, 'combined keyboard permits at most three lines');
        assert.ok(after.boxes['.composer'].height <= .4 * 420 + .5, 'combined keyboard composer respects visual viewport cap');
        positive(after.boxes['.qcard'], 'combined keyboard card'); positive(after.boxes['.qopts'], 'combined keyboard options');
        assert.ok(after.boxes['.qopts'].height >= 44, 'combined keyboard keeps answer options reachable');
        assert.ok(after.boxes['.qcard'].bottom <= after.boxes['.composer'].top + .5, 'combined keyboard card clears input');
        for (const selector of [...frame.filter(selector => !['.composer-actions .attach', '.display-foot'].includes(selector)), '.composer-mic']) {
          const a = before.boxes[selector], b = after.boxes[selector]; positive(a, selector); positive(b, selector);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `combined keyboard/${selector}/${key}: ${a[key]} -> ${b[key]}`);
        }
        assert.ok(Math.abs(before.boxes['.composer'].bottom - after.boxes['.composer'].bottom) <= .5, 'combined keyboard composer bottom stays pinned');
        records.push({ label: `combined-keyboard-${locale}-${theme}`, before, after });
      } finally {
        await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.originalComposerViewport }); if (globalThis.originalComposerTouch) Object.defineProperty(navigator, 'maxTouchPoints', globalThis.originalComposerTouch); else delete navigator.maxTouchPoints; window.dispatchEvent(new Event('resize')); });
      }
    }
  });
  await t.test('a late question preserves the next draft and its card/reply budget', async () => {
    for (const entrance of ['choice', 'combined']) for (const [width, height] of [[1024, 640], [1440, 640], [390, 844]]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
      await reset(width, height, locale, theme, { voice: true, entrance }); await draft(page, 12);
      await shadow(page, c => { globalThis.composerPending = Promise.withResolvers(); c.shadowRoot.querySelector('form.composer').requestSubmit(); });
      await draft(page, 30); await settleEvidenceFrame(page);
      await page.evaluate(() => globalThis.composerPending.resolve());
      await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.send').disabled);
      await settleEvidenceFrame(page);
      const label = `ait-513-late-card-${entrance}-${locale}-${theme}-${width}x${height}`;
      const before = await capture(`${label}-draft`);
      await shadow(page, async c => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        const question = c.session.locale === 'de' ? 'Welche Option passt?' : 'Which option fits?';
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'late-question', role: 'assistant', inputRevision: inputRevision(c.session),
          content: question, question_short: question, options: [{ text: 'Option A', likely: true }, { text: 'Option B' }, { text: 'Option C' }] } });
      });
      await settleEvidenceFrame(page); const after = await capture(label);
      records.push({ label, before, after });
      assert.equal(after.value, before.value, 'a late reply preserves the separate next draft');
      assert.deepEqual(after.boxes['.composer'], before.boxes['.composer'], 'an asynchronous question never resizes the composer');
      if (entrance === 'choice') stable(before, after, 'late question');
      else {
        assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.attach')).display), 'none', 'combined Attach is explicitly hidden');
        for (const selector of [...frame.filter(selector => selector !== '.composer-actions .attach'), '.composer-mic']) {
          const a = before.boxes[selector], b = after.boxes[selector]; positive(a, selector); positive(b, selector);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= .5, `late combined question/${selector}/${key}: ${a[key]} -> ${b[key]}`);
        }
      }
      for (const state of [before, after]) positive(state.boxes['.audio-rail'], 'late question audio rail');
      assert.deepEqual(after.boxes['.audio-rail'], before.boxes['.audio-rail'], 'late question audio rail stays fixed');
      positive(after.boxes['.qcard'], 'late question card'); positive(after.boxes['.qopts'], 'late question options');
      assert.ok(after.boxes['.qcard'].height >= 150, 'a late card retains its 150px minimum');
      assert.ok(after.boxes['.transcript-shell'].height >= 128, 'a late question retains the 128px reply floor');
      assert.ok(after.boxes['.qopts'].height >= 44, 'a late question keeps an answer reachable');
    }
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
    const latest = await shadow(page, c => {
      const button = c.shadowRoot.querySelector('.transcript-latest'), box = button.getBoundingClientRect();
      const hit = c.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { box: box.toJSON(), reachable: hit === button || button.contains(hit) };
    });
    positive(latest.box, 'visible Latest action'); assert.equal(latest.box.height, 44, 'Latest retains a real 44px target');
    assert.equal(latest.reachable, true, 'the floating Latest action is reachable');
    const beforeNotice = await geometry(page);
    await shadow(page, c => { c.shadowRoot.querySelector('.voice-notice--recovered').textContent = 'Connection recovered.'; });
    await settleHeld(page); const afterNotice = await geometry(page); stable(beforeNotice, afterNotice, 'async notice');
    const row = await shadow(page, (c, id) => c.shadowRoot.querySelector(`[data-id="${id}"]`).getBoundingClientRect().toJSON(), target.id);
    positive(row, 'pointer row after notice'); assert.ok(Math.abs(row.top - after.top) <= .5, 'notice preserves pointer row');
    records.push({ label: 'pointer', target, after, row, beforeNotice, afterNotice });
  });
  for (const width of [390, 1024, 1440]) await t.test(`a resting pointer at the followed tail wins when a notice arrives at ${width}`, async () => {
    await reset(width, width === 390 ? 844 : 900, 'en', 'light', { voice: true, turns: 22 });
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
    records.push({ label: `pointer-at-followed-tail-${width}`, before, after, target, row });
  });
  await t.test('added composer content contributes to measured growth and keeps the overview fixed', async () => {
    await reset(390, 844, 'en', 'light', { turns: 22 }); const before = await geometry(page);
    // Model visitor-staged content without an upload or provider request.
    await shadow(page, c => {
      const slot = document.createElement('div'); slot.className = 'fixture-composer-content';
      slot.setAttribute('aria-hidden', 'true'); slot.style.cssText = 'height:88px;grid-column:1/-1';
      c.shadowRoot.querySelector('.composer').prepend(slot);
      c.shadowRoot.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settleEvidenceFrame(page); const after = await geometry(page);
    records.push({ label: 'added-composer-content', before, after });
    const growth = after.boxes['.composer'].height - before.boxes['.composer'].height;
    assert.ok(growth >= 44, 'the added content genuinely grows the composer');
    assert.ok(after.extent - after.client - after.scroll <= 1, 'following reaches the new content end in the same frame');
    assert.ok(Math.abs(after.growth - before.growth - growth) <= .5, 'reported growth includes added composer content');
    const effective = await shadow(page, c => parseFloat(getComputedStyle(c.shadowRoot.querySelector('.workspace')).getPropertyValue('--aithema-composer-height')));
    assert.ok(Math.abs(effective - after.boxes['.composer'].height) <= .5, 'published effective height includes added content');
    stable(before, after, 'added composer content');
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

}

// Keep the manual remote profile entry; CI registers the parent in its measured
// question-card file so top-level timing attribution matches the shard manifest.
if (process.argv[1]?.endsWith('/transcript-composer-cases.js')) {
  test('AIT-511/AIT-513: transcript height, upward composer growth, caps, anchoring and send lifecycle', { timeout: 240_000 }, transcriptComposerCases);
}
