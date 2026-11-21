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
// A host override far longer than a phone line (several lines in the sheet).
const longSentence = locale => Array(8).fill(locale === 'de'
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
  return async ({ width, height, locale, sentence, doc }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(async (locale, sentence, doc) => {
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = sentence === undefined ? base : { ...base, featureConsent: { ...base.featureConsent, text: sentence } };
      let release; globalThis.releaseConsent = new Promise(resolve => { release = resolve; }); globalThis.release = () => release();
      const prior = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => String(url).endsWith('/consent') && (options.method ?? 'GET') === 'GET'
        ? (await globalThis.releaseConsent, doc ? Response.json(doc) : new Response('unavailable', { status: 500 })) : prior(url, options);
      mount(JSON.parse(JSON.stringify(document.querySelector('aithema-session').session)));
    }, locale, sentence, doc);
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
  return { open: true, sentence: box(holder), sentenceOnScreen: onScreen(holder), target: box(target), row: box(row), targetOnScreen: onScreen(target),
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
          if (sheet.row.bottom - sheet.sentence.y > sheet.body.height - 2 * GAP) failures.push(`the fixture fits the sentence and the target together: ${sheet.row.bottom - sheet.sentence.y} vs ${sheet.body.height}`);
          if (!sheet.targetOnScreen) failures.push('the target checkbox is on screen with the sentence (both fit)');
          if (!sheet.focusTarget) failures.push(`the target checkbox has focus (both fit): ${sheet.focus}`);
          // The least scroll: the target row's bottom where it was before the load.
          const bottomAtStart = sheet.row.bottom + (sheet.scrollTop - start), least = Math.max(0, bottomAtStart - (sheet.body.y + sheet.body.height) + GAP);
          if (Math.abs(sheet.scrollTop - start - least) > 1) failures.push(`the sheet scrolls the least that shows both: ${sheet.scrollTop - start} vs ${least}`);
        }
        await capture(page, name, { summary: `loaded; sentence on screen ${sheet.sentenceOnScreen}; target on screen ${sheet.targetOnScreen}; focus ${sheet.focus}`, sentenceText: full, scrollAtOpen: start, ...sheet });
        none(failures, `${name}: ${JSON.stringify({ start, sheet })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}
