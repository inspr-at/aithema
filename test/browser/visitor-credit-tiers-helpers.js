// AIT-135 A2 D. The shipped component against deterministic owner-route fixtures.
// Run exclusively through remote-browser.sh or CI; screenshots never render the design mock.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { assertMatrixCaseCount, fullMatrix, matrixWidths } from './matrix-coverage.js';
import { startChild } from '../helpers.js';

const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn) => page.waitForFunction(fn, { timeout: 20_000, polling: 40 });
const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
// Wait for the rendered fixture and finite UI transitions instead of paying
// 450 ms after every action in all twelve viewport/theme/language combinations.
const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect.getComputedTiming().endTime))
    .map(animation => animation.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
const unchanged = (before, after, label) => {
  const displacement = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
  assert.equal(displacement, 0, `${label}: surrounding controls displaced ${displacement} px; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return displacement;
};

export async function fixture(page, locale, { address = null, spent = 3_450_000, reserved = 0, delivery = false, privacy = true, handover = false, confirmed = false, voiceRunning = false, voiceAdmissionFailure = false, waitingCall = false } = {}) {
  await shadow(page, async (c, options) => {
    const { locale, address, spent, reserved, delivery, privacy, handover, confirmed, voiceRunning, voiceAdmissionFailure, waitingCall } = options;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { inputRevision } = await import('/packages/core/src/session.js');
    window.a2OriginalFetch ??= window.fetch.bind(window);
    const state = window.a2 = { address, spent, reserved, delivery, privacy, confirmed, saving: false,
      denyVoice: voiceAdmissionFailure, voiceRequests: [], voiceCloses: 0, creditsReads: 0 };
    const allowancesMicro = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
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
    const session = structuredClone(c.session); session.locale = locale; session.demo = false; session.paused = false; session.identity = identity(); session.credits = null;
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
          if (state.denyVoice) throw Object.assign(new Error('fixture admission refused'), { code: 'not-admitted', reason: 'host-limit' });
          const events = voiceEvents();
          return { callId: request.callId, providerSessionId: 'fixture-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async heartbeat() {},
            async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
            async close() { state.voiceCloses++; events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } };
        } };
    }
    c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery, privacyDocumentConfigured: privacy }, handover } });
    if (voiceRunning) c.shadowRoot.querySelector('.voice-start').click();
  }, { locale, address, spent, reserved, delivery, privacy, handover, confirmed, voiceRunning, voiceAdmissionFailure, waitingCall });
  await until(page, () => window.a2.creditsReads > 0);
  await settle(page);
}

export async function visitorCreditMatrix(t, locales) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-a2-browser-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await demo.kill(); await rm(directory, { recursive: true, force: true }); } });
  if (evidence) await mkdir(evidence, { recursive: true });
  const head = process.env.GITHUB_SHA ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1];
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const branchHead = event?.pull_request?.head?.sha ?? head;
  const passLines = [], states = [], captures = [], uiChecks = [];
  for (const locale of locales) {
    browser = await browserForFile();
    const page = await browser.newPage();
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
      assert.match(sent.confirmation, locale === 'de' ? /^Wir haben Ihnen einen Bestätigungslink geschickt/u : /^We sent you a confirmation link/u);
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
        await page.screenshot({ path: join(evidence, `ait155-full-hold-${label}.png`), fullPage: false });
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
      assert.equal(capturedRailText, locale === 'de' ? 'Credits aufgebraucht' : 'Credits used up', `${label}: F7 after-hangup-used-up capture matches its label`);
      passLines.push({ locale, theme, width, state: 'after-hangup-used-up', displacementPx: endingDisplacement, railText: capturedRailText, pass: true }); await shot('after-hangup-used-up');
      const calm = await shadow(page, c => {
        const r = c.shadowRoot, ink = getComputedStyle(r.querySelector('.composer-out__title')).color;
        return { questionReadable: !r.querySelector('.question-card').hidden, answersRest: r.querySelector('.question-card').inert,
          pauseDisabled: r.querySelector('.pause').disabled, neutral: ['.voice-close', '.pause', '.host-credits__used-up'].every(selector => getComputedStyle(r.querySelector(selector)).color === ink) };
      });
      assert.deepEqual(calm, { questionReadable: true, answersRest: true, pauseDisabled: true, neutral: true });
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.composer-out__upgrade')).color), theme === 'dark' ? 'rgb(18, 144, 140)' : 'rgb(14, 111, 108)', 'the host-limit upgrade link keeps the approved START teal');
      passLines.push({ locale, theme, width, state: 'run-out', displacementPx: unchanged(liveBefore, await boxes(page, liveFixed), `${label}/run-out`), pass: true }); await shot('run-out');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no horizontal overflow');
    }
    assert.deepEqual(problems, []);
    await browser.close(); browser = null;
  }
  assertMatrixCaseCount('visitor-credit', states.length);
  const stamp = rows => rows.map(row => ({ head, branchHead, ...row }));
  if (evidence) await writeFile(join(evidence, `a2-${locales.join('-')}-pass-lines.json`), JSON.stringify({ head, branchHead, runner: 'remote/CI', source: 'shipped component with owner-route fixtures; language selected through the picker', passLines: stamp(passLines), uiChecks: stamp(uiChecks), states, captures }, null, 2));
  for (const row of [...passLines, ...uiChecks].filter(row => [390, 1440].includes(row.width) && ['full-hold-call', 'deleting', 'mail-confirm-dialog'].includes(row.state))) {
    t.diagnostic(`PASS branch-head=${branchHead} source-head=${head} ${row.locale}-${row.theme}-${row.width}/${row.state}${row.displacementPx === 0 ? ' 0 px layout shift' : ''} ${JSON.stringify(row)}`);
  }
  t.diagnostic(`${passLines.length} zero-displacement checks; ${states.length} states; ${captures.length} viewport screenshots across all ${new Set(states.map(row => `${row.locale}/${row.theme}/${row.width}`)).size} viewport/theme/language combinations`);
}
