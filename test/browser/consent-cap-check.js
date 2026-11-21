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
  // r2 (Codex CLAMP): the reserve's own line height, for the desktop two-line cap.
  const reserveNode = [...root.querySelectorAll('.composer-feedback-reserve > .composer-reserve-consent')].find(n => n.checkVisibility());
  base.reserveLineHeight = reserveNode ? parseFloat(getComputedStyle(reserveNode).lineHeight) : null;
  const line = root.querySelector('.composer-reason[data-consent-feature="text"]');
  if (!line?.checkVisibility()) return { ...base, line: null };
  const label = line.querySelector('.consent-line-copy'), action = line.querySelector('.consent-action'), style = getComputedStyle(line);
  const textRects = node => { const rects = []; const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement.checkVisibility()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const b of range.getClientRects()) if (b.width > .5 && b.height > .5) rects.push({ x: b.x, y: b.y, width: b.width, height: b.height }); }
    return rects; };
  const labelStyle = getComputedStyle(label);
  // r2 (TICK (a)): every "·" the clamp box paints inside its own box (clamped
  // lines beyond it are not on screen).
  const lb = label.getBoundingClientRect(), separators = [];
  { const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { if (!n.parentElement.checkVisibility()) continue;
      for (let i = n.textContent.indexOf('·'); i >= 0; i = n.textContent.indexOf('·', i + 1)) {
        const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1);
        for (const b of range.getClientRects()) { const middle = b.y + b.height / 2;
          if (b.width > .5 && b.height > .5 && middle > lb.y && middle < lb.y + lb.height && b.x >= lb.x - .5 && b.x + b.width <= lb.x + lb.width + .5) separators.push({ x: b.x, y: b.y, width: b.width, height: b.height }); } } } }
  // r2 (Codex CLAMP): the action's ACTUAL hit area, its ::after target, read
  // from the used values (position, size and the translate), not assumed.
  const after = getComputedStyle(action, '::after'), a = action.getBoundingClientRect();
  let hit = null;
  if (after.content !== 'none' && after.display !== 'none') {
    const w = parseFloat(after.width), h = parseFloat(after.height), m = new DOMMatrixReadOnly(after.transform === 'none' ? undefined : after.transform);
    const x = after.left !== 'auto' ? a.x + action.clientLeft + parseFloat(after.left) : a.x + action.clientLeft + action.clientWidth - parseFloat(after.right) - w;
    const y = after.top !== 'auto' ? a.y + action.clientTop + parseFloat(after.top) : a.y + action.clientTop + action.clientHeight - parseFloat(after.bottom) - h;
    hit = { x: x + m.m41, y: y + m.m42, width: w, height: h };
  }
  return { ...base, separators, hit, line: { ...box(line), lineHeight: parseFloat(style.lineHeight), scrollWidth: line.scrollWidth, clientWidth: line.clientWidth, direction: style.direction },
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
  // r4: `intake` adds document ('document') or image ('image') intake; `granted`
  // mounts with text and voice already allowed (the fixture's analysis value).
  // r8: `copy` overrides top-level copy keys (e.g. a two-line imagePreparing).
  const mountWith = async (page, locale, consent = {}, start = false, { intake = null, granted = false, copy = {} } = {}) => {
    await page.evaluate(async (locale, overrides, start, intake, granted, copy) => {
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = { ...base, ...copy, featureConsent: { ...base.featureConsent, ...overrides } };
      globalThis.snapshot603a ??= JSON.parse(JSON.stringify(document.querySelector('aithema-session').session));
      const snapshot = JSON.parse(JSON.stringify(globalThis.snapshot603a)), best = snapshot.featureMatrix.best;
      if (start || intake === 'image') best.imageInput = { available: true };
      if (intake === 'document') best.uploads = { available: true };
      if (granted) { best.text = structuredClone(best.analysis); best.voice = structuredClone(best.analysis); }
      mount(snapshot);
    }, locale, consent, start, intake, granted, copy);
    await page.waitForFunction(granted => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return granted ? root.querySelector('.composer-reason[data-shortcut]') : root.querySelector('.composer-reason[data-consent-feature="text"] .consent-action');
    }, {}, granted);
    await settle(page);
  };
  const open = async ({ width, height, locale, start = false, consent = {}, intake = null, granted = false, copy = {} }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    // AIT-603 r8b: the keyboard-up latch observes the feedback row with a ResizeObserver. Chrome dispatches a
    // "ResizeObserver loop" error to window without reporting it as a page error, so forward it as a problem.
    page.on('console', message => { if (/ResizeObserver/.test(message.text())) problems.push(message.text()); });
    await page.evaluateOnNewDocument(() => window.addEventListener('error', event => {
      if (/ResizeObserver/.test(String(event.message))) console.error(`ResizeObserver loop: ${event.message}`);
    }));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await mountWith(page, locale, consent, start, { intake, granted, copy });
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
  return { open, mountWith, grant, read, capture, evidence };
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

// r2, TICK decision (a): on phones the consent line is ALWAYS two rows and the
// action ALWAYS ends row 2 at one fixed spot (short text, clamped text, the
// 72-letter word, both action lengths, both locales). No "·" is painted (row 1
// never ends with one; the clamped case has none). Mic and Send keep one box
// at each width across all of them, the locale switch and pending → granted;
// the granted line sits top-aligned in the same two rows. Codex CLAMP: the
// action's actual 44 px hit area never overlaps Send or Mic (320/360/390 EN/DE).
const overlap = (p, q) => Math.max(0, Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y));
export async function consentCapTwoRowsCheck(t) {
  const { open, mountWith, grant, read, capture } = await harness(t);
  for (const [width, height] of [[320, 568], ...phones]) {
    const name = `${width}x${height}-two-rows`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale: 'en' }, problems);
      try {
        let ref = null, last = null;
        for (const locale of ['en', 'de']) for (const [actionName, action] of Object.entries(ACTIONS)) for (const [textName, text] of Object.entries(TEXTS)) {
          const label = `${width}x${height}-${locale}-${textName}-${actionName}-action`;
          await mountWith(page, locale, { ...action(), text: text(locale) });
          const state = await read(page); last = { label, state };
          failures.push(...capFailures(state).failures.map(f => `${label}: ${f}`));
          const { line } = state;
          if (!(line?.height > 0)) continue;
          if (Math.abs(line.height - 2 * line.lineHeight) > .5) failures.push(`${label}: the consent line is always two rows: ${line.height} vs 2 × ${line.lineHeight}`);
          if (state.separators?.length) failures.push(`${label}: no "·" ends row 1 (none is painted): ${JSON.stringify(state.separators)}`);
          const box = state.action?.rects?.[0];
          if (!(box?.width > 0 && box?.height > 0)) { failures.push(`${label}: the action's painted box is positive: ${JSON.stringify(box)}`); continue; }
          const spot = { right: box.x + box.width, bottom: box.y + box.height };
          // The hit area: positive, and clear of Send and Mic.
          if (!(state.hit?.width >= 44 - .5 && state.hit?.height >= 44 - .5)) failures.push(`${label}: the action's hit area is 44 px: ${JSON.stringify(state.hit)}`);
          for (const control of ['send', 'mic']) {
            if (!(state[control]?.width > 0 && state[control]?.height > 0)) failures.push(`${label}: ${control} positive box: ${JSON.stringify(state[control])}`);
            else if (state.hit && overlap(state.hit, state[control]) > .5) failures.push(`${label}: the action's hit area stays off ${control}: ${JSON.stringify({ hit: state.hit, [control]: state[control] })}`);
          }
          if (!ref) { ref = { label, state, spot }; if (textName === 'short') await capture(page, `r2-${label}-pending`, state); continue; }
          if (textName === 'short') await capture(page, `r2-${label}-pending`, state);
          for (const key of ['right', 'bottom']) if (Math.abs(spot[key] - ref.spot[key]) > .5) failures.push(`${label}: the action ends row 2 at one spot (${key}): ${ref.spot[key]} (${ref.label}) -> ${spot[key]}`);
          failures.push(...sameBoxFailures(`${label} vs ${ref.label}`, ref.state, state).filter(f => !/: dock keeps/u.test(f)));
          if (Math.abs(line.y - ref.state.line.y) > .5) failures.push(`${label}: the consent line keeps its top: ${ref.state.line.y} -> ${line.y}`);
        }
        // Pending → granted (the last mount: DE, the short action, the 72-letter word inside the stock text).
        const granted = await grant(page);
        await capture(page, `r2-${last.label}-granted`, granted);
        failures.push(...sameBoxFailures(`granted vs ${ref?.label}`, ref?.state ?? {}, granted).filter(f => !/: dock keeps/u.test(f)));
        if (!(granted.reason?.width > 0 && granted.reason?.height > 0)) failures.push(`the granted line positive box: ${JSON.stringify(granted.reason)}`);
        else if (ref && Math.abs(granted.reason.y - ref.state.line.y) > .5) failures.push(`the granted line is top-aligned in the same two rows: ${granted.reason.y} vs ${ref.state.line.y}`);
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
        // r2 (Codex CLAMP Medium): desktop behaves as main: its reserve keeps
        // main's two-line cap (.composer-reason max-height 2.6em = 2 × 1.3), so a
        // long sentence cannot hold a third line in the dock after consent.
        if (!(state.reserve?.width > 0 && state.reserve?.height > 0 && state.reserveLineHeight > 0)) failures.push(`the desktop consent reserve positive box: ${JSON.stringify({ reserve: state.reserve, lineHeight: state.reserveLineHeight })}`);
        else if (state.reserve.height > 2 * state.reserveLineHeight + .5) failures.push(`the desktop reserve keeps main's two-line cap: ${state.reserve.height} > 2 × ${state.reserveLineHeight}`);
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

// r3, TICK k1: the phone keyboard (workspace[data-phone-keyboard]) is up.
// - Consent pending: the consent line is ONE row; the stock short reason
//   (featureConsent.textNarrow) starts it and the action ends it at the inline
//   end; never the action alone; the host text is hidden; the action's
//   accessible description is unchanged (the host sentence, once).
// - Consent granted: the consent row takes 0 px (no reserve under the field).
// - Within the keyboard-up state nothing moves while the field grows.
// The keyboard is emulated as in AIT-511/513 (touch, a shorter visual viewport, focus in the field).
const KEYBOARD = [[320, 568, 308], [390, 844, 420]];
const keyboardUp = (page, height) => page.evaluate(height => {
  globalThis.k1Viewport ??= visualViewport; globalThis.k1Touch ??= Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints') ?? null;
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
  const viewport = new EventTarget(); Object.assign(viewport, { height, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').focus({ preventScroll: true });
  window.dispatchEvent(new Event('resize'));
}, height);
const typeLines = (page, lines) => page.$eval('aithema-session', (c, lines) => {
  const input = c.shadowRoot.querySelector('textarea'); input.value = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, lines);
const settleLong = page => page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const keyboardState = c => {
  const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const rect = n => (n && n.checkVisibility() ? box(n) : null);
  const line = root.querySelector('.composer-reason[data-consent-feature="text"]');
  const feedback = root.querySelector('.composer-feedback'), action = line?.querySelector('.consent-action');
  const shown = n => [...n.querySelectorAll('*')].filter(e => e.checkVisibility() && !e.children.length);
  const textRects = node => { const rects = []; const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement.checkVisibility()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const b of range.getClientRects()) if (b.width > .5 && b.height > .5) rects.push({ x: b.x, y: b.y, width: b.width, height: b.height }); }
    return rects; };
  let hit = null;
  if (action?.checkVisibility()) {
    const after = getComputedStyle(action, '::after'), a = action.getBoundingClientRect();
    if (after.content !== 'none' && after.display !== 'none') {
      const w = parseFloat(after.width), h = parseFloat(after.height), m = new DOMMatrixReadOnly(after.transform === 'none' ? undefined : after.transform);
      const x = after.left !== 'auto' ? a.x + action.clientLeft + parseFloat(after.left) : a.x + action.clientLeft + action.clientWidth - parseFloat(after.right) - w;
      const y = after.top !== 'auto' ? a.y + action.clientTop + parseFloat(after.top) : a.y + action.clientTop + action.clientHeight - parseFloat(after.bottom) - h;
      hit = { x: x + m.m41, y: y + m.m42, width: w, height: h };
    }
  }
  const label = line?.querySelector('.consent-line-copy');
  // r4: the reason's own box (it may ellipsize) and the action's natural width (it never shrinks).
  const labelBox = label ? { ...rect(label), scrollWidth: label.scrollWidth, clientWidth: label.clientWidth, textOverflow: getComputedStyle(label).textOverflow, whiteSpace: getComputedStyle(label).whiteSpace } : null;
  const actionWidths = action ? { scrollWidth: action.scrollWidth, clientWidth: action.clientWidth } : null;
  const description = action ? root.getElementById(action.getAttribute('aria-describedby') ?? '') : null;
  return {
    keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'),
    dock: rect(root.querySelector('.composer-dock')), composer: rect(root.querySelector('.composer')), field: rect(root.querySelector('textarea')),
    mic: rect(root.querySelector('.composer-mic')), send: rect(root.querySelector('.send')),
    feedback: rect(feedback), reserve: rect(root.querySelector('.composer-feedback-reserve')),
    line: line ? { box: rect(line), lineHeight: parseFloat(getComputedStyle(line).lineHeight) } : null,
    // The painted reason: every text node whose element is visible (a variant span holds its separator span).
    reason: label ? { text: (() => { let text = ''; const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) if (n.parentElement.checkVisibility()) text += n.textContent;
      return text.trim(); })(), rects: textRects(label) } : null,
    action: action ? { box: rect(action), text: shown(action).map(n => n.textContent).join('').trim() || action.textContent.trim(), rects: textRects(action) } : null,
    hit, description: description ? { id: description.id, text: description.textContent } : null, labelBox, actionWidths,
  };
};
const stableBoxes = (name, before, after, parts) => {
  const failures = [];
  for (const part of parts) {
    const a = part.split('.').reduce((o, k) => o?.[k], before), b = part.split('.').reduce((o, k) => o?.[k], after);
    if (!(a?.width > 0 && a?.height > 0 && b?.width > 0 && b?.height > 0)) { failures.push(`${name}: ${part} positive boxes: ${JSON.stringify([a, b])}`); continue; }
    for (const key of keys) if (Math.abs(a[key] - b[key]) > .5) failures.push(`${name}: ${part} keeps its ${key}: ${a[key]} -> ${b[key]}`);
  }
  return failures;
};
// r4, TICK M1: the action's accessible name, read from the accessibility tree.
const actionName_ = async page => {
  const opener = await page.$('aithema-session >>> .composer-reason[data-consent-feature="text"] .consent-action');
  const node = opener ? await page.accessibility.snapshot({ root: opener }) : null; await opener?.dispose();
  return node?.name ?? null;
};
// r4, TICK M1: a host action too long for the row beside the short reason.
// Long enough that the short reason must yield at 320 (narrow) and 390 (wide), short enough to fit the row.
const LONG_ACTION = { en: { action: 'Review and agree to sending your messages now…', actionNarrow: 'Review and agree to message sending' },
  de: { action: 'Verarbeitung prüfen und jetzt gleich zustimmen…', actionNarrow: 'Verarbeitung prüfen, zustimmen' } };
export async function consentKeyboardUpCheck(t) {
  const { open, grant, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-keyboard-up`;
    await t.test(name, async () => {
      const problems = [], failures = [], growth = [];
      for (const [actionName, action] of [...Object.entries(ACTIONS), ['long', () => LONG_ACTION[locale]], ['granted', ACTIONS.stock]]) {
        const label = `${name}-${actionName === 'granted' ? 'granted' : `pending-${actionName}-action`}`;
        const page = await open({ width, height, locale, consent: { ...action(), text: stock[locale].text } }, problems);
        try {
          const consent = await page.evaluate(() => globalThis.fixtureCopy.featureConsent);
          // r5 (Codex gatepra4 Low, evidence): grant first, so the keyboard-down
          // twin of "granted" shows the granted dock, not the pending one.
          if (actionName === 'granted') await grant(page);
          const down = await page.$eval('aithema-session', keyboardState);
          const downName = actionName === 'granted' ? null : await actionName_(page);
          // r4: the keyboard-down twin of every keyboard-up capture (TICK's label parity pairs).
          await capture(page, `r4-k1-${label}-down`, down);
          await keyboardUp(page, viewport); await settleLong(page);
          const up = await page.$eval('aithema-session', keyboardState);
          if (!up.keyboard) { failures.push(`${label}: the keyboard flag is set`); continue; }
          for (const part of ['dock', 'composer', 'field', 'mic', 'send']) if (!(up[part]?.width > 0 && up[part]?.height > 0)) failures.push(`${label}: ${part} positive box: ${JSON.stringify(up[part])}`);
          if (actionName === 'granted') {
            // 0 px: no consent row and no empty reserve under the field.
            if (up.line) failures.push(`${label}: no consent line after the grant`);
            if (up.feedback && up.feedback.height > .5) failures.push(`${label}: the consent row takes 0 px: ${JSON.stringify(up.feedback)}`);
          } else {
            const { line } = up;
            if (!(line?.box?.width > 0 && line?.box?.height > 0)) { failures.push(`${label}: the consent line positive box: ${JSON.stringify(line)}`); continue; }
            if (Math.abs(line.box.height - line.lineHeight) > .5) failures.push(`${label}: the consent line is one row: ${line.box.height} vs ${line.lineHeight}`);
            if (!(up.feedback?.height > 0) || up.feedback.height > line.lineHeight + .5) failures.push(`${label}: the consent row is one row: ${JSON.stringify(up.feedback)} vs ${line.lineHeight}`);
            // The stock short reason starts the row (never the action alone); the host text is hidden.
            if (up.reason?.text !== consent.textNarrow) failures.push(`${label}: the row starts with the stock short reason "${consent.textNarrow}": "${up.reason?.text}"`);
            if (!up.reason?.rects?.length) failures.push(`${label}: the short reason is painted`);
            if (up.reason?.text?.includes(consent.text)) failures.push(`${label}: the host text is hidden while the keyboard is up`);
            // r4, TICK M1: the keyboard never changes the action's label or name;
            // the label follows the width rule alone, as with the keyboard down.
            const expected = down.action?.text;
            if (!expected || up.action?.text !== expected) failures.push(`${label}: the action keeps its keyboard-down label "${expected}" and ends the row: "${up.action?.text}"`);
            if (width === 390 && expected !== consent.action) failures.push(`${label}: at 390 the action is the wide label "${consent.action}": "${expected}"`);
            const upName = await actionName_(page);
            if (!downName || upName !== downName) failures.push(`${label}: the accessible name is the same with the keyboard up: "${downName}" -> "${upName}"`);
            // The action never shrinks; the reason yields (one line, ellipsis).
            if (!(up.actionWidths?.clientWidth > 0) || up.actionWidths.scrollWidth > up.actionWidths.clientWidth + 1) failures.push(`${label}: the action never shrinks: ${JSON.stringify(up.actionWidths)}`);
            if (up.labelBox?.textOverflow !== 'ellipsis' || up.labelBox?.whiteSpace !== 'nowrap') failures.push(`${label}: the reason is one line with an ellipsis: ${JSON.stringify(up.labelBox)}`);
            if (up.labelBox && up.action?.box && up.labelBox.x + up.labelBox.width > up.action.box.x + .5) failures.push(`${label}: the reason's box ends before the action: ${JSON.stringify({ reason: up.labelBox, action: up.action.box })}`);
            if (actionName === 'long' && !(up.labelBox?.scrollWidth > up.labelBox?.clientWidth)) failures.push(`${label}: a long host action makes the reason yield (ellipsis): ${JSON.stringify(up.labelBox)}`);
            const a = up.action?.rects;
            if (a?.length !== 1 || !(a[0].width > 0 && a[0].height > 0)) failures.push(`${label}: the action is one painted box: ${JSON.stringify(a)}`);
            else {
              const middle = a[0].y + a[0].height / 2;
              if (middle < line.box.y || middle > line.box.y + line.box.height) failures.push(`${label}: the action is on the row: ${JSON.stringify({ a: a[0], line: line.box })}`);
              if (Math.abs(a[0].x + a[0].width - (line.box.x + line.box.width)) > 1) failures.push(`${label}: the action sits at the inline end: ${a[0].x + a[0].width} vs ${line.box.x + line.box.width}`);
              for (const r of up.reason?.rects ?? []) {
                if (!(r.width > 0 && r.height > 0)) failures.push(`${label}: reason text positive box`);
                if (Math.min(r.x + r.width, (up.labelBox?.x ?? 0) + (up.labelBox?.width ?? Infinity)) > a[0].x + .5) failures.push(`${label}: the reason ends before the action: ${JSON.stringify({ r, a: a[0] })}`);
                if (Math.abs((r.y + r.height / 2) - middle) > line.lineHeight / 2) failures.push(`${label}: the reason shares the action's row: ${JSON.stringify({ r, a: a[0] })}`);
              }
            }
            // The 44 px hit area, clear of Send and Mic.
            if (!(up.hit?.width >= 44 - .5 && up.hit?.height >= 44 - .5)) failures.push(`${label}: the action's hit area is 44 px: ${JSON.stringify(up.hit)}`);
            for (const control of ['send', 'mic']) if (up.hit && up[control] && overlap(up.hit, up[control]) > .5) failures.push(`${label}: the hit area stays off ${control}: ${JSON.stringify({ hit: up.hit, [control]: up[control] })}`);
            // The accessible description is unchanged: the host sentence.
            if (!up.description || up.description.text !== consent.text || up.description.id !== down.description?.id || up.description.text !== down.description?.text)
              failures.push(`${label}: the action's description is unchanged: ${JSON.stringify({ down: down.description, up: up.description })}`);
            const opener = await page.$('aithema-session >>> .composer-reason[data-consent-feature="text"] .consent-action');
            const node = opener ? await page.accessibility.snapshot({ root: opener }) : null; await opener?.dispose();
            if (node?.description !== consent.text) failures.push(`${label}: the accessible description is the host sentence: "${node?.description}"`);
          }
          await capture(page, `r3-k1-${label}`, up);
          // Typing: the field grows (to its cap); nothing else in the dock moves.
          await typeLines(page, 8); await settleLong(page);
          const typed = await page.$eval('aithema-session', keyboardState);
          if (!typed.keyboard) failures.push(`${label}: the keyboard stays up while typing`);
          // The field grows to its cap (layout.js ComposerSize): at most three lines
          // with the keyboard up (short), and the composer at most 40 % of the
          // visual viewport, never below the field's minimum (the cap is the
          // minimum when the composer's other rows already take that room).
          const chrome = up.composer.height - up.field.height, cap = Math.min(92.5, Math.max(up.field.height, .4 * viewport - chrome));
          if (!(typed.field?.height >= cap - 1)) failures.push(`${label}: the field grows to its cap: ${up.field?.height} -> ${typed.field?.height} (cap ${cap})`);
          if (typed.composer && typed.composer.height > Math.max(.4 * viewport, up.composer.height) + .5) failures.push(`${label}: the composer respects the visual viewport cap: ${typed.composer.height} > ${.4 * viewport}`);
          growth.push(`${label}: field ${up.field.height} -> ${typed.field?.height} (cap ${cap.toFixed(2)}), composer ${up.composer.height} -> ${typed.composer?.height} of ${.4 * viewport}`);
          failures.push(...stableBoxes(`${label} typing`, up, typed, ['mic', 'send', ...(up.line ? ['line.box', 'action.box'] : [])]));
          if (Math.abs((up.feedback?.height ?? 0) - (typed.feedback?.height ?? 0)) > .5) failures.push(`${label}: the consent row keeps its height while typing`);
          await capture(page, `r3-k1-${label}-typed`, typed);
        } finally { await page.close(); }
      }
      // The lane keeps lines with "Error:"; the growth numbers go to the log either way.
      t.diagnostic(`k1 growth: ${growth.join(' | ')}`);
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r4 (Codex KEYBOARD + A11Y): k1 holds on document- and image-enabled docks
// too. Pending: one row (no 3.75em / 44 px refusal floor). Granted with nothing
// staged: 0 px. A staged image keeps its row; a rate-limited document upload
// keeps its normal feedback row with Try again and Discard visible, unclipped
// and focusable while the keyboard is up (only an idle row collapses).
const intakeState = c => {
  const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const rect = n => (n && n.checkVisibility() ? box(n) : null);
  const line = root.querySelector('.composer-reason[data-consent-feature="text"]');
  const controls = [...root.querySelectorAll('.composer-feedback :is(.upload-retry, .upload-discard)')].map(n => ({
    cls: n.className, text: n.textContent.trim(), box: rect(n), visible: n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) }));
  return { keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'),
    composer: rect(root.querySelector('.composer')), field: rect(root.querySelector('textarea')), send: rect(root.querySelector('.send')),
    feedback: rect(root.querySelector('.composer-feedback')), images: rect(root.querySelector('.staged-images')),
    documentInput: root.querySelector('.composer').hasAttribute('data-document-input'), imageInput: root.querySelector('.composer').hasAttribute('data-image-input'),
    line: line ? { box: rect(line), lineHeight: parseFloat(getComputedStyle(line).lineHeight) } : null, controls,
    // r5: idle = the row holds nothing but the shortcut hint (no Saved, no control).
    idle: Boolean(root.querySelector('.composer-reason[data-shortcut]')) && !root.querySelector('.composer-feedback[data-saved]') && !root.querySelector('.composer-feedback :is(button, a, input)'),
    reasonState: { shortcut: root.querySelector('.composer-reason').hasAttribute('data-shortcut'), text: root.querySelector('.composer-reason').textContent } };
};
const focusable = (page, selector) => page.$eval('aithema-session', (c, selector) => {
  const n = c.shadowRoot.querySelector(selector); if (!n) return false; n.focus(); return c.shadowRoot.activeElement === n;
}, selector);
const mockIntake = page => page.evaluate(() => {
  const c = document.querySelector('aithema-session'), original = window.fetch.bind(window), schedule = window.setTimeout.bind(window);
  const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; canvas.getContext('2d').fillRect(0, 0, 1, 1);
  window.k1PNG = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0)); window.k1Seq = 0;
  // The retry wait runs at once (as in AIT-290's upload-retry case); a document upload is rate limited.
  window.setTimeout = (callback, delay, ...args) => schedule(callback, new Error().stack.includes('#waitForUploadRetry') ? 0 : delay, ...args);
  window.fetch = async (url, options = {}) => {
    const path = String(url);
    if (/\/uploads$/u.test(path)) {
      if (options.method !== 'POST') return new Response(null, { status: 503 });
      const files = options.body.getAll('files');
      if (files.some(file => file.type !== 'image/png')) return Response.json({ error: 'upload-rate-limit' }, { status: 429, headers: { 'Retry-After': '1' } });
      return Response.json({ events: files.map((file, index) => ({ sessionId: c.session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
        id: `k1-${++window.k1Seq}`, filename: file.name, kind: 'image', state: window.k1Ready ? 'staged-ready' : 'staged-pending', bytes: file.size, mediaType: 'image/png', at: new Date(0).toISOString() } })) }, { status: 202 });
    }
    if (/\/uploads\/[^/]+\/image$/u.test(path)) return new Response(window.k1PNG, { headers: { 'content-type': 'image/png' } });
    return original(url, options);
  };
});
export async function consentKeyboardIntakeCheck(t) {
  const { open, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) for (const intake of ['document', 'image']) {
    const name = `${width}x${height}-${locale}-${intake}-keyboard-up`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      for (const state of ['pending', 'granted', ...(intake === 'image' ? ['staged', 'staged-ready'] : ['rate-limited'])]) {
        const label = `${name}-${state}`;
        const page = await open({ width, height, locale, intake, granted: state !== 'pending', consent: { text: stock[locale].text } }, problems);
        try {
          await mockIntake(page);
          // r5: 'staged-ready' stages an image that is ready at once (no longer preparing).
          if (state === 'staged-ready') await page.evaluate(() => { window.k1Ready = true; });
          await keyboardUp(page, viewport); await settleLong(page);
          if (state.startsWith('staged')) {
            await page.$eval('aithema-session', c => { const transfer = new DataTransfer(); transfer.items.add(new File([window.k1PNG], 'k1.png', { type: 'image/png' }));
              c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer })); });
            await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-images:not([hidden]) .staged-image'), { timeout: 15_000 });
            // r5: ready (no longer preparing): the reason is the idle shortcut hint again.
            if (state === 'staged-ready') await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-shortcut]'), { timeout: 15_000 }).catch(() => {});
          }
          if (state === 'rate-limited') {
            await page.$eval('aithema-session', c => { const input = c.shadowRoot.querySelector('.attach-input'), transfer = new DataTransfer();
              transfer.items.add(new File(['Offers'], 'offers.txt', { type: 'text/plain' })); input.files = transfer.files; input.dispatchEvent(new Event('change')); });
            await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.upload-retry'), { timeout: 15_000 });
          }
          await settleLong(page);
          const up = await page.$eval('aithema-session', intakeState);
          if (!up.keyboard) { failures.push(`${label}: the keyboard flag is set`); continue; }
          if (intake === 'document' && !up.documentInput) failures.push(`${label}: the dock is document-enabled`);
          if (intake === 'image' && !up.imageInput) failures.push(`${label}: the dock is image-enabled`);
          for (const part of ['composer', 'field', 'send']) if (!(up[part]?.width > 0 && up[part]?.height > 0)) failures.push(`${label}: ${part} positive box: ${JSON.stringify(up[part])}`);
          // Nothing staged: no image reserve above the field (the short-phone image slot's padding).
          if (!state.startsWith('staged') && up.composer && up.field && up.field.y - up.composer.y > 12) failures.push(`${label}: no reserve above the field: ${up.field.y - up.composer.y} px`);
          if (state === 'pending') {
            if (!(up.line?.box?.width > 0 && up.line?.box?.height > 0)) failures.push(`${label}: the consent line positive box: ${JSON.stringify(up.line)}`);
            else if (!(up.feedback?.height > 0) || up.feedback.height > up.line.lineHeight + .5) failures.push(`${label}: the consent row is one row: ${JSON.stringify(up.feedback)} vs ${up.line.lineHeight}`);
          } else if (state === 'granted') {
            if (up.feedback && up.feedback.height > .5) failures.push(`${label}: nothing staged, the feedback row takes 0 px: ${JSON.stringify(up.feedback)}`);
          } else if (state.startsWith('staged')) {
            if (!(up.images?.width > 0 && up.images?.height > 0)) failures.push(`${label}: the staged image keeps its row: ${JSON.stringify(up.images)}`);
            else if (up.images.y + up.images.height > up.field.y + .5) failures.push(`${label}: the staged row sits above the field: ${JSON.stringify({ images: up.images, field: up.field })}`);
            // r5 (Codex gatepra4 Low, KEYBOARD): a READY staged image leaves no blank
            // feedback row under the field: the row holds only the shortcut hint, so it takes 0 px.
            if (state === 'staged-ready' && !up.idle) failures.push(`${label}: the staged image becomes ready (the row holds only the shortcut hint): ${JSON.stringify(up.reasonState)}`);
            else if (state === 'staged-ready' && up.feedback && up.feedback.height > .5) failures.push(`${label}: a ready staged image leaves no blank feedback row: ${JSON.stringify(up.feedback)}`);
          } else {
            if (up.controls.length !== 2) failures.push(`${label}: Try again and Discard are present: ${JSON.stringify(up.controls)}`);
            if (!(up.feedback?.width > 0 && up.feedback?.height > 0)) failures.push(`${label}: the feedback row keeps a positive box: ${JSON.stringify(up.feedback)}`);
            for (const control of up.controls) {
              if (!control.visible || !(control.box?.width > 0 && control.box?.height > 0)) { failures.push(`${label}: ${control.cls} visible with a positive box: ${JSON.stringify(control)}`); continue; }
              const f = up.feedback;
              if (!f || control.box.y < f.y - .5 || control.box.y + control.box.height > f.y + f.height + .5 || control.box.x < f.x - .5 || control.box.x + control.box.width > f.x + f.width + .5)
                failures.push(`${label}: ${control.cls} not clipped by its row: ${JSON.stringify({ control: control.box, feedback: f })}`);
            }
            for (const selector of ['.upload-retry', '.upload-discard']) if (!await focusable(page, selector)) failures.push(`${label}: ${selector} takes focus`);
          }
          await capture(page, `r4-k1-${label}`, up);
        } finally { await page.close(); }
      }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r5 (Codex gatepra4 Medium, A11Y): the keyboard-up collapse takes only a row
