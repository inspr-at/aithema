import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { shadow, until, boxes } from './start2-display-helpers.js';
import { fixture, settle, stable, click } from './email-ask-fixture.js';

export async function noUploadsFeedbackCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-no-upload-feedback-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const [width, height] of [[390, 844], [1024, 1000], [1440, 1000], [390, 568]]) {
    const label = `${locale}-${theme}-${width}x${height}`;
    await page.setViewport({ width, height });
    await fixture(page, locale, { opener: true, emailOffer: { afterMessages: 2 } });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme); await settle(page);
    assert.equal(await shadow(page, c => c.session.featureMatrix.best.uploads), undefined, `${label}: uploads are not configured`);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.composer').hasAttribute('data-image-input')), false, `${label}: no image layout`);
    const actual = (await boxes(page, ['.composer-feedback']))[0];
    if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-510-r16-${label}-combined-without-uploads.png`) });
    // Main's combined feedback rule has no minimum. Its grid-item initial
    // value is auto; override only this property to compare the real boxes.
    await shadow(page, c => { c.shadowRoot.querySelector('.composer-feedback').style.minHeight = 'auto'; });
    await settle(page);
    const main = (await boxes(page, ['.composer-feedback']))[0];
    for (const box of [actual, main]) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive feedback geometry ${box}`);
    const shift = Math.max(...actual.map((n, i) => Math.abs(n - main[i])));
    rects.push({ label, actual, main, shift });
    await shadow(page, c => { c.shadowRoot.querySelector('.composer-feedback').style.removeProperty('min-height'); });
  }
  if (evidence) await writeFile(join(evidence, 'ait-510-r16-no-upload-feedback-rects.json'), JSON.stringify(rects, null, 2));
  assert.deepEqual(rects.filter(row => row.shift !== 0), [], 'AIT-510 r16: combined composers without uploads retain main feedback boxes exactly');
}

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
    await shadow(page, (c, locale) => {
      for (const n of c.querySelectorAll('[slot="sidebar-contact"], [slot="contact-launcher"]')) n.remove();
      for (const slot of ['sidebar-contact', 'contact-launcher']) {
        const button = document.createElement('button'); button.slot = slot;
        const label = locale === 'de' ? 'Kontakt' : 'Contact';
        if (slot === 'contact-launcher') {
          button.setAttribute('aria-label', label);
          button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor"><path d="M4 5h16v12H9l-5 3V5Z"/></svg>';
          Object.assign(button.style, { display: 'grid', placeItems: 'center', padding: '0', border: '0', background: 'transparent' });
        } else button.textContent = label;
        c.append(button);
      }
    }, locale);
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

