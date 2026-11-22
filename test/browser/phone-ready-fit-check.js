// AIT-603: phones (≤ 600 px), the combined entrance with the REAL image concept
// layout (visualsBound, as the AIT-601 check), at the ready stage. The welcome's
// clamp follows the space: whole lines, the largest count (at most the
// existing six, at least two) that keeps the label, the lines and the
// "Read full reply" link visible together with readiness in its one-row
// short-screen form. When even two lines and readiness do not fit, the scroll
// area scrolls with a soft bottom fade while content is below. The hand-off
// keeps the clamp, the welcome box and its first line; the dock does not move.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';
import { welcome } from './combined-image-opener-check.js';

// 360x740 is the "360x?" phone in TICK's capture list.
const viewports = [[390, 664], [375, 667], [320, 568], [360, 740], [430, 932]];
const cases = [];
for (const [width, height] of viewports) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark'])
  cases.push({ width, height, locale, theme, text: 100 });
// 390x664 at 125 % text size (the root font size the shadow styles' rem follows).
for (const locale of ['en', 'de']) cases.push({ width: 390, height: 664, locale, theme: 'light', text: 125 });
// START's dock (271 px on RC27 at 390x664) also reserves the image refusal row:
// with image input available the composer carries data-image-input and its
// feedback row keeps the 44 px image reserve (combined-entrance-styles.js), which
// adds the ~25 px between the plain fixture dock (246.61 px) and START's.
for (const locale of ['en', 'de']) cases.push({ width: 390, height: 664, locale, theme: 'light', text: 100, start: true });
// r2 (Codex READY-STAGE Medium): the ready stage fits with BOTH scrollbar
// modes of .conversation-scroll (scrollbar-gutter:stable). Every case above
// runs with a classic 15 px gutter (a desktop Chromium, the remote lane's
// default); these run again with an overlay scrollbar (0 px, as on phones).
// Each mode is set explicitly in the page, never left to the host's default.
for (const [width, height, locale, text] of [[320, 568, 'en', 100], [320, 568, 'de', 100], [360, 740, 'de', 100], [390, 664, 'en', 100], [390, 664, 'de', 125]])
  cases.push({ width, height, locale, theme: 'light', text, scrollbar: 'overlay' });
// r11: CI Linux's fallback sans is wider than macOS's, and DE readiness took a
// third row there. These cases run a wide font on every platform (Verdana on
// macOS, DejaVu Sans on Linux), so the readiness fit is proven with wide
// metrics wherever the suite runs, not only on the CI platform.
for (const [width, height, text] of [[320, 568, 100], [390, 664, 125]])
  cases.push({ width, height, locale: 'de', theme: 'light', text, font: 'wide' });
