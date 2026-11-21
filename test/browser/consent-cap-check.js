// AIT-603 PR-A: the phone text-consent cap, held to TICK's spec with a PURE
// CSS clamp (LEAD: no JS measuring, no truncation search, no cache).
// On phones (≤ 600 px) the dock's text-consent line shows at most two whole
// lines. When the host text overflows, its own clamp box ends it with "…"
// (CSS line-clamp) and the action, outside that box, is whole and ends line
// 2. The hidden reserve has the same cap, so granting consent moves nothing;
// the granted line sits top-aligned in it. A locale switch (another action
// length) and a font swap re-lay out by CSS alone. The action is named by
// its visible text; the host sentence is its description, exposed once.
// Desktop (> 600 px) is unchanged. Every measured box must be positive.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const keys = ['x', 'y', 'width', 'height'];
const stock = { en: en.featureConsent, de: de.featureConsent };
const longText = locale => Array(8).fill(stock[locale].text).join(' ');
// One unbroken 72-letter word (no spaces, no hyphens).
const WORD72 = { en: 'Consentdocumentation'.repeat(4).slice(0, 72), de: 'Einwilligungsdokumentation'.repeat(3).slice(0, 72) };
assert.equal(WORD72.en.length, 72); assert.equal(WORD72.de.length, 72);
// Host text lengths from 0 to "very long".
const TEXTS = {
  empty: () => '',
  short: locale => (locale === 'de' ? 'Einwilligung nötig' : 'Consent needed'),
  stock: locale => stock[locale].text,
  long: locale => longText(locale),
  word72: locale => WORD72[locale],
  'word72-after': locale => `${stock[locale].text} ${WORD72[locale]} ${stock[locale].text}`,
};
const ACTIONS = { stock: () => ({}), short: () => ({ action: 'OK', actionNarrow: 'OK' }) };
const HOST = {
  en: { text: 'Your messages reach our model provider only after you agree', action: 'Agree…', actionNarrow: 'Agree' },
  de: { text: 'Ihre Nachrichten erreichen unseren Modellanbieter erst nach Ihrer Zustimmung', action: 'Zustimmen…', actionNarrow: 'Zustimmen' },
};
const phones = [[360, 740], [390, 664]];

// The lane's summary keeps lines with "Error:", so a red names its reason.
const none = (failures, label) => { if (failures.length) throw new Error(`${failures.join(' | ')} [${label}]`.slice(0, 1500)); };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

// The consent line, its clamp box, the action, the reserve and the dock controls, read in the page.
const consentInPage = c => {
  const root = c.shadowRoot;
  const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const rect = n => (n && n.checkVisibility() ? box(n) : null);
  const base = { dock: rect(root.querySelector('.composer-dock')), mic: rect(root.querySelector('.composer-mic')), send: rect(root.querySelector('.send')),
    reason: rect(root.querySelector('.composer-feedback > .composer-reason')), reasonText: root.querySelector('.composer-feedback > .composer-reason')?.textContent ?? null,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    reserve: rect([...root.querySelectorAll('.composer-feedback-reserve > .composer-reserve-consent')].find(n => n.checkVisibility())) };
  const line = root.querySelector('.composer-reason[data-consent-feature="text"]');
  if (!line?.checkVisibility()) return { ...base, line: null };
  const label = line.querySelector('.consent-line-copy'), action = line.querySelector('.consent-action'), style = getComputedStyle(line);
  const textRects = node => { const rects = []; const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement.checkVisibility()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const b of range.getClientRects()) if (b.width > .5 && b.height > .5) rects.push({ x: b.x, y: b.y, width: b.width, height: b.height }); }
    return rects; };
  const labelStyle = getComputedStyle(label);
  return { ...base, line: { ...box(line), lineHeight: parseFloat(style.lineHeight), scrollWidth: line.scrollWidth, clientWidth: line.clientWidth, direction: style.direction },
    label: { ...box(label), display: labelStyle.display, lineClamp: labelStyle.webkitLineClamp, overflow: labelStyle.overflowY,
      scrollHeight: label.scrollHeight, clientHeight: label.clientHeight, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth, rects: textRects(label) },
    action: { ...box(action), text: action.textContent.trim() ? [...action.querySelectorAll('*')].filter(n => n.checkVisibility() && !n.children.length).map(n => n.textContent).join('') || action.textContent : '',
      rects: textRects(action), position: getComputedStyle(action).position } };
};

