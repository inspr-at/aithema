// AIT-603 PR-B: the consent sheet the dock's text-consent action opens shows
// the host's text-consent sentence in full (the host override, else the stock
// copy), on screen after it opens, on the failed AND the successful load path,
// and leaves keyboard focus on screen: the target checkbox when it is on
// screen, otherwise the sentence (a programmatic stop). Short sentence and
// short document (both fit): the sheet moves the least that shows both and the
// target keeps focus. Phones 360/390 and desktop 1440, EN/DE. Every measured
// box must be positive. TICK captures go to AITHEMA_EVIDENCE_DIR/ait-603b/tick.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const stock = { en: en.featureConsent.text, de: de.featureConsent.text };
// A host override far longer than the dock's two-line cap (several lines in
// the sheet). Three sentences, not eight: the footer's help cell reserves the
// longest feature-consent sentence (helpMeasurements), so at eight DE sentences
// the settings body on phones is shorter than the sentence itself; that reserve
// is AIT-603 PR-A's layout scope.
const longSentence = locale => Array(3).fill(locale === 'de'
  ? 'Ihre Nachrichten erreichen unseren Modellanbieter erst nach Ihrer Zustimmung.'
  : 'Your messages reach our model provider only after you agree.').join(' ');
const sizes = [[360, 740], [390, 664], [1440, 900]];
export const sheetCases = sizes.flatMap(([width, height]) => ['en', 'de'].map(locale => ({ width, height, locale })));
const GAP = 12;

// The lane's summary keeps lines with "Error:", so a red names its reason.
const none = (failures, label) => { if (failures.length) throw new Error(`${failures.join(' | ')} [${label}]`.slice(0, 1200)); };
const settle = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))); });

async function capture(page, label, values) {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-603b', 'tick'); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false, captureBeyondViewport: false });
  await writeFile(join(dir, `${label}.json`), JSON.stringify({ label, viewportOnly: true, ...values }, null, 2));
  await appendFile(join(dir, 'index.txt'), `${label}.png  ${label}.json  ${values.summary}\n`);
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-sheet-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  // `sentence`: the host's featureConsent.text override (undefined = stock).
  // `doc`: the consent document GET returns (null = the load fails with 500);
  // it waits for releaseConsent(), so the scroll before the load is known.
  // `noFocusVisible` (r4): emulate an engine that ignores focus({ focusVisible }).
  return async ({ width, height, locale, sentence, doc, noFocusVisible = false }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(async (locale, sentence, doc, noFocusVisible) => {
      if (noFocusVisible) {
        const focus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (options) { return focus.call(this, options && { preventScroll: options.preventScroll }); };
      }
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = sentence === undefined ? base : { ...base, featureConsent: { ...base.featureConsent, text: sentence } };
      let release; globalThis.releaseConsent = new Promise(resolve => { release = resolve; }); globalThis.release = () => release();
      const prior = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => String(url).endsWith('/consent') && (options.method ?? 'GET') === 'GET'
        ? (await globalThis.releaseConsent, doc ? Response.json(doc) : new Response('unavailable', { status: 500 })) : prior(url, options);
      mount(JSON.parse(JSON.stringify(document.querySelector('aithema-session').session)));
    }, locale, sentence, doc, noFocusVisible);
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"] .consent-action'));
    await settle(page);
    return page;
  };
}

const documentFor = (kind, contract) => kind === 'long'
  ? { contract, selected: [], features: { text: ['fixture-item-6'] }, items: Array.from({ length: 6 }, (_, i) => ({ id: `fixture-item-${i + 1}`, version: 1, title: `Fixture item ${i + 1}`,
    recipients: 'The host', text: Array(6).fill('This fixture item describes one processing purpose for the local check only.').join(' ') })) }
  : { contract, selected: [], features: { text: ['fixture-item-2'] }, items: Array.from({ length: 8 }, (_, i) => ({ id: `fixture-item-${i + 1}`, version: 1, title: `Fixture item ${i + 1}`,
    recipients: 'The host', text: 'One short purpose.' })) };