const FONTS = { wide: 'Verdana,"DejaVu Sans",sans-serif' };
const SCROLLBARS = {
  classic: '.conversation-scroll::-webkit-scrollbar { width:15px; height:15px; } .conversation-scroll::-webkit-scrollbar-thumb { background:#8888; }',
  overlay: '.conversation-scroll::-webkit-scrollbar { width:0; height:0; }',
};
const caseName = ({ width, height, locale, theme, text, start, longConsent, r4, scrollbar, font }) => `${width}x${height}-${locale}-${theme}${text === 100 ? '' : `-text${text}`}${start ? '-start' : ''}${longConsent ? '-longconsent' : ''}${r4 ? '-r4' : ''}${scrollbar === 'overlay' ? '-overlay' : ''}${font ? `-${font}` : ''}`;
const CAP = 6, MIN = 2;
const keys = ['x', 'y', 'width', 'height'];
const positive = (label, box) => assert.ok(box && box.width > 0 && box.height > 0, `${label} positive box: ${JSON.stringify(box)}`);
// The lane summary keeps only lines with "Error:", so a failure names its reasons there (r2: the two unexplained r1 entries).
const none = (failures, label) => { if (failures.length) throw new Error(`${failures.join(' | ')} [${label}]`.slice(0, 1500)); };
const inside = (outer, inner) => inner.y >= outer.y - .5 && inner.y + inner.height <= outer.y + outer.height + .5;
// TICK M1: no "·" starts or ends a painted line of the one-row readiness, and
// a line that joins two runs of text still separates them.
function separatorFailures(lines) {
  if (!lines?.length) return [`the one-row readiness paints lines: ${JSON.stringify(lines)}`];
  const failures = [];
  for (const [i, line] of lines.entries()) {
    const words = line.map(item => item.kind === 'separator' ? '\u00b7' : item.text).join(' ');
    if (line[0].kind === 'separator') failures.push(`readiness line ${i + 1} starts with a separator: "${words}"`);
    if (line.at(-1).kind === 'separator') failures.push(`readiness line ${i + 1} ends with a separator: "${words}"`);
    const texts = line.filter(item => item.kind === 'text').length;
    if (texts > 1 && !line.some(item => item.kind === 'separator')) failures.push(`readiness line ${i + 1} keeps its separators: "${words}"`);
  }
  return failures;
}
// Codex M4: the reserve holds exactly the consent line the dock shows (same
// text at the same width and size), so its row cannot change height.
function reserveFailures({ line, reserve, feedback }) {
  if (!line) return [`the dock shows the consent line before consent: ${JSON.stringify({ reserve, feedback })}`];
  if (!(line.width > 0 && line.height > 0)) return [`consent line positive box: ${JSON.stringify(line)}`];
  const match = reserve.find(item => item.text === line.text);
  if (!match) return [`a reserve holds the visible consent line "${line.text}": ${JSON.stringify(reserve)}`];
  if (Math.abs(match.height - line.height) > .5) return [`the consent reserve has the visible line's height: ${match.height} vs ${line.height} (${line.fontSize}) "${line.text}"`];
  return [];
}
// AIT-603 r4 (TICK's cap, LEAD (a)): on phones the dock's text-consent line
// and its hidden reserve share one cap of two whole lines. Longer host copy
// clamps with "…"; the action stays whole at the end of the second line; the
// sheet the action opens shows the host's sentence in full. Granted: the
// shorter line sits top-aligned in the same reserve, so nothing moves.
const CONSENT_CAP = 2;
function capFailures(item, pending, natural) {
  const { line, label, action, consentReserve } = pending.consent, failures = [];
  if (!line || !(line.width > 0 && line.height > 0)) return [`the dock shows the consent line before consent: ${JSON.stringify(pending.consent)}`];
  // The natural wrap is long enough to need the cap (r4: at least four lines).
  if (!(natural >= (item.r4 ? 4 : 3))) failures.push(`the fixture consent copy wraps to ${item.r4 ? 4 : 3} or more lines unclamped: ${natural}`);
  const lines = line.height / line.lineHeight;
  if (Math.abs(lines - Math.round(lines)) > .05) failures.push(`the consent line shows whole lines: ${line.height} / ${line.lineHeight}`);
  if (Math.round(lines) > CONSENT_CAP) failures.push(`the consent line shows at most ${CONSENT_CAP} lines: ${lines.toFixed(2)} "${line.text}"`);
  // PR-A (LEAD: pure CSS): the host text clamps in its own box by CSS
  // line-clamp, which paints the "…"; the box overflows (it is clamped).
  const clamp = pending.consent.clamp;
  if (!(clamp?.lineClamp === '2' && clamp.overflows)) failures.push(`the host text clamps with "…" in its own two-line box: ${JSON.stringify(clamp)} "${label}"`);
  // The action: whole, inside the line, on its second line.
  if (!action?.rects?.length) failures.push(`the consent action is painted: ${JSON.stringify(action)}`);
  for (const box of action?.rects ?? []) {
    const middle = box.y + box.height / 2 - line.y;
    if (!(box.width > 0 && box.height > 0)) failures.push(`consent action text positive box: ${JSON.stringify(box)}`);
    if (box.x < line.x - .5 || box.x + box.width > line.x + line.width + .5) failures.push(`the consent action is whole inside the line: ${JSON.stringify({ box, line })}`);
    if (!(middle > line.lineHeight && middle < 2 * line.lineHeight)) failures.push(`the consent action sits on the second line: ${JSON.stringify({ box, line })}`);
  }
  if (action?.text && !line.text.endsWith(action.text)) failures.push(`the action ends the line: "${line.text}" / "${action.text}"`);
  // One shared cap: the reserve is the capped visible line.
  if (!(consentReserve?.width > 0 && consentReserve?.height > 0)) failures.push(`the consent reserve positive box: ${JSON.stringify(consentReserve)}`);
  else if (Math.abs(consentReserve.height - line.height) > .5) failures.push(`the consent reserve is the capped line: ${consentReserve.height} vs ${line.height}`);
  // The dock keeps Send on screen and the conversation keeps its area.
  const send = pending.send;
  if (!(send?.width > 0 && send?.height > 0) || send.x < -.5 || send.y < -.5 || send.x + send.width > item.width + .5 || send.y + send.height > item.height + .5)
    failures.push(`Send inside the viewport: ${JSON.stringify(send)} in ${item.width}x${item.height}`);
  if (!(pending.scroll?.height > 0 && pending.clientHeight > 0)) failures.push(`the conversation area stays: ${JSON.stringify({ scroll: pending.scroll, client: pending.clientHeight })}`);
  return failures;
}
// The natural line count of the visible consent copy (sentence, separator,
// action) laid out uncapped at the line's width and text metrics.
const naturalConsentLines = (page, narrow) => page.$eval('aithema-session', async (c, narrow) => {
  const { reasonSeparator } = await import('/packages/ui/src/reason-separator.js');
  const consent = globalThis.fixtureCopy.featureConsent, line = c.shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]');
  if (!line) return null;
  const style = getComputedStyle(line), probe = document.createElement('small'), action = document.createElement('button');
  probe.className = 'composer-reason'; probe.dataset.consentFeature = 'text';
  probe.style.cssText = `position:absolute;visibility:hidden;left:0;top:0;max-height:none;overflow:visible;width:${line.clientWidth}px;letter-spacing:${style.letterSpacing}`;
  action.className = 'consent-action'; action.type = 'button'; action.textContent = narrow ? consent.actionNarrow : consent.action;
  probe.append(`${narrow ? consent.textNarrow : consent.text}${reasonSeparator}`, action);
  line.parentElement.append(probe);
  const lines = probe.getBoundingClientRect().height / parseFloat(style.lineHeight); probe.remove();
  return Math.round(lines * 100) / 100;
}, narrow);
// Consent pending and granted, and a second configure(): at or below 340 px and
// above it, at 100 % and 125 % text.
const stateCases = [[320, 568], [360, 740], [390, 664], [430, 932]].flatMap(([width, height]) => ['en', 'de'].map(locale => ({ width, height, locale, theme: 'light', text: 100 })))
  .concat(['en', 'de'].map(locale => ({ width: 390, height: 664, locale, theme: 'light', text: 125 })))
  // Codex gate2c M4: a consent line of three or more lines (the locale's own
  // consent sentence three times, the short phone one five times, at a narrow
  // width and larger text). r4: these now take the two-line cap.
  // r2: the EN sentence is short ("Messages need your consent"): three times
  // wraps to only two natural lines at 390 px 125 %, so that case repeats it
  // four times (the r1 run's unexplained -states failure was this fixture check).
  .concat([[320, 568, 'en', 150, 3], [320, 568, 'de', 125, 3], [360, 740, 'de', 150, 3], [390, 664, 'en', 125, 4]]
    .map(([width, height, locale, text, longConsent]) => ({ width, height, locale, theme: 'light', text, longConsent })))
  // r4: TICK's capture set, 360/390 EN/DE with long host consent copy (the
  // locale's sentence eight times: four or more lines unclamped).
  .concat([[360, 740], [390, 664]].flatMap(([width, height]) => ['en', 'de'].map(locale => ({ width, height, locale, theme: 'light', text: 100, longConsent: 8, r4: true }))));

