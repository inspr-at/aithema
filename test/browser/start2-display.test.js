// AIT-131 evidence: the real reference page and component, with deterministic display snapshots and local voice.
// No provider calls, microphone, wallet writes or voice lifecycle work. Run only on the remote browser runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { pixels, samePaint } from './png-pixels.js';
import { browserPath, mockIdentityReads, shadow, until, settle, boxes, layoutBoxes, statusGeometry, sameBoxes, finishRevealEntry, freezeRevealExit, seekReveal, evidenceCommit } from './start2-display-helpers.js';

test('AIT-155: opaque scrolled band, approved scroll-zero paint and 0px layout shift, DE/EN light/dark 390/1024/1440', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-opaque-band-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, passLines = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mockIdentityReads(page);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.opaqueBandSeed = c.session; });
  const approvedBackground = 'linear-gradient(to bottom,color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)),color-mix(in srgb,var(--aithema-accent) 4%,transparent) 70%,transparent)';
  const selectors = ['.band', '.band-orb', '.audio-rail', '.header-actions', '.conversation', '.composer-shell', '.display-foot'];
  const shot = async (label, state) => {
    const file = `ait155-band-${label}-${state}.png`;
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
    return file;
  };
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(window.opaqueBandSeed);
      session.locale = locale; session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
      session.transcript = Array.from({ length: 16 }, (_, i) => ({ id: `opaque-${i}`, role: 'assistant',
        content: (locale === 'de' ? 'Diese Nachricht muss vollständig hinter dem Band verschwinden. ' : 'This message must disappear completely behind the band. ').repeat(8) }));
      c.style.setProperty('--aithema-height', '1600px');
      c.configure({ copy, session, host: { library: true } });
      c.shadowRoot.activeElement?.blur();
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
      for (const [selector, value] of [['#demo-account-label', copy.host.slots.account], ['#demo-account-note', copy.host.slots.accountNote], ['#demo-account-source', copy.host.slots.source]]) document.querySelector(selector).textContent = value;
      c.shadowRoot.querySelector('.transcript-shell').scrollTop = 0; scrollTo(0, 0);
    }, locale);
    await page.mouse.move(0, 500); await settle();
    assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', `${label}: stable paint through the real motion preference`);
    const baseline = await boxes(page, selectors);
    const bandBox = baseline[0], clip = { x: 0, y: bandBox[1], width, height: bandBox[3] };
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').hasAttribute('data-scrolled')), false);
    const originalPaint = Buffer.from(await page.screenshot({ clip }));
    await shadow(page, (c, background) => { c.shadowRoot.querySelector('.band').style.background = background; }, approvedBackground);
    assert.equal(samePaint(originalPaint, Buffer.from(await page.screenshot({ clip }))), true, `${label}: scroll-zero matches main's AIT-131 gradient`);
    assert.deepEqual(await boxes(page, selectors), baseline, `${label}: approved scroll-zero geometry`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').style.removeProperty('background'));
    passLines.push({ head: evidenceCommit, locale, theme, width, state: 'not-scrolled', displacementPx: 0, pass: true, file: await shot(label, 'not-scrolled') });
    await shadow(page, c => {
      const root = c.shadowRoot, band = root.querySelector('.band');
      root.querySelector('.transcript-shell').scrollTop = 0;
      const range = document.createRange(); range.selectNodeContents(root.querySelector('.turn-text'));
      const line = range.getClientRects()[0];
      scrollTo({ top: scrollY + line.top - (band.getBoundingClientRect().height - 24), behavior: 'instant' });
    });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.band').hasAttribute('data-scrolled'));
    const scrolled = await boxes(page, selectors);
    const metrics = await shadow(page, c => {
      const root = c.shadowRoot, band = root.querySelector('.band'), style = getComputedStyle(band), fade = getComputedStyle(band, '::before');
      const probe = document.createElement('span'); probe.style.color = 'color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper))'; root.append(probe);
      const rgb = getComputedStyle(probe).color; probe.remove();
      const ink = getComputedStyle(root.querySelector('.turn-text')).color;
      const range = document.createRange(); range.selectNodeContents(root.querySelector('.turn-text'));
      const line = range.getClientRects()[0], box = band.getBoundingClientRect();
      return { background: style.backgroundColor, backgroundImage: style.backgroundImage, rgb, ink, scrollY,
        orbRight: root.querySelector('.band-orb').getBoundingClientRect().right,
        band: { top: box.top, bottom: box.bottom, height: box.height },
        line: { left: line.left, right: line.right, top: line.top, bottom: line.bottom },
        fade: { position: fade.position, top: fade.top, height: fade.height, pointerEvents: fade.pointerEvents, content: fade.content } };
    });
    assert.ok(metrics.scrollY > 0 && metrics.band.top === 0, `${label}: genuinely scrolled sticky band`);
    assert.equal(metrics.backgroundImage, 'none'); assert.equal(metrics.background, metrics.rgb);
    assert.deepEqual(metrics.fade, { position: 'absolute', top: `${metrics.band.height}px`, height: '12px', pointerEvents: 'none', content: '""' });
    assert.equal(scrolled[0][3], baseline[0][3], `${label}: unchanged band height`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').removeAttribute('data-scrolled'));
    assert.deepEqual(await boxes(page, selectors), scrolled, `${label}: opaque surface and fade cause 0 px layout shift`);
    await shadow(page, c => c.shadowRoot.querySelector('.band').setAttribute('data-scrolled', ''));
    const painted = pixels(Buffer.from(await page.screenshot()));
    await shadow(page, c => { c.shadowRoot.querySelector('.band').style.visibility = 'hidden'; });
    const exposed = pixels(Buffer.from(await page.screenshot()));
    await shadow(page, c => c.shadowRoot.querySelector('.band').style.removeProperty('visibility'));
    const expected = metrics.rgb.match(/[\d.]+/gu).slice(0, 3).map(value => Math.round(Number(value) * 255));
    const ink = metrics.ink.match(/\d+/gu).slice(0, 3).map(Number);
    const rgbAt = (png, x, y) => [...png.result.subarray((y * png.width + x) * png.channels, (y * png.width + x) * png.channels + 3)];
    let textPixels = 0;
    for (let y = Math.max(Math.ceil(metrics.line.top), metrics.band.bottom - 18); y < Math.min(metrics.line.bottom, metrics.band.bottom - 2); y++) {
      // Sample the surface clear of the orb's intentional foreground glass shadow.
      for (let x = Math.max(Math.ceil(metrics.line.left), Math.ceil(metrics.orbRight) + 24); x < Math.min(metrics.line.right, width); x++) {
        if (!rgbAt(exposed, x, y).every((channel, i) => Math.abs(channel - ink[i]) <= 24)) continue;
        textPixels++;
        assert.deepEqual(rgbAt(painted, x, y), expected, `${label}: band pixel ${x},${y} over bubble text equals the opaque band colour`);
      }
    }
    assert.ok(textPixels >= 20, `${label}: sampled actual bubble glyphs under the band (${textPixels})`);
    passLines.push({ head: evidenceCommit, locale, theme, width, state: 'scrolled', displacementPx: 0, pass: true, textPixels, expected, ...metrics, file: await shot(label, 'scrolled') });
    await page.evaluate(() => scrollTo(0, 0));
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.band').hasAttribute('data-scrolled'));
    assert.deepEqual(await boxes(page, selectors), baseline, `${label}: scrolling back restores every box`);
    const restoredPaint = Buffer.from(await page.screenshot({ clip }));
    if (!samePaint(originalPaint, restoredPaint)) {
      if (evidence) {
        await writeFile(join(evidence, `ait155-debug-${label}-original.png`), originalPaint);
        await writeFile(join(evidence, `ait155-debug-${label}-restored.png`), restoredPaint);
      }
    }
    assert.equal(samePaint(originalPaint, restoredPaint), true, `${label}: scrolling back restores main's paint`);
  }
  if (evidence) await writeFile(join(evidence, 'ait155-band-pass-lines.json'), JSON.stringify({ head: evidenceCommit, capture: 'viewport', passLines }, null, 2));
  for (const row of passLines) t.diagnostic(`PASS head=${row.head} ${row.locale}-${row.theme}-${row.width}/${row.state} 0 px layout shift${row.textPixels ? `; ${row.textPixels} opaque pixels over text` : '; AIT-131 main paint preserved'}`);
});