export async function inlineOfferCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-inline-offer-'));
  const demo = await startChild(new URL('../fixtures/email-offer-server.js', import.meta.url), join(directory, 'session.sqlite'), { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile(), evidence = process.env.AITHEMA_EVIDENCE_DIR, rects = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  if (evidence) await mkdir(evidence, { recursive: true });
  const page = await browser.newPage();
  // All host deadlines and browser Date reads use one injected clock.
  await page.evaluateOnNewDocument(() => { const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } }; });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session);
  const targets = ['.composer-shell', 'textarea', '.composer-mic', '.send', '.composer-feedback', '.composer-status', '.display-foot'];
  const measured = async () => {
    const result = await boxes(page, targets);
    for (const [i, box] of result.entries()) assert.ok(box[2] > 0 && box[3] > 0, `${targets[i]} must have positive geometry: ${box}`);
    return result;
  };
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    const label = `${locale}-${theme}-${width}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    let baseline = null, offerBaseline = null;
    const shot = async state => {
      await settle(page);
      rects.push({ label, state, surface: 'combined-row', targets, boxes: await measured() });
      const bounds = await shadow(page, c => {
        const row = c.shadowRoot.querySelector('.email-offer');
        return row ? { offer: row.getBoundingClientRect().toJSON(), shell: c.shadowRoot.querySelector('.transcript-shell').getBoundingClientRect().toJSON() } : null;
      });
      if (bounds) {
        for (const box of Object.values(bounds)) assert.ok(box.width > 0 && box.height > 0, `${label}/${state}: positive offer geometry`);
        assert.ok(bounds.offer.left >= bounds.shell.left - .5 && bounds.offer.right <= bounds.shell.right + .5, `${label}/${state}: offer fits the transcript`);
        rects.push({ label, state, surface: 'offer-bounds', ...bounds });
      }
      if (baseline && bounds) {
        const currentOffer = await boxes(page, ['.email-offer', '.email-offer__row', '.email-offer__send']);
        for (const box of currentOffer) assert.ok(box[2] > 0 && box[3] > 0, `${label}/${state}: positive offer control geometry`);
        if (offerBaseline) {
          const shift = Math.max(...offerBaseline.flatMap((box, i) => box.map((n, j) => Math.abs(n - currentOffer[i][j]))));
          assert.ok(shift <= .5, `${label}/${state}: offer control shift ${shift}`); rects.push({ label, state, targets: ['.email-offer', '.email-offer__row', '.email-offer__send'], before: offerBaseline, after: currentOffer, shift });
        } else offerBaseline = currentOffer;
      }
      if (baseline) {
        const current = await measured();
        const shift = Math.max(...baseline.flatMap((box, i) => box.map((n, j) => Math.abs(n - current[i][j]))));
        assert.ok(shift <= .5, `${label}/${state}: control shift ${shift}`); rects.push({ label, state, targets, before: baseline, after: current, shift });
      }
      if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `ait-507-${label}-${state}.png`), fullPage: false }); };
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 2 }, initialMessages: 0, lock: true });
    await shadow(page, (c, theme) => c.setAttribute('theme', theme), theme);
    const entrance = await shadow(page, c => {
      const root = c.shadowRoot, opener = root.querySelector('[data-id="host:opener"]');
      const box = opener.getBoundingClientRect();
      return { combined: root.querySelector('.workspace').dataset.entrance,
        openers: root.querySelectorAll('[data-id="host:opener"]').length,
        openerBox: [box.x, box.y, box.width, box.height],
        canonical: c.session.transcript.length, offer: Boolean(root.querySelector('.email-offer')),
        captureHidden: root.querySelector('.host-verify').hidden,
        creditsEmailHidden: root.querySelector('.credits-email').hidden,
        deferred: root.querySelector('.credits-email').hasAttribute('data-capture-deferred') };
    });
    assert.equal(entrance.combined, 'combined', `${label}: combined entrance with emailOffer`);
    assert.equal(entrance.openers, 1, `${label}: exactly one shared entrance opener`);
    assert.ok(entrance.openerBox[2] > 0 && entrance.openerBox[3] > 0, `${label}: positive opener geometry`);
    assert.equal(entrance.canonical, 0, `${label}: opener remains render-only before input`);
    assert.equal(entrance.offer, false, `${label}: no inline email form before input`);
    assert.equal(entrance.captureHidden, true, `${label}: Settings capture deferred`);
    assert.equal(entrance.creditsEmailHidden, true, `${label}: credits email link hidden`);
    assert.equal(entrance.deferred, true, `${label}: credits email action deferred`);
    rects.push({ label, state: 'entrance', surface: 'opener', box: entrance.openerBox });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.understanding), 'absent'); await shot('entrance');
    await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').hidden), true);
    await shot('before-input');
    await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').close());
    await page.evaluate(() => window.ait164.reply()); await settle(page);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.email-offer'))), false);
    const before = await measured(); await page.evaluate(() => window.ait164.reply());
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await settle(page);
    const after = await measured();
    const shift = Math.max(...before.flatMap((box, i) => box.map((n, j) => Math.abs(n - after[i][j]))));
    assert.ok(shift <= .5, `${label}: control shift ${shift}`); rects.push({ label, targets, before, after, shift });
    const state = await shadow(page, c => { const r = c.shadowRoot; return { notice: r.querySelector('.email-offer .m-notice-text').textContent, href: r.querySelector('.email-offer .m-pp').getAttribute('href'), inert: r.querySelector('form.composer').inert, count: c.session.transcript.length, active: r.activeElement?.id }; });
    assert.match(state.notice, locale === 'en' ? /advertising/ : /Werbung/); assert.equal(state.href, '/privacy'); assert.equal(state.inert, false); assert.equal(state.count, 4); assert.notEqual(state.active, 'email-offer-input');
    baseline = after; await shot('capture');
    // Native focus must not move the inline offer inside the combined scrollers.
    const focusTargets = ['.email-offer', '.email-offer__row', '.email-offer__send', ...targets];
    const focusSample = () => shadow(page, (c, selectors) => {
      const root = c.shadowRoot;
      return { boxes: selectors.map(selector => { const b = root.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }),
        scrolls: ['.workspace', '.conversation', '.conversation-scroll', '.concept-thread', '.transcript-shell'].map(selector => {
          const n = root.querySelector(selector), b = n.getBoundingClientRect();
          return { selector, top: n.scrollTop, height: n.clientHeight, content: n.scrollHeight, y: b.y, boxHeight: b.height };
        }), documentScroll: scrollY };
    }, focusTargets);
    const beforeFocus = await focusSample();
    await shadow(page, c => c.shadowRoot.querySelector('#email-offer-input').focus());
    await settle(page);
    const afterFocus = await focusSample();
    for (const sample of [beforeFocus, afterFocus]) for (const box of sample.boxes) assert.ok(box[2] > 0 && box[3] > 0, `${label}: positive native-focus geometry`);
    const focusShift = Math.max(...beforeFocus.boxes.flatMap((box, i) => box.map((n, j) => Math.abs(n - afterFocus.boxes[i][j]))));
    rects.push({ label, state: 'native-focus', targets: focusTargets, before: beforeFocus.boxes, after: afterFocus.boxes, shift: focusShift, beforeFocus, afterFocus });
    if (evidence) await writeFile(join(evidence, 'ait-507-rects.json'), JSON.stringify(rects, null, 2));
    await shot('capture-focused');
    assert.ok(focusShift <= .5, `${label}: native focus shifts the combined offer ${focusShift}px; ${JSON.stringify({ beforeFocus, afterFocus })}`);
    await shadow(page, c => { const row = c.shadowRoot.querySelector('.email-offer'); row.querySelector('input').value = 'invalid'; row.querySelector('form').requestSubmit(); });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-offer input').getAttribute('aria-invalid')), 'true'); await shot('invalid');
    for (const status of [400, 503]) {
      await page.evaluate(status => { window.ait164.saveStatus = status; }, status);
      await shadow(page, c => { const row = c.shadowRoot.querySelector('.email-offer'); row.querySelector('input').value = 'visitor@example.test'; row.querySelector('form').requestSubmit(); });
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__send').getAttribute('aria-disabled') === 'false');
      const failure = await shadow(page, async c => {
        const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`), row = c.shadowRoot.querySelector('.email-offer');
        return { text: row.querySelector('.email-offer__message').textContent, invalid: row.querySelector('input').getAttribute('aria-invalid'),
          inputHidden: row.querySelector('input').hidden, invalidCopy: copy.hostSurface.verify.invalid, failedCopy: copy.hostSurface.email.failed };
      });
      assert.equal(failure.text, status === 400 ? failure.invalidCopy : failure.failedCopy);
      assert.equal(failure.invalid, String(status === 400)); assert.equal(failure.inputHidden, false);
      assert.equal(await page.evaluate(() => window.ait164.address), null);
      assert.equal(await page.evaluate(() => window.ait164.requests.includes('link')), false);
      await shot(status === 400 ? 'save-refused' : 'save-failed');
    }
    await page.evaluate(() => { window.ait164.saveStatus = null; });
    await page.evaluate(() => { window.ait164.saving = true; window.ait164.linkFails = true; });
    await shadow(page, c => { const row = c.shadowRoot.querySelector('.email-offer'); row.querySelector('input').value = 'visitor@example.test'; row.querySelector('form').requestSubmit(); });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__send').getAttribute('aria-disabled') === 'true');
    assert.equal(await shadow(page, async c => { const { [c.session.locale]: copy } = await import(`/packages/ui/src/i18n/${c.session.locale}.js`); return c.shadowRoot.querySelector('.email-offer__message').textContent === copy.hostSurface.email.saving; }), true);
    await shot('saving');
    await page.evaluate(() => { window.ait164.saving = false; });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer__send').getAttribute('aria-disabled') === 'false' && window.ait164.requests.includes('link'));
    await shot('delivery-failed');
    await page.evaluate(() => { window.ait164.linkFails = false; }); await click(page, '.email-offer__send');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer').dataset.step === 'sent');
    assert.equal(await page.evaluate(() => window.ait164.noticeVersion), 'ait-135-v1'); await shot('sent');
    await shadow(page, c => { window.ait164.confirmed = true; c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...c.session.identity, status: 'verified', address: 'visitor@example.test', assessmentUnlocked: true, conceptsUnlocked: true } }); });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer').dataset.step === 'confirmed'); await shot('confirmed');
    baseline = null;
    for (const [variant, confirmedAllowance] of [['confirm', 24_000_000], ['lock-only', 12_000_000]]) {
      await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 1 }, initialMessages: 0, lock: true,
        tierAllowances: { anonymous: 12_000_000, emailGiven: 12_000_000, emailConfirmed: confirmedAllowance } });
      await page.evaluate(() => window.ait164.reply()); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer')); await shot(variant);
    }
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 1 }, initialMessages: 0, address: 'saved@example.test', lock: true });
    await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-verify').hidden), false);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.m-delete-mail').inert), false); await shot('saved-settings');
    await shadow(page, c => c.shadowRoot.querySelector('dialog.settings').close());
    await page.evaluate(() => window.ait164.reply()); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer'));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.email-offer input').hidden), true); await shot('resend');
    await fixture(page, locale, { opener: true, delivery: true, emailOffer: { afterMessages: 2 }, initialMessages: 1, voice: true });
    await page.evaluate(() => window.ait164.reply()); await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.email-offer'));
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail').dataset.call), 'active');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('form.composer').inert), false); await shot('during-call');
    await click(page, '.email-offer__dismiss'); await page.evaluate(() => window.ait164.reply()); await settle(page);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.email-offer'))), false); await shot('dismissed');
    await click(page, '.voice-close');
  }
  if (evidence) await writeFile(join(evidence, 'ait-507-rects.json'), JSON.stringify(rects, null, 2));
}