// TICK's cap at a phone width. The text clamps (CSS line-clamp "…" in its own
// box), the action never does: whole, on the last line, ending it.
function capFailures(state) {
  const { line, label, action } = state, failures = [];
  if (!(line?.width > 0 && line?.height > 0)) return [`the consent line positive box: ${JSON.stringify(line)}`];
  if (!(label?.width > 0 && label?.height > 0)) failures.push(`the clamp box positive box: ${JSON.stringify(label)}`);
  const lines = line.height / line.lineHeight;
  if (Math.abs(lines - Math.round(lines)) > .05) failures.push(`the consent line shows whole lines: ${line.height} / ${line.lineHeight}`);
  if (Math.round(lines) > 2 || Math.round(lines) < 1) failures.push(`the consent line shows one or two lines: ${lines.toFixed(2)}`);
  // The sentence's own clamp box: -webkit-line-clamp 2 ("…" at the clamp).
  // Chromium computes display:-webkit-box with a line clamp as flow-root.
  if (label?.lineClamp !== '2' || !/-webkit-box|flow-root/u.test(label?.display ?? '') || label?.overflow !== 'hidden') failures.push(`the host text has its own two-line clamp box: ${JSON.stringify({ display: label?.display, clamp: label?.lineClamp, overflow: label?.overflow })}`);
  const clamped = label.scrollHeight > label.clientHeight + 1;
  if (clamped && Math.round(lines) !== 2) failures.push(`a clamped line shows exactly two lines: ${lines.toFixed(2)}`);
  // The action: one whole box (never cut or wrapped), inside the line, on its last line.
  if (action?.rects?.length !== 1) failures.push(`the consent action is one painted box: ${JSON.stringify(action?.rects)}`);
  for (const b of action?.rects ?? []) {
    if (!(b.width > 0 && b.height > 0)) failures.push(`consent action text positive box: ${JSON.stringify(b)}`);
    // Horizontally whole inside the line; vertically its middle is inside the
    // line (a text box is the font's content area, which a larger glyph face
    // can make taller than the line height).
    const middle = b.y + b.height / 2 - line.y;
    if (b.x < line.x - .5 || b.x + b.width > line.x + line.width + .5 || middle < 0 || middle > line.height)
      failures.push(`the consent action is whole inside the line: ${JSON.stringify({ b, line })}`);
    if (Math.floor(middle / line.lineHeight) + 1 !== Math.round(lines)) failures.push(`the consent action is on the last line: ${JSON.stringify({ b, line })}`);
    // It ends the line: nothing painted after it on its line.
    for (const t of label?.rects ?? []) {
      const onSameLine = Math.abs((t.y + t.height / 2) - (b.y + b.height / 2)) < line.lineHeight / 2 && t.y + t.height <= label.y + label.height + .5;
      if (!onSameLine) continue;
      if (t.x < b.x + b.width - .5 && t.x + t.width > b.x + .5) failures.push(`the host text does not run under the action: ${JSON.stringify({ t, b })}`);
      if (line.direction !== 'rtl' && t.x >= b.x + b.width - .5) failures.push(`the action ends its line: ${JSON.stringify({ t, b })}`);
    }
  }
  // No scrolling and no horizontal overflow inside the line, nor on the page.
  if (label && label.scrollWidth > label.clientWidth + 1) failures.push(`no horizontal overflow in the clamp box: ${label.scrollWidth} > ${label.clientWidth}`);
  if (line.scrollWidth > line.clientWidth + 1) failures.push(`no horizontal overflow in the line: ${line.scrollWidth} > ${line.clientWidth}`);
  if (state.pageOverflow > 0) failures.push(`no horizontal page overflow: ${state.pageOverflow}`);
  // One shared cap: the hidden reserve has the visible line's height (when it
  // is not taller, the dock row is the reserve's).
  if (!(state.reserve?.width > 0 && state.reserve?.height > 0)) failures.push(`the consent reserve positive box: ${JSON.stringify(state.reserve)}`);
  else if (line.height > state.reserve.height + .5) failures.push(`the visible line fits the reserve: ${line.height} > ${state.reserve.height}`);
  else if (state.reserve.height > 2 * line.lineHeight + .5) failures.push(`the reserve holds at most two lines: ${state.reserve.height}`);
  return { failures, clamped, lines: Math.round(lines) };
}
const sameBoxFailures = (name, before, after) => {
  const failures = [];
  for (const control of ['dock', 'mic', 'send']) {
    if (!(before[control]?.width > 0 && before[control]?.height > 0 && after[control]?.width > 0 && after[control]?.height > 0)) { failures.push(`${name}: ${control} positive boxes: ${JSON.stringify([before[control], after[control]])}`); continue; }
    for (const key of keys) if (Math.abs(before[control][key] - after[control][key]) > .5) failures.push(`${name}: ${control} keeps its ${key}: ${before[control][key]} -> ${after[control][key]}`);
  }
  return failures;
};

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-cap-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-603a', 'tick') : null;
  if (evidence) await mkdir(evidence, { recursive: true });
  const index = [];
  // Mount (again) with the locale's copy and the host's featureConsent overrides.
  const mountWith = async (page, locale, consent = {}, start = false) => {
    await page.evaluate(async (locale, overrides, start) => {
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = { ...base, featureConsent: { ...base.featureConsent, ...overrides } };
      globalThis.snapshot603a ??= JSON.parse(JSON.stringify(document.querySelector('aithema-session').session));
      const snapshot = JSON.parse(JSON.stringify(globalThis.snapshot603a));
      if (start) snapshot.featureMatrix.best.imageInput = { available: true };
      mount(snapshot);
    }, locale, consent, start);
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"] .consent-action'));
    await settle(page);
  };
  const open = async ({ width, height, locale, start = false, consent = {} }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await mountWith(page, locale, consent, start);
    return page;
  };
  const grant = async page => {
    await page.evaluate(() => grant());
    await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'));
    await settle(page);
    return page.$eval('aithema-session', consentInPage);
  };
  const read = page => page.$eval('aithema-session', consentInPage);
  const capture = async (page, name, state) => {
    index.push({ name, shot: `${name}.png`, file: `${name}.json`, dock: state.dock, mic: state.mic, send: state.send, line: state.line, action: state.action ? { ...state.action, rects: undefined } : null });
    if (!evidence) return;
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
    await writeFile(join(evidence, `${name}.json`), JSON.stringify(state, null, 2));
    await writeFile(join(evidence, `index-${process.pid}-${t.name.replace(/\W+/gu, '-').slice(0, 40)}.json`), JSON.stringify(index, null, 2));
  };
  return { open, mountWith, grant, read, capture };
}

