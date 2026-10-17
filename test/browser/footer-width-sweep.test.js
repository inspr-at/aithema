import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, evidenceCommit } from './start2-display-helpers.js';

const widths = [...new Set([320, 390, ...Array.from({ length: 26 }, (_, i) => 600 + i * 20), 699, 700, 701])].sort((a, b) => a - b);
const shotWidths = [600, 680, 700, 701, 1024];
const tolerancePx = .25;
const settle = page => shadow(page, async () => {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

// Measure the original text ranges too: overflow:hidden, ellipsis or a smaller
// fixed box must not turn an overlong translation into a passing measurement.
const geometry = page => shadow(page, c => {
  const root = c.shadowRoot, row = root.querySelector('.display-foot__row');
  const rect = node => {
    const b = node.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  };
  const visible = node => {
    if (!node || !node.getClientRects().length || getComputedStyle(node).visibility !== 'visible') return false;
    for (let parent = node; parent && parent !== root; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      // Fully clipped live regions remain accessible, but paint no footer footprint.
      if (style.display === 'none' || Number(style.opacity) === 0 || style.clipPath === 'inset(50%)') return false;
    }
    // The feature list is an intentional 1px screen-reader-only description,
    // not a painted footer item. Keep clipping checks for all visible labels.
    return !node.closest('.footer-popup, .features');
  };
  const outside = (inner, outer) => Math.max(0, outer.left - inner.left, inner.right - outer.right,
    outer.top - inner.top, inner.bottom - outer.bottom);
  const container = rect(row), footprints = new Map(), violations = [];
  let maxOverflowPx = 0, maxOverlapPx = 0;
  for (const selector of ['.footer-info', '.host-credits', '.footer-right']) {
    const zone = root.querySelector(selector), bounds = rect(zone), painted = { ...bounds };
    const record = (box, limit, item) => {
      const overflow = Math.max(outside(box, limit), outside(box, container));
      maxOverflowPx = Math.max(maxOverflowPx, overflow);
      if (overflow > 0) violations.push({ item, overflowPx: overflow });
      painted.left = Math.min(painted.left, box.left); painted.right = Math.max(painted.right, box.right);
      painted.top = Math.min(painted.top, box.top); painted.bottom = Math.max(painted.bottom, box.bottom);
    };
    record(bounds, container, selector);
    for (const node of zone.querySelectorAll('*')) if (visible(node)) record(rect(node), bounds, node.className);
    const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
    for (let text; (text = walker.nextNode());) {
      if (!text.textContent.trim() || !visible(text.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const box of range.getClientRects()) record(box, rect(text.parentElement), `${text.parentElement.className}: ${text.textContent}`);
    }
    footprints.set(selector, painted);
  }
  const groups = [
    ['.footer-info', '.host-credits', '.footer-right'],
    ['.ai-notice .speaker-sign', '.display-version', '.ai-notice__label', '.ai-notice__short', '.ai-notice__voice'],
    ['.host-credits__stack', '.host-credits__track'],
    ['.host-credits__amount', '.host-credits__total', '.host-credits__unit'],
    ['.engine', '.status'],
    ['.status__label', '.connection-timer'],
  ];
  for (const selectors of groups) {
    const items = selectors.filter(selector => visible(root.querySelector(selector)))
      .map(selector => ({ selector, box: footprints.get(selector) ?? rect(root.querySelector(selector)) }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const overlap = Math.max(0, Math.min(Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left),
        Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)));
      maxOverlapPx = Math.max(maxOverlapPx, overlap);
      if (overlap > 0) violations.push({ items: [a.selector, b.selector], overlapPx: overlap });
    }
  }
  return { maxOverflowPx, maxOverlapPx, violations,
    compact: getComputedStyle(root.querySelector('.host-credits__total')).display === 'none',
    legal: !root.querySelector('.host-legal').hidden,
    measureCompact: getComputedStyle(root.querySelector('.host-credits__measure-total')).display === 'none',
    amount: root.querySelector('.host-credits__amount').textContent };
});

const assertFits = (measurement, label) => {
  assert.ok(measurement.maxOverflowPx <= tolerancePx, `${label}: footer overflow ${JSON.stringify(measurement)}`);
  assert.ok(measurement.maxOverlapPx <= tolerancePx, `${label}: footer overlap ${JSON.stringify(measurement)}`);
};

test('AIT-164: footer width sweep 600–1100/20 plus 699/700/701, DE/EN, full/fewer digits; no overflow, overlap or clipping',
  { timeout: 90_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-footer-sweep-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
    });
    let browser;
    t.after(async () => { await browser?.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
    if (evidence) await mkdir(evidence, { recursive: true });
    const passes = [], summaries = [], shots = [];
    for (const locale of ['de', 'en']) {
      browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, locale),
        env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
      const page = await browser.newPage(), errors = [];
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width: 1100, height: 900 });
      await page.evaluateOnNewDocument(locale => {
        localStorage.setItem('aithema-demo-locale', locale);
        window.ait164Footer = { availableMicro: 24_000_000 };
        const original = window.fetch.bind(window);
        window.fetch = async (url, init = {}) => {
          if (new URL(url, location.href).pathname.endsWith('/credits')) {
            const limitMicro = 24_000_000, availableMicro = window.ait164Footer.availableMicro;
            return Response.json({ exhausted: false, limitSlot: null, lowAtMicro: 0, lowAtMaxMicro: 2_400_000,
              tiers: { current: 'emailConfirmed', next: null, delta: 0, allowancesMicro: { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: limitMicro } },
              balance: { owner: { limitMicro, availableMicro, committedMicro: limitMicro - availableMicro, reservedMicro: 0 } } });
          }
          return original(url, init);
        };
      }, locale);
      // One navigation per locale. Both digit states and every width resize the
      // same live component; only the twenty requested viewports are captured.
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      await shadow(page, async (c, { locale, commit }) => {
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const session = structuredClone(c.session); session.locale = locale; session.demo = false;
        session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
        session.transcript = [
          { id: 'footer-user', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' },
          { id: 'footer-reply', role: 'assistant', content: locale === 'de' ? 'Was soll die Website leisten?' : 'What should the website do?' },
        ];
        c.setAttribute('motion', 'off');
        c.configure({ session, copy, host: { credits: true, library: true, version: { version: '0.0.0', commit } } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
      }, { locale, commit: evidenceCommit });
      const setBalance = async availableMicro => {
        await shadow(page, (c, availableMicro) => {
          window.ait164Footer.availableMicro = availableMicro;
          c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
        }, availableMicro);
        await until(page, availableMicro => {
          const amount = document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent;
          return amount.replace(/[.,]/gu, '') === String(availableMicro / 10_000);
        }, availableMicro);
      };
      const summary = { head: evidenceCommit, locale, widths, digitStates: ['full', 'fewer'], checks: 0, maxOverflowPx: 0, maxOverlapPx: 0 };
      for (const [digits, availableMicro] of [['full', 24_000_000], ['fewer', 980_000]]) {
        await setBalance(availableMicro);
        for (const width of widths) {
          await page.setViewport({ width, height: 900 }); await settle(page);
          const measurement = await geometry(page), label = `HEAD ${evidenceCommit} ${locale}/${width}/${digits}`;
          assertFits(measurement, label);
          assert.equal(measurement.compact, width < (measurement.legal ? 1100 : 700), `${label}: compact boundary`);
          assert.equal(measurement.measureCompact, measurement.compact, `${label}: reserved total uses the same boundary`);
          passes.push({ head: evidenceCommit, locale, width, digits, ...measurement, pass: true }); summary.checks++;
          summary.maxOverflowPx = Math.max(summary.maxOverflowPx, measurement.maxOverflowPx);
          summary.maxOverlapPx = Math.max(summary.maxOverlapPx, measurement.maxOverlapPx);
        }
      }
      // Prove the guard still sees an overlong string when its element clips.
      await page.setViewport({ width: 701, height: 900 }); await settle(page);
      const original = await shadow(page, c => {
        const label = c.shadowRoot.querySelector('.display-version'), original = label.textContent;
        label.style.cssText = `width:${label.getBoundingClientRect().width}px;overflow:hidden;text-overflow:ellipsis;flex:none`;
        label.textContent += ' longer translated footer text'.repeat(12);
        return original;
      });
      const clippedMeasurement = await geometry(page);
      assert.throws(() => assertFits(clippedMeasurement, 'clipped longer string'), /footer overflow/u);
      await shadow(page, (c, original) => {
        const label = c.shadowRoot.querySelector('.display-version'); label.textContent = original; label.removeAttribute('style');
      }, original);
      await setBalance(24_000_000);
      for (const width of shotWidths) for (const theme of ['light', 'dark']) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await settle(page);
        const measurement = await geometry(page); assertFits(measurement, `HEAD ${evidenceCommit} ${locale}/${width}/${theme}/viewport`);
        const file = `ait164-fix2-footer-${locale}-${theme}-${width}.png`;
        if (evidence) {
          await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
          await page.mouse.move(-1, -1); await settle(page);
          await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
        }
        shots.push({ head: evidenceCommit, locale, width, theme, file, captures: 'viewport', ...measurement, pass: true });
      }
      assert.deepEqual(errors, [], locale); summaries.push(summary);
      t.diagnostic(`AIT-164 HEAD ${evidenceCommit} ${locale}: ${summary.checks} footer sweep checks PASS; max overflow ${summary.maxOverflowPx} px; max overlap ${summary.maxOverlapPx} px; tolerance ${tolerancePx} px; clipped longer string rejected`);
      await browser.close(); browser = null;
    }
    if (evidence) await writeFile(join(evidence, 'ait164-fix2-footer-pass-lines.json'), JSON.stringify({
      head: evidenceCommit, tolerancePx, captures: 'viewport', summaries, passes, shots,
    }, null, 2));
    t.diagnostic(`AIT-164 HEAD ${evidenceCommit}: ${passes.length} geometry sweep checks PASS; ${shots.length} footer viewports PASS`);
  });

// AIT-281 deliberately reuses one page for the complete state matrix. Scenario
// controls and labels belong to this fixture; production has no sample roles.
test('AIT-281: actor role state matrix has exactly 0px movement at 1440/1024/390, DE/EN, light/dark',
  { timeout: 90_000 }, async t => {
    const { browserForFile } = await import('./shared-browser.js');
    const directory = await mkdtemp(join(tmpdir(), 'aithema-role-'));
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'role.sqlite'), {
      AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
    });
    const browser = await browserForFile(), page = await browser.newPage(), errors = [];
    t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await page.evaluate(() => {
      const c = document.querySelector('aithema-session'); window.roleBase = structuredClone(c.session);
      const original = window.fetch.bind(window);
      window.fetch = async (url, init = {}) => {
        const path = new URL(url, location.href).pathname, f = window.roleFixture;
        if (f && path.endsWith('/identity')) return Response.json({ roleChoice: f.view });
        if (f && path.endsWith('/identity/role')) {
          f.command = JSON.parse(init.body);
          if (f.state === 'saving') return new Promise(() => {});
          if (f.state === 'error') return Response.json({ error: 'fixture-failure' }, { status: 500 });
          if (f.state === 'stale') { f.view = { ...f.view, role: 'representative', source: 'chosen', reasoning: null, revision: f.view.revision + 1 };
            return Response.json({ error: 'role-conflict', roleChoice: f.view }, { status: 409 }); }
          f.view = { ...f.view, role: f.command.role, source: 'chosen', reasoning: null, revision: f.view.revision + 1 };
          return Response.json({ roleChoice: f.view });
        }
        if (f && path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
          if (init.signal?.aborted) controller.close(); else init.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }));
        return original(url, init);
      };
    });
    const evidence = process.env.AITHEMA_EVIDENCE_DIR, shots = [], pass = [];
    if (evidence) await mkdir(evidence, { recursive: true });
    const states = ['null', 'inferred', 'chosen', 'saving', 'error', 'stale', 'saved', 'unavailable'];
    for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      let baseline, surfaceBaseline;
      for (const state of states) {
        await shadow(page, async (c, { state, locale, theme, width }) => {
          if (state === 'inferred') {
            // A real event updates the still-open null-role component in place.
            const f = window.roleFixture, actor = { type: 'company', evidence: 'inferred', reasoning: f.inference };
            f.state = state; f.view = { ...f.view, role: actor.type, reasoning: actor.reasoning, revision: c.session.seq + 1 };
            c.receive({ seq: f.view.revision, type: 'understanding.updated', data: { ...c.session.understanding, actor } });
            return;
          }
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const labels = { de: { private: 'Privatperson', company: 'Unternehmen', representative: 'Vertretung', agency: 'Agentur' },
            en: { private: 'Private individual', company: 'Company', representative: 'Representative', agency: 'Agency' } };
          const inference = locale === 'de' ? 'Fixture: Sie schreiben „wir“ und sprechen vom Abgleich von Eingangsrechnungen; das deutet auf einen Betrieb mit mehreren Personen hin.'
            : 'Fixture: You write “we” and talk about matching incoming invoices, which points to a business with several people.';
          const view = { available: state !== 'unavailable', roles: Object.keys(labels.en), role: state === 'null' ? null : 'company',
            source: state === 'chosen' ? 'chosen' : 'inferred',
            reasoning: state === 'null' ? null : inference, revision: window.roleBase.seq };
          window.roleFixture = { state, view, inference };
          const session = structuredClone(window.roleBase); session.locale = locale; session.demo = false; session.roleChoice = view;
          session.actor = state === 'null' ? null : { type: 'company', evidence: view.source === 'chosen' ? 'selected' : 'inferred', reasoning: view.reasoning };
          session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
          session.transcript = [{ id: 'role-user', role: 'user', content: locale === 'de' ? 'Wir verlieren Zeit beim Abgleich von Eingangsrechnungen.' : 'We lose time matching incoming invoices.' },
            { id: 'role-assistant', role: 'assistant', content: locale === 'de' ? 'Wer gibt die Rechnungen heute frei?' : 'Who approves invoices today?' }];
          session.understanding = { ...session.understanding, summary: locale === 'de' ? 'Eingangsrechnungen abgleichen' : 'Match incoming invoices', actor: session.actor };
          c.setAttribute('motion', 'off');
          c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
          c.configure({ session, copy, host: { actorRole: { labels } } });
          document.documentElement.lang = locale; document.documentElement.dataset.theme = theme; c.setAttribute('theme', theme);
          const root = c.shadowRoot;
          if (state !== 'unavailable' || width === 390) {
            root.querySelector(width === 390 ? '.settings-open' : '.actor-trigger').click();
            await Promise.resolve();
            if (['saving', 'error', 'stale', 'saved'].includes(state)) {
              root.querySelector((width === 390 ? '.actor-sheet ' : '.actor-popover ')+'input[value=agency]').click();
              await Promise.resolve(); await Promise.resolve();
            }
          }
        }, { state, locale, theme, width });
        const surface = width === 390 ? '.actor-sheet' : '.actor-popover';
        if (['error', 'stale'].includes(state)) await until(page, ({ state, surface }) =>
          document.querySelector('aithema-session').shadowRoot.querySelector(surface+' .actor-status').dataset.phase === state, { state, surface });
        if (state === 'saved') {
          if (width === 390) await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.actor-sheet .actor-status').dataset.phase === 'saved');
          else {
            await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.actor-popover').hidden);
            await shadow(page, c => c.shadowRoot.querySelector('.actor-trigger').click());
          }
        }
        await settle(page);
        const measured = await shadow(page, (c, { width, state }) => {
          const root = c.shadowRoot, surface = root.querySelector(width === 390 ? '.actor-sheet' : '.actor-popover');
          const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
          const rows = [...surface.querySelectorAll('.actor-option')];
          return { page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
            fixed: ['.display-foot', '.footer-info', '.footer-right', '.workspace', '.band', '.actor-role', '.actor-trigger'].map(s => box(root.querySelector(s))),
            surface: state === 'unavailable' ? null : [box(surface), ...rows.map(box), box(surface.querySelector('.actor-status'))],
            rowHeights: rows.map(row => row.getBoundingClientRect().height),
            checked: surface.querySelector('input:checked')?.value, footer: root.querySelector('.actor-trigger-text').textContent,
            sparkle: !root.querySelector('.actor-trigger .actor-spark').hidden,
            muted: getComputedStyle(root.querySelector('.actor-trigger .actor-value')).color === getComputedStyle(root.querySelector('.actor-chevron')).color,
            valueWeight: getComputedStyle(root.querySelector('.actor-trigger .actor-value')).fontWeight,
            triggerVisible: getComputedStyle(root.querySelector('.actor-role')).display !== 'none' && !root.querySelector('.actor-trigger').hidden,
            open: width === 390 ? surface.open : !surface.hidden, account: root.querySelector('.actor-account').hidden,
            reasoning: surface.querySelector('.actor-reason').textContent, status: surface.querySelector('.actor-status').textContent,
            pending: surface.querySelector('[data-pending]')?.dataset.role,
            disabled: [...surface.querySelectorAll('input')].filter(input => input.disabled).length };
        }, { width, state });
        baseline ??= measured.fixed;
        // Revoking the capability hides the trigger, while preserving its slot.
        assert.deepEqual(state === 'unavailable' ? measured.fixed.slice(0, -1) : measured.fixed,
          state === 'unavailable' ? baseline.slice(0, -1) : baseline, `${width}/${theme}/${locale}/${state}: page/footer shifted`);
        assert.equal(measured.page[0], measured.page[1], 'no horizontal page overflow');
        assert.equal(measured.account, true, 'absent host account has no account line');
        if (state !== 'unavailable') {
          surfaceBaseline ??= measured.surface;
          assert.deepEqual(measured.surface, surfaceBaseline, `${width}/${theme}/${locale}/${state}: surface/rows shifted`);
          assert.ok(measured.rowHeights.every(height => height === (width === 390 ? 50 : 44)),
            `${width}/${theme}/${locale}/${state}: role row heights ${JSON.stringify(measured.rowHeights)}`);
          assert.equal(measured.open, true);
          assert.equal(measured.triggerVisible, width !== 390);
          assert.equal(measured.valueWeight, state === 'null' ? '400' : '500');
          assert.equal(measured.muted, state === 'null');
          if (state === 'null') {
            assert.equal(measured.footer, locale === 'de' ? 'Rolle: noch offen' : 'Role: not set');
            assert.equal(measured.reasoning, locale === 'de' ? 'Noch nicht eingeschätzt.' : 'Not assessed yet.');
            assert.equal(measured.status, locale === 'de' ? 'Wird beim Auswählen gespeichert.' : 'Saved as soon as you choose.');
            assert.equal(measured.checked, undefined); assert.equal(measured.sparkle, false); assert.equal(measured.muted, true);
            if (width !== 390) {
              const trigger = await page.$(`::-p-aria([name="${measured.footer}"][role="button"])`);
              assert.ok(trigger, 'null trigger accessible name has no inferred suffix'); await trigger.dispose();
            }
          }
          if (state === 'inferred') { assert.equal(measured.checked, 'company'); assert.equal(measured.sparkle, true); }
          if (state === 'saving') { assert.equal(measured.pending, 'agency'); assert.equal(measured.disabled, 3); assert.match(measured.footer, /Unternehmen|Company/u); }
          if (state === 'error') assert.equal(measured.checked, 'company');
          if (state === 'stale') assert.equal(measured.checked, 'representative');
          if (state === 'saved') assert.equal(measured.checked, 'agency');
        } else { assert.equal(measured.triggerVisible, false); assert.equal(measured.open, width === 390); }
        const line = `PASS ${width} ${theme} ${locale} ${state === 'inferred' ? 'null→inferred' : state}: page/footer/surface/rows 0px; account=none`;
        pass.push(line);
        if (evidence) {
          await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
          await page.mouse.move(-1, -1); await settle(page);
          const name = `role-${width}-${theme}-${locale}-${state}.png`;
          await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false });
          shots.push({ file: name, head: evidenceCommit, width, theme, locale, state, surface: width === 390 ? 'sheet' : state === 'unavailable' ? 'none' : 'popover', account: 'none', viewport: true, reducedMotion: true, blurred: true, pass: line });
        }
      }
    }
    assert.deepEqual(errors, []);
    assert.equal(pass.length, 96);
    t.diagnostic(`PASS AIT-281: ${pass.length} state/viewport/theme/locale cases; exact 0px movement; one page`);
    if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, fonts: 'Chrome baseline UI/display stacks pinned', shots, pass, errors }, null, 2)+'\n');
  });
