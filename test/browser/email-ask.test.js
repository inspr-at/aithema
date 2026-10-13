import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 500));
const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
const fixed = ['.composer-shell', '.send', '.understanding > .foot', '.display-foot', '.host-credits', '.engine-info'];
const stable = (before, after, label) => {
  const shift = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
  assert.equal(shift, 0, `${label}: layout shift ${shift} px; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return shift;
};

// Only this test supplies fixture values. The shipped component reads every
// tier, price, balance, address and ask record through its normal host routes.
async function fixture(page, locale, { delivery = false, address = null, confirmed = false, low = false, out = false, voice = false, motion = 'off' } = {}) {
  await shadow(page, async (c, options) => {
    const { locale, delivery, address, confirmed, low, out, voice, motion } = options;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { inputRevision } = await import('/packages/core/src/session.js');
    const { voiceEvents } = await import('/packages/core/src/live-voice.js');
    window.ait164Fetch ??= window.fetch.bind(window);
    const allowancesMicro = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
    const state = window.ait164 = { address, confirmed, spent: 3_450_000, ask: {}, after: 0, saving: false, linkFails: false, requests: [], voiceEvents: null };
    const tier = () => state.confirmed ? 'emailConfirmed' : state.address ? 'emailGiven' : 'anonymous';
    const identity = () => ({ ...c.session.identity, address: state.address, status: state.confirmed ? 'verified' : state.address && delivery ? 'verification-pending' : 'guest',
      assessmentUnlocked: true, conceptsUnlocked: true, verificationRequired: false, pollVerification: false, resendAfterMs: 0, delivery: 'sent' });
    const visitor = () => ({ address: state.address, tier: tier(), limitMicro: allowancesMicro[tier()] });
    if (low || out) state.spent = allowancesMicro[tier()] - (out ? 0 : 980_000);
    const credits = () => { const current = tier(), limitMicro = allowancesMicro[current], next = !state.address ? 'emailGiven' : delivery && !state.confirmed ? 'emailConfirmed' : null;
      return { tiers: { current, next, delta: next ? allowancesMicro[next] - limitMicro : 0, canConfirm: delivery, allowancesMicro },
        exhausted: state.spent >= limitMicro, lowAtMicro: Math.max(limitMicro / 10, 5 * 100_000),
        emailAsk: state.ask, emailAskAfter: state.after, nowMs: Date.now(), limitSlot: null,
        balance: { owner: { limitMicro, committedMicro: state.spent, confirmedSpendMicro: state.spent, reservedMicro: 0, uncertainSpendMicro: 0, availableMicro: Math.max(0, limitMicro - state.spent) } } }; };
    state.credits = credits;
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, method = init.method ?? 'GET';
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      if (path.endsWith('/credits')) return Response.json(credits());
      if (path === `/api/sessions/${c.session.id}`) return Response.json({ ...c.session, identity: identity(), featureMatrix: c.session.featureMatrix });
      if (path.endsWith('/visitor/email')) {
        if (method === 'PUT') { state.requests.push('save'); while (state.saving) await new Promise(resolve => setTimeout(resolve, 20)); state.address = JSON.parse(init.body).address; state.confirmed = false; }
        return Response.json({ visitor: visitor(), notice: { version: 'ait-135-v1', deliveryEnabled: delivery }, privacyDocumentConfigured: true });
      }
      if (path.endsWith('/identity')) return Response.json({ identity: identity(), delivery, privacyDocumentConfigured: true });
      if (/\/identity\/(request|change|resend)$/u.test(path)) { state.requests.push('link'); return Response.json({ identity: identity() }, { status: state.linkFails ? 503 : 200 }); }
      if (path.endsWith('/email-ask')) {
        const body = JSON.parse(init.body), count = c.session.transcript.filter(t => t.role === 'user' && !t.erased).length;
        let accepted = true;
        if (body.action === 'show') {
          if (body.why === 'turn5' && state.after > Date.now() || body.why === 'low' && state.ask.shownLow) accepted = false;
          else { Object.assign(state.ask, { open: true, why: body.why, openedAt: count, folded: false, [body.why === 'low' ? 'shownLow' : 'shown5']: true }); if (body.why === 'turn5') state.after = Date.now() + 86_400_000; }
        } else if (body.action === 'line') {
          const values = credits(), next = values.tiers.next;
          state.ask.lowLine ??= { at: c.session.transcript.at(-1).id, kind: next === 'emailGiven' ? 'give' : next === 'emailConfirmed' ? 'confirm' : 'none', deltaMicro: values.tiers.delta, availableMicro: values.balance.owner.availableMicro };
        } else { state.ask.open = false; state.ask.folded = body.action === 'fold'; }
        if (accepted) state.ask.revision = (state.ask.revision ?? 0) + 1;
        return Response.json({ accepted, emailAsk: state.ask, emailAskAfter: state.after, nowMs: Date.now() });
      }
      return window.ait164Fetch(url, init);
    };
    for (const n of c.querySelectorAll('[slot="legal"]')) n.remove();
    const legal = document.createElement('a'); legal.slot = 'legal'; legal.href = '/privacy'; legal.setAttribute('data-aithema-privacy', ''); c.append(legal);
    const session = structuredClone(c.session); session.locale = locale; session.demo = false; session.paused = false; delete session.voiceLifecycle;
    session.identity = identity(); session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
    session.transcript = Array.from({ length: 4 }, (_, i) => [
      { id: `fixture-u${i}`, role: 'user', content: locale === 'de' ? 'Ich möchte meine Anforderungen besprechen.' : 'I would like to discuss my requirements.' },
      { id: `fixture-a${i}`, role: 'assistant', content: locale === 'de' ? 'Welche Ziele haben Sie?' : 'What are your goals?' },
    ]).flat();
    session.understanding = { ...session.understanding, inputRevision: inputRevision(session), readinessAssessed: true,
      summary: locale === 'de' ? 'Die Person möchte eine Website für ihr Vorhaben.' : 'The person wants a website for their project.', conversationReadiness: .5, implementationReadiness: .2 };
    session.featureMatrix = { best: { text: { available: !out }, analysis: { available: true }, voice: { available: !out } } };
    const voiceClient = voice ? { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native' } } },
      async start(request) { const events = voiceEvents(); state.voiceEvents = events; return { callId: request.callId, providerSessionId: 'gate-fixture-provider', events,
        async setInput() {}, async setOutput() {}, async updateContext() {}, async heartbeat() {}, async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; }, async close() { events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } }; } } : undefined;
    c.setAttribute('motion', motion); c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery, privacyDocumentConfigured: true } } });
    state.reply = () => { const i = c.session.transcript.length;
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `u${i}`, role: 'user', content: locale === 'de' ? 'Ja.' : 'Yes.' } });
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `a${i}`, role: 'assistant', content: locale === 'de' ? 'Wie soll es weitergehen?' : 'How would you like to continue?' } }); };
    if (voice) c.shadowRoot.querySelector('.voice-start').click();
  }, { locale, delivery, address, confirmed, low, out, voice, motion });
  await settle();
  // Capture the live dock above the fixed footer, with the sticky band still
  // in the viewport. A full-page capture would repaint that band over content.
  if (page.viewport().width < 960) {
    await shadow(page, c => c.shadowRoot.querySelector('.composer-dock').scrollIntoView({ block: 'end' }));
    await page.evaluate(() => window.scrollBy(0, 72));
    await settle();
  }
}

test('AIT-164: viewport state matrix, DE/EN light/dark 390/1024/1440; zero layout shift', { timeout: 480_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-email-ask-')), evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  let browser; t.after(async () => { await browser?.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const passes = [];
  for (const locale of ['de', 'en']) {
    browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, locale), env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
    await page.select('#locale', locale);
    await until(page, locale => document.querySelector('aithema-session')?.session.locale === locale, locale);
    for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await page.setViewport({ width, height: 1000 }); await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
      const label = `${locale}-${theme}-${width}`;
      // The stacked assessment is below the phone viewport. Only controls
      // visible under its pointer are part of that viewport's shift contract.
      const targets = width >= 960 ? fixed : fixed.filter(selector => !selector.startsWith('.understanding'));
      let baseline;
      const shot = async state => {
        await settle(); const shift = stable(baseline, await boxes(page, targets), `${label}/${state}`);
        passes.push({ head: evidenceCommit, locale, theme, width, state, layoutShiftPx: shift, pass: true });
        if (evidence) await page.screenshot({ path: join(evidence, `ait164-${label}-${state}.png`), fullPage: false });
      };
      const reply = async () => { await page.evaluate(() => window.ait164.reply()); await settle(); };
      await fixture(page, locale); baseline = await boxes(page, targets); await shot('before');
      await reply();
      const gate = await shadow(page, c => ({ placement: c.shadowRoot.querySelector('.workspace').dataset.emailAsk, focus: c.shadowRoot.activeElement?.id ?? null }));
      assert.equal(gate.placement, width >= 960 ? 'pane' : 'dock'); assert.notEqual(gate.focus, 'email-ask-input'); await shot('gate');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'visitor@example.test'; input.focus({ preventScroll: true }); }); await shot('gate-typing');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'invalid-address'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('#email-ask-input').getAttribute('aria-invalid')), 'true'); await shot('gate-invalid');
      await page.evaluate(() => { window.ait164.saving = true; });
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#email-ask-input'); input.value = 'visitor@example.test'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); }); await shot('gate-saving');
      await page.evaluate(() => { window.ait164.saving = false; }); await settle(); await shot('gate-saved');
      await click(page, '.email-ask__skip'); await shot('gate-dismissed');
      await fixture(page, locale, { delivery: true }); baseline = await boxes(page, targets); await reply(); await shot('gate-mail');
      await shadow(page, c => { c.shadowRoot.querySelector('#email-ask-input').value = 'visitor@example.test'; c.shadowRoot.querySelector('#email-ask-form').requestSubmit(); }); await settle();
      assert.deepEqual(await page.evaluate(() => window.ait164.requests), ['save', 'link']); await shot('gate-saved-mail');
      for (const [state, options] of [
        ['low-text', { low: true }], ['low-voice', { low: true, voice: true }],
        ['low-given', { low: true, address: 'visitor@example.test' }], ['low-confirmed', { low: true, address: 'visitor@example.test', delivery: true, confirmed: true }],
        ['low-pending', { low: true, address: 'visitor@example.test', delivery: true }], ['out', { out: true }],
      ]) {
        await fixture(page, locale, options); baseline = await boxes(page, targets); await reply();
        const values = await shadow(page, c => ({ ask: c.shadowRoot.querySelector('.workspace').dataset.emailAsk, low: c.shadowRoot.querySelector('.host-credits').dataset.low,
          line: Boolean(c.shadowRoot.querySelector('.email-low-line')), rail: c.shadowRoot.querySelector('.voice-state').textContent, usedUp: c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up') }));
        if (state === 'out') assert.equal(values.usedUp, true);
        else assert.equal(values.low, 'true');
        if (state === 'low-voice') { assert.equal(values.ask, 'closed'); assert.equal(values.line, false); assert.equal(values.rail, locale === 'de' ? 'Noch wenig Guthaben' : 'Credit running low'); }
        if (options.address) assert.equal(values.ask, 'closed');
        await shot(state);
        if (state === 'low-voice') { await click(page, '.voice-pause'); await settle(); await shot('low-after-call'); assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed'); }
      }
      // Fold, deferred typing, no mid-stream opening, and changing digit count.
      await fixture(page, locale); baseline = await boxes(page, targets); await reply();
      if (width >= 960) { await reply(); await reply(); assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.email-ask-fold')).visibility), 'visible'); await shot('gate-folded'); }
      await fixture(page, locale); baseline = await boxes(page, targets);
      const footerBefore = await boxes(page, ['.host-credits', '.engine-info']);
      await page.evaluate(() => { window.ait164.after = Date.now() + 86_400_000; window.ait164.spent = 12_000_000 - 980_000; window.ait164.reply(); }); await settle();
      stable(footerBefore, await boxes(page, ['.host-credits', '.engine-info']), `${label}/footer-fewer-digits`);
      const footer = await shadow(page, c => { const r = c.shadowRoot, left = r.querySelector('.ai-notice').getBoundingClientRect(), credit = r.querySelector('.host-credits').getBoundingClientRect(); return { gap: credit.left - left.right, numeric: getComputedStyle(r.querySelector('.host-credits__amount')).fontVariantNumeric }; });
      assert.ok(footer.gap >= 23.5, `${label}: footer gap ${footer.gap}`); assert.equal(footer.numeric, 'tabular-nums'); await shot('footer-fewer-digits');
      await fixture(page, locale, { motion: 'on' }); baseline = await boxes(page, targets);
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#message'); input.value = 'draft'; input.focus(); input.dispatchEvent(new Event('input')); });
      await reply(); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed', 'typing defers the ask');
      await shadow(page, c => { const input = c.shadowRoot.querySelector('#message'); input.value = ''; input.blur(); });
      await new Promise(resolve => setTimeout(resolve, 1650)); await settle();
      assert.notEqual(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed');
      if (width < 960) {
        const lift = await shadow(page, c => { const r = c.shadowRoot; return r.querySelector('.composer-shell').getBoundingClientRect().bottom - r.querySelector('.email-ask').getBoundingClientRect().bottom; });
        assert.equal(lift, 20, 'phone gate lifts exactly 20 px');
      }
      await shot('flow-gate');
      await fixture(page, locale); baseline = await boxes(page, targets);
      await shadow(page, c => { c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'stream-u5', role: 'user', content: 'A requirement.' } });
        c.receive({ type: 'turn.partial', data: { id: 'stream-a5', delta: 'A partial reply', inputRevision: c.session.inputRevision } }); });
      await settle(); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed', 'no ask during the fifth reply');
      await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'stream-a5', role: 'assistant', content: 'A complete reply.' } })); await shot('flow-stream-finished');
      await fixture(page, locale, { voice: true }); baseline = await boxes(page, targets); await reply();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.emailAsk), 'closed'); await shot('flow-call');
      await page.evaluate(() => { window.ait164.spent = 12_000_000 - 720_000; window.ait164.reply(); }); await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-low-line') === null), true); await shot('flow-low-call');
      await click(page, '.voice-close'); await settle(); await shot('flow-low-call-ended');
      assert.deepEqual(errors, [], label);
    }
    await browser.close(); browser = null;
  }
  if (evidence) await writeFile(join(evidence, 'ait164-pass-lines.json'), JSON.stringify({ head: evidenceCommit, runner: 'mbp2606/CI', captures: 'viewport', passes }, null, 2));
  t.diagnostic(`AIT-164 HEAD ${evidenceCommit}: ${passes.length} viewport state checks PASS; layout shift 0 px`);
});