// The boxes of one frame, read in the page. Self-contained, so it also runs
// inside the page's own hand-off hook (Codex M3: the first live frame).
const boxesInPage = c => {
    const root = c.shadowRoot, workspace = root.querySelector('.workspace'), row = root.querySelector('[data-id="host:opener"]');
    const rect = node => { if (!node || !node.checkVisibility()) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const scroll = root.querySelector('.conversation-scroll'), text = row?.querySelector('.turn-text'), more = row?.querySelector('.host-opener-more');
    const ready = root.querySelector('.ready'), style = text ? getComputedStyle(text) : null;
    const range = document.createRange(); if (text) range.selectNodeContents(text);
    const first = text ? range.getClientRects()[0] : null;
    // The natural line count of the whole welcome, laid out once without the clamp.
    let naturalLines = null;
    if (text) {
      const probe = text.cloneNode(true); probe.style.cssText = 'display:block;-webkit-line-clamp:none;position:absolute;visibility:hidden;left:0;top:0';
      probe.style.width = `${text.clientWidth}px`; text.parentNode.append(probe);
      naturalLines = Math.round(probe.getBoundingClientRect().height / parseFloat(style.lineHeight)); probe.remove();
    }
    const dock = root.querySelector('.composer-dock'), shell = root.querySelector('.transcript-shell');
    const list = shell?.querySelector('ol')?.getBoundingClientRect(), pane = shell?.getBoundingClientRect();
    return { stage: workspace.dataset.stage, layout: workspace.dataset.conceptLayout, entrance: workspace.dataset.entrance,
      scroll: rect(scroll), gutter: scroll.offsetWidth - scroll.clientWidth, scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      fade: getComputedStyle(scroll).maskImage, fadeAttribute: scroll.hasAttribute('data-bottom'),
      // r11: a 0 px fade (no room below the link) serializes as "100%", not calc(100% - 0px).
      fadeLength: (() => { const mask = getComputedStyle(scroll).maskImage, match = /calc\(100% - ([\d.]+)px\)/u.exec(mask); return match ? Number(match[1]) : /\) 100%, /u.test(mask) ? 0 : null; })(),
      opener: rect(row), label: rect(row?.querySelector(':scope > strong')), text: rect(text), firstLine: first ? { x: first.x, y: first.y, width: first.width, height: first.height } : null,
      lineHeight: style ? parseFloat(style.lineHeight) : null, clamp: style ? style.webkitLineClamp : null, naturalLines,
      link: rect(more), linkText: more && !more.hidden ? more.textContent : null,
      ready: rect(ready), readyRoute: rect(root.querySelector('.ready__route')),
      routeText: root.querySelector('.ready__route')?.textContent ?? null,
      // The one-row part: title · consent state · Change settings (the route line is separate, RC26).
      readyRow: (() => { const boxes = ['.ready h3', '.ready__row[data-ready="consent"]', '.ready__actions'].map(selector => rect(root.querySelector(selector))).filter(Boolean);
        if (!boxes.length) return null; const top = Math.min(...boxes.map(b => b.y)); return { count: boxes.length, top, height: Math.max(...boxes.map(b => b.y + b.height)) - top }; })(),
      readyRows: [...root.querySelectorAll('.ready__row')].filter(node => node.checkVisibility()).map(node => node.dataset.ready),
      // TICK M1: the one-row readiness as painted lines: text runs (Range rects per
      // text node) and the visible "·" separators (generated content: the box from
      // the separator-bearing element's start edge to its first in-flow child).
      readyLines: (() => {
        if (!ready?.checkVisibility()) return null;
        const route = ready.querySelector('.ready__route'), segments = [];
        const solid = box => box.width > 1 && box.height > 1;
        // Visually hidden copy (the dt's 1 px clip) is not painted text.
        const clipped = element => { for (let n = element; n && n !== ready; n = n.parentElement) { const s = getComputedStyle(n); if (s.clipPath !== 'none' || s.visibility === 'hidden') return true; } return false; };
        for (const element of ready.querySelectorAll('*')) {
          if (route.contains(element) || !element.checkVisibility() || clipped(element)) continue;
          const before = getComputedStyle(element, '::before');
          if (!before.content.includes('\u00b7') || before.display === 'none' || before.visibility === 'hidden') continue;
          const box = element.getBoundingClientRect();
          const child = [...element.children].find(n => n.checkVisibility() && getComputedStyle(n).position !== 'absolute' && solid(n.getBoundingClientRect()));
          segments.push({ kind: 'separator', left: box.left, right: child ? child.getBoundingClientRect().left : box.right, top: box.top, bottom: box.bottom });
        }
        const walker = document.createTreeWalker(ready, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode());) {
          if (!n.textContent.trim() || route.contains(n) || !n.parentElement.checkVisibility() || clipped(n.parentElement)) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          for (const box of range.getClientRects()) if (solid(box)) segments.push({ kind: 'text', text: n.textContent.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom });
        }
        // Codex Low: a painted line is a line box: segments share a line when
        // their vertical extents overlap by more than half the shorter one
        // (no fixed pixel distance, so any text size and line height works).
        const lines = [];
        for (const segment of segments.sort((a, b) => a.top - b.top)) {
          const line = lines.find(l => Math.min(l.bottom, segment.bottom) - Math.max(l.top, segment.top) > Math.min(l.bottom - l.top, segment.bottom - segment.top) / 2);
          if (line) { line.items.push(segment); line.top = Math.min(line.top, segment.top); line.bottom = Math.max(line.bottom, segment.bottom); }
          else lines.push({ top: segment.top, bottom: segment.bottom, items: [segment] });
        }
        return lines.map(line => line.items.sort((a, b) => a.left - b.left).map(({ kind, text, left, right }) => ({ kind, text, left, right })));
      })(),
      // Codex M4: the dock's consent line and the reserve that holds its row.
      consent: (() => {
        // Painted text only: visually hidden copy (a 1 px clip) is not on screen.
        const clippedIn = (n, top) => { for (let e = n; e && e !== top.parentElement; e = e.parentElement) if (getComputedStyle(e).clipPath !== 'none') return true; return false; };
        const painted = element => { const words = []; const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) if (n.parentElement.checkVisibility() && !clippedIn(n.parentElement, element)) words.push(n.textContent); return words.join('').replace(/\s+/gu, ' ').trim(); };
        const line = root.querySelector('.composer-reason[data-consent-feature="text"]');
        const reserve = [...root.querySelectorAll('.composer-feedback-reserve > *')].filter(n => n.checkVisibility())
          .map(n => { const r = n.getBoundingClientRect(); return { text: painted(n), width: r.width, height: r.height }; });
        // r4: the host text part, the action's painted text boxes, and the consent reserve.
        const copy = line?.querySelector('.consent-line-copy'), action = line?.querySelector('.consent-action');
        const actionRects = []; if (action) { const walker = document.createTreeWalker(action, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement.checkVisibility() || clippedIn(n.parentElement, action)) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            for (const b of range.getClientRects()) if (b.width > 1 && b.height > 1) actionRects.push({ x: b.x, y: b.y, width: b.width, height: b.height }); } }
        return { line: line?.checkVisibility() ? { ...rect(line), text: painted(line), fontSize: getComputedStyle(line).fontSize, lineHeight: parseFloat(getComputedStyle(line).lineHeight) } : null,
          label: copy ? painted(copy) : null,
          clamp: copy ? { lineClamp: getComputedStyle(copy).webkitLineClamp, overflows: copy.scrollHeight > copy.clientHeight + 1 } : null, action: action ? { text: painted(action), rects: actionRects } : null,
          consentReserve: rect([...root.querySelectorAll('.composer-feedback-reserve > .composer-reserve-consent')].find(n => n.checkVisibility())),
          reserve, feedback: rect(root.querySelector('.composer-feedback')) };
      })(),
      // The live transcript: D511a's fit inputs (AIT-601 fold check) and the visitor turn.
      shell: rect(shell), shellScrollTop: shell?.scrollTop, shellClientHeight: shell?.clientHeight,
      contentEnd: list ? list.bottom + shell.scrollTop - pane.top : null, shellPaddingBottom: shell ? parseFloat(getComputedStyle(shell).paddingBottom) : null,
      visitor: rect([...(shell?.querySelectorAll('.turn.user') ?? [])].at(-1)),
      dock: rect(dock), attach: rect(root.querySelector('.attach')), composer: rect(root.querySelector('textarea')),
      mic: rect(root.querySelector('.composer-mic')), send: rect(root.querySelector('.send')),
      // Recorded for the look: the dock rows below the controls.
      dockRows: Object.fromEntries(['.composer-feedback', '.composer-reason', '.composer-status-slot', '.composer-notice-slot', '.composer-notice']
        .map(selector => [selector, { box: rect(root.querySelector(selector)), text: root.querySelector(selector)?.textContent ?? null }])) };
};
async function measure(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  return page.$eval('aithema-session', boxesInPage);
}

