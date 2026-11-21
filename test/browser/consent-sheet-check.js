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
  // `focusFails` (r5, gate Low): focus() on a consent checkbox does nothing.
  // `hostCopy` (r6): 'host' = the host overrides every feature reason and help
  // template with long copy; 'fr' = a custom locale (fr) on the EN copy;
  // 'fr-host' = both.
  return async ({ width, height, locale, sentence, doc, noFocusVisible = false, focusFails = false, hostCopy = '', countries = null }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(() => addEventListener('error', event => { (globalThis.pageErrors ??= []).push(String(event.message)); }));
    await page.evaluate(async (locale, sentence, doc, noFocusVisible, focusFails, hostCopy, countries) => {
      if (focusFails) {
        const focus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (options) { if (this.matches('.consent-item input')) return undefined; return focus.call(this, options); };
      }
      if (noFocusVisible) {
        const focus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (options) { return focus.call(this, options && { preventScroll: options.preventScroll }); };
      }
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = sentence === undefined ? base : { ...base, featureConsent: { ...base.featureConsent, text: sentence } };
      if (hostCopy.includes('host')) {
        const long = 'This host words its own consent reason at far greater length than the stock copy, so it wraps over many lines in the help cell.';
        const copy = globalThis.fixtureCopy;
        globalThis.fixtureCopy = { ...copy, featureConsent: { ...copy.featureConsent, ...Object.fromEntries(['text', 'uploads', 'images', 'html', 'voice', 'analysis'].map(feature => [feature, long])) },
          help: Object.fromEntries(Object.entries(copy.help).map(([key, value]) => [key, `${value} ${long} ${long}`])) };
      }
      if (hostCopy.includes('fr')) globalThis.fixtureCopy = { ...globalThis.fixtureCopy, display: { ...globalThis.fixtureCopy.display, locale: 'fr' } };
      let release; globalThis.releaseConsent = new Promise(resolve => { release = resolve; }); globalThis.release = () => release();
      const prior = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => String(url).endsWith('/consent') && (options.method ?? 'GET') === 'GET'
        ? (await globalThis.releaseConsent, doc ? Response.json(doc) : new Response('unavailable', { status: 500 })) : prior(url, options);
      // `countries` (r6): every catalog model's providers are seated in these
      // countries and the best preset offers a 'default' model (as
      // start2-display's provider-seat check); the host slots a privacy link.
      // The fixture page answers /settings itself, so this wraps its fetch.
      if (countries) {
        const fixtureFetch = globalThis.fetch;
        globalThis.fetch = async (url, options = {}) => {
          if ((options.method ?? 'GET') !== 'GET' || !String(url).endsWith('/settings')) return fixtureFetch(url, options);
          const catalog = await (await fixtureFetch(url, options)).json();
          for (const preset of Object.values(catalog.presets ?? {})) for (const model of preset.models ?? []) model.facts = { ...model.facts, hostCountries: countries, hostTraining: true };
          // The fixture has no provider, so its best preset may list no model.
          const best = (catalog.presets ??= {}).best ??= { offered: true, status: 'available', models: [] };
          (best.models ??= []).unshift({ ...best.models[0] ?? { label: 'Fixture model', status: 'available', offered: true }, id: 'default', facts: { ...best.models[0]?.facts, hostCountries: countries, hostTraining: true } });
          if (globalThis.countriesSession) { catalog.settings = globalThis.countriesSession.settings; catalog.processingPreset = 'best'; }
          return Response.json(catalog);
        };
        document.querySelector('aithema-session').insertAdjacentHTML('beforeend', '<nav slot="legal"><a data-aithema-privacy href="/host-privacy">Host document</a></nav>');
      }
      mount(JSON.parse(JSON.stringify(document.querySelector('aithema-session').session)));
    }, locale, sentence, doc, noFocusVisible, focusFails, hostCopy, countries);
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
  return { open: true, targetMarked: target ? target.hasAttribute('data-focus-ring') : null, targetRing, focusRing, targetFocusVisible: Boolean(target?.matches(':focus-visible')) && active === target, ch70, below: box(context), sentence: box(holder), sentenceOnScreen: onScreen(holder), target: box(target), row: box(row), label: box(target?.closest('label')), targetOnScreen: onScreen(target),
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
  // r5 (gate Low): `focus-fails` (360 EN, 1440 DE): focus() does not land on the
  // checkbox, so no data-focus-ring marker may stay on it for a later pointer focus.
  const engines = item => item.width === 360 && item.locale === 'en' || item.width === 1440 && item.locale === 'de'
    ? ['native', 'no-focus-visible', 'focus-fails'] : ['native', 'no-focus-visible'];
  for (const item of sheetCases) for (const engine of engines(item)) {
    const name = `${item.width}x${item.height}-${item.locale}-ring-${engine}`;
    await t.test(name, async () => {
      const problems = [], full = stock[item.locale];
      const page = await open({ ...item, doc: documentFor('short', 'fixture-ait-603b-ring'), noFocusVisible: engine === 'no-focus-visible', focusFails: engine === 'focus-fails' }, problems);
      try {
        await openSheet(page);
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-item--target'));
        await settle(page);
        const sheet = await page.$eval('aithema-session', readSheet, full);
        const failures = [];
        if (!(sheet.target?.width > 0 && sheet.target?.height > 0)) failures.push(`the target checkbox positive box: ${JSON.stringify(sheet.target)}`);
        const ring = sheet.targetRing, want = sheet.focusRing;
        if (engine === 'focus-fails') {
          if (sheet.focusTarget) failures.push(`precondition: focus() did not land on the checkbox: ${sheet.focus}`);
          if (sheet.targetMarked !== false) failures.push(`no stale data-focus-ring marker on a checkbox that did not get focus: ${sheet.targetMarked}`);
        } else if (!sheet.focusTarget) failures.push(`the target checkbox has focus (both fit): ${sheet.focus}`);
        if (engine !== 'focus-fails' && (!ring || !want || ring.style !== want.style || ring.width !== want.width || ring.offset !== want.offset || ring.color !== want.color)) {
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
// r5 (TICK decision (i)): a CJK and an emoji host sentence. Their help line
// is clamped to the N lines the stock copy needs, with an ellipsis.
const glyphs = { wide: Array(12).fill('WWWW').join(' '), narrow: Array(12).fill('iiii').join(' '),
  cjk: Array(4).fill('您的消息只有在您同意后才会到达我们的模型提供商。').join(''), emoji: Array(60).fill('😀').join('') };
// r5 (TICK decision (i)): read in the page. `stockMax`: the tallest rendering
// of every stock help text (consent-needed with each stock feature reason) in
// the help cell's width, probed apart from the dialog's own measures. Then the
// consent-needed help for this sentence goes into the live help line, as the
// dialog writes it: the cell keeps its height and the line shows whole lines,
// at most N = stockMax / line height, clamped when the text needs more.
const readHelp = async (c, locale, full) => {
  const dialog = c.shadowRoot.querySelector('dialog.settings[open]');
  const cell = dialog.querySelector('.context-text'), message = cell.querySelector('.context-message');
  const { helpReason, fill } = await import('/packages/ui/src/settings-dialog.js');
  const { featureConsentText } = await import('/packages/ui/src/consent-line.js');
  const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
  const probe = text => {
    const node = message.cloneNode(false); node.removeAttribute('role'); node.removeAttribute('aria-live'); node.removeAttribute('style');
    for (const key of Object.keys(node.dataset)) delete node.dataset[key];
    node.style.visibility = 'hidden'; node.textContent = text; cell.append(node);
    const height = node.getBoundingClientRect().height; node.remove(); return height;
  };
  const stockTexts = Object.entries(base.help).flatMap(([key, text]) => key === 'consentNeeded'
    ? ['text', 'uploads', 'images', 'html', 'voice', 'analysis'].map(feature => fill(text, { reason: helpReason(featureConsentText(base, feature)) })) : [fill(text, { reason: '' })]);
  const stockMax = Math.max(...stockTexts.map(probe));
  const line = parseFloat(getComputedStyle(message).lineHeight);
  const before = cell.getBoundingClientRect();
  const help = fill(base.help.consentNeeded, { reason: helpReason(full) }), unclamped = probe(help);
  // The dialog writes its own help on every render, so the help goes in through
  // its own path: the real pointer hovers a consent term (as a consent-needed
  // option carries; fixed, out of flow) and #showHelp writes the consent-needed
  // help for the host sentence.
  const { CONSENT_REASON } = await import('/packages/core/src/settings.js');
  const term = document.createElement('span'); term.textContent = 'consent term';
  term.style.cssText = 'position:fixed;left:24px;top:24px;width:48px;height:24px;z-index:2147483647;background:transparent;color:transparent';
  Object.assign(term.dataset, { help: 'consent', kind: 'consent', reason: CONSENT_REASON, feature: 'text' });
  dialog.append(term);
  const point = term.getBoundingClientRect();
  return { stockMax, line, cell: { width: before.width, height: before.height }, unclamped, help, point: { x: point.x + point.width / 2, y: point.y + point.height / 2 } };
};
const readHelpAfter = c => {
  const dialog = c.shadowRoot.querySelector('dialog.settings[open]');
  const cell = dialog.querySelector('.context-text'), message = cell.querySelector('.context-message');
  const after = cell.getBoundingClientRect(), shown = message.getBoundingClientRect();
  return { cellAfter: { width: after.width, height: after.height }, message: { width: shown.width, height: shown.height },
    lineClamp: getComputedStyle(message).webkitLineClamp, written: message.textContent };
};
const helpFailures = (kind, h, width, locale) => {
  const failures = [];
  if (!(h.cell.width > 0 && h.cell.height > 0 && h.cellAfter.width > 0 && h.cellAfter.height > 0 && h.message.width > 0 && h.message.height > 0 && h.line > 0 && h.stockMax > 0)) {
    return [`${kind}: help cell, help line, line height and stock probe positive: ${JSON.stringify(h)}`];
  }
  const lines = Math.round(h.stockMax / h.line);
  if (h.written !== h.help) failures.push(`${kind}: precondition: the help line shows the consent-needed help for this sentence: ${JSON.stringify(h.written)}`);
  if (Math.abs(h.cell.height - h.stockMax) > 1) failures.push(`${kind}: the help cell reserves exactly the tallest stock help (no sample): ${h.cell.height} vs ${h.stockMax}`);
  if (Math.abs(h.cellAfter.height - h.cell.height) > 1) failures.push(`${kind}: the help cell keeps its height with this reason in the help line: ${h.cellAfter.height} vs ${h.cell.height}`);
  if (h.message.height > lines * h.line + 1) failures.push(`${kind}: the help line shows at most N=${lines} lines: ${h.message.height} vs ${lines * h.line}`);
  if (Math.abs(h.message.height / h.line - Math.round(h.message.height / h.line)) * h.line > 1) failures.push(`${kind}: the help line shows whole lines only: ${h.message.height} / ${h.line}`);
  if (h.unclamped > lines * h.line + 1 && String(h.lineClamp) !== String(lines)) failures.push(`${kind}: a help text taller than N=${lines} lines is clamped there with an ellipsis: line-clamp ${h.lineClamp}`);
  // The clamp must be exercised: emoji at 360 EN/DE, CJK at 360 EN (DE needs
  // N=4 stock lines there, and the 40-grapheme CJK help fits in them).
  if ((kind === 'emoji' || kind === 'cjk' && locale === 'en') && width === 360 && !(h.unclamped > lines * h.line + 1)) failures.push(`precondition: the ${kind} help needs more than N=${lines} lines at 360: ${h.unclamped}`);
  return failures;
};
export async function consentSheetBodyHeightCheck(t) {
  const open = await harness(t);
  for (const item of sheetCases) {
    const name = `${item.width}x${item.height}-${item.locale}-body-height`;
    await t.test(name, async () => {
      const problems = [], seen = {};
      for (const kind of ['short', 'long', 'oversized', 'wide', 'narrow', 'cjk', 'emoji']) {
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
          const help = await page.$eval('aithema-session', readHelp, item.locale, full);
          await page.mouse.move(help.point.x, help.point.y); await settle(page);
          sheet.help = { ...help, ...await page.$eval('aithema-session', readHelpAfter) };
          if (['cjk', 'emoji'].includes(kind)) await capture(page, `${name}-${kind}-help`, { summary: `${kind} help line; cell ${sheet.help.cell.height} -> ${sheet.help.cellAfter.height}; line ${sheet.help.message.height} / ${sheet.help.line}; clamp ${sheet.help.lineClamp}`, ...sheet.help });
        } finally { await page.close(); }
      }
      const failures = [];
      for (const [kind, sheet] of Object.entries(seen)) {
        if (!(sheet.body?.width > 0 && sheet.body?.height > 0)) failures.push(`${kind}: the settings body positive box: ${JSON.stringify(sheet.body)}`);
        if (!(sheet.below?.width > 0 && sheet.below?.height > 0)) failures.push(`${kind}: the footer row under the body positive box: ${JSON.stringify(sheet.below)}`);
        if (!(sheet.sentence?.width > 0 && sheet.sentence?.height > 0)) failures.push(`${kind}: the sentence positive box: ${JSON.stringify(sheet.sentence)}`);
      }
      for (const [kind, sheet] of Object.entries(seen)) failures.push(...helpFailures(kind, sheet.help, item.width, item.locale));
      if (!failures.length) for (const kind of ['long', 'oversized', 'wide', 'narrow', 'cjk', 'emoji']) {
        const a = seen.short, b = seen[kind];
        if (Math.abs(b.body.height - a.body.height) > 1) failures.push(`${kind}: the settings body keeps its height: ${b.body.height} vs ${a.body.height} (short)`);
        const band = sheet => sheet.below.y - sheet.body.bottom;
        if (band(b) - band(a) > 1) failures.push(`${kind}: no empty band between the body and the footer row: ${band(b)} vs ${band(a)} (short)`);
        if (Math.abs(b.below.y - a.below.y) > 1) failures.push(`${kind}: the footer row stays in place: ${b.below.y} vs ${a.below.y} (short)`);
        if (item.width === 1440 && !(b.ch70 > 0 && b.sentence.width <= b.ch70 + 1)) failures.push(`${kind}: at 1440 the sentence wraps at about 70ch: ${b.sentence.width} vs ${b.ch70}`);
      }
      none(failures, `${name}: ${JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { body: v.body?.height, below: v.below?.y, help: v.help && { cell: v.help.cell.height, after: v.help.cellAfter.height, stock: v.help.stockMax, line: v.help.line, shown: v.help.message.height, clamp: v.help.lineClamp } }])))}`);
      assert.deepEqual(problems, []);
    });
  }
}

// AIT-603 PR-B r6 (Codex gateprb5, three Mediums on the footer help clamp).
const helpState = c => {
  const dialog = c.shadowRoot.querySelector('dialog.settings[open]');
  const cell = dialog.querySelector('.context-text'), message = cell.querySelector('.context-message'), body = dialog.querySelector('.settings__body');
  const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
  const reserve = Math.max(0, ...[...cell.children].filter(n => n !== message).map(n => n.getBoundingClientRect().height));
  return { innerWidth, cell: box(cell), message: box(message), body: box(body), reserve, line: parseFloat(getComputedStyle(message).lineHeight),
    lines: getComputedStyle(message).webkitLineClamp, text: message.textContent, errors: [...globalThis.pageErrors ?? []] };
};
const positiveHelp = (s, label) => (s.cell.width > 0 && s.cell.height > 0 && s.message.width > 0 && s.message.height > 0 && s.body.width > 0 && s.body.height > 0 && s.reserve > 0 && s.line > 0)
  ? [] : [`${label}: help cell, help line, body, reserve and line height positive: ${JSON.stringify(s)}`];
const hoverConsent = async (page, locale, full) => {
  const help = await page.$eval('aithema-session', readHelp, locale, full);
  await page.mouse.move(help.point.x, help.point.y); await settle(page);
  return help;
};
async function r6Capture(page, label, values) {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-603b', 'tick-r6'); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false, captureBeyondViewport: false });
  await writeFile(join(dir, `${label}.json`), JSON.stringify({ label, viewportOnly: true, ...values }, null, 2));
  await appendFile(join(dir, 'index.txt'), `${label}.png  ${label}.json  ${values.summary}\n`);
}

// M1: a resize 1440 -> 360 with the long emoji help on screen. Every animation
// frame across the resize is sampled (read in requestAnimationFrame, before the
// frame's own layout and observers, so the state the frame starts from): the
// help line never exceeds the reserve (N whole lines), the help cell keeps the
// reserve, and the body height is the same in every frame at 360.
export async function consentSheetHelpResizeCheck(t) {
  const open = await harness(t);
  for (const locale of ['en', 'de']) {
    await t.test(`1440 -> 360 ${locale} resize with the emoji help`, async () => {
      const problems = [], full = glyphs.emoji;
      const page = await open({ width: 1440, height: 900, locale, sentence: full, doc: null }, problems);
      try {
        await openSheet(page);
        await page.evaluate(() => globalThis.release());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-status')?.textContent.length > 0);
        await settle(page);
        const help = await hoverConsent(page, locale, full);
        await page.$eval('aithema-session', (c, read) => {
          const sample = (0, eval)(`(${read})`); globalThis.helpFrames = [];
          const tick = () => { globalThis.helpFrames.push(sample(c)); if (globalThis.helpFrames.length < 40) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        }, helpState.toString());
        await page.setViewport({ width: 360, height: 740 });
        await page.waitForFunction(() => globalThis.helpFrames.length >= 40, { timeout: 30_000 });
        const frames = await page.evaluate(() => globalThis.helpFrames);
        const after = frames.filter(f => f.innerWidth === 360), failures = [];
        if (after.length < 10) failures.push(`precondition: at least 10 sampled frames at 360: ${after.length}`);
        if (!after.every(f => f.text === help.help)) failures.push(`precondition: the help line shows the emoji consent help in every frame: ${JSON.stringify(after.map(f => f.text).find(text => text !== help.help))}`);
        const last = after.at(-1);
        if (last && !(last.message.height > 2 * last.line - 1)) failures.push(`precondition: the emoji help wraps at 360: ${last.message.height} / ${last.line}`);
        after.forEach((f, i) => {
          failures.push(...positiveHelp(f, `frame ${i}`));
          if (f.message.height > f.reserve + 1) failures.push(`frame ${i}: the help line never exceeds the reserve (N=${Math.round(f.reserve / f.line)} lines): ${f.message.height} vs ${f.reserve}`);
          if (Math.abs(f.cell.height - f.reserve) > 1) failures.push(`frame ${i}: the help cell keeps the reserve: ${f.cell.height} vs ${f.reserve}`);
          if (Math.abs(f.body.height - last.body.height) > 1) failures.push(`frame ${i}: the body keeps its height in every frame at 360: ${f.body.height} vs ${last.body.height}`);
        });
        const errors = [...new Set(frames.flatMap(f => f.errors))];
        if (errors.length) failures.push(`no ResizeObserver loop or other page error: ${errors.join(' / ')}`);
        await r6Capture(page, `resize-1440-360-${locale}-emoji`, { summary: `${after.length} frames at 360; help ${after.map(f => f.message.height).join(',')}; reserve ${last?.reserve}; body ${[...new Set(after.map(f => f.body.height))].join(',')}`, frames });
        none(failures, `resize ${locale}: ${JSON.stringify(after.map(f => ({ help: f.message.height, reserve: f.reserve, cell: f.cell.height, body: f.body.height, lines: f.lines })))}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// M2: the reserve uses the STOCK copy only (stock reasons and stock help
// templates; a locale without stock copy uses the EN stock). A host that
// overrides every feature reason and help template gives the same N, help
// cell and body height as the stock copy, in en, de and a custom locale fr.
export async function consentSheetHostCopyReserveCheck(t) {
  const open = await harness(t);
  for (const [locale, plain, host] of [['en', '', 'host'], ['de', '', 'host'], ['en', 'fr', 'fr-host']]) {
    const label = host.startsWith('fr') ? 'fr' : locale;
    await t.test(`360 ${label}: host copy does not set the reserve`, async () => {
      const problems = [], seen = {};
      for (const hostCopy of [plain, host]) {
        const page = await open({ width: 360, height: 740, locale, sentence: undefined, doc: null, hostCopy }, problems);
        try {
          await openSheet(page);
          await page.evaluate(() => globalThis.release());
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] .consent-status')?.textContent.length > 0);
          await settle(page);
          seen[hostCopy || 'stock'] = await page.$eval('aithema-session', helpState);
          await r6Capture(page, `host-copy-360-${label}-${hostCopy || 'stock'}`, { summary: `reserve ${seen[hostCopy || 'stock'].reserve}; N ${Math.round(seen[hostCopy || 'stock'].reserve / seen[hostCopy || 'stock'].line)}; body ${seen[hostCopy || 'stock'].body.height}`, ...seen[hostCopy || 'stock'] });
        } finally { await page.close(); }
      }
      const a = seen[plain || 'stock'], b = seen[host], failures = [...positiveHelp(a, 'stock'), ...positiveHelp(b, host)];
      if (!failures.length) {
        if (Math.round(b.reserve / b.line) !== Math.round(a.reserve / a.line)) failures.push(`the host copy gives the stock N: ${Math.round(b.reserve / b.line)} vs ${Math.round(a.reserve / a.line)}`);
        if (Math.abs(b.cell.height - a.cell.height) > 1) failures.push(`the help cell keeps the stock height: ${b.cell.height} vs ${a.cell.height}`);
        if (Math.abs(b.body.height - a.body.height) > 1) failures.push(`the body keeps the stock height: ${b.body.height} vs ${a.body.height}`);
      }
      none(failures, `${label}: ${JSON.stringify({ stock: { reserve: a.reserve, body: a.body.height }, host: { reserve: b.reserve, body: b.body.height } })}`);
      assert.deepEqual(problems, []);
    });
  }
}

// M3: the privacy gauge's help with a long provider-country list and the
// host's privacy link. The message is NOT clamped (it ends in a link); the
// reserve covers it (the dialog measures the privacy help it would show), so
// the link is fully visible inside every clipping box, draws its focus ring
// unclipped, and the body and help cell keep their height when it shows.
const COUNTRIES = ['US', 'IE', 'DE', 'FR', 'JP', 'BR', 'IN', 'CA', 'AU', 'SG', 'KR', 'MX', 'ZA', 'CH', 'SE', 'NO', 'PL', 'IT', 'ES', 'NL'];
export async function consentSheetPrivacyLinkCheck(t) {
  const open = await harness(t);
  for (const [width, height, locale] of [[360, 740, 'en'], [360, 740, 'de'], [768, 1024, 'en'], [1440, 900, 'en']]) {
    await t.test(`${width} ${locale}: the privacy link with a long country list`, async () => {
      const problems = [];
      const page = await open({ width, height, locale, sentence: undefined, doc: null, countries: COUNTRIES }, problems);
      try {
        // As start2-display's provider-seat check: the best preset's 'default'
        // model carries the countries, voice and visuals off.
        await page.$eval('aithema-session', c => {
          const session = structuredClone(c.session);
          session.processingPreset = 'best'; session.settings = { ...session.settings, preset: 'best', model: 'default', voice: 'off', visuals: 'off' };
          globalThis.countriesSession = session;
          c.configure({ copy: globalThis.fixtureCopy, session }); c.openSettings();
        });
        try {
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings[open] [data-gauge="privacy"]')?.dataset.state === 'hostCountries', { timeout: 20_000 });
        } catch {
          const state = await page.$eval('aithema-session', c => ({ open: Boolean(c.shadowRoot.querySelector('dialog.settings[open]')), privacy: c.shadowRoot.querySelector('[data-gauge="privacy"]')?.dataset.state ?? null, preset: c.session?.processingPreset ?? null, settings: c.session?.settings ?? null,
            model: c.shadowRoot.querySelector('[data-select="model"]')?.textContent ?? null }));
          throw new Error(`precondition: the privacy gauge shows provider countries: ${JSON.stringify(state)}`);
        }
        await settle(page);
        const before = await page.$eval('aithema-session', helpState);
        // Below 600 px the gauges are hidden (AIT-294 phone essentials), so the
        // privacy help never shows there and its measure must reserve nothing.
        if (width < 600) {
          const phone = await page.$eval('aithema-session', c => {
            const dialog = c.shadowRoot.querySelector('dialog.settings[open]'), m = dialog.querySelector('.context-link-measure');
            return { gauges: dialog.querySelector('[data-gauge="privacy"]').checkVisibility(), measure: m ? m.getBoundingClientRect().height : null };
          });
          const failures = [];
          if (phone.gauges) failures.push('precondition: the gauges are hidden below 600 px');
          if (phone.measure > 0) failures.push(`below 600 px the privacy help's measure reserves nothing: ${phone.measure}`);
          await r6Capture(page, `privacy-link-${width}-${locale}`, { summary: `phone: gauges visible ${phone.gauges}; link measure ${phone.measure}`, ...phone });
          none(failures, `privacy ${width} ${locale}`);
          assert.deepEqual(problems, []);
          return;
        }
        // The gauge can sit below the body's fold: bring it on screen first.
        await page.$eval('aithema-session', c => {
          const gauge = c.shadowRoot.querySelector('dialog.settings[open] [data-gauge="privacy"]'), details = gauge.closest('details');
          if (details) details.open = true;
          gauge.scrollIntoView({ block: 'center' });
        });
        await settle(page);
        const point = await page.$eval('aithema-session', c => { const r = c.shadowRoot.querySelector('dialog.settings[open] [data-gauge="privacy"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        // The keyboard path (the gauge is focusable in this state); the pointer
        // rests outside the dialog so no hovered term takes precedence.
        void point; await page.mouse.move(1, 1);
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('dialog.settings[open] [data-gauge="privacy"]').focus({ focusVisible: true }));
        await settle(page);
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('dialog.settings[open] .context-message a[data-aithema-privacy]')?.focus({ focusVisible: true }));
        await settle(page);
        const after = await page.$eval('aithema-session', c => {
          const dialog = c.shadowRoot.querySelector('dialog.settings[open]'), message = dialog.querySelector('.context-message'), link = message.querySelector('a[data-aithema-privacy]');
          if (!link) return { link: null, text: message.textContent };
          const css = getComputedStyle(link), ring = (parseFloat(css.outlineWidth) || 0) + (parseFloat(css.outlineOffset) || 0);
          const r = link.getBoundingClientRect(), clipped = [];
          for (let n = link.parentElement; n && n !== dialog.parentNode; n = n.parentElement) {
            const style = getComputedStyle(n);
            if (!/(auto|scroll|hidden|clip)/u.test(`${style.overflowX} ${style.overflowY}`) && style.webkitLineClamp === 'none') continue;
            const v = n.getBoundingClientRect();
            if (r.top - ring < v.top - .5 || r.bottom + ring > v.bottom + .5 || r.left - ring < v.left - .5 || r.right + ring > v.right + .5) clipped.push(`${n.className || n.tagName}: link ${JSON.stringify([r.top, r.bottom])} ring ${ring} box ${JSON.stringify([v.top, v.bottom])} overflow ${style.overflowY} clamp ${style.webkitLineClamp}`);
          }
          return { link: { width: r.width, height: r.height, top: r.top, bottom: r.bottom }, focused: c.shadowRoot.activeElement === link, outline: css.outlineStyle, ring, clipped, visible: link.checkVisibility(), text: message.textContent };
        });
        const shown = await page.$eval('aithema-session', helpState), failures = [...positiveHelp(before, 'before'), ...positiveHelp(shown, 'shown')];
        if (!after.link) failures.push(`precondition: the help line carries the host's privacy link: ${JSON.stringify(after.text)} ${JSON.stringify(await page.$eval('aithema-session', c => { const g = c.shadowRoot.querySelector('dialog.settings[open] [data-gauge="privacy"]'), r = g.getBoundingClientRect(); return { focused: c.shadowRoot.activeElement?.className ?? null, visible: g.checkVisibility(), box: [r.x, r.y, r.width, r.height], tabIndex: g.tabIndex, details: g.closest('details')?.open ?? null, hidden: Boolean(g.closest('[hidden]')) }; }))}`);
        else {
          if (!(after.link.width > 0 && after.link.height > 0) || !after.visible) failures.push(`the link has a positive, visible box: ${JSON.stringify(after.link)}`);
          if (width === 768 && !(shown.message.height > 2 * shown.line - 1)) failures.push(`precondition: the privacy help wraps over several lines: ${shown.message.height} / ${shown.line}`);
          if (!after.focused || after.outline === 'none' || !(after.ring > 0)) failures.push(`the link takes focus and draws a ring: ${JSON.stringify({ focused: after.focused, outline: after.outline, ring: after.ring })}`);
          if (after.clipped.length) failures.push(`the link and its ring are inside every clipping box: ${after.clipped.join(' | ')}`);
          if (shown.message.height > shown.reserve + 1) failures.push(`the reserve covers the privacy help: ${shown.message.height} vs ${shown.reserve}`);
          if (Math.abs(shown.cell.height - before.cell.height) > 1) failures.push(`the help cell keeps its height: ${shown.cell.height} vs ${before.cell.height}`);
          if (Math.abs(shown.body.height - before.body.height) > 1) failures.push(`the body keeps its height: ${shown.body.height} vs ${before.body.height}`);
        }
        await r6Capture(page, `privacy-link-${width}-${locale}`, { summary: `link ${JSON.stringify(after.link)}; clipped ${after.clipped?.length ?? '-'}; cell ${before.cell.height} -> ${shown.cell.height}; body ${before.body.height} -> ${shown.body.height}`, before, shown, after });
        none(failures, `privacy ${width} ${locale}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}
