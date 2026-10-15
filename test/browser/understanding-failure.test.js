import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';
import { startChild } from '../helpers.js';

const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
});

test('AIT-198 failed overview: DE/EN 390/1440, immediate free visitor settlement, retry recovery and 0 px', { timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-understanding-failure-'));
  const fixture = await startChild(new URL('../fixtures/understanding-failure.js', import.meta.url), join(dir, 'unused.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [], passes = [];
  t.after(async () => { await browser.close(); await fixture.kill(); await rm(dir, { recursive: true, force: true }); });
  page.on('pageerror', error => errors.push(error.message));
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const width of [390, 1440]) for (const verdict of ['uncertain', 'failed']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    console.log(`AIT-198 fixture ${locale}/${width}/${verdict}: loading`);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    await shadow(page, async (c, locale) => {
      const response = await fetch('/fixture?locale=' + locale);
      if (!response.ok) throw new Error('Fixture setup failed: ' + await response.text());
      const session = await response.json();
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      c.setAttribute('motion', 'off'); c.configure({ session, copy, host: { credits: true } });
      window.fixtureComponent = c;
    }, locale);
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent.includes('…'));
    await settle(page);
    const targets = ['.understanding', '.composer-shell', '.display-foot', '.host-credits', '.audio-rail'];
    console.log(`AIT-198 fixture ${locale}/${width}/${verdict}: holding`);
    const before = await boxes(page, targets);
    const held = await shadow(page, c => c.shadowRoot.querySelector('.host-credits__amount').textContent);
    await page.evaluate((verdict, held) => { window.heldCredits = held; return fetch('/settle?verdict=' + verdict); }, verdict, held);
    console.log(`AIT-198 fixture ${locale}/${width}/${verdict}: settled`);
    const expected = locale === 'de' ? 'Der Überblick konnte gerade nicht erstellt werden · Erneut versuchen' : "The overview couldn't be built just now · Try again";
    await page.waitForFunction(expected => document.querySelector('aithema-session').shadowRoot.querySelector('.notice').textContent === expected, { timeout: 10_000 }, expected);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent !== window.heldCredits, undefined);
    await settle(page);
    const failed = await shadow(page, c => {
      const r = c.shadowRoot, n = r.querySelector('.notice'), s = getComputedStyle(n);
      const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;color:var(--aithema-muted)'; r.querySelector('.understanding').append(probe);
      const quietInk = getComputedStyle(probe).color; probe.remove();
      return { amount: r.querySelector('.host-credits__amount').textContent, color: s.color, quietInk,
        background: s.backgroundColor, alerts: r.querySelectorAll('.understanding [role="alert"]').length, reload: c === window.fixtureComponent };
    });
    assert.notEqual(failed.amount, held, 'same settlement releases the held visitor credits');
    const balance = await page.evaluate(async () => (await (await fetch(`/api/sessions/${document.querySelector('aithema-session').session.id}/credits`)).json()).balance.owner);
    assert.equal(balance.confirmedSpendMicro, (passes.length + 1) * 100_000 + passes.length * 100_000, 'only successful replies and previous successful analyses charge the visitor');
    assert.equal(balance.uncertainSpendMicro, 0); assert.equal(balance.reservedMicro, 0);
    assert.equal(failed.color, failed.quietInk);
    assert.equal(failed.alerts, 0); assert.equal(failed.background, 'rgba(0, 0, 0, 0)'); assert.equal(failed.reload, true);
    assert.deepEqual(await boxes(page, targets), before, 'failed overview causes 0 px surrounding displacement');
    if (evidence) await page.screenshot({ path: join(evidence, `ait198-${locale}-${width}-${verdict}.png`), fullPage: false, captureBeyondViewport: false });
    console.log(`AIT-198 fixture ${locale}/${width}/${verdict}: refund and geometry checked`);
    await page.evaluate(() => fetch('/success'));
    console.log('AIT-198 fixture: success enabled');
    const retry = await shadow(page, c => ({ inlineDisabled: c.shadowRoot.querySelector('.overview-retry').disabled, footerDisabled: c.shadowRoot.querySelector('.retry').disabled, operations: c.session.operations, features: c.session.featureMatrix }));
    assert.equal(retry.inlineDisabled, false, JSON.stringify(retry)); assert.equal(retry.footerDisabled, false, JSON.stringify(retry));
    console.log('AIT-198 fixture: retry enabled');
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/retry'), { timeout: 5000 }), shadow(page, c => c.shadowRoot.querySelector('.overview-retry').click())]);
    assert.equal(response.status(), 202);
    console.log(`AIT-198 fixture ${locale}/${width}/${verdict}: retry admitted`);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.summary-text').textContent === 'Ein Überblick. An overview.');
    await settle(page);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent), locale === 'de' ? 'Aktuelle Einschätzung' : 'Current assessment');
    assert.deepEqual(await boxes(page, targets), before, 'next success causes 0 px surrounding displacement');
    assert.equal(await shadow(page, c => c === window.fixtureComponent), true);
    const pass = { head: evidenceCommit, locale, width, verdict, visitorCharge: 0, layoutShiftPx: 0, recoveredWithoutReload: true, pass: true };
    passes.push(pass); console.log(`AIT-198 PASS ${locale} ${width} ${verdict}: quiet failure, hold released on settle, next success without reload, 0 px`);
    if (evidence) await page.screenshot({ path: join(evidence, `ait198-${locale}-${width}-${verdict}-recovered.png`), fullPage: false, captureBeyondViewport: false });
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'ait198-passes.json'), JSON.stringify({ head: evidenceCommit, passes }, null, 2));
});