export async function phoneReadyFitCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-phone-ready-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, index = [], tickIndex = [];
  const open = async (page, { width, height, locale, theme, text, start, longConsent, scrollbar = 'classic', font }, problems) => {
    page.on('pageerror', error => problems.push(error.message));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(async (welcomeText, locale, size, start, longConsent, scrollbarStyle, fontFamily) => {
      document.documentElement.style.fontSize = `${size}%`;
      // r11: a wide font case sets the host's font before mount (the fits read its metrics).
      if (fontFamily) document.querySelector('aithema-session').style.setProperty('--aithema-font', fontFamily);
      // r2: the scroll area's scrollbar mode, before mount (the fit reads the width it leaves).
      const scrollbarSheet = new CSSStyleSheet(); scrollbarSheet.replaceSync(scrollbarStyle);
      const shadow = document.querySelector('aithema-session').shadowRoot;
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, scrollbarSheet];
      if (longConsent) {
        const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale], consent = base.featureConsent;
        const repeat = (words, times) => Array(times).fill(words).join(' ');
        globalThis.fixtureCopy = { ...base, featureConsent: { ...consent, text: repeat(consent.text, longConsent), textNarrow: repeat(consent.textNarrow, 5) } };
      }
      const host = document.querySelector('aithema-session');
      const snapshot = JSON.parse(JSON.stringify(host.session));
      snapshot.opener = { text: welcomeText, locale }; snapshot.visualsBound = true;
      if (start) snapshot.featureMatrix.best.imageInput = { available: true };
      // Kept for a second configure() with the same snapshot (Codex M2).
      globalThis.snapshot603 = snapshot;
      mount(snapshot);
    }, welcome[locale], locale, text, Boolean(start), longConsent ?? 0, SCROLLBARS[scrollbar], FONTS[font] ?? null);
  };
  if (evidence) await mkdir(join(evidence, 'ait-603', 'shots'), { recursive: true });
  for (const item of cases) {
    const { width, height, locale, theme, text } = item, name = caseName(item);
    await t.test(name, async () => {
      const page = await browser.newPage(), problems = [];
      try {
        await open(page, item, problems);
        const record = async (state, boxes) => {
          index.push({ name, state, width, height, locale, theme, text, start: Boolean(item.start), scrollbar: item.scrollbar ?? 'classic', file: `ait-603/${name}-${state}.json`, shot: `ait-603/shots/${name}-${state}.png` });
          if (!evidence) return;
          await writeFile(join(evidence, 'ait-603', `${name}-${state}.json`), JSON.stringify(boxes, null, 2));
          await writeFile(join(evidence, 'ait-603', 'index.json'), JSON.stringify(index, null, 2));
          await page.screenshot({ path: join(evidence, 'ait-603', 'shots', `${name}-${state}.png`), fullPage: false });
        };
        const before = await measure(page);
        await record('prelive', before);
        const label = `${name}/prelive`, failures = [];
        assert.equal(before.entrance, 'combined');
        assert.equal(before.layout, 'image', `${label}: a bound image visual enters the real image concept layout`);
        assert.notEqual(before.stage, 'live');
        for (const key of ['scroll', 'opener', 'label', 'text', 'firstLine', 'ready', 'dock', 'composer', 'mic', 'send']) positive(`${label}/${key}`, before[key]);
        // r2: the scrollbar mode is the one this case asks for (15 px classic gutter, 0 px overlay).
        assert.equal(before.gutter, (item.scrollbar ?? 'classic') === 'overlay' ? 0 : 15, `${label}: the ${item.scrollbar ?? 'classic'} scrollbar gutter`);
        // The combined dock renders no separate attach control; record it, never compare a hidden box.
        if (before.attach) positive(`${label}/attach`, before.attach);
        assert.ok(before.naturalLines > CAP, `${label}: the fixture welcome is longer than the clamp: ${before.naturalLines}`);
        // Spec 2: readiness in its one-row short-screen form (title · status · Change settings), at most two lines.
        // RC26 (start-journey rc26-look checks): the phone notice is abbreviated, so the
        // processing route stays readable in its own line below the one-row form.
        positive(`${label}/readyRoute`, before.readyRoute);
        if (!before.routeText?.trim()) failures.push('the phone processing route line is non-empty');
        if (JSON.stringify(before.readyRows) !== '["consent"]') failures.push(`readiness shows only its consent state: ${JSON.stringify(before.readyRows)}`);
        if (before.readyRow?.count !== 3 || before.readyRow.height > 2 * 44 + .5) failures.push(`title, consent state and Change settings wrap to at most two rows: ${JSON.stringify(before.readyRow)}`);
        if (before.readyRoute && before.readyRoute.y < before.readyRow.top + before.readyRow.height - .5) failures.push(`the route line follows the one-row readiness: ${JSON.stringify(before.readyRoute)}`);
        failures.push(...separatorFailures(before.readyLines));
        failures.push(...reserveFailures(before.consent));
        // Spec 1: whole lines, at least two, at most the existing six.
        const lines = before.text.height / before.lineHeight;
        if (Math.abs(lines - Math.round(lines)) > .05) failures.push(`whole lines only: ${before.text.height} / ${before.lineHeight}`);
        const shown = Math.round(lines);
        if (shown < MIN || shown > CAP) failures.push(`between ${MIN} and ${CAP} lines: ${shown}`);
        if (before.linkText !== (locale === 'de' ? 'Ganze Antwort lesen' : 'Read full reply')) failures.push(`the clamped welcome offers the link: ${before.linkText}`);
        else positive(`${label}/link`, before.link);
        // Does the two-line minimum fit? Everything below the text moves by whole lines.
        const end = Math.max(...[before.link, before.ready].filter(Boolean).map(box => box.y + box.height)) + before.scrollTop - before.scroll.y;
        const minimumEnd = end - (shown - MIN) * before.lineHeight;
        const fits = minimumEnd <= before.clientHeight + .5;
        if (fits) {
          // Label, lines, link and readiness together inside the scroll area; nothing to scroll, no fade.
          for (const key of ['label', 'text', 'link', 'ready']) if (before[key] && !inside(before.scroll, before[key])) failures.push(`${key} inside .conversation-scroll: ${JSON.stringify(before[key])} in ${JSON.stringify(before.scroll)}`);
          if (before.scrollTop > .5) failures.push(`the ready stage starts at its top: ${before.scrollTop}`);
          // The largest count: one more line would not fit (or the six-line cap is reached).
          if (shown < CAP && end + before.lineHeight <= before.clientHeight + .5) failures.push(`the largest whole-line count: ${shown} lines leave ${before.clientHeight - end} px`);
          if (before.fade !== 'none' || before.fadeAttribute) failures.push(`no fade while nothing is below: ${before.fade}`);
        } else {
          // Spec 3: the minimum, a scrolling area and the bottom fade while content is below.
          if (shown !== MIN) failures.push(`the minimum ${MIN} lines when even they do not fit: ${shown}`);
          if (before.scrollHeight <= before.clientHeight) failures.push(`the scroll area scrolls: ${before.scrollHeight} <= ${before.clientHeight}`);
          if (before.fade === 'none' || !before.fadeAttribute) failures.push(`a bottom fade while content is below: ${before.fade}`);
          // A soft fade of about 24 px (never under 12 px). The link stays above it
          // whenever the label, the two lines and the link fit in the unfaded part
          // (nothing above the label may push it down). The 64482822 run had a fixed
          // 24 px fade and the link 2 px inside it at 390x664 DE 125 %.
          // Codex gate2c Low: the 12 px floor yields to the link: when less than
          // 12 px are below a link in view, the fade takes only that room (0 = none).
          const fade = before.fadeLength;
          const linkEnd = before.link.y + before.link.height + before.scrollTop - before.scroll.y, labelTop = before.label.y + before.scrollTop - before.scroll.y;
          const room = Math.floor(before.clientHeight - linkEnd);
          if (!(fade >= 0 && fade <= 24) || (fade < 12 && !(room >= 0 && fade === room))) failures.push(`a soft fade of 12..24 px, shorter only to clear the link: ${JSON.stringify({ fade: before.fade, room })}`);
          if (linkEnd <= before.clientHeight + .5 && linkEnd > before.clientHeight - (fade ?? 24) + .5)
            failures.push(`the link stays above the fade: ${JSON.stringify({ linkEnd, labelTop, client: before.clientHeight, fade })}`);
          // Codex Low: the fade stays until the exact end (2 px before it, content is still below).
          await page.$eval('aithema-session', c => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight - s.clientHeight - 2; });
          const near = await measure(page);
          if (near.scrollTop + near.clientHeight < near.scrollHeight - .5 && !near.fadeAttribute) failures.push(`the fade stays while content is below: ${JSON.stringify({ top: near.scrollTop, client: near.clientHeight, height: near.scrollHeight })}`);
          await page.$eval('aithema-session', c => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight; });
          const end2 = await measure(page);
          if (end2.fade !== 'none' || end2.fadeAttribute) failures.push(`the fade is gone at the end: ${end2.fade}`);
          await page.$eval('aithema-session', c => { c.shadowRoot.querySelector('.conversation-scroll').scrollTop = 0; });
        }
        // Spec 4: the hand-off (AIT-506/601 sequence).
        const settled = await measure(page);
        // Codex M3: the first send enters live before its response. Hold that
        // response, so the first live paint is measured before anything arrives.
        await page.evaluate(() => {
          const original = globalThis.fetch, held = new Promise(resolve => { globalThis.releaseTurns = resolve; });
          globalThis.fetch = async (url, options) => { if (String(url).endsWith('/turns') && globalThis.releaseTurns) await held; return original(url, options); };
        });
        await page.type('aithema-session >>> textarea', locale === 'de' ? 'Ein Rechnungssystem.' : 'An invoice system.');
        await page.click('aithema-session >>> .send');
        await page.waitForFunction(() => trace.includes('consent'));
        // The frame before the hand-off: the typed message is in the field, which
        // may have grown (ComposerSize) before any hand-off happens.
        const typed = await measure(page);
        // Codex gate2c M3: the boxes in the task that makes the stage live (a
        // MutationObserver, before any frame), in the first two frames after it
        // (requestAnimationFrame), and settled three frames later. A jump that
        // settles within those frames fails as well.
        await page.evaluate(`globalThis.boxes603 = ${boxesInPage}`);
        await page.evaluate(() => {
          const host = document.querySelector('aithema-session'), root = host.shadowRoot, frames = globalThis.liveFrames603 = [];
          const observer = new MutationObserver(() => {
            if (root.querySelector('.workspace')?.dataset.stage !== 'live') return;
            observer.disconnect();
            frames.push({ at: 'stage', ...globalThis.boxes603(host) });
            requestAnimationFrame(() => { frames.push({ at: 'frame1', ...globalThis.boxes603(host) });
              requestAnimationFrame(() => frames.push({ at: 'frame2', ...globalThis.boxes603(host) })); });
          });
          observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stage'] });
        });
        await page.evaluate(() => { failSend = true; grant(); });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
        await page.waitForFunction(() => globalThis.liveFrames603.length === 3);
        const first = await measure(page), frames = await page.evaluate(() => globalThis.liveFrames603);
        index.push({ name, state: 'firstlive-frames', frames: frames.map(({ at, opener, text, firstLine, mic, send, dock, ready, clamp }) => ({ at, opener, text, firstLine, mic, send, dock, ready, clamp })) });
        await record('firstlive', first);
        for (const key of ['scroll', 'opener', 'text', 'firstLine', 'dock', 'mic', 'send']) positive(`${name}/firstlive/${key}`, first[key]);
        if (first.ready) failures.push(`readiness goes away at the first live paint: ${JSON.stringify(first.ready)}`);
        if (first.clamp !== settled.clamp || typed.clamp !== settled.clamp) failures.push(`the clamp is fixed into the first live paint: ${settled.clamp} -> ${typed.clamp} -> ${first.clamp}`);
        // Spec 4, at the hand-off itself: nothing has arrived, so nothing follows;
        // the welcome box, its text and first line, and the dock stay where they were.
        for (const frame of [...frames, { at: 'settled', ...first }]) {
          for (const part of ['opener', 'text', 'firstLine', 'mic', 'send', 'dock']) {
            if (!(frame[part]?.width > 0 && frame[part]?.height > 0)) { failures.push(`${frame.at}: ${part} positive box: ${JSON.stringify(frame[part])}`); continue; }
            for (const key of keys)
              if (Math.abs(typed[part][key] - frame[part][key]) > .5) failures.push(`first live paint (${frame.at}): ${part} ${key} moved: ${typed[part][key]} -> ${frame[part][key]}`);
          }
          if (frame.clamp !== settled.clamp) failures.push(`first live paint (${frame.at}): the clamp is fixed: ${settled.clamp} -> ${frame.clamp}`);
        }
        await page.evaluate(() => { const release = globalThis.releaseTurns; globalThis.releaseTurns = null; release(); });
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
        await page.evaluate(() => {
          c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: c.session.opener.text } });
          failSend = false;
        });
        await page.click('aithema-session >>> .send');
        await page.waitForFunction(() => sent.length === 1 && document.querySelector('aithema-session').shadowRoot.querySelector('.workspace').dataset.stage === 'live');
        const after = await measure(page);
        await record('live', after);
        assert.equal(after.layout, 'image');
        for (const key of ['scroll', 'opener', 'text', 'firstLine', 'dock', 'composer', 'mic', 'send']) positive(`${name}/live/${key}`, after[key]);
        if (after.ready) failures.push(`readiness goes away at the hand-off: ${JSON.stringify(after.ready)}`);
        if (after.clamp !== settled.clamp) failures.push(`the clamp is fixed through the hand-off: ${settled.clamp} -> ${after.clamp}`);
        // AIT-601 TICK L1 (TICK spec 4: after the first visitor turn the transcript
        // scrolls as usual): only real overflow, even without the idle 40 px
        // render-label reserve, follows to the visitor turn; the welcome may move
        // then. Otherwise the welcome keeps its box and first line.
        // The real end padding (8 px on short phones), never an assumed 40 px reserve (Codex M3).
        const overflow = after.contentEnd + after.shellPaddingBottom > after.shellClientHeight + .5;
        if (after.shellScrollTop > .5) {
          if (!overflow) failures.push(`the live transcript follows only on real overflow: ${JSON.stringify({ contentEnd: after.contentEnd, padding: after.shellPaddingBottom, client: after.shellClientHeight })}`);
          positive(`${name}/live/visitor`, after.visitor);
          // Recorded, not asserted here: at 320x568 EN the follow can stop 44 px short
          // when the persisted welcome's reply controls arrive after it (also before
          // AIT-603, remote lane at 29ead717); outside TICK's AIT-603 spec, reported.
          index.at(-1).visitorWhole = inside(after.shell, after.visitor);
        }
        const kept = after.shellScrollTop <= .5;
        for (const key of keys) {
          if (!kept) break;
          if (Math.abs(settled.firstLine[key] - after.firstLine[key]) > .5) failures.push(`welcome first line ${key} moved: ${settled.firstLine[key]} -> ${after.firstLine[key]}`);
          // As in AIT-601: the persisted welcome can add reply controls below its text, so its box height may grow.
          if (key !== 'height' && Math.abs(settled.opener[key] - after.opener[key]) > .5) failures.push(`welcome ${key} moved: ${settled.opener[key]} -> ${after.opener[key]}`);
          if (Math.abs(settled.text[key] - after.text[key]) > .5) failures.push(`welcome text ${key} moved: ${settled.text[key]} -> ${after.text[key]}`);
        }
        for (const key of keys) {
          for (const control of ['mic', 'send']) if (Math.abs(settled[control][key] - after[control][key]) > .5) failures.push(`${control} ${key} moved: ${settled[control][key]} -> ${after[control][key]}`);
        }
        if (Math.abs(settled.dock.y - after.dock.y) > .5) failures.push(`.composer-dock top moved: ${settled.dock.y} -> ${after.dock.y}`);
        if (Math.abs(settled.dock.height - after.dock.height) > .5) failures.push(`.composer-dock height changed: ${settled.dock.height} -> ${after.dock.height}`);
        index.at(-1).followed = !kept;
        if (failures.length) failures.push(`prelive ${JSON.stringify(before)}`, `first live ${JSON.stringify(first)}`, `live ${JSON.stringify(after)}`);
        none(failures, name);
        assert.deepEqual(failures, [], name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  // Codex M2 and M4: a second configure() with the same snapshot and viewport
  // re-fits the rebuilt workspace; granting consent keeps the dock's height.
  for (const item of stateCases) {
    const name = `${caseName(item)}-states`;
    await t.test(name, async () => {
      const page = await browser.newPage(), problems = [], failures = [];
      try {
        await open(page, item, problems);
        const pending = await measure(page);
        positive(`${name}/dock`, pending.dock); positive(`${name}/text`, pending.text);
        const tick = evidence && item.r4 ? join(evidence, 'ait-603', 'tick-r4') : null;
        if (tick) { await mkdir(tick, { recursive: true }); await page.screenshot({ path: join(tick, `${name}-pending.png`), fullPage: false }); }
        let natural = null; const sheet = null;
        if (item.longConsent) {
          // r4: the r3 wrap (three or more lines) is now the unclamped copy; the dock shows the two-line cap.
          natural = await naturalConsentLines(page, item.width <= 340);
          failures.push(...capFailures(item, pending, natural));
        }
        // The consent sheet (the full host sentence) is PR-B's (fix/ait-603b-consent-sheet); not checked here.
        await page.evaluate(() => mount(globalThis.snapshot603));
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('[data-host-opener] .turn-text'));
        const again = await measure(page);
        positive(`${name}/again/text`, again.text);
        if (again.clamp !== pending.clamp) failures.push(`configure() again re-fits the clamp: ${pending.clamp} -> ${again.clamp}`);
        if (Math.abs(again.text.height - pending.text.height) > .5) failures.push(`configure() again keeps the welcome's lines: ${pending.text.height} -> ${again.text.height}`);
        await page.evaluate(() => grant());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'));
        const granted = await measure(page);
        positive(`${name}/granted/dock`, granted.dock);
        for (const key of keys) if (Math.abs(pending.dock[key] - granted.dock[key]) > .5) failures.push(`the dock keeps its ${key} when consent is granted: ${pending.dock[key]} -> ${granted.dock[key]}`);
        if (item.longConsent) {
          // r4: mic and Send keep their boxes too; a shorter granted line starts where the capped line started.
          for (const control of ['mic', 'send']) {
            positive(`${name}/granted/${control}`, granted[control]);
            for (const key of keys) if (Math.abs(pending[control][key] - granted[control][key]) > .5) failures.push(`${control} keeps its ${key} when consent is granted: ${pending[control][key]} -> ${granted[control][key]}`);
          }
          const reason = granted.dockRows['.composer-reason'].box;
          if (reason?.height > 0 && pending.consent.line && Math.abs(reason.y - pending.consent.line.y) > .5) failures.push(`the granted line sits top-aligned in the reserve: ${reason.y} vs ${pending.consent.line.y}`);
        }
        if (tick) {
          await page.screenshot({ path: join(tick, `${name}-granted.png`), fullPage: false });
          const pick = boxes => ({ dock: boxes.dock, mic: boxes.mic, send: boxes.send });
          await writeFile(join(tick, `${name}.json`), JSON.stringify({ pending: pick(pending), granted: pick(granted), consent: pending.consent, natural, sheet,
            grantedReason: granted.dockRows['.composer-reason'] }, null, 2));
          tickIndex.push({ name, width: item.width, height: item.height, locale: item.locale, natural, lines: pending.consent.line ? pending.consent.line.height / pending.consent.line.lineHeight : null,
            dock: [pending.dock, granted.dock], mic: [pending.mic, granted.mic], send: [pending.send, granted.send], sheet,
            shots: [`${name}-pending.png`, `${name}-granted.png`], file: `${name}.json` });
          await writeFile(join(tick, 'index.json'), JSON.stringify(tickIndex, null, 2));
        }
        index.push({ name, state: 'consent-states', width: item.width, height: item.height, locale: item.locale, theme: item.theme, text: item.text,
          dockPending: pending.dock, dockGranted: granted.dock, clamp: [pending.clamp, again.clamp], consent: pending.consent });
        if (evidence) {
          await writeFile(join(evidence, 'ait-603', `${name}.json`), JSON.stringify({ pending, again, granted }, null, 2));
          await writeFile(join(evidence, 'ait-603', 'index.json'), JSON.stringify(index, null, 2));
          await page.screenshot({ path: join(evidence, 'ait-603', 'shots', `${name}-granted.png`), fullPage: false });
        }
        if (failures.length) failures.push(`pending ${JSON.stringify(pending)}`, `granted ${JSON.stringify(granted)}`);
        none(failures, name);
        assert.deepEqual(failures, [], name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  // r2 (Codex READY-STAGE Low): one boundary. Phones are ≤ 600 px: at exactly
  // 600 px the phone readiness shows its processing route line (RC26); from
  // 601 px the desktop rule hides it.
  for (const [width, phone] of [[600, true], [601, false]]) {
    const name = `${width}x800-route-boundary`;
    await t.test(name, async () => {
      const page = await browser.newPage(), problems = [], failures = [];
      try {
        await open(page, { width, height: 800, locale: 'en', theme: 'light', text: 100 }, problems);
        const state = await measure(page);
        positive(`${name}/ready`, state.ready);
        if (state.readyRow?.count !== 3) failures.push(`the one-row readiness form: ${JSON.stringify(state.readyRow)}`);
        if (phone && !(state.readyRoute?.width > 0 && state.readyRoute?.height > 0 && state.routeText?.trim())) failures.push(`a phone (≤ 600 px) shows the processing route line: ${JSON.stringify({ route: state.readyRoute, text: state.routeText })}`);
        if (!phone && state.readyRoute) failures.push(`above 600 px the desktop rule hides the route line: ${JSON.stringify(state.readyRoute)}`);
        none(failures, name);
        assert.deepEqual(problems, []);
      } finally { await page.close(); }
    });
  }
  assert.equal(index.length, cases.length * 4 + stateCases.length);
}