// that shows NOTHING but the shortcut hint. The visual Saved confirmation after
// a successful send stays visible and unclipped with the keyboard up, on plain,
// document- and image-enabled docks.
const savedState = c => {
  const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const feedback = root.querySelector('.composer-feedback'), saved = root.querySelector('.composer-saved');
  return { keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'), flag: feedback.hasAttribute('data-saved'),
    feedback: box(feedback), feedbackClip: getComputedStyle(feedback).clipPath, saved: box(saved), text: saved.textContent.trim(),
    visible: saved.checkVisibility({ visibilityProperty: true, opacityProperty: true }), field: box(root.querySelector('textarea')), viewport: innerWidth,
    dock: box(root.querySelector('.composer-dock')), mic: box(root.querySelector('.composer-mic')), send: box(root.querySelector('.send')),
    // r6: the idle hint is not painted in a kept (empty) row.
    reasonPainted: !feedback.hasAttribute('data-saved') && Boolean(root.querySelector('.composer-reason').textContent.trim())
      && root.querySelector('.composer-reason').checkVisibility({ visibilityProperty: true, opacityProperty: true }) && root.querySelector('.composer-reason').getBoundingClientRect().height > .5
      && getComputedStyle(feedback).clipPath === 'none' };
};
// r6: the keyboard closes (focus leaves the field, the visual viewport is whole again).
const keyboardDown = page => page.evaluate(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.k1Viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').blur();
  window.dispatchEvent(new Event('resize'));
});
export async function consentKeyboardSavedCheck(t) {
  const { open, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-keyboard-up-saved`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      for (const intake of [null, 'document', 'image']) {
        const label = `${name}-${intake ?? 'plain'}`;
        const page = await open({ width, height, locale, intake, granted: true, consent: { text: stock[locale].text } }, problems);
        try {
          await keyboardUp(page, viewport); await settleLong(page);
          await typeLines(page, 1); await settleLong(page);
          await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.send').click());
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback[data-saved]'), { timeout: 15_000 });
          await settle(page);
          const up = await page.$eval('aithema-session', savedState);
          if (!up.keyboard) { failures.push(`${label}: the keyboard flag is set`); continue; }
          const copy = await page.evaluate(() => (typeof globalThis.fixtureCopy.saved === 'string' ? globalThis.fixtureCopy.saved : null));
          if (!up.flag || !up.text || (copy && up.text !== copy)) failures.push(`${label}: Saved is painted: ${JSON.stringify({ flag: up.flag, text: up.text, copy })}`);
          if (!up.visible) failures.push(`${label}: Saved is visible`);
          for (const part of ['feedback', 'saved', 'field', 'send']) if (!(up[part]?.width > 0 && up[part]?.height > 0)) failures.push(`${label}: ${part} positive box: ${JSON.stringify(up[part])}`);
          if (up.feedbackClip !== 'none') failures.push(`${label}: the feedback row is not clipped: ${up.feedbackClip}`);
          const f = up.feedback, s = up.saved;
          if (s.y < f.y - .5 || s.y + s.height > f.y + f.height + .5 || s.x < f.x - .5 || s.x + s.width > f.x + f.width + .5)
            failures.push(`${label}: Saved lies inside its row: ${JSON.stringify({ saved: s, feedback: f })}`);
          if (s.x < -.5 || s.x + s.width > up.viewport + .5) failures.push(`${label}: Saved is on screen: ${JSON.stringify(s)}`);
          if (s.y < up.field.y + up.field.height - .5) failures.push(`${label}: Saved sits under the field: ${JSON.stringify({ saved: s, field: up.field })}`);
          await capture(page, `r5-k1-${label}`, up);
          // r6 (TICK r5 M1): with the keyboard up the feedback row only grows. Saved
          // clears itself 1.6 s after the send; its row stays (empty) and Send/Mic
          // do not move at +1.6 s nor at +3 s. Closing and reopening the keyboard
          // starts the row at 0 px again.
          await capture(page, `r6-saved-${label}-at-send`, up);
          await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback[data-saved]'), { timeout: 15_000 });
          await settleLong(page);
          const cleared = await page.$eval('aithema-session', savedState);
          await capture(page, `r6-saved-${label}-plus-1600ms`, cleared);
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1400))); await settleLong(page);
          const later = await page.$eval('aithema-session', savedState);
          await capture(page, `r6-saved-${label}-plus-3000ms`, later);
          for (const [when, state] of [['+1.6 s', cleared], ['+3 s', later]]) {
            if (!state.keyboard) failures.push(`${label} ${when}: the keyboard stays up`);
            if (state.flag || state.text) failures.push(`${label} ${when}: Saved has cleared: ${JSON.stringify({ flag: state.flag, text: state.text })}`);
            if (state.reasonPainted) failures.push(`${label} ${when}: the kept row is empty (no hint painted)`);
            failures.push(...stableBoxes(`${label} Saved ${when}`, up, state, ['mic', 'send', 'feedback', 'dock']));
          }
          await keyboardDown(page); await settleLong(page);
          const closed = await page.$eval('aithema-session', savedState);
          if (closed.keyboard) failures.push(`${label}: the keyboard closes`);
          await keyboardUp(page, viewport); await settleLong(page);
          const reopened = await page.$eval('aithema-session', savedState);
          if (!reopened.keyboard) failures.push(`${label}: the keyboard reopens`);
          for (const part of ['field', 'send', 'mic']) if (!(reopened[part]?.width > 0 && reopened[part]?.height > 0)) failures.push(`${label} reopened: ${part} positive box: ${JSON.stringify(reopened[part])}`);
          if (reopened.feedback.height > .5) failures.push(`${label}: after the keyboard closes and reopens the row starts at 0 px: ${JSON.stringify(reopened.feedback)}`);
          await capture(page, `r6-saved-${label}-reopened`, reopened);
        } finally { await page.close(); }
      }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r7 (TICK r6 M1 general rule, Codex gatepra6 Medium x2): with the keyboard
// up the feedback row only GROWS. Feedback that clears by itself (an image's
// "Preparing…" turning ready; Saved after its timer) leaves its row in place,
// empty, until the keyboard closes. (a) pending -> ready on an image-enabled
// dock, 390 EN/DE: Send/Mic identical at "Preparing…", at ready and at ready
// + 2 s. (b) Saved visible keyboard-down on a phone that is ALREADY compact,
// then the keyboard opens (no compact-mode change, so no composer render), then
// Saved clears: the row stays, Send/Mic identical at +1.6 s and +3 s.
const wait = (page, ms) => page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), ms);
export async function consentKeyboardSelfClearCheck(t) {
  const { open, capture } = await harness(t);
  const [width, height, viewport] = KEYBOARD[1];
  for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-keyboard-up-preparing-ready`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image', granted: true, consent: { text: stock[locale].text } }, problems);
      try {
        await mockIntake(page);
        await keyboardUp(page, viewport); await settleLong(page);
        await page.$eval('aithema-session', c => { const transfer = new DataTransfer(); transfer.items.add(new File([window.k1PNG], 'k1.png', { type: 'image/png' }));
          c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer })); });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-images:not([hidden]) .staged-image'), { timeout: 15_000 });
        await settleLong(page);
        const preparing = await page.$eval('aithema-session', savedState);
        const preparingText = await page.$eval('aithema-session', c => ({ shortcut: c.shadowRoot.querySelector('.composer-reason').hasAttribute('data-shortcut'),
          text: c.shadowRoot.querySelector('.composer-reason').textContent.trim(), pending: c.session.uploads.some(u => u.kind === 'image' && u.state === 'staged-pending') }));
        if (!preparing.keyboard) failures.push(`${name}: the keyboard flag is set`);
        if (!preparingText.pending || preparingText.shortcut || !preparingText.text) failures.push(`${name}: fixture: the image is preparing ("Preparing…" in the row): ${JSON.stringify(preparingText)}`);
        if (!(preparing.feedback?.width > 0 && preparing.feedback?.height > 0)) failures.push(`${name}: "Preparing…" takes its row: ${JSON.stringify(preparing.feedback)}`);
        await capture(page, `r7-preparing-${name}-preparing`, { ...preparing, reason: preparingText });
        await page.$eval('aithema-session', c => { const image = c.session.uploads.find(u => u.kind === 'image');
          c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } }); });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-shortcut]'), { timeout: 15_000 });
        await settleLong(page);
        const ready = await page.$eval('aithema-session', savedState);
        await capture(page, `r7-preparing-${name}-ready`, ready);
        await wait(page, 2000); await settleLong(page);
        const later = await page.$eval('aithema-session', savedState);
        await capture(page, `r7-preparing-${name}-ready-plus-2s`, later);
        for (const [when, state] of [['ready', ready], ['ready + 2 s', later]]) {
          if (!state.keyboard) failures.push(`${name} ${when}: the keyboard stays up`);
          if (state.reasonPainted) failures.push(`${name} ${when}: the kept row is empty (no hint painted)`);
          failures.push(...stableBoxes(`${name} Preparing -> ${when}`, preparing, state, ['mic', 'send', 'feedback', 'dock']));
        }
        await keyboardDown(page); await settleLong(page);
        await keyboardUp(page, viewport); await settleLong(page);
        const reopened = await page.$eval('aithema-session', savedState);
        if (!reopened.keyboard) failures.push(`${name}: the keyboard reopens`);
        if (reopened.feedback.height > .5) failures.push(`${name}: after the keyboard closes and reopens a ready image's row starts at 0 px: ${JSON.stringify(reopened.feedback)}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
  // (b) Already compact before the keyboard opens: 320x568 and 390x600.
  for (const [w, h, v] of [[320, 568, 308], [390, 600, 380]]) for (const locale of ['en', 'de']) {
    const name = `${w}x${h}-${locale}-compact-saved-then-keyboard`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width: w, height: h, locale, granted: true, consent: { text: stock[locale].text } }, problems);
      try {
        const compact = await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.workspace').hasAttribute('data-phone-short'));
        if (!compact) failures.push(`${name}: fixture: the phone is compact before the keyboard opens`);
        await typeLines(page, 1); await settleLong(page);
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.send').click());
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback[data-saved]'), { timeout: 15_000 });
        await keyboardUp(page, v); await settle(page);
        const up = await page.$eval('aithema-session', savedState);
        if (!up.keyboard) failures.push(`${name}: the keyboard flag is set`);
        if (!up.flag || !up.visible) failures.push(`${name}: fixture: Saved is still visible when the keyboard opens: ${JSON.stringify({ flag: up.flag, visible: up.visible })}`);
        await capture(page, `r7-compact-saved-${name}-keyboard-opened`, up);
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback[data-saved]'), { timeout: 15_000 });
        await settleLong(page);
        const cleared = await page.$eval('aithema-session', savedState);
        await capture(page, `r7-compact-saved-${name}-cleared`, cleared);
        await wait(page, 1400); await settleLong(page);
        const later = await page.$eval('aithema-session', savedState);
        await capture(page, `r7-compact-saved-${name}-plus-3000ms`, later);
        for (const [when, state] of [['Saved cleared', cleared], ['+3 s', later]]) {
          if (!state.keyboard) failures.push(`${name} ${when}: the keyboard stays up`);
          if (state.reasonPainted) failures.push(`${name} ${when}: the kept row is empty (no hint painted)`);
          failures.push(...stableBoxes(`${name} ${when}`, up, state, ['mic', 'send', 'feedback', 'dock']));
        }
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r6 (Codex gatepra5 Medium, TICK M1 rule): a host action that EXACTLY fits the
// keyboard-down row (within the old .35em gap) is not ellipsized with the
// keyboard up: once the reason has yielded to 0 the gap goes too and the action
// gets the whole row. Read from the visible span's PAINTED text (its text run
// against the span's own box), not the button box.
const fitState = c => {
  const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const line = root.querySelector('.composer-reason[data-consent-feature="text"]'), action = line?.querySelector('.consent-action');
  const span = action ? [...action.children].find(n => n.checkVisibility()) : null;
  const range = document.createRange(); if (span) range.selectNodeContents(span);
  const runs = span ? [...range.getClientRects()].filter(r => r.width > .5 && r.height > .5).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) : [];
  return { keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'), line: line ? box(line) : null, action: action ? box(action) : null,
    span: span ? { ...box(span), text: span.textContent, scrollWidth: span.scrollWidth, clientWidth: span.clientWidth, textOverflow: getComputedStyle(span).textOverflow,
      gap: .35 * parseFloat(getComputedStyle(span).fontSize) } : null, runs,
    dock: box(root.querySelector('.composer-dock')), mic: box(root.querySelector('.composer-mic')), send: box(root.querySelector('.send')) };
};
// Builds, in the page, a label whose painted width is within (row - gap, row - .25].
const fittingLabel = (c, prefix) => {
  const line = c.shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'), action = line.querySelector('.consent-action');
  const span = [...action.children].find(n => n.checkVisibility()), row = line.getBoundingClientRect().width;
  const probe = span.cloneNode(false); probe.removeAttribute('class'); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto;max-width:none;overflow:visible';
  span.parentNode.append(probe);
  const width = text => { probe.textContent = text; const range = document.createRange(); range.selectNodeContents(probe); return range.getBoundingClientRect().width; };
  const max = row - .25;
  // Letters first, then thin and hair spaces in the middle (never trailing: they would hang).
  const make = (body, mid) => `${prefix}${mid} ${body}k`;
  let body = '', mid = '';
  for (const ch of 'mwnoeaskrtifl') for (let i = 0; i < 200 && width(make(body + ch, mid)) <= max; i++) body += ch;
  for (const ch of [' ', ' ']) for (let i = 0; i < 40 && width(make(body, mid + ch)) <= max; i++) mid += ch;
  const label = make(body, mid), measured = width(label); probe.remove();
  return { label, measured, row };
};
export async function consentKeyboardFitActionCheck(t) {
  const { open, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-fitting-action`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const probePage = await open({ width, height, locale, consent: { text: stock[locale].text } }, problems);
      let fit;
      try { fit = await probePage.$eval('aithema-session', fittingLabel, locale === 'de' ? 'Jetzt' : 'Agree'); } finally { await probePage.close(); }
      const page = await open({ width, height, locale, consent: { action: fit.label, actionNarrow: fit.label, text: stock[locale].text } }, problems);
      try {
        const painted = (state, mode) => {
          const label = `${name}-${mode}`, { span, runs, line } = state;
          if (!(line?.width > 0 && line?.height > 0)) { failures.push(`${label}: the consent line positive box: ${JSON.stringify(line)}`); return; }
          if (!(span?.width > 0 && span?.height > 0)) { failures.push(`${label}: the visible label positive box: ${JSON.stringify(span)}`); return; }
          if (span.text !== fit.label) failures.push(`${label}: the visible label is the host label: "${span.text}"`);
          if (runs.length !== 1 || !(runs[0].width > 0 && runs[0].height > 0)) { failures.push(`${label}: the label is one painted run: ${JSON.stringify(runs)}`); return; }
          // Painted whole: the text run ends inside the span's own (clipping) box.
          if (runs[0].x < span.x - .5 || runs[0].x + runs[0].width > span.x + span.width + .5) failures.push(`${label}: the label is painted whole (no ellipsis): ${JSON.stringify({ run: runs[0], span: { x: span.x, width: span.width }, scrollWidth: span.scrollWidth, clientWidth: span.clientWidth })}`);
        };
        const down = await page.$eval('aithema-session', fitState);
        // The fixture is near-fitting: wider than the row minus the old .35em gap.
        if (!(down.runs[0]?.width > down.line.width - down.span.gap && down.runs[0]?.width <= down.line.width)) failures.push(`${name}: fixture: the label nearly fills the keyboard-down row: ${JSON.stringify({ run: down.runs[0], row: down.line?.width, gap: down.span?.gap, fit })}`);
        painted(down, 'keyboard-down');
        await capture(page, `r6-fit-${name}-down`, down);
        await keyboardUp(page, viewport); await settleLong(page);
        const up = await page.$eval('aithema-session', fitState);
        if (!up.keyboard) failures.push(`${name}: the keyboard flag is set`);
        painted(up, 'keyboard-up');
        if (up.line && down.line && Math.abs(up.line.width - down.line.width) > .5) t.diagnostic(`${name}: row width down ${down.line.width} vs up ${up.line.width}`);
        await capture(page, `r6-fit-${name}-up`, up);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r8 (Codex gatepra7 Medium, TICK r7 binding): the kept row holds the LARGEST
// height it had since the latch. (a) 320 EN/DE, keyboard up: a two-line notice
// in the row (a two-line "Preparing…" copy) clears (the image turns ready):
// Send/Mic/row/dock identical at ready and ready + 2 s; after the keyboard
// closes and reopens the row starts at 0 px with no held height. (b) Codex
// gatepra7 Low: discarding a pending image with the keyboard up, with a
// viewport paint before the withdrawal acknowledgment, leaves no kept row.
// r8b: four lines, taller than the image dock's 44 px row (two lines fit inside it).
const twoLine = { en: 'Preparing your image. This takes a moment, you can keep typing meanwhile. Your text stays as it is and is sent together with the image once it is ready.', de: 'Dein Bild wird vorbereitet. Das dauert einen Moment, du kannst weiterschreiben. Dein Text bleibt erhalten und geht zusammen mit dem Bild hinaus, sobald es bereit ist.' };
const pasteImage = page => page.$eval('aithema-session', c => { const transfer = new DataTransfer(); transfer.items.add(new File([window.k1PNG], 'k1.png', { type: 'image/png' }));
  c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer })); });
