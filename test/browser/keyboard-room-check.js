// AIT-618 (LEAD's binding decision after AIT-603 PR-A): at compact keyboard-up
// phone sizes the controls never move, and the transcript gets its room back
// from OTHER chrome:
// - the keyboard-shortcut hint ("⌘ + Enter to send") is not painted on a touch
//   phone without a hardware keyboard ((hover:none) and (pointer:coarse), a
//   static media query, so it never appears or disappears while typing); its
//   box is kept, so nothing moves; desktop and hardware keyboards keep it;
// - while the phone keyboard is up the "Microphone blocked" status row
//   collapses (0 px, no row gap; its text stays in the accessibility tree) and
//   returns when the keyboard closes; the AI notice stays.
// Acceptance (TICK): at 320x568 with the keyboard up (visual viewport 308 and
// 340) at least one whole transcript line stays visible in the pending and the
// cleared consent states (image and document docks, EN/DE), and Send and Mic
// stay identical through pending -> cleared -> + 2 s (PR-A r10's floor rule).
// Every measured box must be positive, so a hidden (0x0) box cannot pass.
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
const none = (failures, label) => { if (failures.length) throw new Error(`${failures.join(' | ')} [${label}]`.slice(0, 1800)); };
const settleLong = page => page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const wait = (page, ms) => page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), ms);
// The keyboard as in AIT-511/513 and PR-A (a shorter visual viewport, focus in the field).
const keyboardUp = (page, height) => page.evaluate(height => {
  globalThis.k1Viewport ??= visualViewport;
  const viewport = new EventTarget(); Object.assign(viewport, { height, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').focus({ preventScroll: true });
  window.dispatchEvent(new Event('resize'));
}, height);
const keyboardDown = page => page.evaluate(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.k1Viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').blur();
  window.dispatchEvent(new Event('resize'));
});

// The dock controls, the status row, the hint and the transcript lines a visitor can read.
const roomState = c => {
  const root = c.shadowRoot, box = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const painted = n => Boolean(n) && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().height > .5
    && n.getBoundingClientRect().width > .5 && [...(function* up(e) { for (; e && e !== root; e = e.parentElement ?? e.parentNode?.host) yield e; })(n)].every(e => getComputedStyle(e).clipPath === 'none');
  const scroll = root.querySelector('.conversation-scroll'), dock = root.querySelector('.composer-dock');
  const s = scroll.getBoundingClientRect(), d = dock.getBoundingClientRect();
  const scrollCSS = getComputedStyle(scroll), fade = scrollCSS.maskImage && scrollCSS.maskImage !== 'none' ? (parseFloat(scrollCSS.getPropertyValue('--opener-fade')) || 24) : 0;
  const viewportBottom = visualViewport.height + (visualViewport.offsetTop || 0);
  const top = Math.max(s.top, 0), bottom = Math.min(s.bottom - fade, d.top, viewportBottom);
  // Whole painted text lines of the transcript inside every clipping ancestor and above the dock.
  const lines = [], shell = scroll.querySelector('.transcript-shell');
  if (shell) {
    const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (!n.textContent.trim() || !n.parentElement.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let clipTop = top, clipBottom = bottom;
      for (let e = n.parentElement; e && e !== scroll; e = e.parentElement) {
        const css = getComputedStyle(e); if (css.overflowY === 'visible' && css.overflowX === 'visible') continue;
        const r = e.getBoundingClientRect(); clipTop = Math.max(clipTop, r.top); clipBottom = Math.min(clipBottom, r.bottom);
      }
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > .5 && r.height > .5 && r.top >= clipTop - .5 && r.bottom <= clipBottom + .5) lines.push({ y: r.y, height: r.height, text: n.textContent.trim().slice(0, 24) });
    }
  }
  const status = root.querySelector('.composer-status'), slot = root.querySelector('.composer-status-slot');
  const hint = root.querySelector('.composer-feedback > .composer-reason[data-shortcut]');
  const workspace = root.querySelector('.workspace');
  return {
    keyboard: workspace.hasAttribute('data-phone-keyboard'), short: workspace.hasAttribute('data-phone-short'),
    coarse: matchMedia('(pointer:coarse)').matches, hoverNone: matchMedia('(hover:none)').matches,
    dock: box(dock), composer: box(root.querySelector('.composer')), field: box(root.querySelector('textarea')),
    mic: box(root.querySelector('.composer-mic')), send: box(root.querySelector('.send')), feedback: box(root.querySelector('.composer-feedback')),
    notice: box(root.querySelector('.composer-notice')), noticePainted: painted(root.querySelector('.composer-notice')),
    band: box(root.querySelector('.band')), scroll: box(scroll), room: Math.max(0, bottom - top), fade,
    lines: lines.length, firstLine: lines[0] ?? null,
    status: { text: status?.textContent.trim() ?? '', painted: painted(status), slot: box(slot) },
    hint: hint ? { text: hint.textContent.trim(), painted: painted(hint), box: box(hint) } : null,
    consent: Boolean(root.querySelector('.composer-reason[data-consent-feature="text"]')),
  };
};
const stableBoxes = (name, before, after, parts) => {
  const failures = [];
  for (const part of parts) {
    const a = before[part], b = after[part];
    if (!(a?.width > 0 && a?.height > 0 && b?.width > 0 && b?.height > 0)) { failures.push(`${name}: ${part} positive boxes: ${JSON.stringify([a, b])}`); continue; }
    for (const key of keys) if (Math.abs(a[key] - b[key]) > .5) failures.push(`${name}: ${part} keeps its ${key}: ${a[key]} -> ${b[key]}`);
  }
  return failures;
};
const brief = s => ({ keyboard: s.keyboard, room: +s.room.toFixed(1), lines: s.lines, scroll: s.scroll, dock: s.dock, band: s.band, notice: s.notice, status: s.status, hint: s.hint });

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-keyboard-room-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-618', 'tick') : null;
  if (evidence) await mkdir(evidence, { recursive: true });
  const index = [];
  // `touch`: a touch phone without a hardware keyboard (pointer:coarse, hover:none).
  const open = async ({ width, height, locale, touch = true, intake = null, granted = false }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (/ResizeObserver/.test(message.text())) problems.push(message.text()); });
    await page.evaluateOnNewDocument(() => window.addEventListener('error', event => {
      if (/ResizeObserver/.test(String(event.message))) console.error(`ResizeObserver loop: ${event.message}`);
    }));
    await page.setViewport({ width, height, hasTouch: touch, isMobile: false });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&opener&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(async (locale, intake, granted) => {
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = { ...base, featureConsent: { ...base.featureConsent, text: base.featureConsent.text } };
      const snapshot = JSON.parse(JSON.stringify(document.querySelector('aithema-session').session)), best = snapshot.featureMatrix.best;
      if (intake === 'image') best.imageInput = { available: true };
      if (intake === 'document') best.uploads = { available: true };
      if (granted) { best.text = structuredClone(best.analysis); best.voice = structuredClone(best.analysis); }
      mount(snapshot);
    }, locale, intake, granted);
    await page.waitForFunction(granted => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return granted ? root.querySelector('.composer-reason[data-shortcut]') : root.querySelector('.composer-reason[data-consent-feature="text"] .consent-action');
    }, { timeout: 15_000 }, granted);
    await settleLong(page);
    return page;
  };
  const read = page => page.$eval('aithema-session', roomState);
  const capture = async (page, name, state) => {
    index.push({ name, shot: `${name}.png`, file: `${name}.json`, ...brief(state) });
    if (!evidence) return;
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
    await writeFile(join(evidence, `${name}.json`), JSON.stringify(state, null, 2));
    await writeFile(join(evidence, `index-${process.pid}-${t.name.replace(/\W+/gu, '-').slice(0, 40)}.json`), JSON.stringify(index, null, 2));
  };
  return { open, read, capture };
}

