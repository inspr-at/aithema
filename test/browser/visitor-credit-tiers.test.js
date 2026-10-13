// AIT-135 A2 D. The shipped component against deterministic owner-route fixtures.
// Run exclusively through remote-browser.sh or CI; screenshots never render the design mock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';

async function browserPath() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name)))];
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* remote runner */ } }
  throw new Error('No browser on remote runner');
}
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn) => page.waitForFunction(fn, { timeout: 20_000, polling: 40 });
const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
const settle = () => new Promise(resolve => setTimeout(resolve, 450));
const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
const unchanged = (before, after, label) => {
  const displacement = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
  assert.equal(displacement, 0, `${label}: surrounding controls displaced ${displacement} px; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return displacement;
};

async function fixture(page, locale, { address = null, spent = 3_450_000, delivery = false, privacy = true, handover = false, confirmed = false, voiceRunning = false } = {}) {
  await shadow(page, async (c, options) => {
    const { locale, address, spent, delivery, privacy, handover, confirmed, voiceRunning } = options;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { inputRevision } = await import('/packages/core/src/session.js');
    window.a2OriginalFetch ??= window.fetch.bind(window);
    const state = window.a2 = { address, spent, delivery, privacy, confirmed, saving: false };
    const allowancesMicro = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
    const identity = () => ({ ...c.session.identity, address: state.address, status: state.confirmed ? 'verified' : state.address && delivery ? 'verification-pending' : 'guest',
      assessmentUnlocked: true, conceptsUnlocked: true, verificationRequired: false, resendAfterMs: 0, pollVerification: false, delivery: 'sent' });
    const current = () => state.confirmed ? 'emailConfirmed' : state.address ? 'emailGiven' : 'anonymous';
    const visitor = () => ({ address: state.address, tier: current(), limitMicro: allowancesMicro[current()] });
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, method = init.method ?? 'GET';
      if (method === 'GET' && path === `/api/sessions/${c.session.id}`) return Response.json({ ...c.session, identity: identity(), featureMatrix: { best: Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, { available: allowancesMicro[current()] > state.spent, reason: allowancesMicro[current()] > state.spent ? null : 'budget denied' }])) } });
      if (path.endsWith('/credits')) {
        const tier = current(), next = !privacy ? null : !state.address ? 'emailGiven' : delivery && !state.confirmed ? 'emailConfirmed' : null;
        const limitMicro = allowancesMicro[tier];
        return Response.json({ balance: { owner: { limitMicro, committedMicro: state.spent, availableMicro: Math.max(0, limitMicro - state.spent) } }, limitSlot: null,
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
    const session = structuredClone(c.session); session.locale = locale; session.demo = false; session.paused = false; session.identity = identity();
    session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
    session.transcript = [{ id: 'visitor-fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte meine Anforderungen besprechen.' : 'I would like to discuss my requirements.' }];
    const question = locale === 'de' ? 'Welche Anforderungen möchten Sie besprechen?' : 'Which requirements would you like to discuss?';
    session.transcript.push({ id: 'visitor-fixture-question', role: 'assistant', content: question, inputRevision: inputRevision(session),
      question_short: question, options: [{ text: locale === 'de' ? 'Ziele' : 'Goals', likely: true }, { text: locale === 'de' ? 'Ressourcen' : 'Resources' }] });
    session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
    c.setAttribute('motion', 'off');
    let voiceClient;
    if (voiceRunning) {
      const { voiceEvents } = await import('/packages/core/src/live-voice.js'); const events = voiceEvents();
      voiceClient = { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native', sendText: 'native' } } },
        async start() { return { callId: 'fixture-call', providerSessionId: 'fixture-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async heartbeat() {},
          async close() { events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } }; } };
    }
    c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery, privacyDocumentConfigured: privacy }, handover } });
    document.documentElement.lang = locale;
    if (voiceRunning) c.shadowRoot.querySelector('.voice-start').click();
  }, { locale, address, spent, delivery, privacy, handover, confirmed, voiceRunning });
  await settle();
}

test('AIT-135 A2 D: every visitor state, DE/EN, light/dark, 1440/1024/390; zero displacement', { timeout: 360_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-a2-browser-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await demo.kill(); await rm(directory, { recursive: true, force: true }); } });
  if (evidence) await mkdir(evidence, { recursive: true });
  const passLines = [], states = [], captures = [];
  for (const locale of ['de', 'en']) {
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome-' + locale),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    const problems = []; page.on('pageerror', error => problems.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session);
    for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      const label = `${locale}-${theme}-${width}`;
      const shot = async state => {
        await new Promise(resolve => setTimeout(resolve, 160)); states.push({ locale, theme, width, state });
        if (!evidence) return;
        // Capture actual viewports: full-page painting moves sticky band/dock content over the page.
        await shadow(page, c => {
          window.a2ShotScroll = { page: [scrollX, scrollY], panes: [...c.shadowRoot.querySelectorAll('*')].map(n => [n, n.scrollLeft, n.scrollTop]) };
          if (!c.shadowRoot.querySelector('dialog[open]')) scrollTo({ top: 0, behavior: 'instant' });
        });
        const capture = async suffix => {
          const file = `a2-${label}-${state}${suffix}.png`;
          await page.screenshot({ path: join(evidence, file), fullPage: false });
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
                n.scrollIntoView({ block: 'end', behavior: 'instant' }); return true;
              }, selector);
              if (scrolled) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await capture(suffix); }
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
      await click(page, '.credits-email'); await settle();
      const fixed = ['.settings__tabs', '.general-new', '.general-consent-manage', '.general-recommended', '.host-verify', '.settings-context', '.settings__footer'];
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), true, 'the credit link opened Settings');
      const before = await boxes(page, fixed);
      const check = async state => { await settle(); const displacementPx = unchanged(before, await boxes(page, fixed), `${label}/${state}`); passLines.push({ locale, theme, width, state, displacementPx, pass: true }); await shot(state); };
      await check('no-email');
      const targets = await shadow(page, c => ['.m-in', '.m-save', '#email-notice .m-pp'].map(selector => {
        const n = c.shadowRoot.querySelector(selector), rect = n.getBoundingClientRect(), after = getComputedStyle(n, '::after');
        return rect.height + Math.max(0, -(parseFloat(after.top) || 0)) + Math.max(0, -(parseFloat(after.bottom) || 0));
      }));
      const primary = await shadow(page, c => { const button = c.shadowRoot.querySelector('.m-save'), style = getComputedStyle(button); return { label: button.textContent, color: style.color, background: style.backgroundColor }; });
      assert.ok(primary.label && primary.color !== primary.background, 'the save label is visible on its primary fill');
      assert.ok(targets.every(height => height >= 44), `44 px capture and privacy targets: ${targets}`);
      await shadow(page, c => { c.shadowRoot.querySelector('#email-input').value = 'reader@example.test'; }); await check('typing');
      await shadow(page, c => { c.shadowRoot.querySelector('#email-input').value = 'reader'; c.shadowRoot.querySelector('.m-form').requestSubmit(); }); await check('invalid');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-input'); input.value = 'reader@example.test'; input.dispatchEvent(new Event('input', { bubbles: true })); window.a2.saving = true; c.shadowRoot.querySelector('.m-form').requestSubmit(); }); await check('saving');
      await page.evaluate(() => { window.a2.saving = false; }); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-verify').dataset.emailState === 'saved'); await check('email-saved');
      await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-email-saved');
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle();
      await click(page, '.m-change'); await check('editing'); await click(page, '.m-cancel');
      await click(page, '.m-delete'); await check('deleting');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement?.className), 'm-act m-keep');
      await click(page, '.m-del'); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-verify').dataset.emailState === 'capture'); await check('deleted');
      await click(page, 'dialog.settings .done');
      await fixture(page, locale, { address: 'reader@example.test', spent: 15_000_000 });
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await click(page, '.m-delete'); await shot('over-spent-delete');
      await click(page, '.m-del'); await settle(); await shot('over-spent-deleted'); await click(page, 'dialog.settings .done'); await shot('credit-used-up-give');
      await click(page, '.host-credits__button'); await shot('credits-used-up-give');
      await fixture(page, locale, { address: 'reader@example.test', spent: 18_000_000 }); await shot('credit-used-up-none'); await click(page, '.host-credits__button'); await shot('credits-used-up-none');
      await fixture(page, locale, { privacy: false, spent: 12_000_000 });
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await shot('privacy-gate'); await click(page, 'dialog.settings .done'); await shot('privacy-gate-used-up');
      await fixture(page, locale, { handover: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await shot('handover-notice');
      await click(page, 'dialog.settings .done');
      await fixture(page, locale, { delivery: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await shot('mail-no-email');
      await click(page, '.verify-entry'); await settle(); await shot('mail-confirm-dialog');
      await shadow(page, c => { c.shadowRoot.querySelector('#verify-dialog-email').value = 'reader@example.test'; c.shadowRoot.querySelector('dialog.verify-dialog form').requestSubmit(); }); await settle(); await shot('mail-link-sent');
      await page.keyboard.press('Escape');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test' }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await shot('mail-pending'); await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-mail-pending');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test', confirmed: true }); await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(); await shot('mail-confirmed'); await click(page, 'dialog.settings .done'); await click(page, '.host-credits__button'); await shot('credits-mail-confirmed');
      await fixture(page, locale, { delivery: true, address: 'reader@example.test', spent: 18_000_000 }); await shot('credit-used-up-confirm');
      await fixture(page, locale, { spent: 11_990_000, voiceRunning: true });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      const liveFixed = ['.band', '.question-card', '.composer-dock', '.composer-shell', '.display-foot', '.export', '.concept-bar'];
      const liveBefore = await boxes(page, liveFixed);
      await shadow(page, c => { window.a2.spent = 12_000_000; c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }); });
      const endingDisplacement = unchanged(liveBefore, await boxes(page, liveFixed), `${label}/call-ending`);
      passLines.push({ locale, theme, width, state: 'call-ending', displacementPx: endingDisplacement, pass: true }); await shot('call-ending');
      await settle(); await settle();
      const calm = await shadow(page, c => {
        const r = c.shadowRoot, ink = getComputedStyle(r.querySelector('.composer-out__title')).color;
        return { questionReadable: !r.querySelector('.question-card').hidden, answersRest: r.querySelector('.question-card').inert,
          pauseDisabled: r.querySelector('.pause').disabled, neutral: ['.voice-close', '.pause', '.host-credits__used-up'].every(selector => getComputedStyle(r.querySelector(selector)).color === ink) };
      });
      assert.deepEqual(calm, { questionReadable: true, answersRest: true, pauseDisabled: true, neutral: true });
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-out__upgrade')).backgroundColor), theme === 'dark' ? 'rgb(18, 144, 140)' : 'rgb(14, 111, 108)', 'the used-up action keeps the approved START teal');
      passLines.push({ locale, theme, width, state: 'run-out', displacementPx: unchanged(liveBefore, await boxes(page, liveFixed), `${label}/run-out`), pass: true }); await shot('run-out');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no horizontal overflow');
    }
    assert.deepEqual(problems, []);
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'a2-pass-lines.json'), JSON.stringify({ head: process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1], runner: 'remote/CI', source: 'shipped component with owner-route fixtures', passLines, states, captures }, null, 2));
  t.diagnostic(`${passLines.length} zero-displacement checks; ${states.length} states; ${captures.length} viewport screenshots across all 12 viewport/theme/language combinations`);
});
