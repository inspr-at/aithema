import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  await new Promise(requestAnimationFrame);
});

test('AIT-173: large voice hold, reconciling and genuine low; DE/EN L/D 390/1024/1440; 0 px shift', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-credit-hold-'));
  const fixture = await startChild(new URL('../fixtures/credit-hold.js', import.meta.url), join(directory, 'unused.sqlite'));
  let browser;
  t.after(async () => { await browser?.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, passes = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => customElements.get('aithema-session'));
  for (const locale of ['de', 'en']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    let baseline;
    for (const state of ['in-call', 'reconciling', 'low', 'full-hold']) {
      await shadow(page, async (c, { locale, state }) => {
        const { session } = await (await fetch(`/fixture?state=${state}`)).json();
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        const { voiceEvents } = await import('/packages/core/src/live-voice.js');
        session.locale = locale; session.demo = false; session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
        session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
        const voiceClient = { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native' } } },
          async start(request) { const events = voiceEvents(); return { callId: request.callId, providerSessionId: 'hold-fixture', events,
            async setInput() {}, async setOutput() {}, async heartbeat() {}, async updateContext() {},
            async close() { events.end(); return { closureConfirmed: false, outcome: 'uncertain', usage: null }; } }; } };
        c.setAttribute('motion', 'off');
        c.configure({ session, copy, voiceClient, host: { credits: true, verification: { delivery: false, privacyDocumentConfigured: true } } });
        const legal = document.createElement('a'); legal.slot = 'legal'; legal.href = '/privacy'; legal.setAttribute('data-aithema-privacy', ''); c.replaceChildren(legal);
        c.shadowRoot.querySelector('.voice-start').click();
      }, { locale, state });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.trim() !== '…');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      if (state === 'reconciling') {
        await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
        await until(page, () => /abgeglichen|reconciled/u.test(document.querySelector('aithema-session').shadowRoot.querySelector('.voice-state').textContent));
      }
      await settle(page);
      const targets = ['.composer-shell', '.display-foot', '.host-credits', '.audio-rail', '.host-credits__amount'];
      if (width < 960) await shadow(page, c => c.shadowRoot.querySelector('.composer-dock').scrollIntoView({ block: 'end' }));
      await settle(page);
      const rects = await boxes(page, targets); baseline ??= rects;
      for (const theme of ['light', 'dark']) {
        await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
        const view = await shadow(page, c => ({ low: c.shadowRoot.querySelector('.host-credits').dataset.low,
          amount: c.shadowRoot.querySelector('.host-credits__amount').textContent,
          ask: c.shadowRoot.querySelector('.workspace').dataset.emailAsk,
          rail: c.shadowRoot.querySelector('.voice-state').textContent,
          ending: c.shadowRoot.querySelector('.audio-rail').hasAttribute('data-credit-ending'),
          title: c.shadowRoot.querySelector('.host-credits__button').getAttribute('title'),
          description: c.shadowRoot.querySelector('.host-credits__button').getAttribute('aria-description'),
          footer: c.shadowRoot.querySelector('.host-credits').textContent,
          numericStyle: getComputedStyle(c.shadowRoot.querySelector('.host-credits__amount')).fontVariantNumeric,
          usedUp: c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up') }));
        assert.equal(view.low, ['low', 'full-hold'].includes(state) ? 'true' : 'false', `${locale}/${width}/${state}: ${JSON.stringify(view)}`);
        assert.equal(view.usedUp, false); assert.equal(view.ending, false);
        if (!['low', 'full-hold'].includes(state)) { assert.equal(view.ask, 'closed'); assert.equal(view.amount.replace(/[.,]/gu, ''), '600'); assert.doesNotMatch(view.rail, /wenig|low|aufgebraucht|used up/iu); }
        else assert.match(view.rail, locale === 'de' ? /wenig/u : /low/u);
        const reconciliation = locale === 'de' ? 'Kosten werden noch abgeglichen' : 'Costs are still being reconciled';
        assert.equal(view.title, state === 'reconciling' ? reconciliation : null);
        assert.equal(view.description, state === 'reconciling' ? reconciliation : null);
        assert.equal(view.footer.includes(reconciliation), false, 'reconciliation has no visible footer hint');
        assert.match(view.numericStyle, /tabular-nums/u);
        if (state === 'reconciling') assert.match(view.rail, locale === 'de' ? /Kosten werden noch abgeglichen/u : /Costs are still being reconciled/u);
        const after = await boxes(page, targets), shift = Math.max(...baseline.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
        assert.equal(shift, 0, `${locale}/${width}/${state}: layout shift ${shift} px`);
        const pass = { head: evidenceCommit, locale, width, theme, state, layoutShiftPx: shift, tooltip: view.title, accessibleDescription: view.description, amount: view.amount, numericStyle: view.numericStyle, pass: true }; passes.push(pass);
        console.log(`AIT-173 PASS ${locale} ${theme} ${width} ${state}: hold-safe credits; footer tooltip=${view.title ?? "none"}; shift=${shift}px`);
        if (evidence) await page.screenshot({ path: join(evidence, `ait173-${locale}-${theme}-${width}-${state}.png`), fullPage: false });
      }
      if (state === 'reconciling') {
        const before = await boxes(page, targets);
        await shadow(page, async c => { await fetch('/reconcile'); c.receive({ type: 'voice.state', data: { state: 'ended' } }); });
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.trim() === '595');
        await settle(page);
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__button').hasAttribute('title')), false);
        const after = await boxes(page, targets), shift = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
        assert.equal(shift, 0, `${locale}/${width}: settlement shifted the credit number by ${shift}px`);
        passes.push({ head: evidenceCommit, locale, width, state: 'settled', layoutShiftPx: shift, pass: true });
        console.log(`AIT-173 PASS ${locale} ${width} settled: tooltip cleared; number changed in place; shift=${shift}px`);
      }
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait173-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});