// 360/390 × EN/DE × stock / "OK" action × host text 0 .. very long (incl. a 72-letter word).
export async function consentCapMatrixCheck(t) {
  const { open, mountWith, read, capture } = await harness(t);
  for (const [width, height] of phones) for (const locale of ['en', 'de']) {
    await t.test(`${width}x${height}-${locale}`, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale }, problems);
      try {
        for (const [actionName, action] of Object.entries(ACTIONS)) for (const [textName, text] of Object.entries(TEXTS)) {
          const name = `${width}x${height}-${locale}-${textName}-${actionName}-action`;
          await mountWith(page, locale, { ...action(), text: text(locale) });
          const state = await read(page);
          const { failures: cap, clamped } = capFailures(state);
          failures.push(...cap.map(f => `${name}: ${f}`));
          // Fixture sanity: very long copy clamps; a short host text does not.
          if (['long', 'word72-after'].includes(textName) && !clamped) failures.push(`${name}: the very long host text clamps`);
          if (['empty', 'short'].includes(textName) && clamped) failures.push(`${name}: a short host text shows whole`);
          if (['long', 'word72', 'word72-after', 'short'].includes(textName)) await capture(page, `${name}-pending`, state);
        }
        none(failures, `${width}x${height}-${locale}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// Pending → granted: the dock, mic and Send keep their boxes (0 px); the
// granted line sits top-aligned in the shared reserve. Plain and image docks.
export async function consentCapGrantCheck(t) {
  const { open, grant, read, capture } = await harness(t);
  const cases = phones.flatMap(([width, height]) => ['en', 'de'].flatMap(locale => ['long', 'stock', 'short'].map(text => ({ width, height, locale, text }))))
    .concat(['en', 'de'].map(locale => ({ width: 390, height: 664, locale, text: 'long', start: true })));
  for (const item of cases) {
    const name = `${item.width}x${item.height}-${item.locale}-${item.text}${item.start ? '-image-dock' : ''}`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ ...item, consent: { text: TEXTS[item.text](item.locale) } }, problems);
      try {
        if (item.start) assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.composer').hasAttribute('data-image-input')), true, `${name}: image input is available`);
        const pending = await read(page);
        const failures = capFailures(pending).failures;
        if (item.text === 'long') await capture(page, `${name}-pending`, pending);
        const granted = await grant(page);
        if (item.text === 'long') await capture(page, `${name}-granted`, granted);
        failures.push(...sameBoxFailures(name, pending, granted));
        if (!(granted.reason?.width > 0 && granted.reason?.height > 0)) failures.push(`the granted line positive box: ${JSON.stringify(granted.reason)} "${granted.reasonText}"`);
        else if (pending.line && Math.abs(granted.reason.y - pending.line.y) > .5) failures.push(`the granted line sits top-aligned in the reserve: ${granted.reason.y} vs ${pending.line.y}`);
        none(failures, `${name}: ${JSON.stringify({ pending: { line: pending.line, reserve: pending.reserve }, granted: granted.reason })}`);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// gate6c's cache Medium: a locale switch keeps the host sentence and the dock
// width but changes the action's length. CSS alone re-lays it out: the cap
// holds in both directions, the action box follows its new text.
export async function consentCapLocaleSwitchCheck(t) {
  const { open, mountWith, read, capture } = await harness(t);
  for (const [width, height] of phones) for (const text of ['long', 'stock']) {
    const name = `${width}x${height}-${text}-locale-switch`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      // One host sentence in both locales; only the action changes.
      const sentence = TEXTS[text]('en');
      const page = await open({ width, height, locale: 'en', consent: { text: sentence } }, problems);
      try {
        const states = [];
        for (const [step, locale, action] of [['en', 'en', {}], ['de', 'de', {}], ['en-again', 'en', {}], ['de-short', 'de', ACTIONS.short()], ['en-stock', 'en', {}]]) {
          if (step !== 'en') await mountWith(page, locale, { ...action, text: sentence });
          const state = await read(page);
          failures.push(...capFailures(state).failures.map(f => `${step}: ${f}`));
          const expected = action.action ?? stock[locale].action;
          if (state.action?.text !== expected) failures.push(`${step}: the action shows "${expected}": "${state.action?.text}"`);
          states.push({ step, state });
          if (text === 'long') await capture(page, `${name}-${step}`, state);
        }
        // Back to EN: the same layout as the first EN paint.
        const [first, , again] = states.map(s => s.state);
        for (const part of ['line', 'action']) for (const key of keys)
          if (Math.abs(first[part][key] - again[part][key]) > .5) failures.push(`EN → DE → EN restores the ${part} ${key}: ${first[part][key]} -> ${again[part][key]}`);
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// A font swap (same family name and width, other glyph metrics) re-lays out
// by CSS: no font event, no JS, the cap still holds.
export async function consentCapFontSwapCheck(t) {
  const { open, read } = await harness(t);
  for (const [width, height] of phones) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-font-swap`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ width, height, locale, consent: { text: longText(locale) } }, problems);
      try {
        const failures = capFailures(await read(page)).failures.map(f => `before: ${f}`);
        for (const adjust of ['.3', '.7']) {
          await page.$eval('aithema-session', (c, adjust) => {
            let style = c.shadowRoot.querySelector('style[data-font-swap]');
            if (!style) { style = document.createElement('style'); style.dataset.fontSwap = ''; c.shadowRoot.append(style); }
            style.textContent = `.composer-reason[data-consent-feature="text"], .composer-reserve-consent { font-size-adjust:${adjust}; }`;
          }, adjust);
          await settle(page);
          failures.push(...capFailures(await read(page)).failures.map(f => `adjust ${adjust}: ${f}`));
        }
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// Desktop (> 600 px) unchanged: no clamp box, the action inline after the sentence.
export async function consentCapDesktopCheck(t) {
  const { open, read, capture } = await harness(t);
  for (const locale of ['en', 'de']) for (const text of ['stock', 'long']) {
    const name = `1440x900-${locale}-${text}-desktop`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ width: 1440, height: 900, locale, consent: { text: TEXTS[text](locale) } }, problems);
      try {
        const state = await read(page), failures = [];
        if (!(state.line?.width > 0 && state.line?.height > 0)) failures.push(`the consent line positive box: ${JSON.stringify(state.line)}`);
        if (state.label?.lineClamp !== 'none' || /-webkit-box/u.test(state.label?.display ?? '')) failures.push(`desktop keeps no clamp box: ${JSON.stringify({ display: state.label?.display, clamp: state.label?.lineClamp })}`);
        if (state.label && state.label.scrollHeight > state.label.clientHeight + 1 && state.label.overflow === 'hidden') failures.push('desktop shows the whole sentence');
        if (state.action?.position !== 'relative') failures.push(`desktop keeps the action inline: ${state.action?.position}`);
        await capture(page, `${name}-pending`, state);
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// TICK r5: the visible action names the button (stock and host copy) and the
// host's full sentence is its description, at 320/360/390.
export async function consentAccessibleTextCheck(t) {
  const { open } = await harness(t);
  for (const width of [320, 360, 390]) for (const locale of ['en', 'de']) for (const copy of ['stock', 'host']) {
    const name = `${width}-${locale}-${copy}`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ width, height: 740, locale, consent: copy === 'host' ? HOST[locale] : {} }, problems);
      try {
        const { consent, painted } = await page.$eval('aithema-session', c => {
          const action = c.shadowRoot.querySelector('.composer-reason[data-consent-feature="text"] .consent-action');
          const visible = [...action.querySelectorAll('*')].filter(n => n.checkVisibility() && !n.children.length).map(n => n.textContent).join('') || action.textContent;
          return { consent: globalThis.fixtureCopy.featureConsent, painted: visible.trim() };
        });
        const opener = await page.$('aithema-session >>> .composer-reason[data-consent-feature="text"] .consent-action');
        const node = await page.accessibility.snapshot({ root: opener });
        await opener.dispose();
        const expectedAction = width <= 340 ? consent.actionNarrow : consent.action, failures = [];
        if (painted !== expectedAction) failures.push(`the visible action: "${painted}" vs "${expectedAction}"`);
        if (node?.name !== expectedAction) failures.push(`the action's accessible name is the action alone: "${node?.name}" vs "${expectedAction}"`);
        if (node?.description !== consent.text) failures.push(`the description is the host's full sentence: "${node?.description}" vs "${consent.text}"`);
        for (const reason of [consent.textActionReason, consent.text]) if (reason && node?.name?.includes(reason)) failures.push(`the name repeats a reason: "${node.name}"`);
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}

// TICK r5 / gate5c M3: the host sentence is exposed once in the composer's
// accessibility tree (the action's description), not again as the status
// region's text or the text box's description; unclamped and clamped.
export async function consentSentenceOnceCheck(t) {
  const { open } = await harness(t);
  for (const width of [320, 360, 390]) for (const locale of ['en', 'de']) for (const copy of ['stock', 'long']) {
    const name = `${width}-${locale}-${copy}-sentence-once`;
    await t.test(name, async () => {
      const problems = [];
      const page = await open({ width, height: 740, locale, consent: copy === 'long' ? { text: longText(locale) } : {} }, problems);
      try {
        const consent = await page.evaluate(() => globalThis.fixtureCopy.featureConsent);
        const composer = await page.$('aithema-session >>> form.composer');
        const tree = await page.accessibility.snapshot({ root: composer, interestingOnly: false });
        await composer.dispose();
        const hits = [];
        const walk = (node, path) => {
          if (node.role === 'InlineTextBox') return;
          for (const field of ['name', 'description', 'value']) if (typeof node[field] === 'string' && node[field].includes(consent.text)) hits.push(`${path}/${node.role} ${field}`);
          for (const child of node.children ?? []) walk(child, `${path}/${node.role}`);
        };
        walk(tree, '');
        const failures = [];
        if (hits.length !== 1) failures.push(`the host sentence is exposed once: ${hits.length} ${JSON.stringify(hits)}`);
        else if (!/\/button description$/u.test(hits[0])) failures.push(`the one exposure is the action's description: ${hits[0]}`);
        const title = await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]').getAttribute('title'));
        if (title) failures.push(`the text-consent status line carries no title: "${title}"`);
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
}