// Read in the page: the visible element whose text is exactly the sentence,
// the target checkbox, the settings body, focus, and on-screen verdicts (inside
// the viewport and inside every scrolling ancestor's visible box).
const readSheet = (c, full) => {
  const dialog = c.shadowRoot.querySelector('dialog.settings[open]');
  if (!dialog) return { open: false };
  const box = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
  const onScreen = node => {
    if (!node || !node.checkVisibility()) return false;
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.top < -.5 || r.bottom > innerHeight + .5 || r.left < -.5 || r.right > innerWidth + .5) return false;
    for (let n = node.parentElement; n && n !== dialog.parentNode; n = n.parentElement) {
      if (!/(auto|scroll|hidden|clip)/u.test(getComputedStyle(n).overflowY)) continue;
      const v = n.getBoundingClientRect(); if (r.top < v.top - .5 || r.bottom > v.bottom + .5) return false;
    }
    return true;
  };
  let holder = null;
  for (const n of dialog.querySelectorAll('*')) if (n.childElementCount === 0 && n.textContent === full && n.checkVisibility()) { holder = n; break; }
  const body = dialog.querySelector('.settings__body'), target = dialog.querySelector('.consent-item--target input'), row = target?.closest('.consent-item');
  const active = c.shadowRoot.activeElement;
  // r3: 70ch in the sentence's own font (L2), the footer info row under the body (M1).
  let ch70 = null;
  if (holder) { const probe = document.createElement('span'); probe.textContent = '0'.repeat(70); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;max-width:none'; holder.after(probe); ch70 = probe.getBoundingClientRect().width; probe.remove(); }
  const context = [...dialog.querySelectorAll('.settings-context, .settings__footer')].find(n => n.checkVisibility());
  // r4 (gate M2): the ring the checkbox draws, and the :focus-visible ring of
  // settings-styles.js (3px solid accent, 2px offset) it must equal.
  let targetRing = null, focusRing = null;
  if (target) {
    const css = getComputedStyle(target);
    targetRing = { style: css.outlineStyle, width: css.outlineWidth, offset: css.outlineOffset, color: css.outlineColor, boxShadow: css.boxShadow };
    const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--aithema-accent)';
    target.parentElement.append(probe); focusRing = { style: 'solid', width: '3px', offset: '2px', color: getComputedStyle(probe).color }; probe.remove();
  }
  return { open: true, targetRing, focusRing, targetFocusVisible: Boolean(target?.matches(':focus-visible')) && active === target, ch70, below: box(context), sentence: box(holder), sentenceOnScreen: onScreen(holder), target: box(target), row: box(row), label: box(target?.closest('label')), targetOnScreen: onScreen(target),
    body: box(body), scrollTop: body.scrollTop, items: dialog.querySelectorAll('.consent-item').length,
    status: dialog.querySelector('.consent-status')?.textContent ?? null,
    focus: active ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(' ').join('.')}` : ''}` : null,
    focusTarget: Boolean(target) && active === target, focusSentence: Boolean(holder) && active === holder, focusOnScreen: onScreen(active),
    sentenceTabIndex: holder?.tabIndex ?? null };
};

async function openSheet(page) {
  await page.click('aithema-session >>> .composer-reason[data-consent-feature="text"] .consent-action');
  await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-editor:not([hidden])'));
  await settle(page);
  return page.$eval('aithema-session', c => c.shadowRoot.querySelector('dialog.settings[open] .settings__body').scrollTop);
}

// AIT-603 PR-B r2: the both-fit branch is measured by the sentence and the
// target CHECKBOX with its label line, not the whole row (a long purpose below
// the checkbox must neither add scroll nor force the sentence anchor). The least
// scroll: the label line's bottom where it was before the load, 12 px clear.
function leastScrollFailures(sheet, start) {
  const failures = [];
  if (!(sheet.label?.width > 0 && sheet.label?.height > 0)) return [`the target label line positive box: ${JSON.stringify(sheet.label)}`];
  // Precondition: the sentence and the target checkbox fit together (the both-fit branch).
  if (sheet.label.bottom - sheet.sentence.y > sheet.body.height - 2 * GAP) failures.push(`the fixture fits the sentence and the target checkbox together: ${sheet.label.bottom - sheet.sentence.y} vs ${sheet.body.height}`);
  if (!sheet.targetOnScreen) failures.push('the target checkbox is on screen with the sentence (both fit)');
  if (!sheet.focusTarget) failures.push(`the target checkbox has focus (both fit): ${sheet.focus}`);
  // r3 (TICK M2): the focused checkbox shows the focus ring, as in the voice cases.
  else if (!sheet.targetFocusVisible) failures.push('the focused target checkbox matches :focus-visible (shows the ring, as the voice cases do)');
  const bottomAtStart = sheet.label.bottom + (sheet.scrollTop - start), least = Math.max(0, bottomAtStart - (sheet.body.y + sheet.body.height) + GAP);
  if (Math.abs(sheet.scrollTop - start - least) > 1) failures.push(`the sheet scrolls the least that shows the sentence and the target checkbox: ${sheet.scrollTop - start} vs ${least}`);
  return failures;
}