// (a) TICK's acceptance: a transcript line in both consent states, controls still, status row collapsed and back.
export async function keyboardRoomCheck(t) {
  const { open, read, capture } = await harness(t);
  const [width, height] = [320, 568];
  for (const viewport of [308, 340]) for (const intake of ['image', 'document']) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-${intake}-dock`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake }, problems);
      try {
        const down = await read(page);
        await capture(page, `${name}-keyboard-down`, down);
        if (!down.coarse || !down.hoverNone) failures.push(`${name}: fixture: a touch phone (pointer:coarse, hover:none): ${JSON.stringify([down.coarse, down.hoverNone])}`);
        if (!down.consent) failures.push(`${name}: fixture: consent pending`);
        if (!/./u.test(down.status.text) || !down.status.painted || !(down.status.slot?.height > 0)) failures.push(`${name}: keyboard down: the mic-blocked row shows: ${JSON.stringify(down.status)}`);
        await keyboardUp(page, viewport); await settleLong(page);
        const pending = await read(page);
        await capture(page, `${name}-keyboard-up-pending`, pending);
        if (!pending.keyboard) failures.push(`${name}: the keyboard flag is set`);
        await page.evaluate(() => grant());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'), { timeout: 15_000 });
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const cleared = await read(page);
        await capture(page, `${name}-keyboard-up-cleared`, cleared);
        await wait(page, 2000); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const later = await read(page);
        await capture(page, `${name}-keyboard-up-cleared-plus-2s`, later);
        for (const [when, state] of [['pending', pending], ['cleared', cleared], ['cleared + 2 s', later]]) {
          if (!state.keyboard) failures.push(`${name} ${when}: the keyboard stays up`);
          if (state.lines < 1) failures.push(`${name} ${when}: at least one whole transcript line is visible: ${JSON.stringify(brief(state))}`);
          // The mic-blocked row collapses while the keyboard is up; its words stay for assistive technology.
          if (state.status.painted || (state.status.slot?.height ?? 0) > .5) failures.push(`${name} ${when}: the mic-blocked row collapses with the keyboard up: ${JSON.stringify(state.status)}`);
          if (!/./u.test(state.status.text)) failures.push(`${name} ${when}: the mic-blocked words stay in the DOM: ${JSON.stringify(state.status)}`);
          // The AI notice stays (a required disclosure).
          if (!state.noticePainted || !(state.notice?.width > 0 && state.notice?.height > 0)) failures.push(`${name} ${when}: the AI notice stays: ${JSON.stringify(state.notice)}`);
          if (state.hint?.painted) failures.push(`${name} ${when}: no shortcut hint on a touch phone: ${JSON.stringify(state.hint)}`);
        }
        for (const [when, state] of [['cleared', cleared], ['cleared + 2 s', later]]) failures.push(...stableBoxes(`${name} pending -> ${when}`, pending, state, ['mic', 'send', 'feedback', 'dock', 'field']));
        await keyboardDown(page); await settleLong(page);
        const back = await read(page);
        await capture(page, `${name}-keyboard-closed`, back);
        if (back.keyboard) failures.push(`${name}: the keyboard flag clears`);
        if (!back.status.painted || !(back.status.slot?.width > 0 && back.status.slot?.height > 0)) failures.push(`${name}: the mic-blocked row returns when the keyboard closes: ${JSON.stringify(back.status)}`);
        else if (Math.abs(back.status.slot.height - down.status.slot.height) > .5) failures.push(`${name}: the returned mic-blocked row has its keyboard-down height: ${down.status.slot.height} -> ${back.status.slot.height}`);
        t.diagnostic(`${name}: room down/pending/cleared/+2 s ${down.room.toFixed(1)} / ${pending.room.toFixed(1)} / ${cleared.room.toFixed(1)} / ${later.room.toFixed(1)}; lines ${pending.lines} / ${cleared.lines} / ${later.lines}; dock ${pending.dock?.height} / ${cleared.dock?.height}; band ${pending.band?.height}; notice ${pending.notice?.height}; status ${JSON.stringify(pending.status.slot)}; Send y ${pending.send?.y} / ${cleared.send?.y} / ${later.send?.y}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (b) The hint: absent on a touch phone (keyboard down and up, never toggling
// while typing, its box kept), present on a phone-sized window with a
// hardware keyboard and pointer, and on desktop.
export async function keyboardHintCheck(t) {
  const { open, read, capture } = await harness(t);
  for (const locale of ['en', 'de']) {
    await t.test(`320x568-${locale}-touch-no-hint`, async () => {
      const name = `320x568-${locale}-touch-no-hint`, problems = [], failures = [];
      const page = await open({ width: 320, height: 568, locale, granted: true }, problems);
      try {
        const down = await read(page);
        await capture(page, `${name}-keyboard-down`, down);
        if (!down.coarse || !down.hoverNone) failures.push(`${name}: fixture: a touch phone: ${JSON.stringify([down.coarse, down.hoverNone])}`);
        if (!down.hint?.text) failures.push(`${name}: fixture: the idle hint is in the DOM: ${JSON.stringify(down.hint)}`);
        if (down.hint?.painted) failures.push(`${name}: keyboard down: the hint is not painted on a touch phone: ${JSON.stringify(down.hint)}`);
        await keyboardUp(page, 308); await settleLong(page);
        const states = [];
        for (const lines of [1, 2, 3]) {
          await page.$eval('aithema-session', (c, lines) => { const input = c.shadowRoot.querySelector('textarea');
            input.value = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n'); input.dispatchEvent(new Event('input', { bubbles: true })); }, lines);
          await settleLong(page); states.push(await read(page));
        }
        await capture(page, `${name}-keyboard-up-typing`, states.at(-1));
        for (const [i, state] of states.entries()) if (state.hint?.painted) failures.push(`${name}: typing (${i + 1} lines): the hint never appears: ${JSON.stringify(state.hint)}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
    for (const [width, height] of [[320, 568], [1440, 900]]) {
      const name = `${width}x${height}-${locale}-hardware-keyboard-hint`;
      await t.test(name, async () => {
        const problems = [], failures = [];
        const page = await open({ width, height, locale, granted: true, touch: false }, problems);
        try {
          const state = await read(page);
          await capture(page, name, state);
          if (state.coarse || state.hoverNone) failures.push(`${name}: fixture: a fine pointer with hover: ${JSON.stringify([state.coarse, state.hoverNone])}`);
          if (!state.hint?.painted || !(state.hint.box?.width > 0 && state.hint.box?.height > 0) || !/Enter/u.test(state.hint.text)) failures.push(`${name}: the hint shows: ${JSON.stringify(state.hint)}`);
          if (!state.status.painted || !(state.status.slot?.height > 0)) failures.push(`${name}: the mic-blocked row shows: ${JSON.stringify(state.status)}`);
        } finally { await page.close(); }
        none(failures, name);
        assert.deepEqual(problems, []);
      });
    }
  }
}