test('AIT-131 r3 demo account keeps shared gaps and its panel inside the viewport down to 320px', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-account-band-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id && !document.querySelector('#demo-account').hidden);
  await shadow(page, c => { globalThis.accountSeed = c.session; });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) for (const folded of [false, true]) {
    const height = width < 600 ? 844 : 900;
    await page.setViewport({ width, height }); await page.select('#theme', theme);
    await page.evaluate(async ({ locale, folded }) => {
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const copy = { en, de }[locale], c = document.querySelector('aithema-session'), s = structuredClone(globalThis.accountSeed);
      s.locale = locale; s.settings.origin = 'chosen'; s.transcript = [{ id: 'account-source', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' }];
      s.identity = { status: 'guest', address: null, verificationRequired: false, assessmentUnlocked: true };
      c.configure({ copy, session: s, host: { library: true, verification: true } });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
      for (const [selector, value] of [['#demo-account-label', copy.host.slots.account], ['#demo-account-note', copy.host.slots.accountNote], ['#demo-account-source', copy.host.slots.source]]) document.querySelector(selector).textContent = value;
      document.querySelector('#demo-account').open = false;
      if (folded) c.shadowRoot.querySelector('.fold').click();
      window.scrollTo(0, 0);
    }, { locale, folded });
    await page.mouse.move(0, 300); await settle();
    const control = await page.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot, account = document.querySelector('#demo-account'), summary = account.querySelector('summary'), label = account.querySelector('#demo-account-label');
      const rect = n => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
      const slot = root.querySelector('slot[name="account"]'), wrap = slot.parentElement;
      const range = document.createRange(); range.selectNodeContents(label);
      const text = range.getBoundingClientRect(), icon = rect(account.querySelector('.utility-icon svg')), chevron = rect(account.querySelector('.utility-chevron svg'));
      return { box: rect(summary), band: rect(root.querySelector('.band')), gear: rect(root.querySelector('.settings-open')), name: summary.getAttribute('aria-label'), title: summary.title,
        inRightGroup: wrap.parentElement.classList.contains('header-actions'), beforeGear: wrap.nextElementSibling.classList.contains('settings-open'),
        label: getComputedStyle(label).display !== 'none', icon, chevron,
        gaps: [text.left - icon.right, chevron.left - text.right], gap: parseFloat(getComputedStyle(summary).gap),
        extras: Boolean(root.querySelector('.host-extras')), emailInSettings: Boolean(root.querySelector('dialog.settings .host-verify')) };
    });
    const context = `${width}/${theme}/${locale}/${folded}: ${JSON.stringify(control)}`;
    assert.equal(control.inRightGroup, true, context); assert.equal(control.beforeGear, true, context);
    assert.ok(control.box.top >= control.band.top && control.box.bottom <= control.band.bottom, context);
    assert.ok(control.box.left >= 0 && control.box.right <= control.gear.left + .5 && control.gear.right <= width + .5, context);
    assert.equal(control.icon.width, 16); assert.equal(control.icon.height, 16); assert.equal(control.label, width >= 600);
    assert.equal(control.name, { de, en }[locale].host.slots.account); assert.equal(control.title, control.name);
    assert.equal(control.extras, false); assert.equal(control.emailInSettings, true);
    if (control.label) {
      assert.equal(control.chevron.width, 10); assert.equal(control.chevron.height, 10);
      for (const gap of control.gaps) assert.ok(Math.abs(gap - control.gap) <= .5, `icon · label · chevron share the menu gap: ${context}`);
    }
    const previous = checks.find(n => n.width === width && n.theme === theme && n.folded === folded);
    if (previous) for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(previous.control.box[key] - control.box[key]) <= .5, `locale preserves the account reserve from ${JSON.stringify(previous.control.box)}: ${context}`);
    if (width === 320) {
      const selectors = ['.host-account', '.settings-open'], before = await boxes(page, selectors);
      // Exercise a wider font's intrinsic label width without changing the evidence's typography.
      await page.$eval('#theme-value', n => { n.style.fontSize = '16px'; });
      const stressed = await boxes(page, selectors);
      await page.$eval('#theme-value', n => n.style.removeProperty('font-size'));
      sameBoxes(before, stressed, 'wider theme glyphs preserve the account and gear reserve');
    }
    const shot = async suffix => {
      if (!evidence) return;
      const name = `r3-demo-account-${folded ? 'folded' : 'unfolded'}-${suffix}-${width}-${theme}-${locale}.png`;
      await page.screenshot({ path: join(evidence, name) }); files.push(name);
    };
    await shot('closed');
    const before = await boxes(page, ['.band', '.band-orb', '.host-account', '.settings-open']);
    await page.click('#demo-account summary'); await settle();
    const panel = await page.$eval('#demo-account', account => {
      const b = account.querySelector('div').getBoundingClientRect(), control = account.querySelector('summary').getBoundingClientRect();
      return { open: account.open, left: b.left, top: b.top, right: b.right, bottom: b.bottom, controlBottom: control.bottom,
        bandBottom: document.querySelector('aithema-session').shadowRoot.querySelector('.band').getBoundingClientRect().bottom,
        position: getComputedStyle(account.querySelector('div')).position };
    });
    assert.equal(panel.open, true); assert.ok(panel.left >= 0 && panel.right <= width + .5 && panel.top >= panel.controlBottom + 5.5 && panel.bottom <= height, JSON.stringify(panel));
    if (width < 400) {
      assert.equal(panel.position, 'fixed'); assert.equal(panel.left, 12); assert.equal(panel.right, width - 12);
      assert.ok(panel.top >= panel.bandBottom + 5.5, 'the viewport panel sits below the whole band');
    }
    sameBoxes(before, await boxes(page, ['.band', '.band-orb', '.host-account', '.settings-open']), 'account disclosure changes no band layout');
    await shot('open'); await page.keyboard.press('Escape'); assert.equal(await page.$eval('#demo-account', n => n.open), false);
    checks.push({ width, theme, locale, folded, control, panel });
  }
  if (evidence) await writeFile(join(evidence, 'r3-demo-account-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-147 Settings footer wraps without moving controls: verification off/unverified/pending/verified, DE/EN, 1440/390, light/dark', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-settings-footer-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  t.after(() => demo.kill());
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(() => browser.close());
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await mockIdentityReads(page); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.footerSeed = c.session; });
  const expected = {
    de: 'Allgemein · Hier können Sie ein neues Gespräch beginnen, die Einwilligung und Ihre Voreinstellungen prüfen und Ihre E-Mail-Adresse bestätigen.',
    en: 'General · Start a new conversation, review consent and your defaults, and confirm your email address.',
  };
  const general = {
    de: 'Allgemein · Hier können Sie ein neues Gespräch beginnen sowie die Einwilligung und Ihre Voreinstellungen prüfen.',
    en: 'General · Start a new conversation, review consent and your defaults.',
  };
  const controls = ['.settings__tabs', '.general-new', '.general-consent-manage', '.general-recommended', '.footer-links', '.save-state', '.done'];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    let baseline;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    for (const state of ['off', 'unverified', 'pending', 'verified']) await t.test(`${locale}/${theme}/${width}/verification-${state}`, async () => {
      const verification = state !== 'off', needsVerification = state === 'unverified' || state === 'pending';
      await page.evaluate(async ({ locale, verification, state }) => {
        const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
        const { paintUtilities } = await import('/demo/page-preferences.js');
        const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.footerSeed), copy = { de, en }[locale];
        session.locale = locale;
        session.identity = { status: { off: 'guest', unverified: 'guest', pending: 'verification-pending', verified: 'verified' }[state],
          address: state === 'pending' || state === 'verified' ? 'visitor@example.com' : null,
          verificationRequired: false, assessmentUnlocked: true, pollVerification: false };
        c.configure({ copy, session, host: { verification } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy); window.scrollTo(0, 0);
      }, { locale, verification, state });
      await page.click('aithema-session >>> .settings-open'); await page.click('aithema-session >>> [data-tab="general"]');
      await page.mouse.move(0, 0); await settle();
      const geometry = await shadow(page, c => {
        const root = c.shadowRoot, message = root.querySelector('.context-message'), box = message.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(message);
        const lines = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        const style = getComputedStyle(message), footer = root.querySelector('.settings__footer').getBoundingClientRect();
        return { text: message.textContent, emailShown: !root.querySelector('.host-verify').hidden,
          verifyButtonShown: !root.querySelector('.host-verify').hidden && !root.querySelector('.verify-entry').hidden,
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, lines, footerTop: footer.top,
          textOverflow: style.textOverflow, fontStyle: style.fontStyle, scrollWidth: message.scrollWidth, clientWidth: message.clientWidth };
      });
      const positions = await boxes(page, controls), context = `${locale}/${theme}/${width}/${state}: ${JSON.stringify(geometry)}`;
      if (!verification) baseline = positions;
      else sameBoxes(baseline, positions, `${context}: enabling verification moves no control`);
      const displacement = Math.max(...positions.flatMap((box, i) => box.map((value, n) => Math.abs(value - baseline[i][n]))));
      assert.equal(displacement, 0, `${context}: control displacement stays 0 px`);
      assert.equal(geometry.emailShown, verification, context);
      assert.equal(geometry.verifyButtonShown, needsVerification, context);
      assert.equal(geometry.text, state === 'verified' ? { de, en }[locale].help.generalEmailManage : needsVerification ? expected[locale] : general[locale], context);
      assert.equal(geometry.fontStyle, 'normal'); assert.notEqual(geometry.textOverflow, 'ellipsis');
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, context);
      for (const line of geometry.lines) {
        assert.ok(line.left >= geometry.box.left - 1 && line.right <= geometry.box.right + 1, context);
        assert.ok(line.top >= geometry.box.top - 1 && line.bottom <= geometry.box.bottom + 1, context);
      }
      assert.ok(geometry.box.bottom <= geometry.footerTop, context);
      if (width === 390 && needsVerification) assert.ok(geometry.lines.length > 1, 'the email hint wraps at phone width');
      for (const control of ['.general-consent-manage', '.general-recommended']) {
        await page.hover(`aithema-session >>> ${control}`);
        sameBoxes(positions, await boxes(page, controls), `${context}: help on hover moves no control`);
      }
      await page.mouse.move(0, 0); await settle();
      if (evidence) {
        const name = `ait-147-settings-general-verification-${state}-${locale}-${width}-${theme}.png`;
        await page.screenshot({ path: join(evidence, name) }); files.push(name);
      }
      checks.push({ locale, theme, width, verification, state, geometry, positions, maxControlDisplacementPx: displacement });
      await page.keyboard.press('Escape');
    });
  }
  if (evidence) await writeFile(join(evidence, 'ait-147-settings-footer-evidence.json'), JSON.stringify({ ticket: 'AIT-147', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-131 r3 Settings email states and verification focus: DE/EN, 1440/390, light/dark', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-settings-email-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await mockIdentityReads(page); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.emailSeed = c.session; });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) for (const state of ['unverified', 'pending', 'verified']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async ({ locale, state }) => {
      const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
      const c = document.querySelector('aithema-session'), s = structuredClone(globalThis.emailSeed);
      s.locale = locale; s.settings.origin = 'chosen';
      s.identity = { status: { unverified: 'guest', pending: 'verification-pending', verified: 'verified' }[state],
        address: state === 'unverified' ? null : 'visitor@example.com', verificationRequired: false, assessmentUnlocked: true,
        conceptsUnlocked: true, resendAfterMs: 0, delivery: state === 'unverified' ? 'idle' : 'sent', pollVerification: false };
      c.configure({ copy: { de, en }[locale], session: s, host: { verification: true, library: true } });
      document.documentElement.lang = locale; window.scrollTo(0, 0);
    }, { locale, state });
    await page.click('aithema-session >>> .settings-open'); await page.click('aithema-session >>> [data-tab="general"]');
    await shadow(page, c => c.shadowRoot.querySelector('.host-verify').scrollIntoView({ block: 'nearest' })); await settle();
    const entry = await shadow(page, c => {
      const root = c.shadowRoot, section = root.querySelector('.host-verify'), button = section.querySelector('.verify-entry');
      const rect = section.getBoundingClientRect(), hit = root.elementFromPoint(rect.x + 8, rect.y + 8);
      return { title: section.querySelector('h3').textContent, address: section.querySelector('.verify-entry-address').textContent,
        status: section.querySelector('.verify-entry-status').textContent, done: section.querySelector('.verify-done').textContent,
        verified: !section.querySelector('.verify-done').hidden, button: button.textContent, hasButton: !button.hidden,
        last: section.parentElement.lastElementChild === section, panel: section.closest('[data-panel]').dataset.panel,
        extras: Boolean(root.querySelector('.host-extras')), visible: section.contains(hit), lock: !root.querySelector('.verify-lock').hidden };
    });
    const words = { de, en }[locale].hostSurface.verify, context = `${width}/${theme}/${locale}/${state}: ${JSON.stringify(entry)}`;
    assert.equal(entry.title, locale === 'en' ? 'Email' : 'E-Mail'); assert.equal(entry.panel, 'general'); assert.equal(entry.last, true);
    assert.equal(entry.extras, false); assert.equal(entry.visible, true, context); assert.equal(entry.lock, false);
    assert.equal(entry.address, state === 'unverified' ? '' : 'visitor@example.com');
    assert.equal(entry.hasButton, state !== 'verified'); assert.equal(entry.verified, state === 'verified');
    if (state === 'verified') assert.equal(entry.done, words.verifiedShort);
    else { assert.equal(entry.status, state === 'pending' ? words.linkSent : words.unverified); assert.equal(entry.button, state === 'pending' ? words.resendOrChange : words.entry); }
    const shot = async name => { if (evidence) { await page.screenshot({ path: join(evidence, name) }); files.push(name); } };
    await shot(`r3-settings-email-${state}-${width}-${theme}-${locale}.png`);
    if (entry.hasButton) {
      await page.click('aithema-session >>> .verify-entry');
      const modal = await shadow(page, c => ({ settings: c.shadowRoot.querySelector('dialog.settings').open, verify: c.shadowRoot.querySelector('dialog.verify-dialog').open,
        focus: c.shadowRoot.activeElement?.className }));
      assert.equal(modal.settings, false); assert.equal(modal.verify, true); assert.equal(modal.focus, state === 'pending' ? 'verify-resend' : 'verify__input');
      await shot(`r3-verify-from-settings-${state}-${width}-${theme}-${locale}.png`);
      await page.keyboard.press('Escape');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.activeElement?.classList.contains('settings-open'));
    } else await page.keyboard.press('Escape');
    checks.push({ width, theme, locale, state, entry });
  }
  if (evidence) await writeFile(join(evidence, 'r3-settings-email-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-131 populated canvas regressions and the orb hit area', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-display-regressions-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const draft = copy => `<!doctype html><html lang="${copy.display.locale}"><head><meta charset="utf-8"><title>${copy.layout.canvas}</title>
    <style>body{margin:0;padding:32px;background:#f7f5ef;color:#243b40;font:16px system-ui}h1{font:32px Georgia}input,button{font:inherit;padding:12px;border:1px solid #b4c9c1;border-radius:6px}button{background:#1d6e6a;color:white}p{line-height:1.5}</style></head>
    <body><h1>${copy === de ? 'Ihr Website-Entwurf' : 'Your website draft'}</h1><p>${copy === de ? 'Eine geschätzte Lieferzeit für handgestickte Polster.' : 'Estimated delivery times for hand-embroidered cushions.'}</p>
    <label>${copy === de ? 'Ihr Motiv' : 'Your design'} <input id="design" value="Blumen"></label>
    <p><button id="count">${copy === de ? 'Entwurf ausprobieren' : 'Try the draft'}</button> <output id="value">0</output></p>
    <script>document.querySelector('#count').addEventListener('click',()=>{document.querySelector('#value').textContent=String(Number(document.querySelector('#value').textContent)+1)});</script></body></html>`;
  let copy = de;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/concepts/canvas1/html')) return request.respond({ status: 200, contentType: 'application/octet-stream', body: draft(copy) });
    if (url.pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
      best: Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }])) }) });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.regressionSeed = c.session; });
  async function scene(locale, theme, width) {
    copy = { en, de }[locale]; await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const c = document.querySelector('aithema-session'), s = structuredClone(globalThis.regressionSeed);
      s.locale = locale; s.settings.origin = 'chosen'; s.conceptVisualKind = 'html'; s.conceptCost = { maxMicro: 400_000 };
      s.transcript = [{ id: 'source', role: 'user', content: locale === 'de' ? 'Eine Website für meine handgestickten Polster.' : 'A website for my hand-embroidered cushions.' }];
      s.inputRevision = 1; s.concepts = [{ id: 'canvas1', mediaType: 'text/html', turnIds: ['source'], referenceIds: [], archived: false,
        feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } }];
      s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }]));
      c.configure({ copy: { en, de }[locale], session: s }); document.documentElement.lang = locale;
      c.shadowRoot.querySelector('.fold').click();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.canvas-html').state === 'ready');
    await page.mouse.move(0, 300);
  }
  async function shot(state, locale, theme, width) {
    const name = `${state}-${width}-${theme}-${locale}.png`;
    if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: true }); files.push(name); }
  }
  const canvasFrame = async () => (await page.$('aithema-session >>> .canvas-html >>> iframe')).contentFrame();
  await t.test('populated canvas keeps interactive state and focus through durable events', async () => {
    await scene('de', 'light', 1440);
    const frame = await canvasFrame(); await frame.click('#count'); await frame.focus('#design'); await frame.type('#design', ' · geändert');
    const before = await frame.$eval('#design', n => n.value);
    await shadow(page, c => { globalThis.canvasFrameBefore = c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe');
      c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }); });
    await settle();
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe') === globalThis.canvasFrameBefore), true);
    assert.equal(await frame.$eval('#value', n => n.textContent), '1'); assert.equal(await frame.$eval('#design', n => n.value), before);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'design', 'typing focus stays in the same browsing context');
    await shot('folded-populated-state-preserved', 'de', 'light', 1440);
  });
  await t.test('unfold unloads the populated executable iframe', async () => {
    await scene('en', 'light', 1440); await canvasFrame();
    await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').artifact), null);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe'))), false);
  });
  await t.test('populated canvas and every modal frame are redacted on consent or source withdrawal', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      for (const cause of ['consent', 'source']) for (const folded of [true, false]) {
        await scene(locale, theme, width);
        await shot('folded-populated-canvas', locale, theme, width);
        if (!folded) await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
        await shadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-html').state === 'ready');
        await shadow(page, (c, cause) => c.receive({ seq: c.session.seq + 1,
          type: cause === 'consent' ? 'consent.revised' : 'turn.withdrawn', data: cause === 'consent' ? { granted: false } : { turnId: 'source' } }), cause);
        const surfaces = await shadow(page, c => ['.canvas-html', '.concept-html'].map(selector => {
          const n = c.shadowRoot.querySelector(selector); return { bytes: n.artifact, frame: Boolean(n.shadowRoot.querySelector('iframe')) };
        }));
        assert.deepEqual(surfaces, [{ bytes: null, frame: false }, { bytes: null, frame: false }], `${locale}/${theme}/${width}/${cause}/${folded}`);
        await shot(`revocation-${cause}-${folded ? 'folded' : 'unfolded'}`, locale, theme, width);
        checks.push({ locale, theme, width, cause, folded, surfaces });
      }
    }
  });
  await t.test('the reveal orb has a 44px hit area around its 40px visual', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await scene(locale, theme, width);
      const visual = (await boxes(page, ['.band-orb .orb__body']))[0];
      const target = await shadow(page, c => {
        const n = c.shadowRoot.querySelector('.band-orb [role="button"]'), r = n.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      });
      assert.equal(visual[2], 40); assert.equal(visual[3], 40); assert.equal(target[2], 44); assert.equal(target[3], 44);
      const bandBefore = await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']);
      // The point is in the target's outer ring, beyond the painted 40px orb.
      await page.mouse.click(target[0] + 1, target[1] + 22);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'open');
      await settle(); sameBoxes(bandBefore, await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']), 'orb activation does not shift the band layout');
      await shot('orb-hit-area-open', locale, theme, width);
      checks.push({ locale, theme, width, visual, target });
    }
  });
  await t.test('conversations menu corners stay painted above the second band row at medium widths', async () => {
    for (const width of [600, 680, 768, 900, 1000]) {
      await scene('de', 'light', width);
      await shadow(page, async c => { const { de } = await import('/packages/ui/src/i18n/de.js'); c.configure({ copy: de, session: c.session, host: { library: true } }); });
      await page.click('aithema-session >>> .conversations-toggle'); await settle();
      const menu = await shadow(page, c => {
        const root = c.shadowRoot, n = root.querySelector('.conversations-menu'), b = n.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
          corners: [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]]
            .map(([x, y]) => { const hit = root.elementFromPoint(x, y); return { painted: n.contains(hit), hit: hit?.className }; }) };
      });
      await shot('conversations-medium', 'de', 'light', width);
      assert.ok(menu.corners.every(n => n.painted), `${width}: ${JSON.stringify(menu)}`);
    }
  });
  if (evidence) await writeFile(join(evidence, 'display-regressions-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit,
    createdAt: new Date().toISOString(), files, checks }, null, 2));
});