const rowState = c => { const feedback = c.shadowRoot.querySelector('.composer-feedback'), reason = feedback.querySelector(':scope > .composer-reason');
  // r8b: an EMPTY kept row: kept while it shows nothing (no Saved, only the idle hint, no control).
  const empty = feedback.hasAttribute('data-keyboard-kept') && !feedback.hasAttribute('data-saved') && Boolean(reason?.matches('[data-shortcut],:empty')) && !feedback.querySelector('button, a, input, [tabindex]');
  return { kept: feedback.hasAttribute('data-keyboard-kept'), empty, minHeight: feedback.style.minHeight, lineHeight: parseFloat(getComputedStyle(reason).lineHeight) || 1.4 * parseFloat(getComputedStyle(reason).fontSize),
    reasonHeight: reason.getBoundingClientRect().height, text: reason.textContent.trim(), images: c.shadowRoot.querySelectorAll('.staged-images:not([hidden]) .staged-image').length }; };
export async function consentKeyboardKeptHeightCheck(t) {
  const { open, capture } = await harness(t);
  const [width, height, viewport] = KEYBOARD[0];
  for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-keyboard-up-two-line-clears`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image', granted: true, consent: { text: stock[locale].text }, copy: { imagePreparing: twoLine[locale] } }, problems);
      try {
        await mockIntake(page);
        await keyboardUp(page, viewport); await settleLong(page);
        await pasteImage(page);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-images:not([hidden]) .staged-image'), { timeout: 15_000 });
        await settleLong(page);
        const shown = await page.$eval('aithema-session', savedState), shownRow = await page.$eval('aithema-session', rowState);
        if (!shown.keyboard) failures.push(`${name}: the keyboard flag is set`);
        if (!(shown.feedback?.width > 0 && shown.feedback?.height > 0)) failures.push(`${name}: the notice takes its row: ${JSON.stringify(shown.feedback)}`);
        if (!(shownRow.reasonHeight > 2.5 * shownRow.lineHeight && shown.feedback?.height > 44.5)) failures.push(`${name}: fixture: the notice wraps to more lines than the 44 px row holds: ${JSON.stringify({ row: shownRow, feedback: shown.feedback })}`);
        await capture(page, `r8-two-line-${name}-shown`, { ...shown, row: shownRow });
        await page.$eval('aithema-session', c => { const image = c.session.uploads.find(u => u.kind === 'image');
          c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } }); });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-shortcut]'), { timeout: 15_000 });
        await settleLong(page);
        const cleared = await page.$eval('aithema-session', savedState);
        await capture(page, `r8-two-line-${name}-cleared`, { ...cleared, row: await page.$eval('aithema-session', rowState) });
        await wait(page, 2000); await settleLong(page);
        const later = await page.$eval('aithema-session', savedState);
        await capture(page, `r8-two-line-${name}-cleared-plus-2s`, later);
        for (const [when, state] of [['cleared', cleared], ['cleared + 2 s', later]]) {
          if (!state.keyboard) failures.push(`${name} ${when}: the keyboard stays up`);
          if (state.reasonPainted) failures.push(`${name} ${when}: the kept row is empty (no hint painted)`);
          failures.push(...stableBoxes(`${name} two-line notice -> ${when}`, shown, state, ['mic', 'send', 'feedback', 'dock']));
        }
        await keyboardDown(page); await settleLong(page);
        await keyboardUp(page, viewport); await settleLong(page);
        const reopened = await page.$eval('aithema-session', savedState), reopenedRow = await page.$eval('aithema-session', rowState);
        if (!reopened.keyboard) failures.push(`${name}: the keyboard reopens`);
        if (reopened.feedback.height > .5 || reopenedRow.kept || reopenedRow.minHeight) failures.push(`${name}: after the keyboard closes and reopens the row starts at 0 px with no held height: ${JSON.stringify({ feedback: reopened.feedback, row: reopenedRow })}`);
        await capture(page, `r8-two-line-${name}-reopened`, reopened);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
  for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-keyboard-up-discard-pending`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image', granted: true, consent: { text: stock[locale].text } }, problems);
      try {
        await mockIntake(page);
        // The withdrawal acknowledgment waits until the test releases it.
        await page.evaluate(() => { const c = document.querySelector('aithema-session'), previous = window.fetch;
          window.fetch = async (url, options) => {
            if (!/\/withdraw$/u.test(String(url))) return previous(url, options);
            await new Promise(resolve => { window.k1Withdraw = resolve; });
            const image = c.session.uploads.find(u => u.kind === 'image');
            return Response.json({ event: { sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'withdrawn' } } });
          }; });
        await keyboardUp(page, viewport); await settleLong(page);
        await pasteImage(page);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-images:not([hidden]) .staged-image'), { timeout: 15_000 });
        await settleLong(page);
        const pending = await page.$eval('aithema-session', rowState);
        if (!pending.kept || !pending.text) failures.push(`${name}: fixture: "Preparing…" is shown and its row kept: ${JSON.stringify(pending)}`);
        await capture(page, `r8-discard-${name}-preparing`, { ...await page.$eval('aithema-session', savedState), row: pending });
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.staged-image__remove').click());
        // A viewport paint before the acknowledgment (the still-visible "Preparing…").
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const between = await page.$eval('aithema-session', rowState);
        await capture(page, `r8-discard-${name}-before-ack`, { ...await page.$eval('aithema-session', savedState), row: between });
        // r8c: the discard's release holds while the discarded "Preparing…" is still painted (no re-latch on it).
        if (between.kept || between.minHeight) failures.push(`${name}: a viewport paint before the acknowledgment does not latch the discarded content again: ${JSON.stringify(between)}`);
        await page.waitForFunction(() => typeof window.k1Withdraw === 'function', { timeout: 15_000 });
        await page.evaluate(() => window.k1Withdraw());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.staged-images:not([hidden]) .staged-image'), { timeout: 15_000 });
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const after = await page.$eval('aithema-session', savedState), afterRow = await page.$eval('aithema-session', rowState);
        await capture(page, `r8-discard-${name}-after-ack`, { ...after, row: afterRow });
        if (!after.keyboard) failures.push(`${name}: the keyboard stays up`);
        if (afterRow.images) failures.push(`${name}: the image is discarded`);
        // r8b: after the ack the row may be kept and hold its own rendered height (it shows the consent line); only a kept
        // row that shows nothing fails.
        if (afterRow.empty) failures.push(`${name}: no empty kept row after the discard:${JSON.stringify({ feedback: after.feedback, row: afterRow })}`);
        for (const part of ['field', 'send', 'mic']) if (!(after[part]?.width > 0 && after[part]?.height > 0)) failures.push(`${name}: ${part} positive box: ${JSON.stringify(after[part])}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r7 (TICK r6 L1): with the keyboard up the reason never shows a stub like
// "E…": once the room left for it is narrower than three of its characters
// plus the ellipsis it drops out entirely (the action carries the meaning; the
// full sentence is in the sheet). Read from the painted text: a visible text
// run inside the reason implies room for at least three characters + "…".
const reasonState = c => {
  const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const copy = root.querySelector('.composer-reason[data-consent-feature="text"] > .consent-line-copy');
  if (!copy) return { copy: null };
  const reasonBox = box(copy), runs = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.textContent.trim() || !n.parentElement.checkVisibility()) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      const left = Math.max(r.x, reasonBox.x), right = Math.min(r.x + r.width, reasonBox.x + reasonBox.width);
      if (r.height > .5 && right - left > .5) runs.push({ left, right });
    }
  }
  // Measured with a probe in the row's font, independent of whether the reason is painted.
  const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
  copy.parentNode.append(probe);
  const sample = (copy.querySelector('.consent-narrow')?.textContent || copy.textContent).trim();
  probe.textContent = sample.slice(0, 3); const three = sample.length >= 3 ? probe.getBoundingClientRect().width : null;
  probe.textContent = '…'; const ellipsis = probe.getBoundingClientRect().width; probe.remove();
  return { keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'), copy: reasonBox, runs, three, ellipsis, text: copy.textContent,
    line: box(copy.parentNode), dock: box(root.querySelector('.composer-dock')), send: box(root.querySelector('.send')), mic: box(root.querySelector('.composer-mic')) };
};
export async function consentKeyboardReasonDropCheck(t) {
  const { open, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-reason-drop`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const probePage = await open({ width, height, locale, consent: { text: stock[locale].text } }, problems);
      let fit;
      try { fit = await probePage.$eval('aithema-session', fittingLabel, locale === 'de' ? 'Jetzt' : 'Agree'); } finally { await probePage.close(); }
      const page = await open({ width, height, locale, consent: { action: fit.label, actionNarrow: fit.label, text: stock[locale].text } }, problems);
      try {
        await keyboardUp(page, viewport); await settleLong(page);
        const up = await page.$eval('aithema-session', reasonState);
        if (!up.keyboard) failures.push(`${name}: the keyboard flag is set`);
        if (!up.copy) failures.push(`${name}: the consent line is present`);
        else {
          for (const part of ['line', 'dock', 'send', 'mic']) if (!(up[part]?.width > 0 && up[part]?.height > 0)) failures.push(`${name}: ${part} positive box: ${JSON.stringify(up[part])}`);
          if (!(up.three > 0 && up.ellipsis > 0)) failures.push(`${name}: fixture: three characters and the ellipsis measure: ${JSON.stringify({ three: up.three, ellipsis: up.ellipsis })}`);
          else if (up.runs.length && up.copy.width < up.three + up.ellipsis - .5)
            failures.push(`${name}: the reason drops out below three characters (no stub): ${JSON.stringify({ reason: up.copy.width, three: up.three, ellipsis: up.ellipsis, runs: up.runs })}`);
        }
        await capture(page, `r7-reason-drop-${name}`, up);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// r5 (Codex gatepra4 Medium, TICK M1 safety net): a host action label WIDER
// than the row. The reason yields to 0, the action is capped at the row with an
// ellipsis (never offscreen, never wrapping the dock taller), and its
// accessible name stays the full label (the visible text is its prefix).
// Keyboard down and up alike.
const OVERWIDE = { en: 'Review and agree to sending all of your messages, documents and images to the assistant right now',
  de: 'Die Verarbeitung aller Nachrichten, Dokumente und Bilder durch den Assistenten jetzt prüfen und zustimmen' };
export async function consentKeyboardWideActionCheck(t) {
  const { open, capture } = await harness(t);
  for (const [width, height, viewport] of KEYBOARD) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-overwide-action`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const full = OVERWIDE[locale];
      const page = await open({ width, height, locale, consent: { action: full, actionNarrow: full, text: stock[locale].text } }, problems);
      try {
        const check = async (state, mode) => {
          const label = `${name}-${mode}`;
          for (const part of ['dock', 'composer', 'field', 'send']) if (!(state[part]?.width > 0 && state[part]?.height > 0)) failures.push(`${label}: ${part} positive box: ${JSON.stringify(state[part])}`);
          const { line, action, feedback } = state;
          if (!(line?.box?.width > 0 && line?.box?.height > 0)) { failures.push(`${label}: the consent line positive box: ${JSON.stringify(line)}`); return; }
          if (!(action?.box?.width > 0 && action?.box?.height > 0)) { failures.push(`${label}: the action positive box: ${JSON.stringify(action)}`); return; }
          // Nothing offscreen; the action box stays inside the row.
          if (action.box.x < -.5 || action.box.x + action.box.width > width + .5) failures.push(`${label}: the action is on screen: ${JSON.stringify(action.box)}`);
          if (action.box.x < line.box.x - .5 || action.box.x + action.box.width > line.box.x + line.box.width + .5) failures.push(`${label}: the action box is at most the row: ${JSON.stringify({ action: action.box, line: line.box })}`);
          // A text run's range rect is its unclipped layout; the painted part is
          // that run inside the visible span's overflow box (text-overflow clips there).
          const clip = state.actionText?.clip;
          if (!(clip?.width > 0 && clip?.height > 0) || state.actionText.overflowX !== 'hidden') failures.push(`${label}: the visible label clips at a positive box: ${JSON.stringify(state.actionText)}`);
          else for (const r of action.rects) {
            const left = Math.max(r.x, clip.x), right = Math.min(r.x + r.width, clip.x + clip.width);
            if (!(right > left)) failures.push(`${label}: the action text is painted: ${JSON.stringify({ r, clip })}`);
            else if (left < -.5 || right > width + .5) failures.push(`${label}: no action text offscreen: ${JSON.stringify({ left, right, clip })}`);
          }
          // One line: the action never wraps the dock taller.
          if (action.box.height > line.lineHeight + .5) failures.push(`${label}: the action is one line: ${action.box.height} vs ${line.lineHeight}`);
          if (new Set(action.rects.map(r => Math.round(r.y))).size > 1) failures.push(`${label}: the action's text is one line: ${JSON.stringify(action.rects)}`);
          // The visible text is a prefix of the full label (an ellipsis ends it).
          if (!state.actionEllipsis) failures.push(`${label}: the action ends with an ellipsis: ${JSON.stringify(state.actionText)}`);
          const name_ = await actionName_(page);
          if (name_ !== full) failures.push(`${label}: the accessible name is the full label: "${name_}"`);
          if (!(feedback?.height > 0)) failures.push(`${label}: the feedback row positive box: ${JSON.stringify(feedback)}`);
          return name_;
        };
        const widthState = c => {
          const action = c.shadowRoot.querySelector('.composer-reason[data-consent-feature="text"] .consent-action');
          const shown = action ? [...action.children].find(n => n.checkVisibility()) : null;
          return { actionEllipsis: Boolean(shown && getComputedStyle(shown).textOverflow === 'ellipsis' && shown.scrollWidth > shown.clientWidth),
            actionText: shown ? { text: shown.textContent, scrollWidth: shown.scrollWidth, clientWidth: shown.clientWidth, overflow: getComputedStyle(shown).textOverflow,
              overflowX: getComputedStyle(shown).overflowX, clip: (({ x, y, width, height }) => ({ x, y, width, height }))(shown.getBoundingClientRect()) } : null };
        };
        const down = { ...await page.$eval('aithema-session', keyboardState), ...await page.$eval('aithema-session', widthState) };
        const downName = await check(down, 'keyboard-down');
        await capture(page, `r5-k1-${name}-down`, down);
        await keyboardUp(page, viewport); await settleLong(page);
        const up = { ...await page.$eval('aithema-session', keyboardState), ...await page.$eval('aithema-session', widthState) };
        if (!up.keyboard) failures.push(`${name}: the keyboard flag is set`);
        const upName = await check(up, 'keyboard-up');
        if (downName !== upName) failures.push(`${name}: no name change keyboard down vs up: "${downName}" -> "${upName}"`);
        // The reason yields to 0 with the keyboard up.
        if (up.labelBox && up.labelBox.width > .5) failures.push(`${name}: the reason yields to 0: ${JSON.stringify(up.labelBox)}`);
        if (up.line?.box && Math.abs(up.line.box.height - up.line.lineHeight) > .5) failures.push(`${name}: the keyboard-up row is one row: ${JSON.stringify(up.line)}`);
        if (!(up.hit?.width >= 44 - .5 && up.hit?.height >= 44 - .5)) failures.push(`${name}: the action's hit area is 44 px: ${JSON.stringify(up.hit)}`);
        await capture(page, `r5-k1-${name}-up`, up);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}
