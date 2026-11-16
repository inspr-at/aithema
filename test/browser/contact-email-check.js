import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { shadow, until, boxes } from './start2-display-helpers.js';
import { fixture, settle, stable } from './email-ask-fixture.js';

export async function combinedOfferCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-combined-offer-address-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  const targets = ['.email-offer', '.email-offer__row', '.email-offer__send', '.composer-shell', 'textarea', '.composer-mic', '.send', '.composer-feedback', '.composer-status'];
  const address = 'visitor.with.a.long.address@example.test';
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 2 }, initialMessages: 1 });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
    await page.evaluate(() => window.ait164.reply());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer'));
    await settle(page);
    const before = await boxes(page, targets);
    for (const box of before) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive capture geometry`);
    if (evidence) await page.screenshot({ path: join(evidence, `ait-506-${label}-email-address-capture.png`) });
    await page.evaluate(() => { window.ait164.linkFails = true; });
    await shadow(page, (c, address) => { const row = c.shadowRoot.querySelector('.email-offer'); row.querySelector('input').value = address; row.querySelector('form').requestSubmit(); }, address);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__send').getAttribute('aria-disabled') === 'false' && window.ait164.requests.includes('link'));
    await settle(page);
    const after = await boxes(page, targets);
    for (const box of after) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive saved-address geometry`);
    const saved = await shadow(page, c => { const row = c.shadowRoot.querySelector('.email-offer'), address = row.querySelector('.email-offer__address'), message = row.querySelector('.email-offer__message');
      return { address: address.textContent, title: address.title, addressBox: address.getBoundingClientRect().toJSON(), messageBox: message.getBoundingClientRect().toJSON() }; });
    assert.equal(saved.address, address, `${label}: full saved address stays available`);
    assert.ok(saved.addressBox.width > 0 && saved.addressBox.height > 0, `${label}: positive address box`);
    const shift = Math.max(...before.flatMap((box, i) => box.map((n, j) => Math.abs(n - after[i][j]))));
    rects.push({ label, targets, before, after, shift, saved });
    if (evidence) { await writeFile(join(evidence, 'ait-506-email-address-rects.json'), JSON.stringify(rects, null, 2)); await page.screenshot({ path: join(evidence, `ait-506-${label}-email-address-saved.png`) }); }
    assert.ok(shift <= .5, `${label}: saved address shifts combined offer ${shift}px; ${JSON.stringify({ before, after, saved })}`);
  }
}

export async function openerEmailCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-opener-email-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    for (const address of [null, 'saved@example.test']) {
      await fixture(page, locale, { opener: 'persisted', emailOffer: { afterMessages: 1 }, initialMessages: 0, low: true, delivery: true, lock: true, address });
      await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
      await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent');
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.email-offer, .email-low-line__action'))), false, `${label}: opener cannot expose offer or low-credit confirm action`);
      assert.deepEqual(await page.evaluate(() => window.ait164.askRequests ?? []), [], 'no low-credit show or line claim before visitor input');
      const targets = ['.display-foot', '.host-credits'];
      const sample = async () => { const result = await boxes(page, targets); for (const box of result) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive opener-state boxes`); return result; };
      const before = await sample();
      await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' })); await settle(page);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').hidden), !address);
      if (!address) assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.verify-lock').hidden), true);
      const after = await sample(), shift = stable(before, after, `${label}/opener-settings`);
      rects.push({ label, state: address ? 'opener-saved' : 'opener-empty', targets, before, after, shift });
      if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-507-${label}-m1-opener-${address ? 'saved' : 'empty'}.png`) });
      await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').close());
    }
  }
  if (evidence) await writeFile(join(evidence, 'ait-507-m1-opener-rects.json'), JSON.stringify(rects, null, 2));
}

export async function contactOfferCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-contact-offer-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390,844],[1024,1000],[1440,1000],[390,620],[390,568]]) {
    const label = `${locale}-${theme}-${width}x${height}`;
    await page.setViewport({ width, height });
    await shadow(page, c => {
      for (const n of c.querySelectorAll('[slot="sidebar-contact"], [slot="contact-launcher"]')) n.remove();
      for (const slot of ['sidebar-contact', 'contact-launcher']) {
        const button = document.createElement('button'); button.slot = slot; button.textContent = 'Contact'; c.append(button);
      }
    });
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 1 }, initialMessages: 0 });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.email-offer'))), false, `${label}: no offer before visitor input`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').hidden), true, `${label}: no capture form before visitor input`);
    await page.evaluate(() => window.ait164.reply());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await settle(page);
    const targets = ['.email-offer', '.email-offer__row', '.email-offer__send', '.sidebar-contact', '.understanding > .foot', '.composer-shell', '.composer-mic', '.send'];
    const before = await boxes(page, targets);
    if (evidence) { await mkdir(join(evidence, 'shots'), { recursive: true }); await page.screenshot({ path: join(evidence, 'shots', `contact-offer-${label}-capture.png`) }); }
    await page.evaluate(() => { window.ait164.linkFails = true; });
    await shadow(page, c => { const row = c.shadowRoot.querySelector('.email-offer'); row.querySelector('input').value = 'visitor@example.test'; row.querySelector('form').requestSubmit(); });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__send').getAttribute('aria-disabled') === 'false' && window.ait164.requests.includes('link')); await settle(page);
    const after = await boxes(page, targets);
    if (evidence) await page.screenshot({ path: join(evidence, 'shots', `contact-offer-${label}-saved.png`) });
    for (const b of [...before, ...after]) assert.ok(b[2] > 0 && b[3] > 0, `${label}: positive contact/offer geometry ${b}`);
    const shift = stable(before, after, `${label}: contact and offer remain stable`);
    rects.push({ label, targets, before, after, shift });
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'contact-offer-rects.json'), JSON.stringify(rects, null, 2)); }
  }
}