test('AIT-138 UI: held-call copy, placeholders, calm lines and disabled controls without layout shift', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-waiting-ui-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], files = [], checks = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
    return request.continue();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const shot = async (state, width, theme, locale) => {
    if (!evidence || width === 1024) return;
    await shadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
    const name = `ait-138-${state}-${width}-${theme}-${locale}.png`;
    await page.screenshot({ path: join(evidence, name), fullPage: false }); files.push(name);
  };
  // Reinstall only the host's voice port after a real reload. The component restores the saved waiting snapshot.
  const configure = async (locale, reload = false) => page.evaluate(async ({ locale, reload }) => {
    const { voiceEvents } = await import('/packages/core/src/live-voice.js'), { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
    const c = document.querySelector('aithema-session'), copy = { de, en }[locale];
    const s = reload ? JSON.parse(sessionStorage.getItem('ait-138-waiting-ui')) : structuredClone(c.session);
    s.locale = locale; s.paused = false; s.settings.origin = 'chosen'; s.settings.voice = 'elevenlabs';
    s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
    s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true, reason: null }]));
    if (!reload) {
      delete s.voiceLifecycle;
      s.transcript = [{ id: 'ui-user', role: 'user', content: locale === 'de' ? 'Eine Website für Stickpolster.' : 'A website for embroidered cushions.' }];
    }
    globalThis.waitingUiStarts = 0;
    const voiceClient = { manifest, async start({ callId }) {
      globalThis.waitingUiStarts++; globalThis.waitingUiCallId = callId;
      const events = voiceEvents(); globalThis.waitingUiEvents = events;
      return { callId, providerSessionId: 'ui-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
        async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
        audioLevels: () => ({ input: .3, output: .65 }), async close() { events.end(); return { closureConfirmed: true }; } };
    } };
    localStorage.setItem('aithema-motion', 'on');
    c.configure({ copy, session: s, voiceClient }); document.documentElement.lang = locale;
    document.querySelector('#locale').value = locale;
    const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy); window.scrollTo(0, 0);
  }, { locale, reload });
  const settled = async state => {
    await until(page, (state) => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === state, state);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await settle();
  };
  const placeholder = () => shadow(page, c => c.shadowRoot.querySelector('textarea').placeholder);
  const controls = () => shadow(page, c => ['.voice-input', '.voice-output'].map(selector => {
    const n = c.shadowRoot.querySelector(selector), style = getComputedStyle(n);
    return { selector, disabled: n.disabled, tooltip: n.title, opacity: style.opacity, cursor: style.cursor };
  }));
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390, 1024]) {
    const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await page.select('#theme', theme); await configure(locale); await settle();
    await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click()); await settled('listening');
    const placeholders = { listening: await placeholder() }; assert.equal(placeholders.listening, copy.placeholderVoice);
    const selectors = ['.band', '.audio-rail', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.composer'];
    const before = await layoutBoxes(page, selectors);
    await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settled('paused');
    placeholders.paused = await placeholder(); assert.equal(placeholders.paused, copy.placeholder);
    sameBoxes(before, await layoutBoxes(page, selectors), `${label}: paused keeps fixed cells`);
    await shot('voice-paused', width, theme, locale);
    await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settled('listening');
    // Force the previous amber paint, then stop motion before waiting: a timer cannot repair the colour for us.
    await page.evaluate(() => globalThis.waitingUiEvents.push({ type: 'speaking', callId: globalThis.waitingUiCallId }));
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle === '#b66a23');
    await shadow(page, c => c.shadowRoot.querySelector('.motion-toggle').click());
    assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off');
    await page.evaluate(() => globalThis.waitingUiEvents.push({ type: 'waiting', callId: globalThis.waitingUiCallId, reason: 'recovery-failed' }));
    await settled('waiting');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-state').textContent), copy.voiceStates.waiting);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.pause').title), copy.resume);
    placeholders.waiting = await placeholder(); assert.equal(placeholders.waiting, copy.placeholder);
    const geometry = await statusGeometry(page);
    if (width >= 1024) { assert.equal(geometry.rendered.length, 1, `${label}: whole label on one line`); assert.equal(geometry.overflow, 'clip');
      assert.ok(geometry.textBox.x >= geometry.waveX && geometry.textBox.right <= geometry.waveX + geometry.waveWidth, `${label}: label fits inside waveform space`); }
    const lineColour = await shadow(page, c => c.shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle);
    assert.equal(lineColour, '#12908c', `${label}: calm user baseline, including motion off`);
    const disabledControls = await controls();
    for (const control of disabledControls) {
      assert.equal(control.disabled, true); assert.equal(control.opacity, '0.4'); assert.equal(control.cursor, 'default');
      assert.equal(control.tooltip, copy.voiceResumeFirst);
    }
    sameBoxes(before, await layoutBoxes(page, selectors), `${label}: waiting keeps fixed cells`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
    await shot('voice-waiting', width, theme, locale);
    await page.evaluate(() => {
      const snapshot = structuredClone(document.querySelector('aithema-session').session);
      snapshot.voiceLifecycle = { callId: globalThis.waitingUiCallId, providerSessionId: 'ui-evidence', state: 'waiting', attempts: 3, needsRecovery: true };
      sessionStorage.setItem('ait-138-waiting-ui', JSON.stringify(snapshot));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await configure(locale, true); await settled('waiting');
    placeholders.waitingAfterReload = await placeholder(); assert.equal(placeholders.waitingAfterReload, copy.placeholder);
    assert.equal(await page.evaluate(() => globalThis.waitingUiStarts), 0, `${label}: reload does not start listening`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-wave').getContext('2d').strokeStyle), '#12908c');
    for (const control of await controls()) { assert.equal(control.disabled, true); assert.equal(control.opacity, '0.4'); assert.ok(control.tooltip); }
    await shot('voice-waiting-reloaded', width, theme, locale);
    checks.push({ viewport: { width, height: width === 390 ? 844 : 900 }, theme, locale, waitingLabel: copy.voiceStates.waiting,
      waitingLabelLines: geometry.rendered.length, waitingLineColour: { token: 'COLOUR.user', value: lineColour }, placeholders,
      disabledControls, noLayoutShift: true, noHorizontalOverflow: true, pass: true });
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait-138-ui-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', files, checks }, null, 2));
});

test('AIT-138 c: recovery notices, explicit reply fallback and waiting tooltips in all viewports', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-recovery-notices-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], files = [], checks = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (new URL(request.url()).pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
    return request.continue();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const shot = async (name, label) => {
    const file = `ait-138-c-${name}-${label}.png`; files.push(file);
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
  };
  const push = event => page.evaluate(event => globalThis.noticeEvents.push({ callId: globalThis.noticeCallId, ...event }), event);
  const recovered = async recovery => {
    await push({ type: 'recovered', recovery });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-notice--recovered').textContent);
    await settle();
  };
  const selectors = ['.band', '.audio-rail', '.voice-notices', '.concept-bar', '.transcript-shell', '.composer-dock'];
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
    await t.test(`${width} ${theme} ${locale}`, async () => {
      const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
      const wording = {
        de: { notice: 'Letzte Antwort vielleicht nicht ganz zu hören', button: 'Antwort wiederholen', title: 'Letzte Antwort',
          note: 'Der vollständige Text der letzten Antwort, Wort für Wort.', close: 'Schließen', tooltip: 'Erst fortsetzen' },
        en: { notice: 'Last reply may not have played in full', button: 'Replay reply', title: 'Last reply',
          note: 'The full text of the last reply, word for word.', close: 'Close', tooltip: 'Resume first' },
      }[locale];
      const layoutChecks = [];
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      await page.select('#theme', theme);
      await page.evaluate(async locale => {
        const { voiceEvents } = await import('/packages/core/src/live-voice.js');
        const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
        const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
        const c = document.querySelector('aithema-session'), s = structuredClone(c.session);
        s.locale = locale; s.paused = false; s.settings.origin = 'chosen'; s.settings.voice = 'elevenlabs';
        s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
        s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: true, reason: null }]));
        delete s.voiceLifecycle;
        s.transcript = [{ id: 'notice-user', role: 'user', content: locale === 'de' ? 'Eine Website für Stickpolster.' : 'A website for embroidered cushions.' }];
        globalThis.noticeReply = locale === 'de' ? 'Die Website zeigt die Lieferzeit nach dem Backlog.\n\nSollen Kunden Motiv, Farbe und Größe selbst wählen können?'
          : 'The website shows delivery time based on the backlog.\n\nShould customers be able to choose the design, colour and size?';
        s.transcript.push({ id: 'notice-reply', role: 'assistant', content: globalThis.noticeReply });
        globalThis.noticeReplays = 0; globalThis.noticeAdmissions = 0; globalThis.noticeModelCalls = 0;
        const voiceClient = { manifest, async start({ callId }) {
          globalThis.noticeAdmissions++; globalThis.noticeCallId = callId;
          const events = voiceEvents(); globalThis.noticeEvents = events;
          return { callId, providerSessionId: 'notice-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
            async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
            async replayLastReply() { globalThis.noticeReplays++; return { kind: 'text', text: globalThis.noticeReply }; },
            async sendText() { globalThis.noticeModelCalls++; }, audioLevels: () => ({ input: .2, output: .3 }),
            async close() { events.end(); return { closureConfirmed: true }; } };
        } };
        localStorage.setItem('aithema-motion', 'off'); c.configure({ copy: { de, en }[locale], session: s, voiceClient });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities({ de, en }[locale]); window.scrollTo(0, 0);
      }, locale);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'listening');
      await page.evaluate(async () => { await document.fonts.ready; }); await settle();
      const before = await layoutBoxes(page, selectors);
      const sameNoticeBoxes = (after, context) => {
        if (width !== 390) { sameBoxes(before, after, context); return; }
        // AIT-188: the last phone item sizes to its current contents. The band,
        // stage, transcript viewport, dock and notice origin still move 0px.
        assert.deepEqual(after.filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), context);
        assert.deepEqual(after[2].slice(0, 3), before[2].slice(0, 3), `${context}: notice origin moves 0px`);
      };
      const noticeLayout = async state => {
        const after = await layoutBoxes(page, selectors);
        if (width === 390) {
          const heights = { 'lone-restored':24, unconfirmed:68, 'known-position':24, 'incomplete-button':112,
            'lone-incomplete':88, 'unacknowledged-reply':112, 'all-notices':156, cleared:0 };
          assert.equal(after[2][3], heights[state], `${label}: ${state} occupies exactly its visible rows`);
          assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.transcript-shell').lastElementChild.className), 'voice-notices');
        } else {
          assert.deepEqual(after[2], before[2], `${label}: ${state} preserves the notice reservation`);
          assert.equal(after[2][3], 108, `${label}: original reserved height`);
        }
        const belowShifts = after.slice(3).flatMap((box, i) => box.map((value, n) => value - before[i + 3][n]));
        assert.ok(belowShifts.every(shift => shift === 0), `${label}: ${state} shifts the content below by 0px`);
        const layout = await shadow(page, c => {
          const root = c.shadowRoot, rect = n => {
            const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
          };
          const rows = [...root.querySelectorAll('.voice-notice')].filter(n => getComputedStyle(n).display !== 'none');
          const text = root.querySelector('.voice-notice--reply > span'), range = document.createRange(); range.selectNodeContents(text);
          return { slot: rect(root.querySelector('.voice-notices')), rows: rows.map(rect), text: rect(text),
            textRight: Math.max(...[...range.getClientRects()].map(r => r.right)), button: rect(root.querySelector('.voice-repeat')) };
        });
        if (layout.rows.length) assert.equal(layout.rows[0].top, layout.slot.top, `${label}: ${state} first notice starts at slot top`);
        for (let i = 1; i < layout.rows.length; i++) {
          assert.equal(layout.rows[i].top, layout.rows[i - 1].bottom, `${label}: ${state} has no empty row between notices`);
        }
        layoutChecks.push({ state, ...layout, belowShiftPx: Math.max(...belowShifts.map(Math.abs)), pass: true });
        return layout;
      };
      const assertButtonPosition = layout => {
        if (width === 390) {
          assert.ok(layout.button.top >= layout.text.bottom, `${label}: button sits under the text`);
          assert.equal(layout.button.left, layout.text.left, `${label}: stacked button starts with its text`);
        } else {
          assert.ok(Math.abs(layout.button.left - layout.textRight - 12) <= 1, `${label}: button starts 12px after the notice text`);
          assert.ok(layout.button.top < layout.text.bottom && layout.button.bottom > layout.text.top, `${label}: button stays beside the text`);
        }
      };
      await recovered({});
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--recovered').textContent), copy.voiceRecovered);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: restored notice reserves its space`);
      const loneRestored = await noticeLayout('lone-restored');
      assert.equal(loneRestored.rows.length, 1, 'only the visible notice occupies a row');
      await shot('restored', label);
      await recovered({ userUnconfirmed: true });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--user').textContent), copy.voiceUserUnconfirmed);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: unconfirmed notice reserves its space`);
      await noticeLayout('unconfirmed');
      await shot('unconfirmed', label);
      const lastReplyText = await page.evaluate(() => globalThis.noticeReply);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: false, lastReplyText });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply > span').textContent), '');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice-live').textContent), copy.voiceRecovered);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: known position hides incomplete notice without layout shift`);
      await noticeLayout('known-position');
      await shot('known-position', label);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply > span').textContent), wording.notice);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').textContent), wording.button);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').getAttribute('aria-haspopup')), 'dialog');
      assert.equal(await page.evaluate(() => globalThis.noticeReplays), 0, 'no automatic replay');
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: reply notice and button reserve their space`);
      assertButtonPosition(await noticeLayout('incomplete-button'));
      await shot('incomplete-button', label);
      // Isolate the reply row to check CSS packing independently of recovery's restored announcement.
      await shadow(page, c => { c.shadowRoot.querySelector('.voice-notice--recovered').textContent = ''; });
      const loneReply = await noticeLayout('lone-incomplete');
      assert.equal(loneReply.rows.length, 1, 'a lone reply uses the first notice slot');
      assertButtonPosition(loneReply);
      await shot('lone-incomplete-button', label);
      await recovered({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: null });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice--reply span').textContent), wording.notice);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').disabled), true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').title), copy.voiceReplyUnavailable);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: unacknowledged reply reserves its space`);
      assertButtonPosition(await noticeLayout('unacknowledged-reply'));
      await shot('unacknowledged-reply', label);
      await recovered({ userUnconfirmed: true, deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText });
      const geometry = await shadow(page, c => {
        const root = c.shadowRoot, notice = root.querySelector('.voice-notices').getBoundingClientRect();
        return [...root.querySelectorAll('.voice-notice--recovered, .voice-notice--user, .voice-notice--reply > span, .voice-repeat')].map(n => {
          const b = n.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
          return { name: n.className || 'reply-text', width: b.width, height: b.height, visible: b.top >= 0 && b.bottom <= innerHeight,
            inside: b.left >= notice.left - .5 && b.right <= notice.right + .5 && b.top >= notice.top - .5 && b.bottom <= notice.bottom + .5,
            textFits: [...range.getClientRects()].every(r => r.left >= b.left - .5 && r.right <= b.right + .5 && r.top >= b.top - .5 && r.bottom <= b.bottom + .5) };
        });
      });
      for (const item of geometry) { assert.ok(item.inside && item.visible && item.textFits, `${label}: ${JSON.stringify(item)}`); }
      assert.ok(geometry.at(-1).width >= 44 && geometry.at(-1).height >= 44, '44px keyboard target');
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: all notices fit without layout shift`);
      assertButtonPosition(await noticeLayout('all-notices'));
      await shot('all-notices', label);
      await shadow(page, c => {
        const live = c.shadowRoot.querySelector('.voice-notice-live'); globalThis.noticeAnnouncements = [];
        globalThis.noticeObserver = new MutationObserver(records => globalThis.noticeAnnouncements.push(...records.map(r => r.type)));
        globalThis.noticeObserver.observe(live, { childList: true, subtree: true, characterData: true });
      });
      // Provider speaking/listening repaints the rail but never rewrites its notice live region.
      await push({ type: 'speaking' }); await push({ type: 'listening' }); await settle();
      assert.equal(await page.evaluate(() => { globalThis.noticeObserver.disconnect(); return globalThis.noticeAnnouncements.length; }), 0);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').focus()); await page.keyboard.press('Enter');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-text').textContent), lastReplyText);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#voice-reply-title').textContent), wording.title);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-note').textContent), wording.note);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-close').textContent), wording.close);
      assert.deepEqual(await page.evaluate(() => [globalThis.noticeReplays, globalThis.noticeAdmissions, globalThis.noticeModelCalls]), [1, 1, 0]);
      await shot('exact-text-fallback', label);
      await page.keyboard.press('Escape');
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.voice-reply-dialog').open);
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.className), 'voice-repeat', 'Escape returns keyboard focus');
      await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').disabled), true);
      await shadow(page, c => c.shadowRoot.querySelector('.pause').click()); await settle();
      await push({ type: 'waiting', reason: 'recovery-failed' });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'waiting');
      for (const [name, cell] of [['input', 'mic'], ['output', 'output']]) {
        const tooltip = await shadow(page, (c, name) => c.shadowRoot.querySelector(`.voice-${name}`).title, name);
        assert.equal(tooltip, wording.tooltip);
        await shadow(page, (c, cell) => c.shadowRoot.querySelector(`.voice-cell--${cell}`).focus(), cell); await settle();
        assert.equal(await shadow(page, (c, cell) => getComputedStyle(c.shadowRoot.querySelector(`.voice-cell--${cell} .voice-waiting-help`)).visibility, cell), 'visible');
        const tooltipBox = await shadow(page, (c, cell) => {
          const b = c.shadowRoot.querySelector(`.voice-cell--${cell} .voice-waiting-help`).getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        }, cell);
        assert.ok(tooltipBox.left >= 0 && tooltipBox.right <= width && tooltipBox.top >= 0 && tooltipBox.bottom <= (width === 390 ? 844 : 900),
          `${label}: ${name} tooltip fits the viewport: ${JSON.stringify(tooltipBox)}`);
        await shot(`waiting-${name}-tooltip`, label);
      }
      await push({ type: 'partial', role: 'user', turnId: 'next', text: 'Next utterance' }); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-notice-live').textContent), '');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true);
      sameNoticeBoxes(await layoutBoxes(page, selectors), `${label}: clearing does not shift layout`);
      const cleared = await noticeLayout('cleared');
      assert.equal(cleared.rows.length, 0, 'cleared notices leave all reserved room below');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click()); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-dialog').open), false);
      checks.push({ viewport: { width, height: width === 390 ? 844 : 900 }, locale, theme, geometry, layoutChecks, capture: 'viewport',
        restored: copy.voiceRecovered, unconfirmed: copy.voiceUserUnconfirmed, incomplete: wording.notice, repeat: wording.button,
        dialogTitle: wording.title, dialogExplanation: wording.note, dialogClose: wording.close, buttonHasPopup: 'dialog',
        reservedHeight: width === 390 ? null : 108, phoneLastItem: width === 390, belowShiftPx: 0, desktopButtonGapPx: width === 390 ? null : 12,
        mobileButtonUnderText: width === 390, waitingTooltips: wording.tooltip, noAutoReplay: true, exactLastReply: true, modelCalls: 0, replayAdmissions: 0,
        incrementalReplayMicro: 0, noLayoutShift: true, announcedOnce: true, clearsNextTurn: true, keyboardAndAria: true, pass: true });
    });
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait-138-c-pass-lines.json'), JSON.stringify({ ticket: 'AIT-138 c', commit: evidenceCommit,
    createdAt: new Date().toISOString(), capture: 'viewport', files, checks }, null, 2));
});

test('AIT-149: reveal exit clock survives delayed browser round trips', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-reveal-clock-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_PROVIDER: 'mock',
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  await page.setViewport({ width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, async c => {
    const { de } = await import('/packages/ui/src/i18n/de.js'), session = c.session;
    session.settings.origin = 'chosen'; localStorage.setItem('aithema-motion', 'on');
    c.configure({ copy: de, session }); c.shadowRoot.querySelector('.band-orb .orb').focus();
  });
  await page.hover('aithema-session >>> .band-orb .orb');
  await finishRevealEntry(page);
  // Every browser-call response arrives after the brand's entire 300ms fade.
  // Capturing the exit in a later call must not silently lose that transition.
  const slowPage = { mouse: { async move(...args) {
    await page.mouse.move(...args);
    await new Promise(resolve => setTimeout(resolve, 400));
  } }, async $eval(...args) {
    const result = await page.$eval(...args);
    await new Promise(resolve => setTimeout(resolve, 400));
    return result;
  } };
  assert.deepEqual(await freezeRevealExit(slowPage), { phase: 'exiting', from: '1', to: '0', duration: 300 }, 'retain the brand fade despite browser round-trip latency');
  await seekReveal(page, 0);
  assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity), '1', 'the initial exit frame is still available');
  await seekReveal(page, 350);
  assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity), '0', 'the 350ms frame is past the completed brand fade');
  await seekReveal(page, 1600);
  await page.evaluate(() => { globalThis.displayRevealCleanup(); delete globalThis.displayRevealCleanup; });
});


test('AIT-105: Tick hover/focus matrix and copied slot have opaque paint and 0 px shift', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-calver-hover-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), errors = [], evidence = process.env.AITHEMA_EVIDENCE_DIR, passLines = [];
  page.on('pageerror', error => errors.push(error.message));
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('aithema-demo-locale', 'en');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.ait105Copied = value; } } });
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  const configure = async (locale, display) => page.evaluate(async ({ locale, display }) => {
    const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
    window.ait105Bundles = { de, en }; const copy = window.ait105Bundles[locale];
    const c = document.querySelector('aithema-session'); window.ait105Copy = copy;
    if (!await c.changeLocale(locale)) throw new Error(`Cannot change conversation to ${locale}`);
    c.configure({ copy, copyForLocale: language => window.ait105Bundles[language], session: c.session, host: { version: {
      product: 'Aithema 2026.10', version: '261014080000.0.0', version_scheme: 'inspr-calver-3',
      commit: 'abcdef1234567890', date: '2026-10-14T08:00:00.000Z', display,
    } } });
  }, { locale, display });
  const popupMetrics = () => shadow(page, c => {
    const root = c.shadowRoot, popup = root.querySelector('.footer-info .footer-popup'), build = root.querySelector('#build-info');
    const style = getComputedStyle(popup), row = build.querySelector('.version-row');
    const box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const coordinate = build.querySelector('.coordinate');
    const visibleVersion = coordinate && (coordinate.children.length ? [...coordinate.children].filter(n => n.getBoundingClientRect().width > 0).map(n => n.textContent).join('') : coordinate.textContent);
    const value = row?.querySelector('.version-value'), feedback = row?.querySelector('.version-feedback');
    const valueVisibility = value && getComputedStyle(value).visibility;
    const rgb = color => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = channels => channels.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
      .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const surface = luminance(rgb(style.backgroundColor));
    const text = n => {
      const colour = getComputedStyle(n).color, light = luminance(rgb(colour));
      return { colour, contrast: (Math.max(light, surface) + .05) / (Math.min(light, surface) + .05) };
    };
    const legal = c.querySelector('[slot="legal"]'), notes = c.querySelector('[slot="footer"]');
    const textLines = { notice: text(root.querySelector('#ai-notice')), version: text(value),
      build: text(build.querySelector('.build-label')), link: text(legal.querySelector('a')), notes: text(notes) };
    const versionColours = [...value.querySelectorAll('span')].filter(n => n.getBoundingClientRect().width > 0)
      .map(n => ({ ...text(n), opacity: getComputedStyle(n).opacity }));
    const gap = (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
    const rhythm = [gap(root.querySelector('#ai-notice'), build), gap(row, build.querySelector('.build-label')),
      gap(build, legal), gap(legal, notes)];
    const rowStyle = getComputedStyle(row);
    const ring = rowStyle.outlineStyle !== 'none' && parseFloat(rowStyle.outlineWidth) > 0;
    const rowBox = row.getBoundingClientRect();
    const ringExtent = Math.max(0, parseFloat(rowStyle.outlineWidth) + parseFloat(rowStyle.outlineOffset));
    const ringBox = { left: rowBox.left - ringExtent, top: rowBox.top - ringExtent,
      right: rowBox.right + ringExtent, bottom: rowBox.bottom + ringExtent };
    const buildRange = document.createRange(); buildRange.selectNodeContents(build.querySelector('.build-label'));
    const buildRect = buildRange.getBoundingClientRect();
    const buildTextBox = { left: buildRect.left, top: buildRect.top, right: buildRect.right, bottom: buildRect.bottom };
    const ringIntersectsBuild = ringBox.left < buildTextBox.right && ringBox.right > buildTextBox.left
      && ringBox.top < buildTextBox.bottom && ringBox.bottom > buildTextBox.top;
    const ringBuildGapPx = buildTextBox.top - ringBox.bottom;

    const visibleText = row && (valueVisibility === 'hidden' ? feedback?.innerText : 'Version ' + visibleVersion);
    return { background: style.backgroundColor, opacity: style.opacity, visibility: style.visibility,
      notice: box(root.querySelector('#ai-notice')), popup: box(popup), row: row && box(row),
      build: build.querySelector('.build-label')?.textContent, product: root.querySelector('.display-version').textContent,
      first: build.firstChild?.className, text: visibleText, valueVisibility,
      feedbackPosition: feedback && getComputedStyle(feedback).position, feedbackBox: feedback && !feedback.hidden ? box(feedback) : null,
      version: visibleVersion, title: build.title, textLines, versionColours, rhythm, ring,
      ringBox, buildTextBox, ringIntersectsBuild, ringBuildGapPx,
      cursor: rowStyle.cursor, rowTint: rowStyle.backgroundColor, legal: [...legal.querySelectorAll('a')].map(n => n.textContent), notes: notes.textContent };
  });
  const capture = async (locale, theme, width, state, metrics) => {
    if (state === 'copied') {
      assert.equal(metrics.ringIntersectsBuild, false, `${locale}/${theme}: ring box does not intersect build text box`);
      assert.ok(metrics.ringBuildGapPx >= 3, `${locale}/${theme}: ring/build text gap ${metrics.ringBuildGapPx} px >= 3 px`);
    }
    const file = `ait105-version-${locale}-${theme}-${width}-${state}.png`;
    if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
    passLines.push({ head: evidenceCommit, locale, theme, width, state, pass: true, displacementPx: 0, file, ...metrics });
    t.diagnostic(`PASS AIT-105 ${locale}/${theme}/${width}/${state}: opaque popup; ${Object.entries(metrics.textLines).map(([line, data]) => `${line} ${data.colour} ${data.contrast.toFixed(2)}:1`).join('; ')}; ring ${metrics.ring ? 'on' : 'off'}${state === 'copied' ? `; ring box does not intersect build text box; gap ${metrics.ringBuildGapPx} px >= 3 px` : ''}; 0 px shift`);
  };
  await t.test('round 3 EN slots on first load and after switching', async () => {
    const strings = () => page.evaluate(() => ['#demo-license', '#demo-legal-source', '#demo-footer'].map(selector => document.querySelector(selector).textContent));
    assert.deepEqual(await strings(), [en.host.slots.license, en.host.slots.legalSource, en.host.slots.footer], 'first EN load');
    await configure('de'); await configure('en');
    assert.deepEqual(await strings(), [en.host.slots.license, en.host.slots.legalSource, en.host.slots.footer]);
    await configure('de');
    assert.deepEqual(await strings(), [de.host.slots.license, de.host.slots.legalSource, de.host.slots.footer], 'switch to DE');
  });
  await configure('de');
  await page.setViewport({ width: 1440, height: 1000 });
  await page.select('#theme', 'dark');
  let notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
  await until(page, () => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.footer-info .footer-popup')).opacity === '1');
  await t.test('opaque approved dark tooltip surface', async () => {
    const metrics = await popupMetrics(); assert.equal(metrics.background, 'rgb(16, 43, 66)'); assert.equal(metrics.opacity, '1');
  });
  await t.test('version has its own line followed by muted UTC build', async () => {
    const metrics = await popupMetrics(); assert.equal(metrics.first, 'version-row');
    assert.equal(metrics.build, 'Build abcdef1 · 2026-10-14 08:00:00 UTC');
    assert.equal(metrics.version, '26.10.14 · 08:00');
    assert.ok(metrics.row[1] >= metrics.notice[1] + metrics.notice[3]);
  });
  await t.test('round 3 every text line reaches 4.5:1 in both themes', async () => {
    const failures = [];
    for (const theme of ['light', 'dark']) {
      await page.select('#theme', theme);
      const metrics = await popupMetrics();
      for (const [line, data] of Object.entries({ ...metrics.textLines, ...Object.fromEntries(metrics.versionColours.map((data, i) => [`version-${i}`, data])) })) {
        if (data.contrast < 4.5) failures.push(`${theme}/${line}: ${data.colour} ${data.contrast.toFixed(2)}:1`);
      }
    }
    assert.deepEqual(failures, []);
  });
  await t.test('round 3 build uses the notes muted colour', async () => {
    const { textLines } = await popupMetrics(); assert.equal(textLines.build.colour, textLines.notes.colour);
  });
  await t.test('round 3 primary version colour, pointer and subtle hover tint', async () => {
    const before = await popupMetrics();
    assert.ok(before.versionColours.every(n => n.colour === before.textLines.version.colour && n.opacity === '1'), JSON.stringify(before.versionColours));
    assert.equal(before.cursor, 'pointer');
    await page.hover('aithema-session >>> #build-info .version-row');
    assert.notEqual((await popupMetrics()).rowTint, before.rowTint);
    await notice.hover();
  });
  await t.test('round 3 four groups with 8 px gaps and version/build 2 px', async () => {
    assert.deepEqual((await popupMetrics()).rhythm, [8, 2, 8, 8]);
  });
  await t.test('round 3 copied ring only for keyboard focus', async () => {
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
    await page.click('aithema-session >>> #build-info .version-row');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
    assert.equal((await popupMetrics()).ring, false, 'mouse copy');
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
    assert.equal((await popupMetrics()).ring, true, 'keyboard copy');
    await page.click('aithema-session >>> #build-info .version-row');
    assert.equal((await popupMetrics()).ring, false, 'mouse copy after keyboard focus');
    await notice.click(); await page.keyboard.press('Tab');
    assert.equal((await popupMetrics()).ring, true, 'keyboard focus returns after clicking away from mouse copy');
    await page.keyboard.press('Tab');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal((await popupMetrics()).ring, true, 'keyboard Tab focus returns after mouse copy');
    await page.keyboard.press('Enter'); assert.equal((await popupMetrics()).ring, true, 'keyboard styling returns after mouse copy');
  });
  await t.test('round 3 failed clipboard and execCommand replace the value with 0 px shift', async () => {
    await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover(); const before = await popupMetrics();
    await page.evaluate(() => {
      window.ait105Clipboard = navigator.clipboard; window.ait105Exec = document.execCommand;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard denied'); } } });
      document.execCommand = () => false;
    });
    try {
      await page.click('aithema-session >>> #build-info .version-row');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="error"]'));
      const failed = await popupMetrics();
      assert.equal(failed.valueVisibility, 'hidden'); assert.deepEqual(failed.row, before.row); assert.deepEqual(failed.popup, before.popup);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.version-feedback input').value), '261014080000.0.0');
      assert.deepEqual(await shadow(page, c => {
        const field = c.shadowRoot.querySelector('.version-feedback input');
        return { focused: c.shadowRoot.activeElement === field, selected: field.value.slice(field.selectionStart, field.selectionEnd),
          description: field.getAttribute('aria-description') };
      }), { focused: true, selected: '261014080000.0.0',
        description: 'Kopieren nicht verfügbar. Die Version ist markiert: mit ⌘C oder Strg+C kopieren.' });
    } finally {
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.ait105Clipboard }); document.execCommand = window.ait105Exec; });
      await configure('de'); notice = await page.$('aithema-session >>> .ai-notice'); await notice.hover();
    }
  });
  await t.test('copy replaces version in the same slot for 1.2 s without an overlay', async () => {
    const before = await popupMetrics(), coordinate = await page.$('aithema-session >>> #build-info .coordinate');
    await coordinate.click();
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('#build-info [data-copy-state="copied"]'));
    const copied = await popupMetrics(); assert.equal(copied.text, 'Kopiert');
    assert.equal(copied.valueVisibility, 'hidden'); assert.equal(copied.feedbackPosition, 'static');
    assert.equal(copied.feedbackBox[1], copied.row[1]);
    assert.deepEqual(copied.popup, before.popup); assert.deepEqual(copied.row, before.row);
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal((await popupMetrics()).text, 'Version 26.10.14 · 08:00');
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await page.select('#theme', theme);
    await configure(locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    await page.mouse.move(0, 0); await settle();
    const notice = await page.$('aithema-session >>> .ai-notice');
    await notice.evaluate(n => n.scrollIntoView({ block: 'center' }));
    const footerBefore = await boxes(page, ['.display-foot', '.ai-notice', '.host-credits', '.footer-right']);
    for (const state of ['hover', 'focus']) {
      await shadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
      if (state === 'hover') await notice.hover();
      else { await notice.focus(); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await page.keyboard.press('Tab');
        assert.equal(await notice.evaluate(n => n.getRootNode().activeElement === n && n.matches(':focus-visible')), true); }
      await until(page, () => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.footer-info .footer-popup')).opacity === '1');
      const metrics = await popupMetrics();
      for (const data of Object.values(metrics.textLines)) assert.ok(data.contrast >= 4.5);
      assert.deepEqual(metrics.rhythm, [8, 2, 8, 8]);
      const copy = locale === 'de' ? de : en;
      assert.deepEqual(metrics.legal, [copy.host.slots.license, copy.host.slots.legalSource]); assert.equal(metrics.notes, copy.host.slots.footer);
      assert.equal(metrics.visibility, 'visible'); assert.equal(metrics.opacity, '1');
      assert.equal(metrics.background, 'rgb(16, 43, 66)');
      const viewportPaint = pixels(Buffer.from(await page.screenshot({ fullPage: false })));
      const surfaceOffset = ((Math.floor(metrics.popup[1]) + 4) * viewportPaint.width + Math.floor(metrics.popup[0]) + 14) * viewportPaint.channels;
      assert.deepEqual([...viewportPaint.result.subarray(surfaceOffset, surfaceOffset + 3)], [16, 43, 66], 'painted popup pixel is opaque approved dark surface');
      assert.equal(metrics.product, 'Aithema 2026.10'); assert.equal(metrics.first, 'version-row');
      assert.equal(metrics.version, '26.10.14 · 08:00');
      assert.equal(metrics.build, 'Build abcdef1 · 2026-10-14 08:00:00 UTC');
      assert.match(metrics.title, /261014080000\.0\.0.*2026-10-14 08:00:00 UTC/u);
      assert.deepEqual(await boxes(page, ['.display-foot', '.ai-notice', '.host-credits', '.footer-right']), footerBefore);
      await capture(locale, theme, width, state, metrics);
    }
    if (width === 1440) {
      const before = await popupMetrics(); await page.evaluate(() => { window.ait105Copied = null; });
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await until(page, () => window.ait105Copied === '261014080000.0.0');
      const copied = await popupMetrics(); assert.equal(copied.text, locale === 'de' ? 'Kopiert' : 'Copied');
      assert.equal(copied.valueVisibility, 'hidden'); assert.equal(copied.feedbackPosition, 'static');
      assert.equal(copied.feedbackBox[1], copied.row[1]);
      assert.deepEqual(copied.row, before.row); assert.deepEqual(copied.popup, before.popup);
      assert.equal(copied.ring, true);
      await capture(locale, theme, width, 'copied', copied);
      await new Promise(resolve => setTimeout(resolve, 1300));
      assert.equal((await popupMetrics()).text, 'Version 26.10.14 · 08:00');
    }
    if (locale === 'de' && theme === 'light' && width === 1440) {
      await shadow(page, c => c.shadowRoot.activeElement?.blur()); await notice.hover();
      const before = await popupMetrics(); await page.click('aithema-session >>> #build-info .version-row');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('[data-copy-state="copied"]'));
      const copied = await popupMetrics(); assert.equal(copied.ring, false);
      assert.deepEqual(copied.row, before.row); assert.deepEqual(copied.popup, before.popup);
      await capture(locale, theme, width, 'copied-mouse', copied);
      await new Promise(resolve => setTimeout(resolve, 1300));
    }
    const originalColor = await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('#build-info .yy')).color);
    await shadow(page, c => { c.style.setProperty('--aithema-accent', '#a52233'); });
    await configure(locale);
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('#build-info .yy')).color), originalColor, 'popup primary version does not inherit host accent overrides');
    await shadow(page, c => c.style.removeProperty('--aithema-accent'));
    await configure(locale, 'semver');
    const reduced = await page.$('aithema-session >>> #build-info .coordinate');
    assert.equal(await reduced.evaluate(n => n.textContent), '261014080000.0.0');
    await shadow(page, c => c.shadowRoot.querySelector('.ai-notice').focus());
    await page.evaluate(() => { window.ait105Copied = null; }); await reduced.click();
    assert.equal(await page.evaluate(() => window.ait105Copied), '261014080000.0.0');
  }
  await page.evaluate(async () => {
    const c = document.querySelector('aithema-session');
    c.configure({ copy: window.ait105Copy, session: c.session, host: { version: { version: '261014080000.0.0', version_scheme: 'future-scheme' } } });
  });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#build-info .coordinate')), null);
  assert.equal(await shadow(page, c => Boolean(c.session.id && c.shadowRoot.querySelector('textarea'))), true);
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait105-version-pass-lines.json'), JSON.stringify(passLines, null, 2));
});