// The full sentence: present, exact, a positive box, on screen.
function sentenceFailures(sheet) {
  const failures = [];
  if (!sheet.open) return ['the settings sheet is open'];
  if (!(sheet.sentence?.width > 0 && sheet.sentence?.height > 0)) failures.push(`the sheet shows the full host sentence (exact text, positive box): ${JSON.stringify(sheet.sentence)}`);
  else if (!sheet.sentenceOnScreen) failures.push('the full host sentence is on screen');
  if (!(sheet.body?.width > 0 && sheet.body?.height > 0)) failures.push(`the settings body positive box: ${JSON.stringify(sheet.body)}`);
  if (!sheet.focusOnScreen) failures.push(`keyboard focus is on screen (${sheet.focus})`);
  return failures;
}

// Failed load: the sentence is on screen with the failure status; focus on screen.
export async function consentSheetFailedLoadCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) for (const copy of ['long', 'short']) {
    const name = `${item.width}x${item.height}-${item.locale}-${copy}-failed`;
    await t.test(name, async () => {
      const problems = [], full = copy === 'long' ? longSentence(item.locale) : stock[item.locale];
      const page = await open({ ...item, sentence: copy === 'long' ? full : undefined, doc: null }, problems);
      try {
        await openSheet(page);
        await page.evaluate(() => globalThis.release());
        const failed = (item.locale === 'de' ? de : en).host.consentFailed;
        await page.waitForFunction(text => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-status')?.textContent === text, {}, failed);
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = sentenceFailures(sheet);
        if (sheet.items !== 0) failures.push(`the failed load shows no items: ${sheet.items}`);
        await capture(page, name, { summary: `failed load; sentence on screen ${sheet.sentenceOnScreen}; focus ${sheet.focus} on screen ${sheet.focusOnScreen}`, sentenceText: full, ...sheet });
        none(failures, `${name}: ${JSON.stringify(sheet)}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// Successful load, long sentence + long document (target last): the sentence
// stays on screen; focus is the target when on screen, else the sentence.
// Short sentence + short document (both fit): the least scroll that shows both,
// both on screen, the target focused.
export async function consentSheetLoadedCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) for (const copy of ['long', 'short']) {
    const name = `${item.width}x${item.height}-${item.locale}-${copy}-loaded`;
    await t.test(name, async () => {
      const problems = [], full = copy === 'long' ? longSentence(item.locale) : stock[item.locale];
      const page = await open({ ...item, sentence: copy === 'long' ? full : undefined, doc: documentFor(copy, `fixture-ait-603b-${copy}`) }, problems);
      try {
        const start = await openSheet(page);
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = sentenceFailures(sheet);
        const expected = copy === 'long' ? 6 : 8;
        if (sheet.items !== expected) failures.push(`the fixture document loads: ${sheet.items} items`);
        if (!(sheet.target?.width > 0 && sheet.target?.height > 0 && sheet.row?.width > 0 && sheet.row?.height > 0)) failures.push(`the target positive boxes: ${JSON.stringify([sheet.target, sheet.row])}`);
        if (sheet.targetOnScreen ? !sheet.focusTarget : !sheet.focusSentence) failures.push(`focus: the target when on screen, else the host sentence (target on screen ${sheet.targetOnScreen}, focus ${sheet.focus})`);
        if (sheet.focusSentence && sheet.sentenceTabIndex !== -1) failures.push(`the sentence is a programmatic focus stop only (tabindex -1): ${sheet.sentenceTabIndex}`);
        if (copy === 'short' && sheet.sentence && sheet.row && sheet.body) {
          // Precondition: the sentence and the target fit together (the both-fit branch).
          failures.push(...leastScrollFailures(sheet, start));
        }
        await capture(page, name, { summary: `loaded; sentence on screen ${sheet.sentenceOnScreen}; target on screen ${sheet.targetOnScreen}; focus ${sheet.focus}`, sentenceText: full, scrollAtOpen: start, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ start, sheet })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// AIT-603 PR-B r2 (gate Medium 1): focus the visitor moves while the document
// loads stays where they put it; a successful load may scroll, never refocus.
export async function consentSheetFocusKeptCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases.filter(({ width, locale }) => width === 360 && locale === 'en' || width === 1440 && locale === 'de')) {
    const name = `${item.width}x${item.height}-${item.locale}-tab-away-loaded`;
    await t.test(name, async () => {
      const problems = [], full = stock[item.locale];
      const page = await open({ ...item, doc: documentFor('short', 'fixture-ait-603b-tab-away') }, problems);
      try {
        const start = await openSheet(page);
        await page.keyboard.press('Tab');
        await settle(page);
        const moved = await page.$eval('aithema-session', c => {
          const active = c.shadowRoot.activeElement, dialog = c.shadowRoot.querySelector('dialog.settings[open]');
          if (!active || !dialog?.contains(active) || active.classList.contains('consent-reason')) return { ok: false, focus: active?.outerHTML.slice(0, 120) ?? null };
          active.dataset.ait603TabAway = '1';
          return { ok: true, focus: active.outerHTML.slice(0, 120) };
        });
        if (!moved.ok) throw new Error(`precondition: Tab moves focus to another control in the sheet while the document loads: ${moved.focus}`);
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const kept = await page.$eval('aithema-session', c => c.shadowRoot.activeElement?.dataset.ait603TabAway === '1');
        const failures = [];
        if (!kept) failures.push(`the control the visitor tabbed to keeps focus after the load (${moved.focus}; now ${sheet.focus})`);
        if (sheet.focusTarget || sheet.focusSentence) failures.push(`the load does not move focus to the target or the sentence: ${sheet.focus}`);
        await capture(page, name, { summary: `tab-away then loaded; focus kept ${kept}; focus ${sheet.focus}`, sentenceText: full, scrollAtOpen: start, tabbedTo: moved.focus, kept, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ start, moved, sheet })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// A target whose purpose is taller than the settings body (item 2 of 8).
const tallPurposeDocument = (feature, contract) => ({ contract, selected: [], features: { [feature]: ['fixture-item-2'] }, items: Array.from({ length: 8 }, (_, i) => ({ id: `fixture-item-${i + 1}`, version: 1, title: `Fixture item ${i + 1}`,
  recipients: 'The host', text: i === 1 ? Array(80).fill('This fixture purpose is long on purpose, for the local layout check only.').join(' ') : 'One short purpose.' })) });

// AIT-603 PR-B r2 (gate Mediums 2 and 3): a tall target purpose.
// Text feature: the sentence and the target checkbox fit together, so the
// sheet scrolls the least that shows both (measured by the checkbox and its
// label line, not the purpose) and the target keeps focus.
// Other features (no sentence): the focused checkbox is centred, as on main,
// so it stays inside the scrollport even when its purpose is taller.
export async function consentSheetTallPurposeCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) for (const feature of ['text', 'voice']) {
    const name = `${item.width}x${item.height}-${item.locale}-${feature}-tall-purpose-loaded`;
    await t.test(name, async () => {
      const problems = [], full = feature === 'text' ? stock[item.locale] : '\u0000no sentence for this feature';
      const page = await open({ ...item, doc: tallPurposeDocument(feature, `fixture-ait-603b-tall-${feature}`) }, problems);
      try {
        let start;
        if (feature === 'text') start = await openSheet(page);
        else {
          await page.evaluate(() => document.querySelector('aithema-session').openConsent('voice'));
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-editor:not([hidden])'));
          await settle(page);
          start = await page.$eval('aithema-session', c => c.shadowRoot.querySelector('dialog.settings[open] .settings__body').scrollTop);
        }
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = [];
        if (!(sheet.body?.width > 0 && sheet.body?.height > 0)) failures.push(`the settings body positive box: ${JSON.stringify(sheet.body)}`);
        if (!(sheet.target?.width > 0 && sheet.target?.height > 0 && sheet.row?.width > 0 && sheet.row?.height > 0)) failures.push(`the target positive boxes: ${JSON.stringify([sheet.target, sheet.row])}`);
        // Precondition: the target row (with its purpose) is taller than the settings body.
        if (sheet.row && sheet.body && sheet.row.height <= sheet.body.height) failures.push(`precondition: the target row is taller than the settings body: ${sheet.row.height} vs ${sheet.body.height}`);
        if (!sheet.targetOnScreen) failures.push(`the focused target checkbox is inside the scrollport: ${JSON.stringify({ target: sheet.target, body: sheet.body })}`);
        if (!sheet.focusTarget) failures.push(`the target checkbox has focus: ${sheet.focus}`);
        if (!sheet.focusOnScreen) failures.push(`keyboard focus is on screen (${sheet.focus})`);
        if (feature === 'text') {
          failures.push(...sentenceFailures(sheet));
          if (sheet.sentence && sheet.body) failures.push(...leastScrollFailures(sheet, start));
        } else if (sheet.target && sheet.body) {
          // As on main: the checkbox centres in the scrollport.
          const centre = sheet.target.y + sheet.target.height / 2 - (sheet.body.y + sheet.body.height / 2);
          if (Math.abs(centre) > 2) failures.push(`the focused checkbox is centred in the scrollport, as on main: ${centre} px off`);
        }
        await capture(page, name, { summary: `${feature} tall purpose loaded; target on screen ${sheet.targetOnScreen}; focus ${sheet.focus}`, sentenceText: feature === 'text' ? full : null, scrollAtOpen: start, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ start, sheet })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// AIT-603 PR-B r2 (gate Low): the oversized fallback. A sixteen-sentence DE host
// (r3: eight before; with the body at full height eight DE sentences fit at 360)
// sentence is taller than the phone settings body: on both load paths the sheet
// anchors at the sentence top (12 px clear) and the sentence holds focus
// (tabindex -1, a programmatic stop).
export async function consentSheetOversizedCheck(t) {
  const open = await harness(t);
  const full = Array(16).fill('Ihre Nachrichten erreichen unseren Modellanbieter erst nach Ihrer Zustimmung.').join(' ');
  for (const item of sheetCases.filter(({ width, locale }) => width < 1000 && locale === 'de')) for (const path of ['failed', 'loaded']) {
    const name = `${item.width}x${item.height}-de-oversized-${path}`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ ...item, sentence: full, doc: path === 'loaded' ? documentFor('long', 'fixture-ait-603b-oversized') : null }, problems);
      try {
        const start = await openSheet(page);
        await page.evaluate(() => globalThis.release());
        if (path === 'failed') await page.waitForFunction(text => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-status')?.textContent === text, {}, de.host.consentFailed);
        else await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = [];
        if (!(sheet.sentence?.width > 0 && sheet.sentence?.height > 0)) failures.push(`the sheet shows the full host sentence (exact text, positive box): ${JSON.stringify(sheet.sentence)}`);
        if (!(sheet.body?.width > 0 && sheet.body?.height > 0)) failures.push(`the settings body positive box: ${JSON.stringify(sheet.body)}`);
        if (sheet.sentence && sheet.body) {
          if (sheet.sentence.height <= sheet.body.height - 2 * GAP) failures.push(`precondition: the sentence is taller than the settings body: ${sheet.sentence.height} vs ${sheet.body.height}`);
          const offset = sheet.sentence.y - sheet.body.y;
          if (Math.abs(offset - GAP) > 1) failures.push(`the sheet anchors at the sentence top, ${GAP} px clear: ${offset}`);
        }
        if (!sheet.focusSentence) failures.push(`the sentence holds focus: ${sheet.focus}`);
        if (sheet.sentenceTabIndex !== -1) failures.push(`the sentence is a programmatic focus stop only (tabindex -1): ${sheet.sentenceTabIndex}`);
        await capture(page, name, { summary: `oversized DE ${path}; sentence top offset ${sheet.sentence && sheet.body ? sheet.sentence.y - sheet.body.y : null}; focus ${sheet.focus}`, sentenceText: full, scrollAtOpen: start, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ start, sheet })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// AIT-603 PR-B r4 (gate M2): the ring is deterministic across engines. Both
// fit (short sentence, short document, loaded): the sheet focuses the target
// checkbox and it draws the same ring as :focus-visible, in Chromium as is and
// with focus({ focusVisible }) ignored (as engines without that option do).
// The lane has no WebKit; the emulation stands in for it.
export async function consentSheetRingCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) for (const engine of ['native', 'no-focus-visible']) {
    const name = `${item.width}x${item.height}-${item.locale}-ring-${engine}`;
    await t.test(name, async () => {
      const problems = [], full = stock[item.locale];
      const page = await open({ ...item, doc: documentFor('short', 'fixture-ait-603b-ring'), noFocusVisible: engine !== 'native' }, problems);
      try {
        await openSheet(page);
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = [];
        if (!(sheet.target?.width > 0 && sheet.target?.height > 0)) failures.push(`the target checkbox positive box: ${JSON.stringify(sheet.target)}`);
        if (!sheet.focusTarget) failures.push(`the target checkbox has focus (both fit): ${sheet.focus}`);
        const ring = sheet.targetRing, want = sheet.focusRing;
        if (!ring || !want || ring.style !== want.style || ring.width !== want.width || ring.offset !== want.offset || ring.color !== want.color) {
          failures.push(`the focused checkbox draws the :focus-visible ring: ${JSON.stringify(ring)} vs ${JSON.stringify(want)}`);
        }
        await capture(page, name, { summary: `${engine}; focus ${sheet.focus}; ring ${ring?.style} ${ring?.width} ${ring?.color}`, sentenceText: full, engine, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ focus: sheet.focus, ring, want })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// AIT-603 PR-B r3 (TICK M1, L2): the sentence lives only in the scrolling body.
// The settings body keeps the same height (+-1 px) for the stock, a long and an
// oversized host sentence, and the gap between the body and the footer row
// under it does not grow (no empty band). At 1440 the sentence wraps at about
// 70ch. Failed load path (the body is the same on both paths); EN/DE, 360/390/1440.
const oversized = locale => Array(16).fill(locale === 'de'
  ? 'Ihre Nachrichten erreichen unseren Modellanbieter erst nach Ihrer Zustimmung.'
  : 'Your messages reach our model provider only after you agree.').join(' ');
// r4 (gate M1): two host sentences whose 40-character help prefixes differ in
// rendered width (wide and narrow glyphs); the help cell's reserve must hold
// the tallest rendering, whatever the character count.
const glyphs = { wide: Array(12).fill('WWWW').join(' '), narrow: Array(12).fill('iiii').join(' ') };
export async function consentSheetBodyHeightCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) {
    const name = `${item.width}x${item.height}-${item.locale}-body-height`;
    await t.test(name, async () => {
      const problems = [], seen = {};
      for (const kind of ['short', 'long', 'oversized', 'wide', 'narrow']) {
        const full = kind === 'short' ? stock[item.locale] : kind === 'long' ? longSentence(item.locale) : kind === 'oversized' ? oversized(item.locale) : glyphs[kind];
        const page = await open({ ...item, sentence: kind === 'short' ? undefined : full, doc: null }, problems);
        try {
          await openSheet(page);
          await page.evaluate(() => globalThis.release());
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-status')?.textContent.length > 0);
          await settle(page);
          seen[kind] = await page.$eval('aithema-session', readSheet, full);
          const sheet = seen[kind];
          await capture(page, `${name}-${kind}`, { summary: `${kind} sentence; body height ${sheet.body?.height}; band ${sheet.below && sheet.body ? sheet.below.y - sheet.body.bottom : null}; footer top ${sheet.below?.y}`, sentenceText: full,
            bodyHeight: sheet.body?.height ?? null, footerTop: sheet.below?.y ?? null, ...sheet });
        } finally { await page.close(); }
      }
      const failures = [];
      for (const [kind, sheet] of Object.entries(seen)) {
        if (!(sheet.body?.width > 0 && sheet.body?.height > 0)) failures.push(`${kind}: the settings body positive box: ${JSON.stringify(sheet.body)}`);
        if (!(sheet.below?.width > 0 && sheet.below?.height > 0)) failures.push(`${kind}: the footer row under the body positive box: ${JSON.stringify(sheet.below)}`);
        if (!(sheet.sentence?.width > 0 && sheet.sentence?.height > 0)) failures.push(`${kind}: the sentence positive box: ${JSON.stringify(sheet.sentence)}`);
      }
      if (!failures.length) for (const kind of ['long', 'oversized', 'wide', 'narrow']) {
        const a = seen.short, b = seen[kind];
        if (Math.abs(b.body.height - a.body.height) > 1) failures.push(`${kind}: the settings body keeps its height: ${b.body.height} vs ${a.body.height} (short)`);
        const band = sheet => sheet.below.y - sheet.body.bottom;
        if (band(b) - band(a) > 1) failures.push(`${kind}: no empty band between the body and the footer row: ${band(b)} vs ${band(a)} (short)`);
        if (Math.abs(b.below.y - a.below.y) > 1) failures.push(`${kind}: the footer row stays in place: ${b.below.y} vs ${a.below.y} (short)`);
        if (item.width === 1440 && !(b.ch70 > 0 && b.sentence.width <= b.ch70 + 1)) failures.push(`${kind}: at 1440 the sentence wraps at about 70ch: ${b.sentence.width} vs ${b.ch70}`);
      }
      none(failures, `${name}: ${JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { body: v.body, below: v.below, sentence: v.sentence, ch70: v.ch70 }])))}`);
      assert.deepEqual(problems, []);
    });
  }
}
